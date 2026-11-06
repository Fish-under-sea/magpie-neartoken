# 宿主对接接口清单（NearToken 插件 ↔ magpie 宿主）

> 版本基线：插件 `1.0.0`（已回退到 `e831957`，工作区未提交）。
> 宿主基线：`FISH-Dock-1106/FISH-Dock-Plugins/plugins/magpie/patches/magpie-v0.1.3140+fish.23.patch`（上游 `v0.1.3140`，`fish.23`）。
> 本文按宿主补丁的**实际代码**写，逐条标注插件是否依赖、宿主是否已实现、两边是否一致。
> 宿主权威说明：补丁内 `docs/subsystems/neartoken.md`、`internal/neartoken/*.go`。

## 一、总览

插件与宿主之间有四条通道，互不替代：

| 通道 | 方向 | 用途 | 宿主实现位置 |
| --- | --- | --- | --- |
| `neartoken:*` 页面调用 | 页面 → 宿主 | 授权、余额、用量、充值、偏好 | `internal/neartoken/manager.go` `call()` |
| provider 模型表 | 宿主 → 插件 `provider.models()` | 供应商列表的模型 | `internal/provider/plugins.go` `pluginCatalog` |
| `config` / `auth` / `loader` | 宿主 → 插件 | 供应商声明、设备授权、钥匙注入 | 插件 `index.mjs` |
| 页面文件镜像 | 插件 → 页面目录 | `pricing.js` / `groups.js` / `logs.js` / `aff.js` / `latest.js` | 插件运行时直接写 `page/` |

## 二、页面调用（`neartoken:*`）

`magpie.calls` 必须声明这些名字，宿主 `callsKeeping` 只保留声明过的（**未声明的调用会被丢弃**）。

| 调用 | 入参 | 出参 | 插件依赖 | 宿主状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `neartoken:state` | 无 | `View`（见 §四） | 是 | 已实现 | 页面启动、每次刷新读取 |
| `neartoken:connect` | `{affCode?}` | 授权信息（`userCode`、`verificationUri`、`expiresAt`） | 是 | 已实现 | 前台请求，超时走网页兜底 `/sign-in` |
| `neartoken:cancel` | 无 | `View` | 是 | 已实现 | 取消进行中的授权 |
| `neartoken:open` | 无 | 无 | 是 | 已实现 | 打开确认页（`proc.OpenBrowser`） |
| `neartoken:disconnect` | 无 | `View` | 是 | 已实现 | 撤销令牌并删本地凭据 |
| `neartoken:refresh` | `{websitePage?, foreground?, background?}` | `View` | 是 | 已实现 | 手动刷新余额与目录；网页兜底 `/wallet` 或 `/pricing` |
| `neartoken:usage` | `{range: day\|week\|month, foreground?}` | `UsageWindow`（§五） | 是 | 已实现 | 前台且 `foreground:true` 时网页兜底 `/usage-logs/` |
| `neartoken:topup` | `{}` 查询；`{amount, paymentMethod, code?}` 下单 | 充值信息 / 订单（`tradeNo`、`url`） | 是 | 已实现 | 下单前台请求，网页兜底 `/wallet`；**不重发 POST** |
| `neartoken:prefs` | `{op:"get"}` 或 `{op:"set", disabled?, hiddenGroups?, pinned?}`，`op:"clear"` 清空 | `prefsView`（§三） | 是 | **已实现** | 落 `neartoken-prefs.json`，写入后不重建插件 |

### 2.1 `neartoken:prefs` 详细契约（宿主 `prefs.go`）

- `op` 缺省或为 `get`：返回 `prefsView`。
- `op:"set"`：
  - `disabled`：数组，形状二选一：`[{"model":"x","groups":["G"]}]`（推荐）或 `["x", …]`（纯 id）。其它形状回 `BAD_PARAM`。
  - `hiddenGroups`：字符串数组。
  - `pinned`：字符串数组。
  - 只写出现的字段；未出现的字段保留原值。
- `op:"clear"`：清空全部偏好。
- 写失败回 `REFUSED`，读失败不报错（视为没有偏好）。
- 文件：`magpie` 配置目录下 `neartoken-prefs.json`，原子写（临时文件 + rename）。

**注意**：宿主不会把偏好镜像成页面可直接 `<script>` 加载的 JS 文件；镜像的是 `prefs.json`（JSON）。页面以 `op:"get"` 为准，不依赖镜像。

### 2.2 插件侧已完成的对接

- 页面读取：`initDisabledByGroup()` 调 `neartoken:prefs {op:"get"}`，用 `disabled[].model`（缺 `groups` 时用该模型最便宜分组补全）。
- 页面写入：`flushDisabled()` 调 `neartoken:prefs {op:"set", disabled:[{model, groups}]}`。
- `magpie.calls` 已补上 `neartoken:prefs`。

## 三、`prefsView` 形状（宿主 → 页面）

```json
{
  "disabled": [{"model": "tts-1", "groups": ["G-cheap"]}],
  "models": ["tts-1"],
  "hiddenGroups": ["神明"],
  "pinned": ["glm-5.3"],
  "updatedAt": 1762444800,
  "path": "…/neartoken-prefs.json"
}
```

`models` 是 `disabled` 去重后的模型 id，宿主过滤只认它。页面只需读 `disabled`。

## 四、`View`（`neartoken:state` 返回）

与插件相关的字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `configured` | bool | 是否已连接 |
| `baseURL` | string | 站点地址 |
| `tokenName` | string | 站点给这把钥匙起的名字（页面「令牌名」用） |
| `account` | object | 账户资料，含 `user`、`accountId`、`affCode`、`invites`、`affQuota`、`affHistoryQuota`、`inviterId`、`referralSource`、`referralUpdatedAt`（Unix 毫秒） |
| `currency` | `{Name, PerUnit, Rate, Symbol, Display}` | 额度换算；`PerUnit` 来自站点 `quota_per_unit`，`Rate` 来自汇率 |
| `models` / `groups` / `groupList` | 数 | 目录规模 |
| `catalogAt` / `walletAt` / `grantedAt` / `currencyAt` | Unix 毫秒 | 各快照时间 |
| `pending` | object | 进行中的授权：`userCode`、`verificationUri`、`verificationUriComplete`、`expiresAt` |
| `error` | string | 上一次失败原因（无则空） |

推荐资料规则（宿主 `referral.go`）：只有授权 `user` 实际提供且类型正确的字段才进入账户资料；缺失、`null`、类型不符 = 未知，显式 `0` 保留为 `0`。

## 五、`UsageWindow`（`neartoken:usage` 返回）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `available` | bool | 站点是否有这个端点 |
| `reason` | string | `unsupported`（站点无端点）或 `unreachable`（这一轮读不到） |
| `range` | string | `day` / `week` / `month` |
| `start` / `end` | int | Unix 秒 |
| `bucketSeconds` | int | 分桶秒数 |
| `currency` | string | 币种符号 |
| `spent` / `balance` | string | 已用 / 余额（已按币种格式化） |
| `tokens` | number | 窗口 token 总数 |
| `models` | `[{model, tokens, cost, costText}]` | 按模型汇总 |
| `buckets` | `[{timestamp, models[]}]` | 堆叠图分桶 |
| `rows` | `[UsageRow]` | 逐条流水；站点没有时为空数组（不是 nil） |

### 5.1 `UsageRow`（逐条流水，#33）

| 字段 | 类型 | 说明 | 站点字段来源（宿主读取名） |
| --- | --- | --- | --- |
| `time` | string | 展示时间 | `time` |
| `timestamp` | int | Unix 秒，排序用 | `timestamp` |
| `kind` | string | 消耗类型 | `kind` |
| `tokenName` | string | 令牌名 | `token_name` |
| `group` | string | 分组 | `group` |
| `model` | string | 请求模型 | `model` |
| `upModel` | string | 上游请求模型 | `up_model` |
| `respModel` | string | 响应模型 | `resp_model` |
| `effort` | string | 思考强度 | `effort` |
| `tps` | number | 输出吞吐 | `tps` |
| `input` / `output` | number | 输入 / 输出 token | `input` / `output` |
| `bytes` | number | 请求体大小 | `bytes` |
| `cache` | number | 缓存 token | `cache` |
| `isStream` | bool | 是否流式 | `is_stream` |
| `cost` / `costText` | number / string | 费用（按 `quota` 换算） | `quota` |
| `ttft` | number | 首字耗时 | `ttft` |
| `dur` | number | 总耗时 | `duration` |
| `detail` | string | 计价说明 | `detail` |

`model` 与 `detail` 都为空的行被丢弃。

**插件侧**：页面已按此渲染；`page/logs.js`（插件 `logs.js` 写入，由 `fetchLogs()` 从 `/api/log/token` 取）与宿主 `rows` 字段名一致，页面优先用 `logs.js`。

## 六、provider 模型表（宿主 → 插件 `provider.models()`）

- 插件在场时，宿主 `pluginOwnsProvider()` 为真，模型表**唯一来源是插件 `provider.models()`**；宿主不再 `provider.Save` 或 `catalog.SaveLive`（`handoff.go`）。
- 停用模型：宿主 `pluginCatalog` 调 `modelFilter("neartoken")` → `LoadPrefs().ModelIDs()`，只剔除模型，**不删供应商**。
- 插件 `models()` 必须在宿主等待时限内返回。宿主补丁里相关时限：`pluginCatalog` 无显式时限，`handOver` 30s，`refresh` 25s，`connect` 40s。

### 6.1 插件侧保障（1.0.x 已做，1.0.0 基线需确认）

- `catalog()` 任何异常回退到包内快照，`models()` 外层再兜底，绝不 reject。
- 冷启动不等网络，先给包内快照。

## 七、插件运行时在插件目录写入的文件（宿主只读引用）

| 文件 | 写入方 | 读取方 | 说明 |
| --- | --- | --- | --- |
| `page/pricing.js` | 插件 `writePricing` | 页面 `startPriceSync` | 模型广场全量目录 |
| `page/groups.js` | 插件 `writeGroups` | 页面 `loadGroups` | 分组快照 |
| `page/aff.js` | 插件 `writeAff` | 页面邀请卡 | 邀请资料（`/api/user/self` 与 wallet 合并） |
| `page/latest.js` | 插件 `stampLatest` | 页面热重载 | npm 最新版本 |
| `page/logs.js` | 插件 `writeLogs` | 页面日志 | 逐条流水（`/api/log/token`） |
| `page/prefs.json` | **宿主**镜像（补丁 `pagePrefsName`） | 无 | 页面不读，仅供排查 |

### 七.1 两点补充说明

1. **prefs 镜像形状**：宿主镜像 `prefs.json`，页面沙箱不能读文件。页面已不依赖它，建议宿主保持现状或删除镜像，二选一。
2. **`pluginOwnsProvider()` 判定**：只看 `plugin.Listed()`（`plugin-providers.json`）与 `plugin.Cached()`。插件未列入时，宿主会回退到自己的 key+URL 供应商。

> 更正：早前根据 `credentials\magpie\plugin-providers.json`（2026-10-27 的旧数据根）判断「没有 neartoken 条目」，该结论**不成立**。真实数据根是 `credentials\magpie-runtime\data`，其中 neartoken 条目存在且 `models=109`，见第八节。

## 八、实测：掉出的真实原因（2026-11-07）

在真实数据根 `C:\Users\Fish\.fish-dock\.fishplugin-magpie\credentials\magpie-runtime\data` 上实测：

| 项 | 实测值 |
| --- | --- |
| 已装插件 | `@fish-under-sea/magpie-neartoken`（`data/plugins/package.json`） |
| 运行时是否含 prefs | 含：二进制里有 `neartoken:prefs`、`neartoken-prefs.json`、`hiddenGroups`、`pluginOwnsProvider`，且带 `fish.23` 标记 |
| `neartoken-prefs.json` | 存在，停用 **109** 条（全部带 `groups`） |
| 站点目录模型数 | 109 |
| 停用后仍启用 | **0** |
| `plugin-providers.json` 的 neartoken | 存在，`models=109` |

结论：**prefs 通道没问题，缺口是语义**。

- 宿主 `pluginCatalog` → `modelFilter` → `LoadPrefs().ModelIDs()`，把 `disabled` 里的模型整个剔除；
- `disabled` 覆盖 109/109 时，过滤结果是空表，供应商即表现为掉出；
- 宿主模型清单没有分组维度，而页面启停原本是分组级，于是「关掉一个组」被放大成「整个模型下线」。

插件侧已按此修正（1.1.1）：只把「所有分组都停用」的模型写进 `disabled`，分组明细只留本机；「全不选」只作用于当前视图分组。

### 宿主侧仍可考虑的一处能力（非阻塞）

若希望「按分组停用」在 magpie 的模型清单里也精确生效，需要宿主让 `ModelIDs()` 尊重 `PrefModel.Groups`：只有某模型被停用的分组覆盖它**全部**分组时才隐藏该模型，否则保留（由插件按剩余分组路由）。当前实现忽略 `groups`，等价于「只要出现就整模型隐藏」。插件已用上面的写入口径规避该差异，不依赖这条改动。

## 九、验收口径

- 页面：`neartoken:prefs` 写入后，重开页面开关状态保持；`magpie.calls` 含 `neartoken:prefs`。
- 宿主：`neartoken-prefs.json` 存在且 `disabled` 与页面一致；停用模型后 `provider.models()` 返回剔除该模型的列表，供应商本身仍在列表中。
- 掉列表：停用/启用任一模型，供应商保持可见（不因写 prefs 而消失）。
