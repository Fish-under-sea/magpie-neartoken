package neartoken

import (
	"context"
	"strings"

	"github.com/yetone/magpie/internal/catalog"
	"github.com/yetone/magpie/internal/provider"
)

// 站点上四种协议的入口。Chat 与 Responses 的基址以 /v1 结尾，Anthropic 的
// 基址是根（和 ANTHROPIC_BASE_URL 一样），Gemini 的基址到 /v1beta。
func chatBase(baseURL string) string      { return strings.TrimRight(baseURL, "/") + "/v1" }
func anthropicBase(baseURL string) string { return strings.TrimRight(baseURL, "/") }
func geminiBase(baseURL string) string    { return strings.TrimRight(baseURL, "/") + "/v1beta" }

// storedKey 是 providers.json 里 neartoken 这一条现在用的密钥；没有就是没连。
func storedKey() (string, bool) {
	p, err := provider.Find(ProviderID)
	if err != nil || p == nil {
		return "", false
	}
	key := strings.TrimSpace(p.Key)
	return key, key != ""
}

// attach 把站点挂成 magpie 的一个供应商：一个 id、一把钥匙、四个入口。
//
// 已有的那一条只改钥匙与基址，其余（用户改过的路由、模型选择、请求头）
// 一律不动 —— 重新登录不该把用户设好的东西清掉。第一次连接才建这一条。
func attach(baseURL, key string, cat *Catalog) error {
	p, err := provider.Find(ProviderID)
	if err != nil || p == nil {
		p = &provider.Provider{
			ID:   ProviderID,
			Name: "NearToken",
			// 站点自己那张图；编辑器与供应商列表都用它
			Icon: siteIconURL(baseURL),
		}
	}
	p.Key = key
	p.Chat = chatBase(baseURL)
	p.Anthropic = anthropicBase(baseURL)
	p.Gemini = geminiBase(baseURL)
	// 站点把 Responses 也开在 /v1 下（New API 的 openai-response）
	p.Responses = chatBase(baseURL)
	p.BaseAPI = "chat"
	if cat != nil && len(cat.Models) > 0 {
		p.Models = append([]string(nil), cat.Models...)
	}
	if err := provider.Save(*p); err != nil {
		return err
	}
	return nil
}

// saveCatalog 把站点目录写成 magpie 认得的那份列表，模型选择器随之更新。
// 一次抓取失败不该让连接失败：没有列表时 magpie 会退回它自己知道的那份。
func (m *Manager) saveCatalog(ctx context.Context, baseURL string, cat *Catalog) {
	if cat == nil || len(cat.Models) == 0 {
		return
	}
	models := make([]catalog.Model, 0, len(cat.Models))
	for _, name := range cat.Models {
		models = append(models, catalog.Model{ID: name, Name: name})
	}
	if err := catalog.SaveLive(ProviderID, chatBase(baseURL), models); err != nil {
		m.logf("saving the site's models: %v", err)
	}
}

// detach 把这一条供应商从 magpie 里删掉。删不动只记录：页面仍会显示未连接，
// 因为密钥已经先撤销了。
func (m *Manager) detach() {
	if err := provider.Delete(ProviderID); err != nil {
		m.logf("removing the provider: %v", err)
	}
	if err := catalog.SaveLive(ProviderID, "", nil); err != nil {
		m.logf("forgetting the site's models: %v", err)
	}
}

// siteIconURL 是站点那张图；页面与供应商卡都用同一个地址。
func siteIconURL(baseURL string) string {
	base := strings.TrimRight(baseURL, "/")
	if base == "" {
		base = DefaultBaseURL
	}
	return base + "/logo.png"
}
