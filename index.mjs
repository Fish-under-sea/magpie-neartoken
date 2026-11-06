// NearToken 的 magpie 宿主部分：一个 OpenCode 形状的 provider 插件。
//
// 它不碰 magpie 源码，用的都是 magpie 自己提供的扩展点：
//
//   auth.methods  设备授权（站点自己的确认页，插件不收密码）
//   auth.usage    余额，按 magpie 的用量卡显示
//   auth.loader   请求带着这把钥匙出去
//   auth.icon     供应商卡上的那张图（data: URI，不联网抓）
//   provider.models  模型目录：一个「分组 × 模型」一行，名字带站点原文组名与
//                    倍率，每个模型带自己的 x-neartoken-group 头
//
// 站点自己的 /v1/models 按令牌分组过滤，很多账号拿到的是空列表，所以模型目录
// 直接读 /api/pricing（公开、全量），不靠那个端点。

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE = 'https://neartoken.cc'
/** 推荐码：所有从插件出站的站点链接都带上，别人第一次绑定也算邀请。 */
const AFF_CODE = '0mY4'
/** affURL 给站点链接补邀请码；已有 query 用 &，链接为空原样返回。 */
function affURL(raw) {
  const u = String(raw || '').trim()
  if (!u) return u
  try {
    const x = new URL(u, SITE)
    if (!x.searchParams.has('aff')) x.searchParams.set('aff', AFF_CODE)
    return x.toString()
  } catch {
    return u
  }
}
/** 站点确认页上的称呼，也是站点给这把钥匙起的名字（HANDOFF：Magpie 与 DSH 是两把）。 */
const CLIENT_NAME = 'Magpie'
const TOKEN_NAME = 'Magpie'
/** 供应商 id：一个就好，单账号。 */
const PROVIDER_ID = 'neartoken'
/** 一次授权在内存里的那点状态。 */
let pending = null

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 站点图标编成 data: URI：magpie 的 auth.icon 只收 https 与 data:image，
 * 不抓包内相对路径，联网抓又会在断网时变成灰书页。
 */
function iconURI() {
  try {
    const png = readFileSync(join(here, 'page', 'icon.png'))
    return 'data:image/png;base64,' + png.toString('base64')
  } catch {
    return ''
  }
}
const ICON = iconURI()

/** call 是一次站点请求：JSON 出去，JSON 回来。 */
async function call(path, { method = 'GET', body, key } = {}) {
  const headers = { accept: 'application/json', 'user-agent': 'magpie-neartoken' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (key) headers.authorization = 'Bearer ' + key
  const res = await fetch(SITE + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${path} answered ${res.status} with a body that isn't JSON`)
  }
  return parsed
}

/** 站点没给 token_name 时的回落：Magpie，不是 DSH。 */
function grantOf(data) {
  const token = typeof data?.access_token === 'string' ? data.access_token : ''
  if (!token) throw new Error('设备授权应答缺少 access_token')
  return { type: 'success', access: token, refresh: token, tokenName: data?.token_name || TOKEN_NAME, user: data?.user }
}

/** 最近一次成功的币种参数；请求失败时沿用它，绝不回退到 per:1。 */
let lastCurrency = null

/** 站点当前怎么印钱：一个 quota 值折算成它显示的那笔钱。 */
async function currency() {
  try {
    const s = await call('/api/status')
    const d = s?.data ?? {}
    const per = Number(d.quota_per_unit) > 0 ? Number(d.quota_per_unit) : 500000
    const rate = Number(d.usd_exchange_rate ?? d.custom_currency_exchange_rate) > 0
      ? Number(d.usd_exchange_rate ?? d.custom_currency_exchange_rate)
      : 1
    const display = d.display_in_currency === true
    // 符号优先级：quota_display_type（实测 CNY）→ 非占位符的 custom_currency_symbol → 默认。
    // 站点给的 custom_currency_symbol 常是通用占位符，直接显示很难看。
    const byCode = { CNY: '\u00a5', USD: '\u0024', EUR: '\u20ac', GBP: '\u00a3', JPY: '\u00a5' }
    const code = typeof d.quota_display_type === 'string' ? d.quota_display_type.trim().toUpperCase() : ''
    const custom = typeof d.custom_currency_symbol === 'string' ? d.custom_currency_symbol.trim() : ''
    const symbol = byCode[code]
      ? byCode[code]
      : custom && custom !== '\u00a4'
        ? custom
        : display ? '\u00a5' : '\u0024'
    lastCurrency = { symbol, per, rate, display }
    return lastCurrency
  } catch {
    // 读不到就沿用上一次成功的值；从没成功过才用站点约定默认（1 美元 = 500000 额度）。
    // 绝不回退 per:1 —— 那会把 quota 原值当金额显示，余额直接放大 50 万倍。
    return lastCurrency || { symbol: '\u00a5', per: 500000, rate: 1, display: true }
  }
}

/**
 * writeHealth 把最近几次 models() 的调用结果写成 page/health.js。
 *
 * 掉供应商时最需要区分两件事：宿主到底有没有来要模型表、要到的表是不是空的。
 * 页面读这个脚本就能看到，不用去翻宿主的插件进程日志。
 */
const healthLog = []
function writeHealth(rec) {
  try {
    healthLog.push({ at: Date.now(), ...rec })
    while (healthLog.length > 12) healthLog.shift()
    writeFileSync(
      join(here, 'page', 'health.js'),
      '// 由插件运行时写入：最近几次 provider.models() 的调用结果\nself.NEARTOKEN_HEALTH = ' + JSON.stringify({ at: Date.now(), recent: healthLog }) + '\n',
      'utf8',
    )
  } catch { /* 只读安装就跳过诊断 */ }
}

/** money 把 quota 折成站点显示的那笔钱。 */
function money(quota, cur) {  const base = quota / (cur.per > 0 ? cur.per : 1)
  return (cur.display && cur.rate > 0 ? base * cur.rate : base).toFixed(2)
}

/** text 是带符号的一笔钱。 */
function text(quota, cur) {
  return cur.symbol + money(quota, cur)
}

/** 倍率的写法：0.1 → 0.1，1 → 1。 */
const ratioText = (v) => String(Math.round(v * 10000) / 10000)

/** ratioOf 是分组倍率，没给就是 0。 */
const ratioOf = (ratios, name) => (Number(ratios?.[name]) > 0 ? Number(ratios[name]) : 0)

/** 站点自己的约定：带 -c 后缀的模型工具调用不可靠，一律不给。 */
/**
 * kindOf 按站点给的字段判断一个模型属于哪一类。
 *
 * 站点在 /api/pricing 里已经标好了端点类型和分组名，不需要猜模型名字：
 *   image-generation → 生图，openai-video → 视频（omni / sd2.0 / sd2.5 /
 *   minimax-h3 都是这一类，名字里一个视频关键词都没有），分组里的 TTS /
 *   ASR / Suno → 语音，向量模型分组 → 向量，其余 → 对话。
 */
function kindOf(row) {
  const ends = Array.isArray(row?.supported_endpoint_types) ? row.supported_endpoint_types : []
  const groups = Array.isArray(row?.enable_groups) ? row.enable_groups.join(' ') : ''
  const text = (String(row?.model_name || '') + ' ' + groups + ' ' + String(row?.description || '')).toLowerCase()
  if (ends.includes('image-generation')) return 'image'
  if (ends.includes('openai-video') || /(^|[-_])video([-_]|$)|veo|seedance|sora|kling/i.test(text)) return 'video'
  if (/tts|text-to-speech|asr|speech|whisper|suno|audio|语音|转文字/i.test(text)) return 'audio'
  if (/embedding|embed|rerank|向量/i.test(text)) return 'embedding'
  return 'chat'
}

/** 系列顺序：供应商列表按它排（Claude→GPT→Gemini→Grok→Kimi→GLM→Qwen→DeepSeek）。 */
const SERIES_WORDS = [
  ['Claude', /anthropic|claude/i],
  ['GPT', /openai|gpt/i],
  ['Gemini', /google|gemini/i],
  ['Grok', /xai|grok/i],
  ['Kimi', /moonshot|kimi/i],
  ['GLM', /智谱|zhipu|glm/i],
  ['Qwen', /阿里巴巴|alibaba|qwen|通义/i],
  ['DeepSeek', /deepseek|kimseek|ds-/i],
]
const SERIES_ORDER = ['Claude', 'GPT', 'Gemini', 'Grok', 'Kimi', 'GLM', 'Qwen', 'DeepSeek', '其他']

/** kindRank：对话在前，功能模型（图片→视频→音频→向量）在后。 */
function kindRank(row) {
  const k = kindOf(row)
  return k === 'chat' ? 0 : 1 + ['image', 'video', 'audio', 'embedding'].indexOf(k)
}

/** seriesRank：按 vendors 表名称 + 模型名认系列，没命中落「其他」。 */
function seriesRank(row, vendors) {
  const v = (vendors || []).find((x) => String(x.id) === String(row?.vendor_id))
  const text = (v?.name || '') + ' ' + String(row?.model_name || '')
  for (let i = 0; i < SERIES_WORDS.length; i++) if (SERIES_WORDS[i][1].test(text)) return i
  return SERIES_ORDER.length - 1
}

/** kindOutput 是 magpie 的 capabilities.output：分区靠它认。 */
function kindOutput(kind) {
  switch (kind) {
    case 'image': return { image: true, text: true }
    case 'video': return { video: true, text: true }
    case 'audio': return { audio: true, text: true }
    case 'embedding': return { embedding: true, text: true }
    default: return { text: true }
  }
}

/**
 * 目录：把 /api/pricing 展开成 magpie 的模型表。
 *
 * 一个模型在几个分组里就是几行，id 里带组 ref（`#7::grok-4.6`），名字是
 * 「站点原文组名 + 倍率 + 模型」。每行带自己的 x-neartoken-group 头，请求
 * 按那一行走那一组——这就是"模型后面跟着它的分组"。
 */
/**
 * readBundledPricing 读包内静态快照，转成 /api/pricing 的 env 形状。
 * 快照里模型用 name，站点用 model_name，这里补回去；其余目录字段按同名映射。
 */
function readBundledPricing() {
  try {
    const raw = readFileSync(join(here, 'page', 'pricing.js'), 'utf8')
    const body = raw.slice(raw.indexOf('=') + 1).trim().replace(/;\s*$/, '')
    const snap = JSON.parse(body)
    const models = Array.isArray(snap?.models) ? snap.models : []
    if (!models.length) return null
    const data = models.map((m) => {
      const row = { ...m }
      delete row.name
      row.model_name = m.name
      return row
    })
    return {
      data,
      group_ratio: snap.groups && typeof snap.groups === 'object' ? snap.groups : {},
      group_refs: snap.refs && typeof snap.refs === 'object' ? snap.refs : {},
      usable_group: snap.notes && typeof snap.notes === 'object' ? snap.notes : {},
      auto_groups: Array.isArray(snap.auto) ? snap.auto : [],
      vendors: Array.isArray(snap.vendors) ? snap.vendors : [],
      supported_endpoint: snap.endpoints && typeof snap.endpoints === 'object' ? snap.endpoints : {},
      pricing_version: snap.version || '',
    }
  } catch { return null }
}

/**
 * loadPricingEnv 先取站点实时目录；失败或返回空时用包内快照兜底。
 * 插件在场时宿主完全依赖 provider.models() 给模型表，一次网络抖动不该让
 * 整张模型表消失（表现为供应商从列表掉下、要重新连接）。
 */
/**
 * 目录环境缓存。宿主在页面改 options 后会立刻重新列举供应商模型，
 * 那一次列举必须快：这里先给缓存或包内快照，实时目录在后台刷新。
 * 之前每次列举都直接打 /api/pricing（外加 npm 版本探测），网络一慢就被宿主判成
 * 「供应商没模型」，表现出来就是改一个模型供应商就掉。
 */
let envCache = null
let envCacheAt = 0
let envBusy = false
const ENV_TTL = 90_000

async function fetchLiveEnv() {
  try {
    const [env, status] = await Promise.all([
      call('/api/pricing'),
      call('/api/status').catch(() => null),
    ])
    if (Array.isArray(env?.data) && env.data.length) return { env, status, bundled: false }
  } catch { /* 落到包内快照 */ }
  const snap = readBundledPricing()
  return snap ? { env: snap, status: null, bundled: true } : { env: { data: [] }, status: null, bundled: true }
}

function refreshEnvInBackground() {
  if (envBusy) return
  envBusy = true
  fetchLiveEnv()
    .then((next) => {
      if (Array.isArray(next?.env?.data) && next.env.data.length) {
        envCache = next
        envCacheAt = Date.now()
      }
    })
    .catch(() => { /* 后台失败保持旧缓存 */ })
    .finally(() => { envBusy = false })
}

async function loadPricingEnv() {
  const fresh = envCache && Date.now() - envCacheAt < ENV_TTL
  if (envCache && fresh) return envCache
  if (envCache) {
    // 有旧缓存：先用它并后台刷新，这次列举绝不等网络
    refreshEnvInBackground()
    return envCache
  }
  // 冷启动也绝不赌网络：宿主等不起。先给包内快照（毫秒级），实时目录后台补。
  // 改 options 会让宿主重建插件宿主进程，缓存随之清空——这一等就足以让宿主
  // 把供应商判成「没有模型」，表现出来就是改一个开关供应商就掉。
  const snap = readBundledPricing()
  envCache = snap ? { env: snap, status: null, bundled: true } : { env: { data: [] }, status: null, bundled: true }
  envCacheAt = Date.now()
  refreshEnvInBackground()
  return envCache
}

/** 按模型实际支持的端点选 API 方言，决定网关用什么协议把它发出去。 */
function npmOf(row) {
  const ends = Array.isArray(row?.supported_endpoint_types) ? row.supported_endpoint_types.map(String) : []
  if (ends.includes('openai') || ends.includes('openai-response') || ends.includes('image-generation') || ends.includes('openai-video')) {
    return '@ai-sdk/openai-compatible'
  }
  if (ends.includes('anthropic')) return '@ai-sdk/anthropic'
  if (ends.includes('gemini')) return '@ai-sdk/google'
  if (ends.includes('jina-rerank') || ends.includes('embedding')) return '@ai-sdk/openai-compatible'
  return '@ai-sdk/openai-compatible'
}

/** 读页面写下的偏好文件（page/prefs.json）；不存在或坏掉就当作没有偏好。 */
function readPrefs() {
  try {
    const raw = readFileSync(join(here, 'page', 'prefs.json'), 'utf8')
    const j = JSON.parse(raw)
    return j && typeof j === 'object' ? j : {}
  } catch { return {} }
}

/** 模型 → 分组 ref。请求不在 catalog 里，靠这张表补 x-neartoken-group。 */
const groupRefOf = new Map()

async function catalogUnsafe(disabledGroups = new Set(), disabledModels = new Set(), enabledByGroup = new Map(), disabledByGroup = new Map(), ignorePrefs = false) {
  const groupsOut = new Map()
  const { env, status, bundled } = await loadPricingEnv()
  const rows = Array.isArray(env?.data) ? env.data : []
  // 页面偏好：模型 → 被停用的分组。放在请求外读一次，不阻塞也不触怒宿主。
  const prefs = ignorePrefs ? {} : readPrefs()
  const prefsDisabled = (() => {
    const out = new Map()
    const raw = prefs?.disabledByGroup
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [name, list] of Object.entries(raw)) {
        if (Array.isArray(list) && list.length) out.set(String(name), new Set(list.map(String)))
      }
    }
    return out
  })()
  const refs = env?.group_refs && typeof env.group_refs === 'object' ? env.group_refs : {}
  const ratios = env?.group_ratio && typeof env.group_ratio === 'object' ? env.group_ratio : {}
  const vendors = Array.isArray(env?.vendors) ? env.vendors : []
  // 完整快照给模型广场：页面按它一比一重绘站点 /pricing
  if (!bundled) writePricing(env, status?.success ? status.data : undefined)
  // 供应商列表的模型顺序：LLM 按系列 Claude→GPT→Gemini→Grok→Kimi→GLM→Qwen→DeepSeek，
  // 功能模型排在后面（图片→视频→音频→向量）。用 vendors 表名称 + 端点实时推导。
  const ordered = rows.slice().sort((a, b) => {
    const ka = kindRank(a), kb = kindRank(b)
    return ka - kb || seriesRank(a, vendors) - seriesRank(b, vendors)
      || String(a?.model_name || '').localeCompare(String(b?.model_name || ''))
  })
  const out = {}
  for (const row of ordered) {
    const model = String(row?.model_name ?? '').trim()
    if (!model) continue
    const kind = kindOf(row)
    const all = Array.isArray(row?.enable_groups) && row.enable_groups.length ? row.enable_groups : ['']
    // 先按「全部分组」计数（关掉的也算），模型广场要显示它有多少个模型
    for (const raw of all) {
      const g = String(raw ?? '').trim()
      if (!g) continue
      const had = groupsOut.get(g)
      groupsOut.set(g, { name: g, ratio: 0, models: (had?.models || 0) + 1, ref: '' })
    }
    const groups = all.filter((g) => {
      const name = String(g ?? '').trim()
      if (!name || disabledGroups.has(name)) return false
      // 页面偏好（文件）里被停用的分组才排除；文件不存在时不过滤
      if (prefsDisabled.has(model) && prefsDisabled.get(model).has(name)) return false
      return true
    })
    if (!groups.length) continue
    // 一个模型只出一行：多分组不再展开成多行，否则「只启用一个模型」在
    // 供应商列表里仍会冒出五六行同名条目。分组与倍率折进显示名里，
    // 请求按该模型最便宜（倍率最低）的分组走。
    const ranked = groups.map((g) => ({
      name: String(g ?? '').trim(),
      ref: String(g ?? '').trim() && refs[String(g ?? '').trim()] ? String(refs[String(g ?? '').trim()]) : '',
      ratio: ratioOf(ratios, String(g ?? '').trim()),
    })).sort((a, b) => (a.ratio || 1e9) - (b.ratio || 1e9))
    const main = ranked[0] || { name: '', ref: '', ratio: 0 }
    const label = model
    const mods = Array.isArray(row?.input_modalities) && row.input_modalities.length
      ? row.input_modalities.map((x) => String(x).toLowerCase())
      : ['text']
    const inputCap = {
      text: mods.includes('text'),
      image: mods.includes('image'),
      audio: mods.includes('audio'),
      video: mods.includes('video'),
      pdf: mods.includes('pdf'),
    }
    // 记下这一行实际走的分组，fetch 时补头用
    groupRefOf.set(model, main.ref || '')
    out[model] = {
      // OpenCode 的 Model 形状：id + name 都要给，宿主按 id 取、按 name 显示
      id: model,
      name: label,
      api: { id: model, url: SITE + '/v1', npm: npmOf(row) },
      limit: {
        context: Number(row?.context_window) > 0 ? Number(row.context_window) : 0,
        output: Number(row?.max_tokens) > 0 ? Number(row.max_tokens) : 0,
      },
      ...(main.ref ? { headers: { 'x-neartoken-group': main.ref } } : {}),
      // 站点自己的分类，交给 magpie 的四个分区（图像/视频/语音/向量）
      ...(kind === 'chat' ? {} : { kind }),
      capabilities: {
        toolcall: true,
        output: kindOutput(kind),
        // 站点给了图片/PDF 输入就允许附件，别再让宿主一律按纯文本对待
        attachment: !!(inputCap.image || inputCap.pdf),
        input: inputCap,
        // 对话模型声明 reasoning，配合下面的 variants，宿主才给「思考强度」档位
        ...(kind === 'chat' ? { reasoning: true } : {}),
      },
      // variants 的键就是 reasoning 档位；缺了它宿主只会显示「—」
      ...(kind === 'chat' ? { variants: { low: {}, medium: {}, high: {} } } : {}),
    }
  }
  if (!bundled) writeGroups([...groupsOut.values()].map((g) => ({
    ...g,
    ratio: ratioOf(ratios, g.name),
    ref: refs[g.name] ? String(refs[g.name]) : '',
  })).sort((a, b) => a.name.localeCompare(b.name, 'zh')))
  return out
}

/**
 * catalog 是给宿主看的稳定入口：无论内部发生什么，都返回非空模型表。
 *
 * 掉供应商的根因是宿主拿不到模型表就判定「这个供应商没有模型」。所以这里
 * 有三层兜底，任何一层失败都不会把异常或空表抛给宿主：
 *   1. 正常构建；
 *   2. 异常时用包内快照重建一次（不带页面偏好过滤）；
 *   3. 仍为空则直接用包内快照的原始模型名，最差也要把模型表撑起来。
 */
async function catalog(disabledGroups, disabledModels, enabledByGroup, disabledByGroup) {
  try {
    const out = await catalogUnsafe(disabledGroups, disabledModels, enabledByGroup, disabledByGroup)
    if (out && Object.keys(out).length) return out
    // 空表：完全忽略页面偏好再试一次（停光所有分组时也必须给宿主非空表）
    const relaxed = await catalogUnsafe(disabledGroups, disabledModels, enabledByGroup, new Map(), true)
    if (relaxed && Object.keys(relaxed).length) return relaxed
  } catch { /* 落到下面的快照兜底 */ }
  try {
    const snap = readBundledPricing()
    const rows = Array.isArray(snap?.data) ? snap.data : []
    const out = {}
    for (const row of rows) {
      const model = String(row?.model_name ?? '').trim()
      if (!model || out[model]) continue
      out[model] = {
        id: model,
        name: model,
        api: { id: model, url: SITE + '/v1', npm: npmOf(row) },
        limit: limitOf(row),
        capabilities: { toolcall: true, output: ['text'], attachment: false, input: { text: true } },
      }
    }
    if (Object.keys(out).length) return out
  } catch { /* 连快照都读不到 */ }
  return {}
}

/**
 * writeGroups 把分组表写成 page/groups.js；writePricing 把整份站点目录写成
 * page/pricing.js，给沙箱里的页面用。
 *
 * 页面发不出网络请求（CSP connect-src 'none'），但能加载自己目录下的脚本，
 * 所以这里不推数据、只落文件：`<script src="pricing.js?t=…">` 一引就有。
 * 写不进去（插件目录只读）就跳过，页面用包内那份静态快照。
 */
function writeGroups(groups) {
  try {
    const js = 'self.NEARTOKEN_GROUPS = ' + JSON.stringify(groups) + '\nself.NEARTOKEN_GROUPS_AT = ' + Date.now() + '\n'
    writeFileSync(join(here, 'page', 'groups.js'), js, 'utf8')
  } catch {
    /* 只读安装：页面自己会说没拿到明细 */
  }
}

/**
 * writePricing 把 /api/pricing 原样裁成模型广场需要的形状，写成 page/pricing.js。
 * 与包内那份静态快照同形状，页面优先用这份（实时），静态那份只是首次兜底。
 */
function writePricing(env, status) {
  try {
    const keep = ['description', 'tags', 'icon', 'vendor_id', 'enable_groups', 'supported_endpoint_types',
      'model_ratio', 'model_price', 'completion_ratio', 'cache_ratio', 'create_cache_ratio',
      'quota_type', 'billing_mode', 'billing_expr', 'context_window', 'max_tokens',
      'input_modalities', 'reasoning_levels', 'image_ratio', 'audio_ratio', 'audio_completion_ratio',
      'billing_usage_schema', 'billing_usage_examples', 'billing_disabled_usage', 'billing_plugin_variants']
    // 包内快照里带了一批站点 /pricing 页面的描述与运行状态（/api/pricing 没给）。
    // 实时刷新时把它们并回来，别让刷新把首屏说明冲掉。
    const extra = new Map()
    let previousCurrency
    try {
      const old = readFileSync(join(here, 'page', 'pricing.js'), 'utf8')
      const raw = old.slice(old.indexOf('=') + 1).trim().replace(/;\s*$/, '')
      const prev = JSON.parse(raw)
      previousCurrency = prev?.currency
      for (const m of prev?.models || []) {
        const x = {}
        for (const k of ['description', 'status', 'latency', 'throughput']) if (m[k] !== undefined) x[k] = m[k]
        if (Object.keys(x).length) extra.set(m.name, x)
      }
    } catch { /* 没有旧快照就只用 API 字段 */ }
    const models = (Array.isArray(env?.data) ? env.data : []).map((m) => {
      const name = String(m?.model_name ?? '')
      const o = { name }
      for (const k of keep) if (m[k] !== undefined && m[k] !== null && m[k] !== '') o[k] = m[k]
      // API 里没有 description 时，用页面快照里的那段说明
      if (!o.description && extra.get(name)?.description) o.description = extra.get(name).description
      return Object.assign(o, extra.get(name) || {})
    })
    const currency = { ...previousCurrency }
    for (const key of ['price', 'usd_exchange_rate', 'quota_display_type', 'quota_per_unit', 'custom_currency_symbol', 'custom_currency_exchange_rate']) {
      if (status?.[key] !== undefined) currency[key] = status[key]
    }
    const snap = {
      ...(Object.keys(currency).length ? { currency } : {}),
      at: Date.now(),
      source: 'https://neartoken.cc/api/pricing',
      version: env?.pricing_version ?? '',
      models,
      groups: env?.group_ratio ?? {},
      refs: env?.group_refs ?? {},
      notes: env?.usable_group ?? {},
      auto: env?.auto_groups ?? [],
      vendors: env?.vendors ?? [],
      endpoints: env?.supported_endpoint ?? {},
    }
    writeFileSync(join(here, 'page', 'pricing.js'),
      '// 由插件运行时从 /api/pricing 写入\nself.NEARTOKEN_PRICING = ' + JSON.stringify(snap) + '\n', 'utf8')
  } catch {
    /* 只读安装：用包内静态快照 */
  }
}

/**
 * writeAff 把 wallet 应答里的邀请/推荐字段写成 page/aff.js。
 * 页面沙箱发不出请求，靠加载这个脚本读实时值；字段名按站点常见写法都认。
 */
function writeAff(d) {
  try {
    const pick = (...keys) => {
      for (const k of keys) if (d[k] !== undefined && d[k] !== null && d[k] !== '') return d[k]
      return undefined
    }
    const snap = {
      at: Date.now(),
      invites: pick('aff_count', 'affCount', 'invite_count', 'invite_num', 'invites', 'referral_count', 'aff_invite_count'),
      affCode: pick('aff_code', 'affCode', 'referral_code', 'aff'),
      affQuota: pick('aff_quota', 'affQuota', 'aff_history_quota'),
    }
    writeFileSync(join(here, 'page', 'aff.js'),
      '// 由插件运行时从 wallet 应答写入\nself.NEARTOKEN_AFF = ' + JSON.stringify(snap) + '\n', 'utf8')
  } catch { /* 只读安装：页面退回宿主 state */ }
}

/** stampLatest 把 npm 上的最新版本写进 page/latest.js，一分钟内不重复问。 */
let latestAskedAt = 0
async function stampLatest() {
  if (Date.now() - latestAskedAt < 60_000) return
  latestAskedAt = Date.now()
  try {
    const res = await fetch('https://registry.npmjs.org/@fish-under-sea%2Fmagpie-neartoken/latest', {
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return
    const body = await res.json()
    const v = typeof body?.version === 'string' ? body.version.trim() : ''
    if (!v) return
    writeFileSync(
      join(here, 'page', 'latest.js'),
      'self.NEARTOKEN_LATEST = ' + JSON.stringify(v) + '\nself.NEARTOKEN_LATEST_AT = ' + Date.now() + '\n',
      'utf8',
    )
  } catch {
    /* 问不到就保持原样：页面会说「没查到」 */
  }
}

/** 缓存 getAuth：定时同步邀请数时要用到站点钥匙。 */
let authGetter = null
function rememberAuth(getAuth) { if (typeof getAuth === 'function') authGetter = getAuth }

/**
 * fetchAff 主动拉一次站点用户资料，把邀请数/推荐码写进 page/aff.js。
 * 页面沙箱发不出请求，靠加载这个脚本读实时值。
 */
async function fetchAff() {
  if (!authGetter) return
  try {
    const auth = await authGetter()
    const key = auth?.access || auth?.key || ''
    if (!key) return
    let d = {}
    try {
      const r = await call('/api/user/self', { key })
      if (r?.success === true && r?.data && typeof r.data === 'object') d = { ...r.data }
    } catch { /* 站点不认这把钥匙就用 wallet 兜底 */ }
    try {
      const w = await call('/api/dsh/device/wallet', { key })
      if (w?.success === true && w?.data && typeof w.data === 'object') d = { ...w.data, ...d }
    } catch { /* 已有资料就够 */ }
    if (Object.keys(d).length) writeAff(d)
  } catch { /* 拿不到就保持上次的值 */ }
}

/**
 * writeLogs 把逐条日志写成 page/logs.js。
 * 页面沙箱 connect-src 为 none，只能靠加载这个脚本读实时流水。
 */
function writeLogs(rows) {
  try {
    writeFileSync(
      join(here, 'page', 'logs.js'),
      '// 由插件运行时从站点日志接口写入\nself.NEARTOKEN_LOGS = ' + JSON.stringify({ at: Date.now(), rows }) + '\n',
      'utf8',
    )
  } catch { /* 只读安装就跳过 */ }
}

/**
 * pickModel 取模型名。
 * 站点不同版本会把它给成字符串或对象（{ name, id }），
 * 对象直接插进页面会显示 [object Object]，这里统一解包。
 */
function pickModel(...candidates) {
  for (const v of candidates) {
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (v && typeof v === 'object') {
      const inner = v.name ?? v.id ?? v.model ?? v.model_name
      if (typeof inner === 'string' && inner.trim()) return inner.trim()
    }
  }
  return ''
}

/** num 把站点可能给的字符串数字转成数字。 */
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * firstToken 取「首字耗时」秒数。
 * new-api 把它放在 other.frt：多数版本是毫秒，个别是秒。
 * 判断依据：首字通常 < 30 秒，所以数值 > 30 一定是毫秒。
 */
function firstToken(rec) {
  let other = rec?.other
  if (typeof other === 'string') {
    try { other = JSON.parse(other) } catch { other = null }
  }
  const raw = num(other?.frt) ?? num(other?.first_response_time) ?? num(other?.first_token_time)
  if (raw === undefined) return undefined
  return raw > 30 ? raw / 1000 : raw
}

/**
 * fmtStamp 把秒级时间戳格式化成 `2026-11-06 06:04:04`。
 * 不能用 toLocaleString：它给的是 `2026-11-6 6:04:04`，月日不补零，
 * 与站点显示不一致。
 */
function fmtStamp(sec) {
  const d = new Date(sec * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * fetchLogs 拉站点逐条日志，归一化成页面要的形状写进 page/logs.js。
 * 优先 /api/log/token（按 API key 查，插件正好有这把钥匙）；
 * 站点若只给 /api/log/self（需要登录会话），这里会自动退回。
 */
/** quotaPerUnit 站点每 1 美元对应的额度；实测 /api/status 给 500000。 */
let quotaPerUnit = 500000
async function readQuotaPerUnit() {
  try {
    const env = await call('/api/status')
    const d = env?.data ?? env
    const v = num(d?.quota_per_unit)
    if (v && v > 0) quotaPerUnit = v
  } catch { /* 拿不到就用默认 500000 */ }
}

async function fetchLogs() {
  if (!authGetter) return
  try {
    const auth = await authGetter()
    const key = auth?.access || auth?.key || ''
    if (!key) return
    await readQuotaPerUnit()
    let list = null
    for (const path of ['/api/log/token?p=0&page_size=100', '/api/log/self?p=0&page_size=100']) {
      try {
        const env = await call(path, { key })
        const d = env?.data
        const items = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : Array.isArray(d?.data) ? d.data : null
        if (items && items.length) { list = items; break }
      } catch { /* 换下一个端点 */ }
    }
    if (!list) return
    const rows = list.map((r) => {
      const other = (() => {
        let o = r?.other
        if (typeof o === 'string') { try { return JSON.parse(o) } catch { return null } }
        return o || null
      })()
      const t = num(r?.created_at) || num(r?.createdAt) || 0
      // 各字段按 new-api 常见写法逐个兜底，避免整列为空
      const prompt = num(r?.prompt_tokens) ?? num(r?.promptTokens) ?? num(other?.prompt_tokens)
      const completion = num(r?.completion_tokens) ?? num(r?.completionTokens) ?? num(other?.completion_tokens)
      const secs = num(r?.use_time) ?? num(r?.useTime) ?? num(other?.use_time)
      const quota = num(r?.quota) ?? num(other?.quota)
      return {
        at: t,
        time: t ? fmtStamp(t) : '',
        kind: '消耗',
        tokenName: r?.token_name || r?.tokenName || '',
        group: r?.group || other?.group || '',
        model: pickModel(r?.model_name, r?.modelName, other?.model_name),
        upModel: pickModel(other?.upstream_model, other?.up_model, other?.request_model),
        respModel: pickModel(other?.response_model, other?.downstream_model),
        effort: other?.reasoning_effort || '',
        // 吞吐 = 输出 token / 生成耗时（总时长减去首字等待）。
        // 用总时长做分母会明显偏低（上游 144 t/s 会算成 16）。
        tps: completion && secs
          ? (() => {
            const ttft = firstToken(r)
            const gen = ttft !== undefined && secs > ttft ? secs - ttft : secs
            return gen > 0 ? Math.round(completion / gen) : undefined
          })()
          : undefined,
        input: prompt,
        output: completion,
        cache: num(r?.cache_tokens) ?? num(other?.cache_tokens),
        bytes: num(r?.request_size) ?? num(other?.request_size) ?? num(other?.req_size),
        quota,
        // 费用 = 额度 / 每美元额度；站点是 ¥ 计价且汇率 1，故直接按 ¥ 显示
        cost: quota === undefined ? '' : '¥' + (quota / quotaPerUnit).toFixed(6),
        ttft: firstToken(r),
        dur: secs,
        detail: [other?.billing_mode, other?.group_ratio ? '×' + other.group_ratio : '', other?.model_ratio ? 'model ×' + other.model_ratio : '']
          .filter(Boolean).join(' · '),
        isStream: r?.is_stream ?? r?.isStream,
      }
    })
    // 最新在最上面：按时间显式降序，不依赖站点返回顺序
    rows.sort((x, y) => (y.at || 0) - (x.at || 0))
    writeLogs(rows)
  } catch { /* 拿不到就保持上次的流水 */ }
}

/**
 * scheduleCatalogSync 后台定时刷新目录快照与邀请数据，一个进程只起一个定时器。
 * 拉全量（不带禁用参数）写 page/pricing.js，禁用状态由页面自己管。
 */
let catalogTimer = null
function scheduleCatalogSync() {
  if (catalogTimer) return
  const tick = () => {
    catalog(new Set(), new Set()).catch(() => {})
    fetchAff().catch(() => {})
    fetchLogs().catch(() => {})
  }
  tick()
  catalogTimer = setInterval(tick, 5 * 60 * 1000)
  if (typeof catalogTimer.unref === 'function') catalogTimer.unref()
}

export default async function neartoken(input, options) {
  // 页面写进来的开关：关掉的分组，以及关掉的模型。
  // 走 magpie 的 plugin options（页面 magpie.options.set），不碰宿主代码。
  // 默认全选：options 里没有 disabledModels 时，一个都不关。
  const asSet = (raw) => {
    if (Array.isArray(raw)) return new Set(raw.filter((x) => typeof x === 'string'))
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw)
        return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [])
      } catch {
        return new Set()
      }
    }
    return new Set()
  }
  const disabledGroups = asSet(options?.disabledGroups)
  const disabledModels = asSet(options?.disabledModels)
  /**
   * 分组级状态。disabledByGroup 是主用的例外表（模型 → 被停用的分组）；
   * enabledByGroup 是 0.6.7 早期写法，仍兼容但只在形状合法时采用。
   * 任何形状不合法都当作「没有记录」，退回默认（该模型所有分组都可用），
   * 绝不让一条坏数据把模型整体判成停用——那会直接表现为供应商掉出。
   */
  function readGroupMap(raw) {
    if (typeof raw === 'string' && raw.trim()) {
      try { raw = JSON.parse(raw) } catch { return new Map() }
    }
    const map = new Map()
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map
    for (const [name, list] of Object.entries(raw)) {
      if (!name || !Array.isArray(list)) continue
      const groups = list.map((g) => String(g ?? '').trim()).filter(Boolean)
      if (groups.length) map.set(String(name), new Set(groups))
    }
    return map
  }
  const disabledByGroup = readGroupMap(options?.disabledByGroup)
  const enabledByGroup = readGroupMap(options?.enabledByGroup)
  // 后台每 5 分钟把 /api/pricing 再拉一遍写回 page/pricing.js，
  // 页面每分钟重载该文件——模型清单与分组就跟着站点实时同步。
  scheduleCatalogSync()
  return {
    /**
     * config 声明 provider 的对外显示名。
     * 宿主列表里显示 @NearToken，点进详情显示 npm 包名 @fish-under-sea/magpie-neartoken。
     */
    async config(cfg) {
      // 任何一步失败都不能让 provider 消失：宿主拿不到声明就当成没这个供应商。
      try {
        if (!cfg || typeof cfg !== 'object') return
        cfg.provider ??= {}
        cfg.provider[PROVIDER_ID] ??= {}
        const p = cfg.provider[PROVIDER_ID]
        p.name = 'NearToken'
        // 不要声明 models：空对象会被理解成「这个供应商声明的模型是 0 个」。
        // 模型表统一由 provider.models() 提供，避免两套来源打架。
        if (!p.npm) p.npm = '@ai-sdk/openai-compatible'
        if (!p.api) p.api = SITE + '/v1'
        delete p.models
      } catch { /* 声明失败也不能抛 */ }
    },
    auth: {
      provider: PROVIDER_ID,
      ...(ICON ? { icon: ICON } : {}),
      methods: [
        {
          type: 'oauth',
          label: 'NearToken（设备授权）',
          /**
           * 向站点要一个确认码；人自己去站点确认。插件不碰密码。
           * @returns {Promise<{url: string, instructions: string}>}
           */
          async authorize() {
            const env = await call('/api/dsh/device/authorize', {
              method: 'POST',
              body: { client_name: CLIENT_NAME, token_name: TOKEN_NAME },
            })
            if (env?.success !== true) throw new Error('站点拒绝发起设备授权：' + (env?.message || '未知原因'))
            const d = env.data ?? {}
            if (!d.device_code || !d.user_code || !d.verification_uri) {
              throw new Error('设备授权应答缺少 device_code / user_code / verification_uri')
            }
            pending = {
              deviceCode: d.device_code,
              interval: Math.max(1, Number(d.interval) || 5) * 1000,
              expiresAt: Date.now() + (Number(d.expires_in) || 600) * 1000,
            }
            return {
              url: affURL(d.verification_uri_complete || d.verification_uri),
              instructions: `在站点上确认这个码：${d.user_code}（登录用你平时的方式，插件不收密码）`,
            }
          },
          /** 轮询结果，直到批准、拒绝或过期。 */
          async callback() {
            if (!pending) throw new Error('没有进行中的授权，请重新开始')
            while (Date.now() < pending.expiresAt) {
              await new Promise((r) => setTimeout(r, pending.interval))
              const env = await call('/api/dsh/device/token', { method: 'POST', body: { device_code: pending.deviceCode } })
              if (env?.success === true) {
                const grant = grantOf(env.data)
                pending = null
                return grant
              }
              switch (env?.message) {
                case 'authorization_pending':
                  continue
                case 'slow_down':
                  pending.interval += 2000
                  continue
                case 'access_denied':
                  pending = null
                  throw new Error('站点上拒绝了这次授权')
                case 'expired_token':
                  pending = null
                  throw new Error('授权已过期，请重新连接')
                default:
                  throw new Error('设备授权轮询返回了未知状态：' + (env?.message || '（空）'))
              }
            }
            pending = null
            throw new Error('授权已过期，请重新连接')
          },
        },
      ],
      /** 余额：站点钱包端点，按 magpie 的用量卡显示。 */
      async usage(getAuth) {
        rememberAuth(getAuth)
        await stampLatest()
        const auth = await getAuth()
        const key = auth?.access || auth?.key
        if (!key) throw new Error('还没有连接 NearToken')
        const [cur, env] = await Promise.all([currency(), call('/api/dsh/device/wallet', { key })])
        if (env?.success !== true) throw new Error('读取余额失败：' + (env?.message || '站点拒绝'))
        const d = env.data ?? {}
        const used = Number(d.used_quota) || 0
        // 把站点给的推荐信息透给页面（页面不能 fetch，靠这个脚本读）
        writeAff(d)
        return {
          user: typeof d.username === 'string' ? d.username : '',
          balance: text(Number(d.quota) || 0, cur),
          windows: [{ name: '已用', display: text(used, cur) }],
        }
      },
      /** 请求带着这把钥匙出去；分组头由每个模型自己带（见 catalog）。 */
      async loader(getAuth) {
        rememberAuth(getAuth)
        const auth = await getAuth()
        const key = auth?.access || auth?.key || ''
        return {
          apiKey: key,
          baseURL: SITE + '/v1',
          fetch: async (input, init) => {
            const body = init?.body
            if (typeof body !== 'string') return fetch(input, init)
            let parsed
            try { parsed = JSON.parse(body) } catch { return fetch(input, init) }
            let touched = false
            const raw = parsed?.model
            let model = typeof raw === 'string' ? raw : ''
            // 旧格式 model 里可能带 `#ref::` 前缀，拆掉
            let ref = ''
            if (model.includes('::')) {
              const [r, m] = model.split('::')
              if (r.startsWith('#')) ref = r
              model = m
              parsed.model = m
              touched = true
            }
            const headers = new Headers(init?.headers || {})
            // 站点必须收到分组头才按对应渠道分发；收不到会回落 default 组，
            // 那边常常没有渠道，于是 503「No available channel for model … under group default」。
            if (!ref) ref = groupRefOf.get(model) || ''
            if (ref) { headers.set('x-neartoken-group', ref); touched = true }
            if (!touched) return fetch(input, init)
            return fetch(input, { ...init, body: JSON.stringify(parsed), headers })
          },
        }
      },
    },
    provider: {
      id: PROVIDER_ID,
      /**
       * 模型表：一个「分组 × 模型」一行。
       * @returns {Promise<Record<string, object>>}
       */
      async models() {
        // 版本探测放到后台：它要访问 npm registry，绝不能挡住宿主列举模型
        try { void stampLatest() } catch { /* 版本探测失败不影响模型表 */ }
        const startedAt = Date.now()
        // 最后一层保险：catalog 已自带兜底，这里再挡一次，
        // 保证永远不向宿主抛 rejected Promise（抛了宿主就判「没有模型」→ 掉供应商）
        try {
          const out = await catalog(disabledGroups, disabledModels, enabledByGroup, disabledByGroup)
          const safe = out && typeof out === 'object' ? out : {}
          writeHealth({ ok: true, count: Object.keys(safe).length, ms: Date.now() - startedAt })
          return safe
        } catch (error) {
          writeHealth({ ok: false, count: 0, ms: Date.now() - startedAt, error: String(error && error.message ? error.message : error) })
          return {}
        }
      },
    },
  }
}