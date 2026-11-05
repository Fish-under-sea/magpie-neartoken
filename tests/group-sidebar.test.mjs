import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../page/app.js', import.meta.url), 'utf8')
const names = new Set(['groupEnableStats', 'groupNote', 'groupChipModel', 'bandActiveCount', 'groupTags', 'cheapestGroup', 'isOn', 'viewGroup'])
const fns = [...source.matchAll(/  function (\w+)\([^\n]*\) \{[\s\S]*?\n  \}/g)]
  .filter((m) => names.has(m[1])).map((m) => m[0]).join('\n')
const consts = [
  ...source.match(/^  const (PRICE_TAGS|LEAD_ORDER) = .*$/gm),
  ...source.match(/^  const leadRank = [\s\S]*?\n  \}\n/m),
  ...source.match(/^  const enabledByGroup = new Map\(\)$/m),
].join('\n')

const p = {
  models: [
    { name: 'a', enable_groups: ['G1'] },
    { name: 'b', enable_groups: ['G1', 'G2'] },
    { name: 'c', enable_groups: ['G3'] },
  ],
  groups: { G1: 1, G2: 0.5, G3: 1 },
  notes: { G1: '一号分组说明', G2: '', G3: '' },
}

function make(entries, group = '') {
  const ctx = vm.createContext({
    Map, Set, JSON, String, Number, Object, Array,
    KIND_SERIES: { chat: '对话' }, groupKind: () => 'chat',
    marketGroup: group, pricing: () => p,
  })
  vm.runInContext(consts + '\n' + fns + '\n;globalThis.__ebg = enabledByGroup;', ctx)
  ctx.__ebg.clear()
  for (const [k, v] of entries) ctx.__ebg.set(k, new Set(v))
  return ctx
}

const row = (stats, g) => {
  const r = stats.get(g)
  return r ? { total: r.total, enabled: r.enabled } : undefined
}
const entries = [['a', ['G1']], ['b', ['G2']], ['c', ['G3']]]

test('分组级启停：同一模型在别组启用不会点亮本组', () => {
  const ctx = make(entries)
  const stats = ctx.groupEnableStats(p)
  assert.deepEqual(row(stats, 'G1'), { total: 2, enabled: 1 })
  assert.deepEqual(row(stats, 'G2'), { total: 1, enabled: 1 })
  assert.deepEqual(row(stats, 'G3'), { total: 1, enabled: 1 })
  assert.match(ctx.groupChipModel(p, 'G1', '', stats).className, /has-enabled/)
  assert.match(ctx.groupChipModel(p, 'G2', '', stats).className, /has-enabled/)
})

test('某组全停就灰化，且不会出现常亮项', () => {
  const ctx = make([['a', []], ['b', []], ['c', []]])
  const stats = ctx.groupEnableStats(p)
  for (const g of ['G1', 'G2', 'G3']) {
    assert.deepEqual(row(stats, g).enabled, 0)
    assert.match(ctx.groupChipModel(p, g, '', stats).className, /all-off/, g)
  }
})

test('最便宜分组是默认视图分组', () => {
  const ctx = make(entries)
  assert.equal(ctx.cheapestGroup(p.models[1], p.groups), 'G2')
  assert.equal(ctx.cheapestGroup({ enable_groups: ['X', 'Y'] }, { X: 0, Y: 1 }), 'Y')
  assert.equal(ctx.cheapestGroup({ enable_groups: [] }, {}), '')
})

test('isOn 跟着当前选定分组切换判定', () => {
  assert.equal(make([['b', ['G2']]], '').isOn(p.models[1]), true) // 未选组时按最便宜的 G2 判定
  const ctxG1 = make([['b', ['G2']]], 'G1')
  assert.equal(ctxG1.isOn(p.models[1]), false)
  const ctxG2 = make([['b', ['G2']]], 'G2')
  assert.equal(ctxG2.isOn(p.models[1]), true)
})

test('官网说明按分组原文取值，缺失返回空串', () => {
  const ctx = make(entries)
  assert.equal(ctx.groupNote(p, 'G1'), '一号分组说明')
  assert.equal(ctx.groupNote(p, 'G2'), '')
})

test('chip 不含说明文字，提示写启用数', () => {
  const ctx = make(entries)
  const m = ctx.groupChipModel(p, 'G1', 'G1', ctx.groupEnableStats(p))
  assert.match(m.className, /\bon\b/)
  assert.equal('desc' in m, false)
  assert.match(m.title, /启用 1\/2 个模型/)
})

test('档位计数按分组级启用统计', () => {
  const ctx = make(entries)
  assert.equal(ctx.bandActiveCount(['G1', 'G2', 'G3'], ctx.groupEnableStats(p)), 3)
  const off = make([['a', []], ['b', []], ['c', []]])
  assert.equal(off.bandActiveCount(['G1', 'G2', 'G3'], off.groupEnableStats(p)), 0)
})

test('官Key 组保留满血，功能词不重复成小标签', () => {
  const ctx = make(entries)
  const key = ctx.groupTags('[满血][官Key] Gemini')
  assert.deepEqual(Array.from(key.price).sort(), ['官Key', '满血'].sort())
  assert.deepEqual(Array.from(key.extra), [])
  const img = ctx.groupTags('[低价][生图] 生图特惠')
  assert.deepEqual(Array.from(img.extra), [])
  assert.deepEqual(Array.from(img.price), ['低价'])
  const grav = ctx.groupTags('[低价][反重力] Gemini')
  assert.deepEqual(Array.from(grav.price).sort(), ['低价', '反重力'].sort())
})

test('鸡蛋等非价格标签保留', () => {
  const ctx = make(entries)
  const tags = ctx.groupTags('[🥚] Claude')
  assert.deepEqual(Array.from(tags.extra), ['🥚'])
  assert.equal(tags.rest, 'Claude')
})