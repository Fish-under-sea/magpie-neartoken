# magpie 依赖交接 · NearToken 0.6.6

> 核验日期：2026-11-05。本文仅说明独立插件需要宿主 / 上游配合的事项，不包含或修改 magpie、Dock 的实现。
> 独立插件版本为 0.6.6；magpie 的后续版本由其维护工作区单独处理，二者不共享版本号。

## 一、本插件已完成

- 选定分组时，卡片只展示该组并使用对应倍率；补齐标准 / 充值、币种、按次 / 用量、时段与停用档位的计价处理。
- 提供最新版本、名称、价格升序、价格降序四项排序，默认最新版本。
- 详情链接定位官网对应模型，保留分组、单位和计价模式；不因点击链接切换模型启停。
- 状态失败、充值不可用、用量不可用时提供官网 / 网页钱包 / 定价页入口；页头也保留官网链接。
- 不自动跳转、不自动重发授权或充值请求；用户主动打开网页。网页登录不等于本地设备授权成功，订单结果不明时先到钱包核对。
- 页面、package.json 与本次核对的 magpie 宿主均使用同样的八条 neartoken:* 通道。

## 二、命名目标与线上状态

目标设备 API 前缀是 **/api/magpie/device/**，不是把 DSH 当成宿主。历史 /api/dsh/device/ 是当前站点实际存在的兼容路径，不代表插件依赖 DSH 应用。

2026-11-05 **18:35（Asia/Shanghai）**，无账户凭据的有限核验结果：

| 方法 / 路由后缀 | magpie 新前缀 | dsh 历史前缀 |
| --- | --- | --- |
| GET wallet | 404，Invalid URL | 401，要求令牌 |
| GET usage?range=day | 404，Invalid URL | 401，要求令牌 |
| GET topup/info | 404，Invalid URL | 401，要求令牌 |
| POST authorize，无效 JSON | 404，Invalid URL | 明确返回 Invalid request body |
| POST token，明确无效的占位码 | 404，Invalid URL | 明确返回 expired_token |
| POST revoke，空请求且无凭据 | 404，Invalid URL | 返回成功；这不代表真实凭据撤销已验收 |
| POST topup，空请求且无凭据 | 404，Invalid URL | 401，要求令牌 |

这次核验使用了实际请求方法，不从 GET 404 推断 POST 是否存在。没有登录、批准授权、充值下单或消费兑换码；没有执行有效设备令牌的端到端联调。

用户已允许：新端点未部署不阻塞本次独立插件发包，等待上游适配并保留网页兜底。因此本版**保留当前兼容调用**，不把正在使用的请求单方面改到实测 404 的新路径，也不在有状态 POST 失败后盲目改前缀重试。

公开 GET /api/status、GET /api/pricing 和推理 /v1 不属于设备前缀迁移，不应机械改成 /api/magpie/device/ 下的路径。

## 三、magpie 需要提供 / 确认

### 1. 设备前缀迁移

- 确认站点已经部署并验收 /api/magpie/device/* 后，统一切换宿主的 authorize、token、revoke、wallet、usage、topup/info、topup 路径。
- 同步通知独立插件维护方切换其直接设备调用。保持 HTTP 方法、鉴权、请求体与响应语义；旧路径退役需有明确顺序。
- 页面仍使用 neartoken:*，不要随 HTTP 改名重命名桥接通道。
- 服务端返回的 verification_uri / verification_uri_complete 原样使用并保留必要参数；不要在客户端机械替换确认网页路径。

本次公开宿主仓树仍为 17980f9cef5eff527262c2ffb96e0775e73a2c55，发行版仍为 2.2.0；相关证据来自该版本的 fish.14 补丁，不能据此宣称 2.2.1 已部署。

### 2. 网页入口承接

- 正确承接插件页的外部 HTTP(S) anchor / target=_blank，并交给系统默认浏览器，保留查询参数。
- neartoken:open 是当前设备确认页的专用操作，不应把它误当成任意 URL 打开接口。本插件没有臆造新的 openExternal 桥接方法。
- 不将站内路由 / hash 一律外跳，一次点击只打开一次。
- 若 Dock 内嵌场景仍有问题，先与独立 magpie 对照定位。仅在证明确需 Dock 配合时向 Dock 提交适配 issue，不在本独立插件仓修改 Dock 或提交宿主补丁。
- 本插件提供“复制站点地址”，作为宿主没有承接外链时的辅助入口；它不替代宿主正确打开 URL 的职责。

### 3. 模型启停同步

- 验证 options.set 的 disabledModels 更新后，宿主重新获取 provider.models 或使相关缓存失效。
- 区分凭据、供应商列表、目录缓存与 UI 选中状态；页面的 marketGroup 只是展示筛选，不自动改变推理路由。

### 4. 邀请资料与兑换

- 依据已核实的 token 成功响应 user，保留并透传账户标识及 aff_code、aff_count、aff_quota、aff_history_quota、inviter_id；不要让 summarize / Account / View 丢弃已经存在的字段。
- 按当前权限边界处理 dashboard 会话 / PAT 与 relay key；持续刷新方式须明确，不要求 relay key 获得整个后台权限。
- 插件本身仍有首次授权资料消费、账户归属与快照隔离待办；这些不是要求宿主代替插件完成。本版不宣称邀请闭环已实现。
- 兑换仍需确认实际用户兑换接口与权限，再约定桥接。neartoken:redeem 和 /api/magpie/device/redeem 仍是候选名称，不当作既有能力。

## 四、现有桥接边界

八条通道：state、connect、cancel、open、disconnect、refresh、usage、topup，均以 neartoken: 为前缀。

- connect：可选 affCode；保留现有确认 URL 处理。
- usage：range 为 day / week / month；明确区分不可达与尚未提供。
- topup：不带 amount 时读取档位；带 amount 和 paymentMethod 才创建订单，宿主映射为 HTTP 的 payment_method。
- 能力未就绪时返回明确错误或既有 unavailable / available:false 结果，不返回伪造成功、零余额或空用量充当真实结果。

## 五、验收与交付边界

独立插件的本次发布不等于服务端迁移或宿主适配完成。宿主后续需分别验证新前缀部署、真实授权 / 钱包 / 用量 / 支付、推荐资料归属、模型清单刷新与外链承接，并记录实际宿主版本。

关联历史任务位于 Fish-under-sea/FISH-DOCK-Plugins 的 #25 / #26 / #27。本次只交付文档，不修改宿主代码、不代发宿主版本，不将“当前兼容调用仍可响应”写成“新前缀迁移成功”。
