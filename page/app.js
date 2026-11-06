// NearToken · magpie 页面插件的前端。
//
// 页面在 sandbox 帧里（CSP connect-src 'none'），一条 fetch 都发不出去：
// 所有出站请求都由 magpie 本体代发，这里只通过 bridge 的 magpie.call 问它。
// 所以本文件不碰网络、不存密钥，站点数据一律经 textContent 上屏。
;(() => {
  'use strict'

  const bridge = window.magpie
  const $ = (id) => document.getElementById(id)
  const PALETTE = ['#5b8def', '#3aa8c9', '#8b7bf0', '#2fb38f', '#d79a3a', '#d9697a']
  /** 推广码仅随站点链接传递；邀请关系是否成立以站点注册规则为准。 */
  const AFF_CODE = '0mY4'
  /** affURL 给站点链接补邀请码；已有 query 用 &。 */
  function affURL(raw) {
    const u = String(raw || '').trim()
    if (!u) return u
    try {
      const x = new URL(u, 'https://neartoken.cc')
      if (!x.searchParams.has('aff')) x.searchParams.set('aff', AFF_CODE)
      return x.toString()
    } catch { return u }
  }

  /** 上一次 neartoken:state 的应答。 */
  let view = null
  /** 看板窗口：day / week / month。 */
  let span = 'day'
  /** 上一次读到的窗口数据，按窗口名缓存，切回来不必再等。 */
  const windows = new Map()
  /** 充值面：档位、渠道、当前选择。 */
  let topupInfo = null
  /** 当前视角：home / market / logs。 */
  let tab = 'home'
  /** 插件写下的分组快照（page/groups.js），页面加载脚本取到。 */
  let groupSnapshot = null
  let groupsAsked = false
  const pick = { amount: null, method: null, custom: '' }
  /** 正在等宿主的哪个动作。 */
  let pendingAct = ''
  let tickCount = 0
  let clock = null

  // ---------- DOM 小工具 ----------

  /** el 造一个元素；attrs 里 data-* / aria-* 原样给，字符串子节点按文本放。 */
  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue
      if (k === 'class') node.className = v
      else if (k === 'text') node.textContent = v
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
      else node.setAttribute(k, v === true ? '' : String(v))
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
    }
    return node
  }

  /** card 是一张带标题的卡。 */
  function card(title, ...kids) {
    return el('section', { class: 'card' }, title ? el('h2', { text: title }) : null, ...kids)
  }

  // ---------- 与宿主说话 ----------

  /** call 问 magpie 做一件事；失败时把它的错误码带到异常上。 */
  async function call(name, params) {
    return bridge.call(name, params || {})
  }

  /** act 是一次点击动作：置忙、调用、合并回状态、重画。 */
  async function act(label, fn) {
    if (pendingAct) return
    pendingAct = label
    render()
    try {
      const next = await fn()
      if (next && typeof next === 'object') {
        if ('configured' in next) view = next
      }
      await softRefresh()
    } catch (error) {
      showError(error)
    } finally {
      pendingAct = ''
      render()
    }
  }

  /** showError 把宿主的话放到页脚的一条提示上，不弹窗。 */
  let lastError = ''
  let notice = ''
  function showNotice(text) { notice = text; lastError = ''; render() }
  function showError(error) {
    const said = String(error && error.message ? error.message : error)
    // options 写入限流由 saveDisabled 自己合并重试，不用挂到页脚
    if (/once a second at most|sets its options/i.test(said)) return
    lastError = said
    // 宿主侧仍在建 key+URL 供应商时，会撞上 magpie 的内置订阅 id。
    // 这不是页面能修的，给一句能照做的指引。
    if (/is the id of the .* subscription/i.test(said)) {
      lastError = '宿主侧还没适配：magpie 把 neartoken 当内置订阅的 id，普通供应商不能占它。' +
        '请先到 magpie 的供应商页里用 NearToken 自己的登录（插件已提供），' +
        '或等宿主按 issue #22 适配后再回这里连接。'
    }
    render()
  }

  // 点击弹层以外的地方收起日期面板（触发一次重绘）
  document.addEventListener('click', (e) => {
    if (!logCalOpen) return
    const t = e.target
    if (t && t.closest && (t.closest('.lg-cal') || t.closest('.lg-range-btn'))) return
    logCalOpen = false
    if (tab === 'logs') render()
  })

  // ---------- 主流程 ----------

  async function boot() {
    // 版本号来自 page/version.js（由 scripts/stamp.mjs 按 package.json 生成）
    const ver = self.NEARTOKEN_VERSION
    if (ver) {
      const chip = document.getElementById('version')
      if (chip) {
        chip.textContent = 'v' + ver
        chip.title = '插件版本 ' + ver
      }
    }
    // 预览用：?tab=market 可直接落在某个视角，生产里没这个参数就是原本界面
    const want = new URLSearchParams(location.search).get('tab')
    if (want === 'market' || want === 'logs' || want === 'home') tab = want
    startPriceSync()
    if (!bridge || typeof bridge.call !== 'function') {
      fail('这个 magpie 还没有插件页的调用通道。')
      return
    }
    try {
      await bridge.ready
      // 不再读插件 options：启停状态只走 neartoken:prefs（写文件、不重建插件宿主）。
      // 旧版 options 里那几个键即使还在宿主配置里，也不再参与任何判断。
      await initDisabledByGroup()
      await load()
      // 宿主的「整模型停用」要等目录加载完才能展开成分组停用
      if (hostOff.size) { applyHostOff(); render() }
      startHotReload()
      clock = setInterval(tick, 1000)
      bridge.onVisibility((visible) => {
        if (visible) load().catch(() => {})
      })
    } catch (error) {
      fail(String(error && error.message ? error.message : error))
    }
  }

  /** 接口不可用时只提供网页入口，不重发授权、充值或兑换请求。 */
  function webFallbackLinks() {
    return el('div', { class: 'row', 'data-web-fallback': 'true', style: 'flex-wrap:wrap;gap:8px;margin-top:12px' },
      [['https://neartoken.cc/', '打开站点登录 ↗'], ['https://neartoken.cc/wallet', '网页钱包 / 充值 ↗'], ['https://neartoken.cc/pricing', '官网模型目录 ↗']].map(([url, label]) =>
        el('a', { class: 'ghost link', href: affURL(url), target: '_blank', rel: 'noopener noreferrer' }, label)),
      el('button', { class: 'ghost', onclick: () => copy(affURL('https://neartoken.cc/')) }, '复制站点地址'))
  }
  function webFallbackCard() {
    return card('通过网页继续',
      el('p', { class: 'brief', text: '接口暂未就绪时，可先在站点登录、查看钱包或访问模型目录。网页登录不会自动完成插件设备授权。' }),
      webFallbackLinks(),
      el('p', { class: 'note', text: '如刚提交过充值，请先在网页钱包确认订单状态，不要重复下单。若宿主未打开网页，可复制地址到浏览器。' }))
  }

  /** 状态读取失败时同时保留重试与网页入口。 */
  function fail(message) {
    $('view').replaceChildren(card('NearToken',
      el('p', { class: 'brief', text: message }),
      el('div', { class: 'row', style: 'margin-top:12px' },
        el('button', { class: 'primary', onclick: () => location.reload() }, '重试'))), webFallbackCard())
    setStatus('不可用', 'warn')
  }

  async function load() {
    view = await call('neartoken:state')
    if (view.configured && !topupInfo) topupInfo = await call('neartoken:topup')
    if (view.configured && !windows.has(span)) windows.set(span, await call('neartoken:usage', { range: span }))
    render()
  }

  /** tick 每秒跑一次：等确认时勤一点，连上之后只补读看板与钱包。 */
  function tick() {
    tickCount += 1
    const counting = view && view.pending
    // 等确认时每秒问一次：站点那边一点批准，这边下一拍就能接上
    if (counting) load().catch(() => {})
    else if (tickCount % 60 === 0) load().catch(() => {})
    if (counting) paintCountdown()
  }

  /** softRefresh 只补读与当前视图有关的那一块，不重画整页。 */
  async function softRefresh() {
    if (!view) return
    if (view.configured) {
      if (!topupInfo) topupInfo = await call('neartoken:topup')
      if (!windows.has(span)) windows.set(span, await call('neartoken:usage', { range: span }))
    }
  }

  function setStatus(text, kind) {
    const chip = $('status')
    chip.className = 'chip' + (kind ? ' ' + kind : '')
    $('status-text').textContent = text
    $('disconnect').hidden = !(view && view.configured)
    $('site').textContent = (view && view.baseURL ? view.baseURL.replace(/^https?:\/\//, '') : 'neartoken.cc')
  }

  // ---------- 渲染 ----------

  function render() {
    if (!view) return
    const body = $('view')
    // 后台刷新仍可能重绘整页：记录广场与筛选栏各自的滚动位置。
    const oldAside = tab === 'market' ? body.querySelector('.market-aside') : null
    const scroll = oldAside ? { x: window.scrollX, y: window.scrollY, aside: oldAside.scrollTop } : null
    const frag = document.createDocumentFragment()
    if (view.pending) {
      setStatus('等待确认', 'warn')
      frag.append(pendingCard())
    } else if (view.configured) {
      setStatus('已连接', 'on')
      frag.append(tabsBar())
      if (tab === 'market') frag.append(marketCard())
      else if (tab === 'logs') frag.append(logsCard())
      else frag.append(el('div', { class: 'home-grid' },
        accountCard(), boardCard(), topupCard(), referralCard()))
    } else {
      setStatus('未连接')
      frag.append(connectCard())
    }
    if (view.error) frag.append(el('p', { class: 'note bad', text: view.error }))
    if (lastError) frag.append(el('p', { class: 'note bad', text: lastError }))
    if (view.error || lastError || (tab === 'logs' && windows.get(span)?.available === false)) frag.append(webFallbackCard())
    if (notice) frag.append(el('p', { class: 'note', text: notice }))
    if (pendingAct) frag.append(el('p', { class: 'note', text: '正在处理：' + pendingAct }))
    body.replaceChildren(frag)
    if (tab === 'market' && view.configured && !view.pending) {
      paintGroupBanner()
      refreshMarketList()
      if (scroll) {
        body.querySelector('.market-aside').scrollTop = scroll.aside
        window.scrollTo({ left: scroll.x, top: scroll.y, behavior: 'instant' })
      }
    }
    if (view.pending) paintCountdown()
    // 首页四张卡等高：以账户卡为基准锁死高度，多出来的内容在卡片内滚动
    if (tab === 'home' && view.configured) equalizeHome()
  }

  /** equalizeHome 量第一张卡（账户）的高度，锁到同组所有卡上。 */
  function equalizeHome() {
    const cards = [...document.querySelectorAll('.home-grid > .card:not(.home-wide)')]
    if (cards.length < 2) return
    cards.forEach((c) => { c.style.height = '' })
    const h = Math.round(cards[0].getBoundingClientRect().height)
    if (!h) return
    cards.forEach((c) => { c.style.height = h + 'px' })
  }

  /** tabsBar 是三个视角：原本界面、模型广场、使用日志。 */
  function tabsBar() {
    const tabs = [['home', '账户总览'], ['market', '模型广场'], ['logs', '使用日志']]
    return el('div', { class: 'tabs', role: 'tablist' },
      tabs.map(([key, label]) => el('button', {
        role: 'tab',
        'aria-selected': String(tab === key),
        class: tab === key ? 'on' : '',
        onclick: () => {
          if (tab === key) return
          tab = key
          render()
          // 日志页：先把插件刚写出的流水换进来，再重绘一次
          if (key === 'logs') syncLogs(() => render())
          if (key !== 'home' && view.configured && !windows.has(span)) {
            call('neartoken:usage', { range: span }).then((w) => { windows.set(span, w); render() }).catch(showError)
          }
          // 模型广场的数据在 page/pricing.js（包内快照 + 插件运行时覆盖），
          // 页面加载时就已就位，不需要再动态取。
        },
      }, label)))
  }

  /** 未连接：说清会发生什么，再给一个按钮。 */
  function connectCard() {
    return card('连接中转站',
      el('p', { class: 'brief' },
        '把 ', el('b', { text: 'neartoken.cc' }), ' 接成 magpie 的供应商：登录在站点自己的页面完成，' +
        '插件不接触密码。连接之后模型由 magpie 的供应商页统一选择，这里只管账户与额度。'),
      el('ul', { class: 'steps' },
        el('li', { text: '站点支持密码、GitHub、Discord、LinuxDo、OIDC、Telegram、微信与 Passkey 登录。' }),
        el('li', {}, '还没有账号？', el('a', { class: 'link', href: affURL('https://neartoken.cc/sign-up'), target: '_blank', rel: 'noreferrer' }, '带推荐码注册 ↗')),
        el('li', { text: '点下面按钮，浏览器会打开确认页；用你平时的方式登录并批准。' }),
        el('li', { text: '回到这里，NearToken 会自动接入，不需要粘贴任何密钥。' })),
      el('div', { class: 'row', style: 'margin-top:14px' },
        el('button', {
          class: 'primary',
          disabled: !!pendingAct,
          onclick: () => act('发起授权', () => call('neartoken:connect', { affCode: AFF_CODE })),
        }, '连接 NearToken')))
  }

  /** 等确认：码是主视觉，地址可复制。 */
  function pendingCard() {
    const p = view.pending
    const row = el('div', { class: 'row wrap', style: 'margin-top:14px' },
      el('button', {
        class: 'primary',
        disabled: !!pendingAct,
        onclick: () => act('打开确认页', () => call('neartoken:open')),
      }, '打开确认页'),
      el('button', { disabled: !!pendingAct, onclick: () => copy(affURL(p.verificationUriComplete)) }, '复制链接'),
      el('button', {
        class: 'ghost',
        disabled: !!pendingAct,
        onclick: () => { load().catch(() => {}) },
      }, '我已确认，立即刷新'),
      el('button', {
        class: 'ghost',
        disabled: !!pendingAct,
        onclick: () => act('取消', () => call('neartoken:cancel')),
      }, '取消'))
    return card('在站点上确认这次连接',
      el('div', { class: 'code', id: 'user-code', text: p.userCode }),
      el('p', { class: 'code-hint' }, '确认码 · ', el('span', { id: 'countdown', text: '' })),
      el('ol', { class: 'steps' },
        el('li', { text: '打开确认页，用你平时的方式登录 NearToken。' }),
        el('li', { text: '页面上这个确认码要和左边一致，再点批准。' }),
        el('li', { text: '批准后这里会自动接入，不用再回来点任何东西。' })),
      row,
      el('p', { class: 'note', id: 'copy-hint', text: '' }))
  }

  /** 推荐计划：站点「复制推荐链接」那一栏的长条卡，跨整行放最下面。 */
  function referralCard() {
    const url = affURL('https://neartoken.cc/sign-up')
    // 邀请数只认真实值：优先插件从站点 wallet 写出的快照，其次宿主 state；
    // 都没有就显示「—」，不再拿 0 假装同步过。
    const aff = self.NEARTOKEN_AFF || {}
    const raw = aff.invites ?? view.invites ?? view.inviteCount ?? view.affCount ?? view.aff_count
    const invites = (raw === undefined || raw === null || raw === '') ? '—' : String(raw)
    const stamp = aff.at ? ' · 同步 ' + new Date(Number(aff.at)).toTimeString().slice(0, 5) : ''
    return el('section', { class: 'card home-wide' },
      el('div', { class: 'rf' },
        el('div', { class: 'rf-ico' }, shareIcon()),
        el('div', { class: 'rf-text' },
          el('h2', { text: '推荐计划', style: 'margin:0' }),
          el('p', { class: 'note', text: '用户通过您的推荐链接注册后，您即可获得奖励。可随时将累计奖励转入余额。', style: 'margin:2px 0 0' })),
        el('div', { class: 'rf-invites' }, el('div', { class: 'k', text: '邀请' }), el('div', { class: 'v', text: invites })),
        el('div', { class: 'rf-link' }, el('span', { text: url })),
        el('button', { class: 'rf-copy', title: '复制推荐链接', onclick: (e) => copyModelId(url, e.currentTarget) }, copyIcon()),
        stamp ? el('span', { class: 'note', style: 'margin:0 0 0 2px', text: stamp }) : null))
  }

  /** groupRatioOf 从快照 groups 里取该分组的倍率。 */
  function groupRatioOf(name) {
    const p = pricing()
    const groups = p?.groups || {}
    const v = groups[String(name || '')]
    return Number.isFinite(Number(v)) ? Number(v) : undefined
  }

  /** groupNameOnly 去掉 "[低价][满血] " 这类前缀，只留组名本体。 */
  function groupNameOnly(name) {
    return String(name || '').replace(/^(\s*\[[^\]]*\])+\s*/, '').trim()
  }

  /** 附件：账户、余额、代金券。 */
  function accountCard() {
    const account = view.account || {}
    const money = splitMoney(account.balance || '')
    const used = account.used || ''
    const meta = [account.username ? '用户 ' + account.username : '', account.group ? '分组 ' + account.group : '']
      .filter(Boolean).join(' · ')
    const parts = [
      el('div', { class: 'row' },
        el('div', { class: 'grow' },
          el('div', { class: 'money' }, el('span', { class: 'unit', text: money.unit }), money.value),
          el('p', { class: 'money-note', text: [used ? '已用 ' + used : '', meta].filter(Boolean).join(' · ') || '还没有读到账户' })),
        el('button', {
          disabled: !!pendingAct,
          onclick: () => act('刷新余额', () => call('neartoken:refresh')),
        }, '刷新')),
    ]
    const vouchers = Array.isArray(account.vouchers) ? account.vouchers : []
    if (vouchers.length) {
      // 总额：各券金额按数字相加，原站顶部就是这么显示的
      const totalNum = vouchers.reduce((sum, v) => sum + (Number(String(v.amount || '').replace(/[^\d.]/g, '')) || 0), 0)
      const unit = String(vouchers[0].amount || '').replace(/[\d.,\s]/g, '') || '¥'
      parts.push(el('div', { class: 'voucher-total' },
        el('span', { class: 'vt-k', text: '代金券总额' }),
        el('span', { class: 'vt-v', text: unit + totalNum.toFixed(2) })))
      parts.push(el('div', { class: 'vouchers' }, vouchers.map((v) =>
        el('div', { class: 'voucher' },
          el('span', { class: 'who' }, groupBadge(String(v.group || '')), el('span', { class: 'vname', text: groupNameOnly(String(v.group || '')) })),
          el('span', { class: 'amt', text: v.amount })))))
    } else {
      parts.push(el('p', { class: 'note', text: '没有可用代金券。站点的邀请计划会发分组券。' }))
    }
    if (view.refreshedAt) parts.push(el('p', { class: 'note', text: '余额截至 ' + clockText(view.refreshedAt) }))
    return card('账户', ...parts)
  }

  /** 数据看板：日 / 周 / 月 + 堆叠面积。 */
  function boardCard() {
    const data = windows.get(span)
    const seg = el('div', { class: 'seg' },
      ['day', 'week', 'month'].map((key) =>
        el('button', {
          'aria-pressed': String(span === key),
          onclick: () => switchSpan(key),
        }, key === 'day' ? '日' : key === 'week' ? '周' : '月')))
    const parts = [el('div', { class: 'row' }, el('h2', { class: 'grow', text: '数据概览', style: 'margin:0' }), seg)]
    if (!data) {
      parts.push(el('p', { class: 'note', text: '正在读取用量…' }))
      return card(null, ...parts)
    }
    if (!data.available) {
      parts.push(el('p', { class: 'note warn', text: data.reason === 'unreachable'
        ? '暂时读不到站点的用量数据。'
        : '站点未提供用量统计。' }))
      parts.push(webFallbackLinks())
      return card(null, ...parts)
    }
    parts.push(el('div', { class: 'stats' },
      el('div', { class: 'stat' },
        el('div', { class: 'k', text: '消耗' }),
        el('div', { class: 'v', text: data.spent })),
      el('div', { class: 'stat' },
        el('div', { class: 'k', text: '当前余额' }),
        el('div', { class: 'v', text: data.balance || '—' })),
      el('div', { class: 'stat' },
        el('div', { class: 'k', text: 'Token' }),
        el('div', { class: 'v', text: compact(data.tokens) }))))
    const chart = el('div', { class: 'chart' })
    chart.append(stackedChart(data))
    parts.push(chart)
    const legend = legendOf(data)
    if (legend) parts.push(legend)
    return card(null, ...parts)
  }

  /**
   * 充值卡：站点「添加资金」页的缩小版。
   * 金额大卡（带优惠角标）、自定义金额 + 待支付、支付方式图标卡、兑换码。
   */
  function topupCard() {
    const info = topupInfo
    if (!info) return el('section', { class: 'card home-wide tp-wide' }, el('p', { class: 'note', text: '正在读取充值档位…' }), webFallbackLinks())
    if (info.unavailable) return el('section', { class: 'card home-wide tp-wide' }, el('p', { class: 'note', text: info.unavailable }), webFallbackLinks())
    const options = Array.isArray(info.options) && info.options.length ? info.options : []
    const methods = Array.isArray(info.methods) ? info.methods.slice() : []
    // 微信支付即便站点没给也补一个灰色占位，撑住右侧视觉空白
    if (!methods.some((m) => /wxpay|wechat|weixin/i.test(String(m?.type || '')))) {
      methods.push({ type: 'wxpay', name: '微信支付' })
    }
    const cur = info.currency || '￥'
    const amount = pick.amount || Number(pick.custom || 0)
    const method = (pick.method && methods.some((m) => m.type === pick.method && m.type === 'alipay')) ? pick.method
      : (methods.find((m) => m.type === 'alipay')?.type || '')
    const payable = (v) => v >= 500 ? Math.round(v * 0.96) : v >= 200 ? Math.round(v * 0.98) : v
    const saved = (v) => v - payable(v)
    // 「去支付」可用时才高亮；订单历史按钮据此决定是否与主按钮等高
    const canPay = !pendingAct && !!amount
    const head = el('div', { class: 'tp-head' },
      el('div', { class: 'tp-badge', text: '￥' }),
      el('div', { class: 'grow' },
        el('h2', { text: '添加资金', style: 'margin:0' }),
        el('p', { class: 'note', text: '选择金额和支付方式', style: 'margin:2px 0 0' })),
      el('a', {
        class: 'btn ghost tp-history' + (canPay ? '' : ' dim'),
        href: affURL('https://neartoken.cc/wallet'), target: '_blank', rel: 'noreferrer',
      }, el('span', { text: '订单历史' }), arrowIcon()),
      el('button', { class: 'primary tp-pay-btn', disabled: !canPay, onclick: () => pay(method) }, '去支付'))
    const tiles = el('div', { class: 'tp-tiles' }, options.map((v) => {
      const on = v === amount && !pick.custom
      const discount = v >= 500 ? '优惠 4%' : v >= 200 ? '优惠 2%' : ''
      return el('button', {
        class: 'tp-tile' + (on ? ' on' : ''), 'aria-pressed': String(on),
        onclick: () => { pick.amount = v; pick.custom = ''; render() },
      },
        el('b', { text: String(v) }),
        el('span', { class: 'tp-pay' },
          el('span', { text: cur + (discount ? payable(v) : v) }),
          discount ? el('span', { class: 'tp-save' }, el('i', { class: 'tp-dot' }), '节省 ' + saved(v)) : null),
        discount ? el('span', { class: 'tp-off', text: discount }) : null)
    }))
    const customRow = el('div', { class: 'tp-custom-row' },
      el('label', { class: 'field tp-field' },
        el('span', { class: 'cur', text: cur }),
        el('input', {
          type: 'text', inputmode: 'numeric', placeholder: '输入金额', value: pick.custom,
          'aria-label': '自定义金额',
          oninput: (e) => { pick.custom = e.target.value.replace(/[^\d]/g, ''); pick.amount = null; render() },
        })),
      el('div', { class: 'tp-due' }, el('span', { text: '待支付金额：' }), el('b', { text: cur + (amount || 0) })))
    const methodButtons = el('div', { class: 'tp-methods' }, methods.map((m) => {
      // 站点当前只有支付宝可用；微信支付置灰占位，撑住右侧视觉空白
      const usable = m.type === 'alipay'
      const on = usable && m.type === method
      return el('button', {
        class: 'tp-method' + (on ? ' on' : '') + (usable ? '' : ' tp-off-method'),
        'aria-pressed': String(on), disabled: !usable,
        title: usable ? m.name : '暂无此支付渠道',
        onclick: usable ? () => { pick.method = m.type; render() } : null,
      },
        el('span', { class: 'tp-micon ' + (m.type === 'alipay' ? 'ali' : 'wx'), text: m.type === 'alipay' ? '支' : '微' }),
        el('b', { text: m.name }),
        usable ? null : el('span', { class: 'tp-na', text: '暂无此支付渠道' }))
    }))
    const redeemRow = el('div', { class: 'tp-custom-row' },
      el('input', {
        class: 'tp-input', type: 'text', placeholder: '输入您的兑换码',
        oninput: (e) => { pick.redeem = e.target.value },
      }),
      el('button', { class: 'ghost', onclick: () => showNotice('当前插件尚未接入兑换调用，请到站点钱包页兑换。') }, '兑换额度'))
    const foot = el('p', { class: 'note', text: '付完 5 分钟内余额会自动刷新；订单与发票在站点的钱包页。' })
    // 显式 2 列 × 3 行网格：两列的标签行、内容行、输入行逐行对齐，
    // 兑换码框与「输入金额」框天然平行；横向堆叠不超出卡片宽度。
    const body = el('div', { class: 'tp-body' },
      el('div', { class: 'tp-cell' }, el('div', { class: 'tp-label', text: '金额' })),
      el('div', { class: 'tp-cell' }, el('div', { class: 'tp-label', text: '付款方式' })),
      el('div', { class: 'tp-cell' }, tiles),
      el('div', { class: 'tp-cell' }, methodButtons,
        el('p', { class: 'note', text: '其他支付方式请联系站长', style: 'margin:6px 0 0' })),
      el('div', { class: 'tp-cell' }, el('div', { class: 'tp-label', text: '自定义金额' }), customRow),
      el('div', { class: 'tp-cell' }, el('div', { class: 'tp-label', text: '🎁 有兑换码吗？' }), redeemRow))
    return el('section', { class: 'card home-wide tp-wide' }, head, body, foot)
  }

  /**
   * loadGroups 取分组快照。
   *
   * 页面在沙箱里发不出网络请求（CSP connect-src 'none'），但能加载自己目录下的
   * 脚本；插件（index.mjs）每次拉目录都会写一份 page/groups.js，这里引一下就有。
   */
  function loadGroups(force) {
    if (groupsAsked && !force) return Promise.resolve(groupSnapshot)
    groupsAsked = true
    return new Promise((resolve) => {
      const s = document.createElement('script')
      s.src = 'groups.js?t=' + Date.now()
      s.onload = () => {
        groupSnapshot = Array.isArray(self.NEARTOKEN_GROUPS) ? self.NEARTOKEN_GROUPS : null
        resolve(groupSnapshot)
      }
      s.onerror = () => resolve(null)
      document.head.append(s)
    })
  }

  /** retryGroups 让插件重新拉一次目录（刷新模型表也顺手刷新了这份快照）。 */
  async function retryGroups() {
    groupSnapshot = null
    render()
    try {
      await bridge.call('neartoken:refresh', {})
    } catch {
      /* 刷新失败也让下面的读取照跑一次 */
    }
    await loadGroups(true)
    render()
  }
    // ---------- 模型广场：一比一复刻 neartoken.cc/pricing ----------

  let marketQuery = ''
  let marketGroup = ''
  let marketKind = 'all'
  let marketUnit = 'M'
  let marketMode = 'standard'
  let marketSort = 'latest'
  let marketLayout = 'grid'
  let marketQuota = 'all'
  let marketEndpoint = 'all'
  /** 侧栏各节的展开状态：key → 是否展开。 */
  const asideOpen = new Map()
  let logQuery = ''
  let logGroup = ''
  let logKind = 'all'
  let logExpanded = false
  /** 日志时间范围：null 表示「今天到现在」。 */
  let logFrom = null
  let logTo = null
  /** 日期弹层是否展开。 */
  let logCalOpen = false
  /** 「展开」开的是第二行筛选，不是分布图。 */
  let logMore = false
  /** 眼睛按钮：隐藏/显示敏感信息（令牌名与费用）。 */
  let logPrivate = false
  /** 正在拉取用量。 */
  let logBusy = false
  /** 分页：当前页与每页行数。 */
  let logPage = 1
  let logPageSize = 100
  /** 哪些逐条行展开了模型映射面板。 */
  const mapOpen = new WeakSet()
  /** 只刷新当前区间：命中缓存就不打宿主；force 时强制重取。 */
  async function refreshUsage(force = false) {
    const sp = logSpan()
    logBusy = true
    render()
    try {
      if (force) windows.delete(sp)
      if (!windows.has(sp)) windows.set(sp, await call('neartoken:usage', { range: sp }))
    } catch (e) {
      showError(e)
    } finally {
      logBusy = false
      render()
    }
  }
  let logTokenName = ''
  let logRequestId = ''
  let logUpRequestId = ''
  /** 当前打开的日志菜单：group / kind / interval / cols。 */
  let logMenu = ''
  /** 自动刷新间隔（秒），0 表示关闭。 */
  let logInterval = 10
  let logAutoTimer = null
  /** 日志列是否显示。 */
  const LOG_COLS = [['token', '令牌'], ['model', '模型'], ['flow', '流'], ['tokenCount', 'Token'], ['bytes', '请求体大小'], ['cost', '费用'], ['time', '耗时'], ['detail', '详情']]
  let logCols = new Set(LOG_COLS.map(([k]) => k))
  /** 日志类型（对齐原站下拉）。 */
  const LOG_KINDS = [['all', '所有类型'], ['topup', '充值'], ['consume', '消耗'], ['manage', '管理', '已弃用'], ['system', '系统'], ['error', '错误'], ['refund', '退款'], ['login', '登录', '已弃用']]
  function setLogInterval(sec) {
    logInterval = sec
    if (logAutoTimer) { clearInterval(logAutoTimer); logAutoTimer = null }
    if (sec > 0) {
      logAutoTimer = setInterval(() => {
        if (tab !== 'logs') return
        // 逐条流水由插件抓取写入，自动刷新要把它一起换进来，否则只有聚合数在动
        syncLogs(() => render())
        refreshUsage(true).catch(() => {})
      }, sec * 1000)
    }
  }
  const marketVendors = new Set()
  const MARKET_QUOTA = [['all', '所有模型'], ['token', '按量计费'], ['request', '按次计费'], ['task', '任务计费']]
  const MARKET_ENDPOINTS = [['all', '所有类型'], ['openai', 'Chat'], ['openai-response', 'Response'], ['anthropic', 'Anthropic'], ['gemini', 'Gemini'], ['jina-rerank', 'Rerank'], ['image-generation', '图片'], ['embedding', '嵌入'], ['openai-video', '视频']]
  const MARKET_KINDS = [['all', '全部'], ['chat', '对话'], ['image', '生图'], ['video', '视频'], ['audio', '语音'], ['embedding', '向量']]

  /** 任务计费：站点给了用量 schema，按次或按秒算，与官网「任务计费」同口径。 */
  function isTaskModel(m) {
    const t = m?.billing_usage_schema
    return !!t && typeof t === 'object' && Object.keys(t).length > 0
  }

  /** 官网定价类型：任务优先，其次按次（quota_type 1），其余按量。 */
  function quotaKindOf(m) {
    if (isTaskModel(m)) return 'task'
    return Number(m?.quota_type) === 1 ? 'request' : 'token'
  }

  /** pricing 是包内静态快照（插件运行时会把实时目录覆盖进同一个文件）。 */
  function pricing() {
    const p = self.NEARTOKEN_PRICING
    return p && Array.isArray(p.models) && p.models.length ? p : null
  }

  /**
   * startPriceSync 每分钟把插件写出后的新快照重新引入一次，
   * 模型列表与分组跟着站点实时同步（禁用状态、筛选都保留）。
   */
  /**
   * syncLogs 把插件新写出的逐条流水与诊断重新引入一次。
   *
   * logs.js 只在页面加载时引一次，插件之后写入的新记录页面看不到——
   * 所以日志页开着时要主动换一份，否则永远停在打开那一刻的旧数据。
   */
  function syncLogs(then) {
    const prevLogs = document.querySelector('script[data-nt-logs]')
    const s = document.createElement('script')
    s.src = 'logs.js?t=' + Date.now()
    s.dataset.ntLogs = '1'
    s.onload = () => {
      if (prevLogs && prevLogs !== s) prevLogs.remove()
      const prevMeta = document.querySelector('script[data-nt-logs-meta]')
      const m = document.createElement('script')
      m.src = 'logs-meta.js?t=' + Date.now()
      m.dataset.ntLogsMeta = '1'
      m.onload = () => {
        if (prevMeta && prevMeta !== m) prevMeta.remove()
        if (typeof then === 'function') then()
      }
      m.onerror = () => { m.remove(); if (typeof then === 'function') then() }
      document.head.appendChild(m)
    }
    s.onerror = () => s.remove()
    document.head.appendChild(s)
  }

  let priceTimer = null
  function startPriceSync() {
    if (priceTimer) return
    priceTimer = setInterval(() => {
      const prev = document.querySelector('script[data-nt-price]')
      const s = document.createElement('script')
      s.src = 'pricing.js?t=' + Date.now()
      s.dataset.ntPrice = '1'
      s.onload = () => {
        if (prev && prev !== s) prev.remove()
        // 站点邀请数据也跟着刷一次
        const prevAff = document.querySelector('script[data-nt-aff]')
        const a = document.createElement('script')
        a.src = 'aff.js?t=' + Date.now()
        a.dataset.ntAff = '1'
        a.onload = () => {
          if (prevAff && prevAff !== a) prevAff.remove()
          if (tab === 'home') render()
        }
        a.onerror = () => a.remove()
        document.head.appendChild(a)
        // 日志只在日志页可见，按需同步，省掉无谓的重绘
        if (tab === 'logs') { syncLogs(() => render()); return }
        if (tab === 'market') render()
      }
      s.onerror = () => s.remove()
      document.head.appendChild(s)
    }, 60000)
  }

  /** syncedAt 把快照时间格式化成 HH:MM，给工具条显示。 */
  function syncedAt() {
    const at = Number(pricing()?.at) || 0
    if (!at) return ''
    const d = new Date(at)
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  }

  /** marketKindOf 按站点端点判类型，端点没标时用模型名/tags 兜底。 */
  function marketKindOf(m) {
    const ends = m?.supported_endpoint_types || []
    const tags = String(m?.tags || '')
    const name = String(m?.name || '')
    const text = tags + ' ' + name
    if (ends.includes('image-generation')) return 'image'
    if (ends.includes('openai-video') || /video/i.test(tags) || /^(veo|sd2|omni|seedance|minimax-h3|kling|sora|vidu|hailuo)/i.test(name)) return 'video'
    if (/tts|asr|speech|audio|music|sound|lyrics|stems|transcribe|whisper|suno|语音|合成|转文字/i.test(text)) return 'audio'
    if (/embedding|embed|vector|向量/i.test(text)) return 'embedding'
    return 'chat'
  }

  /** 鸡蛋🥚 是被置顶的特殊分组：站点发了就自动纳入，没发就显示暂无。 */
  const isEgg = (g) => /鸡蛋|🥚|egg/i.test(String(g || ''))

  /** groupModels 是某个分组下实际挂的模型，来自实时快照（不是写死的名单）。 */
  function groupModels(name) {
    const models = pricing()?.models || []
    return models.filter((m) => (m.enable_groups || []).includes(name))
  }

  /**
   * groupKind 用分组下的具体模型推功能类别：
   * 多数是生图端点就归「图片」，视频端点归「视频」，依此类推。
   * 这样站点新增分组/模型时归类跟着快照变，不会留成悬空的分组。
   * 分组下暂时没有模型时，才回退到组名关键词。
   */
  function groupKind(name) {
    const ms = groupModels(name)
    if (!ms.length) {
      const raw = String(name || '')
      if (/生图|图片|image/i.test(raw)) return 'image'
      if (/视频|video/i.test(raw)) return 'video'
      if (/语音|TTS|ASR|音频/i.test(raw)) return 'audio'
      if (/向量|embedding/i.test(raw)) return 'embedding'
      return 'chat'
    }
    const votes = { image: 0, video: 0, audio: 0, embedding: 0, chat: 0 }
    for (const m of ms) votes[marketKindOf(m)] = (votes[marketKindOf(m)] || 0) + 1
    const kinds = ['image', 'video', 'audio', 'embedding']
    let best = 'chat', bestN = votes.chat
    for (const k of kinds) if (votes[k] > bestN) { best = k; bestN = votes[k] }
    return best
  }

  /** 系列顺序：Claude → GPT → Gemini → Grok → Kimi → GLM → Qwen → DeepSeek → 其他。 */
  const SERIES_ORDER = ['Claude', 'GPT', 'Gemini', 'Grok', 'Kimi', 'GLM', 'Qwen', 'DeepSeek', '其他']
  const KIND_SERIES = { image: '图片', video: '视频', audio: '音频', embedding: '向量' }

  /** 用 vendors 表的名称认系列（实时快照，id 变了也跟得上），名称没命中再看模型名。 */
  const VENDOR_WORDS = [
    ['Claude', /anthropic|claude/i], ['GPT', /openai|gpt/i], ['Gemini', /google|gemini/i],
    ['Grok', /xai|grok/i], ['Kimi', /moonshot|kimi/i], ['GLM', /智谱|zhipu|glm/i],
    ['Qwen', /阿里巴巴|alibaba|qwen|通义/i], ['DeepSeek', /deepseek|kimseek|ds-/i],
  ]
  function seriesOfModel(m) {
    const v = (pricing()?.vendors || []).find((x) => String(x.id) === String(m.vendor_id))
    const text = (v?.name || '') + ' ' + String(m.name || '')
    for (const [s, re] of VENDOR_WORDS) if (re.test(text)) return s
    return '其他'
  }

  /**
   * groupSeries 用该分组下模型的系列投票，决定这个分组归到哪个系列位置。
   * 分组档位内的 chip 就按它排（Claude → GPT → … → DS），不再按倍率乱跳。
   */
  function groupSeries(g) {
    const ms = groupModels(g)
    if (!ms.length) {
      for (const [s, re] of VENDOR_WORDS) if (re.test(String(g || ''))) return s
      return '其他'
    }
    const votes = {}
    for (const m of ms) { const s = seriesOfModel(m); votes[s] = (votes[s] || 0) + 1 }
    let best = '其他', bn = votes['其他'] || 0
    for (const s of SERIES_ORDER) if ((votes[s] || 0) > bn) { best = s; bn = votes[s] }
    return best
  }
  const seriesIdx = (g) => {
    if (/国模/.test(String(g || ''))) return 999   // 国模固定排在该档最后
    const i = SERIES_ORDER.indexOf(groupSeries(g))
    return i === -1 ? 99 : i
  }

  /** modelRank 返回模型该排在哪一档：先 LLM 系列，再功能模型，全部来自实时数据。 */
  function modelRank(m) {
    const kind = marketKindOf(m)
    if (kind !== 'chat') return { tier: 1, order: ['image', 'video', 'audio', 'embedding'].indexOf(kind), kind }
    const s = seriesOfModel(m)
    return { tier: 0, order: SERIES_ORDER.indexOf(s) === -1 ? 99 : SERIES_ORDER.indexOf(s), kind }
  }

  function vendorOf(id) {
    const v = (pricing()?.vendors || []).find((x) => String(x.id) === String(id))
    return v ? v.name : '其他'
  }

  /** 第一级：模型功能（由分组下实际模型端点推导，不靠组名猜）。第二级：价格与品质。 */
  const PRICE_TAGS = ['低价', '满血', '促销', '备用', '官Key', '官key', '国模', '自有', '反重力', '神秘折扣', 'CC', 'Kiro', '灵车', 'Argon', 'GPT Pro', 'Claude', 'DeepSeek', 'GLM', 'Gemini', 'Kimi', 'GPT', 'Suno', 'AIS']

  /** 第二级里的首标签次序：满血 > 官Key > 低价 > 其他。满血排在低价前面。 */
  const LEAD_ORDER = ['满血', '官Key', '官key', '低价', '促销', '备用', '国模', '自有', '反重力', '神秘折扣']
  const leadRank = (w) => {
    const i = LEAD_ORDER.findIndex((k) => w.toLowerCase().includes(k.toLowerCase()))
    return i === -1 ? 99 : i
  }

  /** groupTags 把 [低价][满血] GPT Pro 2 拆成功能 / 价格 / 其他标签 / 余下文字。 */
  function groupTags(name) {
    const raw = String(name || '')
    const parts = (raw.match(/\[[^\]]+\]/g) || []).map((p) => p.slice(1, -1))
    const rest = raw.replace(/\[[^\]]+\]/g, '').trim()
    const all = parts.concat(rest ? [rest] : []).join(' ')
    // 功能标签按分组下实际模型的端点推导；站点改目录后自动跟着变
    const func = KIND_SERIES[groupKind(name)] || '对话'
    // 官Key 是独立档位，标签里不再挂「满血」（[满血][官Key] → 官Key）
    const price = parts.filter((p) => PRICE_TAGS.some((k) => p.toLowerCase().includes(k.toLowerCase())))
    price.sort((a, b) => leadRank(a) - leadRank(b))
    // 功能词由功能标签表达，不再重复成小标签（生图 / 图片 / 视频 / 语音 / 向量）
    const FUNC_WORDS = /^(生图|图片|图像|视频|语音|音频|向量|嵌入)$/
    // 站点自己的其它标签（🥚 / ?? / AIS 等）照抄显示，不能丢
    const extra = parts.filter((p) => !price.includes(p) && p !== func && !FUNC_WORDS.test(p))
    return { func, price, extra, rest, lead: price[0] || '' }
  }

  /** groupBadge 按「功能 → 价格」两级重绘；首标签单独加 .lead 作视觉区分。 */
  function groupBadge(name, ratio) {
    const t = groupTags(name)
    const tone = { '图片': 'pink', '视频': 'blue', '音频': 'purple', '向量': 'teal', '对话': 'plain' }
    const colorOf = (w) => {
      if (/满血|原生|特惠/i.test(w)) return 'red'
      if (/反重力/i.test(w)) return 'cyan'
      if (/低价|神秘|自有|国模/i.test(w)) return 'green'
      if (/促销|生图|Kiro|灵车/i.test(w)) return 'pink'
      if (/备用|官Key|官key|CC|Argon|GPT Pro|视频|向量/i.test(w)) return 'blue'
      return 'plain'
    }
    const extraTone = (w) => (/🥚|蛋/i.test(w) ? 'gold' : /\?\?/.test(w) ? 'slate' : 'plain')
    return el('span', { class: 'gb' },
      // 功能标签只在非对话类显示；对话是默认，不重复挂
      t.func === '对话' ? null : el('span', { class: 'gb-tag lvl1 ' + (tone[t.func] || 'plain'), text: t.func }),
      t.extra.map((w) => el('span', { class: 'gb-tag lvl2 ' + extraTone(w), text: w })),
      t.price.map((w, i) => el('span', {
        class: 'gb-tag lvl2 ' + colorOf(w) + (i === 0 ? ' lead' : ''),
        text: w,
      })),
      t.rest ? el('span', { class: 'gb-rest', text: t.rest }) : null,
      // 分组倍率：快照 groups 里的数字，原站也把它跟在组名后面
      Number.isFinite(Number(ratio)) && Number(ratio) > 0
        ? el('span', { class: 'gb-mul', text: 'x' + String(Number(ratio)).replace(/0+$/, '').replace(/\.$/, '') })
        : null)
  }

  /** 计价条件的有限解析器：仅允许数值/字符串比较、布尔运算及公开用量/时间函数。 */
  function priceCondition(expression, facts = {}, now = new Date()) {
    try {
      const tokens = []
      const pattern = /\s*(\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_]\w*|\|\||&&|>=|<=|==|!=|[()!,><])/y
      let at = 0
      while (at < expression.length) {
        if (!expression.slice(at).trim()) break
        pattern.lastIndex = at
        const match = pattern.exec(expression)
        if (!match) return undefined
        tokens.push(match[1]); at = pattern.lastIndex
      }
      let cursor = 0
      const requireToken = (expected) => { if (tokens[cursor++] !== expected) throw new Error('Unsupported pricing condition') }
      const primary = () => {
        const token = tokens[cursor++]
        if (token === '(') { const value = or(); requireToken(')'); return value }
        if (token === '!') { const value = primary(); return value === undefined ? undefined : !value }
        if (/^\d/.test(token || '')) return Number(token)
        if (token?.startsWith('"')) return JSON.parse(token)
        if (token?.startsWith("'")) return token.slice(1, -1)
        if (token === 'true' || token === 'false') return token === 'true'
        if (!['u', 'hour', 'weekday'].includes(token)) throw new Error('Unsupported pricing function')
        requireToken('('); const argument = primary(); requireToken(')')
        if (token === 'u') return facts[argument]
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: argument, weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now)
        if (token === 'hour') return Number(parts.find((x) => x.type === 'hour')?.value)
        return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((x) => x.type === 'weekday')?.value)
      }
      const comparison = () => {
        const left = primary(), operator = tokens[cursor]
        if (!['==', '!=', '>=', '<=', '>', '<'].includes(operator)) return left
        cursor++; const right = primary()
        if (left === undefined || right === undefined) return undefined
        if (operator === '==') return left === right
        if (operator === '!=') return left !== right
        if (operator === '>=') return left >= right
        if (operator === '<=') return left <= right
        return operator === '>' ? left > right : left < right
      }
      const and = () => { let value = comparison(); while (tokens[cursor] === '&&') { cursor++; const right = comparison(); value = value === false || value === 0 || right === false || right === 0 ? false : value === undefined || right === undefined ? undefined : !!value && !!right } return value }
      const or = () => { let value = and(); while (tokens[cursor] === '||') { cursor++; const right = and(); value = value === true || right === true ? true : value === undefined || right === undefined ? undefined : !!value || !!right } return value }
      const value = or()
      return cursor === tokens.length ? value : undefined
    } catch { return undefined }
  }

  /** 时段规则只求当前分支，绝不通过 eval 执行站点表达式。 */
  function timedPriceExpression(expression, now = new Date()) {
    const question = expression.indexOf('?')
    if (question < 0) return undefined
    let depth = 0, quote = '', nested = 0, colon = -1
    for (let i = question + 1; i < expression.length; i++) {
      const ch = expression[i]
      if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue }
      if (ch === '"' || ch === "'") { quote = ch; continue }
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (depth === 0 && ch === '?') nested++
      if (depth === 0 && ch === ':') { if (nested) nested--; else { colon = i; break } }
    }
    if (colon < 0) return undefined
    const active = priceCondition(expression.slice(0, question), {}, now)
    if (active === undefined) return undefined
    return (active ? expression.slice(question + 1, colon) : expression.slice(colon + 1)).trim()
  }

  /** 只解析任务单价的线性项；无法确认的表达式交给官网详情，不执行远程代码。 */
  function taskPrices(m, multiplier) {
    const schema = m?.billing_usage_schema
    if (!schema || !Object.keys(schema).length) return null
    const expr = String(m.billing_expr || '')
    if (!expr) return Number(m.quota_type) === 1 ? null : { unconfigured: true }
    const number = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?'
    const disabled = m.billing_disabled_usage
    const restrict = disabled && Object.values(disabled).some((values) => Array.isArray(values) && values.length)
    let scenarios = [{}], previousEnd = 0
    if (restrict) {
      for (const [key, spec] of Object.entries(schema)) {
        if (!Array.isArray(spec.enum)) continue
        const allowed = spec.enum.filter((value) => !(disabled[key] || []).includes(value))
        if (scenarios.length * allowed.length > 256) return { unsupported: true, tiered: true }
        scenarios = scenarios.flatMap((facts) => allowed.map((value) => ({ ...facts, [key]: value })))
      }
    }
    const tiers = []
    for (const match of expr.matchAll(/\btier\(\s*(["'])([^"']*)\1\s*,/g)) {
      const start = match.index + match[0].length
      let depth = 1, quote = '', end = start
      for (; end < expr.length; end++) {
        const ch = expr[end]
        if (quote) { if (ch === '\\') end++; else if (ch === quote) quote = ''; continue }
        if (ch === '"' || ch === "'") { quote = ch; continue }
        if (ch === '(') depth++
        if (ch === ')' && --depth === 0) break
      }
      if (depth) return { unsupported: true, tiered: true }
      if (restrict) {
        const prefix = expr.slice(previousEnd, match.index).trim().replace(/^:\s*/, '')
        const question = prefix.lastIndexOf('?')
        let active
        if (question >= 0) {
          const condition = prefix.slice(0, question).trim()
          const results = scenarios.map((facts) => ({ facts, result: priceCondition(condition, facts) }))
          if (results.some((item) => item.result === undefined)) return { unsupported: true, tiered: true }
          active = results.some((item) => !!item.result)
          scenarios = results.filter((item) => !item.result).map((item) => item.facts)
        } else { active = scenarios.length > 0; scenarios = [] }
        previousEnd = end + 1
        if (!active) continue
      }
      const cost = expr.slice(start, end).trim()
      const terms = cost.split(/\s+\+\s+|(?<=[)\d])\+(?=[a-zA-Z(\d])/g)
      const units = {}, constants = []
      for (const term of terms) {
        const direct = term.match(new RegExp(String.raw`^u\(\s*(["'])([^"']+)\1\s*\)\s*\*\s*(${number})$`))
        const reverse = term.match(new RegExp(String.raw`^(${number})\s*\*\s*u\(\s*(["'])([^"']+)\2\s*\)$`))
        if (direct || reverse) {
          const key = direct ? direct[2] : reverse[3]
          const value = Number(direct ? direct[3] : reverse[1])
          if (!Number.isFinite(value) || value < 0 || !schema[key]?.unit) return { unsupported: true, tiered: true }
          units[key] = (units[key] || 0) + value
        } else {
          const constant = term.match(new RegExp('^(?:fixed\\(\\s*)?(' + number + ')(?:\\s*\\))?$'))
          if (!constant) return { unsupported: true, tiered: true }
          constants.push(Number(constant[1]))
        }
      }
      tiers.push({ units, constant: constants.reduce((a, b) => a + b, 0) })
    }
    if (!tiers.length) return { unsupported: true, tiered: true }
    const entries = []
    const localized = (v, fallback) => typeof v === 'string' ? v : (v?.zh || v?.zhCN || v?.en || fallback)
    const range = (values) => ({ value: Math.min(...values) * multiplier, max: Math.max(...values) * multiplier })
    for (const [key, spec] of Object.entries(schema)) {
      const values = tiers.map((t) => t.units[key]).filter(Number.isFinite)
      if (!values.length) continue
      const unit = localized(spec.unitLabel, { second: '秒', count: '个', credit: '积分', token: 'Token', request: '次' }[spec.unit] || spec.unit)
      entries.push({ key, label: localized(spec.description, key), unit, ...range(values) })
    }
    for (const [key, label, pure] of [['request', '按次计费', true], ['constant', '附加费用', false]]) {
      const values = tiers.filter((t) => (Object.keys(t.units).length === 0) === pure && t.constant > 0).map((t) => t.constant)
      if (values.length) entries.push({ key, label, unit: '次', ...range(values) })
    }
    return entries.length ? { entries, tiered: true } : { unsupported: true, tiered: true }
  }

  /** 官网口径：选组倍率 → 标准/充值系数 → 币种与单位格式化。 */
  function priceOf(m) {
    const config = pricing()?.currency || {}
    const priceRate = Math.max(Number(config.price ?? 1), 0.001)
    const exchangeRate = Math.max(Number(config.usd_exchange_rate ?? priceRate), 0.001)
    const modelGroups = m?.enable_groups || []
    const ratios = modelGroups.map((g) => Number(pricing()?.groups?.[g])).filter(Number.isFinite)
    const selectedRatio = Number(pricing()?.groups?.[marketGroup])
    const groupRatio = marketGroup && modelGroups.includes(marketGroup)
      ? (Number.isFinite(selectedRatio) ? selectedRatio : 1)
      : (ratios.length ? Math.min(...ratios) : 1)
    const multiplier = groupRatio * (marketMode === 'topup' ? priceRate / exchangeRate : 1)
    let expr = m?.billing_mode === 'tiered_expr' ? String(m.billing_expr || '') : ''
    const currentPeriod = /\b(?:hour|weekday)\s*\(/.test(expr)
    if (currentPeriod) {
      expr = timedPriceExpression(expr)
      if (expr === undefined) return { unsupported: true, tiered: true }
    }
    const task = taskPrices({ ...m, billing_expr: expr }, multiplier)
    if (task) return { ...task, currentPeriod }
    const coef = (v) => { const x = expr.match(new RegExp('\\b' + v + '\\s*\\*\\s*([\\d.]+(?:[eE][+-]?\\d+)?)')); return x ? Number(x[1]) : undefined }
    const fixed = expr.match(/fixed\(\s*([\d.]+)\s*\)/)
    if (fixed) return { perCall: Number(fixed[1]) * multiplier, perLabel: /\bimage_count\b/.test(expr) ? '张' : '次', tiered: true }
    if (!expr && Number(m?.quota_type) === 1 && typeof m?.model_price === 'number' && Number.isFinite(m.model_price) && m.model_price >= 0) {
      return { perCall: m.model_price * multiplier, perLabel: '次', tiered: false }
    }
    const finite = (v) => typeof v === 'number' && Number.isFinite(v)
    if (expr && (coef('p') === undefined && coef('c') === undefined || /\b(?:time|hour|minute|weekday|month|day)\s*\(/.test(expr))) return { unsupported: true, tiered: true }
    const p0 = expr ? coef('p') : (finite(m?.model_ratio) ? m.model_ratio * 2 : undefined)
    const c0 = expr ? coef('c') : (p0 !== undefined && finite(m?.completion_ratio) ? p0 * m.completion_ratio : undefined)
    const r0 = expr ? coef('cr') : (p0 !== undefined && finite(m?.cache_ratio) ? p0 * m.cache_ratio : undefined)
    return { input: p0 === undefined ? undefined : p0 * multiplier, output: c0 === undefined ? undefined : c0 * multiplier, cache: r0 === undefined ? undefined : r0 * multiplier, tiered: !!expr, currentPeriod }
  }

  /** 与官网一致区分币种、千/百万 Token，以及缺失值和微小非零价格。 */
  function money(v, unit, perCall = false) {
    if (v === undefined || v === null || !Number.isFinite(v)) return '—'
    const config = pricing()?.currency || {}
    const kind = config.quota_display_type || 'CNY'
    const rate = kind === 'CNY' ? Number(config.usd_exchange_rate ?? 1) : kind === 'CUSTOM' ? Number(config.custom_currency_exchange_rate ?? 1) : 1
    let amount = v * (rate > 0 ? rate : 1) / (unit === 'K' ? 1000 : 1)
    const digits = Math.abs(amount) >= 1 || perCall ? 4 : 6
    if (amount !== 0 && Math.abs(amount) < 10 ** -digits) amount = Math.sign(amount) * 10 ** -digits
    const options = { minimumFractionDigits: 0, maximumFractionDigits: digits }
    if (kind === 'CUSTOM') return (config.custom_currency_symbol?.trim() || '¤') + ' ' + new Intl.NumberFormat('zh-CN', options).format(amount)
    return new Intl.NumberFormat('zh-CN', { ...options, style: 'currency', currency: kind === 'CNY' ? 'CNY' : 'USD', currencyDisplay: 'narrowSymbol' }).format(amount)
  }

  /** 官网真实详情路由；保留返回列表所需的分组、单位和计价模式。 */
  function modelDetailURL(m) {
    const url = new URL('https://neartoken.cc/pricing/' + encodeURIComponent(m.name))
    if (marketGroup) url.searchParams.set('group', marketGroup)
    url.searchParams.set('tokenUnit', marketUnit)
    if (marketMode === 'topup') url.searchParams.set('rechargePrice', 'true')
    return affURL(url.toString())
  }

  /** modelCard：点击整张卡切换启用；高亮就是启用，只有启用的进 magpie 模型清单。 */
  /** 模型映射图标：两个圆点由 S 形连线相接，点开看请求/上游/响应模型。 */
  function mapIcon() {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '13'); svg.setAttribute('height', '13')
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.7')
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round')
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('d', 'M8 7h6a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h5')
    svg.appendChild(path)
    for (const [cx, cy] of [[19, 7], [6, 19]]) {
      const c = document.createElementNS(ns, 'circle'); c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', '2')
      svg.appendChild(c)
    }
    return svg
  }

  /** 推荐计划图标：三个节点由连线相接（分享语义），放在圆形底上。 */
  function shareIcon() {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '18'); svg.setAttribute('height', '18')
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.7')
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round')
    for (const d of ['M9 12a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0z', 'M20 5.5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0z', 'M20 18.5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0z', 'M8.6 10.9 15.4 6.6', 'M8.6 13.1 15.4 17.4']) {
      const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.appendChild(p)
    }
    return svg
  }

  /** 外链箭头：细线斜向右上。 */
  function arrowIcon() {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '13'); svg.setAttribute('height', '13')
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8')
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round')
    for (const d of ['M7 17 17 7', 'M9 7h8v8']) {
      const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.appendChild(p)
    }
    return svg
  }

  /** 复制图标：两个错位圆角方框，和上游一致。 */
  function copyIcon() {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '13'); svg.setAttribute('height', '13')
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8')
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round')
    for (const d of ['M9 9h9a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 18 21H9A1.5 1.5 0 0 1 7.5 19.5V10.5A1.5 1.5 0 0 1 9 9z', 'M4.5 15A1.5 1.5 0 0 1 3 13.5V4.5A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5']) {
      const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.appendChild(p)
    }
    return svg
  }

  /** 模型品牌小图标：按 vendor_id 取本地品牌图标，取不到用首字母块。 */
  function modelBrandIcon(m) {
    const p = pricing()
    const v = (p?.vendors || []).find((x) => String(x.id) === String(m?.vendor_id))
    const item = v ? vendorIconModel(v, p) : null
    if (item && item.src) return el('img', { class: 'ml-vicon', src: item.src, alt: '', width: 13, height: 13, loading: 'lazy' })
    return el('span', { class: 'ml-vicon ml-vicon-fb', text: String(m?.name || '?').slice(0, 1).toUpperCase() })
  }

  /** fmtMoney 把价格收成最多两位小数（去掉多余 0）。 */
  function fmtMoney(v) {
    const n = Number(v)
    if (!Number.isFinite(n)) return '—'
    const fixed = n.toFixed(2)
    if (fixed.endsWith('.00')) return fixed.slice(0, -3)
    if (fixed.endsWith('0')) return fixed.slice(0, -1)
    return fixed
  }

  /** modelRow 渲染列表模式下的一行：模型 / 类型 / 价格 / 缓存 / 供应商 / 标签 / 端点 / 分组。 */
  function modelRow(m) {
    const p = priceOf(m)
    // 列表行与卡片必须用同一套判据：分组级明细 + 宿主的整模型停用
    const on = isOn(m)
    const groups = (m?.enable_groups || []).slice()
    const shown = groups.slice(0, 2)
    const restCount = Math.max(0, groups.length - shown.length)
    const ends = m?.supported_endpoint_types || []
    const vendorName = vendorOf(m.vendor_id)
    const item = (pricing()?.vendors || []).find((v) => String(v.id) === String(m.vendor_id))
    const vIcon = item ? vendorIconModel(item, pricing()) : null
    return el('div', {
      class: 'ml-row' + (on ? '' : ' off'),
      'data-model': m.name,
      onclick: () => toggleModel(m.name),
    },
      el('span', { class: 'ml-cell ml-model' },
        modelBrandIcon(m), el('span', { class: 'ml-name', text: m.name }),
        el('span', { class: 'ml-sort', text: '⇅' })),
      el('span', { class: 'ml-cell ml-type ' + (p.tiered ? 'dyn' : 'flat'), text: p.unconfigured ? '按用量计费' : p.tiered ? '动态计费' : '按量计费' }),
      el('span', { class: 'ml-cell ml-price' },
        el('span', { class: 'ml-p-line' },
          el('span', { class: 'ml-p-k', text: '输入' }), el('span', { class: 'ml-p-v', text: fmtMoney(p.input) }),
          el('span', { class: 'ml-p-k', text: '输出' }), el('span', { class: 'ml-p-v', text: fmtMoney(p.output) })),
        el('span', { class: 'ml-p-unit', text: 'CNY / 1M Token' })),
      el('span', { class: 'ml-cell ml-cache' },
        el('span', { class: 'ml-c-v', text: p.cache != null ? '¥' + fmtMoney(p.cache) : '—' }),
        el('span', { class: 'ml-c-unit', text: '/ 1M' })),
      el('span', { class: 'ml-cell ml-vendor' },
        vIcon && vIcon.src ? el('img', { class: 'ml-vicon', src: vIcon.src, alt: '', width: 13, height: 13 }) : null,
        el('span', { text: vendorName || '—' })),

      el('span', { class: 'ml-cell ml-ends' },
        ends.length
          ? [...ends.slice(0, 2).map((e) => el('span', { class: 'ml-end', text: e })),
            ends.length > 2 ? el('span', { class: 'ml-more', text: '+' + (ends.length - 2) }) : null].filter(Boolean)
          : el('span', { class: 'ml-dash' }, el('i'))),
      el('span', { class: 'ml-cell ml-groups', title: groups.join(' / ') },
        shown.map((g) => el('span', { class: 'ml-gb' }, groupBadge(g))),
        restCount ? el('span', { class: 'ml-more', text: '+' + restCount }) : null))
  }

  function modelCard(m) {
    const p = priceOf(m)
    const ends = (m?.supported_endpoint_types || []).join(', ')
    // 卡片上的分组标签按「低价 → 官Key → 满血 → 功能」的档位顺序排
    const groups = (m?.enable_groups || []).slice().sort((a, b) => {
      const rank = (g) => {
        if (/官Key|官key/.test(g)) return 1
        if (/低价/.test(g)) return 0
        if (/满血/.test(g)) return 2
        const k = groupKind(g)
        return k === 'chat' ? 3 : 4 + ['image', 'video', 'audio', 'embedding'].indexOf(k)
      }
      return rank(a) - rank(b) || a.localeCompare(b, 'zh')
    })
    // 选定分组时只显示该组；「所有分组」时显示首个分组，其余折叠成 +N。
    const visibleGroups = marketGroup ? groups.filter((g) => g === marketGroup) : groups
    const shownGroups = visibleGroups.slice(0, 1)
    const more = visibleGroups.length - shownGroups.length
    const kind = marketKindOf(m)
    const on = isOn(m)
    const priceRow = p.unconfigured || p.unsupported
      ? el('p', { class: 'note', text: p.unconfigured ? '按用量计费 · 价格未配置' : '动态计费 · 请查看官网详情中的完整规则' })
      : p.entries
        ? el('div', { class: 'mc-prices one' }, p.entries.map((entry) =>
          el('div', null, el('span', { text: entry.label }), el('b', { text: money(entry.value, 'M') + (entry.max !== entry.value ? ' – ' + money(entry.max, 'M') : '') + ' / ' + entry.unit }))))
        : p.perCall !== undefined
          ? el('div', { class: 'mc-prices one' },
            el('div', null, el('span', { text: '按次计费' }), el('b', { text: money(p.perCall, 'M', !p.tiered) + ' / ' + p.perLabel })))
          : el('div', { class: 'mc-prices' },
            el('div', null, el('span', { text: '输入' }), el('b', { text: money(p.input, marketUnit) + ' / 1' + marketUnit })),
            el('div', null, el('span', { text: '输出' }), el('b', { text: money(p.output, marketUnit) + ' / 1' + marketUnit })),
            p.cache !== undefined && (!p.tiered || p.cache === 0 || p.cache !== p.input)
              ? el('div', null, el('span', { text: '缓存读取' }), el('b', { text: money(p.cache, marketUnit) + ' / 1' + marketUnit })) : null)
    const hasStatus = m.status !== undefined && m.status !== null
    const bars = el('span', { class: 'mc-bar' }, Array.from({ length: 10 }, (_, i) =>
      el('i', { class: hasStatus ? (i < Math.round((Number(m.status) || 0) / 10) ? 'ok' : 'bad') : '' })))
    return el('article', {
      class: 'mc' + (kind !== 'chat' ? ' mc-' + kind : '') + (on ? ' on' : ' off'),
      'aria-pressed': String(on),
      title: on ? '已启用 · 点一下停用' : '已停用 · 点一下启用',
      onclick: () => toggleModel(m.name),
    },
      el('div', { class: 'mc-head' },
        (() => {
          const v = (pricing()?.vendors || []).find((x) => String(x.id) === String(m.vendor_id))
          const icon = v ? vendorIconModel(v, pricing()) : null
          return icon && icon.src
            ? el('span', { class: 'mc-vicon mc-vicon-img' },
              el('img', { src: icon.src, alt: '', width: 22, height: 22, loading: 'lazy', onerror: (e) => { e.target.style.display = 'none' } }))
            : el('span', { class: 'mc-vicon', text: vendorOf(m.vendor_id).slice(0, 1) })
        })(),
        el('div', { class: 'grow' },
          el('div', { class: 'mc-name', text: m.name }),
          el('div', { class: 'mc-vendor', text: vendorOf(m.vendor_id) })),
        el('span', {
          class: 'mc-flag ' + (on ? 'on' : 'off'),
          'data-mc-flag': on ? 'on' : 'off',
        }, el('i', { class: 'mc-dot' }), el('span', { text: on ? '已启用' : '未启用' })),
        el('button', {
          class: 'mc-copy', title: '复制模型 ID',
          onclick: (e) => { e.stopPropagation(); copyModelId(m.name, e.currentTarget) },
        }, copyIcon())),
      el('p', { class: 'mc-desc', text: m.description || '暂无描述。' }),
      el('div', { class: 'mc-billing ' + (p.tiered ? 'dyn' : 'flat'), text: p.unconfigured ? '按用量计费' : p.tiered ? '动态计费' : p.perCall !== undefined ? '按次计费' : '按量计费' }),
      priceRow,
      p.currentPeriod ? el('p', { class: 'note', text: '当前时段价格' }) : null,
      el('div', { class: 'mc-line' },
        el('span', { class: 'k', text: '分组' }),
        shownGroups.map((g) => groupBadge(g)),
        more > 0 ? el('span', { class: 'mc-more', text: '+' + more }) : null),
      el('div', { class: 'mc-line' },
        el('span', { class: 'k', text: '端点' }),
        el('div', { class: 'mc-ends' }, (m?.supported_endpoint_types || []).length
          ? m.supported_endpoint_types.map((e) => el('span', { class: 'mc-end', text: e }))
          : el('span', { class: 'v', text: '—' }))),
      el('div', { class: 'mc-stats' },
        el('span', null, el('span', { class: 'k', text: '状态' }),
          el('span', { class: 'v', text: hasStatus ? Number(m.status).toFixed(2) + '%' : '—' })),
        bars,
        el('span', null, el('span', { class: 'k', text: '延迟' }),
          el('span', { class: 'v', text: m.latency || '—s' })),
        el('span', null, el('span', { class: 'k', text: '吞吐' }),
          el('span', { class: 'v', text: m.throughput || '—t/s' })),
        el('a', {
          class: 'mc-more', href: modelDetailURL(m), target: '_blank', rel: 'noreferrer',
          onclick: (e) => e.stopPropagation(),
        }, el('span', { text: '详情' }), el('span', { class: 'mc-more-arrow', text: '›' }))))
  }

  /** 官网最新版本口径：系列内代际落后量 → 主版本 → 档位 → 次版本。 */
  function versionKey(name) {
    const text = String(name || '').trim().toLowerCase()
    const match = text.match(/(\d+)(?:[.-](\d{1,2}))?/)
    if (!match) return null
    const parts = text.split(/[-_.\s]+/)
    const grades = { mythos: 10, fable: 9, opus: 8, sonnet: 7, haiku: 6, astra: 10, sol: 9, terra: 8, luna: 7, pro: 6, flash: 5 }
    return { major: Number(match[1]), minor: Number(match[2] || 0), family: parts[0].replace(/\d.*$/, ''), grade: Math.max(0, ...parts.map((part) => grades[part] || 0)) || 6 }
  }
  function byVersionDesc(a, b, newest = new Map()) {
    const x = versionKey(a.name), y = versionKey(b.name)
    if (!x || !y) return x ? -1 : y ? 1 : a.name.localeCompare(b.name)
    const ageX = Math.max(0, (newest.get(x.family) ?? x.major) - x.major)
    const ageY = Math.max(0, (newest.get(y.family) ?? y.major) - y.major)
    return ageX - ageY || y.major - x.major || y.grade - x.grade || y.minor - x.minor || a.name.localeCompare(b.name)
  }

  /** filteredModels 把搜索、分组、类型、厂商筛选叠起来。 */
  function filteredModels() {
    const p = pricing()
    if (!p) return []
    let list = p.models.slice()
    if (marketGroup) list = list.filter((m) => (m.enable_groups || []).includes(marketGroup))
    if (marketKind !== 'all') list = list.filter((m) => marketKindOf(m) === marketKind)
    if (marketQuota !== 'all') list = list.filter((m) => quotaKindOf(m) === marketQuota)
    if (marketEndpoint !== 'all') list = list.filter((m) => (m.supported_endpoint_types || []).includes(marketEndpoint))
    if (marketVendors.size) list = list.filter((m) => marketVendors.has(String(m.vendor_id)))
    const q = marketQuery.trim().toLowerCase()
    if (q) list = list.filter((m) => [m.name, vendorOf(m.vendor_id), m.description, m.tags,
      (m.enable_groups || []).join(' '), (m.supported_endpoint_types || []).join(' ')].join(' ').toLowerCase().includes(q))
    if (marketSort === 'name') return list.sort((a, b) => a.name.localeCompare(b.name))
    if (marketSort === 'price-low' || marketSort === 'price-high') {
      const value = (m) => { const p = priceOf(m); return p.perCall ?? p.entries?.[0]?.value ?? p.input }
      const values = new Map(list.map((m) => [m, value(m)]))
      const direction = marketSort === 'price-low' ? 1 : -1
      return list.sort((a, b) => {
        const x = values.get(a), y = values.get(b), knownX = Number.isFinite(x), knownY = Number.isFinite(y)
        if (knownX !== knownY) return knownX ? -1 : 1
        return (knownX ? (x - y) * direction : 0) || a.name.localeCompare(b.name)
      })
    }
    const newest = new Map()
    for (const model of list) {
      const key = versionKey(model.name)
      if (key) newest.set(key.family, Math.max(newest.get(key.family) || 0, key.major))
    }
    return list.sort((a, b) => byVersionDesc(a, b, newest))
  }

  /** refreshMarketList 只重画右侧列表，不整页 render（保住搜索框焦点）。 */
  function refreshMarketList() {
    const box = $('market-list')
    const count = $('market-count')
    if (!box) return
    const list = filteredModels()
    if (count) {
      const at = syncedAt()
      count.textContent = list.length + ' 个模型' + (at ? ' · 同步 ' + at : '')
      count.title = at ? '插件运行时每 5 分钟拉取目录，页面每分钟重载快照' : '目录来自插件写入的本地快照'
    }
    box.className = 'model-grid' + (marketLayout === 'list' ? ' as-list' : '')
    if (marketLayout === 'list') {
      const head = el('div', { class: 'ml-head' },
        ['模型', '类型', '价格', '缓存', '供应商', '端点', '分组'].map((t) => el('span', { text: t })))
      box.replaceChildren(head, ...(list.length ? list.map(modelRow) : [el('p', { class: 'note', text: '没有符合条件的模型。' })]))
      return
    }
    box.replaceChildren(...(list.length ? list.map(modelCard) : [el('p', { class: 'note', text: '没有符合条件的模型。' })]))
  }

  /** 筛选与工具条原位更新，保留侧栏节点、滚动位置及键盘焦点。 */
  function refreshMarketView() {
    const states = { mode: marketMode, unit: marketUnit, sort: marketSort, layout: marketLayout, quota: marketQuota, endpoint: marketEndpoint }
    document.querySelectorAll('.market [data-market-group], .market [data-market-kind], .market [data-market-vendor], .market [data-market-setting]').forEach((button) => {
      const d = button.dataset
      const on = d.marketGroup !== undefined ? marketGroup === d.marketGroup
        : d.marketKind !== undefined ? marketKind === d.marketKind
        : d.marketVendor !== undefined ? marketVendors.has(d.marketVendor)
        : states[d.marketSetting] === d.marketValue
      button.classList.toggle('on', on)
      button.setAttribute('aria-pressed', String(on))
    })
    // 模型启停会改变各分组的启用数：原位同步状态条、提示与档位计数，
    // 不重建侧栏节点，保留滚动位置和键盘焦点。
    const snap = pricing()
    if (snap) {
      const stats = groupEnableStats(snap)
      document.querySelectorAll('.market [data-market-group].group-chip').forEach((button) => {
        const item = groupChipModel(snap, button.dataset.marketGroup, marketGroup, stats)
        button.classList.remove('has-enabled', 'all-off')
        if (item.className.includes('has-enabled')) button.classList.add('has-enabled')
        if (item.className.includes('all-off')) button.classList.add('all-off')
        button.title = item.title
      })
      document.querySelectorAll('.market .chip-group-count[data-band-items]').forEach((node) => {
        const items = JSON.parse(node.dataset.bandItems)
        node.textContent = bandActiveCount(items, stats) + '/' + items.length
      })
    }
    paintGroupBanner()
    refreshMarketList()
  }

  /** 模型最便宜的分组：catalog 默认就按这一组路由。 */
  function cheapestGroup(m, ratios = pricing()?.groups) {
    const groups = (m?.enable_groups || []).map((g) => String(g ?? '').trim()).filter(Boolean)
    if (!groups.length) return ''
    return groups.slice().sort((a, b) => {
      const ra = Number(ratios?.[a])
      const rb = Number(ratios?.[b])
      const va = Number.isFinite(ra) && ra > 0 ? ra : 1e9
      const vb = Number.isFinite(rb) && rb > 0 ? rb : 1e9
      return va - vb || a.localeCompare(b, 'zh')
    })[0]
  }

  /**
   * disabledByGroup: 模型 → 被停用的分组集合。只记例外，默认全部分组启用。
   * 这份明细只给页面自己用（本机存储），不直接交给宿主。
   */
  const disabledByGroup = new Map()

  /**
   * hostOff: 宿主记录为「整个模型停用」的模型名。
   *
   * 宿主的模型清单没有分组这一维：`neartoken-prefs.json` 的 disabled 里出现
   * 一个模型，`HiddenModels()` 就把它整个剔出清单。所以这里单独记一份，
   * 用它在页面上把这些模型显示成全组停用。
   */
  const hostOff = new Set()

  /** 当前视图下这个模型用哪个分组判定启停：选定分组就用它，否则用最便宜那一组。 */
  function viewGroup(m) {
    return marketGroup || cheapestGroup(m)
  }

  /** 模型在当前视图分组里是否启用。 */
  function isOn(m) {
    if (hostOff.has(m?.name)) return false
    const off = disabledByGroup.get(m?.name)
    return !off || !off.has(viewGroup(m))
  }

  /** 按「分组 × 模型」的真实归属统计；启用与否按分组级状态判断。 */
  function groupEnableStats(p) {
    const out = new Map()
    for (const g of Object.keys(p?.groups || {})) out.set(g, { total: 0, enabled: 0 })
    for (const m of p?.models || []) {
      const off = disabledByGroup.get(m.name)
      for (const raw of m?.enable_groups || []) {
        const g = String(raw ?? '').trim()
        if (!g) continue
        const row = out.get(g) || { total: 0, enabled: 0 }
        row.total++
        if (!off || !off.has(g)) row.enabled++
        out.set(g, row)
      }
    }
    return out
  }

  /** 写回载荷：只放停用例外，并清掉 0.6.7 早期的大字段，避免宿主里留过期映射。 */
  function groupOptionsPayload(base, map) {
    const payload = { ...(base || {}) }
    delete payload.enabledByGroup
    payload.disabledByGroup = Object.fromEntries([...map].map(([k, v]) => [k, [...v]]))
    // 旧版「全局停用的模型」字段必须清空，否则 provider 仍按它把模型整批过滤
    payload.disabledModels = []
    return payload
  }

  /** 读回分组级停用表。明细来自本机存储；宿主的记录只有「整模型停用」。 */
  const DISABLED_KEY = 'neartoken:disabledByGroup'
  async function initDisabledByGroup() {
    disabledByGroup.clear()
    hostOff.clear()
    // 1) 本机明细：页面自己记的分组级状态（写宿主会被降级成整模型停用，见 flushDisabled）
    let local = null
    try {
      const raw = localStorage.getItem(DISABLED_KEY)
      if (raw && raw.trim()) local = JSON.parse(raw)
    } catch { local = null }
    if (typeof local === 'string' && local.trim()) {
      try { local = JSON.parse(local) } catch { local = null }
    }
    if (local && typeof local === 'object' && !Array.isArray(local)) {
      for (const [name, list] of Object.entries(local)) {
        if (!name || !Array.isArray(list)) continue
        const groups = list.map((g) => String(g ?? '').trim()).filter(Boolean)
        if (groups.length) disabledByGroup.set(String(name), new Set(groups))
      }
    }
    // 2) 宿主记录：disabled 里出现一个模型，就是「整模型停用」，没有分组维度
    try {
      const view = await bridge.call('neartoken:prefs', { op: 'get' })
      if (view && typeof view === 'object' && Array.isArray(view.disabled)) {
        for (const item of view.disabled) {
          if (!item || typeof item.model !== 'string' || !item.model) continue
          hostOff.add(item.model)
        }
      }
    } catch { /* 宿主还没有这个调用：只用本机明细 */ }
  }

  /**
   * applyHostOff 把「宿主整模型停用」展开成该模型所有分组停用。
   * 目录没加载时算不出分组，所以放在 load() 之后再调。
   */
  function applyHostOff() {
    const p = pricing()
    if (!p || !hostOff.size) return
    const models = p.models || []
    // 旧版「全不选」把每个模型的所有分组都写进了宿主 disabled，hostOff 于是覆盖全部模型。
    // 那不是正常意图（谁也不会想把 109 个模型全关掉），判为旧数据：清掉宿主记录并放开，
    // 否则侧栏分组会一直被锁成灰，连点全选都点不亮。
    if (models.length && hostOff.size >= models.length) {
      hostOff.clear()
      disabledByGroup.clear()
      bridge.call('neartoken:prefs', { op: 'set', disabled: [] }).catch(() => {})
      return
    }
    for (const name of [...hostOff]) {
      const m = models.find((x) => x.name === name)
      if (!m) continue
      const all = (m.enable_groups || []).map((g) => String(g ?? '').trim()).filter(Boolean)
      if (all.length) disabledByGroup.set(name, new Set(all))
    }
  }

  /** 官网给分组的说明；没有就返回空串，不编内容。 */
  function groupNote(p, g) {
    const n = p?.notes?.[g]
    return typeof n === 'string' ? n.trim() : ''
  }

  /** 侧栏分组 chip 的展示模型：启用状态与提示文本（说明文字走右侧横幅）。 */
  function groupChipModel(p, g, currentGroup, stats) {
    const row = stats.get(g) || { total: 0, enabled: 0 }
    const note = groupNote(p, g)
    // 没有启用模型就一律灰化：否则没有主分组模型的分组永远不带状态类，看起来「不受控制」。
    const state = row.enabled > 0 ? ' has-enabled' : ' all-off'
    const count = row.total ? '启用 ' + row.enabled + '/' + row.total + ' 个模型' : '该分组暂无模型'
    return {
      className: 'market-chip group-chip' + (currentGroup === g ? ' on' : '') + state,
      title: [note, count].filter(Boolean).join('\n'),
    }
  }

  /** 选中的分组在右侧模型区顶部显示一条横幅：标签 + 倍率 + 官网说明。 */
  function paintGroupBanner() {
    const box = document.getElementById('market-banner')
    if (!box) return
    const p = pricing()
    if (!p || !marketGroup) {
      box.hidden = true
      box.replaceChildren()
      return
    }
    const ratio = Number(p.groups?.[marketGroup]) || 0
    const note = groupNote(p, marketGroup)
    box.hidden = false
    box.replaceChildren(el('div', { class: 'market-group-banner' },
      el('div', { class: 'mgb-head' },
        groupBadge(marketGroup),
        ratio > 0 ? el('span', { class: 'ratio', text: 'x' + ratioText(ratio) }) : null),
      note ? el('p', { class: 'mgb-desc', text: note }) : null))
  }

  /** 档位头部只数「含启用模型」的分组。 */
  function bandActiveCount(items, stats) {
    return items.filter((g) => (stats.get(g)?.enabled || 0) > 0).length
  }

  /** 站点 /api/pricing 的 vendor.icon 对应包内 vendor-icons/<icon>.svg。 */
  function vendorIconModel(v, p) {
    const icon = typeof v?.icon === 'string' ? v.icon.trim() : ''
    const count = (p?.models || []).filter((m) => String(m.vendor_id) === String(v.id)).length
    return {
      src: icon ? 'vendor-icons/' + encodeURIComponent(icon) + '.svg' : '',
      fallback: icon ? '' : String(v?.name || '?').slice(0, 1),
      count,
    }
  }

  /** marketCard 是广场整页：顶部工具条 + 左筛选 + 右卡片网格。 */
  function marketCard() {
    const p = pricing()
    // 分组栏两条线，互不混：
    //   LLM（分组下的模型以对话端点为主）→ 价格档：低价 → 满血 → 官Key → 其他
    //   非 LLM（生图/视频/音频/向量端点为主）→ 功能档：图片 → 视频 → 音频 → 向量
    // 类别由 groupKind 按实际模型投票得出，站点更新目录后自动跟着变。
    // 归类时「满血」优先：带满血标签的组一律划到下面的满血档，
    // 不被 /低价/ 抢走，避免低价栏里混着满血组。
    const bandOf = (g) => {
      if (isEgg(g)) return 'egg'
      if (/官Key|官key/.test(g)) return '官Key'   // 官Key 独立档，含 [满血][官Key]
      if (/满血/.test(g)) return '满血'           // 其余带满血的划到下面
      if (/低价/.test(g)) return '低价'
      return '其他'
    }
    // 官Key 单独一档提到前面；低价在上，满血在下面；鸡蛋🥚 永远置顶
    const BAND_ORDER = ['低价', '官Key', '满血', '其他']
    const FUNC_BANDS = [['image', '图片'], ['video', '视频'], ['audio', '音频'], ['embedding', '向量']]
    const allGroups = Object.keys(p?.groups || {})
    const groupStats = groupEnableStats(p)
    const byRatio = (a, b) => (Number(p.groups[a]) || 0) - (Number(p.groups[b]) || 0) || a.localeCompare(b, 'zh')
    // 空分组也按名字归到对应档（如 [低价][满血] Gemini Ultra 属满血），
    // 不另设「暂无模型」档，避免把满血组丢到最后。
    const llmGroups = allGroups.filter((g) => groupKind(g) === 'chat')
    const funcGroups = allGroups.filter((g) => groupKind(g) !== 'chat')
    // 鸡蛋🥚 置顶：站点有就给，没有就置一个「暂无」
    const eggGroups = allGroups.filter(isEgg)
    llmGroups.splice(0, llmGroups.length, ...llmGroups.filter((g) => !isEgg(g)))
    funcGroups.splice(0, funcGroups.length, ...funcGroups.filter((g) => !isEgg(g)))
    // 供应商排序：先按指定优先级（OpenAI / Claude / Gemini / Grok / Kimi / GLM / Qwen / DeepSeek / 腾讯 / MiniMax / 小米 / 字节），其余按名称。
    const VENDOR_ORDER = [
      /openai|chatgpt/i, /anthropic|claude/i, /google|gemini/i, /xai|grok/i,
      /kimi|moonshot/i, /glm|zhipu|智谱/i, /qwen|阿里|alibaba/i, /deepseek/i,
      /腾讯|tencent/i, /minimax/i, /小米|mimo|xiaomi/i, /字节|bytedance|豆包/i,
    ]
    const vendorRank = (v) => {
      const name = String(v.name || '') + ' ' + String(v.id || '')
      for (let i = 0; i < VENDOR_ORDER.length; i += 1) if (VENDOR_ORDER[i].test(name)) return i
      return VENDOR_ORDER.length
    }
    const vendors = (p?.vendors || []).slice().sort((a, b) => {
      const d = vendorRank(a) - vendorRank(b)
      return d || String(a.name).localeCompare(String(b.name), 'zh')
    })
    const search = el('input', {
      class: 'market-search', type: 'search', placeholder: '搜索模型名称、供应商、端点或标签...',
      value: marketQuery,
      oninput: (e) => { marketQuery = e.target.value; refreshMarketList() },
    })
    const seg = (items, cur, onPick, setting) => el('div', { class: 'market-seg' },
      items.map(([k, label]) => el('button', {
        'data-market-setting': setting, 'data-market-value': k,
        'aria-pressed': String(cur === k), onclick: () => { onPick(k); refreshMarketView() },
      }, label)))
    const total = p?.models?.length || 0
    const onCount = (p?.models || []).filter((m) => isOn(m)).length
    const allOn = total > 0 && onCount >= total
    const allOff = total > 0 && onCount === 0
    const tools = el('div', { class: 'market-tools' },
      el('div', { class: 'market-seg' },
        el('button', {
          'aria-pressed': String(allOn), class: allOn ? 'on' : '',
          title: '启用全部模型', onclick: () => setAll(true),
        }, '全选'),
        el('button', {
          'aria-pressed': String(allOff), class: allOff ? 'on' : '',
          title: '停用全部模型', onclick: () => setAll(false),
        }, '全不选')),
      seg([['standard', '标准'], ['topup', '充值']], marketMode, (k) => { marketMode = k }, 'mode'),
      seg([['M', '/1M'], ['K', '/1K']], marketUnit, (k) => { marketUnit = k }, 'unit'),
      el('select', {
        class: 'market-tool market-sort', title: '排序', 'aria-label': '模型排序',
        style: 'cursor:pointer;max-width:150px',
        onchange: (e) => { marketSort = e.target.value; refreshMarketView() },
      }, [['latest', '最新版本'], ['name', '名称'], ['price-low', '价格：从低到高'], ['price-high', '价格：从高到低']].map(([value, label]) =>
        el('option', { value, selected: value === marketSort, text: label }))),
      el('div', { class: 'market-seg' },
        el('button', { 'data-market-setting': 'layout', 'data-market-value': 'grid', 'aria-pressed': String(marketLayout === 'grid'), title: '网格', onclick: () => { marketLayout = 'grid'; refreshMarketView() } }, '▦'),
        el('button', { 'data-market-setting': 'layout', 'data-market-value': 'list', 'aria-pressed': String(marketLayout === 'list'), title: '列表', onclick: () => { marketLayout = 'list'; refreshMarketView() } }, '☰')))
    // 价格档在前、功能档在后；这是列表里的「往上」，不是标签内前后权重
    const llmBands = BAND_ORDER.map((name) => ({
      name, tone: { '低价': 'low', '官Key': 'official', '满血': 'full', '其他': 'other' }[name],
      items: llmGroups.filter((g) => bandOf(g) === name)
        .sort((a, b) => seriesIdx(a) - seriesIdx(b) || byRatio(a, b)),
    })).filter((b) => b.items.length)
    const funcBands = FUNC_BANDS.map(([kind, label]) => ({
      name: label, tone: 'func',
      items: funcGroups.filter((g) => groupKind(g) === kind).sort(byRatio),
    })).filter((b) => b.items.length)
    const chipOf = (g) => {
      const ratio = Number(p.groups[g]) || 0
      const item = groupChipModel(p, g, marketGroup, groupStats)
      return el('button', {
        class: item.className,
        title: item.title, 'data-market-group': g, 'aria-pressed': String(marketGroup === g),
        onclick: () => { marketGroup = marketGroup === g ? '' : g; refreshMarketView() },
      }, groupBadge(g), ratio > 0 ? el('span', { class: 'ratio', text: 'x' + ratioText(ratio) }) : null)
    }
    const bandHead = (name, tone, items) => el('div', { class: 'chip-group-name ' + tone },
      el('span', { text: name }),
      el('span', {
        class: 'chip-group-count', 'data-band-items': JSON.stringify(items),
        text: bandActiveCount(items, groupStats) + '/' + items.length,
      }))
    const bandEl = (b) => el('div', { class: 'chip-group' },
      bandHead(b.name, b.tone, b.items),
      el('div', { class: 'market-chips' }, b.items.map(chipOf)))
    const groupChips = el('div', { class: 'market-chips' },
      el('button', {
        class: 'market-chip' + (!marketGroup ? ' on' : ''), 'data-market-group': '', 'aria-pressed': String(!marketGroup), onclick: () => { marketGroup = ''; refreshMarketView() },
      }, '所有分组'),
      // 鸡蛋🥚 永远第一档
      el('div', { class: 'chip-group' },
        bandHead('鸡蛋🥚', 'egg', eggGroups),
        el('div', { class: 'market-chips' }, eggGroups.length
          ? eggGroups.map(chipOf)
          : [el('span', { class: 'market-chip none', text: '暂无' })])),
      llmBands.map(bandEl), funcBands.map(bandEl))
    // 类型 / 供应商在有限宽度内横向堆叠（分组栏仍保持竖排）
    const kinds = el('div', { class: 'market-chips chips-row' },
      MARKET_KINDS.map(([k, label]) => el('button', {
        class: 'market-chip' + (marketKind === k ? ' on' : ''),
        'data-market-kind': k, 'aria-pressed': String(marketKind === k),
        onclick: () => { marketKind = k; refreshMarketView() },
      }, label)))
    const countOf = (predicate) => (p?.models || []).filter(predicate).length
    const chipCount = (value, label) => el('span', { class: 'vendor-count', text: String(value) })
    const quotaChips = el('div', { class: 'market-chips chips-row' },
      MARKET_QUOTA.map(([k, label]) => el('button', {
        class: 'market-chip' + (marketQuota === k ? ' on' : ''),
        'data-market-setting': 'quota', 'data-market-value': k, 'aria-pressed': String(marketQuota === k),
        onclick: () => { marketQuota = k; refreshMarketView() },
      }, el('span', { text: label }), chipCount(k === 'all' ? countOf(() => true) : countOf((m) => quotaKindOf(m) === k), label))))
    const endpointChips = el('div', { class: 'market-chips chips-row' },
      MARKET_ENDPOINTS.map(([k, label]) => el('button', {
        class: 'market-chip' + (marketEndpoint === k ? ' on' : ''),
        'data-market-setting': 'endpoint', 'data-market-value': k, 'aria-pressed': String(marketEndpoint === k),
        onclick: () => { marketEndpoint = k; refreshMarketView() },
      }, el('span', { text: label }), chipCount(k === 'all' ? countOf(() => true) : countOf((m) => (m.supported_endpoint_types || []).includes(k)), label))))
    const vendorChips = el('div', { class: 'market-chips vendor-grid' },
      vendors.map((v) => {
        const item = vendorIconModel(v, p)
        return el('button', {
          class: 'market-chip vendor-chip' + (marketVendors.has(String(v.id)) ? ' on' : ''),
          'data-market-vendor': String(v.id), 'aria-pressed': String(marketVendors.has(String(v.id))),
          onclick: () => {
            const id = String(v.id)
            if (marketVendors.has(id)) marketVendors.delete(id)
            else marketVendors.add(id)
            refreshMarketView()
          },
        },
          item.src
            ? el('img', {
              class: 'vendor-icon', src: item.src, alt: '', width: 16, height: 16, loading: 'lazy',
              onerror: (e) => { e.target.style.visibility = 'hidden' },
            })
            : el('span', { class: 'vendor-icon vendor-icon-fallback', text: item.fallback }),
          el('span', { class: 'vendor-name', text: v.name }),
          item.count > 0 ? el('span', { class: 'vendor-count', text: String(item.count) }) : null)
      }))
    // 每一节都可折叠：标题行是按钮，展开状态记在 asideOpen 里，重绘不丢。
    const asideSec = (key, title, body, openByDefault, badge) => {
      const open = asideOpen.has(key) ? asideOpen.get(key) : openByDefault
      const head = el('button', {
        class: 'aside-sec-head', 'data-sec': key, 'aria-expanded': String(open),
        onclick: (e) => {
          const node = e.currentTarget.closest('.aside-sec')
          const next = !node.classList.contains('closed')
          node.classList.toggle('closed', next)
          e.currentTarget.setAttribute('aria-expanded', String(!next))
          asideOpen.set(key, !next)
        },
      },
        el('span', { class: 'aside-sec-title', text: title }),
        badge ? el('span', { class: 'aside-sec-badge', text: badge }) : null,
        el('span', { class: 'aside-sec-chev', text: '⌄' }))
      return el('section', { class: 'aside-sec' + (open ? '' : ' closed'), 'data-sec-body': key }, head,
        el('div', { class: 'aside-sec-body' }, body))
    }
    /** 重置图标：一段圆弧加回卷箭头，和上游一致。 */
    const resetIcon = () => {
      const ns = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(ns, 'svg')
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '14'); svg.setAttribute('height', '14')
      svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2')
      svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round')
      svg.setAttribute('class', 'ma-reset-svg')
      for (const d of ['M3.5 12a8.5 8.5 0 1 0 3-6.6', 'M3 4.5v5h5']) {
        const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.appendChild(p)
      }
      return svg
    }
    const activeCount = [marketGroup, marketKind !== 'all', marketQuota !== 'all', marketEndpoint !== 'all', marketVendors.size].filter(Boolean).length
    const aside = el('aside', { class: 'market-aside' },
      el('div', { class: 'ma-head' },
        el('div', { class: 'ma-head-main' },
          el('h3', { class: 'ma-title', text: '筛选' }),
          el('p', { class: 'ma-desc', text: '按供应商、分组、类型和标签细化模型。' })),
        el('button', {
          class: 'ma-reset', title: '清空全部筛选条件',
          onclick: () => { marketQuery = ''; marketGroup = ''; marketKind = 'all'; marketQuota = 'all'; marketEndpoint = 'all'; marketVendors.clear(); search.value = ''; refreshMarketView() },
        }, resetIcon(), el('span', { text: '重置' }))),
      activeCount ? el('p', { class: 'ma-badge', text: '筛选已启用' }) : null,
      asideSec('group', '分组', groupChips, true, marketGroup ? '1' : ''),
      asideSec('kind', '类型', kinds, true, marketKind !== 'all' ? '1' : ''),
      asideSec('vendor', '供应商', vendorChips, true, marketVendors.size ? String(marketVendors.size) : ''),
      asideSec('quota', '定价类型', quotaChips, true, marketQuota !== 'all' ? '1' : ''),
      asideSec('endpoint', '端点类型', endpointChips, true, marketEndpoint !== 'all' ? '1' : ''))
    const off = new Set([...disabledByGroup.keys(), ...hostOff]).size
    const body = el('div', { class: 'market-body' },
      aside,
      el('div', { class: 'market-main' },
        el('div', { id: 'market-banner', hidden: true }),
        el('div', { class: 'market-count', id: 'market-count', text: (p?.models?.length || 0) + ' 个模型' + (syncedAt() ? ' · 同步 ' + syncedAt() : '') }),
        el('div', { class: 'model-grid', id: 'market-list' }),
        el('p', { class: 'note', text: off
          ? '已停用 ' + off + ' 个模型：某个模型的所有分组都关掉时，它会从 magpie 的模型列表隐藏；全部模型都关掉时只影响本页。点卡片可重新启用，或按「全选」。'
          : '默认全选。点卡片切换启用状态；所有分组都关掉时该模型会从 magpie 列表隐藏，全部关掉则只影响本页。' })))
    const wrap = el('section', { class: 'market' },
      el('div', { class: 'market-top' }, search, tools),
      body)
    // render 在挂载后同步填充列表，再恢复滚动，避免空列表导致页面高度瞬降。
    return wrap
  }

  /** 把时间按站点格式打印：YYYY-MM-DD HH:mm:ss */
  function fmtDT(d) {
    const p = (n) => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  }
  /** 当天 0 点。 */
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
  /** 当前日志区间；没设过就是今天 0 点到现在。 */
  function logRange() {
    const to = logTo ? new Date(logTo) : new Date()
    const from = logFrom ? new Date(logFrom) : startOfDay(to)
    return { from, to }
  }
  /** 区间折算成站点用量端点认识的粒度。 */
  function logSpan() {
    const { from, to } = logRange()
    const days = (to - from) / 86400000
    return days <= 1.2 ? 'day' : days <= 8 ? 'week' : 'month'
  }

  /** 使用日志：筛选条 + 统计条 + 明细表；日期用可用弹层选。 */
  function logsCard() {
    const range = logRange()
    const span = logSpan()
    const data = windows.get(span)
    const asInput = (d) => { const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) }
    const applyRange = () => {
      const f = document.getElementById('lg-from')
      const t = document.getElementById('lg-to')
      if (f && f.value) logFrom = new Date(f.value)
      if (t && t.value) logTo = new Date(t.value)
      logCalOpen = false
      windows.delete('day'); windows.delete('week'); windows.delete('month')
      load().catch(() => {})
      render()
    }
    const preset = (days) => {
      const to = new Date()
      const from = days === 0 ? startOfDay(to) : new Date(to.getTime() - (days - 1) * 86400000)
      if (days > 0) from.setHours(0, 0, 0, 0)
      logFrom = from
      logTo = to
      logCalOpen = false
      windows.delete('day'); windows.delete('week'); windows.delete('month')
      load().catch(() => {})
      render()
    }
    const calPop = logCalOpen ? el('div', { class: 'lg-cal' },
      el('div', { class: 'lg-cal-presets' },
        el('button', { onclick: () => preset(0) }, '今天'),
        el('button', { onclick: () => preset(7) }, '近 7 天'),
        el('button', { onclick: () => preset(30) }, '近 30 天'),
        el('button', { onclick: () => preset(90) }, '近 90 天')),
      el('div', { class: 'lg-cal-fields' },
        el('label', null, el('span', { text: '开始' }),
          el('input', { id: 'lg-from', type: 'datetime-local', value: asInput(range.from) })),
        el('label', null, el('span', { text: '结束' }),
          el('input', { id: 'lg-to', type: 'datetime-local', value: asInput(range.to) }))),
      el('div', { class: 'lg-cal-actions' },
        el('button', { class: 'ghost', onclick: () => { logCalOpen = false; render() } }, '取消'),
        el('button', { class: 'primary', onclick: applyRange }, '应用'))) : null

    const rangeField = el('div', { class: 'lg-range' },
      el('button', {
        class: 'lg-range-btn' + (logCalOpen ? ' open' : ''), 'aria-expanded': String(logCalOpen),
        title: '选择时间范围',
        onclick: (e) => { e.stopPropagation(); logCalOpen = !logCalOpen; render() },
      },
        el('span', { class: 'lg-ico', text: '▦' }),
        el('span', { class: 'lg-range-text', text: fmtDT(range.from) + ' ~ ' + fmtDT(range.to) })),
      calPop)

    // 原站的自定义下拉：触发器 + 浮层，选中项带 ✓，可带「已弃用」徽标
    // 原站下拉右端是「上箭头 + 下箭头」两个小三角，不是单个 ⌄
    const refreshIcon = () => {
      const ns = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(ns, 'svg')
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '14'); svg.setAttribute('height', '14')
      svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2')
      svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round')
      for (const d of ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7']) {
        const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.appendChild(p)
      }
      return svg
    }
    const keyIcon = () => {
      const ns = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(ns, 'svg')
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '13'); svg.setAttribute('height', '13')
      svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.9')
      svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round')
      // 站点用的是「圆形钥匙头 + 短柄」：一个圆 + 一条斜柄
      for (const d of ['M15.5 8.5a4 4 0 1 1-5.66-5.66 4 4 0 0 1 5.66 5.66z', 'M10.6 10.6 4 17.2', 'M4 17.2v3h3', 'M15.2 5.2h.01']) {
        const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.appendChild(p)
      }
      return svg
    }
    /** 模型前的厂商 logo：按 vendor_id 找本地品牌图标；找不到就用首字母块。 */
    const modelIcon = (name) => {
      const p = pricing()
      const snap = (p?.models || []).find((x) => x.name === name)
      const v = snap ? (p?.vendors || []).find((x) => String(x.id) === String(snap.vendor_id)) : null
      const item = v ? vendorIconModel(v, p) : null
      if (item && item.src) return el('img', { class: 'lg-mico', src: item.src, alt: '', width: 14, height: 14, loading: 'lazy', onerror: (e) => { e.target.style.display = 'none' } })
      return el('span', { class: 'lg-mico lg-mico-fb', text: (name || '?').slice(0, 1).toUpperCase() })
    }
    const eyeIcon = (off) => {
      const ns = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(ns, 'svg')
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16')
      svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8')
      svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round')
      const paths = off
        ? ['M3 3l18 18', 'M10.6 10.6a2 2 0 0 0 2.8 2.8', 'M9.9 5.2A9.9 9.9 0 0 1 12 5c5 0 9 4.5 10 7-.4 1-1.4 2.5-2.8 3.8', 'M6.1 6.1C3.9 7.6 2.5 9.7 2 12c1 2.5 5 7 10 7 1.4 0 2.7-.3 3.9-.9']
        : ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z']
      for (const d of paths) { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.appendChild(p) }
      return svg
    }
    const chev = () => el('span', { class: 'lg-chev', 'aria-hidden': 'true' }, el('i'), el('i'))
    const menu = (id, label, items, value, onPick, opts = {}) => {
      const open = logMenu === id
      return el('div', { class: 'lg-menu-wrap' + (opts.grow ? ' grow' : '') },
        el('button', {
          class: 'lg-trigger' + (open ? ' open' : ''), 'aria-expanded': String(open),
          onclick: (e) => { e.stopPropagation(); logMenu = open ? '' : id; render() },
        }, el('span', { class: 'lg-trigger-text', text: label }), chev()),
        open ? el('div', { class: 'lg-menu' + (opts.wide ? ' wide' : '') },
          opts.title ? el('div', { class: 'lg-menu-title', text: opts.title }) : null,
          el('div', { class: 'lg-menu-list' }, items.map(([val, text, badge]) => el('button', {
            class: 'lg-menu-item' + (opts.multi ? (opts.isOn && opts.isOn(val) ? ' sel' : '') : (val === value ? ' sel' : '')),
            onclick: (e) => { e.stopPropagation(); onPick(val); if (!opts.multi) logMenu = ''; render() },
          }, el('span', { class: 'lg-menu-label', text }),
            badge ? el('span', { class: 'lg-menu-badge', text: badge }) : null,
            (opts.multi ? (opts.isOn && opts.isOn(val)) : (val === value)) ? el('span', { class: 'lg-check', text: '✓' }) : null))) ) : null)
    }
    const kindLabel = (LOG_KINDS.find(([v]) => v === logKind) || LOG_KINDS[0])[1]
    const colMenuItems = LOG_COLS.map(([k, label]) => [k, label])

    const toolbar = el('div', { class: 'lg-bar' },
      rangeField,
      el('input', {
        class: 'lg-input', type: 'search', placeholder: '模型名称', value: logQuery,
        oninput: (e) => { logQuery = e.target.value },
        onkeydown: (e) => { if (e.key === 'Enter') render() },
      }),
      menu('group', logGroup || '分组', [['', '全部分组']].concat(Object.keys(pricing()?.groups || {}).sort((a, b) => a.localeCompare(b, 'zh')).map((g) => [g, g])), logGroup, (v) => { logGroup = v }),
      menu('kind', kindLabel, LOG_KINDS.map(([v, t, b]) => [v, t, b]), logKind, (v) => { logKind = v }),
      el('button', {
        class: 'lg-btn outline lg-expand' + (logMore ? ' open' : ''), title: '展开或收起更多筛选',
        'aria-expanded': String(logMore), onclick: () => { logMore = !logMore; render() },
      }, el('span', { text: logMore ? '收起' : '展开' }), el('span', { class: 'lg-chev single', 'aria-hidden': 'true' }, el('i'))))

    // 宿主若给出逐条流水（data.rows），按上游 9 列完整渲染；否则退回按模型汇总。
    // 逐条流水优先取插件写下的 page/logs.js（宿主代取站点日志）；
    // 宿主 neartoken:usage 若也给了 rows，则退而用它。
    const liveLogs = self.NEARTOKEN_LOGS
    const detailRows = Array.isArray(liveLogs?.rows) && liveLogs.rows.length
      ? liveLogs.rows
      : Array.isArray(data?.rows) ? data.rows : null
    const colIdx = { token: 2, model: 3, flow: 4, tokenCount: 5, bytes: 6, cost: 7, time: 8, detail: 9 }
    const hiddenClass = Object.entries(colIdx).filter(([k]) => !logCols.has(k)).map(([, n]) => 'hide-c' + n).join(' ')
    /** 空值横线：用 CSS 画，几何中心与数字中线一致（em dash 的字形墨迹偏低）。 */
    const dash = (cls) => el('span', { class: 'lg-dash' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' }, el('i'))
    /** secs 秒数带单位：4.5 → 4.5s，整数也留一位小数。 */
    const secs = (v) => {
      const n = Number(v)
      if (!Number.isFinite(n)) return '—'
      return n.toFixed(1) + 's'
    }
    const fmtNum = (n) => {
      const v = Number(n)
      if (!Number.isFinite(v)) return '—'
      return v.toLocaleString('en-US')
    }
    const fmtBytes = (n) => {
      const v = Number(n) || 0
      if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB'
      if (v >= 1024) return (v / 1024).toFixed(1) + ' KB'
      return Math.round(v) + ' B'
    }
    const moreRow = logMore ? el('div', { class: 'lg-bar lg-bar-more' },
      el('input', { class: 'lg-input', type: 'search', placeholder: '令牌名称', value: logTokenName, oninput: (e) => { logTokenName = e.target.value } }),
      el('input', { class: 'lg-input', type: 'search', placeholder: '请求 ID', value: logRequestId, oninput: (e) => { logRequestId = e.target.value } }),
      el('input', { class: 'lg-input', type: 'search', placeholder: '上游请求 ID', value: logUpRequestId, oninput: (e) => { logUpRequestId = e.target.value } })) : null

    const pageCount = (n) => Math.max(1, Math.ceil(n / logPageSize))
    const pageSlice = (list) => list.slice((logPage - 1) * logPageSize, logPage * logPageSize)
    const pagerBar = (totalCount) => el('div', { class: 'lg-pager' },
      el('span', { class: 'lg-total', text: '总计：' + totalCount }),
      el('span', { class: 'lg-pagesize-label', text: '每页行数' }),
      el('div', { class: 'lg-menu-wrap' },
        el('button', {
          class: 'lg-trigger lg-pagesize', 'aria-expanded': String(logMenu === 'pagesize'),
          onclick: (e) => { e.stopPropagation(); logMenu = logMenu === 'pagesize' ? '' : 'pagesize'; render() },
        }, el('span', { class: 'lg-trigger-text', text: String(logPageSize) }), chev()),
        logMenu === 'pagesize' ? el('div', { class: 'lg-menu small up' },
          el('div', { class: 'lg-menu-list' }, [10, 20, 30, 40, 50, 100].map((v) => el('button', {
            class: 'lg-menu-item' + (v === logPageSize ? ' sel' : ''),
            onclick: (e) => { e.stopPropagation(); logPageSize = v; logPage = 1; logMenu = ''; render() },
          }, el('span', { class: 'lg-menu-label', text: String(v) }), v === logPageSize ? el('span', { class: 'lg-check', text: '✓' }) : null)))) : null),
      el('button', { class: 'lg-btn icon-btn', title: '第一页', disabled: logPage <= 1, onclick: () => { if (logPage > 1) { logPage = 1; render() } } }, '«'),
      el('button', { class: 'lg-btn icon-btn', title: '上一页', disabled: logPage <= 1, onclick: () => { if (logPage > 1) { logPage -= 1; render() } } }, '‹'),
      el('span', { class: 'lg-page-pill', text: String(logPage) }),
      el('button', { class: 'lg-btn icon-btn', title: '下一页', disabled: logPage >= pageCount(totalCount), onclick: () => { if (logPage < pageCount(totalCount)) { logPage += 1; render() } } }, '›'),
      el('button', { class: 'lg-btn icon-btn', title: '最后一页', disabled: logPage >= pageCount(totalCount), onclick: () => { logPage = pageCount(totalCount); render() } }, '»'))

    const all = (data?.models || []).slice().sort((a, b) => b.tokens - a.tokens)
    const total = all.reduce((sum, m) => sum + m.tokens, 0) || 1
    const q = logQuery.trim().toLowerCase()
    let rows = q ? all.filter((m) => String(m.model).toLowerCase().includes(q)) : all
    if (logKind !== 'all') rows = rows.filter((m) => {
      const snap = (pricing()?.models || []).find((x) => x.name === m.model)
      return snap ? marketKindOf(snap) === logKind : logKind === 'chat'
    })
    if (logGroup) rows = rows.filter((m) => {
      const snap = (pricing()?.models || []).find((x) => x.name === m.model)
      return snap && (snap.enable_groups || []).includes(logGroup)
    })

    const statbar = el('div', { class: 'lg-stats' },
      el('div', { class: 'lg-chips' },
        el('span', { class: 'lg-chip' }, el('i', { class: 'lg-dot blue' }), '用量 ', el('b', { text: data?.spent || '¥0' })),
        el('span', { class: 'lg-chip' }, el('i', { class: 'lg-dot red' }), 'RPM ', el('b', { text: '0' })),
        el('span', { class: 'lg-chip' }, el('i', { class: 'lg-dot blue' }), 'TPM ', el('b', { text: compact(data?.tokens || 0) }))),
      el('div', { class: 'lg-actions' },
        el('div', { class: 'lg-menu-wrap' },
          el('button', {
            class: 'lg-btn bordered' + (logInterval > 0 ? ' on' : ''), title: '自动刷新间隔',
            'aria-expanded': String(logMenu === 'interval'),
            onclick: (e) => { e.stopPropagation(); logMenu = logMenu === 'interval' ? '' : 'interval'; render() },
          }, el('span', { class: 'spin' + (logBusy ? ' spinning' : '') }, refreshIcon()), el('span', { text: ' ' + (logInterval > 0 ? logInterval + 's' : '关闭') }), chev()),
          logMenu === 'interval' ? el('div', { class: 'lg-menu small' },
            el('div', { class: 'lg-menu-title', text: '自动刷新已' + (logInterval > 0 ? '开启' : '关闭') }),
            el('div', { class: 'lg-menu-list' }, [[0, '关闭'], [5, '5s'], [10, '10s'], [30, '30s'], [60, '60s']].map(([val, text]) => el('button', {
              class: 'lg-menu-item' + (val === logInterval ? ' sel' : ''),
              onclick: (e) => { e.stopPropagation(); setLogInterval(val); logMenu = ''; render() },
            }, el('span', { class: 'lg-menu-label', text }), val === logInterval ? el('span', { class: 'lg-check', text: '✓' }) : null))) ) : null),
        el('button', {
          class: 'lg-btn icon-btn' + (logPrivate ? ' on' : ''),
          title: logPrivate ? '显示敏感信息' : '隐藏敏感信息',
          'aria-pressed': String(logPrivate),
          onclick: () => { logPrivate = !logPrivate; render() },
        }, eyeIcon(logPrivate)),
        el('button', {
          class: 'lg-btn primary',
          onclick: (e) => {
            const btn = e.currentTarget
            btn.classList.add('searching')
            refreshUsage(true).finally(() => setTimeout(() => btn.classList.remove('searching'), 500))
          },
        }, '搜索'),
        el('button', { class: 'lg-btn outline', onclick: () => { logQuery = ''; logGroup = ''; logKind = 'all'; logFrom = null; logTo = null; windows.clear(); load().catch(() => {}); render() } }, '重置'),
        el('a', {
          class: 'lg-btn outline', title: '在官网查看完整日志',
          href: 'https://neartoken.cc/usage-logs/common?aff=0mY4', target: '_blank', rel: 'noopener noreferrer',
          style: 'text-decoration:none;display:inline-flex;align-items:center',
        }, '在官网打开'),
        el('div', { class: 'lg-menu-wrap right' },
          el('button', {
            class: 'lg-btn outline', 'aria-expanded': String(logMenu === 'cols'),
            onclick: (e) => { e.stopPropagation(); logMenu = logMenu === 'cols' ? '' : 'cols'; render() },
          }, el('span', { text: '查看' }), chev()),
          logMenu === 'cols' ? el('div', { class: 'lg-menu' },
            el('div', { class: 'lg-menu-title', text: '切换列' }),
            el('div', { class: 'lg-menu-list' }, colMenuItems.map(([val, text]) => el('button', {
              class: 'lg-menu-item sel',
              onclick: (e) => {
                e.stopPropagation()
                if (logCols.has(val)) logCols.delete(val); else logCols.add(val)
                render()
              },
            }, el('span', { class: 'lg-menu-label', text }), el('span', { class: 'lg-check', text: logCols.has(val) ? '✓' : '' })))) ) : null)))

    if (!data) {
      return el('section', { class: 'logs' },
        el('h2', { class: 'logs-title', text: '通用日志' }), toolbar, statbar,
        el('p', { class: 'note', text: '正在读取用量…' }))
    }
    if (!data.available) {
      return el('section', { class: 'logs' },
        el('h2', { class: 'logs-title', text: '通用日志' }), toolbar, statbar,
        el('p', { class: 'note warn', text: data.reason === 'unreachable' ? '暂时读不到站点的用量数据。' : '站点未提供用量统计。' }))
    }

    // 只有插件真的写入过流水（at > 0）才算「有逐条数据源」。
    // 占位文件是 { at: 0, rows: [] }，把它当成空窗口会让页面永远显示「没有逐条记录」。
    const liveAt = Number(liveLogs?.at) || 0
    const liveRows = Array.isArray(liveLogs?.rows) ? liveLogs.rows : null
    const hasLiveSource = liveAt > 0 && !!liveRows
    if (hasLiveSource && liveRows.length === 0) {
      return el('section', { class: 'logs' },
        el('h2', { class: 'logs-title', text: '通用日志' }),
        el('div', { class: 'logs-panel' },
          toolbar, moreRow, statbar,
          el('div', { class: 'lg-table-wrap' }, el('p', { class: 'lg-empty', text: '这个窗口没有逐条记录。' })),
          pagerBar(0)),
        el('p', { class: 'note', text: '插件已连上站点日志接口，当前时间窗口没有记录。' }))
    }

    if (detailRows && detailRows.length) {
      const colsD = ['时间', '令牌', '模型', '流', 'Token', '请求体大小', '费用', '耗时', '详情']
      const pageRowsD = pageSlice(detailRows)
      const body = pageRowsD.map((r) => el('div', { class: 'lg-row' },
        el('span', { class: 'lg-cell-stack' },
          el('span', { text: String(r.time || '') }),
          el('span', { class: 'lg-tag ok', text: r.kind || '消耗' })),
        el('span', { class: 'lg-cell-stack' },
          el('span', {
            class: 'lg-pill lg-copyable', title: '点击复制令牌名称',
            onclick: (e) => { e.stopPropagation(); copyModelId(r.tokenName || '', e.currentTarget) },
          }, keyIcon(), el('span', { text: logPrivate ? '••••' : (r.tokenName || '—') })),
          r.group ? el('span', { class: 'lg-group' }, groupBadge(r.group, groupRatioOf(r.group))) : null),
        el('span', { class: 'lg-cell-stack' },
          el('span', { class: 'lg-model-row' },
            el('span', {
              class: 'lg-model lg-model-tap', title: '点击查看模型映射',
              onclick: (e) => {
                e.stopPropagation()
                if (mapOpen.has(r)) mapOpen.delete(r); else mapOpen.add(r)
                render()
              },
            }, modelIcon(r.model), el('span', { text: r.model || '—' })),
            r.upModel || r.respModel ? el('button', {
              class: 'lg-map' + (mapOpen.has(r) ? ' on' : ''), title: '查看模型映射',
              onclick: (e) => { e.stopPropagation(); if (mapOpen.has(r)) mapOpen.delete(r); else mapOpen.add(r); render() },
            }, mapIcon()) : null),
          r.effort ? el('span', { class: 'lg-effort', text: r.effort }) : null,
          // 映射面板做成浮层：绝对定位，不占列宽，避免被窄列挤成竖排
          mapOpen.has(r) ? el('div', { class: 'lg-map-pop' },
            el('div', { class: 'lg-map-title', text: '模型映射' }),
            [['请求模型', r.model], ['上游请求模型', r.upModel], ['响应模型', r.respModel]].map(([k, v]) =>
              el('div', { class: 'lg-map-row' }, el('span', { class: 'lg-map-k', text: k }), el('span', { class: 'lg-map-v', text: v || '—' }))) ) : null),
        el('span', { class: 'lg-cell-stack' },
          el('span', { class: 'lg-flow' + (r.isStream === false ? ' off' : ''), text: r.isStream === false ? '非流' : '流' }),
          el('span', { class: 'lg-sub' }, r.tps ? el('span', { text: r.tps + ' t/s' }) : dash('sm'))),
        el('span', { class: 'lg-cell-stack' },
          el('span', { class: 'num', text: (r.input != null ? fmtNum(r.input) : '—') + ' / ' + (r.output != null ? fmtNum(r.output) : '—') }),
          r.cache != null && Number(r.cache) > 0
            ? el('span', { class: 'lg-sub', text: '缓存 ' + fmtNum(r.cache) })
            : null),
        el('span', { class: 'num' }, r.bytes != null ? fmtBytes(r.bytes) : dash()),
        el('span', { class: 'lg-cell-stack' },
          el('span', { class: 'lg-pill lg-cost', text: logPrivate ? '••••' : (r.cost || '—') })),
        el('span', { class: 'lg-cell-stack lg-time' },
          el('span', null, '首字 ', r.ttft ? el('b', { text: secs(r.ttft) }) : dash('in')),
          el('span', null, '耗时 ', r.dur ? el('b', { text: secs(r.dur) }) : dash('in'))),
        el('span', { class: 'lg-detail' }, r.detail || dash())))
      return el('section', { class: 'logs' },
        el('h2', { class: 'logs-title', text: '通用日志' }),
        el('div', { class: 'logs-panel' },
          toolbar, moreRow, statbar,
          el('div', { class: 'lg-table-wrap' }, el('div', { class: 'lg-table ' + hiddenClass },
            el('div', { class: 'lg-row head' }, colsD.map((c) => el('span', { text: c }))), body)),
          pagerBar(detailRows.length)),
        el('p', { class: 'note', text: '数据来自站点逐条日志。' }))
    }

    const cols = ['时间', '令牌', '模型', '流', 'Token', '请求体大小', '费用', '耗时', '详情']
    const table = el('div', { class: 'lg-table ' + hiddenClass },
      el('div', { class: 'lg-row head' }, cols.map((c) => el('span', { text: c }))),
      pageSlice(rows).length ? pageSlice(rows).map((m) => {
        const snap = (pricing()?.models || []).find((x) => x.name === m.model)
        const group = snap ? cheapestGroup(snap) : ''
        const effort = snap && marketKindOf(snap) === 'chat' ? 'High' : ''
        return el('div', { class: 'lg-row' },
        el('span', { class: 'lg-cell-stack' },
          el('span', { class: 'lg-strong', text: fmtDT(range.to).slice(0, 16) }),
          el('span', { class: 'lg-tag ok', text: '消耗' })),
        el('span', { class: 'lg-cell-stack' },
          el('span', {
            class: 'lg-pill lg-copyable', title: '点击复制令牌名称',
            onclick: (e) => { e.stopPropagation(); copyModelId(view.tokenName || '', e.currentTarget) },
          }, keyIcon(), el('span', { text: logPrivate ? '••••' : (view.tokenName || '—') })),
          group ? el('span', { class: 'lg-gb' }, groupBadge(group, groupRatioOf(group))) : null),
        el('span', { class: 'lg-cell-stack' },
          el('span', { class: 'lg-pill lg-model-pill', title: m.model }, modelIcon(m.model), el('span', { text: m.model })),
          effort ? el('span', { class: 'lg-effort', text: effort }) : null),
        el('span', { class: 'lg-cell-stack' },
          el('span', { class: 'lg-flow', text: '流' }),
          el('span', { class: 'lg-sub' }, dash('sm'))),
        el('span', { class: 'lg-strong num', text: fmtNum(m.tokens) }),
        el('span', { class: 'lg-strong num' }, dash()),
        el('span', { class: 'lg-cell-stack' },
          el('span', { class: 'lg-pill lg-cost', text: logPrivate ? '••••' : (m.costText || '—') })),
        el('span', { class: 'lg-cell-stack lg-time' },
          el('span', { class: 'lg-bar-green' }, '首字 ', dash('in')),
          el('span', { class: 'lg-bar-green' }, '耗时 ', dash('in'))),
        el('span', { class: 'lg-detail' }, dash()))
      })
        : el('div', { class: 'lg-empty', text: '这个筛选下没有记录。' }))

    const dist = logExpanded ? el('div', { class: 'lg-dist' },
      rows.slice(0, 8).map((m, i2) => el('div', { class: 'lg-dist-row' },
        el('div', { class: 'lg-dist-name', title: m.model, text: m.model }),
        el('div', { class: 'lg-dist-track' },
          el('i', { style: 'width:' + Math.max(2, Math.round((m.tokens / total) * 100)) + '%;background:' + ['#5b8def', '#43b8a4', '#9b7ce0', '#54b26a', '#e0a44a', '#d47a9a', '#6fa8d6', '#c08bd0'][i2 % 8] })),
        el('div', { class: 'lg-dist-val', text: compact(m.tokens) + ' · ' + Math.round((m.tokens / total) * 100) + '%' })))) : null

    // 没有逐条数据源时说清原因：插件还没拿到凭据 / 接口失败 / 站点没给
    const meta = self.NEARTOKEN_LOGS_META
    const why = (() => {
      if (hasLiveSource) return ''
      if (!meta || !meta.at) return '逐条流水还没写入：插件尚未拿到站点凭据（宿主调用余额或发一次请求后会自动补齐）。'
      if (meta.ok === false) return '逐条流水读取失败：' + (meta.error || '未知原因') + '。'
      if (meta.stage === 'no-key') return '逐条流水还没写入：插件尚未拿到站点凭据。'
      return '逐条流水为空：站点这条令牌暂时没有记录。'
    })()
    return el('section', { class: 'logs' },
      el('h2', { class: 'logs-title', text: '通用日志' }),
      el('div', { class: 'logs-panel' },
        toolbar, moreRow, statbar,
        el('div', { class: 'lg-table-wrap' }, table),
        pagerBar(rows.length)),
      el('p', { class: 'note', text: why || '数字来自站点用量端点，按模型汇总；站点未提供逐条流水，故「流 / 请求体大小 / 耗时」留空。' }))
  }

  /** toggleModel 只翻转「当前视图分组」里的启用状态，同一模型在别组不受影响。 */
  async function toggleModel(name) {
    const m = pricing()?.models.find((x) => x.name === name)
    if (!m) return
    const g = viewGroup(m)
    if (!g) return
    // 选定分组时，只对真正属于该组的模型生效，避免把模型不存在的组记进停用表
    if (marketGroup && !(m.enable_groups || []).includes(marketGroup)) return
    const off = new Set(disabledByGroup.get(name) || [])
    const blocked = hostOff.has(name)
    if (blocked || off.has(g)) {
      // 现在显示为关 → 打开：先解除宿主的「整模型停用」，再打开当前分组
      hostOff.delete(name)
      off.delete(g)
    } else {
      off.add(g)
    }
    if (off.size) disabledByGroup.set(name, off)
    else disabledByGroup.delete(name)
    refreshMarketView()
    await saveDisabled()
  }

  /**
   * setAll 全选 / 全不选。
   *
   * 两侧必须说同一件事，否则会出现「卡片未启用、侧栏分组还亮着」：
   *   · 全选   = 清空所有停用记录，卡片与分组一起点亮；
   *   · 全不选 = 每个模型的所有分组都关掉，卡片与分组一起变灰。
   *
   * 「全不选」不把这张全灰表交给宿主：宿主没有分组维度，收到 109 条就等于
   * 把整张模型表清空，供应商会从 magpie 列表里消失——那是「看不见」，不是
   * 「停用」。写入侧的上限保护见 flushDisabled。
   */
  async function setAll(enable) {
    const p = pricing()
    if (!p) return
    if (enable) {
      disabledByGroup.clear()
      hostOff.clear()
      render()
      await saveDisabled()
      return
    }
    for (const m of p.models) {
      const all = (m.enable_groups || []).map((g) => String(g ?? '').trim()).filter(Boolean)
      if (!all.length) continue
      disabledByGroup.set(m.name, new Set(all))
    }
    hostOff.clear()
    render()
    await saveDisabled()
  }

  /**
   * hostPayload 算出要交给宿主的停用清单。
   *
   * 宿主按「模型」隐藏（没有分组维度），所以只交「所有分组都停用」的模型。
   * 若全部模型都被关掉，整体交空表：空表会让供应商从 magpie 列表消失，
   * 那种「看不见」比「停用」更难恢复，因此全灰只留在本页。
   */
  function hostPayload(plain, models) {
    const out = []
    let total = 0
    for (const m of models || []) {
      const name = m?.name
      if (!name) continue
      total++
      const all = (m.enable_groups || []).map((g) => String(g ?? '').trim()).filter(Boolean)
      if (!all.length) continue
      const off = plain[name]
      if (!Array.isArray(off)) continue
      if (all.every((g) => off.includes(g))) out.push({ model: name, groups: all })
    }
    if (total && out.length >= total) return { disabled: [], allOff: true }
    return { disabled: out, allOff: false }
  }

  /**
   * saveDisabled 把启用状态落盘：分组明细写本机，整模型停用写宿主。
   *
   * 宿主的模型清单没有分组维度——disabled 里出现一个模型就整个剔出清单。
   * 所以交给宿主的只有「所有分组都停用」的模型；全部模型都被关掉时交空表，
   * 那种「全灰」只留在本页（见 hostPayload）。
   */
  let saveTimer = null
  async function flushDisabled() {
    const plain = Object.fromEntries([...disabledByGroup].map(([k, v]) => [k, [...v]]))
    // 本机永远存全量明细：只有页面自己需要分组粒度
    try {
      localStorage.setItem(DISABLED_KEY, JSON.stringify(plain))
    } catch { /* 存不下就只保留本次会话的状态 */ }
    const { disabled } = hostPayload(plain, pricing()?.models || [])
    try {
      await bridge.call('neartoken:prefs', { op: 'set', disabled })
      lastError = ''
    } catch { /* 宿主没有这个调用：本机明细已经够页面用 */ }
  }
  function saveDisabled() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveTimer = null; flushDisabled() }, 1150)
  }

  /** ratioText 是倍率的写法：0.1 → 0.1，1 → 1。 */
  function ratioText(v) {
    return String(Math.round(v * 10000) / 10000)
  }


  // ---------- 交互 ----------

  async function switchSpan(key) {
    if (span === key) return
    span = key
    if (!windows.has(key)) {
      render()
      try {
        windows.set(key, await call('neartoken:usage', { range: key }))
      } catch (error) {
        showError(error)
      }
    }
    render()
  }

  async function pay(method) {
    const amount = pick.amount || Number(pick.custom || 0)
    if (!amount) { showError('先选一个金额，或自己填一个。'); return }
    if (!method) { showError('站点没有可用的收款方式。'); return }
    await act('创建订单', async () => {
      const result = await call('neartoken:topup', { amount, paymentMethod: method })
      const hint = $('copy-hint')
      if (hint && result && result.opened === false && result.url) {
        hint.textContent = '没自动打开浏览器，请手动打开：' + result.url
      }
      await new Promise((r) => setTimeout(r, 300))
      return null
    })
  }

  /** 复制模型 ID：优先剪贴板 API，受限时回退 textarea + execCommand，并给按钮即时反馈。 */
  /** toast 在页面顶部弹一条提示，2 秒后自动消失。 */
  let toastTimer = null
  function toast(message, bad = false) {
    let box = document.getElementById('nt-toast')
    if (!box) {
      box = document.createElement('div')
      box.id = 'nt-toast'
      document.body.appendChild(box)
    }
    box.className = 'nt-toast' + (bad ? ' bad' : '') + ' show'
    box.replaceChildren(
      el('span', { class: 'nt-toast-icon', text: bad ? '!' : '✓' }),
      el('span', { class: 'nt-toast-text', text: message }))
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { box.classList.remove('show') }, 2000)
  }

  async function copyModelId(text, btn) {
    let ok = false
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch (_) {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.top = '-1000px'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        ta.setSelectionRange(0, text.length)
        ok = document.execCommand('copy')
        ta.remove()
      } catch (_e) {
        ok = false
      }
    }
    if (ok) toast('已复制到剪贴板')
    else toast('复制失败，请手动复制', true)
    // 反馈统一走页面顶部 toast，按钮本身不叠加任何徽标或变色
    if (btn) btn.title = (ok ? '已复制 ' : '复制失败，请手动复制 ') + text
    return ok
  }

  async function copy(text) {
    const hint = $('copy-hint')
    try {
      await navigator.clipboard.writeText(text)
      if (hint) hint.textContent = '链接已复制。'
    } catch (_) {
      if (hint) hint.textContent = '复制不了，请手动选中这一行：' + text
      selectCode()
    }
  }

  function selectCode() {
    const node = $('user-code')
    if (!node) return
    const range = document.createRange()
    range.selectNodeContents(node)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  }

  function paintCountdown() {
    const node = $('countdown')
    if (!node || !view || !view.pending) return
    const left = Math.max(0, view.pending.expiresAt - Date.now())
    const m = Math.floor(left / 60000)
    const s = Math.floor((left % 60000) / 1000)
    node.textContent = '还剩 ' + m + ':' + String(s).padStart(2, '0')
  }

  $('disconnect').addEventListener('click', () => {
    act('断开连接', () => call('neartoken:disconnect'))
  })

  // ---------- 检查更新 ----------

  /** cmp 比两段版本号：a 比 b 新返回正数。只认数字段，够用了。 */
  function cmpVersion(a, b) {
    const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0)
    const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const d = (pa[i] || 0) - (pb[i] || 0)
      if (d) return d
    }
    return 0
  }

  /**
   * loadLatest 取 npm 上的最新版本。
   *
   * 页面自己查不了，插件会把结果写成 page/latest.js；这里用 script 引入，
   * 加 ?t= 破缓存，所以点一次「检查更新」就是现问一次。
   */
  function loadLatest() {
    return new Promise((resolve) => {
      const s = document.createElement('script')
      s.src = 'latest.js?t=' + Date.now()
      s.onload = () => resolve(typeof self.NEARTOKEN_LATEST === 'string' ? self.NEARTOKEN_LATEST : '')
      s.onerror = () => resolve('')
      document.head.append(s)
    })
  }

  /**
   * 自动热重载：定时读 page/latest.js 比对版本，发现比当前新就把本页带破缓存参数重载。
   * 这样插件不需要「检查更新」按钮，装上新版本后页面会自己换过去。
   */
  let hotTimer = null
  async function autoHotReload() {
    const latest = await loadLatest()
    const mine = self.NEARTOKEN_VERSION || ''
    if (!latest || !mine || cmpVersion(latest, mine) <= 0) return
    const key = 'nt-reloaded-' + latest
    try {
      if (sessionStorage.getItem(key)) return
      sessionStorage.setItem(key, '1')
    } catch { /* 没有 storage 也允许重载一次 */ }
    const note = document.getElementById('update-note')
    if (note) {
      note.hidden = false
      note.className = 'update-note new'
      note.textContent = '插件已更新到 v' + latest + '，正在重载…'
    }
    setTimeout(() => {
      try {
        const u = new URL(location.href)
        u.searchParams.set('v', latest)
        location.replace(u.toString())
      } catch { location.reload() }
    }, 900)
  }
  function startHotReload() {
    if (hotTimer) return
    setTimeout(() => { autoHotReload().catch(() => {}) }, 2500)
    hotTimer = setInterval(() => { autoHotReload().catch(() => {}) }, 60_000)
  }


  // ---------- 画图 ----------

  /** stackedChart 画一张按模型堆叠的面积图；模型多于 5 个时余下的合并。 */
  function stackedChart(data) {
    const W = 640
    const H = 148
    const padL = 38
    const padR = 8
    const padT = 10
    const padB = 18
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H)
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', '按模型堆叠的消耗曲线')

    const buckets = data.buckets || []
    const totals = buckets.map((b) => (b.models || []).reduce((sum, m) => sum + m.tokens, 0))
    const max = Math.max(1, ...totals)

    // 横向刻度：0 与峰值，两条线足够定位
    for (const [i, value] of [0, 0.5, 1].entries()) {
      const y = padT + (H - padT - padB) * (1 - value)
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('x1', String(padL))
      line.setAttribute('x2', String(W - padR))
      line.setAttribute('y1', String(y))
      line.setAttribute('y2', String(y))
      line.setAttribute('class', 'grid')
      svg.append(line)
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      label.setAttribute('x', String(padL - 6))
      label.setAttribute('y', String(y + 3))
      label.setAttribute('text-anchor', 'end')
      label.setAttribute('class', 'axis')
      label.textContent = compact(max * value)
      svg.append(label)
      void i
    }

    const series = seriesOf(data)
    if (!buckets.length || max <= 1) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      text.setAttribute('x', String(W / 2))
      text.setAttribute('y', String(H / 2))
      text.setAttribute('text-anchor', 'middle')
      text.setAttribute('class', 'axis')
      text.textContent = '这段时间没有消耗'
      svg.append(text)
      return svg
    }

    const stepX = buckets.length > 1 ? (W - padL - padR) / (buckets.length - 1) : 0
    const xOf = (i) => padL + stepX * i
    const yOf = (value) => H - padB - ((H - padT - padB) * value) / max
    const running = new Array(buckets.length).fill(0)

    for (const [name, color] of series) {
      const lower = running.slice()
      const upper = []
      buckets.forEach((bucket, i) => {
        const row = (bucket.models || []).find((m) => m.model === name)
        running[i] += row ? row.tokens : 0
        upper.push(running[i])
      })
      let path = 'M ' + xOf(0).toFixed(2) + ' ' + yOf(lower[0]).toFixed(2)
      for (let i = 1; i < buckets.length; i++) path += ' L ' + xOf(i).toFixed(2) + ' ' + yOf(lower[i]).toFixed(2)
      for (let i = buckets.length - 1; i >= 0; i--) path += ' L ' + xOf(i).toFixed(2) + ' ' + yOf(upper[i]).toFixed(2)
      path += ' Z'
      const area = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      area.setAttribute('d', path)
      area.setAttribute('fill', color)
      area.setAttribute('fill-opacity', '0.55')
      area.setAttribute('stroke', color)
      area.setAttribute('stroke-width', '1.2')
      svg.append(area)
    }

    // 时间轴：首尾各一个刻度，按月用日期，按日/周用小时
    for (const at of [0, buckets.length - 1]) {
      if (at < 0) continue
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      label.setAttribute('x', String(xOf(at)))
      label.setAttribute('y', String(H - 4))
      label.setAttribute('text-anchor', at === 0 ? 'start' : 'end')
      label.setAttribute('class', 'axis')
      label.textContent = tickLabel(buckets[at].timestamp, data.range)
      svg.append(label)
    }
    return svg
  }

  /** seriesOf 取模型序列：前五个各自一层，余下的合并成"其他"。 */
  function seriesOf(data) {
    const models = (data.models || []).slice(0, 5)
    const out = models.map((m, i) => [m.model, PALETTE[i % PALETTE.length]])
    if ((data.models || []).length > 5) out.push(['其他', PALETTE[5]])
    return out
  }

  /** legendOf 是图例，带每个模型的占比。 */
  function legendOf(data) {
    const models = data.models || []
    if (!models.length) return null
    const total = models.reduce((sum, m) => sum + m.tokens, 0) || 1
    const rows = models.slice(0, 5).map((m, i) => legendRow(m.model, PALETTE[i % PALETTE.length], m.tokens / total))
    if (models.length > 5) {
      const rest = models.slice(5).reduce((sum, m) => sum + m.tokens, 0)
      rows.push(legendRow('其他', PALETTE[5], rest / total))
    }
    return el('div', { class: 'legend' }, rows)
  }

  function legendRow(name, color, share) {
    return el('span', { class: 'key' },
      el('span', { class: 'swatch', style: 'background:' + color }),
      el('span', { text: name }),
      el('span', { class: 'pct', text: Math.round(share * 100) + '%' }))
  }

  // ---------- 格式化 ----------

  /** splitMoney 把"￥12.34"拆成符号与数字，好让余额那块自己排字。 */
  function splitMoney(text) {
    const match = /^([^\d.\-+]*)(.*)$/.exec(String(text || ''))
    const unit = (match && match[1]) || ''
    const value = (match && match[2]) || text || '—'
    return { unit, value: value || '0.00' }
  }

  /** compact 把大数缩成 1.2k / 3.4M。 */
  function compact(value) {
    const n = Number(value) || 0
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B'
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'
    return String(Math.round(n))
  }

  function clockText(ms) {
    const d = new Date(ms)
    const pad = (n) => String(n).padStart(2, '0')
    return pad(d.getHours()) + ':' + pad(d.getMinutes())
  }

  function tickLabel(seconds, range) {
    const d = new Date(seconds * 1000)
    if (range === 'month') return (d.getMonth() + 1) + '/' + d.getDate()
    return String(d.getHours()).padStart(2, '0') + ':00'
  }

  boot()
})()