import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../page/app.js', import.meta.url), 'utf8')
const names = new Set(['filteredModels', 'isTaskModel', 'quotaKindOf', 'versionKey', 'byVersionDesc', 'priceOf', 'taskPrices', 'priceCondition', 'timedPriceExpression'])
const functions = [...source.matchAll(/  function (\w+)\([^\n]*\) \{[\s\S]*?\n  \}/g)]
  .filter((m) => names.has(m[1])).map((m) => m[0]).join('\n')

const models = [
  { name: 'token-openai', quota_type: 0, supported_endpoint_types: ['openai'], enable_groups: ['G'] },
  { name: 'request-gemini', quota_type: 1, model_price: 0.1, supported_endpoint_types: ['gemini'], enable_groups: ['G'] },
  { name: 'task-video', quota_type: 0, billing_usage_schema: { seconds: { unit: 'second' } }, supported_endpoint_types: ['openai-video'], enable_groups: ['G'] },
  { name: 'task-request', quota_type: 1, model_price: 1, billing_usage_schema: { clips: { unit: 'count' } }, supported_endpoint_types: ['openai'], enable_groups: ['G'] },
  { name: 'multi', quota_type: 0, supported_endpoint_types: ['openai', 'anthropic'], enable_groups: ['G'] },
]

function run(quota = 'all', endpoint = 'all') {
  const ctx = vm.createContext({
    marketSort: 'name', marketGroup: '', marketMode: 'standard', marketQuery: '', marketKind: 'all',
    marketQuota: quota, marketEndpoint: endpoint, marketVendors: new Set(),
    pricing: () => ({ models, groups: { G: 1 } }),
    modelRank: () => ({ tier: 0, order: 0 }), vendorOf: () => '', marketKindOf: () => 'chat',
  })
  vm.runInContext(functions, ctx)
  return Array.from(ctx.filteredModels(), (m) => m.name)
}

test('定价类型分类与官网一致：任务优先，其次按次', () => {
  assert.deepEqual(run('task'), ['task-request', 'task-video'])
  assert.deepEqual(run('request'), ['request-gemini'])
  assert.deepEqual(run('token'), ['multi', 'token-openai'])
})

test('端点类型按 supported_endpoint_types 精确过滤', () => {
  assert.deepEqual(run('all', 'openai'), ['multi', 'task-request', 'token-openai'])
  assert.deepEqual(run('all', 'anthropic'), ['multi'])
  assert.deepEqual(run('all', 'openai-video'), ['task-video'])
  assert.deepEqual(run('all', 'jina-rerank'), [])
})

test('两类筛选可以叠加', () => {
  assert.deepEqual(run('token', 'openai'), ['multi', 'token-openai'])
  assert.deepEqual(run('task', 'openai'), ['task-request'])
})

test('侧栏确实提供这两组筛选项', () => {
  assert.match(source, /定价类型/)
  assert.match(source, /端点类型/)
  for (const label of ['按量计费', '按次计费', '任务计费', 'Chat', 'Response', 'Anthropic', 'Gemini', 'Rerank', '图片', '嵌入', '视频']) {
    assert.ok(source.includes(label), '缺少筛选项：' + label)
  }
})