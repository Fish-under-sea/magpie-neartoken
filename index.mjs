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

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE = 'https://neartoken.cc'
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

/** 站点当前怎么印钱：一个 quota 值折算成它显示的那笔钱。 */
async function currency() {
  try {
    const s = await call('/api/status')
    const d = s?.data ?? {}
    const per = Number(d.quota_per_unit) > 0 ? Number(d.quota_per_unit) : 1
    const rate = Number(d.usd_exchange_rate) > 0 ? Number(d.usd_exchange_rate) : 1
    const display = d.display_in_currency === true
    const symbol = typeof d.custom_currency_symbol === 'string' && d.custom_currency_symbol.trim()
      ? d.custom_currency_symbol.trim()
      : display ? '￥' : '$'
    return { symbol, per, rate, display }
  } catch {
    return { symbol: '$', per: 1, rate: 1, display: false }
  }
}

/** money 把 quota 折成站点显示的那笔钱。 */
function money(quota, cur) {
  const base = quota / (cur.per > 0 ? cur.per : 1)
  return (cur.display && cur.rate > 0 ? base * cur.rate : base).toFixed(2)
}

/** text 是带符号的一笔钱。 */
function text(quota, cur) {
  return cur.symbol + money(quota, cur)
}

/** 倍率的写法：0.1 → 0.1，1 → 1。 */
function ratioText(v) {
  return String(Math.round(v * 10000) / 10000)
}

/** 生图模型的名字词。 */
const DRAWS = ['image', 'imagen', 'imagine', 'dall-e', 'flux', 'seedream', 'cogview', 'stable-diffusion', 'sdxl', 'wanx', 'kolors', 'hidream', 'banana', 'midjourney', 'mj-', 'qwen-image']
/** 视频模型的名字词。 */
const FILMS = ['veo', 'sora', 'kling', 'seedance', 'hailuo', 'vidu', 'pixverse', 'runway', 'luma', 'wan2', 'wanx-video', 'minimax-video', 'movie', 'video', 't2v', 'i2v']
/** 既不聊也不画不拍的名字。 */
const SKIP = ['embedding', 'embed-', 'text-embedding', 'tts', 'transcribe', 'asr', 'rerank', 'moderation', 'whisper', 'speech']

const hasWord = (id, words) => words.some((w) => id.toLowerCase().includes(w))

/**
 * 目录：把 /api/pricing 展开成 magpie 的模型表。
 *
 * 一个模型在几个分组里就是几行，id 里带组 ref（`#7::grok-4.6`），名字是
 * 「站点原文组名 + 倍率 + 模型」。每行带自己的 x-neartoken-group 头，请求
 * 按那一行走那一组——这就是"模型后面跟着它的分组"。
 */
async function catalog() {
  const env = await call('/api/pricing')
  const rows = Array.isArray(env?.data) ? env.data : []
  const refs = env?.group_refs && typeof env.group_refs === 'object' ? env.group_refs : {}
  const ratios = env?.group_ratio && typeof env.group_ratio === 'object' ? env.group_ratio : {}
  const out = {}
  for (const row of rows) {
    const model = String(row?.model_name ?? '').trim()
    if (!model || hasWord(model, SKIP) || model.toLowerCase().endsWith('-c')) continue
    const ends = Array.isArray(row?.supported_endpoint_types) ? row.supported_endpoint_types : []
    const chat = ends.length === 0 || ends.some((e) => ['openai', 'openai-response', 'anthropic', 'gemini'].includes(e))
    const drawer = hasWord(model, DRAWS) || ends.includes('image-generation')
    const film = hasWord(model, FILMS)
    if (!chat && !drawer && !film) continue
    const groups = Array.isArray(row?.enable_groups) && row.enable_groups.length ? row.enable_groups : ['']
    for (const raw of groups) {
      const group = String(raw ?? '').trim()
      const ref = group && refs[group] ? String(refs[group]) : ''
      const ratio = group && Number(ratios[group]) > 0 ? Number(ratios[group]) : 0
      const id = ref ? `${ref}::${model}` : model
      const label = group ? (ratio > 0 ? `${group} ${ratioText(ratio)}x` : group) + ' · ' + model : model
      out[id] = {
        name: label,
        api: { id: model, url: SITE + '/v1', npm: '@ai-sdk/openai-compatible' },
        limit: {
          context: Number(row?.context_window) > 0 ? Number(row.context_window) : 0,
          output: Number(row?.max_tokens) > 0 ? Number(row.max_tokens) : 0,
        },
        ...(ref ? { headers: { 'x-neartoken-group': ref } } : {}),
        capabilities: {
          toolcall: true,
          ...(drawer ? { output: { image: true, text: true } } : {}),
          ...(film ? { output: { video: true, text: true } } : {}),
        },
      }
    }
  }
  return out
}

export default async function neartoken() {
  return {
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
              url: d.verification_uri_complete || d.verification_uri,
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
        const auth = await getAuth()
        const key = auth?.access || auth?.key
        if (!key) throw new Error('还没有连接 NearToken')
        const [cur, env] = await Promise.all([currency(), call('/api/dsh/device/wallet', { key })])
        if (env?.success !== true) throw new Error('读取余额失败：' + (env?.message || '站点拒绝'))
        const d = env.data ?? {}
        const used = Number(d.used_quota) || 0
        return {
          user: typeof d.username === 'string' ? d.username : '',
          balance: text(Number(d.quota) || 0, cur),
          windows: [{ name: '已用', display: text(used, cur) }],
        }
      },
      /** 请求带着这把钥匙出去；分组头由每个模型自己带（见 catalog）。 */
      async loader(getAuth) {
        const auth = await getAuth()
        const key = auth?.access || auth?.key || ''
        return {
          apiKey: key,
          baseURL: SITE + '/v1',
          fetch: async (input, init) => {
            // 保险：模型名里若还带着 `#ref::` 前缀，拆掉并补上头
            const body = init?.body
            if (typeof body === 'string') {
              try {
                const parsed = JSON.parse(body)
                const raw = parsed?.model
                if (typeof raw === 'string' && raw.includes('::')) {
                  const [ref, model] = raw.split('::')
                  parsed.model = model
                  const headers = new Headers(init?.headers || {})
                  if (ref.startsWith('#')) headers.set('x-neartoken-group', ref)
                  return fetch(input, { ...init, body: JSON.stringify(parsed), headers })
                }
              } catch {
                /* 不是 JSON 就原样发 */
              }
            }
            return fetch(input, init)
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
        return catalog()
      },
    },
  }
}