import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const app = fs.readFileSync(new URL('../page/app.js', import.meta.url), 'utf8')
const css = fs.readFileSync(new URL('../page/market.css', import.meta.url), 'utf8')

test('耗时竖条按总耗时分三档：<5s 绿、5–15s 橙黄、≥15s 红', () => {
  assert.match(app, /const tierClass = \(v\) =>/, '应有分档函数')
  assert.match(app, /n < 5\) return 'lg-dur-fast'/, '5 秒以下为快')
  assert.match(app, /n < 15\) return 'lg-dur-mid'/, '5–15 秒为中等')
  assert.match(app, /return 'lg-dur-slow'/, '15 秒以上为慢')
  for (const cls of ['lg-dur-fast', 'lg-dur-mid', 'lg-dur-slow']) {
    assert.ok(css.includes(`.logs .${cls}`), 'CSS 应有 ' + cls)
  }
})

test('耗时样式不套工具栏胶囊（.lg-bar 是工具栏，套上会变丑）', () => {
  // 类名必须是 lg-dur；用 lg-bar 会命中 .lg-bar 的边框/内边距，整行变成胶囊
  assert.equal(/class: 'lg-bar ' \+ tierClass/.test(app), false, '耗时不应使用 lg-bar 类名')
  assert.match(app, /class: 'lg-dur ' \+ tierClass/, '应使用独立的 lg-dur')
  assert.match(css, /\.logs \.lg-dur \{[^}]*border: 0; background: none; border-radius: 0/, '显式清掉盒子造型')
})

test('首字与耗时各自分档，竖条与数值同色', () => {
  assert.match(app, /tierClass\(r\.ttft\)/, '首字按自身秒数分档')
  assert.match(app, /tierClass\(r\.dur\)/, '耗时按自身秒数分档')
  assert.match(css, /\.logs \.lg-dur::before \{[^}]*background: currentColor/, '竖条跟随文字颜色')
  assert.match(css, /\.logs \.lg-dur-none::before \{ background: transparent/, '没有数据时不画条')
})

test('模型胶囊是液态玻璃样式', () => {
  assert.match(css, /\.logs \.lg-model-pill \{[^}]*backdrop-filter: blur\(10px\)/, '应有背景模糊')
  assert.match(css, /\.logs \.lg-model-pill \{[^}]*inset 0 1px 0 rgba\(255,255,255,\.22\)/, '应有内高光')
  assert.match(css, /\.logs \.lg-model-pill \{[^}]*border-radius: 999px/, '应是胶囊')
})