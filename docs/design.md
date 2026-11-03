# NearToken 在 magpie 里的边界与契约

这份文档说的是「页面能问宿主什么、宿主替它做什么、哪些事故意不做」。它是 `host/internal/neartoken` 与 `page/` 的共同说明；两边改之前先读一遍。

## 为什么需要宿主

magpie 的插件页跑在一个沙箱帧里，策略是 `sandbox allow-scripts` 加 `connect-src 'none'`：页面加载得了自己的文件，发不出任何网络请求，也调不到 `/api`。这不是疏漏，是设计——插件页不该拿到窗口的 API。

于是页面要联网就只有一条路：`magpie.call(name, params)` → 窗口 → `POST /api/plugin-pages/call` → 宿主。

宿主的校验顺序是固定的：

1. `spec` 必须是一个开着的插件页；
2. `name` 必须在那个插件 `package.json` 的 `magpie.calls` 里；
3. 才执行。

所以 `neartoken:*` 这八条既写在 `package.json` 里，也在 `internal/gui/pluginpagecall.go` 里分派给 `internal/neartoken`。两处都对上，页面才拿得到数据。

## 数据从哪来

| 端点 | 用途 | 鉴权 |
| --- | --- | --- |
| `GET /api/status` | 站点名、`quota_per_unit`、`usd_exchange_rate`、`display_in_currency` | 匿名 |
| `POST /api/dsh/device/authorize` | 发起设备授权 | 匿名 |
| `POST /api/dsh/device/token` | 轮询结果，拿 `access_token` | 匿名（拿 `device_code`） |
| `POST /api/dsh/device/revoke` | 断开时撤销 | Bearer |
| `GET /api/dsh/device/wallet` | 余额、已用、分组代金券 | Bearer |
| `GET /api/dsh/device/usage?range=day\|week\|month` | 用量窗口 | Bearer |
| `GET /api/dsh/device/topup/info` | 充值档位与收款方式 | Bearer |
| `POST /api/dsh/device/topup` | 下单，拿 `pay_url` | Bearer |
| `GET /api/pricing` | 模型目录、`enable_groups`、`group_refs` | 匿名 |

Bearer 就是设备授权签下来的那把密钥：和 `/v1/chat/completions` 用的是同一把，不是第二套凭据。

## 密钥在哪

只在一个地方：`providers.json` 里 `id` 为 `neartoken` 的那一条的 `key`。

- 页面永远看不到它：`neartoken:state` 只回账户数字、代金券和目录规模。
- 不支持手动导入：没有「粘贴密钥」的入口，连接只能走设备授权。
- 不支持多账号：这一条 provider 只有一个 `key`，不写 `keys` 数组。
- 断开时先调站点撤销，再删 provider 与本地快照；站点撤不掉也照删本地那一份。

## 金额口径

站点的钱都是 quota 单位。折算只有一个函数（`Currency.money`）：

```
value = quota / quota_per_unit
value *= usd_exchange_rate   // 仅当 display_in_currency 为真
符号 = ￥（display 为真）或 $，站点给了 custom_currency_symbol 就用它
```

钱包、看板、代金券都过这一个函数，所以三处数字不会互相打架。汇率缓存 10 分钟。

## 会话与状态

`<magpie 数据目录>/neartoken.json` 存的是**显示用的快照**：账户、代金券、目录规模、汇率、以及未完成授权的可见部分。它不存密钥。

- 读不出来：当作没有，不拿一份坏文件覆盖上一次的好数字。
- 写：临时文件 + 改名，留一份 `.bak`。
- 与 `providers.json` 的关系：有没有连接看 `providers.json`；`neartoken.json` 只是让重启后还能显示上一次的数字。

进行中的授权由宿主在后台轮询（按站点给的 `interval`，`slow_down` 加 2 秒），页面只读状态，不参与轮询——页面被关掉、重新打开都不会重启一次授权。

## 模型与路由

登录成功后：

1. `provider.Save` 写一条 `neartoken` 供应商：`chat` / `responses` 用 `/v1`，`anthropic` 用站点根，`gemini` 用 `/v1beta`，`baseAPI` 为 `chat`；
2. `catalog.SaveLive` 把站点目录写成 magpie 认得的那份模型列表。

模型选择、路由、失败切换、用量记账全部交回 magpie——插件不重做那一套，也不维护自己的模型选择器。

可聊模型的判据（与 `dsh-neartoken` 一致）：

- `-c` 后缀一律不要；
- 名字里带 `image` / `tts` / `transcribe` / `asr` / `embedding` / `lyria` / `midjourney` / `nano-banana` / `veo` / `imagen` / `dall-e` / `sd` 的不要——站点把媒体模型也挂在 `openai` / `gemini` 这个 surface 下，端点类型分不出来；
- 站点声明了 `supported_endpoint_types` 时，含 `openai` / `openai-response` / `anthropic` / `gemini` 之一即可；
- 站点没声明时按名字放行：宁可多列一个，也不能让整份目录消失。

## 故意不做的事

- **不做密码登录表单。** 站点自己管 2FA、Passkey、Turnstile；插件收密码只会绕开这些。
- **不做多账号与手动导入。** 用户要的是一个能用的账号，不是把 `providers.json` 变成第二个控制台。
- **不做本地用量统计。** 消耗数字来自站点，插件不另记一份账，也不会因为读不到就编一个。
- **不画空图。** 读不到用量时说「站点未提供用量统计」或「暂时读不到」，不画一条平线假装没有消耗。

## 错误码

页面按码分支，不解析英文原文：

| 码 | 含义 |
| --- | --- |
| `NOT_CONNECTED` | 还没连接 |
| `SITE_UNREACHABLE` | 连不上站点 |
| `SITE_RESPONSE_INVALID` | 站点回的不是认识的 JSON |
| `SITE_REFUSED` | 站点明确拒绝，`message` 里带原话 |
| `DSH_TOKEN_REQUIRED` | 这把密钥不是设备授权签发的（充值端点会这么答） |
| `TOPUP_UNAVAILABLE` | 站点没开在线充值 |
| `NO_USAGE` | 站点没有用量端点 |
| `INVALID_PARAM` | 参数不对（金额不为正整数、窗口名不认识） |

## 测试

`go test ./internal/neartoken/ -count=1`：用 `httptest` 起一个假站点覆盖授权、轮询四种未完成状态、钱包折算、用量窗口、充值、目录过滤与撤销。测试用 `testenv` 把 HOME 与 XDG 目录指进临时目录，不碰真实的 `providers.json`。