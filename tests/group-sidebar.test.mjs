import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../page/app.js', import.meta.url), 'utf8')
const names = new Set(['groupEnableStats', 'groupNote', 'groupChipModel', 'bandActiveCount', 'groupTags', 'cheapestGroup', 'isOn', 'viewGroup', 'initDisabledByGroup', 'groupOptionsPayload'])
const fns = [...source.matchAll(/  (?:async )?function (\w+)\([^\n]*\) \{[\s\S]*?\n  \}/g)]
  .filter((m) => names.has(m[1])).map((m) => m[0]).join('\n')
const consts = [
  ...source.match(/^  const (PRICE_TAGS|LEAD_ORDER) = .*$/gm),
  ...source.match(/^  const leadRank = [\s\S]*?\n  \}\n/m),
  ...source.match(/^  const disabledByGroup = new Map\(\)$/m),
  ...source.match(/^  const hostOff = new Set\(\)$/m),
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

function make(entries = [], group = '', options = {}) {
  const ctx = vm.createContext({
    Map, Set, JSON, String, Number, Object, Array,
    KIND_SERIES: { chat: '对话' }, groupKind: () => 'chat',
    marketGroup: group, pricing: () => p, options,
    bridge: { call: async () => { throw new Error('no prefs') } },
    localStorage: { getItem: () => null, setItem: () => {} },
  })
  vm.runInContext(consts + '\n' + fns + '\n;globalThis.__dbg = disabledByGroup; globalThis.__hostOff = hostOff;', ctx)
  ctx.__dbg.clear()
  for (const [k, v] of entries) ctx.__dbg.set(k, new Set(v))
  return ctx
}

const row = (stats, g) => {
  const r = stats.get(g)
  return r ? { total: r.total, enabled: r.enabled } : undefined
}

test('没有停用记录时，模型在它列出的每个分组里都算启用', () => {
  const ctx = make()
  const stats = ctx.groupEnableStats(p)
  assert.deepEqual(row(stats, 'G1'), { total: 2, enabled: 2 })
  assert.deepEqual(row(stats, 'G2'), { total: 1, enabled: 1 })
  assert.deepEqual(row(stats, 'G3'), { total: 1, enabled: 1 })
})

test('停用某组只影响该组，模型在别组不受牵连', () => {
  const ctx = make([['b', ['G1']]])
  const stats = ctx.groupEnableStats(p)
  assert.deepEqual(row(stats, 'G1'), { total: 2, enabled: 1 })
  assert.deepEqual(row(stats, 'G2'), { total: 1, enabled: 1 })
  assert.match(ctx.groupChipModel(p, 'G1', '', stats).className, /has-enabled/)
})

test('某组模型全停就灰化，不会出现常亮项', () => {
  const ctx = make([['a', ['G1']], ['b', ['G1']]])
  const stats = ctx.groupEnableStats(p)
  assert.deepEqual(row(stats, 'G1'), { total: 2, enabled: 0 })
  assert.match(ctx.groupChipModel(p, 'G1', '', stats).className, /all-off/)
})

test('最便宜分组是默认视图分组', () => {
  const ctx = make()
  assert.equal(ctx.cheapestGroup(p.models[1], p.groups), 'G2')
  assert.equal(ctx.cheapestGroup({ enable_groups: [] }, {}), '')
})

test('isOn 跟着当前选定分组切换判定', () => {
  assert.equal(make([], '').isOn(p.models[1]), true)
  assert.equal(make([['b', ['G2']]], '').isOn(p.models[1]), false)
  assert.equal(make([['b', ['G2']]], 'G2').isOn(p.models[1]), false)
  assert.equal(make([['b', ['G1']]], 'G2').isOn(p.models[1]), true)
})

test('宿主记的「整模型停用」让该模型在所有分组都显示为关', () => {
  const ctx = make()
  // 宿主 disabled 里出现一个模型 = 整个模型下线（没有分组维度）
  ctx.__hostOff.add('b')
  assert.equal(ctx.isOn(p.models[1]), false)
  // 同一次点击把它打开后，宿主的整模型停用要跟着解除
  assert.equal(ctx.isOn(p.models[0]), true)
})

test('读回停用表：形状不对就当没有记录，不会把模型判成停用', async () => {
  for (const bad of [{ disabledByGroup: { a: 'G1' } }, { disabledByGroup: [] }, { disabledByGroup: 'bad' }, { disabledByGroup: null }]) {
    const ctx = make([], '', bad)
    await ctx.initDisabledByGroup()
    assert.equal(ctx.__dbg.size, 0, JSON.stringify(bad))
    assert.equal(ctx.isOn(p.models[0]), true)
  }
  const ok = make([], '', { disabledByGroup: { a: ['G1'] } })
  await ok.initDisabledByGroup()
  assert.equal(ok.isOn(p.models[0]), false)
})

test('提示写启用数，chip 不含说明文字', () => {
  const ctx = make()
  const m = ctx.groupChipModel(p, 'G1', 'G1', ctx.groupEnableStats(p))
  assert.match(m.className, /\bon\b/)
  assert.equal('desc' in m, false)
  assert.match(m.title, /启用 2\/2 个模型/)
})

test('档位计数只数含启用模型的分组', () => {
  const ctx = make([['a', ['G1']], ['b', ['G1']]])
  assert.equal(ctx.bandActiveCount(['G1', 'G2', 'G3'], ctx.groupEnableStats(p)), 2)
})

test('写回载荷只放停用例外，并清掉旧的大字段', () => {
  const ctx = make([['a', ['G1']]])
  // vm 里创建的对象原型不同，统一用 JSON 形态比较
  const payload = JSON.parse(JSON.stringify(ctx.groupOptionsPayload({ disabledModels: ['x'], other: 'keep', enabledByGroup: { a: ['G1', 'G2'] } }, ctx.__dbg)))
  assert.deepEqual(payload.enabledByGroup, undefined)
  assert.equal('enabledByGroup' in payload, false)
  assert.deepEqual(payload.disabledByGroup, { a: ['G1'] })
  assert.deepEqual(payload.disabledModels, [], '旧版全局停用表必须清空，否则 provider 仍按它过滤模型')
  assert.equal(payload.other, 'keep', '其它字段原样保留')
  const empty = JSON.parse(JSON.stringify(ctx.groupOptionsPayload({}, new Map())))
  assert.deepEqual(empty.disabledByGroup, {}, '默认全选时载荷就是空对象')
})

test('鸡蛋等非价格标签保留，官Key 保留满血', () => {
  const ctx = make()
  assert.deepEqual(Array.from(ctx.groupTags('[🥚] Claude').extra), ['🥚'])
  assert.deepEqual(Array.from(ctx.groupTags('[满血][官Key] Gemini').price).sort(), ['官Key', '满血'].sort())
  assert.deepEqual(Array.from(ctx.groupTags('[低价][生图] 生图特惠').extra), [])
})