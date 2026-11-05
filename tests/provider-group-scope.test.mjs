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

test('停用例外表只关掉列出的分组，其余分组仍可用', async () => {
  const m = await models({ disabledByGroup: { m1: ['G-cheap'] } })
  assert.equal(m.m1.headers['x-neartoken-group'], '#2')
  assert.ok(m.img1, '没被列出的模型不受影响')
})

test('旧启用表仍可用：只留官Key时改走该组', async () => {
  const m = await models({ enabledByGroup: { m1: ['G-key'] } })
  assert.equal(m.m1.headers['x-neartoken-group'], '#2')
})

test('分组表形状不合法时一律当没有记录，不能把模型判成停用', async () => {
  for (const bad of [
    { enabledByGroup: { m1: 'G-key' } },
    { enabledByGroup: { m1: [] } },
    { enabledByGroup: [] },
    { enabledByGroup: 'not-json' },
    { disabledByGroup: { m1: 42 } },
    { disabledByGroup: null },
  ]) {
    const m = await models(bad)
    assert.ok(m.m1, '不应掉出：' + JSON.stringify(bad))
    assert.ok(m.img1, '不应掉出：' + JSON.stringify(bad))
  }
})

test('模型的所有分组都停用时才不出现在模型表', async () => {
  const m = await models({ disabledByGroup: { m1: ['G-cheap', 'G-key'] } })
  assert.equal(m.m1, undefined)
  assert.ok(m.img1)
})