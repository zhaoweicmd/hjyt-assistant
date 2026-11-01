// 开发用小工具：直接跑 lib/expr.js 里的命名表达式，把结果落盘。
//
// 用法：node test/dump.mjs <buy|route|health|board|status|state|audit> [参数JSON] [输出.json]
//   例：node test/dump.mjs health              → test/fixtures/health.json
//       node test/dump.mjs route '{"fromAirports":["上海浦东"]}' → test/fixtures/route.json
//       node test/dump.mjs board '{"days":14}'
//
// 只做 Runtime.evaluate（只读），不做任何写操作。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GameClient } from '../lib/index.js'
import { resolveProfile } from '../lib/profile.js'
import { STATUS_EXPR, STATE_EXPR, AUDIT_EXPR, BUY_EXPR, routeExpr, HEALTH_EXPR, boardExpr } from '../lib/expr.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const prof = resolveProfile({}, () => {})
const client = new GameClient({
  cdpHost: prof.cdpHost,
  cdpPort: prof.cdpPorts[0],
  cdpPorts: prof.cdpPorts,
  gameHostHints: prof.gameHostHints,
  gameTitles: prof.gameTitles,
})

const name = (process.argv[2] || 'buy').toLowerCase()
let params = {}
if (process.argv[3]) { try { params = JSON.parse(process.argv[3]) } catch (e) { params = {} } }
const outFile = process.argv[4] || path.join(HERE, 'fixtures', name + '.json')

let expr
if (name === 'status') expr = STATUS_EXPR
else if (name === 'state') expr = STATE_EXPR
else if (name === 'audit') expr = AUDIT_EXPR
else if (name === 'buy') expr = BUY_EXPR
else if (name === 'route') expr = routeExpr(params)
else if (name === 'health') expr = HEALTH_EXPR
else if (name === 'board') expr = boardExpr(params.days || 14)
else { console.log('未知表达式: ' + name); process.exit(1) }

try {
  const out = await client.evalRaw(expr, 180000)
  let parsed = out
  if (typeof out === 'string') { try { parsed = JSON.parse(out) } catch (e) {} }
  const text = JSON.stringify(parsed, null, 1)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, text)
  const summary = (parsed && typeof parsed === 'object')
    ? Object.keys(parsed).map((k) => {
      const v = parsed[k]
      if (Array.isArray(v)) return k + '[' + v.length + ']'
      if (v && typeof v === 'object') return k + '{' + Object.keys(v).length + '}'
      return k + '=' + JSON.stringify(v)
    }).join(' ')
    : String(parsed)
  console.log('OK ' + outFile)
  console.log(summary.slice(0, 1200))
} catch (e) {
  console.log('ERROR ' + ((e && e.message) || e))
  process.exitCode = 1
} finally {
  client.close()
  process.exit(process.exitCode || 0)
}
