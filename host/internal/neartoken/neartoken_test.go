package neartoken

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/yetone/magpie/internal/testenv"
)

// TestMain 把 HOME 与 XDG 目录指进临时目录：这只表会读 providers.json，
// 测试绝不能碰用户自己的那一份。
func TestMain(m *testing.M) { testenv.Main(m) }

// fakeSite 是站点的一个替身：全部端点都从这里答，测试不碰网络。
type fakeSite struct {
	mu       sync.Mutex
	srv      *httptest.Server
	decision string // pending / granted / denied / expired / slow_down
	polls    int
	revoked  []string
	topupOff bool
	lastAuth string
}

func newFakeSite(t *testing.T) *fakeSite {
	t.Helper()
	f := &fakeSite{decision: "granted"}
	mux := http.NewServeMux()

	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{"success": true, "data": map[string]any{
			"system_name":         "NearToken",
			"quota_per_unit":      500000,
			"usd_exchange_rate":   7.2,
			"display_in_currency": true,
		}})
	})
	mux.HandleFunc("/api/dsh/device/authorize", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["client_name"] != "magpie" {
			t.Errorf("client_name = %v, want magpie", body["client_name"])
		}
		write(w, map[string]any{"success": true, "data": map[string]any{
			"device_code":               "dev-1",
			"user_code":                 "K7QM-3XPD",
			"verification_uri":          "https://site/dsh/device",
			"verification_uri_complete": "https://site/dsh/device?user_code=K7QM-3XPD",
			"expires_in":                600,
			"interval":                  5,
		}})
	})
	mux.HandleFunc("/api/dsh/device/token", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.polls++
		decision := f.decision
		f.mu.Unlock()
		switch decision {
		case "granted":
			write(w, map[string]any{"success": true, "data": map[string]any{
				"access_token": "sk-abc",
				"token_name":   "magpie",
				"user":         map[string]any{"username": "fish", "display_name": "Fish", "group": "default", "quota": 250000, "used_quota": 50000},
			}})
		default:
			write(w, map[string]any{"success": false, "message": decision})
		}
	})
	mux.HandleFunc("/api/dsh/device/revoke", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.revoked = append(f.revoked, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		f.mu.Unlock()
		write(w, map[string]any{"success": true})
	})
	mux.HandleFunc("/api/dsh/device/wallet", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.lastAuth = r.Header.Get("Authorization")
		f.mu.Unlock()
		write(w, map[string]any{"success": true, "data": map[string]any{
			"quota":      250000,
			"used_quota": 50000,
			"group_credits": []map[string]any{
				{"group": "[低价] Grok", "group_id": 7, "amount": 100000},
				{"group": "空的", "group_id": 8, "amount": 0},
			},
		}})
	})
	mux.HandleFunc("/api/dsh/device/usage", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("range") != "day" && r.URL.Query().Get("range") != "week" && r.URL.Query().Get("range") != "month" {
			http.Error(w, "bad range", http.StatusBadRequest)
			return
		}
		write(w, map[string]any{"success": true, "data": map[string]any{
			"start_timestamp": 1700000000,
			"end_timestamp":   1700086400,
			"bucket_seconds":  3600,
			"quota":           100000,
			"tokens":          12345,
			"models": []map[string]any{
				{"model": "gpt-5", "quota": 60000, "tokens": 8000},
				{"model": "claude-5", "quota": 40000, "tokens": 4345},
			},
			"buckets": []map[string]any{
				{"timestamp": 1700000000, "models": []map[string]any{{"model": "gpt-5", "quota": 30000, "tokens": 4000}}},
				{"timestamp": 1700003600, "models": []map[string]any{}},
			},
		}})
	})
	mux.HandleFunc("/api/dsh/device/topup/info", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		off := f.topupOff
		f.mu.Unlock()
		if off {
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			write(w, map[string]any{"success": false, "message": "not a DSH key", "code": CodeTokenRequired})
			return
		}
		write(w, map[string]any{"success": true, "data": map[string]any{
			"enable_online_topup": true,
			"min_topup":           10,
			"amount_options":      []float64{10, 20, 50},
			"pay_methods":         []map[string]any{{"name": "支付宝", "type": "alipay"}},
		}})
	})
	mux.HandleFunc("/api/dsh/device/topup", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["amount"].(float64) != 20 || body["payment_method"] != "alipay" {
			t.Errorf("order body = %v", body)
		}
		write(w, map[string]any{"success": true, "data": map[string]any{
			"trade_no": "DSH3NO1",
			"pay_url":  "/dsh/pay?trade_no=DSH3NO1&sig=x",
		}})
	})
	mux.HandleFunc("/api/pricing", func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{
			"success": true,
			"data": []map[string]any{
				{"model_name": "gpt-5", "enable_groups": []string{"[满血] GPT"}, "supported_endpoint_types": []string{"openai"}},
				{"model_name": "claude-5", "enable_groups": []string{"[满血] Claude"}, "supported_endpoint_types": []string{"anthropic"}},
				{"model_name": "gpt-5-c", "enable_groups": []string{"[满血] GPT"}, "supported_endpoint_types": []string{"openai"}},
				{"model_name": "gpt-image-2", "enable_groups": []string{"[满血] GPT"}, "supported_endpoint_types": []string{"openai"}},
				{"model_name": "text-embedding-3-large", "enable_groups": []string{"向量"}, "supported_endpoint_types": []string{"openai"}},
				{"model_name": "gemini-3-pro", "enable_groups": []string{"[满血] Gemini"}, "supported_endpoint_types": []string{"gemini"}},
			},
			"group_refs": map[string]string{"[满血] GPT": "#3"},
		})
	})

	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func write(w http.ResponseWriter, v any) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func TestAuthorizeAndGrant(t *testing.T) {
	site := newFakeSite(t)
	c := newClient(site.srv.URL)

	auth, err := c.authorize(t.Context(), "magpie", "aB3d")
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	if auth.UserCode != "K7QM-3XPD" || auth.DeviceCode != "dev-1" {
		t.Fatalf("auth = %+v", auth)
	}
	if !strings.Contains(auth.VerificationURIComplete, "aff=aB3d") {
		t.Errorf("affiliate code lost: %s", auth.VerificationURIComplete)
	}

	outcome, grant, perr := c.poll(t.Context(), auth.DeviceCode)
	if perr != nil {
		t.Fatalf("poll: %v", perr)
	}
	if outcome != PollGranted || grant.AccessToken != "sk-abc" || grant.TokenName != "magpie" {
		t.Fatalf("outcome = %v, grant = %+v", outcome, grant)
	}
	if grant.User["username"] != "fish" {
		t.Errorf("user = %v", grant.User)
	}
}

func TestPollStates(t *testing.T) {
	for _, tc := range []struct {
		decision string
		want     PollOutcome
	}{
		{"authorization_pending", PollPending},
		{"slow_down", PollSlowDown},
		{"access_denied", PollDenied},
		{"expired_token", PollExpired},
	} {
		t.Run(tc.decision, func(t *testing.T) {
			site := newFakeSite(t)
			site.decision = tc.decision
			outcome, _, err := newClient(site.srv.URL).poll(t.Context(), "dev-1")
			if err != nil {
				t.Fatalf("poll: %v", err)
			}
			if outcome != tc.want {
				t.Fatalf("outcome = %v, want %v", outcome, tc.want)
			}
		})
	}
}

func TestBadAffiliateCodeIsDropped(t *testing.T) {
	site := newFakeSite(t)
	auth, err := newClient(site.srv.URL).authorize(t.Context(), "magpie", "bad code!")
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	if strings.Contains(auth.VerificationURIComplete, "aff=") {
		t.Errorf("an invalid code was sent on: %s", auth.VerificationURIComplete)
	}
}

func TestWalletMoney(t *testing.T) {
	site := newFakeSite(t)
	c := newClient(site.srv.URL)
	cur := c.readStatus(t.Context())
	if cur.PerUnit != 500000 || cur.Rate != 7.2 || !cur.Display {
		t.Fatalf("currency = %+v", cur)
	}
	quota, used, vouchers, err := c.wallet(t.Context(), "sk-abc", cur)
	if err != nil {
		t.Fatalf("wallet: %v", err)
	}
	if site.lastAuth != "Bearer sk-abc" {
		t.Errorf("auth header = %q", site.lastAuth)
	}
	if cur.text(quota) != "￥3.60" {
		// 250000 / 500000 = 0.5 USD × 7.2 = 3.6
		t.Errorf("balance = %s", cur.text(quota))
	}
	if cur.text(used) != "￥0.72" {
		t.Errorf("used = %s", cur.text(used))
	}
	if len(vouchers) != 1 || vouchers[0].Group != "[低价] Grok" || vouchers[0].Amount != "￥1.44" {
		t.Errorf("vouchers = %+v", vouchers)
	}
}

func TestUsageWindow(t *testing.T) {
	site := newFakeSite(t)
	c := newClient(site.srv.URL)
	cur := c.readStatus(t.Context())

	win, err := c.readUsage(t.Context(), "sk-abc", "￥3.60", "day", cur)
	if err != nil {
		t.Fatalf("usage: %v", err)
	}
	if !win.Available || win.Spent != "￥1.44" || win.Tokens != 12345 {
		t.Fatalf("window = %+v", win)
	}
	if len(win.Models) != 2 || win.Models[0].Model != "gpt-5" || win.Models[0].CostText != "￥0.86" {
		t.Errorf("models = %+v", win.Models)
	}
	if len(win.Buckets) != 2 {
		t.Errorf("buckets = %d", len(win.Buckets))
	}
	if _, err := c.readUsage(t.Context(), "sk-abc", "", "year", cur); err == nil {
		t.Error("a window the site doesn't have was taken")
	}
}

func TestUsageUnsupportedSite(t *testing.T) {
	// 老站点：这条路径回的是 JSON 但没有窗口
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{"success": false, "message": "invalid URL"})
	}))
	t.Cleanup(srv.Close)

	win, err := newClient(srv.URL).readUsage(t.Context(), "sk", "￥1.00", "day", Currency{PerUnit: 500000})
	if err != nil {
		t.Fatalf("usage: %v", err)
	}
	if win.Available || win.Reason != "unsupported" {
		t.Fatalf("window = %+v", win)
	}
}

func TestTopup(t *testing.T) {
	site := newFakeSite(t)
	c := newClient(site.srv.URL)
	cur := c.readStatus(t.Context())

	info := c.topupInfo(t.Context(), "sk-abc", cur)
	if info.Unavailable != "" || !info.Enabled || len(info.Options) != 3 || len(info.Methods) != 1 {
		t.Fatalf("info = %+v", info)
	}

	order, err := c.topup(t.Context(), "sk-abc", 20, "alipay")
	if err != nil {
		t.Fatalf("topup: %v", err)
	}
	if order.TradeNo != "DSH3NO1" || !strings.HasPrefix(order.URL, site.srv.URL+"/dsh/pay") {
		t.Fatalf("order = %+v", order)
	}

	if _, err := c.topup(t.Context(), "sk-abc", 0, "alipay"); err == nil {
		t.Error("a zero amount was taken")
	}

	site.topupOff = true
	off := c.topupInfo(t.Context(), "sk-abc", cur)
	if !strings.Contains(off.Unavailable, "重新连接") {
		t.Errorf("a key the site doesn't sell top-ups to: %q", off.Unavailable)
	}
}

func TestCatalogKeepsChatModelsOnly(t *testing.T) {
	site := newFakeSite(t)
	cat, err := newClient(site.srv.URL).readCatalog(t.Context())
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	got := strings.Join(cat.Models, ",")
	want := "gpt-5,claude-5,gemini-3-pro"
	if got != want {
		t.Fatalf("models = %s, want %s", got, want)
	}
	if len(cat.Groups) != 3 {
		t.Errorf("groups = %v", cat.Groups)
	}
	if cat.Refs["[满血] GPT"] != "#3" {
		t.Errorf("refs = %v", cat.Refs)
	}
}

func TestManagerStateWithoutAConnection(t *testing.T) {
	m := New(t.TempDir())
	view := m.state(t.Context())
	if view.Configured || view.Pending != nil || view.ProviderID != ProviderID {
		t.Fatalf("view = %+v", view)
	}
	if view.Currency.PerUnit != 1 {
		t.Errorf("a site not read yet should default to raw quota, got %+v", view.Currency)
	}
}

func TestRevokeSendsTheKey(t *testing.T) {
	site := newFakeSite(t)
	if err := newClient(site.srv.URL).revoke(t.Context(), "sk-abc"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if len(site.revoked) != 1 || site.revoked[0] != "sk-abc" {
		t.Fatalf("revoked = %v", site.revoked)
	}
}

// 保持 io 被用到（编不过就说明测试夹具改坏了）
var _ = io.Discard
