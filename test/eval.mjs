// 开发用小工具：把任意页面表达式文件在游戏页里跑一次，打印返回的 JSON。
//
// 用法：node test/eval.mjs test/_probe/xxx.js         打印格式化 JSON
//       node test/eval.mjs test/_probe/xxx.js out.json 同时写文件
//
// 只做 Runtime.evaluate，不做任何写操作；表达式必须自己返回 JSON 字符串
// （returnByValue，因此不能返回 Promise）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GameClient } from '../lib/index.js'
import { resolveProfile } from '../lib/profile.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const prof = resolveProfile({}, () => {})
const client = new GameClient({
  cdpHost: prof.cdpHost,
  cdpPort: prof.cdpPorts[0],
  cdpPorts: prof.cdpPorts,
  gameHostHints: prof.gameHostHints,
  gameTitles: prof.gameTitles,
})

const file = process.argv[2]
if (!file) { console.log('用法: node test/eval.mjs <表达式文件.js> [输出.json]'); process.exit(1) }
const expr = fs.readFileSync(path.resolve(file), 'utf8')

try {
  const out = await client.evalRaw(expr, 120000)
  let parsed = out
  if (typeof out === 'string') { try { parsed = JSON.parse(out) } catch (e) {} }
  const text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 1)
  console.log(text)
  if (process.argv[3]) fs.writeFileSync(path.resolve(process.argv[3]), text)
} catch (e) {
  console.log('ERROR ' + ((e && e.message) || e))
  process.exitCode = 1
} finally {
  client.close()
  process.exit(process.exitCode || 0)
}
