import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 掉供应商的回归防护：宿主拿不到模型表就会判定「这个供应商没有模型」。
// 这组用例锁死两条：抛异常不冒泡、不返回空表；并锁住「插件不再二次按 prefs 过滤」。

const src = fs.readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')

test('catalog 有两层兜底：catalogUnsafe + 包内快照重建', () => {
  assert.ok(/async function catalogUnsafe\(/.test(src), '应有 catalogUnsafe 实现')
  assert.ok(/async function catalog\(/.test(src), '应有安全包装的 catalog')
  assert.ok(/readBundledPricing\(\)/.test(src), '应有快照重建分支')
  // 停用一律交给宿主的 modelFilter：插件再按 prefs 过滤就是第二份真相
  assert.equal(/ignorePrefs/.test(src), false, '不应再有「忽略偏好放宽」这条分支')
  assert.equal(/readPrefs\(/.test(src), false, '不应再读 page/prefs.json 参与过滤')
})

test('models() 外层吞掉异常，绝不向宿主抛 rejected Promise', () => {
  const i = src.indexOf('async models()')
  assert.ok(i > 0, '应找到 models()')
  const seg = src.slice(i, i + 1200)
  assert.ok(/try \{/.test(seg), 'models 内应有 try')
  assert.ok(seg.includes('return {}'), 'catch 应返回空对象而不是抛出')
})

test('插件不再按旧 options 过滤模型（options 里留什么都不影响模型表）', () => {
  // 旧版把启停写进 options，宿主重建插件宿主导致闪断；这条锁住不再回头
  assert.equal(/options\?\.disabledGroups/.test(src), false, '不应再读 options.disabledGroups')
  assert.equal(/options\?\.disabledModels/.test(src), false, '不应再读 options.disabledModels')
  assert.equal(/options\?\.enabledByGroup/.test(src), false, '不应再读 options.enabledByGroup')
  assert.equal(/options\?\.disabledByGroup/.test(src), false, '不应再读 options.disabledByGroup')
})

test('promise 被拒时不向宿主冒泡（models 外层 catch 已覆盖）', () => {
  // 行为验证放在 provider-group-scope 的夹具里；这里只锁源码约定
  assert.ok(/catch \(error\)/.test(src), 'models 应有 catch')
  assert.ok(/return safe/.test(src), '成功路径应返回对象')
})