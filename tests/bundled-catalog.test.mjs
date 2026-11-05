import test from 'node:test'
import assert from 'node:assert/strict'

// 站点目录与状态端点都不可用时，provider.models 必须仍给出稳定的模型表。
// 所有 fetch 都失败，catalog 的兜底路径只读包内快照、不写任何文件。
globalThis.fetch = async () => { throw new Error('offline (模拟站点目录请求失败)') }

const mod = await import('../index.mjs')
const plugin = await mod.default({}, {})

test('站点目录不可用时模型表仍返回包内快照，不抛异常', async () => {
  const models = await plugin.provider.models()
  const keys = Object.keys(models)
  assert.ok(keys.length > 50, '模型表应保持完整，实际 ' + keys.length + ' 个')
  assert.ok(models['claude-fable-5'], '应包含快照里已知模型')
})

test('兜底模型仍带分组路由头与分类信息', async () => {
  const models = await plugin.provider.models()
  const one = models['claude-fable-5']
  assert.ok(one && one.api && one.api.id === 'claude-fable-5')
  assert.ok(one.capabilities && one.capabilities.output)
})

test('旧 disabledModels 不再过滤模型（启停改由 prefs 文件）', async () => {
  const plugin2 = await mod.default({}, { disabledModels: ['claude-fable-5'] })
  const models = await plugin2.provider.models()
  assert.ok(models['claude-fable-5'], '不应再按旧字段把模型过滤掉')
  assert.ok(Object.keys(models).length > 50)
})
