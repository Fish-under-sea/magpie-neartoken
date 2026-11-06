# 废弃接口与字段清单

> 版本基线：插件 `1.0.0`（工作区已回退到 `e831957`）。
> 目的：列出 1.0.x 之前写过、现在不再作为宿主对接依据的接口、字段与文件，并标明代码位置，便于后续清理。
> 本文只记录事实，**本轮不删除代码**。删除需等宿主确认不再读取旧 `options` 后再做。

## 一、总表

| 编号 | 名称 | 类型 | 现状 | 代码位置（当前工作区） | 替代 |
| --- | --- | --- | --- | --- | --- |
| D1 | `options.disabledModels` | 插件 options 字段 | 页面仍读取，provider 仍过滤 | `index.mjs:728`、`page/app.js:153-154` | `neartoken:prefs`（`disabled`） |
| D2 | `options.disabledGroups` | 插件 options 字段 | provider 仍过滤分组 | `index.mjs:727`、`:341` | `neartoken:prefs`（`disabled[].groups`） |
| D3 | `options.enabledByGroup` | 插件 options 字段（0.6.7） | provider 仍读取；页面写回时删除 | `index.mjs:749`、`page/app.js:1432` | `neartoken:prefs` |
| D4 | `options.disabledByGroup` | 插件 options 字段（0.6.8 起） | provider 读取；页面兜底读取 | `index.mjs:748`、`page/app.js:1466` | `neartoken:prefs` |
| D5 | `bridge.options.get()` 读开关 | 页面调用 | 启动时读取，仅作兜底 | `page/app.js:149` | `neartoken:prefs {op:"get"}` |
| D6 | `neartoken:prefs {get:true}` | 旧页面调用形状 | 已改为 `{op:"get"}` | 1.0.0 原 `page/app.js` | `{op:"get"}` |
| D7 | `neartoken:prefs {set:{…}}` | 旧页面调用形状（载荷为「模型→分组数组」对象） | 宿主不认，已改 | 1.0.0 原 `page/app.js` | `{op:"set", disabled:[…]}` |
| D8 | `page/prefs.json` 读取 | 插件读自己页面目录的文件 | 插件 `readPrefs()` 仍读取，与宿主过滤重复 | `index.mjs:286-293` | `neartoken:prefs {op:"get"}` |
| D9 | `localStorage` 键 `neartoken:disabledByGroup` | 页面本机存储 | 宿主不可用时的兜底 | `page/app.js:1440`、`:2218` | `neartoken:prefs` |
| D10 | `page/groups.js` 作为过滤输入 | 文件 | 仅用于页面分组展示，不再参与 provider 过滤 | `index.mjs:394-398` | —（保留，仅收窄用途） |

## 二、说明

### D1–D4：插件 options 通道

早期版本把启停状态写进插件 options（`magpie.options.set`）。宿主侧任何 options 变化都会让插件重建，供应商因此在列表里闪断或消失，这是「掉出列表」的已知触发源之一。

- 现状：`index.mjs` 的 `neartoken` 导出函数仍读取这些字段并参与过滤。
- 页面写入时已删除 `enabledByGroup`、清空 `disabledModels`，但**读取侧仍兼容**。
- 清理条件：宿主 `neartoken:prefs` 真机验证通过，且不再存在依赖旧 options 的页面。

### D5：页面读 `bridge.options.get()`

- `page/app.js` 启动时仍读取 options，作为 `initDisabledByGroup()` 的兜底。
- 清理条件：同 D1–D4。

### D6、D7：旧 prefs 调用形状

- 旧页面写的是 `{get:true}` 与 `{set: 模型→分组数组}`。宿主 `prefs.go` 只认 `op` 字段，旧形状会被当作参数错误。
- 当前页面已改为宿主协议，旧形状只存在于 1.0.0 历史中。

### D8：`page/prefs.json`

- 宿主补丁 `pagePrefsName = "prefs.json"` 会把偏好镜像到插件 `page/` 目录，但页面沙箱不能读取文件，且镜像是 JSON 而非 `<script>`。
- 插件 `readPrefs()` 读取它并参与 provider 过滤；宿主 `pluginCatalog` 已通过 `modelFilter` 完成过滤，插件这一层与之重复。

### D9：`localStorage`

- 宿主可用时不再写入。页面只在 `neartoken:prefs` 调用失败时才写本机存储。

### D10：`groups.js`

- 仍由插件写入，页面用它画分组。不再参与 provider 过滤。保留，列在这里是为了说明用途已收窄。

## 三、不在本清单内（仍在用）

- `neartoken:state / connect / cancel / open / disconnect / refresh / usage / topup / prefs`
- `usage.rows`（逐条流水契约）
- `page/pricing.js`、`page/logs.js`、`page/aff.js`、`page/latest.js`

## 四、清理顺序（建议，待确认）

1. 宿主 `neartoken:prefs` 真机通过 → 删除 D5、D9 兜底分支。
2. provider 删除 D1–D4 的 options 读取，过滤只保留宿主 `modelFilter` 这一层。
3. 删除 D8 `readPrefs()`，避免与宿主过滤重复。
4. 每一步各发一个版本，并在 `HOST-接口对接.md` 的验收段落记录。
