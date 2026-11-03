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

  /** 上一次 neartoken:state 的应答。 */
  let view = null
  /** 看板窗口：day / week / month。 */
  let span = 'day'
  /** 上一次读到的窗口数据，按窗口名缓存，切回来不必再等。 */
  const windows = new Map()
  /** 充值面：档位、渠道、当前选择。 */
  let topupInfo = null
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
  function showError(error) {
    lastError = String(error && error.message ? error.message : error)
    render()
  }

  // ---------- 主流程 ----------

  async function boot() {
    if (!bridge || typeof bridge.call !== 'function') {
      fail('这个 magpie 还没有插件页的调用通道。')
      return
    }
    try {
      await bridge.ready
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
    if (counting && tickCount % 2 === 0) load().catch(() => {})
    else if (!counting && tickCount % 60 === 0) load().catch(() => {})
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
    const frag = document.createDocumentFragment()
    if (view.pending) {
      setStatus('等待确认', 'warn')
      frag.append(pendingCard())
    } else if (view.configured) {
      setStatus('已连接', 'on')
      frag.append(accountCard(), boardCard(), topupCard(), providerCard())
    } else {
      setStatus('未连接')
      frag.append(connectCard())
    }
    if (view.error) frag.append(el('p', { class: 'note bad', text: view.error }))
    if (lastError) frag.append(el('p', { class: 'note bad', text: lastError }))
    if (pendingAct) frag.append(el('p', { class: 'note', text: '正在处理：' + pendingAct }))
    body.replaceChildren(frag)
  }

  /** 未连接：说清会发生什么，再给一个按钮。 */
  function connectCard() {
    return card('连接 NearToken',
      el('p', { class: 'brief' },
        '把 ', el('b', { text: 'neartoken.cc' }), ' 接成 magpie 的供应商：登录在站点自己的页面完成，' +
        '插件不接触密码。连接之后模型由 magpie 的供应商页统一选择，这里只管账户与额度。'),
      el('ul', { class: 'steps' },
        el('li', { text: '站点支持密码、GitHub、Discord、LinuxDo、OIDC、Telegram、微信与 Passkey 登录。' }),
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
      el('button', { disabled: !!pendingAct, onclick: () => copy(p.verificationUriComplete) }, '复制链接'),
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

  /** 充值卡：档位、渠道、去支付。 */
  function topupCard() {
    const info = topupInfo
    if (!info) return card('充值', el('p', { class: 'note', text: '正在读取充值档位…' }))
    if (info.unavailable) return card('充值', el('p', { class: 'note', text: info.unavailable }))
    const options = Array.isArray(info.options) && info.options.length ? info.options : []
    const amount = pick.amount
    const method = pick.method || (info.methods[0] && info.methods[0].type) || ''
    const parts = [
      el('div', { class: 'topup' },
        el('div', { class: 'row wrap' },
          options.map((value) => el('button', {
            'aria-pressed': String(value === amount),
            onclick: () => { pick.amount = value; pick.custom = ''; render() },
          }, String(value))),
          el('label', { class: 'field' },
            el('span', { class: 'cur', text: info.currency || '￥' }),
            el('input', {
              type: 'text',
              inputmode: 'numeric',
              placeholder: '其他',
              value: pick.custom,
              'aria-label': '自定义金额',
              oninput: (e) => { pick.custom = e.target.value.replace(/[^\d]/g, ''); pick.amount = null },
            }))),
        el('div', { class: 'row' },
          info.methods.length > 1
            ? el('select', {
              'aria-label': '收款方式',
              onchange: (e) => { pick.method = e.target.value; render() },
            }, info.methods.map((m) => el('option', { value: m.type, selected: m.type === method }, m.name)))
            : el('span', { class: 'note', text: info.methods.length ? info.methods[0].name : '' }),
          el('span', { class: 'grow' }),
          el('button', {
            class: 'primary',
            disabled: !!pendingAct,
            onclick: () => pay(method),
          }, '去支付'))),
      el('p', { class: 'note', text: '付完 5 分钟内余额会自动刷新；订单与发票在站点的钱包页。' }),
    ]
    return card('充值', ...parts)
  }

  /** 供应商卡：说明模型已经交给 magpie 了。 */
  function providerCard() {
    const models = view.models || 0
    const groups = view.groups || 0
    return card('模型与供应商',
      el('dl', { class: 'facts' },
        el('div', null, el('dt', { text: '供应商' }), el('dd', { text: 'NearToken（已接入）' })),
        el('div', null, el('dt', { text: '可用模型' }), el('dd', { text: models ? models + ' 个' : '尚未读到目录' })),
        el('div', null, el('dt', { text: '计费分组' }), el('dd', { text: groups ? groups + ' 个' : '—' })),
        el('div', null, el('dt', { text: '令牌名' }), el('dd', { text: view.tokenName || '—' }))),
      el('p', { class: 'note', text: '模型选择、路由与失败切换都在 magpie 的供应商页里，和别的供应商一样；这里不重复一套。' }))
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