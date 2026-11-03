package neartoken

import (
	"context"
	"fmt"
	"slices"
)

// usagePath 是插件的密钥能读的用量端点，range 取 day / week / month。
const usagePath = "/api/dsh/device/usage"

// UsageRanges 是看板能切的三个窗口。
var UsageRanges = []string{"day", "week", "month"}

// UsageModel 是一个模型在一格或整个窗口里的用量。
type UsageModel struct {
	Model    string  `json:"model"`
	Tokens   float64 `json:"tokens"`
	Cost     float64 `json:"cost"`
	CostText string  `json:"costText"`
}

// UsageBucket 是堆叠图上的一列。
type UsageBucket struct {
	Timestamp int64        `json:"timestamp"`
	Models    []UsageModel `json:"models"`
}

// UsageWindow 是一个窗口的全部数字。Available 为 false 时，Reason 说明是
// 站点没有这个端点（unsupported）还是这一轮读不到（unreachable）——两种说法
// 在页面上是两句不同的话，不合并。
type UsageWindow struct {
	Available     bool          `json:"available"`
	Reason        string        `json:"reason,omitempty"`
	Range         string        `json:"range"`
	Start         int64         `json:"start"`
	End           int64         `json:"end"`
	BucketSeconds int           `json:"bucketSeconds"`
	Currency      string        `json:"currency"`
	Spent         string        `json:"spent"`
	Balance       string        `json:"balance"`
	Tokens        float64       `json:"tokens"`
	Models        []UsageModel  `json:"models"`
	Buckets       []UsageBucket `json:"buckets"`
}

// readUsage 读一个窗口。调用方给的 balance 是钱包卡片上那个数：端点只说花
// 了多少，余额是钱包的事，不在第二个地方再问一遍。
func (c *client) readUsage(ctx context.Context, key, balance, span string, cur Currency) (*UsageWindow, *Error) {
	if !slices.Contains(UsageRanges, span) {
		return nil, fail(CodeBadParam, "没有这个窗口：%s（day / week / month）", span)
	}
	env, cerr := c.call(ctx, "GET", usagePath+"?range="+span, nil, key)
	if cerr != nil {
		return &UsageWindow{Available: false, Reason: "unreachable", Range: span, Balance: balance}, nil
	}
	if !env.ok() {
		// 老站点把这条路径当未知路由，回的是 JSON 但没有窗口：这是部署事实，
		// 不是密钥坏了。
		return &UsageWindow{Available: false, Reason: "unsupported", Range: span, Balance: balance}, nil
	}
	var data struct {
		Start         float64 `json:"start_timestamp"`
		End           float64 `json:"end_timestamp"`
		BucketSeconds float64 `json:"bucket_seconds"`
		Quota         float64 `json:"quota"`
		Tokens        float64 `json:"tokens"`
		Models        []struct {
			Model  string  `json:"model"`
			Quota  float64 `json:"quota"`
			Tokens float64 `json:"tokens"`
		} `json:"models"`
		Buckets []struct {
			Timestamp float64 `json:"timestamp"`
			Models    []struct {
				Model  string  `json:"model"`
				Quota  float64 `json:"quota"`
				Tokens float64 `json:"tokens"`
			} `json:"models"`
		} `json:"buckets"`
	}
	if derr := env.decode(&data); derr != nil || data.BucketSeconds <= 0 {
		return &UsageWindow{Available: false, Reason: "unsupported", Range: span, Balance: balance}, nil
	}
	row := func(model string, quota, tokens float64) UsageModel {
		return UsageModel{Model: model, Tokens: tokens, Cost: cur.money(quota), CostText: cur.text(quota)}
	}
	out := &UsageWindow{
		Available:     true,
		Range:         span,
		Start:         int64(data.Start),
		End:           int64(data.End),
		BucketSeconds: int(data.BucketSeconds),
		Currency:      cur.symbol(),
		Spent:         cur.text(data.Quota),
		Balance:       balance,
		Tokens:        data.Tokens,
		Models:        []UsageModel{},
		Buckets:       []UsageBucket{},
	}
	for _, m := range data.Models {
		if m.Model == "" {
			continue
		}
		out.Models = append(out.Models, row(m.Model, m.Quota, m.Tokens))
	}
	for _, b := range data.Buckets {
		bucket := UsageBucket{Timestamp: int64(b.Timestamp), Models: []UsageModel{}}
		for _, m := range b.Models {
			if m.Model == "" {
				continue
			}
			bucket.Models = append(bucket.Models, row(m.Model, m.Quota, m.Tokens))
		}
		out.Buckets = append(out.Buckets, bucket)
	}
	return out, nil
}

// rangeLabel 是窗口在页面上的名字，错误消息里用。
func rangeLabel(span string) string {
	switch span {
	case "day":
		return "日"
	case "week":
		return "周"
	case "month":
		return "月"
	}
	return fmt.Sprint(span)
}
