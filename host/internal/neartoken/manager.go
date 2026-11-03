package neartoken

import (
	"context"
	"log"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/yetone/magpie/internal/proc"
)

// walletTTL 是钱包数字在页面上算"新鲜"的时长：超过这个时间的一次 state 会
// 顺手在后台重读，读回来之前页面看到的仍是上一份。
const walletTTL = 5 * time.Minute

// currencyTTL 是站点汇率在内存里复用的时长。
const currencyTTL = 10 * time.Minute

// Manager 是这只进程里唯一的一份 NearToken 状态：进行中的授权、钱包快照、
// 站点汇率，以及页面能问的那些动作。
type Manager struct {
	mu         sync.Mutex
	snap       snapshot
	pending    *Authorization
	polling    bool
	cancel     context.CancelFunc
	refreshing bool

	path    string
	baseURL string
	client  *client
	now     func() time.Time
}

// New 造一只 Manager；dir 为空时用 magpie 的数据目录。
func New(dir string) *Manager {
	path := StatePath()
	if strings.TrimSpace(dir) != "" {
		path = filepath.Join(dir, "neartoken.json")
	}
	m := &Manager{path: path, baseURL: DefaultBaseURL, client: newClient(DefaultBaseURL)}
	m.snap = loadSnapshot(path)
	if m.snap.BaseURL != "" {
		m.baseURL = m.snap.BaseURL
		m.client = newClient(m.baseURL)
	}
	return m
}

// shared 是进程里的那一只，第一次用到时才建。
var shared = sync.OnceValue(func() *Manager { return New("") })

// Call 是页面请求的唯一入口：name 来自它 package.json 的 magpie.calls，
// params 是页面给的。每个动作都回一份页面画得出来的数据。
func Call(ctx context.Context, name string, params map[string]any) (any, error) {
	return shared().call(ctx, name, params)
}

func (m *Manager) call(ctx context.Context, name string, params map[string]any) (any, error) {
	switch name {
	case "neartoken:state":
		return m.state(ctx), nil
	case "neartoken:connect":
		return m.connect(params)
	case "neartoken:cancel":
		m.cancelPending()
		return m.state(ctx), nil
	case "neartoken:open":
		return m.open()
	case "neartoken:disconnect":
		return m.disconnect(ctx)
	case "neartoken:refresh":
		return m.refresh(ctx)
	case "neartoken:usage":
		return m.usage(ctx, params)
	case "neartoken:topup":
		return m.topup(ctx, params)
	}
	return nil, fail(CodeBadParam, "没有这个调用：%s", name)
}

// View 是页面的状态：连接与否、账户、未完成的授权、汇率与目录规模。
type View struct {
	Configured  bool     `json:"configured"`
	BaseURL     string   `json:"baseURL"`
	TokenName   string   `json:"tokenName,omitempty"`
	Currency    Currency `json:"currency"`
	Account     *Account `json:"account,omitempty"`
	Pending     *pending `json:"pending,omitempty"`
	Error       string   `json:"error,omitempty"`
	Models      int      `json:"models"`
	Groups      int      `json:"groups"`
	ProviderID  string   `json:"providerId"`
	RefreshedAt int64    `json:"refreshedAt,omitempty"`
}

// state 组装一份状态；钱包过期时顺手在后台重读一次，本身不等。
func (m *Manager) state(ctx context.Context) *View {
	key, connected := storedKey()
	_ = key

	m.mu.Lock()
	snap := m.snap
	m.mu.Unlock()

	view := &View{
		Configured:  connected,
		BaseURL:     m.baseURL,
		TokenName:   snap.TokenName,
		ProviderID:  ProviderID,
		Account:     snap.Account,
		Error:       snap.Error,
		Models:      snap.Models,
		Groups:      snap.Groups,
		RefreshedAt: snap.WalletAt,
	}
	if snap.Currency != nil {
		view.Currency = *snap.Currency
	} else {
		view.Currency = Currency{Name: "NearToken", PerUnit: 1, Rate: 1}
	}
	if p, ok := m.livePending(); ok {
		view.Pending = p.pendingView()
	}
	if connected {
		m.refreshWalletSoon()
	}
	return view
}

// livePending 是还在有效期内的那一次授权，过期的不再显示。
func (m *Manager) livePending() (*Authorization, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pending == nil {
		return nil, false
	}
	if m.clock().After(m.pending.ExpiresAt) {
		return nil, false
	}
	return m.pending, true
}

// pendingView 是给页面看的那几个字段（device_code 除外）。
func (a *Authorization) pendingView() *pending {
	return &pending{
		UserCode:                a.UserCode,
		VerificationURI:         a.VerificationURI,
		VerificationURIComplete: a.VerificationURIComplete,
		ExpiresAt:               a.ExpiresAt.UnixMilli(),
	}
}

// connect 发起一次授权；已经有一次在等就不重启它。
func (m *Manager) connect(params map[string]any) (any, error) {
	if _, ok := m.livePending(); ok {
		return m.state(context.Background()), nil
	}
	aff, _ := params["affCode"].(string)
	auth, err := m.client.authorize(context.Background(), ClientName, aff)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.pending = auth
	m.snap.Pending = auth.pendingView()
	m.snap.Error = ""
	m.mu.Unlock()
	m.save()
	m.startPolling(auth)
	return m.state(context.Background()), nil
}

// startPolling 在后台按站点给的间隔问结果；页面只读状态，不参与轮询。
func (m *Manager) startPolling(auth *Authorization) {
	m.mu.Lock()
	if m.polling {
		m.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.polling = true
	m.mu.Unlock()

	go func() {
		defer func() {
			m.mu.Lock()
			m.polling = false
			m.cancel = nil
			m.mu.Unlock()
		}()
		interval := auth.Interval
		if interval <= 0 {
			interval = 5 * time.Second
		}
		timer := time.NewTimer(interval)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			}
			if m.clock().After(auth.ExpiresAt) {
				m.finishAuth("授权已过期，请重新连接。")
				return
			}
			outcome, grant, err := m.client.poll(ctx, auth.DeviceCode)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				// 一次网络抖动不算失败：下一轮再问
				timer.Reset(interval)
				continue
			}
			switch outcome {
			case PollGranted:
				m.completeAuth(grant)
				return
			case PollDenied:
				m.finishAuth("站点上拒绝了这次授权。")
				return
			case PollExpired:
				m.finishAuth("授权已过期，请重新连接。")
				return
			case PollSlowDown:
				interval += 2 * time.Second
				timer.Reset(interval)
			default:
				timer.Reset(interval)
			}
		}
	}()
}

// completeAuth 拿到密钥：挂供应商、拉目录、读钱包，全都落地后才清 pending。
func (m *Manager) completeAuth(grant *Grant) {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()

	cur := m.currency(ctx)
	cat, _ := m.client.readCatalog(ctx)
	if err := attach(m.baseURL, grant.AccessToken, cat); err != nil {
		m.finishAuth("密钥已拿到，但没能挂上 magpie 的供应商：" + err.Error())
		return
	}
	m.saveCatalog(ctx, m.baseURL, cat)

	m.mu.Lock()
	m.pending = nil
	m.snap.Pending = nil
	m.snap.TokenName = grant.TokenName
	m.snap.GrantedAt = m.clock().UnixMilli()
	m.snap.Error = ""
	m.snap.Currency = &cur
	if cat != nil {
		m.snap.Models = len(cat.Models)
		m.snap.Groups = len(cat.Groups)
		m.snap.CatalogAt = m.clock().UnixMilli()
	}
	if acc := summarize(grant.User, cur); acc != nil {
		m.snap.Account = acc
	}
	m.mu.Unlock()
	m.save()
	m.refreshWalletNow(context.Background())
}

// finishAuth 结束一次授权并记下原因。
func (m *Manager) finishAuth(reason string) {
	m.mu.Lock()
	m.pending = nil
	m.snap.Pending = nil
	m.snap.Error = reason
	cancel := m.cancel
	m.mu.Unlock()
	m.save()
	if cancel != nil {
		cancel()
	}
}

// cancelPending 放弃进行中的授权（站点那边的码自然过期）。
func (m *Manager) cancelPending() {
	m.mu.Lock()
	m.pending = nil
	m.snap.Pending = nil
	cancel := m.cancel
	m.mu.Unlock()
	m.save()
	if cancel != nil {
		cancel()
	}
}

// open 让系统浏览器打开正在等的那一页确认页。地址只取 Manager 自己记着的
// 那个，页面没法让宿主打开任意 URL。
func (m *Manager) open() (any, error) {
	auth, ok := m.livePending()
	if !ok {
		return nil, fail(CodeBadParam, "没有等待确认的授权")
	}
	if err := proc.OpenBrowser(auth.VerificationURIComplete); err != nil {
		return map[string]any{
			"opened": false,
			"url":    auth.VerificationURIComplete,
			"error":  "没能打开浏览器，请手动打开这个地址：" + err.Error(),
		}, nil
	}
	return map[string]any{"opened": true, "url": auth.VerificationURIComplete}, nil
}

// disconnect 撤销站点上的密钥、删掉 magpie 里这一条、清掉本地的数字。
func (m *Manager) disconnect(ctx context.Context) (any, error) {
	key, _ := storedKey()
	if key != "" {
		if warn := m.client.revoke(ctx, key); warn != nil {
			// 站点不认这把钥匙也要断开：本地那份必须走
			m.logf("revoking the key: %v", warn)
		}
	}
	m.detach()
	m.mu.Lock()
	m.snap = snapshot{BaseURL: m.baseURL}
	m.pending = nil
	cancel := m.cancel
	m.mu.Unlock()
	m.save()
	if cancel != nil {
		cancel()
	}
	return m.state(ctx), nil
}

// refresh 现在就读一遍钱包与目录，然后回状态。
func (m *Manager) refresh(ctx context.Context) (any, error) {
	key, ok := storedKey()
	if !ok {
		return nil, fail(CodeNotConnected, "还没有连接 NearToken")
	}
	if err := m.readWallet(ctx, key); err != nil {
		return nil, err
	}
	if cat, cerr := m.client.readCatalog(ctx); cerr == nil && cat != nil {
		m.saveCatalog(ctx, m.baseURL, cat)
		m.mu.Lock()
		m.snap.Models = len(cat.Models)
		m.snap.Groups = len(cat.Groups)
		m.snap.CatalogAt = m.clock().UnixMilli()
		m.mu.Unlock()
		m.save()
	}
	return m.state(ctx), nil
}

// refreshWalletSoon 在后台重读一次钱包，同一时间只有一次。
func (m *Manager) refreshWalletSoon() {
	m.mu.Lock()
	stale := m.clock().UnixMilli()-m.snap.WalletAt > walletTTL.Milliseconds()
	if !stale || m.refreshing {
		m.mu.Unlock()
		return
	}
	m.refreshing = true
	m.mu.Unlock()
	go func() {
		defer func() {
			m.mu.Lock()
			m.refreshing = false
			m.mu.Unlock()
		}()
		key, ok := storedKey()
		if !ok {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		if err := m.readWallet(ctx, key); err != nil {
			m.logf("reading the wallet: %v", err)
		}
	}()
}

// refreshWalletNow 是同步版：一次连接完成后立刻要看到数字。
func (m *Manager) refreshWalletNow(ctx context.Context) {
	key, ok := storedKey()
	if !ok {
		return
	}
	if err := m.readWallet(ctx, key); err != nil {
		m.logf("reading the wallet: %v", err)
	}
}

// readWallet 读一次钱包并把它并进快照；失败保留旧数字，不清空。
func (m *Manager) readWallet(ctx context.Context, key string) *Error {
	cur := m.currency(ctx)
	quota, used, vouchers, err := m.client.wallet(ctx, key, cur)
	if err != nil {
		return err
	}
	m.mu.Lock()
	acc := &Account{Vouchers: vouchers}
	if m.snap.Account != nil {
		*acc = *m.snap.Account
		acc.Vouchers = vouchers
	}
	acc.Balance = cur.text(quota)
	acc.Used = cur.text(used)
	m.snap.Account = acc
	m.snap.WalletAt = m.clock().UnixMilli()
	m.snap.Currency = &cur
	m.mu.Unlock()
	m.save()
	return nil
}

// currency 是站点汇率，10 分钟内复用上一次的结果。
func (m *Manager) currency(ctx context.Context) Currency {
	m.mu.Lock()
	cached := m.snap.Currency
	at := m.snap.CurrencyAt
	m.mu.Unlock()
	if cached != nil && cached.PerUnit > 0 && m.clock().UnixMilli()-at < currencyTTL.Milliseconds() {
		return *cached
	}
	cur := m.client.readStatus(ctx)
	m.mu.Lock()
	m.snap.Currency = &cur
	m.snap.CurrencyAt = m.clock().UnixMilli()
	m.mu.Unlock()
	return cur
}

// usage 读看板的一个窗口。
func (m *Manager) usage(ctx context.Context, params map[string]any) (any, error) {
	key, ok := storedKey()
	if !ok {
		return nil, fail(CodeNotConnected, "还没有连接 NearToken")
	}
	span, _ := params["range"].(string)
	if span == "" {
		span = "day"
	}
	m.mu.Lock()
	balance := ""
	if m.snap.Account != nil {
		balance = m.snap.Account.Balance
	}
	m.mu.Unlock()
	cur := m.currency(ctx)
	win, err := m.client.readUsage(ctx, key, balance, span, cur)
	if err != nil {
		return nil, err
	}
	return win, nil
}

// topup 不带 amount 时读充值档位；带了就下单并把支付页交给系统浏览器。
func (m *Manager) topup(ctx context.Context, params map[string]any) (any, error) {
	key, ok := storedKey()
	if !ok {
		return nil, fail(CodeNotConnected, "还没有连接 NearToken")
	}
	cur := m.currency(ctx)
	amount, hasAmount := paramNumber(params, "amount")
	if !hasAmount {
		return m.client.topupInfo(ctx, key, cur), nil
	}
	method, _ := params["paymentMethod"].(string)
	order, err := m.client.topup(ctx, key, amount, method)
	if err != nil {
		return nil, err
	}
	opened := proc.OpenBrowser(order.URL) == nil
	// 付完几分钟内余额自己再读一次，不必回页面点刷新
	time.AfterFunc(20*time.Second, m.refreshWalletSoon)
	return map[string]any{"order": order, "opened": opened, "url": order.URL}, nil
}

// paramNumber 从页面给的 params 里取一个数（JSON 解出来是 float64）。
func paramNumber(params map[string]any, name string) (float64, bool) {
	switch v := params[name].(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	}
	return 0, false
}

// logf 是这只表的日志：前缀让它从 magpie 别的日志里认得出来。
func (m *Manager) logf(format string, args ...any) {
	log.Printf("neartoken: "+format, args...)
}
