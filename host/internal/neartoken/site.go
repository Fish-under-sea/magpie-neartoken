// Package neartoken 把 NearToken（https://neartoken.cc，一个 New API 部署）
// 接进 magpie：设备授权登录、余额与代金券、用量看板、在线充值，以及把站点
// 作为 magpie 自己的一个供应商挂上（模型与路由仍由 magpie 原生负责）。
//
// 站点只在一个地方被说起：baseURL。所有请求都从这里出，所有错误都带一个
// 稳定的码，页面对着码给一句人话，而不是把上游的英文原样铺开。
package neartoken

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// DefaultBaseURL 是站点根地址，不带尾斜杠。
const DefaultBaseURL = "https://neartoken.cc"

// ProviderID 是这个插件在 magpie 里挂的供应商 id：一个就好，不支持多账号。
const ProviderID = "neartoken"

// ClientName 是站点确认页上显示的这头设备的称呼。
//
// 它故意不是 dsh-neartoken 的「DSH 插件」：那位作者的令牌、日志与授权记录
// 都靠 DSH 这个标识认人，我们的连接混进同一串标识里，他排查时就分不清哪一条
// 是自己的用户。这里写 Magpie。
const ClientName = "Magpie"

// TokenName 是请求站点给这把密钥起的名字。
//
// 站点按 client_name 命名时它就是令牌名；站点另有实现时会忽略它——带上不会
// 出错，但**令牌名最终由站点决定**。所以插件不把它当事实：页面显示的是站点
// 回的 token_name，回什么显示什么。
const TokenName = "Magpie"

// UserAgent 让站点的访问日志与 New API 的请求记录分得出来源。不是标准要求，
// 但排查时省一次猜。
const UserAgent = "magpie-neartoken"

// 页面对着这些码分支；字符串是页面与 Go 共同的语言，不要随手改。
const (
	CodeUnreachable   = "SITE_UNREACHABLE"
	CodeInvalidAnswer = "SITE_RESPONSE_INVALID"
	CodeRefused       = "SITE_REFUSED"
	CodeNotConnected  = "NOT_CONNECTED"
	// CodeTokenRequired 是站点为「只有 DSH 设备授权签发的令牌才能充值」写的码，
	// 名字里的 DSH 是站点自己的历史，不是本插件的标识；这里只按它分支，对外
	// 一律说「这把密钥不是本插件登录签发的」。
	CodeTokenRequired  = "DSH_TOKEN_REQUIRED"
	CodeTopupOff       = "TOPUP_UNAVAILABLE"
	CodeNoUsage        = "NO_USAGE"
	CodeBadParam       = "INVALID_PARAM"
	CodeAuthExpired    = "AUTH_EXPIRED"
	CodeProvider       = "PROVIDER_FAILED"
	CodeAuthInProgress = "AUTH_IN_PROGRESS"
)

// Error 是一个带码的失败：页面按码分支，Message 是给人看的那句。
// 字段叫 Kind 而不是 Code，因为 Code() 是 internal/gui 认的那个接口。
type Error struct {
	Kind    string
	Message string
}

func (e *Error) Error() string { return e.Message }

// Code 让页面拿到稳定的分支码（internal/gui 的错误编码靠这个接口）。
func (e *Error) Code() string { return e.Kind }

func fail(code, format string, args ...any) *Error {
	return &Error{Kind: code, Message: fmt.Sprintf(format, args...)}
}

// envelope 是站点所有 JSON 应答的外壳：{success, message, code, data}。
// 设备授权的轮询把「还没决定」也放在 success:false 里，所以这里只解形状，
// 判断留给调用者。
type envelope struct {
	Success *bool           `json:"success"`
	Message string          `json:"message"`
	Code    string          `json:"code"`
	Data    json.RawMessage `json:"data"`
	// GroupRefs 只在 /api/pricing 上出现：分组名 → 路由用的 #<id>。
	GroupRefs map[string]string `json:"group_refs"`
}

// client 是本站的一次调用：地址、超时、以及给测试换掉的 http.Client。
type client struct {
	baseURL string
	http    *http.Client
}

func newClient(baseURL string) *client {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = DefaultBaseURL
	}
	return &client{
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    &http.Client{Timeout: 25 * time.Second},
	}
}

// call 发一次请求并解外面的信封。auth 为空表示匿名调用（发起授权、轮询）。
// 只有「连不上」与「回的不是 JSON」在这里算错，站点自己的拒绝原样交回去。
func (c *client) call(ctx context.Context, method, path string, body any, auth string) (*envelope, *Error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, fail(CodeBadParam, "请求体序列化失败：%v", err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return nil, fail(CodeBadParam, "请求地址无效：%v", err)
	}
	req.Header.Set("accept", "application/json")
	// 站点日志里认得出是哪一个客户端在问，不靠猜
	req.Header.Set("user-agent", UserAgent)
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	if auth != "" {
		req.Header.Set("authorization", "Bearer "+auth)
	}
	res, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			// 一次调用自己超时了，不是站点的问题，但页面看到的仍是"没答"。
			return nil, fail(CodeUnreachable, "站点没有在时限内应答")
		}
		return nil, fail(CodeUnreachable, "连不上 %s：%v", c.baseURL, err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return nil, fail(CodeUnreachable, "读取站点应答失败：%v", err)
	}
	env := &envelope{}
	if err := json.Unmarshal(raw, env); err != nil {
		return nil, fail(CodeInvalidAnswer, "站点应答不是 JSON（HTTP %d）", res.StatusCode)
	}
	return env, nil
}

// ok 是 success 明确为 true。
func (e *envelope) ok() bool { return e.Success != nil && *e.Success }

// said 是站点自己给的那句话，挑一个说得出话的字段。
func (e *envelope) said() string {
	if strings.TrimSpace(e.Message) != "" {
		return strings.TrimSpace(e.Message)
	}
	return ""
}

// refused 把一次被拒的信封翻成带码的错误：充值端点用 403 + code 说明
// "这把 Key 不是本插件签发的"，其余按站点原话。
func (e *envelope) refused(action string) *Error {
	if e.Code == CodeTokenRequired {
		return fail(CodeTokenRequired, "这把密钥不是本插件登录签发的，请重新连接")
	}
	if said := e.said(); said != "" {
		return fail(CodeRefused, "%s：%s", action, said)
	}
	return fail(CodeRefused, "%s被站点拒绝了", action)
}

// decode 把 data 解成 v。
func (e *envelope) decode(v any) *Error {
	if len(e.Data) == 0 || string(e.Data) == "null" {
		return fail(CodeInvalidAnswer, "站点应答缺少 data")
	}
	if err := json.Unmarshal(e.Data, v); err != nil {
		return fail(CodeInvalidAnswer, "站点应答的 data 解不开：%v", err)
	}
	return nil
}

// asError 让 errors.As 找到装在包装里的 *Error。
func asError(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return fail(CodeRefused, "%v", err)
}
