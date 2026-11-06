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
  const ends = (Array.isArray(row?.supported_endpoint_types) ? row.supported_endpoint_types : []).map((x) => String(x))
  const groupNames = Array.isArray(row?.enable_groups) ? row.enable_groups.map((g) => String(g ?? '')).join(' ') : ''
  const groups = groupNames.toLowerCase()
  const name = String(row?.model_name || '')
  const desc = String(row?.description || '')

  if (ends.includes('image-generation')) return 'image'
  if (ends.includes('openai-video')
    || /(^|[-_])video([-_]|$)|veo|seedance|sora|kling/i.test(name + ' ' + groupNames + ' ' + desc)) return 'video'

  // 语音：只看输出侧。端点类型或分组名说了算，模型名不参与——
  // gpt-4o-audio-preview 这类「能听音频、输出仍是文本」的对话模型不能被卷进来。
  if (ends.some((e) => /^(audio|tts|asr|transcription|speech)$/i.test(e))) return 'audio'
  if (/tts|asr|text-to-speech|speech|suno|语音|转文字/i.test(groups)) return 'audio'

  // 向量：同样以端点类型与分组为准；模型名只认完整的 embedding 词，
  // 不用裸 embed（那会把其它词里的 embed 也算进去）。
  if (ends.some((e) => /^(embedding|jina-rerank|rerank)$/i.test(e))) return 'embedding'
  if (/embedding|向量|rerank/i.test(groups)) return 'embedding'
  if (/embedding/i.test(name)) return 'embedding'

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

/** 模型 → 分组 ref。请求不在 catalog 里，靠这张表补 x-neartoken-group。 */
const groupRefOf = new Map()

async function catalogUnsafe() {
  const groupsOut = new Map()
  const { env, status, bundled } = await loadPricingEnv()
  // bundled 为真表示这份数据来自包内快照（冷启动或站点抓取失败），不是实时
  lastCatalogBundled = Boolean(bundled)
  const rows = Array.isArray(env?.data) ? env.data : []
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
      // 停用与否由宿主的 modelFilter（neartoken-prefs.json）负责，插件不再二次过滤：
      // 两份真相最容易互相打架——一边剔光、一边还留着，表现就是「模型数忽多忽少」。
      return Boolean(name)
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
/**
 * 上一次「站点实时」拿到的模型表 + 本次数据来源。
 *
 * 宿主的 KeepPluginsListed 每次重列都会对比前后两次列表：少了哪个模型，
 * 就把用户对这个模型的选择移除（dropGonePluginPicks），并把下次重列提前到
 * 5 分钟后 —— 用户看到的就是「过几分钟供应商掉一次」。
 *
 * 所以这里要保证两件事：
 *   1. 列表单调不减：站点偶发少给几个模型时，用上一次的补齐；
 *   2. 本次不是实时数据时，在返回表上打 magpie.fellBack 标记，宿主据此
 *      跳过对比（pluginListedIDs 会 continue 掉 FellBack 的 provider）。
 */
let lastCatalogSource = 'empty'
let lastGoodCatalog = null
/** catalogUnsafe 这次用的数据是不是包内快照（不是站点实时）。 */
let lastCatalogBundled = true

/**
 * mergeModelsWithLastGood 用上一次实时表补齐本次缺的模型。
 *
 * 宿主 KeepPluginsListed 每次重列都对比前后两次列表：少一个模型就把用户对它的
 * 选择移除，并把下次重列提前到 5 分钟——用户看到的就是「过几分钟掉一次」。
 * 站点偶发少给几个模型时靠这里补齐，避免被误判成「模型下架」。
 */
function mergeModelsWithLastGood(table, lastGood) {
  if (!table || !lastGood) return { table, restored: 0 }
  let restored = 0
  for (const id of Object.keys(lastGood)) {
    if (!table[id]) { table[id] = lastGood[id]; restored += 1 }
  }
  return { table, restored }
}

async function catalog() {
  try {
    const out = await catalogUnsafe()
    if (out && Object.keys(out).length) {
      // bundled 时数据来自包内快照：模型集合可能过时，不能当「实时真相」
      lastCatalogSource = lastCatalogBundled ? 'snapshot' : 'live'
      return out
    }
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
    if (Object.keys(out).length) {
      lastCatalogSource = 'snapshot'
      return out
    }
  } catch { /* 连快照都读不到 */ }
  lastCatalogSource = 'empty'
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

/** logsAskedAt 是逐条日志最近一次补抓的时间，models() 里用来节流。 */
let logsAskedAt = 0

/** 缓存 getAuth：定时同步邀请数时要用到站点钥匙。 */
let authGetter = null
function rememberAuth(getAuth) { if (typeof getAuth === 'function') authGetter = getAuth }
/**
 * sessionKey 是本次连接拿到的令牌（只放内存，不落盘）。
 *
 * 宿主只在「要余额」或「发请求」时才会把 getAuth 递进来，很多使用路径两样都不发生，
 * 于是逐条日志永远拿不到钥匙。连接成功那一刻令牌本来就在手上，留一份够本进程用。
 */
let sessionKey = ''

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
 * writeLogsMeta 把「这次抓逐条日志走到哪一步」写成 page/logs-meta.js。
 *
 * 页面拿不到逐条流水时，最需要区分三件事：插件还没拿到凭据、接口失败、站点没记录。
 * 这三种在页面上是三句不同的话，不合并成一句「没有数据」。
 */
function writeLogsMeta(rec) {
  try {
    writeFileSync(
      join(here, 'page', 'logs-meta.js'),
      '// 由插件运行时写入：最近一次逐条日志抓取的结果\nself.NEARTOKEN_LOGS_META = ' + JSON.stringify({ at: Date.now(), ...rec }) + '\n',
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
 * logKindOf 把站点的日志 type 换成页面上的类型词。
 *
 * 实测 /api/log/token 的 type 是数字（当前账号全是 2），不是字符串，
 * 所以不能写死「消耗」。编码沿用站点（new-api）的既有约定：
 * 1 充值 / 2 消费 / 3 管理 / 4 系统 / 5 错误 / 6 退款；未知值原样回显。
 */
function logKindOf(type) {
  const n = Number(type)
  switch (n) {
    case 1: return '充值'
    case 2: return '消费'
    case 3: return '管理'
    case 4: return '系统'
    case 5: return '错误'
    case 6: return '退款'
    default: return typeof type === 'string' && type.trim() ? type.trim() : '消费'
  }
}

/** 数字尽量短：2 → 「2」，0.5 → 「0.5」，1.25 → 「1.25」。 */
function shortNum(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return ''
  return String(Math.round(n * 10000) / 10000)
}

/**
 * tierPrices 从计费表达式里取出某个档位的（输入, 输出）单价。
 *
 * 站点 expr 形如：
 *   len <= 272000 ? tier("0_272k", p * 2 + cr * 0.1 + cc * 2.5 + c * 10)
 *                 : tier("272k_plus", p * 4 + ... + c * 15)
 * 其中 p 是输入系数、c 是输出系数，单位都是「元 / 百万 token」。
 * 注意 cr（缓存读）和 cc（缓存写）也含字母 c，所以匹配单字符变量要用负向断言。
 */
function tierPrices(expr, wantTier) {
  if (typeof expr !== 'string' || !expr) return null
  const re = /tier\("([^"]+)"\s*,([^)]*)\)/g
  const found = []
  let m
  while ((m = re.exec(expr))) found.push({ name: m[1], body: m[2] })
  if (!found.length) return null
  const hit = (wantTier && found.find((f) => f.name === wantTier)) || found[0]
  const pick = (re2) => {
    const mm = hit.body.match(re2)
    return mm ? Number(mm[1]) : undefined
  }
  const input = pick(/(?<![a-z])p\s*\*\s*([\d.]+)/)
  const output = pick(/(?<![a-z])c\s*\*\s*([\d.]+)/)
  if (input === undefined && output === undefined) return null
  return { name: hit.name, input, output }
}

/**
 * tierLabel 把站点的档位 key 换成看得懂的词。
 *
 * off_peak / peak 是「谷时 / 峰时」时段的内部 key，直接显示像乱码；
 * 别的档位（0_272k 这类长度分层）站点自己就用这个写法，保持原样。
 */
function tierLabel(name) {
  const s = String(name || '').trim()
  if (!s) return '标准'
  const map = { off_peak: '谷时', peak: '峰时', offpeak: '谷时', standard: '标准', default: '标准' }
  return map[s.toLowerCase()] || s
}

/**
 * detailOf 拼「详情」列，形状对齐原站：`档位 · ¥输入 / ¥输出/M`。
 *
 * 价格不是倍率本身，站点有两条路：
 *  1. 表达式计费（billing_mode=tiered_expr）：解码 expr_b64，取该档位里
 *     p 与 c 的系数——实测 gpt-6.1-sol 是 ¥2 / ¥10/M，与官网一致；
 *  2. 倍率计费：输入价 = model_ratio × 2，输出价 = model_ratio × completion_ratio × 2
 *     （实测 gpt-6.1-terra：0.5 与 5 → ¥1 / ¥5/M，与官网一致）。
 * 两条都不成立时才退回额度，不编造数字。
 */
function detailOf(other, quota) {
  if (!other || typeof other !== 'object') return ''
  const tier = typeof other.matched_tier === 'string' ? other.matched_tier.trim() : ''

  // 路线 1：表达式计费
  let expr = ''
  if (typeof other.expr_b64 === 'string' && other.expr_b64) {
    try { expr = Buffer.from(other.expr_b64, 'base64').toString('utf8') } catch { expr = '' }
  }
  const priced = tierPrices(expr, tier)
  if (priced) {
    const a = priced.input !== undefined ? '¥' + shortNum(priced.input) : '—'
    const b = priced.output !== undefined ? '¥' + shortNum(priced.output) : '—'
    return `${tierLabel(priced.name || tier)} · ${a} / ${b}/M`
  }

  // 路线 2：倍率计费
  const mr = num(other.model_ratio)
  if (mr !== undefined) {
    const cr = num(other.completion_ratio)
    const inP = mr * 2
    const outP = mr * (cr !== undefined && cr > 0 ? cr : 1) * 2
    if (inP > 0 || outP > 0) return `标准 · ¥${shortNum(inP)} / ¥${shortNum(outP)}/M`
  }

  // 路线 3：什么都没有就退回额度
  if (quota !== undefined) return '额度 ' + quota
  return ''
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

async function fetchLogs(trigger = 'tick') {
  // 钥匙有两个来源：宿主递进来的 getAuth（usage / loader 钩子），
  // 或者刚刚连接时自己拿到的那把（sessionKey）。两样都没有就写原因，别静默失败。
  if (!authGetter && !sessionKey) {
    writeLogsMeta({ ok: false, stage: 'no-auth', trigger, rows: 0, error: '还没拿到站点凭据（宿主尚未调用余额或请求钩子）' })
    return
  }
  try {
    let key = sessionKey
    if (authGetter) {
      try {
        const auth = await authGetter()
        const fromHost = auth?.access || auth?.key || ''
        if (fromHost) key = fromHost
      } catch { /* 宿主没给就继续用连接时那把 */ }
    }
    if (!key) {
      writeLogsMeta({ ok: false, stage: 'no-key', trigger, rows: 0, error: '凭据里没有可用的令牌' })
      return
    }
    await readQuotaPerUnit()
    let list = null
    let lastError = ''
    for (const path of ['/api/log/token?p=0&page_size=100', '/api/log/self?p=0&page_size=100']) {
      try {
        const env = await call(path, { key })
        if (env?.success === false) lastError = String(env.message || '站点拒绝')
        const d = env?.data
        const items = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : Array.isArray(d?.data) ? d.data : null
        if (items && items.length) { list = items; break }
      } catch (error) { lastError = String(error && error.message ? error.message : error) }
    }
    if (!list) {
      writeLogsMeta({ ok: false, stage: 'no-list', trigger, rows: 0, error: lastError || '站点没有返回记录' })
      return
    }
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
        // 类型按站点 type 值映射，不写死「消耗」：1 充值 / 2 消费 / 3 管理 / 4 系统 / 5 错误 / 6 退款
        kind: logKindOf(r?.type),
        tokenName: r?.token_name || r?.tokenName || '',
        group: r?.group || other?.group || '',
        model: pickModel(r?.model_name, r?.modelName, other?.model_name),
        upModel: pickModel(other?.upstream_model, other?.up_model, other?.request_model, other?.upstream_model_name),
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
        // 详情按站点真实字段拼：计价档位 · 单价 / 单价（原站就是这个形状）
        detail: detailOf(other, quota),
        isStream: r?.is_stream ?? r?.isStream,
      }
    })
    // 最新在最上面：按时间显式降序，不依赖站点返回顺序
    rows.sort((x, y) => (y.at || 0) - (x.at || 0))
    writeLogs(rows)
    writeLogsMeta({ ok: true, stage: 'ok', trigger, rows: rows.length })
  } catch (error) {
    writeLogsMeta({ ok: false, stage: 'error', trigger, rows: 0, error: String(error && error.message ? error.message : error) })
  }
}

/**
 * scheduleCatalogSync 后台定时刷新目录快照与邀请数据，一个进程只起一个定时器。
 * 拉全量（不带禁用参数）写 page/pricing.js，禁用状态由页面自己管。
 */
let catalogTimer = null
let logsTimer = null
function scheduleCatalogSync() {
  if (catalogTimer) return
  const tick = () => {
    catalog().catch(() => {})
    fetchAff().catch(() => {})
    fetchLogs('catalog').catch(() => {})
  }
  tick()
  catalogTimer = setInterval(tick, 5 * 60 * 1000)
  if (typeof catalogTimer.unref === 'function') catalogTimer.unref()
  // 逐条日志变化比目录快得多：拿到凭据后每分钟补一次，别等 5 分钟那一轮。
  logsTimer = setInterval(() => {
    if (!authGetter) return
    fetchLogs('interval').catch(() => {})
  }, 60 * 1000)
  if (typeof logsTimer.unref === 'function') logsTimer.unref()
}

export default async function neartoken(input, options) {
  // 启停状态一律不经过插件 options：
  //   · 页面写 options 会让宿主重建插件宿主，供应商因此在列表里闪断；
  //   · 宿主的 ModelIDs（neartoken-prefs.json）已经负责把停用模型挡在清单外，
  //     插件这一层再读一份旧 options 只会制造第二个真相。
  // 参数保留是为了兼容宿主既有调用形状，内容不再参与过滤。
  void input
  void options
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
                sessionKey = grant.access || ''
                pending = null
                // 刚一登进来就把逐条日志补齐，不必等背景定时器
                fetchLogs('connect').catch(() => {})
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
        // 刚拿到凭据就补一次逐条日志：日志页不必等背景定时器那 5 分钟
        fetchLogs('usage').catch(() => {})
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
        fetchLogs('loader').catch(() => {})
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
       *
       * 宿主调用这个钩子时会带第二个参数：`{ auth, signal }`，其中的 auth 是
       * 插件凭据的副本（host.js：`ph.models(given, { auth: authCopy(k) })`）。
       * 也就是说「宿主重列模型」这个动作本身就会把令牌送到插件手上——逐条日志
       * 不需要等 reconnect，也不需要宿主另开通道。
       * @returns {Promise<Record<string, object>>}
       */
      async models(_given, ctx) {
        // 先收下宿主递来的令牌：它比「连接那一刻」可靠得多（重启后依然有）
        try {
          const a = ctx?.auth
          const k = (a && (a.access || a.key)) || ''
          if (typeof k === 'string' && k.trim()) sessionKey = k.trim()
        } catch { /* auth 形状不对就继续用已有的 */ }
        // 宿主要模型表是高频动作：凭据拿到之后顺手补一次逐条日志（60 秒节流）。
        // 有些使用路径从不触发余额卡片，没有这一条日志就永远不刷新。
        try {
          if ((authGetter || sessionKey) && Date.now() - logsAskedAt > 60_000) {
            logsAskedAt = Date.now()
            fetchLogs('models').catch(() => {})
          }
        } catch { /* 日志失败不影响模型表 */ }
        const startedAt = Date.now()
        // 最后一层保险：catalog 已自带兜底，这里再挡一次，
        // 保证永远不向宿主抛 rejected Promise（抛了宿主就判「没有模型」→ 掉供应商）
        try {
          const out = await catalog()
          const safe = out && typeof out === 'object' ? out : {}

          // 保护 1：列表单调不减。站点偶发少给几个模型时，用上一次实时表补齐，
          // 否则宿主会把这些「消失」的模型从用户选择里移除。
          const merged = mergeModelsWithLastGood(safe, lastGoodCatalog)
          const restored = merged.restored

          // 保护 2：本次不是实时数据（用了包内快照或彻底失败）时打标记，
          // 宿主看到 magpie.fellBack 就不会拿这份列表去判断「谁不见了」。
          if (lastCatalogSource !== 'live') {
            try { safe[Symbol.for('magpie.fellBack')] = true } catch { /* 标记失败不影响返回 */ }
          } else if (Object.keys(safe).length) {
            // 只在实时数据上更新基线，别把兜底数据当成「新的真相」
            const snapshotOfGood = {}
            for (const [id, m] of Object.entries(safe)) snapshotOfGood[id] = m
            lastGoodCatalog = snapshotOfGood
          }

          writeHealth({
            ok: true,
            count: Object.keys(safe).length,
            ms: Date.now() - startedAt,
            source: lastCatalogSource,
            restored,
          })
          return safe
        } catch (error) {
          writeHealth({ ok: false, count: 0, ms: Date.now() - startedAt, error: String(error && error.message ? error.message : error) })
          return {}
        }
      },
    },
  }
}