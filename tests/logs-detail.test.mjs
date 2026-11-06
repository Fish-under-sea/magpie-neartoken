import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')

// 把 detailOf / tierPrices / shortNum 从源码里抽出来单独跑，
// 避免为了测试去启动整个插件运行时。
const pick = (name) => {
  const i = src.indexOf('function ' + name)
  assert.ok(i > 0, '应找到 ' + name)
  // 从函数头找到配对的右花括号
  let depth = 0
  let j = src.indexOf('{', i)
  const start = src.lastIndexOf('\n', i)
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(start, k + 1) }
  }
  throw new Error('未闭合：' + name)
}

const helpers = `
function num(v) {
  const n = Number(String(v ?? '').replace(/[^\\d.-]/g, ''))
  return Number.isFinite(n) ? n : undefined
}
${pick('shortNum')}
${pick('tierLabel')}
${pick('tierPrices')}
${pick('detailOf')}
`
const mod = new Function(helpers + '; return { detailOf }')()
const { detailOf } = mod

// 以下三条都来自 2026-11-07 实测 /api/log/token 的真实返回
const sol = {
  matched_tier: '0_272k', billing_mode: 'tiered_expr', model_ratio: 0, completion_ratio: 0,
  expr_b64: Buffer.from(
    '(len <= 272000 ? tier("0_272k", p * 2 + cr * 0.1 + cc * 2.5 + c * 10) : '
    + 'tier("272k_plus", p * 4 + cr * 0.2 + cc * 5 + c * 15))', 'utf8').toString('base64'),
}
const astra = {
  matched_tier: '0_272k', billing_mode: 'tiered_expr', model_ratio: 0, completion_ratio: 0,
  expr_b64: Buffer.from(
    '(len <= 272000 ? tier("0_272k", p * 10 + cr * 1 + cc * 12.5 + c * 50) : '
    + 'tier("272k_plus", p * 20 + cr * 2 + cc * 25 + c * 75))', 'utf8').toString('base64'),
}
const terra = { model_ratio: 0.5, completion_ratio: 5, cache_ratio: 0.05, matched_tier: null }

test('表达式计费取真实单价：gpt-6.1-sol 是 ¥2 / ¥10/M', () => {
  assert.equal(detailOf(sol, 39), '0_272k · ¥2 / ¥10/M')
})

test('表达式计费取真实单价：gpt-6-astra 是 ¥10 / ¥50/M', () => {
  assert.equal(detailOf(astra, 196), '0_272k · ¥10 / ¥50/M')
})

test('倍率计费换算成单价：gpt-6.1-terra 是 ¥1 / ¥5/M', () => {
  // 输入 = model_ratio × 2 = 1；输出 = model_ratio × completion_ratio × 2 = 5
  assert.equal(detailOf(terra, 23), '标准 · ¥1 / ¥5/M')
})

test('缓存读写系数不会被当成输出单价', () => {
  // cr / cc 都含字母 c，若正则不排除就会把 0.1 或 2.5 当成 c 的系数
  assert.equal(detailOf(sol, 39).includes('¥2 / ¥10/M'), true)
  assert.equal(/¥2 \/ ¥0\.1/.test(detailOf(sol, 39)), false)
})

test('时段档位显示中文，不再把内部 key 抛给用户', () => {
  // 实测 deepseek-flash：tier("peak", … c * 8) / tier("off_peak", … c * 4)
  const expr = 'weekday("UTC") <= 5 ? tier("peak", p * 2 + cr * 0.04 + c * 8) '
    + ': tier("off_peak", p * 1 + cr * 0.02 + c * 4)'
  const off = { matched_tier: 'off_peak', expr_b64: Buffer.from(expr, 'utf8').toString('base64') }
  const peak = { matched_tier: 'peak', expr_b64: Buffer.from(expr, 'utf8').toString('base64') }
  assert.equal(detailOf(off, 199), '谷时 · ¥1 / ¥4/M')
  assert.equal(detailOf(peak, 199), '峰时 · ¥2 / ¥8/M')
  assert.equal(/off_peak|peak/.test(detailOf(off, 199) + detailOf(peak, 199)), false, '不应出现英文内部 key')
})

test('没有计价信息时退回额度，不编造单价', () => {
  assert.equal(detailOf({}, 100), '额度 100')
  assert.equal(detailOf(null, 100), '')
})
