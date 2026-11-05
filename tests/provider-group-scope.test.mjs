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
fs.writeFileSync(path.join(dir, 'page', 'pricing.js'), 'self.NEARTOKEN_PRICING = {"models":[],"groups":{}}\n')

const pricingEnv = {
  success: true,
  data: [
    {
      model_name: 'm1', vendor_id: 1, model_ratio: 1, completion_ratio: 1,
      enable_groups: ['G-cheap', 'G-key'], supported_endpoint_types: ['openai'],
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