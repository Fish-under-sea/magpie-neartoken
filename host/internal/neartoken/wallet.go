package neartoken

import "context"

// walletPath 用插件的密钥读用户维度的额度与分组代金券。
const walletPath = "/api/dsh/device/wallet"

// Voucher 是一张分组代金券：只能付它自己那一组，金额按站点货币印。
type Voucher struct {
	Group   string `json:"group"`
	GroupID int    `json:"groupId"`
	Amount  string `json:"amount"`
}

// Account 是账户卡要的几件事。
type Account struct {
	Username    string    `json:"username"`
	DisplayName string    `json:"displayName"`
	Group       string    `json:"group"`
	Balance     string    `json:"balance"`
	Used        string    `json:"used"`
	Vouchers    []Voucher `json:"vouchers"`
}

// wallet 读余额、已用与分组代金券，金额按站点货币折成文字。端点不存在
// （老站点）、读不到、令牌被停用，都只表示"这一轮没读到"，调用者保留上一次
// 的数字，不清空。
func (c *client) wallet(ctx context.Context, key string, cur Currency) (quota, used float64, vouchers []Voucher, err *Error) {
	env, cerr := c.call(ctx, "GET", walletPath, nil, key)
	if cerr != nil {
		return 0, 0, nil, cerr
	}
	if !env.ok() {
		return 0, 0, nil, env.refused("读取余额")
	}
	var data struct {
		Quota     float64 `json:"quota"`
		UsedQuota float64 `json:"used_quota"`
		Credits   []struct {
			Group   string  `json:"group"`
			GroupID int     `json:"group_id"`
			Amount  float64 `json:"amount"`
		} `json:"group_credits"`
	}
	if derr := env.decode(&data); derr != nil {
		return 0, 0, nil, derr
	}
	out := make([]Voucher, 0, len(data.Credits))
	for _, g := range data.Credits {
		// 只留还有钱的那些；站点已经滤过一遍，这里再守一次
		if g.Amount <= 0 {
			continue
		}
		out = append(out, Voucher{Group: g.Group, GroupID: g.GroupID, Amount: cur.text(g.Amount)})
	}
	return data.Quota, data.UsedQuota, out, nil
}

// summarize 把 grant 里那份 user 摊成账户卡。
func summarize(user map[string]any, cur Currency) *Account {
	if user == nil {
		return nil
	}
	text := func(key string) string {
		if v, ok := user[key].(string); ok {
			return v
		}
		return ""
	}
	num := func(key string) float64 {
		if v, ok := user[key].(float64); ok {
			return v
		}
		return 0
	}
	name := text("username")
	display := text("display_name")
	if display == "" {
		display = name
	}
	return &Account{
		Username:    name,
		DisplayName: display,
		Group:       text("group"),
		Balance:     cur.text(num("quota")),
		Used:        cur.text(num("used_quota")),
		Vouchers:    []Voucher{},
	}
}
