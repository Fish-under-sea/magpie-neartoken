import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const css = fs.readFileSync(new URL('../page/style.css', import.meta.url), 'utf8')
const market = fs.readFileSync(new URL('../page/market.css', import.meta.url), 'utf8')
const app = fs.readFileSync(new URL('../page/app.js', import.meta.url), 'utf8')

test('代金券不再有左侧竖条（旧票根 ::before 已移除）', () => {
  // 竖条是旧的 .voucher::before（3px 琥珀色贴左边），整段已删
  assert.equal(/\.voucher::before\s*\{/.test(css), false, 'style.css 不应再有 .voucher::before 竖条')
  assert.equal(/width:\s*3px/.test(css), false, '不应再有 3px 宽的装饰条')
  // market.css 里显式清掉伪元素，作为兜底
  assert.match(market, /\.card \.voucher::before, \.card \.voucher::after \{ content: none; border: 0; \}/)
})

test('代金券胶囊内部是「徽标 + 金额」两端对齐', () => {
  assert.match(market, /\.card \.voucher \{[^}]*justify-content: space-between/, '内部应两端对齐')
  assert.match(market, /\.card \.voucher \{[^}]*border-radius: 999px/, '仍是胶囊')
})

test('代金券不再重复拼组名（Grok Grok）', () => {
  // groupBadge 已经渲染组名，外面再拼 vname 就会重复
  assert.equal(/class: 'vname'/.test(app), false, '不应再额外拼一次组名')
  assert.match(app, /el\('span', \{ class: 'who' \}, groupBadge\(String\(v\.group \|\| ''\)\)\)/)
})
