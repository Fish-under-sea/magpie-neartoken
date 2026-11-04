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
  /** 推荐码：所有从插件出站的站点链接都带上，别人第一次绑定也算邀请。 */
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
  /** 插件自己的开关：关掉的模型（写进 magpie 的 plugin options，provider 插件按它过滤）。 */
  let options = {}
  let disabledModels = new Set()
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
      // 插件自己的开关：关掉的模型。默认全选（options 里没有这个字段时一个都不关）
      try {
        options = (await bridge.options.get()) || {}
      } catch {
        options = {}
      }
      const raw = options.disabledModels
      disabledModels = Array.isArray(raw) ? new Set(raw)
        : (typeof raw === 'string' && raw.trim() ? new Set((() => { try { return JSON.parse(raw) } catch { return [] } })()) : new Set())
      await load()
      clock = setInterval(tick, 1000)
      bridge.onVisibility((visible) => {
        if (visible) load().catch(() => {})
      })
    } catch (error) {
      fail(String(error && error.message ? error.message : error))
    }
  }

  /** fail 是连不上宿主的终态：一句说明，一个重试。 */
  function fail(message) {
    $('view').replaceChildren(card('NearToken',
      el('p', { class: 'brief', text: message }),
      el('div', { class: 'row', style: 'margin-top:12px' },
        el('button', { class: 'primary', onclick: () => location.reload() }, '重试'))))
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
    if (notice) frag.append(el('p', { class: 'note', text: notice }))
    if (pendingAct) frag.append(el('p', { class: 'note', text: '正在处理：' + pendingAct }))
    body.replaceChildren(frag)
    if (tab === 'market' && view.configured && !view.pending) {
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
    const tabs = [['home', '原本界面'], ['market', '模型广场'], ['logs', '使用日志']]
    return el('div', { class: 'tabs', role: 'tablist' },
      tabs.map(([key, label]) => el('button', {
        role: 'tab',
        'aria-selected': String(tab === key),
        class: tab === key ? 'on' : '',
        onclick: () => {
          if (tab === key) return
          tab = key
          render()
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
          onclick: () => act('发起授权', () => call('neartoken:connect', {})),
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
        el('div', { class: 'rf-ico', text: '◈' }),
        el('div', { class: 'rf-text' },
          el('h2', { text: '推荐计划', style: 'margin:0' }),
          el('p', { class: 'note', text: '用户通过您的推荐链接注册后，您即可获得奖励。可随时将累计奖励转入余额。', style: 'margin:2px 0 0' })),
        el('div', { class: 'rf-invites' }, el('div', { class: 'k', text: '邀请' }), el('div', { class: 'v', text: invites })),
        el('div', { class: 'rf-link' }, el('span', { text: url })),
        el('button', { class: 'rf-copy', title: '复制推荐链接', onclick: () => copy(url) }, '⧉'),
        stamp ? el('span', { class: 'note', style: 'margin:0 0 0 2px', text: stamp }) : null))
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
      parts.push(el('div', { class: 'label', text: '代金券' }))
      parts.push(el('div', { class: 'vouchers' }, vouchers.map((v) =>
        el('div', { class: 'voucher' },
          el('span', { class: 'who', title: v.group, text: v.group }),
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
      if (!data.reason) parts.push(el('p', { class: 'note', text: '' }))
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
    if (!info) return el('section', { class: 'card home-wide tp-wide' }, el('p', { class: 'note', text: '正在读取充值档位…' }))
    if (info.unavailable) return el('section', { class: 'card home-wide tp-wide' }, el('p', { class: 'note', text: info.unavailable }))
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
    const head = el('div', { class: 'tp-head' },
      el('div', { class: 'tp-badge', text: '￥' }),
      el('div', { class: 'grow' },
        el('h2', { text: '添加资金', style: 'margin:0' }),
        el('p', { class: 'note', text: '选择金额和支付方式', style: 'margin:2px 0 0' })),
      el('a', { class: 'ghost link', href: affURL('https://neartoken.cc/wallet'), target: '_blank', rel: 'noreferrer' }, '订单历史 ↗'),
      el('button', { class: 'primary', disabled: !!pendingAct || !amount, onclick: () => pay(method) }, '去支付'))
    const tiles = el('div', { class: 'tp-tiles' }, options.map((v) => {
      const on = v === amount && !pick.custom
      const discount = v >= 500 ? '优惠 4%' : v >= 200 ? '优惠 2%' : ''
      return el('button', {
        class: 'tp-tile' + (on ? ' on' : ''), 'aria-pressed': String(on),
        onclick: () => { pick.amount = v; pick.custom = ''; render() },
      },
        el('b', { text: String(v) }),
        el('span', { class: 'tp-pay', text: discount ? cur + payable(v) + ' · 节省 ' + saved(v) : cur + v }),
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
      el('button', { class: 'ghost', onclick: () => showNotice('兑换额度需要站点提供兑换端点，可在站点钱包页兑换。') }, '兑换额度'))
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
  let marketSort = 'default'
  let marketLayout = 'grid'
  let logQuery = ''
  let logGroup = ''
  let logKind = 'all'
  let logExpanded = false
  const marketVendors = new Set()
  const MARKET_KINDS = [['all', '全部'], ['chat', '对话'], ['image', '生图'], ['video', '视频'], ['audio', '语音'], ['embedding', '向量']]

  /** pricing 是包内静态快照（插件运行时会把实时目录覆盖进同一个文件）。 */
  function pricing() {
    const p = self.NEARTOKEN_PRICING
    return p && Array.isArray(p.models) && p.models.length ? p : null
  }

  /**
   * startPriceSync 每分钟把插件写出后的新快照重新引入一次，
   * 模型列表与分组跟着站点实时同步（禁用状态、筛选都保留）。
   */
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

  /** groupTags 把 [低价][满血] GPT Pro 2 拆成功能 / 价格 / 余下文字，供排序与重绘。 */
  function groupTags(name) {
    const raw = String(name || '')
    const parts = (raw.match(/\[[^\]]+\]/g) || []).map((p) => p.slice(1, -1))
    const rest = raw.replace(/\[[^\]]+\]/g, '').trim()
    const all = parts.concat(rest ? [rest] : []).join(' ')
    // 功能标签按分组下实际模型的端点推导；站点改目录后自动跟着变
    const func = KIND_SERIES[groupKind(name)] || '对话'
    // 官Key 是独立档位，标签里不再挂「满血」（[满血][官Key] → 官Key）
    let price = parts.filter((p) => PRICE_TAGS.some((k) => p.toLowerCase().includes(k.toLowerCase())))
    if (/官Key|官key/i.test(all)) price = price.filter((p) => !/满血/.test(p))
    price.sort((a, b) => leadRank(a) - leadRank(b))
    return { func, price, rest, lead: price[0] || '' }
  }

  /** groupBadge 按「功能 → 价格」两级重绘；首标签单独加 .lead 作视觉区分。 */
  function groupBadge(name) {
    const t = groupTags(name)
    const tone = { '图片': 'pink', '视频': 'blue', '音频': 'purple', '向量': 'teal', '对话': 'plain' }
    const colorOf = (w) => {
      if (/满血|原生|特惠/i.test(w)) return 'red'
      if (/低价|反重力|神秘|自有|国模/i.test(w)) return 'green'
      if (/促销|生图|Kiro|灵车/i.test(w)) return 'pink'
      if (/备用|官Key|官key|CC|Argon|GPT Pro|视频|向量/i.test(w)) return 'blue'
      return 'plain'
    }
    return el('span', { class: 'gb' },
      // 功能标签只在非对话类显示；对话是默认，不重复挂
      t.func === '对话' ? null : el('span', { class: 'gb-tag lvl1 ' + (tone[t.func] || 'plain'), text: t.func }),
      t.price.map((w, i) => el('span', {
        class: 'gb-tag lvl2 ' + colorOf(w) + (i === 0 ? ' lead' : ''),
        text: w,
      })),
      t.rest ? el('span', { class: 'gb-rest', text: t.rest }) : null)
  }

  /**
   * priceOf 反推站点卡片上的价格：
   *   计费表达式里 p/c/cr 的系数 × 该模型最低分组倍率（站点按最低档展示）。
   * 没有表达式（按量计费）时系数 = model_ratio × 2、× completion_ratio、× cache_ratio。
   * 逐个与站点 SSR 卡片核对过：gpt-6-astra ¥2/¥10/¥0.2、claude-sonnet-5-5
   * ¥3/¥15/¥0.15、glm-5.3 ¥2/¥7/¥0.5、gpt-6.1-terra ¥0.26/¥1.3/¥0.013。
   */
  function priceOf(m) {
    const expr = String(m?.billing_expr || '')
    const coef = (v) => { const x = expr.match(new RegExp('\\b' + v + '\\s*\\*\\s*([\\d.]+)')); return x ? Number(x[1]) : null }
    const ratios = (m?.enable_groups || []).map((g) => Number(pricing()?.groups?.[g])).filter((v) => v > 0)
    const min = ratios.length ? Math.min(...ratios) : 1
    // 生图/音乐这类按次计费：表达式里是 fixed(单价) × 张数，不是 token 系数
    const fixed = expr.match(/fixed\(\s*([\d.]+)\s*\)/)
    if (fixed) return { perCall: Number(fixed[1]) * min, perLabel: '张', tiered: true }
    if (Number(m?.quota_type) === 1 && Number(m?.model_price) > 0) {
      return { perCall: Number(m.model_price), perLabel: '次', tiered: false }
    }
    const p0 = coef('p') ?? (Number(m?.model_ratio) || 0) * 2
    const c0 = coef('c') ?? p0 * (Number(m?.completion_ratio) || 0)
    const r0 = coef('cr') ?? p0 * (Number(m?.cache_ratio) || 0)
    return { input: p0 * min, output: c0 * min, cache: r0 * min, tiered: !!expr }
  }

  /** money 是价格写法：¥2、¥0.02；/1K 时把每 1M 的价除以 1000。 */
  function money(v, unit) {
    const x = unit === 'K' ? v / 1000 : v
    if (!x) return '¥0'
    const s = String(Math.round(x * 1e8) / 1e8)
    return '¥' + s
  }

  /** modelCard：点击整张卡切换启用；高亮就是启用，只有启用的进 magpie 模型清单。 */
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
    const shownGroups = groups.slice(0, 2)
    const more = groups.length - shownGroups.length
    const kind = marketKindOf(m)
    const on = !disabledModels.has(m.name)
    const priceRow = p.perCall !== undefined
      ? el('div', { class: 'mc-prices one' },
        el('div', null, el('span', { text: '按次计费' }), el('b', { text: money(p.perCall, 'M') + ' / ' + p.perLabel })))
      : el('div', { class: 'mc-prices' },
        el('div', null, el('span', { text: '输入' }), el('b', { text: money(p.input, marketUnit) + ' / 1' + marketUnit })),
        el('div', null, el('span', { text: '输出' }), el('b', { text: money(p.output, marketUnit) + ' / 1' + marketUnit })),
        el('div', null, el('span', { text: '缓存读取' }), el('b', { text: money(p.cache, marketUnit) + ' / 1' + marketUnit })))
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
        el('span', { class: 'mc-vicon', text: vendorOf(m.vendor_id).slice(0, 1) }),
        el('div', { class: 'grow' },
          el('div', { class: 'mc-name', text: m.name }),
          el('div', { class: 'mc-vendor', text: vendorOf(m.vendor_id) })),
        el('span', { class: 'mc-flag', text: on ? '✓ 已启用' : '○ 未启用' }),
        el('button', {
          class: 'mc-copy', title: '复制模型 ID',
          onclick: (e) => { e.stopPropagation(); copy(m.name) },
        }, '⧉')),
      el('p', { class: 'mc-desc', text: m.description || '暂无描述。' }),
      el('div', { class: 'mc-billing ' + (p.tiered ? 'dyn' : 'flat'), text: p.tiered ? '动态计费' : '按量计费' }),
      priceRow,
      el('div', { class: 'mc-line' },
        el('span', { class: 'k', text: '分组' }),
        shownGroups.map((g) => groupBadge(g)),
        more > 0 ? el('span', { class: 'mc-more', text: '+' + more }) : null),
      el('div', { class: 'mc-line' },
        el('span', { class: 'k', text: '端点' }),
        el('span', { class: 'v', text: ends || '—' })),
      el('div', { class: 'mc-stats' },
        el('span', null, el('span', { class: 'k', text: '状态' }),
          el('span', { class: 'v', text: hasStatus ? Number(m.status).toFixed(2) + '%' : '—' })),
        bars,
        el('span', null, el('span', { class: 'k', text: '延迟' }),
          el('span', { class: 'v', text: m.latency || '—s' })),
        el('span', null, el('span', { class: 'k', text: '吞吐' }),
          el('span', { class: 'v', text: m.throughput || '—t/s' }))),
      el('div', { class: 'mc-foot' },
        el('a', { class: 'link', href: affURL('https://neartoken.cc/pricing'), target: '_blank', rel: 'noreferrer' }, '详情 ›')))
  }

  /**
   * versionKey 把模型名里的版本号抽成可比较的数字串（gpt-6.1 > gpt-6 > gpt-5.6，
   * claude-opus-4-8 > 4-7）。站点 /api/pricing 没有 created_at，
   * 这版按版本号降序作为「最新版本」的可实时计算口径，不依赖写死名单。
   */
  function versionKey(name) {
    const s = String(name || '').toLowerCase()
    const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number)
    return nums.length ? nums : [-1]
  }
  function byVersionDesc(a, b) {
    const x = versionKey(a.name), y = versionKey(b.name)
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (y[i] ?? 0) - (x[i] ?? 0)
      if (d) return d
    }
    return a.name.localeCompare(b.name)
  }

  /** filteredModels 把搜索、分组、类型、厂商筛选叠起来。 */
  function filteredModels() {
    const p = pricing()
    if (!p) return []
    let list = p.models.slice()
    if (marketSort === 'latest') {
      list.sort(byVersionDesc)
    } else {
      // 按实时数据归类：LLM 走 vendor 系列（Claude→GPT→Gemini→Grok→Kimi→GLM→Qwen→DS），
      // 功能模型排在后面按 图片→视频→音频→向量。不用模型名正则，快照更新即跟随。
      list.sort((a, b) => {
        const ra = modelRank(a), rb = modelRank(b)
        return ra.tier - rb.tier || ra.order - rb.order || a.name.localeCompare(b.name)
      })
    }
    if (marketGroup) list = list.filter((m) => (m.enable_groups || []).includes(marketGroup))
    if (marketKind !== 'all') list = list.filter((m) => marketKindOf(m) === marketKind)
    if (marketVendors.size) list = list.filter((m) => marketVendors.has(String(m.vendor_id)))
    const q = marketQuery.trim().toLowerCase()
    if (q) list = list.filter((m) => [m.name, vendorOf(m.vendor_id), m.description, m.tags,
      (m.enable_groups || []).join(' '), (m.supported_endpoint_types || []).join(' ')].join(' ').toLowerCase().includes(q))
    return list
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
    box.replaceChildren(...(list.length ? list.map(modelCard) : [el('p', { class: 'note', text: '没有符合条件的模型。' })]))
  }

  /** 筛选与工具条原位更新，保留侧栏节点、滚动位置及键盘焦点。 */
  function refreshMarketView() {
    const states = { mode: marketMode, unit: marketUnit, sort: marketSort, layout: marketLayout }
    document.querySelectorAll('.market [data-market-group], .market [data-market-kind], .market [data-market-vendor], .market [data-market-setting]').forEach((button) => {
      const d = button.dataset
      const on = d.marketGroup !== undefined ? marketGroup === d.marketGroup
        : d.marketKind !== undefined ? marketKind === d.marketKind
        : d.marketVendor !== undefined ? marketVendors.has(d.marketVendor)
        : states[d.marketSetting] === d.marketValue
      button.classList.toggle('on', on)
      button.setAttribute('aria-pressed', String(on))
    })
    refreshMarketList()
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
    const byRatio = (a, b) => (Number(p.groups[a]) || 0) - (Number(p.groups[b]) || 0) || a.localeCompare(b, 'zh')
    // 空分组也按名字归到对应档（如 [低价][满血] Gemini Ultra 属满血），
    // 不另设「暂无模型」档，避免把满血组丢到最后。
    const llmGroups = allGroups.filter((g) => groupKind(g) === 'chat')
    const funcGroups = allGroups.filter((g) => groupKind(g) !== 'chat')
    // 鸡蛋🥚 置顶：站点有就给，没有就置一个「暂无」
    const eggGroups = allGroups.filter(isEgg)
    llmGroups.splice(0, llmGroups.length, ...llmGroups.filter((g) => !isEgg(g)))
    funcGroups.splice(0, funcGroups.length, ...funcGroups.filter((g) => !isEgg(g)))
    const vendors = (p?.vendors || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'))
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
    const allOn = disabledModels.size === 0
    const allOff = total > 0 && disabledModels.size >= total
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
      el('button', {
        class: 'market-tool' + (marketSort === 'latest' ? ' on' : ''),
        'aria-pressed': String(marketSort === 'latest'),
        'data-market-setting': 'sort', 'data-market-value': 'latest',
        title: '按模型版本号降序（站点暂无上架时间字段）',
        onclick: () => { marketSort = marketSort === 'latest' ? 'default' : 'latest'; refreshMarketView() },
      }, '↑ 最新版本'),
      el('div', { class: 'market-seg' },
        el('button', { 'data-market-setting': 'layout', 'data-market-value': 'grid', 'aria-pressed': String(marketLayout === 'grid'), title: '网格', onclick: () => { marketLayout = 'grid'; refreshMarketView() } }, '▦'),
        el('button', { 'data-market-setting': 'layout', 'data-market-value': 'list', 'aria-pressed': String(marketLayout === 'list'), title: '列表', onclick: () => { marketLayout = 'list'; refreshMarketView() } }, '☰')))
    // 价格档在前、功能档在后；这是列表里的「往上」，不是标签内前后权重
    const llmBands = BAND_ORDER.map((name) => ({
      name, tone: name === '低价' ? 'low' : '',
      items: llmGroups.filter((g) => bandOf(g) === name)
        .sort((a, b) => seriesIdx(a) - seriesIdx(b) || byRatio(a, b)),
    })).filter((b) => b.items.length)
    const funcBands = FUNC_BANDS.map(([kind, label]) => ({
      name: label, tone: 'func',
      items: funcGroups.filter((g) => groupKind(g) === kind).sort(byRatio),
    })).filter((b) => b.items.length)
    const chipOf = (g) => {
      const ratio = Number(p.groups[g]) || 0
      return el('button', {
        class: 'market-chip' + (marketGroup === g ? ' on' : ''),
        title: '按这个分组筛选', 'data-market-group': g, 'aria-pressed': String(marketGroup === g),
        onclick: () => { marketGroup = marketGroup === g ? '' : g; refreshMarketView() },
      }, groupBadge(g), ratio > 0 ? el('span', { class: 'ratio', text: 'x' + ratioText(ratio) }) : null)
    }
    const bandEl = (b) => el('div', { class: 'chip-group' },
      el('div', { class: 'chip-group-name ' + b.tone, text: b.name }),
      el('div', { class: 'market-chips' }, b.items.map(chipOf)))
    const groupChips = el('div', { class: 'market-chips' },
      el('button', {
        class: 'market-chip' + (!marketGroup ? ' on' : ''), 'data-market-group': '', 'aria-pressed': String(!marketGroup), onclick: () => { marketGroup = ''; refreshMarketView() },
      }, '所有分组'),
      // 鸡蛋🥚 永远第一档
      el('div', { class: 'chip-group' },
        el('div', { class: 'chip-group-name egg', text: '鸡蛋🥚' }),
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
    const vendorChips = el('div', { class: 'market-chips chips-row' },
      vendors.map((v) => el('button', {
        class: 'market-chip' + (marketVendors.has(String(v.id)) ? ' on' : ''),
        'data-market-vendor': String(v.id), 'aria-pressed': String(marketVendors.has(String(v.id))),
        onclick: () => {
          const id = String(v.id)
          if (marketVendors.has(id)) marketVendors.delete(id)
          else marketVendors.add(id)
          refreshMarketView()
        },
      }, v.name)))
    const aside = el('aside', { class: 'market-aside' },
      el('div', { class: 'ma-head' },
        el('h3', { text: '筛选' }),
        el('button', { class: 'link', onclick: () => { marketQuery = ''; marketGroup = ''; marketKind = 'all'; marketVendors.clear(); search.value = ''; refreshMarketView() } }, '↺ 重置')),
      el('p', { class: 'note', text: '按供应商、分组、类型和标签细化搜索模型。' }),
      el('h4', { text: '分组' }), groupChips,
      el('h4', { text: '类型' }), kinds,
      el('h4', { text: '供应商' }), vendorChips)
    const off = disabledModels.size
    const body = el('div', { class: 'market-body' },
      aside,
      el('div', { class: 'market-main' },
        el('div', { class: 'market-count', id: 'market-count', text: (p?.models?.length || 0) + ' 个模型' + (syncedAt() ? ' · 同步 ' + syncedAt() : '') }),
        el('div', { class: 'model-grid', id: 'market-list' }),
        el('p', { class: 'note', text: off
          ? '已停用 ' + off + ' 个模型：它们不会进 magpie 的模型清单。点卡片可重新启用，或按「全选」。'
          : '默认全选。点卡片切换启用状态，高亮 = 已启用；只有启用的模型才进 magpie 的模型清单。' })))
    const wrap = el('section', { class: 'market' },
      el('div', { class: 'market-top' }, search, tools),
      body)
    // render 在挂载后同步填充列表，再恢复滚动，避免空列表导致页面高度瞬降。
    return wrap
  }

  /** 使用日志：仿站点日志页——筛选条 + 统计条 + 全宽明细表。 */
  function logsCard() {
    const data = windows.get(span)
    const seg = el('div', { class: 'seg' },
      ['day', 'week', 'month'].map((key) =>
        el('button', { 'aria-pressed': String(span === key), onclick: () => switchSpan(key) },
          key === 'day' ? '日' : key === 'week' ? '周' : '月')))
    const head = el('div', { class: 'row' },
      el('h2', { class: 'grow', text: '使用日志', style: 'margin:0' }), seg)
    if (!data) return el('section', { class: 'logs' }, card(null, head, el('p', { class: 'note', text: '正在读取用量…' })))
    if (!data.available) {
      return el('section', { class: 'logs' }, card(null, head,
        el('p', { class: 'note warn', text: data.reason === 'unreachable'
          ? '暂时读不到站点的用量数据。' : '站点未提供用量统计。' })))
    }
    const all = (data.models || []).slice().sort((a, b) => b.tokens - a.tokens)
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
    const groups = Object.keys(pricing()?.groups || {}).sort((a, b) => a.localeCompare(b, 'zh'))
    const rangeText = span === 'day' ? '今日' : span === 'week' ? '本周' : '本月'
    const toolbar = el('div', { class: 'logs-toolbar' },
      el('div', { class: 'lt-field grow' }, el('span', { class: 'lt-ico', text: '▦' }),
        el('span', { class: 'lt-range', text: rangeText + ' · 00:00 ~ 现在' })),
      el('input', {
        class: 'lt-input', type: 'search', placeholder: '模型名称', value: logQuery,
        oninput: (e) => { logQuery = e.target.value; render() },
      }),
      el('select', { class: 'lt-select', onchange: (e) => { logGroup = e.target.value; render() } },
        el('option', { value: '', text: '分组' }),
        groups.map((g) => el('option', { value: g, text: g, selected: logGroup === g }))),
      el('select', { class: 'lt-select', onchange: (e) => { logKind = e.target.value; render() } },
        el('option', { value: 'all', text: '所有类型' }),
        MARKET_KINDS.slice(1).map(([k, label]) => el('option', { value: k, text: label, selected: logKind === k }))),
      el('button', { class: 'lt-btn', onclick: () => { logExpanded = !logExpanded; render() } }, logExpanded ? '收起 ▴' : '展开 ▾'))
    const statbar = el('div', { class: 'logs-statbar' },
      el('div', { class: 'ls-chips' },
        el('span', { class: 'ls-chip' }, el('i', { class: 'ls-dot blue' }), '用量 ', el('b', { text: data.spent || '—' })),
        el('span', { class: 'ls-chip' }, el('i', { class: 'ls-dot red' }), 'RPM ', el('b', { text: '0' })),
        el('span', { class: 'ls-chip' }, el('i', { class: 'ls-dot blue' }), 'TPM ', el('b', { text: compact(data.tokens || 0) }))),
      el('div', { class: 'ls-actions' },
        el('button', { class: 'lt-btn', title: '10 秒刷新', onclick: () => { load().catch(() => {}) } }, '↻ 10s'),
        el('button', { class: 'lt-btn', onclick: () => { logQuery = ''; logGroup = ''; logKind = 'all'; render() } }, '重置'),
        el('button', { class: 'lt-btn primary', onclick: () => render() }, '搜索'),
        el('button', { class: 'lt-btn', onclick: () => showError('逐条导出需要宿主提供日志端点。') }, '导出')))
    const cols = ['时间', '令牌', '模型', '流', 'Token', '请求体大小', '费用', '耗时', '详情']
    const table = el('div', { class: 'logs-table' },
      el('div', { class: 'lt-row head' }, cols.map((c) => el('span', { text: c }))),
      rows.length ? rows.map((m) => el('div', { class: 'lt-row' },
        el('span', { text: rangeText }),
        el('span', { text: view.tokenName || '—' }),
        el('span', { class: 'who', title: m.model, text: m.model }),
        el('span', { text: '—' }),
        el('span', { class: 'num', text: compact(m.tokens) }),
        el('span', { text: '—' }),
        el('span', { class: 'num', text: m.costText || '—' }),
        el('span', { text: '—' }),
        el('span', { class: 'num', text: Math.round((m.tokens / total) * 100) + '%' })))
        : el('div', { class: 'lt-empty', text: '这个筛选下没有记录。' }))
    // 分布不再是下面的一张卡：折进「展开」，默认不占版面
    const dist = logExpanded ? el('div', { class: 'logs-dist' },
      rows.slice(0, 8).map((m, i) => el('div', { class: 'dist-row' },
        el('div', { class: 'dist-name', title: m.model, text: m.model }),
        el('div', { class: 'dist-track' },
          el('i', { style: 'width:' + Math.max(2, Math.round((m.tokens / total) * 100)) + '%;background:' + ['#5b8def', '#43b8a4', '#9b7ce0', '#54b26a', '#e0a44a', '#d47a9a', '#6fa8d6', '#c08bd0'][i % 8] })),
        el('div', { class: 'dist-val', text: compact(m.tokens) + ' · ' + Math.round((m.tokens / total) * 100) + '%' })))) : null
    return el('section', { class: 'logs' },
      el('div', { class: 'logs-head' }, head),
      toolbar, statbar, dist,
      el('div', { class: 'logs-table-wrap' }, table),
      el('p', { class: 'note', text: '数字来自站点用量端点，按模型汇总；站点未提供逐条流水，故「流 / 请求体大小 / 耗时」留空。' }))
  }
  /** toggleModel 翻转一个模型的启用状态，并写回 plugin options。 */
  async function toggleModel(name) {
    if (!name) return
    if (disabledModels.has(name)) disabledModels.delete(name)
    else disabledModels.add(name)
    refreshMarketList()
    await saveDisabled()
  }

  /** setAll 全选 / 全不选：双状态按钮都走这里。 */
  async function setAll(enable) {
    const p = pricing()
    if (!p) return
    if (enable) disabledModels.clear()
    else p.models.forEach((m) => disabledModels.add(m.name))
    render()
    await saveDisabled()
  }

  /**
   * saveDisabled 把「关掉的模型」写进 plugin options，provider 插件按它过滤清单。
   *
   * magpie 限制页面每秒最多写一次 options，连点卡片会被拒（"a page sets its
   * options once a second at most"）。所以这里合并写入：1.1 秒内的多次改动只发
   * 最后一次，正在发送时再排队补一次；限流错误不往页脚挂。
   */
  let saveTimer = null
  let sending = false
  let sendAgain = false
  async function flushDisabled() {
    if (sending) { sendAgain = true; return }
    sending = true
    try {
      const next = await bridge.options.set({ ...options, disabledModels: [...disabledModels] })
      if (next && typeof next === 'object') options = next
      lastError = ''
    } catch {
      // 写失败时保留本地状态，下一拍重试；不把限流提示挂到页脚
      sendAgain = true
    } finally {
      sending = false
      if (sendAgain) { sendAgain = false; setTimeout(flushDisabled, 1100) }
    }
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

  let checking = false
  async function checkUpdate() {
    if (checking) return
    checking = true
    const btn = $('updates')
    const note = $('update-note')
    const was = btn.textContent
    btn.disabled = true
    btn.textContent = '检查中…'
    note.hidden = true
    const latest = await loadLatest()
    const mine = self.NEARTOKEN_VERSION || ''
    checking = false
    btn.disabled = false
    btn.textContent = was
    if (!latest) {
      note.className = 'update-note warn'
      note.textContent = '没查到最新版本：插件还没联网拉过一次，稍后再试。'
      note.hidden = false
      return
    }
    if (mine && cmpVersion(latest, mine) > 0) {
      note.className = 'update-note new'
      note.textContent = '有新版本 v' + latest + '（当前 v' + mine + '）'
      const link = el('a', {
        class: 'link',
        href: 'https://github.com/Fish-under-sea/magpie-neartoken/releases',
        target: '_blank',
        rel: 'noreferrer',
        style: 'margin-left:8px',
      }, '去下载 ↗')
      note.append(link)
      note.hidden = false
      return
    }
    note.className = 'update-note'
    note.textContent = '已是最新 v' + (mine || latest)
    note.hidden = false
  }

  $('updates').addEventListener('click', checkUpdate)

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