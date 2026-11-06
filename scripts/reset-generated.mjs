// 打包前把「插件运行时写入」的文件复位成占位，避免本地测试产生的运行时数据进包。
// 只动这三个：logs.js / logs-meta.js / health.js（pricing.js 是包内快照，不能动）。
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const page = (name) => join(here, 'page', name)

const files = {
  'logs.js': "// 占位：插件运行时会把站点逐条日志覆盖写入这里。\nself.NEARTOKEN_LOGS = self.NEARTOKEN_LOGS || { at: 0, rows: [] }\n",
  'logs-meta.js': "// 占位：插件运行时会把最近一次逐条日志抓取的结果覆盖写入这里。\nself.NEARTOKEN_LOGS_META = self.NEARTOKEN_LOGS_META || { at: 0, ok: false, stage: 'init', rows: 0 }\n",
  'health.js': "// 占位：插件运行时会把最近几次 provider.models() 的调用结果覆盖写入这里。\nself.NEARTOKEN_HEALTH = self.NEARTOKEN_HEALTH || { at: 0, recent: [] }\n",
}

for (const [name, body] of Object.entries(files)) {
  writeFileSync(page(name), body, 'utf8')
  console.log('reset page/' + name)
}