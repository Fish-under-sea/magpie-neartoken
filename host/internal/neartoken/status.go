package neartoken

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// 站点的公开状态与定价端点。
const (
	statusPath  = "/api/status"
	pricingPath = "/api/pricing"
)

// Currency 是站点印钱的方式：一个原始 quota 值折算成它显示的那笔钱。
//
// 站点回的额度全是 quota 单位，钱包、用量、代金券都按这同一份汇率折算，
// 三处数字才不会互相打架。
type Currency struct {
	// Symbol 是金额前面的符号（￥ 或 $）。
	Symbol string `json:"symbol"`
	// PerUnit 是一个显示单位值多少 quota。
	PerUnit float64 `json:"perUnit"`
	// Rate 是显示货币对美元的比价，站点要求按货币显示时才会乘。
	Rate float64 `json:"rate"`
	// Display 是站点是否要按它自己的货币显示金额。
	Display bool `json:"display"`
	// Name 是站点名（近令牌站点的 system_name）。
	Name string `json:"name"`
}

// money 把 quota 折成站点显示的那笔钱，未取整。
func (c Currency) money(quota float64) float64 {
	perUnit := c.PerUnit
	if perUnit <= 0 {
		perUnit = 1
	}
	value := quota / perUnit
	if c.Display && c.Rate > 0 {
		value *= c.Rate
	}
	return value
}

// text 是一位金额：带符号、两位小数，和站点自己的面板一致。
func (c Currency) text(quota float64) string {
	return fmt.Sprintf("%s%.2f", c.symbol(), c.money(quota))
}

func (c Currency) symbol() string {
	if c.Symbol != "" {
		return c.Symbol
	}
	if c.Display {
		return "￥"
	}
	return "$"
}

// readStatus 读站点的公开状态。/api/status 匿名可读，所以连接之前页面也
// 拿得到站点名；读不到就退回默认口径，不因此让整张卡报错。
func (c *client) readStatus(ctx context.Context) Currency {
	cur := Currency{Symbol: "", PerUnit: 1, Rate: 1, Display: false, Name: "NearToken"}
	env, err := c.call(ctx, "GET", statusPath, nil, "")
	if err != nil || !env.ok() {
		return cur
	}
	var data struct {
		SystemName        string   `json:"system_name"`
		QuotaPerUnit      float64  `json:"quota_per_unit"`
		USDExchangeRate   *float64 `json:"usd_exchange_rate"`
		DisplayInCurrency bool     `json:"display_in_currency"`
		// 站点可选地覆盖货币符号（"¥"、"€"），有就用它
		CustomSymbol string `json:"custom_currency_symbol"`
	}
	if derr := env.decode(&data); derr != nil {
		return cur
	}
	if strings.TrimSpace(data.SystemName) != "" {
		cur.Name = strings.TrimSpace(data.SystemName)
	}
	if data.QuotaPerUnit > 0 {
		cur.PerUnit = data.QuotaPerUnit
	}
	if data.USDExchangeRate != nil && *data.USDExchangeRate > 0 {
		cur.Rate = *data.USDExchangeRate
	}
	cur.Display = data.DisplayInCurrency
	cur.Symbol = strings.TrimSpace(data.CustomSymbol)
	return cur
}

// currencyClock 记着这份汇率读到的时间，免得每次调用都问一遍站点。
type currencyClock struct {
	cur Currency
	at  time.Time
}

// fresh 是这份汇率还能用（10 分钟内）。
func (c currencyClock) fresh(now time.Time) bool {
	return !c.at.IsZero() && now.Sub(c.at) < 10*time.Minute
}
