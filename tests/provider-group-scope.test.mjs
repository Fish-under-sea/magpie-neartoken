import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-provider-'))
fs.copyFileSync(new URL('../index.mjs', import.meta.url), path.join(dir, 'index.mjs'))
fs.mkdirSync(path.join(dir, 'page'), { recursive: true })
fs.copyFileSync(new URL('../page/icon.png', import.meta.url), path.join(dir, 'page', 'icon.png'))
const bundledSnapshot = {
  version: 'test',
  models: [
    { name: 'm1', enable_groups: ['G-cheap', 'G-key'], supported_endpoint_types: ['openai'], input_modalities: ['text', 'image'], context_window: 1000000, max_tokens: 64000, quota_type: 0, vendor_id: 1 },
    { name: 'img1', enable_groups: ['G-img'], supported_endpoint_types: ['image-generation'], input_modalities: ['text'], quota_type: 0, vendor_id: 1 },
  ],
  groups: { 'G-cheap': 0.5, 'G-key': 2, 'G-img': 1 },
  refs: { 'G-cheap': '#1', 'G-key': '#2', 'G-img': '#3' },
  notes: {}, auto: [], vendors: [], endpoints: {},
}
fs.writeFileSync(path.join(dir, 'page', 'pricing.js'), 'self.NEARTOKEN_PRICING = ' + JSON.stringify(bundledSnapshot) + '\n')

const pricingEnv = {
  success: true,
  data: [
    {
      model_name: 'm1', vendor_id: 1, model_ratio: 1, completion_ratio: 1,
      enable_groups: ['G-cheap', 'G-key'], supported_endpoint_types: ['openai'],
      input_modalities: ['text', 'image'], context_window: 1000000, max_tokens: 64000,
    },
    {
      model_name: 'img1', vendor_id: 1, model_ratio: 1, completion_ratio: 1,
      enable_groups: ['G-img'], supported_endpoint_types: ['image-generation'],
    },
  ],
  group_ratio: { 'G-cheap': 0.5, 'G-key': 2, 'G-img': 1 },
  group_refs: { 'G-cheap': '#1', 'G-key': '#2', 'G-img': '#3' },
  vendors: [], usable_group: {}, auto_groups: [], supported_endpoint: {},
}
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes('/api/log/token')) {
    return {
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        data: [{
          created_at: 1793990000, token_name: 'Magpie', model_name: 'm1', group: 'G-cheap',
          quota: 500000, prompt_tokens: 10, completion_tokens: 20, use_time: 1.5,
          is_stream: true, request_size: 128, other: '{}',
        }],
      }),
    }
  }
  if (u.includes('/api/pricing')) return { ok: true, text: async () => JSON.stringify(pricingEnv) }
  if (u.includes('/api/status')) return { ok: true, text: async () => '{"success":true,"data":{}}' }
  throw new Error('offline')
}

const mod = await import(pathToFileURL(path.join(dir, 'index.mjs')).href)
const models = async (options) => (await (await mod.default({}, options)).provider.models())

test('模型在原生列表里只显示模型名', async () => {
  const m = await models({})
  assert.equal(m.m1.name, 'm1')
  assert.equal(m.img1.name, 'img1')
})

test('停用状态不再由插件过滤：prefs.json 写什么都不影响模型表', async () => {
  // 停用由宿主的 modelFilter（neartoken-prefs.json → HiddenModels）负责。
  // 插件再按 prefs 过滤就是第二份真相，正是「模型数忽多忽少」的来源。
  fs.writeFileSync(path.join(dir, 'page', 'prefs.json'), JSON.stringify({ disabledByGroup: { m1: ['G-cheap', 'G-key'] } }))
  const m = await models({})
  assert.ok(m.m1, '插件必须仍返回 m1，交给宿主去隐藏')
  assert.ok(m.img1, '其它模型同样不受影响')
  fs.rmSync(path.join(dir, 'page', 'prefs.json'), { force: true })
  const back = await models({})
  assert.ok(back.m1, '删掉偏好后依然在')
})

test('API 方言跟着端点走：纯 anthropic 模型不会被当成 openai 发', async () => {
  const m = await models({})
  assert.equal(m.m1.api.npm, '@ai-sdk/openai-compatible')
  assert.equal(m.img1.api.npm, '@ai-sdk/openai-compatible')
})

test('模型字段完整：id、上下文、输入模态、附件与能力', async () => {
  const m = await models({})
  assert.equal(m.m1.id, 'm1')
  assert.equal(m.m1.limit.context, 1000000)
  assert.equal(m.m1.limit.output, 64000)
  assert.deepEqual(m.m1.capabilities.input, { text: true, image: true, audio: false, video: false, pdf: false })
  assert.equal(m.m1.capabilities.attachment, true)
  assert.equal(m.m1.capabilities.toolcall, true)
  assert.ok(m.m1.api && m.m1.api.url && m.m1.api.npm)
  assert.equal(m.m1.status, undefined, '不能给宿主 deprecated 状态，否则会被隐藏')
})

test('对话模型声明 reasoning 与思考档位，图片模型不声明', async () => {
  const m = await models({})
  assert.equal(m.m1.capabilities.reasoning, true)
  assert.deepEqual(Object.keys(m.m1.variants), ['low', 'medium', 'high'])
  assert.equal(m.img1.capabilities.reasoning, undefined)
  assert.equal(m.img1.variants, undefined)
})

test('未指定分组级状态时，模型走最便宜的组', async () => {
  assert.equal((await models({})).m1.headers['x-neartoken-group'], '#1')
})

test('页面侧启停不再参与过滤，模型表始终是全量', async () => {
  for (const opt of [
    { disabledByGroup: { m1: ['G-cheap'] } },
    { enabledByGroup: { m1: ['G-key'] } },
    { disabledModels: ['m1'] },
    { disabledByGroup: { m1: ['G-cheap', 'G-key'] } },
  ]) {
    const m = await models(opt)
    assert.ok(m.m1, '不应被过滤掉：' + JSON.stringify(opt))
    assert.ok(m.img1)
  }
})

test('分组头由 fetch 注入，模型自身也带一份', async () => {
  const m = await models({})
  assert.equal(m.m1.headers['x-neartoken-group'], '#1')
})

test('宿主在 models 钩子里递来的 auth 会被收下并用于抓日志', async () => {
  // host.js：ph.models(given, { auth: authCopy(k) })——重列模型这个动作本身就把令牌送来，
  // 逐条日志因此不依赖 reconnect，也不依赖宿主另开通道。
  //
  // 这里只断言「凭据被收下」这个与网络无关的事实：一旦收下，fetchLogs 就绝不会
  // 再写 no-auth / no-key。具体能否抓到行取决于网络桩，而 --test-isolation=none
  // 下所有测试文件共享 globalThis.fetch，不能作为稳定判据。
  const pageDir = path.join(dir, 'page')
  const metaPath = path.join(pageDir, 'logs-meta.js')
  fs.writeFileSync(metaPath, 'self.NEARTOKEN_LOGS_META = { at: 0, ok: false, stage: "init", rows: 0 }\n')

  const p = await mod.default({}, {})
  await p.provider.models(undefined, { auth: { type: 'oauth', access: 'sk-test-token' } })

  const deadline = Date.now() + 2000
  let meta = null
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(metaPath, 'utf8')
      const m = raw.match(/self\.NEARTOKEN_LOGS_META = (\{[\s\S]*?\})\s*$/)
      if (m) {
        meta = JSON.parse(m[1])
        if (meta.stage && meta.stage !== 'init') break
      }
    } catch { /* 还没写出来 */ }
    await new Promise((r) => setTimeout(r, 50))
  }

  assert.ok(meta, 'logs-meta 应被写入')
  assert.notEqual(meta.stage, 'no-auth', '收下 auth 后不应再判定没有凭据')
  assert.notEqual(meta.stage, 'no-key', '收下 auth 后不应再判定令牌为空')
})

