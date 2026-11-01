// 传输层测试：起一个假的 CDP 服务（HTTP /json/list + WebSocket Runtime.evaluate），
// 验证 GameClient 的「找标签页 → 连 ws → evalJson」全链路，不需要真游戏。
//
// 用法：node test/cdp.test.mjs
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { GameClient } from '../lib/index.js'

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 200) : '')) }
}

const BIG = 'x'.repeat(60000)

// ---- 假 CDP 服务 ----
const server = http.createServer((req, res) => {
  if (req.url === '/json/list') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify([
      { type: 'page', title: '航迹云途 - 航空公司模拟经营游戏', url: 'https://hangjiyuntu.cn/', webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/page/FAKE' },
      { type: 'page', title: '新标签页', url: 'chrome://newtab/', webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/page/OTHER' },
    ]))
    return
  }
  if (req.url === '/json/version') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ Browser: 'mock-chrome/1.0', 'Protocol-Version': '1.3' }))
    return
  }
  res.writeHead(404)
  res.end('no')
})
const wss = new WebSocketServer({ server, path: '/devtools/page/FAKE' })
wss.on('connection', (sock) => {
  sock.on('message', (raw) => {
    let msg = null
    try { msg = JSON.parse(raw.toString()) } catch (e) { return }
    if (msg.method !== 'Runtime.evaluate') {
      sock.send(JSON.stringify({ id: msg.id, result: {} }))
      return
    }
    const expr = String((msg.params && msg.params.expression) || '')
    let value
    if (expr.includes('__hang')) return                       // 不回包 → 触发客户端超时
    else if (expr.includes('__big')) value = JSON.stringify({ ok: true, blob: BIG })
    else if (expr.includes('typeof GameState')) value = 'yes'
    else value = JSON.stringify({ ok: true, kind: 'mock', len: expr.length, head: expr.slice(0, 24) })
    sock.send(JSON.stringify({ id: msg.id, result: { result: { type: 'string', value } } }))
  })
})
let port = 0
await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve() }))
console.log('mock CDP on 127.0.0.1:' + port)

const client = new GameClient({
  transport: 'cdp',    // 本用例只验 CDP 链路：别让 auto 在失败时退到 Browser Control 桥
  cdpHost: '127.0.0.1',
  cdpPort: port,
  cdpPorts: [port],
  gameHostHints: ['hangjiyuntu.cn'],
  gameTitles: ['航迹云途'],
})

try {
  console.log('== 1. 找标签页（URL/标题匹配）==')
  const tab = await client.findGameTab()
  ok(!!tab, '找到页面标签')
  ok(String(tab && tab.url).includes('hangjiyuntu.cn'), '优先命中 URL 线索', tab && tab.url)

  console.log('== 2. WebSocket 连接 ==')
  await client.connect()
  ok(client.ws && client.ws.readyState === 1, 'ws 已连接')
  ok(client.ws && (client.ws.kind === 'ws' || client.ws.kind === 'native'), '适配层实现名', client.ws && client.ws.kind)

  console.log('== 3. Runtime.evaluate（JSON 往返）==')
  const r1 = await client.evalJson('(() => JSON.stringify({ ok: true, a: 1 }))()')
  ok(r1 && r1.ok === true && r1.kind === 'mock', 'evalJson 解析出对象', r1)
  const raw = await client.evalRaw('(() => JSON.stringify({ ok: true }))()')
  ok(typeof raw === 'string', 'evalRaw 返回字符串')

  console.log('== 4. 大 payload（6 万字符，验证不截断）==')
  const big = await client.evalJson('(() => JSON.stringify({ ok: true, __big: 1 }))()')
  ok(big && typeof big.blob === 'string' && big.blob.length === BIG.length, '6 万字符无截断', big && big.blob && big.blob.length)

  console.log('== 5. 超时与错误 ==')
  const t0 = Date.now()
  let threw = false
  try { await client.evalJson('(() => JSON.stringify({ ok: true, __hang: 1 }))()', 800) } catch (e) { threw = true }
  const dt = Date.now() - t0
  ok(threw, '超时能抛出（不挂死）', dt)
  ok(dt < 9000, '超时在 9s 内返回（evalJson 800 + cdp 余量 5000）', dt)
} finally {
  client.close()
  wss.close()
  server.close()
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
