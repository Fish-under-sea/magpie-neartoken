package neartoken

import (
	"context"
	"strings"
)

// 充值面：站点只给"本插件签发的密钥"下单，别的一律 403 DSH_TOKEN_REQUIRED。
const (
	topupInfoPath = "/api/dsh/device/topup/info"
	topupPath     = "/api/dsh/device/topup"
)

// TopupMethod 是站点开着的收款方式之一。
type TopupMethod struct {
	Type string `json:"type"`
	Name string `json:"name"`
}

// TopupInfo 是充值卡能画出来的东西。Unavailable 非空时整块收起，页面只留
// 那一句原因，不摆一个点不动的按钮。
type TopupInfo struct {
	Enabled     bool          `json:"enabled"`
	Unavailable string        `json:"unavailable,omitempty"`
	Min         float64       `json:"min"`
	Options     []float64     `json:"options"`
	Methods     []TopupMethod `json:"methods"`
	Currency    string        `json:"currency"`
}

// TopupOrder 是一次下单的结果：站点的订单号与要打开的支付页。
type TopupOrder struct {
	TradeNo string `json:"tradeNo"`
	URL     string `json:"url"`
}

// topupInfo 读站点的充值档位与渠道。
func (c *client) topupInfo(ctx context.Context, key string, cur Currency) *TopupInfo {
	out := &TopupInfo{Options: []float64{}, Methods: []TopupMethod{}, Currency: cur.symbol()}
	env, err := c.call(ctx, "GET", topupInfoPath, nil, key)
	if err != nil {
		out.Unavailable = "连不上站点，充值暂时不可用。"
		return out
	}
	if !env.ok() {
		switch env.Code {
		case CodeTokenRequired:
			out.Unavailable = "当前密钥不是本插件登录签发的，重新连接后即可充值。"
		default:
			// 老站点根本没有这个端点：不摆充值区
			if env.said() == "" {
				out.Unavailable = "站点未提供在线充值。"
			} else {
				out.Unavailable = env.said()
			}
		}
		return out
	}
	var data struct {
		Enable    bool      `json:"enable_online_topup"`
		Min       float64   `json:"min_topup"`
		Options   []float64 `json:"amount_options"`
		PayMethod []struct {
			Name string `json:"name"`
			Type string `json:"type"`
		} `json:"pay_methods"`
	}
	if derr := env.decode(&data); derr != nil {
		out.Unavailable = "站点的充值信息读不出来。"
		return out
	}
	out.Enabled = data.Enable
	out.Min = data.Min
	if data.Options != nil {
		out.Options = data.Options
	}
	for _, m := range data.PayMethod {
		if m.Type == "" || m.Name == "" {
			continue
		}
		out.Methods = append(out.Methods, TopupMethod{Type: m.Type, Name: m.Name})
	}
	if !out.Enabled {
		out.Unavailable = "站点当前关闭了在线充值。"
	}
	if out.Enabled && len(out.Methods) == 0 {
		out.Unavailable = "站点没有开着的收款方式。"
	}
	return out
}

// topup 下一单，返回要交给系统浏览器打开的地址。真实校验收在站点侧，这里
// 只挡掉明显不合法的金额。
func (c *client) topup(ctx context.Context, key string, amount float64, method string) (*TopupOrder, *Error) {
	if amount <= 0 || amount != float64(int64(amount)) {
		return nil, fail(CodeBadParam, "充值金额必须是正整数")
	}
	if strings.TrimSpace(method) == "" {
		return nil, fail(CodeBadParam, "请先选一个收款方式")
	}
	env, err := c.call(ctx, "POST", topupPath, map[string]any{"amount": amount, "payment_method": method}, key)
	if err != nil {
		return nil, err
	}
	if !env.ok() {
		return nil, env.refused("发起充值")
	}
	var data struct {
		TradeNo string `json:"trade_no"`
		PayURL  string `json:"pay_url"`
	}
	if derr := env.decode(&data); derr != nil {
		return nil, derr
	}
	if data.PayURL == "" {
		return nil, fail(CodeInvalidAnswer, "站点没有给出支付地址")
	}
	pay := data.PayURL
	if strings.HasPrefix(pay, "/") {
		pay = c.baseURL + pay
	}
	return &TopupOrder{TradeNo: data.TradeNo, URL: pay}, nil
}
