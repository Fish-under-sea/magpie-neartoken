import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// 把 index.mjs 复制到临时目录，避免 provider 回写真实 page/pricing.js。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-provider-'))
fs.copyFileSync(new URL('../index.mjs', import.meta.url), path.join(dir, 'index.mjs'))
fs.mkdirSync(path.join(dir, 'page'), { recursive: true })
fs.copyFileSync(new URL('../page/icon.png', import.meta.url), path.join(dir, 'page', 'icon.png'))
fs.writeFileSync(path.join(dir, 'page', 'pricing.js'), 'self.NEARTOKEN_PRICING = {"models":[],"groups":{}}\n')

const pricingEnv = {
  success: true,
  data: [{
    model_name: 'm1', vendor_id: 1, model_ratio: 1, completion_ratio: 1,
    enable_groups: ['G-cheap', 'G-key'], supported_endpoint_types: ['openai'],
  }],
  group_ratio: { 'G-cheap': 0.5, 'G-key': 2 },
  group_refs: { 'G-cheap': '#1', 'G-key': '#2' },
  vendors: [], usable_group: {}, auto_groups: [], supported_endpoint: {},
}
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes('/api/pricing')) return { ok: true, text: async () => JSON.stringify(pricingEnv) }
  if (u.includes('/api/status')) return { ok: true, text: async () => '{"success":true,"data":{}}' }
  throw new Error('offline')
}

const mod = await import(pathToFileURL(path.join(dir, 'index.mjs')).href)

test('未指定分组级状态时，模型走最便宜的组', async () => {
  const plugin = await mod.default({}, {})
  const models = await plugin.provider.models()
  assert.equal(models.m1.headers['x-neartoken-group'], '#1')
})

test('分组级状态只留官Key时，同一模型改走该组', async () => {
  const plugin = await mod.default({}, { enabledByGroup: { m1: ['G-key'] } })
  const models = await plugin.provider.models()
  assert.equal(models.m1.headers['x-neartoken-group'], '#2')
})

test('该模型所有分组都停用时不出现在模型表', async () => {
  const plugin = await mod.default({}, { enabledByGroup: { m1: [] } })
  const models = await plugin.provider.models()
  assert.equal(models.m1, undefined)
})