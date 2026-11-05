import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../page/app.js', import.meta.url), 'utf8')
const fns = [...source.matchAll(/  function (\w+)\([^\n]*\) \{[\s\S]*?\n  \}/g)]
  .filter((m) => m[1] === 'vendorIconModel').map((m) => m[0]).join('\n')
const ctx = vm.createContext({ String, Number, Object, Array, encodeURIComponent })
vm.runInContext(fns, ctx)

const p = {
  models: [
    { name: 'a', vendor_id: 1 },
    { name: 'b', vendor_id: 1 },
    { name: 'c', vendor_id: 3 },
    { name: 'd', vendor_id: '8' },
  ],
}
const field = (v, snap, key) => ctx.vendorIconModel(v, snap)[key]

test('有 icon 的供应商映射到包内同名 SVG', () => {
  assert.equal(field({ id: 1, name: 'OpenAI', icon: 'OpenAI' }, p, 'src'), 'vendor-icons/OpenAI.svg')
  assert.equal(field({ id: 2, name: 'Anthropic', icon: 'Claude.Color' }, p, 'src'), 'vendor-icons/Claude.Color.svg')
  assert.equal(field({ id: 1, name: 'OpenAI', icon: 'OpenAI' }, p, 'fallback'), '')
})

test('站点没给 icon 时用名称首字兜底', () => {
  assert.equal(field({ id: 13, name: 'TypeSafe' }, p, 'src'), '')
  assert.equal(field({ id: 13, name: 'TypeSafe' }, p, 'fallback'), 'T')
})

test('供应商模型数按 vendor_id 字符串匹配统计', () => {
  assert.equal(field({ id: 1, name: 'OpenAI', icon: 'OpenAI' }, p, 'count'), 2)
  assert.equal(field({ id: 8, name: '阿里巴巴', icon: 'Qwen.Color' }, p, 'count'), 1)
  assert.equal(field({ id: 99, name: 'None' }, p, 'count'), 0)
})

test('每个有 icon 的供应商都有本地 SVG 文件', () => {
  const official = JSON.parse(fs.readFileSync(new URL('../page/pricing.js', import.meta.url), 'utf8').replace(/^.*?=/s, '').trim())
  const dir = new URL('../page/vendor-icons/', import.meta.url)
  for (const v of official.vendors || []) {
    if (typeof v.icon !== 'string' || !v.icon.trim()) continue
    const src = ctx.vendorIconModel(v, official).src
    const name = src.replace('vendor-icons/', '')
    assert.ok(fs.existsSync(new URL(name, dir)), '缺少图标文件：' + name)
    const svg = fs.readFileSync(new URL(name, dir), 'utf8')
    assert.ok(svg.startsWith('<svg'), '不是 SVG：' + name)
    assert.ok(!svg.includes('currentColor'), '仍含主题继承色：' + name)
  }
})
