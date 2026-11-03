package neartoken

import (
	"context"
	"encoding/json"
	"slices"
	"sort"
	"strings"
)

// Catalog 是站点目录里 magpie 能用的那部分：可聊的模型、它们所在的分组，
// 以及分组到路由 ref 的映射（#<id>，跨分组路由要用）。
type Catalog struct {
	// Models 是可聊的模型名，站点顺序，去重。
	Models []string `json:"models"`
	// Groups 是这些模型出现在过的分组名，站点顺序，去重。
	Groups []string `json:"groups"`
	// Refs 是分组名到 #<id> 的映射；没有 ref 的分组不在里面。
	Refs map[string]string `json:"refs"`
}

// 站点把生图、语音、向量、视频也挂在 openai / gemini 这个 surface 下，
// 所以端点类型分不出"能聊的"和"共用该 surface 的媒体模型"；名字约定是
// 目前唯一可用的判据，也是 dsh-neartoken 一直在用的那条。
var mediaHints = []string{
	"image", "tts", "transcribe", "asr", "embedding", "lyria",
	"midjourney", "nano-banana", "veo", "imagen", "dall-e", "sd",
}

// chatEndpoints 是能聊的端点类型。
var chatEndpoints = []string{"openai", "openai-response", "anthropic", "gemini"}

// chattable 说这个模型能不能拿来聊天。
func chattable(name string, endpoints []string) bool {
	lower := strings.ToLower(name)
	if strings.HasSuffix(lower, "-c") {
		return false
	}
	for _, hint := range mediaHints {
		if strings.Contains(lower, hint) {
			return false
		}
	}
	if len(endpoints) == 0 {
		// 站点没声明时按名字放行：宁可多列一个，也不能让整份目录消失。
		return true
	}
	for _, e := range endpoints {
		if slices.Contains(chatEndpoints, e) {
			return true
		}
	}
	return false
}

// readCatalog 读站点的模型目录。
func (c *client) readCatalog(ctx context.Context) (*Catalog, *Error) {
	env, err := c.call(ctx, "GET", pricingPath, nil, "")
	if err != nil {
		return nil, err
	}
	if !env.ok() {
		return nil, env.refused("读取模型目录")
	}
	// /api/pricing 的 data 是一个数组，不是对象，所以这里自己解
	var data []struct {
		Name      string   `json:"model_name"`
		Groups    []string `json:"enable_groups"`
		Endpoints []string `json:"supported_endpoint_types"`
	}
	if err := json.Unmarshal(env.Data, &data); err != nil {
		return nil, fail(CodeInvalidAnswer, "站点应答的 data 解不开：%v", err)
	}
	out := &Catalog{Models: []string{}, Groups: []string{}, Refs: map[string]string{}}
	seenModel := map[string]bool{}
	seenGroup := map[string]bool{}
	for _, m := range data {
		name := strings.TrimSpace(m.Name)
		if name == "" || !chattable(name, m.Endpoints) {
			continue
		}
		if !seenModel[name] {
			seenModel[name] = true
			out.Models = append(out.Models, name)
		}
		for _, g := range m.Groups {
			g = strings.TrimSpace(g)
			if g == "" || seenGroup[g] {
				continue
			}
			seenGroup[g] = true
			out.Groups = append(out.Groups, g)
		}
	}
	for name, ref := range env.GroupRefs {
		if strings.HasPrefix(ref, "#") {
			out.Refs[name] = ref
		}
	}
	out.Refs = sortedRefs(out.Refs)
	return out, nil
}

// sortedRefs 让 map 的顺序稳定：JSON 不保证，但测试与日志会看。
func sortedRefs(refs map[string]string) map[string]string {
	keys := make([]string, 0, len(refs))
	for k := range refs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make(map[string]string, len(keys))
	for _, k := range keys {
		out[k] = refs[k]
	}
	return out
}
