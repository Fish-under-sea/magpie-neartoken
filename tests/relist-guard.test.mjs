import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// 宿主 KeepPluginsListed 每次重列都对比前后列表：少一个模型就把用户的选择移除，
// 并把下次重列提前到 5 分钟（relistSoon）——用户看到的就是「过几分钟掉一次供应商」。
// 这里锁住插件侧两道防护：列表单调不减、非实时数据打 magpie.fellBack 标记。

const src = fs.readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')

/** 从源码里抽一个函数体出来单独跑（避免为纯逻辑启动整个插件运行时）。 */
function pick(name) {
  const i = src.indexOf('function ' + name)
  assert.ok(i > 0, '应找到 ' + name)
  const start = src.lastIndexOf('\n', i)
  let depth = 0
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(start, k + 1) }
  }
  throw new Error('未闭合：' + name)
}

const { mergeModelsWithLastGood } = new Function(
  pick('mergeModelsWithLastGood') + '; return { mergeModelsWithLastGood }')()

test('站点少给模型时，用上一次实时表补齐（保持单调不减）', () => {
  const lastGood = { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } }
  const now = { a: { id: 'a' } } // 站点这次只回了 a
  const { restored } = mergeModelsWithLastGood(now, lastGood)
  assert.equal(restored, 2, '应补回 b 与 c')
  for (const id of ['a', 'b', 'c']) assert.ok(now[id], '不应丢掉 ' + id)
})

test('站点多给模型时不受影响（新车西照常进入列表）', () => {
  const lastGood = { a: { id: 'a' } }
  const now = { a: { id: 'a' }, d: { id: 'd' } }
  const { restored } = mergeModelsWithLastGood(now, lastGood)
  assert.equal(restored, 0, '不应误判')
  assert.ok(now.d, '新模型必须保留')
})

test('没有历史表时原样返回', () => {
  const now = { a: { id: 'a' } }
  assert.equal(mergeModelsWithLastGood(now, null).restored, 0)
  assert.deepEqual(Object.keys(now), ['a'])
})

// 冷启动：新模块实例的 envCache 为空，首列必定来自包内快照 → 必须打 fellBack。
// 注意：--test-isolation=none 下所有测试文件共享 globalThis，桩必须能恢复，
// 且只返回「失败响应」而不是抛错，免得拖住别的文件的网络等待。
const realFetch = globalThis.fetch
globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => '' })

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-relist-'))
fs.copyFileSync(new URL('../index.mjs', import.meta.url), path.join(dir, 'index.mjs'))
fs.mkdirSync(path.join(dir, 'page'), { recursive: true })
fs.copyFileSync(new URL('../page/icon.png', import.meta.url), path.join(dir, 'page', 'icon.png'))
const bundledSnapshot = {
  version: 'test',
  models: [
    { name: 'm-a', enable_groups: ['G-a'], supported_endpoint_types: ['openai'], quota_type: 0, vendor_id: 1 },
    { name: 'm-b', enable_groups: ['G-a'], supported_endpoint_types: ['openai'], quota_type: 0, vendor_id: 1 },
  ],
  groups: { 'G-a': 1 },
  refs: { 'G-a': '#1' },
  notes: {}, auto: [], vendors: [], endpoints: {},
}
fs.writeFileSync(path.join(dir, 'page', 'pricing.js'),
  'self.NEARTOKEN_PRICING = ' + JSON.stringify(bundledSnapshot) + '\n')

// 站点返回 403：模拟抓不到实时目录
globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => '' })

const mod = await import(pathToFileURL(path.join(dir, 'index.mjs')).href)

// 本文件跑完把全局 fetch 还回去，避免影响同一进程里的其他测试文件
test.after(() => { globalThis.fetch = realFetch })

test('首列数据来自包内快照时打 magpie.fellBack 标记（宿主据此不丢 pick）', async () => {
  const p = await mod.default({}, {})
  const out = await p.provider.models()
  assert.equal(out[Symbol.for('magpie.fellBack')], true, '非实时数据必须打标记')
  assert.ok(Object.keys(out).length >= 2, '仍要给出模型表，不能是空表')
  assert.equal(out[Symbol.for('magpie.fellBack')] instanceof Symbol, false, '标记值应是布尔')
})

test('models() 永远不会向宿主抛异常', async () => {
  const p = await mod.default({}, {})
  await assert.doesNotReject(async () => p.provider.models())
})
