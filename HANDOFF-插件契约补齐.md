# HANDOFF：插件侧契约补齐（1.0.1）

> 给宿主侧（magpie + 我们的补丁）与后续维护者的交接说明。
> 结论先行：**插件侧该补的都补了；「启停真正生效」那一半在宿主侧，按 A 方案（宿主侧过滤）执行。**

## 一、本次补齐清单

对照「neartoken 插件那边还差什么」那张表逐条落地：

| # | 事项 | 之前 | 现在 |
| --- | --- | --- | --- |
| 1 | `magpie.calls` 加 `"neartoken:prefs"` | 缺（只有 8 条） | **已加**，现为 9 条 |
| 2 | 设置区块 UI：清单 + 每行开关、`{op:"get"}` / `{op:"set"}`、`hiddenGroups`、`pinned` | 用 `{get:true}` / `{set:{...}}`，无 hiddenGroups/pinned | **协议已对齐**：读 `{op:'get'}`、写 `{op:'set', disabled:[{model,groups}], hiddenGroups:[], pinned:[]}`；读回同时兼容 `{disabled:[...]}` 与旧的 `{disabledByGroup:{...}}` |
| 3 | 用量面板消费 `usage.rows` + 空数组提示 | 消费了，但无空态文案 | **已加**：有数据源但窗口为空时显示「这个窗口没有逐条记录。」，不再回落到聚合视图 |
| 4 | 版本 bump + 宿主 `min` | 无 min 字段 | **已加** `magpie.min = "2.2.2"`（`prefs` 通道与 `usage.rows` 从该版本起提供） |
| 5 | 让「启停」真正生效 | — | 插件侧已能读 `page/prefs.json` 并按分组过滤；**按 A 方案由宿主在 `pluginCatalog` 层按 `Prefs.Disabled` 过滤**，插件不改 provider 签名 |

顺带补了两个渲染缺口（原表未列，但上游有）：

- **缓存 token**：宿主已写出 `cache`，页面此前没渲染；现在在 Token 列下方显示 `缓存 27,520`。
- **流式标记**：宿主已写出 `isStream`，现在非流式显示灰色「非流」，流式显示蓝色「流」。

## 二、宿主侧需要做的事（A 方案）

1. **`neartoken:prefs` 调用落盘**：把 `{op:'set'}` 的载荷写到插件目录 `page/prefs.json`，`{op:'get'}` 读回同一份。
   载荷形状：
   ```jsonc
   {
     "disabled": [{ "model": "deepseek-flash", "groups": ["[低价] DeepSeek"] }],
     "hiddenGroups": ["group"],
     "pinned": ["[低价] DeepSeek"]
   }
   ```
2. **在 `pluginCatalog` 那层过滤**：宿主收口插件模型的地方，按 `Prefs.Disabled` 把对应 `model + group` 从清单里去掉。
   - 这样 `provider.models()` 保持零改动，不会因 `import neartoken` 形成环（需要放在 `internal/gui` / `internal/plugin` 一层，或加注册钩子，约 15 行 + 用例）。
3. **`neartoken:usage` 的 `rows` 契约**：保持现有字段（`time/kind/tokenName/group/model/upModel/respModel/effort/tps/input/output/cache/bytes/cost/ttft/dur/detail/isStream`）。插件页面已全部消费。

## 三、插件侧数据路径（现状，便于排查）

- 页面沙箱 `connect-src 'none'`，**发不出网络请求**；所有站点数据由宿主写脚本文件、页面加载读取：
  - `page/pricing.js` ← `/api/pricing`（模型目录、分组倍率）
  - `page/aff.js` ← `/api/dsh/device/wallet`（邀请数、推荐码）
  - `page/logs.js` ← `/api/log/token`（失败兜底 `/api/log/self`），逐条流水
- 逐条流水优先用 `page/logs.js`，`neartoken:usage` 的 `rows` 作为次选。
- 费用 = `quota / quota_per_unit`，`quota_per_unit` 从 `/api/status` 读（实测 500000）。
- 吞吐 = `输出 token / (总时长 − 首字耗时)`；首字 `other.frt` 按数值判断毫秒/秒（>30 视为毫秒）。
- 排序按时间戳降序，最新在最上。

## 四、验证

- 单测 57 + 3 全绿；浏览器回归 65 + 12 全绿。
- `page/logs.js` 以空占位发版，预览 mock 不随包发布。
- 已实测：`calls` 9 条、`magpie.min = 2.2.2`、prefs 读写协议、空态文案、缓存/流式渲染。

## 五、仍未解决

- **真机逐条日志能否拉到**取决于站点对插件钥匙的授权。探测结论：`/api/log/token` 认 API key（无 key → `Token not provided`，错 key → `Invalid token`），`/api/log/self` 只认登录会话。若真机仍只有聚合行，请把 magpie 日志里 `plugin:` 输出发来，按实际响应调字段映射。
- `bytes`（请求体大小）与上游请求 ID 在 new-api 日志对象里通常不存在，可能恒为空；若站点扩展了字段再加映射。
