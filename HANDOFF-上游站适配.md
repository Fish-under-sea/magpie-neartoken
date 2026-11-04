# HANDOFF · NearToken 上游站需适配的设备授权端点

> 面向：`neartoken.cc` 站点维护方
> 提出方：`@fish-under-sea/magpie-neartoken`（magpie 原生页面插件）
> 日期：2026-11-04
> 关联：FISH-DOCK-Plugins issue（宿主侧改动另见该仓）

## 1. 背景

插件走站点自己的设备授权（`/api/dsh/device/authorize` → `/api/dsh/device/token`），拿到的 `access_token` 是一把 **API token**，不是站点用户的登录 session。页面运行在 magpie 的 sandbox 帧里，`CSP connect-src 'none'`，一条 fetch 都发不出去；所有站点数据只能由插件运行时（`index.mjs`）或宿主（`FISH-DOCK-Plugins` 的 neartoken 供应商）代发。

因此，任何「用户态」数据都必须有**设备 token 可访问的端点**。

## 2. 实测结果（不带凭据直接探测）

| 端点 | 状态 | 返回 |
| --- | --- | --- |
| `GET /api/dsh/device/wallet` | 401 | `Token not provided`（带设备 token 可用，返回 `used_quota` / `quota` / `username`） |
| `GET /api/user/self` | 401 | `AUTH_UNAUTHORIZED / Unauthorized, invalid access token` |
| `GET /api/user/aff` | 401 | 同上 |
| `GET /api/user/topup` | 401 | 同上 |
| `GET /api/redemption/` | 401 | 同上 |
| `GET /api/dsh/device/redeem` | 404 | `Invalid URL` |
| `GET /api/dsh/device/aff` | 404 | `Invalid URL` |
| `POST /api/dsh/device/authorize` / `token` | 可用 | 设备授权链路正常 |
| `GET /api/pricing` | 200 | 目录里**没有** `created_at` / `release_date` / `sort_version` 字段 |

## 3. 需要上游站做的三件事

### 3.1 邀请数据（推荐计划的邀请人数）

**现状**：站点 `/pricing` 页面的「推荐计划」卡显示邀请数与 `aff_code`，但 `/api/user/self` 只认用户 session，设备 token 拿不到；`/api/dsh/device/wallet` 也不带这些字段。插件页面的「邀请」只能显示「—」。

**请求**：在 `/api/dsh/device/wallet` 的应答里补上（或新增 `GET /api/dsh/device/aff`）：

```jsonc
{
  "success": true,
  "data": {
    "username": "fish",
    "quota": 643200,
    "used_quota": 231500,
    "aff_code": "0mY4",         // 本人推荐码
    "aff_count": 1,             // 已邀请人数
    "aff_quota": 0,             // 累计邀请奖励（站点内部单位）
    "aff_history_quota": 0      // 可选
  }
}
```

字段名保持与站点用户对象一致即可，插件侧已兼容
`aff_count` / `affCount` / `invite_count` / `invites` / `referral_count` 等写法。

### 3.2 兑换码真实兑换

**现状**：插件「添加资金」卡里有「输入您的兑换码 → 兑换额度」，但 `/api/redemption/` 需要用户 session；设备通道没有兑换端点，按钮只能提示「请到站点钱包页兑换」。

**请求**：新增设备 token 可用的兑换端点，例如：

```
POST /api/dsh/device/redeem
Authorization: Bearer <设备 access_token>
Content-Type:  application/json

{ "code": "<兑换码>" }
```

应答：

```jsonc
// 成功
{ "success": true, "data": { "quota": 50000, "amount": "¥10.00" } }
// 失败
{ "success": false, "message": "invalid_code" }   // 或 expired / already_used
```

请把兑换码校验、幂等、限额都放在站点侧；插件只负责转发与显示结果。

### 3.3 邀请码绑定（「通过插件访问就算邀请」）

**现状**：插件已把**所有出站点链接**补上 `aff=<推荐码>`（注册页、设备授权确认页、模型详情、订单历史、推荐链接）。但设备授权确认页 `verification_uri_complete` 带的 `aff` 查询参数，站点注册流程是否据此建立邀请关系，插件无法验证——用户反馈「邀请码貌似无法真实兑换」。

**请求**：
1. `POST /api/dsh/device/authorize` 接受可选 `aff` 参数并绑定本次授权；或
2. 确认 `verification_uri_complete` 上的 `aff` 会在用户注册时写入邀请关系；
3. 注册成功后 `aff_count` 能即时 +1（这样插件 60 秒刷新就能看到变化）。

## 4. 模型「最新版本」排序（次要）

`GET /api/pricing` 的 `data[]` 没有上架时间字段。站点前端的排序常量是
`{ VERSION: "version", NAME: "name", PRICE_LOW: "price-low", PRICE_HIGH: "price-high" }`，
前端按版本号比较。插件目前用模型名里的数字版本号降序做实时近似（如 `gpt-6.1 > gpt-6 > gpt-5.6`）。

**请求（可选）**：在 `data[]` 每项补一个 `created_at`（unix 秒）或 `sort_version`，
插件即可按站点权威时间排序，不再猜版本号。

## 5. 验收用例

1. 设备 token 调 `wallet` 能拿到 `aff_count`；站点邀请 1 人后，插件首页「邀请」显示 1（60 秒内刷新）。
2. 再邀请一人，显示 2。
3. 设备 token 调 `redeem` 兑换一张有效码成功，账户余额增加；无效码返回明确错误码。
4. 用带 `aff` 的确认页注册新账号，推荐人的 `aff_count` +1。
5. 未拿到邀请数据时插件显示「—」，不显示 0。

## 6. 分工

| 事项 | 责任方 |
| --- | --- |
| 3.1 / 3.2 / 3.3 的端点与字段 | **上游站（本文档）** |
| `neartoken:state` 透传邀请字段、新增 `neartoken:redeem` 调用、确认页 aff 参数 | **宿主（FISH-DOCK-Plugins issue）** |
| 页面渲染、链接带 aff、`page/aff.js` 每分钟重载 | 插件（已完成） |
