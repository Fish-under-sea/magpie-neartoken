import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// 宿主 magpie 2.3.2（fish.27）新增 neartoken:relist：把「被 setAside 的供应商记录」
// 放回并触发重列。插件页在登录后调一次即可自愈，用户不必再手动点「加回来」。
// 老宿主没有这条通道，调用失败必须静默，不能影响其它功能。

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const app = fs.readFileSync(new URL('../page/app.js', import.meta.url), 'utf8')

test('package.json 声明了 neartoken:relist 通道', () => {
  assert.ok(Array.isArray(pkg.magpie?.calls), 'magpie.calls 应为数组')
  assert.ok(pkg.magpie.calls.includes('neartoken:relist'), '缺少 neartoken:relist')
})

test('页面在已连接时调用 relist，且失败静默', () => {
  assert.match(app, /call\('neartoken:relist'\)/, '应实际调用该通道')
  assert.match(app, /if \(view\.configured\) selfHealProvider\(\)/, '只在已连接时调用')
  // 失败走 catch 分支而不是抛给用户
  assert.match(app, /catch \{[\s\S]{0,120}老宿主没有这条通道/, '失败要静默处理')
})

test('每会话最多重试两次，避免反复打扰宿主', () => {
  assert.match(app, /let relistTries = 0/, '应有调用计数')
  assert.match(app, /if \(relistTries >= 2\) return/, '超过两次不再调用')
  assert.match(app, /setTimeout\(\(\) => \{ selfHealProvider\(\) \}, 3000\)/, '失败隔 3 秒重试一次')
})

test('magpie.min 抬到 2.3.2（fish.27 起才有 relist 与五类分区）', () => {
  assert.equal(pkg.magpie.min, '2.3.2')
})
