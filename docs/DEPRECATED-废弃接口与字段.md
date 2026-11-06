# 废弃接口与字段清单

> 版本基线：插件 `1.1.2`（以 `1.0.0` 为基线，叠加 1.1.x 修复）。
> 目的：列出早期写过、现在已不再使用的接口、字段与文件，并标明**当前状态**与代码位置。
> 2026-11-07 这轮已把 D1–D8 从代码里移除；D9、D10 保留但用途收窄。

## 一、总表

| 编号 | 名称 | 类型 | 状态 | 原代码位置 | 替代 |
| --- | --- | --- | --- | --- | --- |
| D1 | `options.disabledModels` | 插件 options 字段 | **已移除读取** | 原 `index.mjs` `asSet(options?.disabledModels)` | 宿主 `neartoken-prefs.json` → `HiddenModels` |
| D2 | `options.disabledGroups` | 插件 options 字段 | **已移除读取**（这条曾静默过滤整组，是「模型数忽多忽少」的隐患） | 原 `index.mjs` `catalogUnsafe` 的 `disabledGroups.has(name)` | 同上 |
| D3 | `options.enabledByGroup` | 插件 options 字段（0.6.7） | **已移除读取** | 原 `index.mjs` `readGroupMap(options?.enabledByGroup)` | `neartoken:prefs` |
| D4 | `options.disabledByGroup` | 插件 options 字段（0.6.8 起） | **已移除读取** | 原 `index.mjs`、`page/app.js` 兜底 | `neartoken:prefs` |
| D5 | `bridge.options.get()` | 页面调用 | **已移除** | 原 `page/app.js` 启动段 | `neartoken:prefs {op:"get"}` |
| D6 | `neartoken:prefs {get:true}` | 旧调用形状 | **已移除** | 1.0.0 页面 | `{op:"get"}` |
| D7 | `neartoken:prefs {set:{…}}` | 旧调用形状 | **已移除** | 1.0.0 页面 | `{op:"set", disabled:[…]}` |
| D8 | `page/prefs.json` 参与过滤 | 插件读文件 | **已移除**（`readPrefs()` 删除） | 原 `index.mjs:readPrefs` | 宿主 `modelFilter` 唯一负责 |
| D9 | `localStorage` 键 `neartoken:disabledByGroup` | 页面本机存储 | 保留：分组级明细的唯一载体 | `page/app.js` | `neartoken:prefs`（宿主只存整模型停用） |
| D10 | `page/groups.js` | 文件 | 保留：只用于页面画分组 | `index.mjs:writeGroups` | — |

## 二、这轮为什么必须移除

### options 通道会让供应商闪断

页面写 options 会让宿主重建插件宿主（`SetPageOptions` → 插件重启）。旧的启停实现把状态写在 options 里，于是「改一个开关 → 插件重启 → 宿主重新列举 → 供应商在列表里闪一下」。这条链历史上被反复误判成「掉出」，实际是我们自己制造的。

现在启停只走 `neartoken:prefs`（宿主写 `neartoken-prefs.json`，**不重建插件**）。

### 两份真相会互相打架

旧实现里，插件 `provider.models()` 自己还会按 `page/prefs.json` 过滤一遍，宿主 `pluginCatalog` 又按 `neartoken-prefs.json` 过滤一遍。两份数据不同步时：

- 宿主剔光、插件还留着 → 供应商「有卡片、无模型」；
- 插件剔光、宿主不知道 → 供应商直接空表 → 掉出。

**现在只留宿主这一层**：`pluginCatalog` → `modelFilter` → `LoadPrefs().ModelIDs()`。插件只负责把「所有分组都停用」的模型写进 `disabled`，其余一律返回全量。

## 三、保留项说明

### D9 `localStorage`

宿主持久化只有「模型」维度，分组粒度的明细只能留在页面本机。因此 `localStorage` 仍是分组级状态的主载体：

- 写：每次 `flushDisabled` 都写全量明细；
- 读：启动时先读本机，再用宿主 `disabled` 把「整模型停用」展开成全组停用（`hostOff`）。

### D10 `groups.js`

仍由插件运行时写入，页面用它画分组胶囊。它不再参与 provider 过滤，也不再影响模型表。

## 四、仍在用（不在本清单）

- `neartoken:state / connect / cancel / open / disconnect / refresh / usage / topup / prefs`（9 条，均在 `magpie.calls` 声明）
- `usage.rows`（逐条流水契约；实测站点该端点无 rows，插件自取 `/api/log/token`）
- `page/pricing.js`、`page/logs.js`、`page/logs-meta.js`、`page/aff.js`、`page/latest.js`、`page/health.js`

## 五、宿主侧残留（等宿主处理）

宿主 `plugins.json` 里仍保留旧版写入的键：

```json
"options": {"disabledByGroup": {...}, "disabledModels": []}
```

插件已不读它们，留着无害，但会误导排查。已在 `FISH-DOCK-Plugins#36` 提出由宿主做一次迁移清理（见该 issue 需求四）。