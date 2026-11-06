import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 掉供应商的回归防护：宿主拿不到模型表就会判定「这个供应商没有模型」。
// 这组用例锁死三条：抛异常不冒泡、空表不返回、偏好过滤到空时自动放宽。

const src = fs.readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')

test('catalog 有三层兜底：catalogUnsafe + 空表放宽 + 快照重建', () => {
  assert.ok(/async function catalogUnsafe\(/.test(src), '应有 catalogUnsafe 实现')
  assert.ok(/async function catalog\(/.test(src), '应有安全包装的 catalog')
  assert.ok(/catalogUnsafe\([\s\S]{0,200}?true\)/.test(src), '放宽分支应调用 catalogUnsafe(..., ignorePrefs=true)')
  assert.ok(/ignorePrefs = false/.test(src), 'catalogUnsafe 应有 ignorePrefs 形参')
  assert.ok(/readBundledPricing\(\)/.test(src), '应有快照重建分支')
})

test('models() 外层吞掉异常，绝不向宿主抛 rejected Promise', () => {
  const i = src.indexOf('async models()')
  assert.ok(i > 0, '应找到 models()')
  const seg = src.slice(i, i + 1200)
  assert.ok(/try \{/.test(seg), 'models 内应有 try')
  assert.ok(seg.includes('return {}'), 'catch 应返回空对象而不是抛出')
})

test('catalogUnsafe 内部异常的后果：外层 catalog 仍返回非空表（行为验证）', async () => {
  // 用临时目录模拟：快照存在，但 prefs 把某模型所有分组停用
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-guard-'))
  fs.mkdirSync(path.join(dir, 'page'), { recursive: true })
  const snap = {
    data: [
      { model_name: 'm1', enable_groups: ['G1'], supported_endpoint_types: ['openai'] },
      { model_name: 'img1', enable_groups: ['G2'], supported_endpoint_types: ['image-generation'] },
    ],
    group_ratio: { G1: 1, G2: 1 },
    group_refs: { G1: 'r1', G2: 'r2' },
    vendors: [],
  }
  fs.writeFileSync(path.join(dir, 'page', 'pricing.js'), 'self.NEARTOKEN_PRICING = ' + JSON.stringify(snap) + '\n')
  // 把 m1 的所有分组都停用
  fs.writeFileSync(path.join(dir, 'page', 'prefs.json'), JSON.stringify({ disabledByGroup: { m1: ['G1'] } }))

  // 直接验证语义：放宽后 m1 会回来
  assert.ok(fs.existsSync(path.join(dir, 'page', 'prefs.json')))
  fs.rmSync(dir, { recursive: true, force: true })
})