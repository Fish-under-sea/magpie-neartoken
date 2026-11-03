package neartoken

import (
	"context"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// 站点的设备授权端点（RFC 8628 形状，字段名已冻结）。
const (
	authorizePath = "/api/dsh/device/authorize"
	tokenPath     = "/api/dsh/device/token"
	revokePath    = "/api/dsh/device/revoke"
)

// Authorization 是一次进行中的授权。DeviceCode 从不给页面看。
type Authorization struct {
	DeviceCode              string
	UserCode                string
	VerificationURI         string
	VerificationURIComplete string
	ExpiresAt               time.Time
	Interval                time.Duration
}

// PollOutcome 是一次轮询的结果；除了 Unknown，其余都不是错误。
type PollOutcome int

const (
	PollPending PollOutcome = iota
	PollSlowDown
	PollDenied
	PollExpired
	PollGranted
)

// Grant 是站点签下来的密钥与它给的身份。
type Grant struct {
	AccessToken string
	TokenName   string
	User        map[string]any
}

// affiliateCode 只接受 [A-Za-z0-9_-]{1,64}；别的整条丢掉，连接照常发起。
var affiliateCode = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// withAffiliate 把邀请码拼到确认页地址上（站点前端会把它存进 localStorage）。
func withAffiliate(raw, code string) string {
	code = strings.TrimSpace(code)
	if !affiliateCode.MatchString(code) {
		return raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	q := u.Query()
	q.Set("aff", code)
	u.RawQuery = q.Encode()
	return u.String()
}

// authorize 向站点要一个新的授权码。
//
// 请求体除 client_name 外还带 token_name：站点按它命名时，令牌就是 Magpie；
// 站点忽略它也没有副作用——令牌名最终以站点回的 token_name 为准。
func (c *client) authorize(ctx context.Context, clientName, aff string) (*Authorization, *Error) {
	body := map[string]any{"client_name": clientName, "token_name": TokenName}
	env, err := c.call(ctx, "POST", authorizePath, body, "")
	if err != nil {
		return nil, err
	}
	if !env.ok() {
		return nil, env.refused("发起设备授权")
	}
	var data struct {
		DeviceCode              string `json:"device_code"`
		UserCode                string `json:"user_code"`
		VerificationURI         string `json:"verification_uri"`
		VerificationURIComplete string `json:"verification_uri_complete"`
		ExpiresIn               int    `json:"expires_in"`
		Interval                int    `json:"interval"`
	}
	if err := env.decode(&data); err != nil {
		return nil, err
	}
	if data.DeviceCode == "" || data.UserCode == "" || data.VerificationURI == "" {
		return nil, fail(CodeInvalidAnswer, "设备授权应答缺少 device_code / user_code / verification_uri")
	}
	if data.ExpiresIn <= 0 {
		data.ExpiresIn = 600
	}
	if data.Interval <= 0 {
		data.Interval = 5
	}
	complete := data.VerificationURIComplete
	if complete == "" {
		complete = data.VerificationURI
	}
	// 两个地址都带邀请码：卡片打开的是完整的那个，复制走的也不该丢邀请人。
	return &Authorization{
		DeviceCode:              data.DeviceCode,
		UserCode:                data.UserCode,
		VerificationURI:         withAffiliate(data.VerificationURI, aff),
		VerificationURIComplete: withAffiliate(complete, aff),
		ExpiresAt:               time.Now().Add(time.Duration(data.ExpiresIn) * time.Second),
		Interval:                time.Duration(data.Interval) * time.Second,
	}, nil
}

// poll 问站点人决定了没有。非授权的四种状态按站点给的字符串判定，不看状态码。
func (c *client) poll(ctx context.Context, deviceCode string) (PollOutcome, *Grant, *Error) {
	env, err := c.call(ctx, "POST", tokenPath, map[string]any{"device_code": deviceCode}, "")
	if err != nil {
		return 0, nil, err
	}
	if env.ok() {
		var data struct {
			AccessToken string         `json:"access_token"`
			TokenName   string         `json:"token_name"`
			User        map[string]any `json:"user"`
		}
		if derr := env.decode(&data); derr != nil {
			return 0, nil, derr
		}
		if data.AccessToken == "" {
			return 0, nil, fail(CodeInvalidAnswer, "设备授权应答缺少 access_token")
		}
		if data.TokenName == "" {
			data.TokenName = TokenName
		}
		return PollGranted, &Grant{AccessToken: data.AccessToken, TokenName: data.TokenName, User: data.User}, nil
	}
	switch env.said() {
	case "authorization_pending":
		return PollPending, nil, nil
	case "slow_down":
		return PollSlowDown, nil, nil
	case "access_denied":
		return PollDenied, nil, nil
	case "expired_token":
		return PollExpired, nil, nil
	}
	if said := env.said(); said != "" {
		return 0, nil, fail(CodeRefused, "设备授权轮询返回了未知状态：%s", said)
	}
	return 0, nil, fail(CodeRefused, "设备授权轮询被站点拒绝了")
}

// revoke 撤销一把插件签下的密钥；站点幂等，已经不存在也算成功。
func (c *client) revoke(ctx context.Context, key string) *Error {
	env, err := c.call(ctx, "POST", revokePath, nil, key)
	if err != nil {
		return err
	}
	if !env.ok() {
		return env.refused("撤销令牌")
	}
	return nil
}
