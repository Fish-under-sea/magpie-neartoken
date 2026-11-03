# NearToken in Magpie

把 [NearToken](https://neartoken.cc) 接进 [magpie](https://github.com/yetone/magpie) 的一个**单包插件**：侧边栏「插件」一组里多一个 NearToken 页面，负责登录绑定、余额与代金券、消耗看板和充值；模型与路由交回 magpie 自己的供应商页。

它不预装、不编进 magpie 的安装包，也不占用 magpie 的内置页面：`@fish-under-sea/magpie-neartoken` 就是一个可以单独下载、单独安装、单独卸载的包。

这个仓库是一次**迁移**，不是兼容层：原先是 DSH（DeepSeek Harness）里的 `dsh-neartoken`，现在按 magpie 的插件体系重做——页面跑在 magpie 的窗口里，出站请求由 magpie 本体代发，供应商挂在 `providers.json` 上，magpie 的模型选择、路由、失败切换照常工作。

## 下载

| 方式 | 命令 / 入口 |
| --- | --- |
| npm（推荐） | `magpie plugin add @fish-under-sea/magpie-neartoken` |
| GitHub 仓库 | `magpie plugin add github:Fish-under-sea/magpie-neartoken` |
| 离线包 | 在 [Releases](https://github.com/Fish-under-sea/magpie-neartoken/releases) 下载 `magpie-neartoken-<版本>.tgz`，解包后把目录添进「插件」页 |

装完在 magpie 的「插件」页打开 NearToken。卸载就是删掉这个包，magpie 的其它部分不受影响。

## 它做什么

| 页面上的事 | 数据从哪来 |
| --- | --- |
| 连接 NearToken | 站点的设备授权（RFC 8628 形状）：页面显示确认码，你在站点自己的页面登录并批准 |
| 余额、已用、代金券 | `GET /api/dsh/device/wallet`，用插件签下来的密钥读 |
| 消耗看板（日 / 周 / 月） | `GET /api/dsh/device/usage?range=…`，按模型堆叠 |
| 充值 | `GET /api/dsh/device/topup/info` 与 `POST /api/dsh/device/topup`，支付页交给系统浏览器 |
| 模型列表 | `GET /api/pricing`，写进 magpie 的供应商目录 |

页面本身一条 `fetch` 都发不出去（它跑在 `connect-src 'none'` 的沙箱帧里），所以上面每一件事都经 `magpie.call` 回到宿主执行。页面永远拿不到密钥：密钥只存在 `providers.json` 的 `neartoken` 那一条里。

**账号只有一个。** 不支持手动粘贴密钥，也不支持多账号：连接由页面发起，断开在页面点，别的地方没有第二入口。

## 宿主通道

`neartoken:*` 这几条调用属于**宿主能力**，不在插件包里：页面能做的每一次出站请求，都得由 magpie 本体执行。用到的是 magpie 的插件页调用通道（`POST /api/plugin-pages/call`），按插件 `package.json` 的 `magpie.calls` 白名单放行。

因此有两种 magpie：

- **带 neartoken 通道的构建**：页面全套功能可用。补丁与构建脚本在本仓库 `patches/`、`host/`、`tools/` 下，见[自己给 magpie 加通道](#自己给-magpie-加通道)。
- **官方原版**：页面照常出现、照常读得到站点与连接状态，但一点「连接」就会说明「这个 magpie 还没有插件页的调用通道」。不会静默失败，也不会假装成功。

## 页面调用（`magpie.calls`）

| 调用 | 作用 |
| --- | --- |
| `neartoken:state` | 连接状态、账户、代金券、未完成的授权、汇率、目录规模 |
| `neartoken:connect` | 发起一次设备授权（`affCode` 可选，站点侧的邀请码） |
| `neartoken:cancel` | 放弃进行中的授权 |
| `neartoken:open` | 用系统浏览器打开正在等的那页确认页 |
| `neartoken:disconnect` | 撤销密钥、删供应商、清本地数字 |
| `neartoken:refresh` | 立刻重读钱包与目录 |
| `neartoken:usage` | `{range: day\|week\|month}` 的用量窗口 |
| `neartoken:topup` | 不带 `amount` 读档位；带 `amount` 与 `paymentMethod` 下单并打开支付页 |

`package.json` 必须原样声明这张表：magpie 按它放行，宿主再按同一份声明校验一次。

## 和 dsh-neartoken 的关系：只共用站点，不混用标识

这不是 dsh-neartoken 的兼容层，也没有复用它的代码、配置或令牌。两边的连接方式不一样：

| | dsh-neartoken | 本插件 |
| --- | --- | --- |
| 宿主 | DSH | magpie |
| 请求由谁发 | DSH Host | magpie 本体（`/api/plugin-pages/call`） |
| 站点确认页上的称呼 | `DSH 插件` | `magpie` |
| 请求的 UA | DSH 自己的 | `magpie-neartoken` |
| 令牌 | 站点写的 `DSH` | 站点按 `magpie` 写 |
| 供应商 | DSH 的 `neartoken` provider | magpie 的 `neartoken` 供应商 |

共用的只有站点已经实现的那批设备授权端点（`/api/dsh/device/authorize`、`/token`、`/revoke`）与钱包、用量、充值端点——那是站点自己的接口，不是哪一家的实现。作者的 `DSH` 标识原样留着：他的令牌、日志和授权记录仍然只认 `DSH`，我们的连接写 `magpie`，两边在站点后台一眼分得开。

站点对「只有 DSH 授权签发的钥匙能充值」这件事回的是 `DSH_TOKEN_REQUIRED`，那是站点的历史码；插件只按它分支，对外一律说「这把密钥不是本插件登录签发的」。

## 页面怎么用

1. 装上包，侧边栏「插件」→「NearToken」。
2. 点「连接 NearToken」，页面给一个确认码。
3. 点「打开确认页」，用平时的方式登录站点——密码、GitHub、Discord、LinuxDo、OIDC、Telegram、微信、Passkey 都在站点自己的页面上完成。
4. 批准后自动接入：余额、代金券、看板、充值一次到齐；模型同时出现在 magpie 的供应商页。
5. 断开连接会撤销站点上这把密钥，并删掉 magpie 里这一条供应商。

## 仓库结构

仓库根就是那个 npm 包（`package.json` 在根，`npm pack` 直接可用）；宿主的源码与脚本在旁边的目录里，不进包。

```
/
├── package.json        插件清单：magpie.page / magpie.icon / magpie.calls
├── page/               页面本体：index.html · app.js · style.css · icon.svg · icon.png
├── LICENSE
├── host/internal/      宿主侧实现的源码（设备授权、钱包、用量、充值、目录）
├── patches/            叠在 FISH 的 magpie 补丁之上的增量
├── tools/              构建与打补丁的脚本
└── docs/               设计与契约
```

## 自己给 magpie 加通道

前提：magpie 源码已经是 `v0.1.2732` + FISH 的 `magpie-v0.1.2732+fish.9.patch`（那一版已经带了插件页调用通道），本仓库的补丁只往上再叠两件事：

1. `internal/neartoken`：设备授权、钱包、用量、充值、目录，以及把站点挂成供应商；
2. `internal/gui/pluginpagecall.go` 里多一条 `neartoken:` 前缀的分派。

```powershell
git -C ..\upstream-2732 apply patches\magpie-neartoken.patch
pwsh -File tools\build.ps1 -Upstream ..\upstream-2732 -Out dist\magpie.exe
```

`internal/neartoken` 的测试用 `httptest` 起一个假站点，不碰网络：

```powershell
go test ./internal/neartoken/ -count=1
```

## 设计取舍

- **登录用设备授权，不收密码。** 站点自己的登录页负责认证与 2FA，插件只轮询结果。插件签下来的密钥就是站点的一张普通令牌，与 `Authorization: Bearer` 完全一致。
- **模型选择不重做。** magpie 已经有供应商、模型、路由、失败切换这一整套；插件只负责把站点目录写进供应商，剩下的交回窗口。
- **金额口径只有一份。** 汇率来自 `/api/status` 的 `quota_per_unit` 与 `usd_exchange_rate`，钱包、看板、代金券都用它折算，三处数字不会互相打架。
- **读不到就说不知道。** 站点没有用量端点时页面写「站点未提供用量统计」，不画一张空图——空图会被读成「这段时间没有消耗」。

## 许可

MIT。站点图标（`page/icon.png`）取自 `neartoken.cc`，仅用于识别该服务。