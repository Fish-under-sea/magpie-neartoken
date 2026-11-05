# 供应商列表反复掉出 · 排查交接

> 日期：2026-11-06（Asia/Shanghai）。范围：**仅 `@fish-under-sea/magpie-neartoken` 独立插件**。
> 本文不改 magpie / FISH-DOCK-Plugins / Dock 的任何代码；需要宿主确认的部分另以 issue 记录。
> 关联：`MAGPIE-依赖交接-0.6.6.md`、FISH-DOCK-Plugins #22 / #25（后者已随 2.2.1 关闭）。

## 1. 用户现象

连接后 NearToken 仍会从 magpie 供应商列表里消失，需要「重新注入」（重新连接 / 重新授权）才回来。用户说明 magpie 侧已经修过一次（#22 的供应商交接），但现象仍在。

## 2. 结论（先给判断）

**触发点在我们这侧，属于独立插件缺陷，已在本插件修复。** 另外确认了第二个由我们造成的成因（0.6.7 引入、0.6.8 修掉）：分组级启用表整表写进 options，体积大且形态不符时会把模型整体判成停用，模型表随之变空——外部表现和「供应商掉出」一样，详见第 7 节。 宿主侧还有一条独立包改不了、且未被真实宿主复现的残留线索，按用户要求单独提 issue 请宿主方验证，不当作已确证根因。

不把「宿主 2.2.1 没修好」当成结论：#25 的关闭评论明确说明宿主方已在 tarball 上验证 `options.set → 重启 → provider.models → 缓存 → 供应商列表` 链路通过，且「未用真实已安装宿主 + 有效账户复现那一组用户现象」。

## 3. 本插件侧：已确证的缺陷与修复

### 缺陷（红灯复现）

`index.mjs` 的 `provider.models()` 直接调用 `catalog(disabledGroups, disabledModels)`；`catalog()` 首行是：

```js
const [env, status] = await Promise.all([call('/api/pricing'), call('/api/status').catch(() => null)])
```

- 站点 `/api/pricing` 一旦超时 / TLS 抖动 / 返回空 `data`，`call()` 抛异常 → `Promise.all` reject → `catalog()` 抛异常 → **`provider.models()` 抛异常**。
- 包内明明有 `page/pricing.js` 静态快照（本次 109 个模型、35 个分组），但 `catalog()` 从不读它。
- 复现：`.work/probe-models-offline.mjs`、正式回归 `tests/bundled-catalog.test.mjs`，mock 全部 fetch 失败时 `provider.models()` 抛 `offline`；网络恢复后返回模型表。红灯属实，不是环境问题。

### 为什么这会表现为「供应商掉出」

按已核对的宿主补丁 `magpie-v0.1.2799+fish.14.patch`（仓树 `17980f9`）：

- `keepGrant()` 在 `pluginOwnsProvider()` 命中时走 `keepWithPlugin()` + `dropHostProvider()`，**宿主不再 `provider.Save`、也不再 `catalog.SaveLive`**（handoff.go 2640–2652、2741–2753）。
- `refresh()` 里同样 `if !pluginOwnsProvider() { saveCatalog }` —— 插件在场时宿主不写模型表（3344–3348）。
- 即：**插件在场时，供应商列表里 neartoken 的模型表唯一来源就是插件的 `provider.models()`**。它抛异常/返回空，宿主列举插件 provider 就拿不到模型表，供应商可能不登记或被标成无模型。
- 用户「重新注入」→ `plugin.Import` 重新写凭据并启动插件 host → 重新列举 → 网络恰好恢复 → 供应商回来。与现象吻合。

### 修复（绿灯）

`index.mjs` 新增 `readBundledPricing()` + `loadPricingEnv()`：

1. 先取站点实时目录；**失败或返回空 `data` 时**，读包内 `page/pricing.js`，把 `models[].name` 映射回 `data[].model_name`，并还原 `group_ratio / group_refs / usable_group / vendors / supported_endpoint`。
2. `catalog()` 改用 `loadPricingEnv()`，`bundled` 时跳过 `writePricing()` / `writeGroups()`（不回写快照、不污染只读安装）。
3. 于是 `provider.models()` 在网络失败时仍返回稳定的 109 行模型表，保留 `x-neartoken-group` 头、`kind` 与 `capabilities`，并继续遵守 `disabledModels`。
4. 同一版新增分组级路由：`catalog()` 接受 `options.enabledByGroup`（模型 → 它在哪些分组启用），只在生效分组里选最低倍率那一组；没有记录的模型保持原行为（全部候选，取最便宜）。该键由页面写入，宿主只需原样持久化。

验证：`tests/bundled-catalog.test.mjs` 3 项（离线兜底、分类/路由头、禁用集合）全绿；`tests/provider-group-scope.test.mjs` 3 项（默认走最便宜组、只留官Key时改走官Key、全停用则不出现）全绿；发布前单元 54 项、浏览器 58 + 12 项全绿。

## 4. 宿主侧残留线索（独立包无法修，待真实宿主复现）

以下来自补丁静态阅读，**未在真实已安装宿主 + 有效账户上复现**，只作为请宿主方验证的线索：

1. `pluginOwnsProvider()` 依赖 `plugin.Listed()`（plugin-providers.json）/`plugin.Cached()`，注释明确「不为这一问去起插件 host」。缓存未生成或失效时返回 false。
2. `state()` 每次调 `settle()`；命中 `pluginOwnsProvider()` 且有宿主条时，`handOver()` → `dropHostProvider()` 删宿主侧供应商并 `catalog.SaveLive(ProviderID, "", nil)` 清空模型表。
3. `storedKey()` 在 `pluginOwnsProvider()` 为 true 时只读插件 auth；false 时读 `provider.Find(ProviderID)`（那条可能已被 handOver 删掉）。

若这三个状态在两次调用之间抖动，宿主侧没有兜底条目，钥匙也可能读不到，表现为「掉出 + 需重新注入」。这条链与第 3 节并不互斥：**本插件的 `models()` 异常可能是让插件 provider 列举失败、进而让上述缓存抖动的诱因**。

请宿主方用真实已安装宿主 + 有效账户做 A/B：记录 `plugin.Listed/Cached`、插件凭据、`provider.Find`、目录缓存四者的状态，确认 `handOver` 删条时机与 `pluginOwnsProvider()` 缓存失效之间是否存在竞态。本文不要求宿主按某个推断改代码。

## 5. 本轮实际改动（仅本插件）

| 文件 | 改动 |
| --- | --- |
| `index.mjs` | `provider.models()` 离线兜底；按 `options.enabledByGroup` 做分组级路由 |
| `page/app.js` | 分组级独立启停（`enabledByGroup`）、分组状态与档位计数、说明横幅、供应商品牌图标、定价 / 端点筛选 |
| `page/market.css` | 上述样式；分组 chip 维持原单行胶囊，熄灭态降透明并去色，另加横幅样式 |
| `page/vendor-icons/*.svg` | 16 个本地品牌图标（9 彩色 + 7 单色规范化），站点 `vendor.icon` 同名映射；无 icon 的 TypeSafe 用首字兜底 |
| `tests/*.test.mjs` | 新增 5 组回归（分组侧栏、离线兜底、供应商图标、定价/端点筛选、provider 分组级路由） |

未改 `package.json` 的 `magpie.calls`（仍是 8 条 `neartoken:*`），未改宿主、Dock、站点，未改端点路径（`/api/magpie/device/*` 迁移仍按 `MAGPIE-依赖交接-0.6.6.md` 等上游部署）。

## 6. 验收口径

- 断网 / `/api/pricing` 失败时，供应商列表仍保留 neartoken 与完整模型表（不再需要重新注入）。
- 网络恢复后自动回到实时目录，不残留旧快照。
- **启停按分组独立**：`options.enabledByGroup` 记录「模型在哪些分组启用」。在某个分组里启用/停用模型，只改变该分组；同一模型在别的分组不受牵连。
- 默认（以及「全选」）按模型列出的**所有分组**启用，所以点击全选后不会留下点不亮的分组；未做任何操作时也是全亮状态。
- 想用更贵的分组（如官Key）时，切到该分组再启用模型即可：该组会亮，provider 也随之改为走这一组；所有分组都能控制，不存在「永远点不亮」的项。
- 分组侧栏：维持原单行胶囊，**不加竖条**；含启用模型的分组整块淡绿提亮，没有启用模型的一律灰化（熄灭态降透明并去色，避免彩色标签看着仍像启用）。
- 选中某个分组后，右侧模型区顶部出现横幅：分组标签 + 倍率 + 站点 `usable_group` 说明；切回「所有分组」时横幅隐藏。
- 卡片在选定分组时只显示该组，未选定时显示首个分组并用 `+N` 折叠其余分组。
- 小标签统一为同一尺寸、圆角、字重与描边，只换底色；站点自带的 🥚 / ?? / AIS 等标签照原文显示。
- 侧栏提供「定价类型」（所有模型 / 按量计费 / 按次计费 / 任务计费）与「端点类型」（Chat / Response / Anthropic / Gemini / Rerank / 图片 / 嵌入 / 视频），均带数量，可与其他筛选叠加。
- 供应商 chip 前置官网同款品牌图标与模型数；模型启停、筛选、排序、后台重绘均不重建侧栏节点，保留滚动与焦点。

## 7. 0.6.7 → 0.6.8：我们自己的一个「掉出」成因

0.6.7 把「每个模型在哪些分组启用」整张表写进 `options.enabledByGroup`（109 个模型 × 分组数组）。这带来两个后果，都会表现成用户看到的样子：

1. **状态读回后失真**：只要宿主存回来的形状与预期不符（对象退化成字符串、数组退化成别的、写入被限流截断），页面会把缺失记录当成「该模型没有任何启用分组」，于是重进页面时明明启用过的模型显示为停用。
2. **模型表变空**：provider 按同一张表过滤，没有记录等于没有可用分组，模型被整体跳过；109 个模型全被跳过时供应商模型表为空，列表里就像「掉出」。生图 / 语音 / 向量 / 鸡蛋这些分组一起消失，正是这张表覆盖不全的直接结果。

0.6.8 改为**只记停用例外**（`options.disabledByGroup`）：默认全部分组启用，只有真正被停用的那一格才写一条；读取侧对任何不合法的形状一律当作没有记录，绝不把模型判成停用；写回时清掉旧的大字段。

因此**先用 0.6.8 复测掉出现象**：如果 0.6.8 之后仍能稳定复现，才回到第 4 节的宿主侧竞态继续查。

## 8. 发布状态与宿主需知

- 0.6.7 与 0.6.8 均已发布（npm `latest` = 0.6.8），各带 GitHub Release 与同名 `.tgz`；0.6.8 是当前应安装的版本。
- `options` 里与分组级启停相关的键是 `disabledByGroup`（对象：模型名 → 被停用的分组名数组，通常为空或很短）。宿主请原样存取；即便整条读不出来，0.6.8 也只会退回「全部分组启用」，不会让模型消失。
- 0.6.7 的旧键 `enabledByGroup` 仍被读取兼容，但页面写回时会主动删除它。
- 真实宿主 + 有效账户的 A/B 仍属宿主方验收范围；本插件的修复不替代那条核验。
