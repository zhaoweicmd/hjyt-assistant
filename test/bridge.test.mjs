// 传输层测试：起一个假的 DSH Browser Control 桥（POST /api/command），
// 验证 GameClient 的「连桥 → 找标签页 → eval → 异常映射」全链路，不需要真游戏、不需要 Chrome。
//
// 用法：node test/bridge.test.mjs
import http from 'node:http'
import { GameClient } from '../lib/index.js'

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 200) : '')) }
}

const BIG = 'x'.repeat(60000)
const TOKEN = 'dsh-local'
const GAME_TAB = 555
let hits = 0
let lastAuth = null

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !String(req.url || '').startsWith('/api/command')) {
    res.writeHead(404); res.end('no'); return
  }
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    hits++
    lastAuth = req.headers.authorization || null
    if (lastAuth !== 'Bearer ' + TOKEN) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'unauthorized', code: 'unauthorized' }))
      return
    }
    let msg = {}
    try { msg = JSON.parse(raw) } catch (e) {}
    const cmd = msg.command
    const params = msg.params || {}
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (cmd === 'browser.info') return send({ ok: true, result: { client: 'mock-ext', version: '1.0.0', browser: { version: '999' } } })
    if (cmd === 'tabs.list') {
      return send({ ok: true, result: { tabs: [
        { id: 111, title: '哔哩哔哩', url: 'https://www.bilibili.com/' },
        { id: GAME_TAB, title: '航迹云途 - 航空公司模拟经营游戏', url: 'https://hangjiyuntu.cn/' },
      ] } })
    }
    if (cmd === 'eval') {
      const expr = String(params.expression || '')
      if (expr.includes('__hang')) return                       // 不回包 → 触发超时
      if (expr.includes('__boom')) return send({ ok: false, error: 'page exception: Error: BOOM\n    at <anonymous>:1:13', code: 'command_failed', hint: '扩展报回失败' })
      let value
      if (expr.includes('typeof GameState')) value = 'yes'
      else if (expr.includes('__big')) value = JSON.stringify({ ok: true, blob: BIG })
      else value = JSON.stringify({ ok: true, kind: 'mock', tabId: params.tabId, len: expr.length })
      return send({ ok: true, result: { tabId: params.tabId, value, valueType: 'string' } })
    }
    send({ ok: false, error: 'unknown command: ' + cmd, code: 'bad_command' })
  })
})
let port = 0
await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve() }))
const BRIDGE = 'http://127.0.0.1:' + port
console.log('mock bridge on ' + BRIDGE)

const client = new GameClient({
  transport: 'bridge',
  bridgeUrl: BRIDGE,
  bridgeToken: TOKEN,
  cdpHost: '127.0.0.1',
  cdpPort: 1,          // 故意指向一个没人监听的端口：确保真的走桥，不是 CDP
  cdpPorts: [1],
  gameHostHints: ['hangjiyuntu.cn'],
  gameTitles: ['航迹云途'],
})

try {
  console.log('== 1. 连桥 + 找游戏标签页 ==')
  await client.connect()
  ok(client.mode === 'bridge', 'mode 切到 bridge', client.mode)
  ok(client.bridgeTabId === GAME_TAB, '按 URL 线索命中游戏标签页', client.bridgeTabId)
  ok(client.bridgeInfo && client.bridgeInfo.client === 'mock-ext', 'browser.info 解析', client.bridgeInfo)
  ok(lastAuth === 'Bearer ' + TOKEN, '请求带 Bearer token', lastAuth)

  console.log('== 2. eval（命令名是 eval）==')
  const r1 = await client.evalJson('(() => JSON.stringify({ ok: true }))()')
  ok(r1 && r1.ok === true && r1.kind === 'mock', 'evalJson 解析出对象', r1)
  ok(r1 && r1.tabId === GAME_TAB, 'eval 带上游戏 tabId', r1 && r1.tabId)
  const raw = await client.evalRaw('(() => 1 + 1)()')
  ok(typeof raw === 'string', 'evalRaw 返回字符串', typeof raw)

  console.log('== 3. 大 payload（6 万字符）==')
  const big = await client.evalJson('(() => JSON.stringify({ ok: true, __big: 1 }))()')
  ok(big && typeof big.blob === 'string' && big.blob.length === BIG.length, '6 万字符无截断', big && big.blob && big.blob.length)

  console.log('== 4. 页面异常映射 ==')
  let msg = ''
  try { await client.evalRaw('(() => { throw new Error("BOOM") })() __boom') } catch (e) { msg = String(e.message) }
  ok(msg.includes('页面执行出错'), 'page exception → 「页面执行出错」', msg.slice(0, 80))
  ok(client.mode === 'bridge', '页面异常不清掉桥连接（只清传输层故障）', client.mode)

  console.log('== 5. 超时 ==')
  const t0 = Date.now()
  let threw = false
  try { await client.evalRaw('__hang', 800) } catch (e) { threw = true }
  const dt = Date.now() - t0
  ok(threw, '超时能抛出（不挂死）', dt)
  ok(dt < 9000, '超时在 9s 内返回', dt)
} finally {
  client.close()
}

console.log('== 6. transport=cdp 时不碰桥 ==')
const before = hits
const cdpOnly = new GameClient({
  transport: 'cdp',
  bridgeUrl: BRIDGE,
  bridgeToken: TOKEN,
  cdpHost: '127.0.0.1',
  cdpPort: port,
  cdpPorts: [port],
  gameHostHints: ['hangjiyuntu.cn'],
  gameTitles: ['航迹云途'],
})
let cdpThrew = false
try { await cdpOnly.connect() } catch (e) { cdpThrew = true }
ok(cdpThrew, 'transport=cdp 时连不上就报错（不偷偷走桥）', cdpThrew)
ok(hits === before, 'transport=cdp 时桥零请求', hits - before)
cdpOnly.close()

server.close()
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
