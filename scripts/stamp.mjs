// 把 package.json 的 version 写进 page/version.js，页面头部就能显示版本号。
// 版本号的唯一权威仍是 package.json；这里只是把它抄一份给沙箱里的页面用
// （页面没有网络，也没有读包内 JSON 的通道）。
//
// 用法：node scripts/stamp.mjs   （npm pack 前会自动跑一次）

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const out = join(root, 'page', 'version.js')
const body = `// 由 scripts/stamp.mjs 生成，别手改：版本号在 package.json。\nself.NEARTOKEN_VERSION = ${JSON.stringify(pkg.version)}\n`
writeFileSync(out, body, 'utf8')
console.log(`page/version.js ← ${pkg.version}`)