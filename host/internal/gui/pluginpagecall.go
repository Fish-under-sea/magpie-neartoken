package gui

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/yetone/magpie/internal/neartoken"
	"github.com/yetone/magpie/internal/plugin"
	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/relay"
	"github.com/yetone/magpie/internal/settings"
)

// 插件页能问 magpie 做的事（magpie.calls）。页面跑在 CSP connect-src 'none'
// 的沙箱帧里，一条 fetch 都发不出去：它要的每一次出站请求、每一次状态改动
// 都必须回到这里，由 magpie 本体执行。所以这张表是唯一的入口，名字不在表
// 里的请求一律拒绝，连"这个插件有没有别的办法"都不透露。

// relayService 是进程内的一份探测状态：插件页关掉、重开都接着上一次的结果，
// 同时也不会因为重开页面就再打一遍上游。
var relayService = relay.NewManager()

// relayStorePath 是 relay 配置的位置（与 providers.json 同目录）。
func relayStorePath() string { return relay.Path() }

// pluginCall 执行一次页面请求。spec 是发起请求的插件，name 是它声明的
// magpie.calls 里的一条，params 由页面给。
func pluginCall(ctx context.Context, spec, name string, params map[string]any) (any, error) {
	switch {
	case strings.HasPrefix(name, "relay:"):
		return relayCall(ctx, name, params)
	case strings.HasPrefix(name, "checkin:"):
		return checkinCall(ctx, name, params)
	case strings.HasPrefix(name, "brand:"):
		return brandCall(name, params)
	case strings.HasPrefix(name, "neartoken:"):
		// 站点在自己的 https 上，页面在 connect-src 'none' 里：登录、余额、
		// 用量、充值都只能由 magpie 本体代为出站。
		return neartoken.Call(ctx, name, params)
	}
	return nil, errNoCall(name)
}

// errNoCall 是不认识的名字：不区分"没这个功能"和"你没这个权限"。
func errNoCall(name string) error { return errors.New("no such call") }

// relayCall 是 relay:* 五条。
func relayCall(ctx context.Context, name string, params map[string]any) (any, error) {
	switch name {
	case "relay:view":
		return relayView()
	case "relay:save":
		return relaySave(params)
	case "relay:start":
		return relayStart()
	case "relay:status":
		return relayStatus()
	case "relay:stop":
		return relayStop()
	}
	return nil, errNoCall(name)
}

// relayView 是页面打开时看到的东西：配置（Key 只有打码）+ 当前状态。
// 它从不返回明文 Key——页面、截图、日志里都不该出现它。
func relayView() (any, error) {
	stored, err := relay.Load(relayStorePath())
	if err != nil {
		return nil, err
	}
	state := relayService.Snapshot()
	return map[string]any{
		"config": map[string]any{
			"baseUrl":         relay.PublicBaseURL(stored.BaseURL),
			"baseUrlRaw":      stored.BaseURL,
			"model":           fallbackString(stored.Model, relay.DefaultModel),
			"comparisonModel": fallbackString(stored.ComparisonModel, relay.ComparisonModel),
			"authMode":        fallbackString(stored.AuthMode, "auto"),
			"apiVersion":      fallbackString(stored.APIVersion, relay.DefaultAPIVersion),
			"timeoutMs":       stored.TimeoutMs,
			"keyHint":         relay.Masked(stored),
			"hasKey":          stored.SealedKey != "",
		},
		"state": state,
	}, nil
}

// relaySave 存配置。apiKey 空字符串表示"沿用已存的 Key"，所以页面不必为了
// 改个模型就把 Key 再打一遍。
func relaySave(params map[string]any) (any, error) {
	stored, err := relay.Load(relayStorePath())
	if err != nil {
		return nil, err
	}
	if value, ok := paramString(params, "baseUrl"); ok {
		stored.BaseURL = value
	}
	if value, ok := paramString(params, "model"); ok {
		stored.Model = value
	}
	if value, ok := paramString(params, "comparisonModel"); ok {
		stored.ComparisonModel = value
	}
	if value, ok := paramString(params, "authMode"); ok {
		stored.AuthMode = value
	}
	if value, ok := paramString(params, "apiVersion"); ok {
		stored.APIVersion = value
	}
	if value, ok := paramInt(params, "timeoutMs"); ok {
		stored.TimeoutMs = value
	}
	// 存之前就校验：坏地址不该进了磁盘才在探测时报错。
	if strings.TrimSpace(stored.BaseURL) != "" {
		normalized, err := relay.NormalizeBaseURL(stored.BaseURL)
		if err != nil {
			return nil, err
		}
		stored.BaseURL = normalized
	}
	if _, err := relay.ValidateModel(stored.Model, relay.DefaultModel); err != nil {
		return nil, err
	}
	if _, err := relay.ValidateModel(stored.ComparisonModel, relay.ComparisonModel); err != nil {
		return nil, err
	}
	if _, err := relay.ValidateAuthMode(stored.AuthMode); err != nil {
		return nil, err
	}
	if _, err := relay.ValidateAPIVersion(stored.APIVersion); err != nil {
		return nil, err
	}
	if _, err := relay.NormalizeTimeout(stored.TimeoutMs); err != nil {
		return nil, err
	}
	if key, ok := paramString(params, "apiKey"); ok && strings.TrimSpace(key) != "" {
		sealed, err := relay.SealKey(key)
		if err != nil {
			return nil, err
		}
		stored.SealedKey = sealed
		stored.KeyHint = relay.Hint(key)
	}
	if err := relay.Save(relayStorePath(), stored); err != nil {
		return nil, err
	}
	return relayView()
}

// relayStart 用存好的配置起一轮探测。Key 在这里才被解开，解不开就让用户
// 重填（换机器、换用户都会这样），不静默失败。
func relayStart() (any, error) {
	stored, err := relay.Load(relayStorePath())
	if err != nil {
		return nil, err
	}
	key, err := relay.OpenKey(stored.SealedKey)
	if err != nil || key == "" {
		return nil, relayErr("KEY_REQUIRED", "请先填写 API Key")
	}
	timeout, err := relay.NormalizeTimeout(stored.TimeoutMs)
	if err != nil {
		return nil, err
	}
	cfg := relay.Config{
		BaseURL:         stored.BaseURL,
		APIKey:          key,
		Model:           stored.Model,
		ComparisonModel: stored.ComparisonModel,
		AuthMode:        stored.AuthMode,
		APIVersion:      stored.APIVersion,
		Timeout:         timeout,
	}
	if err := relayService.Start(cfg); err != nil {
		return nil, err
	}
	return relayStatus()
}

func relayStatus() (any, error) { return relayService.Snapshot(), nil }

func relayStop() (any, error) { return relayService.Stop(), nil }

// relayErr 把 relay 包里的错误码带到页面上，页面据此给一句人话。
func relayErr(code, message string) error { return &relayCallError{code: code, message: message} }

type relayCallError struct {
	code    string
	message string
}

func (e *relayCallError) Error() string { return e.message }

// Code 让页面拿到稳定的分支码。
func (e *relayCallError) Code() string { return e.code }

// checkinCall 接的是现有的签到与额度刷新逻辑：这些命令以前只能从 magpie
// 自己的页面点（/api/settings/plugin-checkin、/api/usage/plugin-checkin），
// 插件页的开关一直是死的——它写的是 fetch，而 CSP 不允许 fetch。
func checkinCall(ctx context.Context, name string, params map[string]any) (any, error) {
	switch name {
	case "checkin:state":
		return checkinState(), nil
	case "checkin:set-provider":
		return checkinSetProvider(params)
	case "checkin:run":
		return checkinRun(ctx, params)
	case "checkin:refresh":
		return checkinRefresh(ctx, params)
	case "checkin:set-account":
		return checkinSetAccount(params)
	}
	return nil, errNoCall(name)
}

// checkinSetAccount 是单个账号的签到开关，用的就是设置页那份 settings.CheckinOff：
// 关掉只把这个账号排除在每日签到之外，厂商级开关不动。这里原先回一个
// ACCOUNT_LEVEL_UNSUPPORTED，其实 magpie 一直有这个字段（/api/settings/
// checkin-account 写的就是它），结果插件页上那个账号开关点下去只会报错。
func checkinSetAccount(params map[string]any) (any, error) {
	key, _ := params["key"].(string)
	if key == "" {
		return nil, relayErr("NO_ACCOUNT", "缺少账号 key")
	}
	on, ok := params["on"].(bool)
	if !ok {
		return nil, relayErr("BAD_PARAM", "on 必须是布尔值")
	}
	s := settings.Load()
	off := slices.DeleteFunc(slices.Clone(s.CheckinOff), func(k string) bool { return k == key })
	if !on {
		off = append(off, key)
	}
	if len(off) == 0 {
		off = nil
	}
	s.CheckinOff = off
	if err := settings.Save(s); err != nil {
		return nil, err
	}
	return checkinState(), nil
}

// checkinState 是插件页「自动签到」一次读到的全部内容：厂商、账号、今天每个
// 账号的结果、实得积分与额度估计。定义在 provider 包，页面只拿聚合值。
func checkinState() provider.CheckinViewState { return provider.CheckinViewStateNow() }

// checkinSetProvider 是 /api/settings/plugin-checkin 的同一件事。
func checkinSetProvider(params map[string]any) (any, error) {
	providerID, ok := paramString(params, "provider")
	if !ok || strings.TrimSpace(providerID) == "" {
		return nil, relayErr("PROVIDER_REQUIRED", "缺少厂商 id")
	}
	on, _ := paramBool(params, "on")
	s := settings.Load()
	if s.PluginCheckins == nil {
		s.PluginCheckins = map[string]bool{}
	} else {
		clone := make(map[string]bool, len(s.PluginCheckins))
		for id, value := range s.PluginCheckins {
			clone[id] = value
		}
		s.PluginCheckins = clone
	}
	s.PluginCheckins[providerID] = on
	if err := settings.Save(s); err != nil {
		return nil, err
	}
	return checkinState(), nil
}

// checkinRun 是 /api/usage/plugin-checkin 的同一件事：让插件对某厂商的账号
// 各签一次到。超时与那条端点一致，都是一分钟。
//
// 不带 provider 就是每家都签：页面顶部的「立即签到」本来就不带厂商，以前这里
// 直接回「缺少厂商 id」，那颗按钮永远失败（issue #9）。参数里给了 provider
// 仍然只签那一家，与原来一致。
func checkinRun(ctx context.Context, params map[string]any) (any, error) {
	runCtx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	results := provider.CheckInPlugins(runCtx, checkinTargets(params)...)
	if results == nil {
		results = []provider.WorkBuddyCheckin{}
	}
	return results, nil
}

// checkinTargets 是这次要签到的厂商：给了 provider 就只签它，没给就是空列表，
// CheckInPlugins 把空列表当成「每家都签」。空串与纯空白按没给处理。
func checkinTargets(params map[string]any) []string {
	id, ok := paramString(params, "provider")
	if !ok {
		return nil
	}
	if id = strings.TrimSpace(id); id == "" {
		return nil
	}
	return []string{id}
}

// checkinRefresh 是 /api/usage/quotas/refresh 的同一件事：把额度卡片重新读
// 一遍，页面随后再读一次 checkin:state 就有新数字。超时与那条端点一致，30 秒。
//
// 它以前和 checkin:run 走同一个分支，于是「刷新今日积分」实际是又签了一次到：
// 签到的结果变不了，额度面板也不会重读。现在两家分开。
func checkinRefresh(ctx context.Context, params map[string]any) (any, error) {
	readCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	for _, id := range checkinRefreshTargets(provider.CheckinViewStateNow().Providers, params) {
		provider.RefreshUsage(readCtx, id, "")
	}
	return provider.CheckinViewStateNow(), nil
}

// checkinRefreshTargets 是这次要重读额度的厂商：给了 provider 就只读它，没给
// 就把页面上有账号的厂商每家读一遍。
func checkinRefreshTargets(providers []provider.CheckinProviderState, params map[string]any) []string {
	if ids := checkinTargets(params); len(ids) > 0 {
		return ids
	}
	ids := make([]string, 0, len(providers))
	for _, p := range providers {
		if strings.TrimSpace(p.ID) != "" {
			ids = append(ids, p.ID)
		}
	}
	return ids
}

// brandCall 是「预装插件美化」那两颗：读开关、翻开关。素材编在 exe 里，
// 所以这里只翻一个标记，页面不必把图标传上来。
func brandCall(name string, params map[string]any) (any, error) {
	switch name {
	case "brand:status":
		return brandState(), nil
	case "brand:set":
		on, ok := params["on"].(bool)
		if !ok {
			return nil, relayErr("BAD_PARAM", "on 必须是布尔值")
		}
		if err := provider.SetBrand(on); err != nil {
			return nil, err
		}
		return brandState(), nil
	}
	return nil, errNoCall(name)
}

// brandState 是页面要的那一行：开关状态 + 覆盖了哪几家。首次安装那段时间还
// 报「登记了、还没装上」的数量，页面据此说「正在准备 N 个供应商插件」，装完
// 归零就消失（#16）。读不到就根本不带这个键，页面不显示那一行。
func brandState() map[string]any {
	vendors := provider.BrandVendors()
	state := map[string]any{"on": provider.BrandOn(), "vendors": vendors, "count": len(vendors)}
	if n, ok := preinstallPending(); ok {
		state["pendingPlugins"] = n
	}
	return state
}

// preinstallStatePath 是宿主首启登记预装插件后落的那份状态（Node 侧
// preinstall.mjs 写，与 providers.json 同一个数据目录下的 config/）。
func preinstallStatePath() string {
	return filepath.Join(filepath.Dir(provider.Path()), "config", "preinstall-state.json")
}

// preinstallPending 是「登记了、还没装上」的包数：登记名单来自状态文件，装没
// 装按 <data>/plugins 下真实的安装读一遍现算——状态文件自己记的数字装完就是
// 旧账，不能拿它当真。读不到（老数据、首启还没落盘）返回 false，不报错。
func preinstallPending() (int, bool) {
	b, err := os.ReadFile(preinstallStatePath())
	if err != nil {
		return 0, false
	}
	var state struct {
		Registered []string `json:"registered"`
	}
	if json.Unmarshal(b, &state) != nil || len(state.Registered) == 0 {
		return 0, false
	}
	pending := 0
	for _, spec := range state.Registered {
		if plugin.Installed(spec) == "" {
			pending++
		}
	}
	return pending, true
}

// paramString 取一个字符串参数（页面可能把它包在 params 里）。
func paramString(params map[string]any, key string) (string, bool) {
	value, ok := params[key]
	if !ok {
		return "", false
	}
	text, ok := value.(string)
	return text, ok
}

// paramBool 取一个布尔参数。
func paramBool(params map[string]any, key string) (bool, bool) {
	value, ok := params[key]
	if !ok {
		return false, false
	}
	switch v := value.(type) {
	case bool:
		return v, true
	}
	return false, false
}

// paramInt 取一个整数参数（JSON 解出来是 float64）。
func paramInt(params map[string]any, key string) (int, bool) {
	value, ok := params[key]
	if !ok {
		return 0, false
	}
	switch v := value.(type) {
	case float64:
		return int(v), true
	case int:
		return v, true
	}
	return 0, false
}

func fallbackString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

// pluginCallRoutes 注册页面请求的入口：POST /api/plugin-pages/call。
//
// 校验顺序是固定的：先看 spec 是不是一个开着的插件页 → 再看 name 是否在它
// 自己 package.json 的 magpie.calls 里 → 才执行。请求体大小与 read 那条端点
// 一样压到 64 KiB。
func pluginCallRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/plugin-pages/call", func(rw http.ResponseWriter, r *http.Request) {
		var in struct {
			Spec   string         `json:"spec"`
			Name   string         `json:"name"`
			Params map[string]any `json:"params"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(rw, r.Body, 64<<10)).Decode(&in); err != nil {
			fail(rw, err)
			return
		}
		calls, ok := windowCalls(in.Spec)
		if !ok {
			fail(rw, errors.New("no plugin page "+in.Spec))
			return
		}
		name := strings.TrimSpace(in.Name)
		if !callAllowed(calls, name) {
			rw.Header().Set("Content-Type", "application/json")
			rw.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(rw).Encode(map[string]string{"error": "this page doesn't ask for " + name})
			return
		}
		// 一次调用最多一分钟：签到要联网，探测有自己的超时。
		ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
		defer cancel()
		value, err := pluginCall(ctx, in.Spec, name, in.Params)
		if err != nil {
			var coded interface{ Code() string }
			if errors.As(err, &coded) {
				rw.Header().Set("Content-Type", "application/json")
				rw.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(rw).Encode(map[string]string{"error": err.Error(), "code": coded.Code()})
				return
			}
			var relayError *relay.Error
			if errors.As(err, &relayError) {
				rw.Header().Set("Content-Type", "application/json")
				rw.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(rw).Encode(map[string]string{"error": relayError.Message, "code": relayError.Code})
				return
			}
			fail(rw, err)
			return
		}
		writeJSON(rw, value)
	})
}
