// 航迹云途 · DSH 辅助插件（宿主侧）
//
// 职责：
//   1. 通过 Chrome DevTools Protocol（默认 127.0.0.1:9222）连到游戏标签页，只读读取 GameState
//   2. 把只读 HUD 注入游戏页面（按钮只往 window.__HJYT_QUEUE 压命令，写操作全部在本宿主执行）
//   3. 一键日常：清理幽灵飞行 → 预约检修 → 补油 → 推进 → 五项校验（复用既有脚本与 tick_day.js）
//   4. 一键排班：读机队/航线 → 搜索无冲突时段 → 出方案表 → 确认后写入 → 自检
//   5. 注册 agent 工具 + HTTP 路由（/hjyt/*），供我与你直接调用

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
// WebSocket 实现：优先用 ws（本机 node_modules / 宿主 profile 里通常都有），
// 没有就退回 Node 22+ 内置的 WebSocket —— 这样插件不依赖 node_modules，
// 换机器（macOS↔Windows）、只同步源码目录也能直接跑。
let NodeWs = null
try {
  const m = await import('ws')
  NodeWs = m.default || m.WebSocket || null
} catch (e) {}
const NativeWs = (typeof globalThis.WebSocket === 'function') ? globalThis.WebSocket : null
if (!NodeWs && !NativeWs) throw new Error('hjyt-assistant: 没有可用的 WebSocket 实现（需要 ws 模块，或 Node 22+ 内置 WebSocket）')

/** 把 ws / 内置 WebSocket 抹平成同一套 `.on()/.send()/.close()/.terminate()` 接口 */
class WsCompat {
  constructor(url, opts = {}) {
    this._h = { open: [], message: [], error: [], close: [] }
    if (NodeWs) {
      const s = new NodeWs(url, opts)
      s.on('open', () => this._emit('open'))
      s.on('message', (raw) => this._emit('message', raw))
      s.on('error', (e) => this._emit('error', e))
      s.on('close', () => this._emit('close'))
      this._s = s
      this.kind = 'ws'
    } else {
      const s = new NativeWs(url)
      s.addEventListener('open', () => this._emit('open'))
      s.addEventListener('message', (ev) => this._emit('message', ev.data))
      s.addEventListener('error', (e) => this._emit('error', e))
      s.addEventListener('close', () => this._emit('close'))
      this._s = s
      this.kind = 'native'
    }
  }
  on(ev, fn) { (this._h[ev] || (this._h[ev] = [])).push(fn); return this }
  _emit(ev, arg) {
    const list = this._h[ev] || []
    for (const fn of list) { try { fn(arg) } catch (e) {} }
  }
  send(data) { this._s.send(data) }
  close() { try { this._s.close() } catch (e) {} }
  terminate() { if (typeof this._s.terminate === 'function') { try { this._s.terminate() } catch (e) {} } else this.close() }
  get readyState() { return this._s.readyState }
}
// 2026-10-21 修：不再 `import('@deepseek-ai/dsh-tools')`（新版宿主里解析不到，
// 静默退化成恒等函数 → 作者 DSL 原样进 register → 32 个工具全部报
// `schema.properties.text.required is not supported on type "string"`）。
// 改为本地按宿主同一套规则编译成 raw JSON Schema，见 lib/schema.js。
import { defineRawTool } from './schema.js'
import { planFleet, DEFAULT_OPTS } from './sched.js'
import { STATUS_EXPR, STATE_EXPR, AUDIT_EXPR, GAME_VALIDATE_EXPR, tickExpr, BUY_EXPR, routeExpr, HEALTH_EXPR, boardExpr, SELECTED_ROUTE_EXPR, routePolicyExpr, routeFareExpr, cabinQuoteExpr, AIRCRAFT_LIST_EXPR, renameAircraftExpr, AIRCRAFT_ROUTES_EXPR, applyRenameExpr, CABIN_INPUT_EXPR, cabinRebuildExpr, FUEL_EXPR, PROFIT_EXPR, ROUTE_DEV_EXPR, AIRPORT_SEARCH_EXPR } from './expr.js'
import { buyPlan, routePlan, healthReport, boardView, bestCabin, buildRenamePlan, fuelPlan, expandPlan, sopChecks, isBlacklistedModel, profitPlan, routeDevPlan, deployCost } from './plan.js'
import { AIRPORT_QUERY_EXPR, buildSheets, briefRows, latestSaveBase, findSaveDir, fmtGameDate } from './airport_query.js'
import { writeXlsx } from './xlsx_min.js'
import { normalizeGameItems, summarizeGameCheck, chunkIds } from './gamecheck.js'
import { resolveProfile, stateFile } from './profile.js'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HUD_PATH = path.join(PKG_ROOT, 'lib', 'hud.src.js')
const PANEL_PATH = path.join(PKG_ROOT, 'lib', 'panel.html')
// 插件版本以 package.json 为唯一来源（HUD 版本指纹 = PKG_VERSION + hud.src.js 字节数）
const PKG_VERSION = (() => {
  try { return String(JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version || '0.0.0') } catch (e) { return '0.0.0' }
})()

// 游戏识别默认线索（可用 config.gameHostHints / config.gameTitles 覆盖；
// 都匹配不上时还会逐个标签页探测 GameState 是否存在）
const DEFAULT_GAME_HOSTS = ['hangjiyuntu.cn']
const DEFAULT_GAME_TITLES = ['航迹云途']

// ---------------------------------------------------------------------------
// 页面侧表达式
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CDP 客户端
// ---------------------------------------------------------------------------

class GameClient {
  constructor(cfg) {
    this.cfg = cfg
    this.ws = null
    this.wsUrl = null
    this.seq = 0
    this.pending = new Map()
    this.injected = false
    this.lastError = null
    this.queueTimer = null
    this.handlers = {}
    // 传输层：'cdp' = 直连 Chrome 远程调试端口；'bridge' = DSH Browser Control
    this.mode = 'cdp'
    this.bridgeTabId = null
    this.bridgeTabUrl = null
    this.bridgeInfo = null
    this.cdpDead = false          // CDP 连过一次失败就置 true（auto 模式下直接走桥）
  }

  httpJson(p) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: this.cfg.cdpHost, port: this.cfg.cdpPort, path: p, method: 'GET' }, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch (e) { resolve(null) }
        })
      })
      req.on('error', reject)
      req.setTimeout(4000, () => req.destroy(new Error('CDP HTTP 超时')))
      req.end()
    })
  }

  close() {
    try { if (this.ws) this.ws.close() } catch (e) {}
    this.ws = null
    this.wsUrl = null
    this.cdpDead = false
  }

  // ---- DSH Browser Control 桥 -------------------------------------------
  // @caob23/dsh-browser-control 在本机 9777 上开了 HTTP 入口 POST /api/command
  // （Bearer token，默认 dsh-local），由浏览器扩展用 chrome.debugger 执行。
  // 好处：只要扩展在线，用户「正常启动」的 Chrome 也能被驱动，不需要
  // --remote-debugging-port=9222，也不用重启浏览器。

  bridgeRequest(payload, timeoutMs = 30000) {
    const url = new URL('/api/command', this.cfg.bridgeUrl || 'http://127.0.0.1:9777')
    const body = JSON.stringify(payload)
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: 'Bearer ' + (this.cfg.bridgeToken || 'dsh-local'),
        },
      }, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          let msg = null
          try { msg = JSON.parse(data) } catch (e) {}
          if (!msg) return reject(new Error('Browser Control 返回的不是 JSON（HTTP ' + res.statusCode + '）'))
          if (msg.ok) return resolve(msg.result)
          const err = new Error(msg.error || ('Browser Control 失败（HTTP ' + res.statusCode + '）'))
          err.bridgeCode = msg.code || null
          err.hint = msg.hint || null
          reject(err)
        })
      })
      req.on('error', (e) => reject(new Error('连不上 DSH Browser Control（' + (this.cfg.bridgeUrl || '') + '）：' + ((e && e.message) || e))))
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Browser Control 命令超时（' + timeoutMs + 'ms）')))
      req.end(body)
    })
  }

  async bridgeCall(command, params = {}, timeoutMs = 30000) {
    return await this.bridgeRequest({ command, params, timeoutMs }, timeoutMs + 5000)
  }

  /** 找游戏标签页：先按域名 / 标题匹配，再逐个试读 GameState */
  async findBridgeTab() {
    const tabs = await this.bridgeCall('tabs.list', {}, 15000)
    const list = (tabs && tabs.tabs) || []
    const hosts = this.cfg.gameHostHints || DEFAULT_GAME_HOSTS
    const titles = this.cfg.gameTitles || DEFAULT_GAME_TITLES
    for (const h of hosts) { const hit = list.find((t) => String(t.url || '').includes(h)); if (hit) return hit }
    for (const k of titles) { const hit = list.find((t) => String(t.title || '').includes(k)); if (hit) return hit }
    for (const t of list.slice(0, 8)) {
      try {
        const r = await this.bridgeCall('eval', { tabId: t.id, expression: "typeof GameState !== 'undefined' ? 'yes' : 'no'" }, 8000)
        if (r && r.value === 'yes') return t
      } catch (e) {}
    }
    return null
  }

  /** 连 Browser Control；连不上返回 false（让上层退回 CDP） */
  async connectBridge() {
    this.bridgeInfo = await this.bridgeCall('browser.info', {}, 8000)
    const tab = await this.findBridgeTab()
    if (!tab) {
      this.lastError = 'Browser Control 已连上，但没找到游戏标签页——请在 Chrome 里打开游戏页'
      return false
    }
    this.bridgeTabId = tab.id
    this.bridgeTabUrl = tab.url
    this.mode = 'bridge'
    this.injected = false
    this.lastError = null
    return true
  }

  async findGameTab() {
    const hosts = this.cfg.gameHostHints || DEFAULT_GAME_HOSTS
    const titles = this.cfg.gameTitles || DEFAULT_GAME_TITLES
    const ports = this.cfg.cdpPorts && this.cfg.cdpPorts.length ? this.cfg.cdpPorts : [this.cfg.cdpPort]
    let pages = []
    for (const port of ports) {
      this.cfg.cdpPort = port
      let tabs = null
      try { tabs = await this.httpJson('/json/list') } catch (e) { continue }
      if (!Array.isArray(tabs)) continue
      const list = tabs.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (!list.length) continue
      pages = list
      for (const h of hosts) {
        const hit = list.find((t) => String(t.url || '').includes(h))
        if (hit) return hit
      }
      for (const k of titles) {
        const hit = list.find((t) => String(t.title || '').includes(k))
        if (hit) return hit
      }
      // 兜底：URL / 标题都没线索，就挑一个能读到 GameState 的标签页
      const guess = await this.probeGameState(list)
      if (guess) return guess
    }
    return pages[0] || null
  }

  /** 逐个标签页试读 GameState（多游戏、多存档、换域名都能接上） */
  async probeGameState(list) {
    for (const tab of list.slice(0, 8)) {
      let ws = null
      try {
        ws = await new Promise((resolve, reject) => {
          const sock = new WsCompat(tab.webSocketDebuggerUrl, { perMessageDeflate: false })
          const timer = setTimeout(() => { try { sock.terminate() } catch (e) {}; reject(new Error('probe timeout')) }, 1500)
          sock.on('open', () => { clearTimeout(timer); resolve(sock) })
          sock.on('error', (e) => { clearTimeout(timer); reject(e) })
        })
        const probe = JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: "typeof GameState !== 'undefined' ? 'yes' : 'no'", returnByValue: true } })
        const ok = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 1500)
          ws.on('message', (raw) => {
            try {
              const msg = JSON.parse(raw.toString())
              if (msg.id === 1) { clearTimeout(timer); resolve(!!(msg.result && msg.result.result && msg.result.result.value === 'yes')) }
            } catch (e) {}
          })
          try { ws.send(probe) } catch (e) { clearTimeout(timer); resolve(false) }
        })
        if (ok) return tab
      } catch (e) {
      } finally {
        try { ws && ws.close() } catch (e) {}
      }
    }
    return null
  }

  async connect() {
    const transport = this.cfg.transport || 'auto'
    // 已经走 Browser Control：先轻推一下（标签页被关 / 扩展掉线就重连）
    if (this.mode === 'bridge' && this.bridgeTabId) {
      try {
        await this.bridgeRequest({ command: 'eval', params: { tabId: this.bridgeTabId, expression: '1' } }, 8000)
        return
      } catch (e) {
        this.mode = 'cdp'
        this.bridgeTabId = null
        this.lastError = String((e && e.message) || e)
      }
    }
    if (this.ws && this.ws.readyState === 1) return
    // 顺序：auto / cdp 先试 CDP（能力最全），失败后 auto 再退 Browser Control 桥
    if (transport !== 'bridge' && !this.cdpDead) {
      try { await this.connectCdp(); return } catch (e) {
        this.lastError = String((e && e.message) || e)
        this.cdpDead = true          // 端口没开就别每次都重试，省掉每次请求的等待
      }
    }
    if (transport !== 'cdp') {
      try { if (await this.connectBridge()) return } catch (e) { this.bridgeInfo = null; this.lastError = String((e && e.message) || e) }
    }
    throw new Error(this.lastError || `未找到游戏标签页（CDP ${this.cfg.cdpHost}:${this.cfg.cdpPort}）——请确认游戏页已打开`)
  }

  async connectCdp() {
    if (this.ws && this.ws.readyState === 1) return
    const tab = await this.findGameTab()
    if (!tab) {
      const msg = `未找到游戏标签页（CDP ${this.cfg.cdpHost}:${this.cfg.cdpPort}）——请确认游戏页已打开`
      this.lastError = msg
      throw new Error(msg)
    }
    if (this.wsUrl === tab.webSocketDebuggerUrl && this.ws) {
      try { this.ws.terminate() } catch (e) {}
    }
    this.wsUrl = tab.webSocketDebuggerUrl
    await new Promise((resolve, reject) => {
      const ws = new WsCompat(this.wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
      const timer = setTimeout(() => { try { ws.terminate() } catch (e) {} ; reject(new Error('CDP WebSocket 连接超时')) }, 8000)
      ws.on('open', () => { clearTimeout(timer); this.ws = ws; this.injected = false; this.lastError = null; resolve() })
      ws.on('message', (raw) => {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch (e) { return }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: rs, reject: rj } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (msg.error) rj(new Error(msg.error.message || 'CDP 错误'))
          else rs(msg.result)
        }
      })
      ws.on('error', (err) => { clearTimeout(timer); this.lastError = String(err && err.message || err); reject(err) })
      ws.on('close', () => { this.ws = null; this.injected = false })
    })
  }

  async cdp(method, params = {}, timeoutMs = 30000) {
    await this.connect()
    const id = ++this.seq
    const payload = JSON.stringify({ id, method, params })
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）——页面可能卡死`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      try { this.ws.send(payload) } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e) }
    })
  }

  async evalRaw(expression, timeoutMs = 30000) {
    if (this.mode === 'bridge') {
      let out = null
      try {
        out = await this.bridgeCall('eval', { tabId: this.bridgeTabId, expression, returnByValue: true }, timeoutMs)
      } catch (e) {
        const msg = String((e && e.message) || e)
        if (/page exception/i.test(msg)) throw new Error('页面执行出错：' + msg.replace(/^page exception:\s*/i, ''))
        // 扩展掉线 / 标签页关了 → 下次调用重新连（connect 会再试 Browser Control）
        this.mode = 'cdp'
        this.bridgeTabId = null
        throw e
      }
      return out ? out.value : undefined
    }
    const r = await this.cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false, timeout: timeoutMs }, timeoutMs + 5000)
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(`页面执行出错：${(d.exception && d.exception.description) || d.text || '未知异常'}`)
    }
    return r && r.result ? r.result.value : undefined
  }

  async evalJson(expression, timeoutMs = 30000) {
    const v = await this.evalRaw(expression, timeoutMs)
    if (typeof v === 'string') return JSON.parse(v)
    return v
  }

  /** 注入只读 HUD（新文档脚本 + 当前页面各注入一次） */
  async ensureHud(force = false) {
    // CDP 模式有「新文档脚本」，注入一次就够；Browser Control 模式没有这个能力，
    // 每次都要问页面要版本号（读档 / 刷新会连带 HUD 一起没了）
    if (this.injected && !force && this.mode !== 'bridge') return
    let src = ''
    try { src = fs.readFileSync(HUD_PATH, 'utf8') } catch (e) { return }
    // 版本号带上文件大小：改过 hud.src.js 就自动换版本，页面上那份旧 HUD 会被替换掉
    // 基础版本读 package.json，别再硬编码（曾是 0.7.4 而 package.json 已 0.7.7，页面显示对不上）
    let ver = PKG_VERSION
    try { ver = PKG_VERSION + '+' + fs.statSync(HUD_PATH).size } catch (e) {}
    src = src.split('__HJYT_VERSION__').join(ver)
    src = 'window.__HJYT_CASH_IDLE=' + Number(this.cfg.cashIdle || 1500) + ';\n' + src
    if (this.mode === 'bridge') {
      // Browser Control 没有「新文档脚本」能力：页面刷新 / 读档后 HUD 会跟着没了，
      // 所以每次都问页面要版本标记，缺了就整段重注入（HUD 自己也有每秒自愈，双保险）。
      try {
        const cur = await this.evalRaw('String(window.__HJYT_HUD_VER__ || "")', 10000)
        if (cur !== ver) {
          await this.evalRaw(src, 20000)
          const after = await this.evalRaw('String(window.__HJYT_HUD_VER__ || "")', 10000)
          this.injected = after === ver
          if (!this.injected) this.lastError = 'HUD 注入后版本标记没变（页面可能拦了脚本执行）'
        } else {
          this.injected = true
        }
      } catch (e) {
        this.injected = false
        this.lastError = String((e && e.message) || e)
        throw e
      }
      return
    }
    try {
      await this.cdp('Page.enable', {})
      await this.cdp('Page.addScriptToEvaluateOnNewDocument', { source: src })
    } catch (e) {}
    try { await this.evalRaw(src) } catch (e) {}
    this.injected = true
  }

  async status() {
    return await this.evalJson(STATUS_EXPR)
  }

  async readState() {
    return await this.evalJson(STATE_EXPR)
  }

  /**
   * 推进一天。
   *   script 模式：跑工作区里的 tick_day.js（含我这套自愈/补油/票价微调，功能更全）
   *   engine 模式：只用引擎自带 advanceGameTime，任何存档 / 任何玩家的页面都能跑
   */
  async tickDay(timeoutMs = 180000) {
    if (this.cfg.tickMode === 'script' && this.cfg.scriptsDir) {
      const p = path.join(this.cfg.scriptsDir, 'tick_day.js')
      if (fs.existsSync(p)) {
        const src = fs.readFileSync(p, 'utf8')
        return await this.evalJson(src, timeoutMs)
      }
    }
    return await this.evalJson(tickExpr(3600, 24), timeoutMs)
  }

  async pollQueue() {
    try {
      await this.connect()
      await this.ensureHud()
      const raw = await this.evalRaw(`JSON.stringify((function () {
        try {
          var G = (typeof GameState !== 'undefined') ? GameState : window.GameState;
          if (G && G.faultSystemEnabled === true) {
            G.faultSystemEnabled = false;
            var list = (G.aircrafts || []);
            for (var i = 0; i < list.length; i++) {
              var a = list[i];
              try { if (a.faultStatus && a.faultStatus !== 'none' && !a.faultResolved && typeof resolveFault === 'function') resolveFault(a.id); } catch (e1) {}
              try { var d = a.departureDelay; if (d && d.active && d.active.blockers) d.active.blockers = d.active.blockers.filter(function (b) { return b && b.code !== 'fault' }); } catch (e2) {}
            }
            if (typeof updateFaultAlert === 'function') { try { updateFaultAlert(); } catch (e3) {} }
          }
        } catch (e0) {}
        return (window.__HJYT_QUEUE || (window.__HJYT_QUEUE = [])).splice(0);
      })())`, 10000)
      const cmds = raw ? JSON.parse(raw) : []
      for (const c of cmds) await this.runCommand(c)
      this.__pumpFailAt = 0
      if (!this.__pumpOkOnce) {
        this.__pumpOkOnce = 1
        try { note({ op: 'pump-ok', cmds: cmds.length, mode: this.mode }) } catch (e2) {}
      }
    } catch (e) {
      this.lastError = String((e && e.message) || e)
      // 每 30 秒最多记一条，避免刷爆日志；用来区分「宿主没跑轮询」和「跑不起来」
      const now = Date.now()
      if (!this.__pumpFailAt || now - this.__pumpFailAt > 30000) {
        this.__pumpFailAt = now
        try { note({ op: 'pump-fail', mode: this.mode, err: this.lastError }) } catch (e2) {}
      }
    }
  }

  async reportToHud(obj) {
    try {
      await this.evalRaw(`window.__HJYT_LAST = ${JSON.stringify(JSON.stringify(obj))}`)
    } catch (e) {}
  }

  async runCommand(c) {
    const t0 = Date.now()
    let out
    try {
      out = await this.handlers[c.cmd](c)
    } catch (e) {
      out = { ok: false, error: String((e && e.message) || e) }
    }
    out = Object.assign({ cmd: c.cmd, ms: Date.now() - t0 }, out)
    try {
      fs.appendFileSync(stateFile(this.cfg, 'plugin_log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), source: 'hud', ...out }) + '\n')
    } catch (e) {}
    await this.reportToHud(out)
    return out
  }
}

// ---------------------------------------------------------------------------
// 写操作（白名单）
// ---------------------------------------------------------------------------

/**
 * 本地脚本桥。工作区有我这套脚本时功能最全；没有时 has() 全返回 false，
 * 上层自动切到「纯页面」实现（任何玩家、任何存档都能跑）。
 */
function makeRunner(prof) {
  const DIR = prof.scriptsDir
  const LEDGER = prof.ledgerFile
  const has = (name) => !!(DIR && fs.existsSync(path.join(DIR, name)))

  function runNode(script, args = [], timeoutMs = 120000) {
    if (!DIR) return { code: -1, stdout: '', stderr: '未找到本地脚本目录', noScripts: true }
    const env = Object.assign({}, process.env, { NO_PROXY: '127.0.0.1,localhost' })
    const r = spawnSync(process.execPath || 'node', [path.join(DIR, script), ...args], {
      cwd: DIR, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
    })
    // 沙箱/受限环境里 spawn 可能直接被拦（EPERM/ENOENT）→ status 为 null、stderr 为空
    const spawnError = r.error ? String(r.error.code || r.error.message || r.error) : null
    return {
      code: r.status == null ? -1 : r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      spawnError,
    }
  }

  function ledgerPath() { return LEDGER }
  function ledger() { return path.basename(LEDGER) }

  function fiveChecks() {
    if (!has('daily_check.js')) return null
    const r = runNode('daily_check.js', [LEDGER], 180000)
    // 脚本根本没能执行（沙箱拦 spawn / EPERM / ENOENT）→ 交给页面侧校验兜底
    if (r.spawnError || (r.code === -1 && !r.stdout.trim())) return null
    const red = []
    const warn = []
    for (const line of r.stdout.split('\n')) {
      if (line.includes('❌')) red.push(line.trim())
      else if (line.includes('⚠️')) warn.push(line.trim())
    }
    return { exitCode: r.code, red, warn, text: r.stdout.trim(), source: 'script' }
  }

  function readLedger() {
    try {
      if (!fs.existsSync(LEDGER)) return []
      return JSON.parse(fs.readFileSync(LEDGER, 'utf8'))
    } catch (e) { return [] }
  }

  function writeLedger(arr) {
    try {
      fs.mkdirSync(path.dirname(LEDGER), { recursive: true })
      fs.writeFileSync(LEDGER, JSON.stringify(arr, null, 1))
      return arr.length
    } catch (e) { return null }
  }

  return { DIR, has, runNode, ledger, ledgerPath, fiveChecks, readLedger, writeLedger }
}

// ---------------------------------------------------------------------------
// 插件本体
// ---------------------------------------------------------------------------

export { GameClient }
export const name = 'hjyt-assistant'

export function apply(ctx, config = {}) {
  const prof = resolveProfile(config, (m) => { try { console.log(m) } catch (e) {} })
  const cfg = {
    workspace: prof.workspace,
    scriptsDir: prof.scriptsDir,
    dataDir: prof.dataDir,
    stateDir: prof.stateDir,
    host: prof.host,
    ledger: prof.ledgerName,
    ledgerFile: prof.ledgerFile,
    tickMode: prof.tickMode,
    cdpHost: prof.cdpHost,
    cdpPort: prof.cdpPorts[0],
    cdpPorts: prof.cdpPorts,
    transport: prof.transport,
    bridgeUrl: prof.bridgeUrl,
    bridgeToken: prof.bridgeToken,
    gameHostHints: prof.gameHostHints,
    gameTitles: prof.gameTitles,
    turnWide: prof.turnWide,
    turnNarrow: prof.turnNarrow,
    firstMin: prof.firstMin,
    lastArr: prof.lastArr,
    maxLegs: prof.maxLegs,
    autoQueue: config.autoQueue !== false,
    cashIdle: Number(config.cashIdle || 1500),
    cashFloor: Number(config.cashFloor || 800),
    // 利润最大化（体检）：客座率下限 62%（引擎连续 3 天 <60% 才报警，留 2 个点余量）
    profitMinLF: config.profitMinLF != null ? Number(config.profitMinLF) : 0.62,
    profitMinGain: config.profitMinGain != null ? Number(config.profitMinGain) : 0.005,
  }
  const game = new GameClient(cfg)
  const runner = makeRunner(prof)
  const log = []

  // 运行态文件一律进「本机专属」状态目录（stateDir 不可写时自动退化成带主机后缀的文件名），
  // 避免多台电脑共用同一个同步盘时互相覆盖日志 / 快照 / 体检基线。
  const LOG_PATH = () => stateFile(prof, 'plugin_log.jsonl')
  const LOG_MAX_BYTES = 1500 * 1024
  const LOG_KEEP_LINES = 400
  // 日志只追加不清理会无限滚大（一次坏启动就写 32 条 register-fail，实测 438 KB / 766 行）。
  // 超 1.5 MB 就只留最近 400 行，避免同步盘里越滚越大；清理失败不影响写日志。
  function trimLogFile(p) {
    let st
    try { st = fs.statSync(p) } catch (e) { return }
    if (!st || st.size <= LOG_MAX_BYTES) return
    try {
      const keep = fs.readFileSync(p, 'utf8').trim().split('\n').slice(-LOG_KEEP_LINES)
      fs.writeFileSync(p, keep.join('\n') + '\n')
    } catch (e) {}
  }
  function note(entry) {
    const row = { ts: Date.now(), ...entry }
    log.push(row)
    if (log.length > 200) log.shift()
    const p = LOG_PATH()
    trimLogFile(p)
    try { fs.appendFileSync(p, JSON.stringify(row) + '\n') } catch (e) {}
  }
  function recentLog(n = 30) {
    try {
      const txt = fs.readFileSync(LOG_PATH(), 'utf8').trim().split('\n').slice(-n)
      return txt.map((l) => { try { return JSON.parse(l) } catch (e) { return null } }).filter(Boolean)
    } catch (e) { return [] }
  }

  // ---- 任务实现 -----------------------------------------------------------

  async function opStatus() {
    try {
      await game.connect()
      await game.ensureHud()
      const s = await game.status()
      const ledger = runner.readLedger()
      return {
        ok: true,
        status: s,
        ledgerDays: ledger.length,
        lastDay: ledger.length ? ledger[ledger.length - 1].dateKey : null,
        hudWired: !game.lastError,
        env: {
          workspace: prof.workspace,
          workspaceSource: prof.workspaceSource,
          scriptsDir: prof.scriptsDir,
          dataDir: prof.dataDir,
          stateDir: prof.stateDir,
          host: prof.host,
          ledger: prof.ledgerFile,
          ledgerSource: prof.ledgerSource,
          tickMode: prof.tickMode,
          cdp: prof.cdpHost + ':' + game.cfg.cdpPort,
          transport: game.mode,
          browserControl: prof.bridgeUrl,
          hasLocalScripts: !!prof.scriptsDir,
          notes: prof.notes,
        },
      }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), hint: '打开游戏页；若 DSH Browser Control 扩展在线会自动走桥（' + prof.bridgeUrl + '），否则需要 Chrome 带 --remote-debugging-port=9222' }
    }
  }

  async function opDaily(n = 1) {
    const steps = []
    let days = Math.max(0, Math.min(30, Number(n) || 0))
    for (let i = 0; i < days; i++) {
      const pre = await opStatus()
      if (!pre.ok) return { ok: false, reason: '未连接游戏', steps }
      let tick
      try {
        tick = await game.tickDay()
      } catch (e) {
        return { ok: false, reason: '推进失败：' + String((e && e.message) || e), steps }
      }
      // 写回账本（追加语义，失败不阻断推进）
      let ledgerDays = null
      try {
        const arr = runner.readLedger()
        arr.push(tick)
        ledgerDays = runner.writeLedger(arr)
      } catch (e) {}

      // 校验：有本地 daily_check.js 就用它（信息更全），否则用页面侧通用校验
      const checks = runner.fiveChecks() || (await opChecks())
      steps.push({
        day: tick.dateKey,
        cash: tick.cashAfter,
        cashDelta: tick.cashDelta,
        reputation: tick.reputation,
        flights: tick.ledger && tick.ledger.flights,
        loadFactor: tick.ledger && tick.ledger.lf,
        delays: tick.delay,
        fuel: tick.fuelAction,
        ledgerDays,
        checks: { code: checks.exitCode, red: checks.red, warn: checks.warn },
      })
      note({ op: 'daily', day: tick.dateKey, cash: tick.cashAfter })
      // 每满 5 天自动存档（磁盘 + 游戏内槽）
      if (ledgerDays && ledgerDays % 5 === 0) {
        try { const sv = await opSave(); steps[steps.length - 1].autosave = sv && sv.file } catch (e) {}
      }
      if (checks.exitCode === 2) {
        return { ok: false, reason: `第 ${tick.dateKey} 出现红线，已停止`, red: checks.red, steps }
      }
    }
    try { await game.pumpQueue() } catch (e) {}
    return { ok: true, steps }
  }

  /** 五项校验（页面侧，按 报告/每日推进校验规则.md；与上次快照比对增量/投放） */
  const CHECK_STATE = () => stateFile(prof, 'plugin_check_state.json')
  function loadCheckPrev() {
    try { return JSON.parse(fs.readFileSync(CHECK_STATE(), 'utf8')) } catch (e) { return null }
  }
  function saveCheckSnap(snap) {
    try { fs.writeFileSync(CHECK_STATE(), JSON.stringify(snap, null, 1)) } catch (e) {}
  }

  async function opChecks() {
    let data = null
    try { data = await pageOnly(HEALTH_EXPR, 120000) } catch (e) {
      return { exitCode: 3, red: [pageErr(e)], warn: [], info: [], source: 'page' }
    }
    if (!data || !data.ok) return { exitCode: 3, red: [(data && data.reason) || '读不到校验数据'], warn: [], info: [], source: 'page' }
    const prev = loadCheckPrev()
    const r = sopChecks(data, prev, { cashIdle: cfg.cashIdle })
    saveCheckSnap(r.snapshot)
    note({ op: 'checks', code: r.exitCode, red: r.red.length, warn: r.warn.length })
    return r
  }

  async function opSave() {
    if (runner.has('save5.js')) {
      const r = runner.runNode('save5.js', ['--force'], 180000)
      // 脚本没能执行（沙箱拦 spawn）→ 退回引擎自带存档，而不是直接报失败
      if (!r.spawnError) {
        const m = /SAVED\s+(\S+)/.exec(r.stdout)
        note({ op: 'save', mode: 'script', file: m ? m[1] : null })
        return { ok: r.code === 0, mode: 'script', file: m ? m[1] : null, stdout: r.stdout.trim().slice(-400), stderr: r.stderr.trim().slice(-300) }
      }
      note({ op: 'save', mode: 'script->engine', reason: r.spawnError })
    }
    // 通用模式：触发引擎自带存档（AUTO 轮换由游戏自己管）
    const r = await game.evalRaw(`(function () {
      try {
        if (typeof autoSaveGame === 'function') { autoSaveGame(); return 'autoSaveGame' }
        if (typeof saveGame === 'function') { saveGame(); return 'saveGame' }
        return 'no-save-api'
      } catch (e) { return 'err:' + (e && e.message) }
    })()`, 30000)
    await new Promise((res) => setTimeout(res, 2500))
    note({ op: 'save', mode: 'engine', via: r })
    return { ok: r !== 'no-save-api' && !String(r).startsWith('err:'), mode: 'engine', via: r, note: '已触发游戏内存档；磁盘备份由游戏自身负责' }
  }

  async function opAudit() {
    // 一：页面侧通用排查（不依赖本地脚本）
    try {
      await game.connect()
      const page = await game.evalJson(AUDIT_EXPR, 120000)
      if (page && page.ok) {
        note({ op: 'audit', source: 'page', fleet: page.fleet, interval: page.intervalCount, stop: page.stopCount })
        return {
          ok: page.intervalCount === 0 && page.stopCount === 0,
          source: 'page',
          result: {
            fleet: page.fleet, legsDay0: page.legsDay0, minStop: page.minStop, maxArr: page.maxArr,
            stopIssues: page.stopCount, intervalIssues: page.intervalCount,
            stopSample: page.stopIssues, apSample: page.intervalIssues, groundTurn: page.groundTurn,
          },
        }
      }
    } catch (e) {}
    // 二：有本地 verify_sched.js 就再跑一遍（额外交叉校验）
    if (runner.has('verify_sched.js')) {
      const r = runner.runNode('apply.js', ['verify_sched.js'], 180000)
      let parsed = null
      try { parsed = JSON.parse(r.stdout) } catch (e) {}
      note({ op: 'audit', source: 'script', ok: parsed ? parsed.intervalIssues === 0 && parsed.stopIssues === 0 : false })
      return { ok: r.code === 0, source: 'script', result: parsed, stderr: r.stderr.trim().slice(-300) }
    }
    return { ok: false, reason: '排查失败：页面侧与本地脚本都不可用' }
  }

  async function opPlanSched(opts = {}, extra = {}) {
    const state = await game.readState()
    if (!state || !state.ok) return { ok: false, reason: '读不到 GameState' }
    // 维修位强制严格（用户 2026-10-19：「去掉放行，一定要维修」）：夜停/停场机场必须有维修位
    const r = planFleet(state, Object.assign({ turn: 'auto', turnWide: cfg.turnWide, turnNarrow: cfg.turnNarrow, firstMin: cfg.firstMin, lastArr: cfg.lastArr, maxLegs: cfg.maxLegs }, opts, { requireMaint: true }))
    return {
      ok: true,
      mode: opts.mode || 'underused',
      generatedFor: r.targets,
      planned: r.plans.filter((p) => p.ok).length,
      totalLegs: r.plans.filter((p) => p.ok).reduce((a, p) => a + p.legs, 0),
      plans: r.plans,
      issues: r.issues,
      note: r.note,
      minStop: r.opts && r.opts.turn,
      lastArr: r.opts && r.opts.lastArr,
    }
  }

  // ---- 排班快照（内存滚动 5 份）与回滚 -------------------------------------
  const SNAPSHOTS = []
  const SNAP_PATH = stateFile(prof, 'plugin_snapshots.json')
  // 快照落盘：插件重启 / 多进程 CLI 调试时也能回滚（以前只存内存 + 只落标签，跨进程回滚会「没有可用快照」）
  function loadSnapshots() {
    try {
      const arr = JSON.parse(fs.readFileSync(SNAP_PATH, 'utf8'))
      if (Array.isArray(arr)) {
        for (const sn of arr.slice(-5)) {
          if (sn && sn.data && typeof sn.data === 'object') SNAPSHOTS.push({ ts: sn.ts || Date.now(), label: sn.label || 'snapshot', data: sn.data, after: sn.after || null })
        }
      }
    } catch (e) {}
  }
  loadSnapshots()
  function pushSnapshot(label, data, after) {
    SNAPSHOTS.push({ ts: Date.now(), label, data, after: after || null })
    while (SNAPSHOTS.length > 5) SNAPSHOTS.shift()
    try { fs.writeFileSync(SNAP_PATH, JSON.stringify(SNAPSHOTS)) } catch (e) {}
  }

  async function opCaptureSchedules(ids) {
    const expr = `(() => {
      const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
      const ids = ${JSON.stringify(ids)}
      const out = {}
      for (const id of ids) out[id] = (G.schedule && G.schedule[id]) ? JSON.parse(JSON.stringify(G.schedule[id])) : null
      return JSON.stringify({ ok: true, data: out })
    })()`
    return await game.evalJson(expr, 60000)
  }

  async function opRollback(index, force = false) {
    if (!SNAPSHOTS.length) return { ok: false, reason: '没有可用快照' }
    const idx = index == null ? SNAPSHOTS.length - 1 : Math.max(0, Math.min(SNAPSHOTS.length - 1, Number(index)))
    const snap = SNAPSHOTS[idx]
    // 安全闸：快照之后这些飞机又被改过（手动排班 / 另一次写入），回滚会覆盖新改动 → 先拒绝
    if (snap.after && !force) {
      const ids = Object.keys(snap.data || {})
      const cur = await opCaptureSchedules(ids)
      const now = (cur && cur.data) || {}
      const changed = ids.filter((id) => JSON.stringify(now[id] || null) !== JSON.stringify((snap.after || {})[id] || null))
      if (changed.length) {
        note({ op: 'rollback-refused', index: idx, changed: changed.length })
        return {
          ok: false,
          needForce: true,
          changed,
          reason: '有 ' + changed.length + ' 架飞机在快照之后又被改过，回滚会覆盖这些新改动；确认要覆盖就传 force:true',
          snapshot: { index: idx, label: snap.label, ts: snap.ts },
        }
      }
    }
    const expr = `(() => {
      const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
      const data = ${JSON.stringify(snap.data)}
      const done = []
      for (const [id, days] of Object.entries(data)) {
        if (days == null) { delete G.schedule[id]; done.push({ id, ok: true, cleared: true }) }
        else { G.schedule[id] = days; done.push({ id, ok: true }) }
      }
      if (typeof updateHUD === 'function') { try { updateHUD() } catch (e) {} }
      return JSON.stringify({ ok: true, done })
    })()`
    const res = await game.evalJson(expr, 60000)
    note({ op: 'rollback', index: idx, label: snap.label, force: !!force })
    return { ok: !!(res && res.ok), restored: res && res.done, snapshot: { index: idx, label: snap.label, ts: snap.ts } }
  }

  async function opApplySched(plans) {
    if (!Array.isArray(plans) || !plans.length) return { ok: false, reason: '没有要应用的方案' }
    const affected = plans.map((p) => p.id).filter(Boolean)
    if (!affected.length) return { ok: false, reason: '方案里缺少飞机 id' }
    // 写前快照（回滚用）
    let before = null
    try { const cap = await opCaptureSchedules(affected); if (cap && cap.ok) before = cap.data } catch (e) {}
    const expr = `(() => {
      const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
      const apply = ${JSON.stringify(plans.map((p) => ({ id: p.id, legs: p.detail || p.legs })))}
      const done = []
      for (const item of apply) {
        const ac = (G.aircrafts || []).find(a => a && a.id === item.id)
        if (!ac) { done.push({ id: item.id, ok: false, reason: '找不到飞机' }); continue }
        const days = []
        for (let d = 0; d < 7; d++) {
          days.push(item.legs.map((l, i) => ({
            routeId: l.rid,
            departureMin: l.dep,
            arrivalMin: l.arr,
            flightTime: l.ft,
            _id: 'seg_' + Date.now() + '_' + d + '_' + i,
            cancelled: false,
            _fuelDeducted: false
          })))
        }
        G.schedule[ac.id] = days
        done.push({ id: item.id, reg: ac.regName, ok: true, legs: item.legs.length })
      }
      if (typeof updateHUD === 'function') { try { updateHUD() } catch (e) {} }
      return JSON.stringify({ ok: true, done })
    })()`
    const res = await game.evalJson(expr, 60000)
    // 记下「写入后」的样子：以后回滚时如果发现当前排班与之不符（说明之后又被改过）就拒绝覆盖
    let after = null
    try { const c2 = await opCaptureSchedules(affected); if (c2 && c2.ok) after = c2.data } catch (e) {}
    if (before) pushSnapshot('apply-sched ' + affected.length + ' 架', before, after)
    note({ op: 'apply-sched', count: (res && res.done || []).filter((d) => d.ok).length })
    const audit = await opAudit()
    // 写完再跑一遍「游戏内校验」（= 时刻表对话框的「校验」按钮），三个排班入口共用这一处
    let gameCheck = null
    try { gameCheck = await gameSchedCheck(affected) } catch (e) { gameCheck = { ok: false, source: 'game', verdict: 'skip', text: '游戏内校验没跑成：' + pageErr(e), items: [] } }
    note({ op: 'apply-sched-gamecheck', verdict: gameCheck && gameCheck.verdict, failed: gameCheck && gameCheck.failed })
    return {
      ok: !!(res && res.ok), applied: res && res.done, audit,
      gameCheck, gameText: gameCheck && gameCheck.text, gameCheckOk: !!(gameCheck && gameCheck.verdict !== 'fail'),
    }
  }

  // ---- v0.3：买机 / 开线 / 排班体检 / 日贡献看板 ------------------------------

  const pageOnly = async (expr, timeout = 120000) => {
    await game.connect()
    return await game.evalJson(expr, timeout)
  }
  const pageErr = (e) => '页面侧读取失败：' + String((e && e.message) || e)

  // ---- 游戏内校验（validateFullSchedule）-------------------------------------
  // 用户在游戏时刻表对话框里点「校验」= verifyScheduleEdit → validateFullSchedule，同一套规则：
  //   a 逐天/跨日航线相连  b 周日→周一闭环  c 相邻航班周转 ≥ 50 分（硬错误，不通过就不能确认）
  //   d 机场最小起飞间隔  e 机场停靠上限（软警告，游戏里显示「⚠️ 通过校验，可能晚点」）
  // 插件写班表的三个入口（面板「一键排班」/「三步排班确认」/「一键部署」）写完都会跑一遍。
  async function gameSchedCheck(ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x || '')).filter(Boolean)
    if (!list.length) return { ok: false, source: 'game', verdict: 'skip', text: '游戏内校验：没有要校验的飞机', items: [] }
    // 桥的 eval 有 100ms 硬上限（48 架一次跑必超时），按 8 架一批跑；某批超时再对半切
    const items = []
    const unread = []
    const runBatch = async (chunk) => {
      let raw = null
      try {
        raw = await pageOnly(GAME_VALIDATE_EXPR(chunk), 60000)
        if (!raw || !raw.ok) throw new Error((raw && raw.reason) || '读不到游戏内校验结果')
      } catch (e) {
        if (chunk.length > 1) {
          const mid = Math.ceil(chunk.length / 2)
          await runBatch(chunk.slice(0, mid))
          await runBatch(chunk.slice(mid))
        } else unread.push({ id: chunk[0], why: pageErr(e) })
        return
      }
      for (const it of (raw.items || [])) items.push(it)
    }
    for (const chunk of chunkIds(list, 8)) await runBatch(chunk)
    if (!items.length) {
      const why = unread.length ? (unread[0].why || '读不到游戏内校验结果') : '读不到游戏内校验结果'
      return { ok: false, source: 'game', verdict: 'skip', reason: why, text: '游戏内校验没跑成：' + why, items: [] }
    }
    const norm = normalizeGameItems(items)
    const summary = summarizeGameCheck(norm)
    if (unread.length) summary.text += '；另有 ' + unread.length + ' 架没读到（' + (unread[0].why || '读取失败') + '）'
    return Object.assign({ ok: true, source: 'game' }, summary, { items: norm, unread: unread.map((u) => u.id) })
  }

  async function opSchedVerify(a = {}) {
    let ids = []
    if (a.acId) ids = [String(a.acId)]
    else if (a.reg) {
      const state = await game.readState()
      if (!state || !state.ok) return { ok: false, reason: '读不到时刻表数据' }
      const ac = state.aircraft.find((x) => x.reg === String(a.reg))
      if (!ac) return { ok: false, reason: '找不到这架飞机：' + a.reg }
      ids = [ac.id]
    } else {
      const state = await game.readState()
      if (!state || !state.ok) return { ok: false, reason: '读不到时刻表数据' }
      const limit = Math.max(1, Math.min(200, Number(a.limit) || 60))
      ids = state.aircraft.filter((x) => !x.hasSold && Number(x.legs) > 0).slice(0, limit).map((x) => x.id)
      if (!ids.length) return { ok: true, source: 'game', verdict: 'skip', text: '全队都没有排班（先 hjyt_plan_sched + hjyt_apply_sched）', items: [] }
    }
    const gc = await gameSchedCheck(ids)
    note({ op: 'sched-verify', verdict: gc && gc.verdict, checked: gc && gc.checked, failed: gc && gc.failed })
    return gc
  }

  async function opBuyPlan(opts = {}) {
    let data = null
    try { data = await pageOnly(BUY_EXPR) } catch (e) { return { ok: false, reason: pageErr(e) } }
    if (!data || !data.ok) return { ok: false, reason: (data && data.reason) || '读不到买机数据' }
    const r = buyPlan(data, Object.assign({
      firstMin: cfg.firstMin, lastArr: cfg.lastArr, maxLegs: cfg.maxLegs, turn: cfg.turnNarrow,
    }, opts))
    note({ op: 'buy-plan', candidates: r.totalCandidates, budget: r.budget })
    return r
  }

  /** 买机报价：输入机型 → 用「当前选中航线（没有就选需求最大的）」算最佳舱位 + 全设施 + 节油发动机的落地价 */
  async function opBuyQuote(a = {}) {
    const model = String(a.model || '').trim()
    if (!model) return { ok: false, reason: '需要机型名' }
    // 一次买几架（1..10）：引擎每买 1 架全场通胀 ×1.015，所以批量总价是等比级数，不是单价×架数
    const qty = Math.max(1, Math.min(10, Math.floor(Number(a.count || 1))))
    let sel = null
    try { sel = await pageOnly(SELECTED_ROUTE_EXPR, 20000) } catch (e) { sel = null }
    // 新机将来停在哪个机场（没指定 base 时引擎会放到现有机队最多的机场）
    let homeAp = String(a.base || '').trim()
    let state0 = null
    try { state0 = await game.readState() } catch (e) {}
    if (!homeAp && state0 && state0.ok) {
      const cnt = {}
      for (const ac of state0.aircraft) { const k = ac.cur || ac.base; if (k) cnt[k] = (cnt[k] || 0) + 1 }
      homeAp = Object.keys(cnt).sort((x, y) => cnt[y] - cnt[x])[0] || ''
    }
    let rid = sel && sel.ok && sel.found ? String(sel.rid) : ''
    let routeReason = '用选中航线'
    if (rid && state0 && state0.ok) {
      const sr = (state0.routes || []).find((r) => String(r.id) === rid)
      if (sr && homeAp && sr.from !== homeAp && sr.to !== homeAp) {
        // 选中的航线不经过新机落脚机场 → 改成该机场需求最大的航线，舱位才不会配给一条飞不了的线
        const cand = (state0.routes || []).filter((r) => r.from === homeAp || r.to === homeAp)
          .sort((x, y) => (y.demand || 0) - (x.demand || 0))[0]
        if (cand) {
          rid = String(cand.id)
          routeReason = '选中航线不经过 ' + homeAp + '，改用该机场需求最大的航线（' + cand.from + '→' + cand.to + '）'
        }
      }
    }
    let q = null
    try { q = await pageOnly(cabinQuoteExpr(rid, model), 40000) } catch (e) { return { ok: false, reason: pageErr(e) } }
    if (!q || !q.ok) {
      // 给相近机型提示，方便 HUD 里改一个字
      let near = []
      try {
        const list = await pageOnly(BUY_EXPR)
        const want = model.toLowerCase().replace(/\s+/g, '')
        near = (list.models || [])
          .filter((m) => m.name.toLowerCase().replace(/\s+/g, '').includes(want) || want.includes(m.name.toLowerCase().replace(/\s+/g, '').slice(0, 6)))
          .slice(0, 6).map((m) => m.name + '（' + m.seats + '座 ' + m.price + '万）')
      } catch (e) {}
      return { ok: false, reason: (q && q.reason) || '报价失败', suggestions: near }
    }
    // 航时 → 每日段数（用于把日需求折成每班需求）
    let ft = null
    try {
      const st = await game.readState()
      if (st && st.ok && st.ft) ft = st.ft[q.route.id] || null
    } catch (e) {}
    if (!Number.isFinite(Number(ft))) {
      ft = Math.round((q.route.km / Math.max(300, q.cruiseSpeed || 750)) * 60 / 0.85) + 25
    }
    const turn = q.isWideBody ? cfg.turnWide : cfg.turnNarrow
    const span = Math.max(120, cfg.lastArr - cfg.firstMin)
    const legs = Math.max(1, Math.min(cfg.maxLegs, Math.floor(span / (2 * Number(ft) + 2 * turn))))
    // 配舱一律走报告「黄金公式」（bestCabin 已是唯一实现）：需要 A 的两个输入 = 航线声誉 + 该线分舱需求池
    const routeRep = Number(q.routeRep != null ? q.routeRep : 0) || 0
    const cab = bestCabin({
      seats: q.seats, demand: q.demand, fares: q.fare, space: q.space, legs,
      km: q.route && q.route.km, routeRep, health: 100, minY: 12,
    })
    const eqPrice = Number(q.quote && q.quote.totalPrice) || 0
    // 买机时的改舱费按引擎口径：(F+J+S)×0.5 万/座（aircraftEquipmentPurchase.js:19 的 cabinCost）
    // 注意：买完再用客舱重建去改（retrofit）才按 F×2 + J×0.8 + S×0.3 收，两个口径不同
    const cabinCost = (cab.layout.F + cab.layout.J + cab.layout.S) * 0.5
    const total = (Number(q.price) || 0) + eqPrice + cabinCost
    // 批量报价：第 i 架 = 单价 × 1.015^i（引擎每买一架全场涨价 1.5%，所以是等比级数而不是单价×架数）
    const perUnit = []
    for (let i = 0; i < qty; i++) perUnit.push(+(total * Math.pow(1.015, i)).toFixed(2))
    const batchTotal = qty <= 1 ? total : total * (Math.pow(1.015, qty) - 1) / 0.015
    const money0 = state0 && Number.isFinite(Number(state0.money)) ? Number(state0.money) : null
    let maxAffordable = null
    if (money0 != null) {
      maxAffordable = 0
      let acc = 0
      for (let i = 0; i < 10; i++) {
        acc += total * Math.pow(1.015, i)
        if (acc <= money0) maxAffordable = i + 1
        else break
      }
    }
    // 落地默认 79cm；买后重建到 71/74cm 能多出 7~11% 的座位空间（报告:买机落地默认79cm 是最大隐性损失）
    const pitchAfter = (q.caps && q.caps.supported && q.caps.wifi && q.caps.ptv && q.eq && q.eq.wifi && q.eq.ptv) ? 71 : 74
    const seatsAtPitch = Math.floor((Number(q.seats) || 0) * 79 / pitchAfter)
    return {
      ok: true,
      model: q.model, seats: q.seats, range: q.range, price: +Number(q.price || 0).toFixed(2),
      equipment: q.eq, equipmentPrice: +eqPrice.toFixed(2), equipmentDetail: q.quote,
      cabin: cab.layout, cabinCost: +cabinCost.toFixed(2),
      total: +total.toFixed(2),
      count: qty, countLabel: qty + ' 架', unitTotal: +total.toFixed(2),
      batchTotal: +batchTotal.toFixed(2), perUnit, money: money0, maxAffordable: maxAffordable,
      pitchAfter, seatsAtPitch,
      route: q.route, routeReason, homeAp, legs, ftMin: Number(ft), turn,
      demand: q.demand, fare: q.fare,
      cabinInfo: { method: cab.method, seats: cab.seats, spaceUsed: cab.spaceUsed, perFlight: cab.perFlight, revenueIndex: cab.revenueIndex, spaceValue: cab.spaceValue, elasticityFactor: cab.elasticityFactor, alternatives: cab.alternatives },
      note: '舱位按该航线分舱位需求自动分配（两方案取收益高的）；装备=小翼+WiFi+PTV，发动机=efficiency（节油）。落地默认 79cm，买完立刻跑 hjyt_cabin_rebuild 可重建到 ' + pitchAfter + 'cm（约 ' + seatsAtPitch + ' 座空间）',
    }
  }

  /** 机队清单（改名面板用） */
  async function opAircraftList() {
    let data = null
    try { data = await pageOnly(AIRCRAFT_LIST_EXPR, 20000) } catch (e) { return { ok: false, reason: pageErr(e) } }
    if (!data || !data.ok) return { ok: false, reason: '读不到机队' }
    return data
  }

  /** 改飞机名：只改 regName（id 不变，排班/账单都不受影响） */
  async function opRenameAircraft(a = {}) {
    const acId = String(a.acId || '')
    const name = String(a.name || '')
    if (!acId) return { ok: false, reason: '需要 acId' }
    let r = null
    try { r = await pageOnly(renameAircraftExpr(acId, name), 20000) } catch (e) { return { ok: false, reason: pageErr(e) } }
    note({ op: 'rename-aircraft', acId, name, ok: !!(r && r.ok) })
    return r || { ok: false, reason: '改名失败' }
  }
  /** 客舱重建：按每架飞机主力航线的分舱位需求重配 F/J/S（Y 由页面按剩余空间算），可顺带改座椅间距 */
  async function opCabinRebuild(a = {}) {
    // 间距分档（报告/座椅间距与发动机硬件优化分析.md:50-51）：
    //   自有 + 白名单（能装设备）+ 已装 WiFi&PTV → 71cm（客流 +19.7%，满意度 80.8 仍过盟线）
    //   其余（租赁/黑名单/没设备）→ 74cm（+11%，满意度 81）
    // 显式传 pitch 时全部按该值（人工覆盖）。
    const forced = a.pitch != null ? Math.max(71, Math.min(102, Number(a.pitch))) : null
    const apply = a.apply !== false
    // 可选覆盖：只重建某架 / 直接给分舱需求 / 没排班时假定段数（新局刚开线也能按需求配舱）
    const wantAcId = a.acId ? String(a.acId) : null
    const forceDemand = (a.demand && typeof a.demand === 'object') ? a.demand : null
    const forceLegs = a.legs != null ? Math.max(1, Math.floor(Number(a.legs))) : null
    let data = null
    try { data = await pageOnly(CABIN_INPUT_EXPR, 40000) } catch (e) { return { ok: false, reason: pageErr(e) } }
    if (!data || !data.ok) return { ok: false, reason: '读不到客舱数据' }
    const items = []
    const skipped = []
    const rows = []
    for (const ac of data.aircraft) {
      if (wantAcId && ac.id !== wantAcId) continue
    const legsEff = ac.legs || forceLegs || 0
    if (!legsEff && !forceDemand) { skipped.push({ id: ac.id, reg: ac.reg, reason: '闲置（0 段/日）' }); continue }
    // 没有分舱需求（这条线还没飞过 / 新局刚开线）时重建会退化成全经济舱：
    // 每个舱位收益都算 0，只剩 Y 兜底把所有座位吃掉。宁可跳过。
    const demandEff = forceDemand || ac.demand || {}
    const dsum = ['F', 'J', 'S', 'Y'].reduce(function (t, c) { return t + Number(demandEff[c] || 0) }, 0)
    if (!(dsum > 0)) { skipped.push({ id: ac.id, reg: ac.reg, reason: '没有分舱需求数据（这条线还没飞过）→ 先排班并飞一天再重建，否则会全变经济舱' }); continue }
      const eligible71 = !!(ac.own && ac.capsSupported && ac.wifi && ac.ptv)
      const pitch = forced || (eligible71 ? 71 : 74)
      const capacity = Math.max(1, Math.floor((Number(ac.spaceBase) || 0) * 79 / pitch))
      const cab = bestCabin({
        seats: capacity, demand: demandEff, fares: ac.fare, space: { F: 6, J: 3, S: 1.5, Y: 1 }, legs: legsEff || 1,
        km: Number(ac.km) || 0, routeRep: Number(ac.routeRep != null ? ac.routeRep : 100), health: Number(ac.health != null ? ac.health : 100), minY: 12,
      })
      items.push({ id: ac.id, F: cab.layout.F, J: cab.layout.J, S: cab.layout.S, pitch })
      rows.push({ id: ac.id, reg: ac.reg, model: ac.model, route: ac.route, legs: ac.legs, before: ac.layout, want: cab.layout, capacity, spaceBase: ac.spaceBase, pitch, pitchWhy: forced ? '人工指定' : (eligible71 ? '自有+可装设备+已装WiFi/PTV' : '租赁/黑名单/无设备') })
    }
    if (!items.length) return { ok: true, total: 0, plan: [], rows, skipped, note: '没有在飞的飞机，客舱无需重建' }
    let res = null
    try { res = await pageOnly(cabinRebuildExpr(items, forced || 74, apply), 60000) } catch (e) { return { ok: false, reason: pageErr(e) } }
    if (!res) return { ok: false, reason: '页面没有返回结果' }
    const plan = (res.plan || []).map((p) => {
      const row = rows.find((r) => r.id === p.id) || {}
      return {
        id: p.id, reg: p.reg || row.reg, model: p.model || row.model, route: row.route, legs: row.legs,
        ok: !!p.ok, err: p.err || null,
        before: p.before || row.before, after: p.layout,
        cost: p.cost || 0, pitch: p.pitch || row.pitch, applied: !!p.applied, inFlight: !!p.inFlight,
      }
    })
    const pitch71 = plan.filter((p) => Number(p.pitch) === 71).length
    const pitch74 = plan.filter((p) => Number(p.pitch) === 74).length
    note({ op: 'cabin-rebuild', apply, pitch: forced || 'auto(71/74)', n: plan.length, total: res.total })
    return {
      ok: !!res.ok, apply, pitch: forced || null,
      pitchPolicy: forced ? '人工指定 ' + forced + 'cm' : '自有+可装设备+已装 WiFi/PTV → 71cm，其余 74cm（本次 71cm ' + pitch71 + ' 架 / 74cm ' + pitch74 + ' 架）',
      total: res.total || 0,
      money: res.money != null ? +Number(res.money).toFixed(2) : null,
      plan, skipped, rows,
      note: apply
        ? '已重建 ' + plan.filter((p) => p.applied).length + ' 架客舱，合计改装费 ' + (res.total || 0) + ' 万；间距按每架能力分档'
        : '预览：需要 ' + (res.total || 0) + ' 万，确认后再执行',
    }
  }

  /**
   * 利润最大化（体检的核心）：按引擎真值公式全量重算「每条航线 F/J/S/Y 倍率 + 每架飞机舱位分配」，
   * 不是最优就直接改。用户 2026-10-20 指令：客座率只要不触发报警（连续 3 天 <60%）即可。
   */
  async function opProfitOptimize(a = {}) {
    const apply = a.apply !== false
    const minLF = a.minLF != null ? Math.max(0.3, Math.min(0.9, Number(a.minLF))) : cfg.profitMinLF
    const applyMinGain = a.applyMinGain != null ? Number(a.applyMinGain) : cfg.profitMinGain
    const only = (a.only === 'fare' || a.only === 'cabin') ? a.only : 'all'
    const read = async () => {
      let d = null
      try { d = await pageOnly(PROFIT_EXPR, 60000) } catch (e) { return { err: pageErr(e) } }
      if (!d || !d.ok) return { err: (d && d.reason) || '读不到票价/需求数据' }
      return { data: d, plan: profitPlan(d, { minLF, applyMinGain }) }
    }
    const first = await read()
    if (first.err) return { ok: false, reason: first.err }
    const plan = first.plan
    const fareRows = only === 'cabin' ? [] : plan.routes.filter((r) => r.fareChanged && r.gain > 0)
    let cabRows = only === 'fare' ? [] : plan.aircraft.filter((x) => x.layoutChanged && x.gain > 0 && !x.skipReason)
    const brief = {
      reputation: plan.reputation, minLF: plan.minLF,
      revDayNow: plan.revDayNow, revDayWant: plan.revDayWant, gain: plan.gain,
      fareChanges: plan.fareChanges, cabinChanges: plan.cabinChanges, cabinCost: plan.cabinCost,
      fareRows: fareRows.map((r) => ({ id: r.id, route: r.from + '→' + r.to, now: r.fareNow, want: r.fareWant, gain: r.gain, lfWant: r.lfWant })),
      cabRows: cabRows.map((x) => ({ id: x.id, reg: x.reg, model: x.model, now: x.layoutNow, want: x.layoutWant, cost: x.cost, gain: x.gain, revDayNow: x.revDayNow, gainWan: +((Number(x.gain) || 0) * (Number(x.revDayNow) || 0)).toFixed(2) })),
    }
    if (!apply) {
      return Object.assign({ ok: true, apply: false, note: '预览：确认后传 apply 或不传（默认直接改）' }, brief, { routes: plan.routes, aircraft: plan.aircraft })
    }
    if (!fareRows.length && !cabRows.length) {
      return Object.assign({ ok: true, apply: true, changed: false, note: '已经是利润最大化（票价与配舱都不用改）' }, brief)
    }
    // 快照（rollback 可回退）
    let before = null
    try { before = await game.readState() } catch (e) {}
    const done = { fare: null, cabin: null }
    if (fareRows.length) {
      try {
        done.fare = await pageOnly(routeFareExpr(fareRows.map((r) => ({ id: r.id, fare: { F: r.fareWant.F, J: r.fareWant.J, S: r.fareWant.S, Y: r.fareWant.Y } }))), 60000)
      } catch (e) { done.fare = { ok: false, reason: pageErr(e) } }
    }
    const moneyNow = (first.data && Number(first.data.money)) || 0
    let cabinSkipped = null
    let doneCab = cabRows.slice()
    const cabinNeedAll = cabRows.reduce((t, x) => t + (Number(x.cost) || 0), 0)
    // 留 800 万运营垫（补油/工资），只用超出的部分改配舱
    const budget = Math.max(0, moneyNow - cfg.cashFloor)
    if (doneCab.length && cabinNeedAll > budget) {
      // 现金不够全改：按「收益 ÷ 改装费」从高到低挑，能改几架改几架
      // 排序口径：绝对日增收(万元) ÷ 改装费（gain 是比率，乘回该机日收入才是绝对额；只按比率排会让小收入飞机插队）
      const valOf = (x) => (Number(x.gainWan) || ((Number(x.gain) || 0) * (Number(x.revDayNow) || 0))) / Math.max(1, Number(x.cost) || 1)
      const ranked = doneCab.slice().sort((a, b) => valOf(b) - valOf(a))
      const picked = []
      let spent = 0
      for (const x of ranked) {
        const c = Number(x.cost) || 0
        if (spent + c > budget) continue
        picked.push(x); spent += c
      }
      doneCab = picked
      const skippedN = cabRows.length - picked.length
      cabinSkipped = '现金 ' + Math.round(moneyNow) + ' 万：配舱改装全改要 ' + Math.round(cabinNeedAll) + ' 万，扣掉运营垫 ' + cfg.cashFloor + ' 万后只够改 ' + picked.length + ' 架（' + Math.round(spent) + ' 万，多赚约 ' + Math.round(picked.reduce((t, x) => t + (Number(x.gainWan) || 0), 0) * 10) / 10 + ' 万/日），剩 ' + skippedN + ' 架等现金够了再改'
    }
    cabRows = doneCab
    const willChange = fareRows.length > 0 || cabRows.length > 0
    // 快照按「真的会改的东西」打：配舱全被现金闸门挡下时不留空快照
    if (before && willChange) pushSnapshot('profit ' + (fareRows.length ? fareRows.length + '条票价' : '') + (cabRows.length ? ' ' + cabRows.length + '架配舱' : ''), before)
    if (cabRows.length) {
      const items = cabRows.map((x) => ({ id: x.id, F: x.layoutWant.F, J: x.layoutWant.J, S: x.layoutWant.S, pitch: x.pitch }))
      try { done.cabin = await pageOnly(cabinRebuildExpr(items, 74, true), 150000) } catch (e) { done.cabin = { ok: false, reason: pageErr(e) } }
    }
    const fareFails = (done.fare && done.fare.rows ? done.fare.rows : []).filter((x) => !x.ok)
    const cabinFails = (done.cabin && done.cabin.plan ? done.cabin.plan : []).filter((x) => !x.ok)
    // 自检：重算一遍，确认离「最优」只剩零头（同时给出改后的真实客座率）
    const second = await read()
    let after = null
    if (!second.err) {
      after = {
        revDayAfter: second.plan.revDayNow, gainLeft: second.plan.gain,
        fareChangesLeft: second.plan.fareChanges, cabinChangesLeft: second.plan.cabinChanges,
        minLFSeen: Math.min.apply(null, second.plan.routes.map((r) => r.lfWant).concat([1])),
      }
    }
    note({ op: 'profit', apply: true, fares: fareRows.length, cabins: cabRows.length, fareFails: fareFails.length, cabinFails: cabinFails.length })
    return {
      ok: fareFails.length === 0 && cabinFails.length === 0 && (!done.cabin || done.cabin.ok !== false),
      apply: true, changed: willChange,
      reputation: plan.reputation, minLF: plan.minLF,
      revDayNow: plan.revDayNow, revDayWant: plan.revDayWant, gain: plan.gain,
      fareApplied: fareRows.map((r) => ({ route: r.from + '→' + r.to, from: r.fareNow, to: r.fareWant, gain: r.gain })),
      cabinApplied: cabRows.map((x) => ({ reg: x.reg, model: x.model, from: x.layoutNow, to: x.layoutWant, cost: x.cost })),
      cabinCost: (done.cabin && done.cabin.total) || 0,
      money: done.cabin && done.cabin.money != null ? +Number(done.cabin.money).toFixed(2) : +Number(moneyNow || 0).toFixed(2),
      fails: fareFails.concat(cabinFails).map((x) => ({ id: x.id, err: x.err || x.reason || '失败' })),
      cabinSkipped: cabinSkipped,
      after,
      note: (cabinFails.length ? '部分配舱失败（' + cabinFails.length + ' 架）' : ''),
    }
  }

  /** 按起降城市自动命名：一按改名 → 全队按当天班表的主航线「起-降」重命名 */
  async function opRenameByRoute(a = {}) {
    let data = null
    try { data = await pageOnly(AIRCRAFT_ROUTES_EXPR, 40000) } catch (e) { return { ok: false, reason: pageErr(e) } }
    if (!data || !data.ok) return { ok: false, reason: '读不到班表' }
    const plan = buildRenamePlan(data.aircraft)
    if (a.apply === false) return Object.assign({ ok: true, dryRun: true }, plan)
    if (!plan.changed) return Object.assign({ ok: true, changed: 0 }, plan)
    let res = null
    try { res = await pageOnly(applyRenameExpr(plan.renamed.map((r) => ({ id: r.id, name: r.to }))), 40000) } catch (e) { return { ok: false, reason: pageErr(e) } }
    note({ op: 'rename-by-route', changed: plan.changed })
    return Object.assign({}, plan, {
      ok: !!(res && res.ok),
      applied: (res && res.rows) || [],
      note: plan.changed + ' 架已按起降城市改名' + (plan.skipped.length ? '；' + plan.skipped.length + ' 架闲置未改' : ''),
    })
  }
  async function opBuyApply(a = {}) {
    const model = String(a.model || '').trim()
    // base 可以留空：等同游戏里的「不指定归属基地」，引擎会尝试自动归属，没有空位就先挂在上海浦东
    const base = String(a.base || '').trim()
    if (!model) return { ok: false, reason: '需要 model（机型名）' }
    let data = null
    try { data = await pageOnly(BUY_EXPR) } catch (e) { return { ok: false, reason: pageErr(e) } }
    if (!data || !data.ok) return { ok: false, reason: '读不到买机数据' }
    const m = (data.models || []).find((x) => x.name === model)
    if (!m) return { ok: false, reason: '机型不存在或当前模块不可运营：' + model }
    const b = base ? (data.bases || []).find((x) => x.name === base) : null
    if (base && !b) return { ok: false, reason: '基地不存在（不是 base/hub 级机场）：' + base }
    const count = Math.max(1, Math.floor(Number(a.count || 1)))
    let cabin = a.cabin && typeof a.cabin === 'object' ? a.cabin : null
    let autoCabin = null
    if (!cabin && (a.cabin === 'auto' || a.autoCabin === true)) {
      const q = await opBuyQuote({ model })
      if (!q.ok) return { ok: false, reason: '自动配舱失败：' + (q.reason || '报价失败'), suggestions: q.suggestions }
      cabin = q.cabin
      autoCabin = { method: q.cabinInfo.method, route: q.route, legs: q.legs, perFlight: q.cabinInfo.perFlight, alternatives: q.cabinInfo.alternatives }
    }
    const n2 = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0)
    // 买机时的改舱费按引擎口径：(F+J+S)×0.5 万/座（aircraftEquipmentPurchase.js:19）
    // retrofit（买完之后改舱）才按 F×2 + J×0.8 + S×0.3 收
    const cabinCost = cabin ? (n2(cabin.F) + n2(cabin.J) + n2(cabin.S)) * 0.5 : 0
    const unit = n2(m.price) + n2(m.quote && m.quote.totalPrice) + cabinCost
    // 批量总价按等比级数（每买 1 架全场 ×1.015，封顶 31 倍），不是「单价×架数」
    const total = count <= 1 ? unit : unit * (Math.pow(1.015, count) - 1) / 0.015
    const plan = {
      model, base: base || null, count, seats: m.seats,
      unitPrice: +unit.toFixed(2), totalCost: +total.toFixed(2),
      equipment: m.eq, equipmentQuote: m.quote, cabin, autoCabin, cabinCost: +cabinCost.toFixed(2),
      money: +n2(data.money).toFixed(2),
      hangarLeft: b ? b.hangarLeft : null, hangarCap: b ? b.hangarCap : null,
      note: base ? null : '未指定基地：引擎会尝试自动归属，没有空位就先挂在上海浦东（baseAirport=null）',
    }
    // 质量闸门（与 hjyt_buy_plan 一致）：黑名单机型 / 全队 LF <89%（Day0–3 不买机的阶段闸门已按用户要求移除）
    if (isBlacklistedModel(model) && !a.force) {
      return { ok: false, gate: 'blacklist', plan, reason: '黑名单机型（不能改发动机/WiFi/小翼，买来硬件锁死）：' + model + '；确实要买请传 force=true' }
    }
    // 客座率闸门已按用户 2026-10-19 要求移除：买机不再看全队 LF（只在结果里保留 lf7 供参考）
    // 「机库位不足」不拦：引擎允许在 0 机库的机场买机（先买、后再升机库/编基地）——用户 2026-10-19 确认
    if (n2(data.money) < total) return { ok: false, reason: `现金不足：需要 ${total.toFixed(2)} 万，现有 ${n2(data.money).toFixed(2)} 万`, plan }
    if (!a.confirm) return { ok: true, needConfirm: true, plan, reason: '写操作：确认无误后传 confirm=true 执行' }
    if (total > 5000 && !a.secondConfirm) {
      return { ok: true, needSecondConfirm: true, plan, reason: `单次花费 ${total.toFixed(2)} 万 > 5,000 万，需再传 secondConfirm=true` }
    }
    const before = await pageOnly(`(() => {
      const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
      const live = (G.aircrafts || []).filter(function (x) { return x && !x.hasSold })
      return JSON.stringify({ ok: true, money: Number(G.money || 0), fleet: live.length, ids: live.map(function (x) { return x.id }) })
    })()`)
    pushSnapshot('buy ' + model + ' x' + count + ' @' + base, before)
    const expr = `(() => {
      const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
      const model = ${JSON.stringify(model)}, base = ${JSON.stringify(base)}, count = ${count}
      const eq = ${JSON.stringify(m.eq || null)}, cabin = ${cabin ? JSON.stringify(cabin) : 'null'}
      const out = []
      for (let i = 0; i < count; i++) {
        let r = null
        try {
          r = (typeof buyAircraftWithEquipment === 'function')
            ? buyAircraftWithEquipment(model, base, eq, cabin)
            : buyAircraft(model, base)
        } catch (e) { out.push({ ok: false, reason: String((e && e.message) || e) }); break }
        const ac = r && r.aircraft
        const ok = !!(r && r.success)
        out.push({ ok: ok, id: ac && ac.id, reg: ac && ac.regName, price: r && (r.totalPrice != null ? r.totalPrice : r.price), msg: (r && r.msg) || null })
        if (!ok) break
      }
      const live = (G.aircrafts || []).filter(function (x) { return x && !x.hasSold })
      return JSON.stringify({ ok: out.length > 0 && out.every(function (x) { return x.ok }), bought: out, money: Number(G.money || 0), fleet: live.length })
    })()`
    const res = await game.evalJson(expr, 60000)
    note({ op: 'buy-apply', model, base, count, ok: !!(res && res.ok) })
    let after = null
    try { after = await game.evalJson(`(() => {
      const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
      const live = (G.aircrafts || []).filter(function (x) { return x && !x.hasSold })
      const mine = live.filter(function (x) { return x.modelId === ${JSON.stringify(model)} || x.model === ${JSON.stringify(model)} })
      return JSON.stringify({ ok: true, money: Number(G.money || 0), fleet: live.length, thisModel: mine.length,
        last: mine.length ? { id: mine[mine.length - 1].id, reg: mine[mine.length - 1].regName, base: mine[mine.length - 1].baseAirport, seats: Object.keys(mine[mine.length - 1].cabinLayout || {}).reduce(function (t, k) { return t + (Number(mine[mine.length - 1].cabinLayout[k]) || 0) }, 0), health: mine[mine.length - 1].health } : null })
    })()`) } catch (e) {}
    const selfCheck = {
      fleetDelta: before && after ? after.fleet - before.fleet : null,
      moneyDelta: before && after ? +(after.money - before.money).toFixed(2) : null,
      newAircraft: after && after.last ? after.last : null,
    }
    if (selfCheck.fleetDelta != null && selfCheck.fleetDelta < count) {
      // 把引擎自己的拒买原因带出来（例：客舱配置不合法或超出空间容量 / 资金不足），别只说自检失败
      const engMsg = ((res && res.bought) || []).map(function (x) { return x && x.msg }).filter(Boolean)[0]
      return { ok: false, reason: '买机失败：' + (engMsg || '自检失败：机队数量没有按预期增加'), plan, res, selfCheck }
    }
    return { ok: !!(res && res.ok), plan, bought: res && res.bought, selfCheck, note: '已买机；接下来用 hjyt_plan_sched 给它排班' }
  }

  async function opRoutePlan(opts = {}) {
    let froms = opts.fromAirports
    // 逗号分隔字符串必须拆成数组：否则 for..of 会按字符遍历，一个候选都出不来
    if (typeof froms === 'string') froms = froms.split(',').map(function (x) { return x.trim() }).filter(Boolean)
    if (!froms || !froms.length) {
      // 新局没有任何 base：退回到「飞机当前所在机场」
      try {
        const st0 = await game.readState()
        froms = Array.from(new Set((st0.aircraft || []).map(function (a) { return a.cur || a.base }).filter(Boolean))).slice(0, 2)
      } catch (e) {}
      // 默认用 main base（base1/base2）出发
      try {
        const buy = await pageOnly(BUY_EXPR)
        const bases = (buy && buy.bases) || []
        const main = bases.filter((b) => /^base[12]$/.test(String(b.level))).map((b) => b.name)
        froms = main.length ? main : (bases.length ? bases.slice(0, 2).map((b) => b.name) : froms)
      } catch (e) { return { ok: false, reason: pageErr(e) } }
    }
    let data = null
    try { data = await pageOnly(routeExpr({ fromAirports: froms, maxDestinations: opts.maxDestinations || 90 })) } catch (e) { return { ok: false, reason: pageErr(e) } }
    if (!data || !data.ok) return { ok: false, reason: (data && data.reason) || '读不到开线数据' }
    const r = routePlan(data, opts)
    note({ op: 'route-plan', froms, matched: r.matched })
    return r
  }

  // 航线开发：某个机场出发最值得开的 N 条线（候选只取已开通区域），并给出每条线能养几架
  async function opRouteDev(opts = {}) {
    let want = opts.airport || opts.from || ''
    if (Array.isArray(want)) want = want[0] || ''
    want = String(want || '').trim()
    if (!want) return { ok: false, reason: '需要机场名（支持模糊：浦东 / PVG / 东京）' }
    // 机场名模糊搜索：精确名直接用，忽略大小写/半截名时命中一个就用它，命中多个就让人选
    let search = null
    try { search = await pageOnly(AIRPORT_SEARCH_EXPR(want), 20000) } catch (e) { search = null }
    const hits = (search && search.matches) || []
    let from = hits.find((m) => m.name === want) ? want : null
    if (!from) {
      if (!hits.length) {
        return { ok: false, from: want, reason: '已开通区域里没有含「' + want + '」的机场；试试：浦东 / 白云 / PVG / 东京', unlocked: (search && search.unlocked) || [] }
      }
      if (hits.length > 1) {
        return { ok: false, ambiguous: true, from: want, q: want, total: hits.length, matches: hits.slice(0, 12), reason: '「' + want + '」匹配到 ' + hits.length + ' 个机场，选一个再查' }
      }
      from = hits[0].name
    }
    const model = String(opts.model || 'B757-200')
    let data = null
    try {
      data = await pageOnly(ROUTE_DEV_EXPR({ fromAirports: [from], model: model, pitch: opts.pitch }), 40000)
    } catch (e) {
      return { ok: false, reason: pageErr(e) }
    }
    if (!data || !data.ok) return { ok: false, reason: (data && data.reason) || '读不到航线开发数据' }
    if (!data.rows || !data.rows.length) {
      return {
        ok: false,
        from: from,
        unlocked: data.unlocked,
        apCount: data.apCount,
        reason: '「' + from + '」没有候选：机场名可能不对，或该机场不在已开通区域（当前：' + ((data.unlocked || []).join('/') || '无') + '）'
      }
    }
    const r = routeDevPlan(data, { top: opts.top || 5, pitch: opts.pitch, lfTarget: opts.lfTarget, minLF: opts.minLF })
    note({ op: 'route-dev', from: from, cand: data.rows.length, top: (r.top || []).length })
    if (want !== from) r.resolvedFrom = want
    return r
  }

  // 机场名模糊解析（航线开发 / 一键部署共用）：精确名优先；命中多个不猜，直接回候选
  async function resolveAirportName(want) {
    let q = Array.isArray(want) ? String(want[0] || '') : String(want == null ? '' : want)
    q = q.trim()
    if (!q) return { ok: false, reason: '需要机场名（支持模糊：浦东 / PVG / 东京）' }
    let search = null
    try { search = await pageOnly(AIRPORT_SEARCH_EXPR(q), 20000) } catch (e) { search = null }
    const hits = (search && search.matches) || []
    if (hits.find((m) => m.name === q)) return { ok: true, name: q, hit: hits.find((m) => m.name === q), want: q }
    if (!hits.length) return { ok: false, want: q, reason: '已开通区域里没有含「' + q + '」的机场', unlocked: (search && search.unlocked) || [] }
    if (hits.length > 1) return { ok: false, ambiguous: true, want: q, q: q, total: hits.length, matches: hits.slice(0, 12), reason: '「' + q + '」匹配到 ' + hits.length + ' 个机场，选一个再查' }
    return { ok: true, name: hits[0].name, hit: hits[0], want: q }
  }

  // 一对（或双向一对）航线：是否已存在 + 开线费
  async function probeRoutePairs(pairs) {
    return await pageOnly(`(() => {
      const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
      const ap = G.airports || {}
      const pairs = ${JSON.stringify(pairs)}
      const out = []
      for (const pr of pairs) {
        const f = pr[0], t = pr[1]
        const A = ap[f], B = ap[t]
        const hit = (G.routes || []).find(function (r) { return r && r.from === f && r.to === t && (r.routeKind || 'passenger') === 'passenger' })
        let km = 0, cost = 0
        if (A && B && A.lat && B.lat) {
          km = haversineDistance(A.lat, A.lng, B.lat, B.lng)
          try { cost = Number(getRouteCreateCost(km)) } catch (e) { cost = km * 100 / 10000 }
        }
        out.push({ from: f, to: t, km: Math.round(km), cost: +cost.toFixed(2), exists: !!hit, rid: hit ? String(hit.id) : null })
      }
      return JSON.stringify({ ok: true, pairs: out, money: Number(G.money || 0) })
    })()`, 25000)
  }

  // 一键部署（HUD「开线」面板选中一条后）：补开线（缺的方向）→ 买 1 架 → 排班
  async function opRouteDeploy(a = {}) {
    const model = String(a.model || 'B757-200')
    const n2 = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0)
    const fr = await resolveAirportName(a.from)
    if (!fr.ok) return Object.assign({ ok: false, stage: 'from' }, fr)
    const tr = await resolveAirportName(a.to)
    if (!tr.ok) return Object.assign({ ok: false, stage: 'to' }, tr)
    const from = fr.name
    const to = tr.name
    if (from === to) return { ok: false, reason: '出发和到达是同一个机场：' + from }
    // ① 这条线的建议（配舱 / 票价 / 需求 / 已有飞机数）
    let devRaw = null
    try { devRaw = await pageOnly(ROUTE_DEV_EXPR({ fromAirports: [from], model: model, pitch: a.pitch }), 40000) } catch (e) { return { ok: false, reason: pageErr(e) } }
    if (!devRaw || !devRaw.ok) return { ok: false, reason: (devRaw && devRaw.reason) || '读不到航线开发数据' }
    const dev = routeDevPlan(devRaw, { top: 999, lfTarget: a.lfTarget })
    const row = (dev.top || dev.rows || []).find((x) => x.to === to)
    if (!row) return { ok: false, reason: '「' + from + '」的候选里没有「' + to + '」（超出航程，或不在已开通区域）' }
    if (row.exists && n2(row.canAdd) <= 0 && a.force !== true) {
      return { ok: false, stage: 'capacity', row: row, reason: '这条线已经吃满：已有 ' + n2(row.acCount) + ' 架、日需求池只够养 ' + n2(row.capacityAircraft) + ' 架；确实还要加请传 force=true' }
    }
    // ② 机型价（含装备）+ 改舱费
    let buy = null
    try { buy = await pageOnly(BUY_EXPR) } catch (e) { return { ok: false, reason: pageErr(e) } }
    if (!buy || !buy.ok) return { ok: false, reason: '读不到买机数据' }
    const mm = (buy.models || []).find((x) => x.name === model)
    if (!mm) return { ok: false, reason: '机型当前不可运营：' + model }
    const cabin = a.cabin && typeof a.cabin === 'object' ? a.cabin : (row.layout || null)
    const cabinCost = cabin ? (n2(cabin.F) * 2 + n2(cabin.J) * 0.8 + n2(cabin.S) * 0.3) : 0
    const fare = Object.assign({}, (row.mults ? { F: row.mults.F, J: row.mults.J, S: row.mults.S, Y: row.mults.Y } : { F: 2, J: 2, S: 1.05, Y: 0.45 }), a.fare || {})
    // ③ 哪些方向还缺（双向开线，偶数段要靠反向航线回程）
    const both = a.both !== false
    const pairs = both ? [[from, to], [to, from]] : [[from, to]]
    let pv = null
    try { pv = await probeRoutePairs(pairs) } catch (e) { return { ok: false, reason: pageErr(e) } }
    if (!pv || !pv.ok) return { ok: false, reason: '读不到航线数据' }
    const missing = (pv.pairs || []).filter((p) => !p.exists)
    const createCost = missing.reduce((t, p) => t + n2(p.cost), 0)
    const cost = deployCost({ modelPrice: mm.price, equipmentPrice: mm.quote && mm.quote.totalPrice, cabinCost: cabinCost, createCost: createCost, directions: missing.length, count: 1, money: pv.money, cashFloor: cfg.cashFloor })
    const plan = {
      from: from, to: to, model: model, both: both, fare: fare, cabin: cabin,
      legs: row.legs, layout: row.layout, fares: row.fares, demand: row.demand,
      existing: pv.pairs, missing: missing.map((p) => p.from + '→' + p.to),
      routeId: (pv.pairs[0] && pv.pairs[0].rid) || row.rid || null,
      base: (fr.hit && fr.hit.level && fr.hit.level !== 'normal') ? from : null,
      cost: cost,
      steps: ['开线（只补缺的方向）', '买 1 架 ' + model + '（含装备 + 按需求配舱）', '排班（偶数段、夜停有维修位）'],
    }
    if (!cost.canAfford) return { ok: false, stage: 'cash', plan: plan, reason: '现金不够：需要 ' + cost.total + ' 万，现有 ' + cost.money + ' 万' }
    if (!a.confirm) return { ok: true, needConfirm: true, plan: plan, reason: '一键部署要花 ' + cost.total + ' 万（买机 ' + cost.buyTotal + ' + 开线 ' + cost.createCost + '）：确认后传 confirm=true 执行' }

    // ④ 开线（只补缺的方向；票价/精品餐食/精品快线按四步写）
    let routeStep = { ok: true, created: [], skipped: !missing.length }
    if (missing.length) {
      const f2 = missing.length === 1 ? missing[0].from : from
      const t2 = missing.length === 1 ? missing[0].to : to
      const r = await opRouteApply({ from: f2, to: t2, both: missing.length !== 1, fare: fare, confirm: true, secondConfirm: true })
      const vrows = (r && r.verify) || []
      const vrid = (vrows.find((x) => x && x.found && x.from === from) || vrows.find((x) => x && x.found) || {}).rid
      routeStep = { ok: !!(r && r.ok), created: (r && r.created) || [], verify: vrows, reason: (r && r.reason) || null, both: missing.length !== 1, missing: plan.missing, rid: vrid ? String(vrid) : null }
      if (!routeStep.ok) return { ok: false, stage: 'route', plan: plan, route: routeStep, reason: '开线失败：' + (routeStep.reason || '') }
    }
    // ⑤ 买 1 架（自动配舱 + 装备）
    const buyRes = await opBuyApply({ model: model, base: plan.base || '', count: 1, cabin: cabin, confirm: true, secondConfirm: true })
    if (!buyRes || !buyRes.ok) {
      const r2 = buyRes || {}
      return { ok: false, stage: 'buy', plan: plan, route: routeStep, reason: '买机失败：' + (r2.reason || '') + (r2.needSecondConfirm ? '（需 secondConfirm）' : ''), buy: r2 }
    }
    const ac = (buyRes.selfCheck && buyRes.selfCheck.newAircraft) || null
    const acId = ac && ac.id ? String(ac.id) : null
    // ⑥ 排班（新机按这条航线排；自动换「起飞端 × 维修窗口」组合）
    let sched = null
    let schedErr = null
    if (acId) {
      // 拿 from→to 方向的 rid（刚建的可能还没进 dev 数据）
      let rid = (routeStep && routeStep.rid) || plan.routeId
      try {
        const pv2 = await probeRoutePairs([[from, to]])
        const p0 = (pv2 && pv2.pairs || [])[0]
        if (p0 && p0.rid) rid = String(p0.rid)
      } catch (e) {}
      try {
        sched = await opSchedFix({ acId: acId, rid: rid, startAt: from, maint: a.maint, maxUtil: a.maxUtil })
        if (!sched || !sched.ok) { schedErr = (sched && sched.reason) || '排班失败'; sched = sched || null }
      } catch (e) { schedErr = String((e && e.message) || e) }
    } else {
      schedErr = '买机返回里没有新机 id'
    }
    let money = null
    try { money = (await game.readState()).money } catch (e) {}
    note({ op: 'route-deploy', from: from, to: to, model: model, cost: cost.total, legs: sched && sched.legs, ok: !schedErr })
    return {
      ok: !schedErr,
      kind: 'route-deploy',
      from: from, to: to, model: model,
      plan: plan,
      route: routeStep,
      aircraft: ac,
      schedule: sched ? { legs: sched.legs, nightAirport: sched.nightAirport, sequence: sched.sequence, combo: sched.combo } : null,
      gameCheck: (sched && sched.gameCheck) || null,
      gameText: (sched && sched.gameText) || null,
      gameCheckOk: sched ? !!(sched.gameCheck && sched.gameCheck.verdict !== 'fail') : null,
      schedErr: schedErr,
      money: money == null ? null : +Number(money).toFixed(2),
      spent: cost.total,
      note: schedErr
        ? '前两步已完成（开线 + 买机），排班没成：' + schedErr + '；可以在 HUD「体检」里看原因，或手动点「一键排班」'
        : '已部署：这条线现在有 1 架在飞；隔天用体检复核票价/配舱是否最优',
    }
  }

  async function opRouteApply(a = {}) {
    const from = String(a.from || '').trim()
    const to = String(a.to || '').trim()
    if (!from || !to) return { ok: false, reason: '需要 from 与 to（机场全名）' }
    if (from === to) return { ok: false, reason: 'from 与 to 不能相同' }
    const both = a.both !== false
    const fare = Object.assign({ F: 2, J: 2, S: 1.05, Y: 0.45 }, a.fare || {})
    const pairs = both ? [[from, to], [to, from]] : [[from, to]]
    let pv = null
    try {
      pv = await pageOnly(`(() => {
        const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
        const ap = G.airports || {}
        const pairs = ${JSON.stringify(pairs)}
        const out = []
        for (const pr of pairs) {
          const f = pr[0], t = pr[1]
          const A = ap[f], B = ap[t]
          const exists = (G.routes || []).some(function (r) { return r && r.from === f && r.to === t && (r.routeKind || 'passenger') === 'passenger' })
          let km = 0, cost = 0
          if (A && B && A.lat && B.lat) {
            km = haversineDistance(A.lat, A.lng, B.lat, B.lng)
            try { cost = Number(getRouteCreateCost(km)) } catch (e) { cost = km * 100 / 10000 }
          }
          out.push({ from: f, to: t, km: Math.round(km), cost: +cost.toFixed(2), exists: exists, toLevel: (B && B.level) || 'normal', toIntl: !!(B && B.isInternational) })
        }
        return JSON.stringify({ ok: true, pairs: out, money: Number(G.money || 0) })
      })()`)
    } catch (e) { return { ok: false, reason: pageErr(e) } }
    if (!pv || !pv.ok) return { ok: false, reason: '读不到机场/航线数据' }
    const dup = pv.pairs.filter((p) => p.exists)
    if (dup.length) return { ok: false, reason: '航线已存在：' + dup.map((p) => p.from + '→' + p.to).join('、'), pairs: pv.pairs }
    const cost = pv.pairs.reduce((t, p) => t + p.cost, 0)
    const plan = { pairs: pv.pairs, both, fare, createCost: +cost.toFixed(2), money: +pv.money.toFixed(2), pass: 'createRoute → 票价 → 精品餐食 → 精品快线' }
    if (pv.money < cost) return { ok: false, reason: `现金不足：开线费 ${cost.toFixed(2)} 万，现有 ${pv.money.toFixed(2)} 万`, plan }
    if (!a.confirm) return { ok: true, needConfirm: true, plan, reason: '写操作：确认无误后传 confirm=true 执行' }
    if (cost > 5000 && !a.secondConfirm) return { ok: true, needSecondConfirm: true, plan, reason: `单次花费 ${cost.toFixed(2)} 万 > 5,000 万，需再传 secondConfirm=true` }
    pushSnapshot('route ' + from + '<->' + to, pv)
    const expr = `(() => {
      const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
      const pairs = ${JSON.stringify(pairs)}
      const fare = ${JSON.stringify(fare)}
      const out = []
      for (const pr of pairs) {
        const f = pr[0], t = pr[1]
        let r = null
        try { r = createRoute(f, t) } catch (e) { out.push({ from: f, to: t, ok: false, reason: String((e && e.message) || e) }); continue }
        const rid = r && (r.id || (r.route && r.route.id))
        if (!r || !r.success || !rid) { out.push({ from: f, to: t, ok: false, reason: (r && r.msg) || 'createRoute 失败' }); continue }
        const step = { from: f, to: t, ok: true, rid: String(rid) }
        try { setRouteFarePolicy(String(rid), fare); step.fare = getRouteFarePolicy(String(rid)) } catch (e) { step.fareErr = String((e && e.message) || e) }
        try { setRouteServicePolicy(String(rid), 'premium'); step.premium = true } catch (e) { step.serviceErr = String((e && e.message) || e) }
        try {
          if (typeof setExpressLevel === 'function') setExpressLevel(String(rid), 'premium_express')
          else { G.expressRoutes = G.expressRoutes || {}; G.expressRoutes[String(rid)] = 'premium_express' }
          step.express = (G.expressRoutes || {})[String(rid)] || null
        } catch (e) { step.expressErr = String((e && e.message) || e) }
        out.push(step)
      }
      return JSON.stringify({ ok: out.every(function (x) { return x.ok }), created: out, money: Number(G.money || 0), routeCount: (G.routes || []).length })
    })()`
    const res = await game.evalJson(expr, 60000)
    note({ op: 'route-apply', from, to, both, ok: !!(res && res.ok) })
    // 自检：新航线四条策略都要落实
    let verify = null
    try {
      verify = await game.evalJson(`(() => {
        const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
        const created = ${JSON.stringify(pairs)}
        const out = []
        for (const pr of created) {
          const r = (G.routes || []).find(function (x) { return x && x.from === pr[0] && x.to === pr[1] })
          if (!r) { out.push({ from: pr[0], to: pr[1], found: false }); continue }
          const rid = String(r.id)
          let svc = null
          try { svc = getRouteServicePolicy(rid) } catch (e) {}
          const key = JSON.stringify(['passenger', pr[0], pr[1]])
          const pol = (G.routeService && G.routeService.policies && G.routeService.policies[key]) || null
          out.push({ from: pr[0], to: pr[1], found: true, rid: rid, catering: pol && pol.cateringLevel, service: svc && svc.cateringLevel, express: (G.expressRoutes || {})[rid] || null, fare: getRouteFarePolicy(rid) })
        }
        return JSON.stringify({ ok: true, rows: out })
      })()`)
    } catch (e) {}
    const bad = verify && verify.rows ? verify.rows.filter((x) => !x.found || (x.catering !== 'premium' && x.service !== 'premium') || x.express !== 'premium_express') : []
    return {
      ok: !!(res && res.ok) && bad.length === 0,
      plan, created: res && res.created, verify: verify && verify.rows,
      warn: bad.length ? '自检未通过：' + bad.length + ' 条航线缺精品餐食/精品快线' : null,
      note: '开线完成后用 hjyt_plan_sched + hjyt_apply_sched 派飞机去飞',
    }
  }

  async function opSchedHealth(opts = {}) {
    let data = null
    try { data = await pageOnly(HEALTH_EXPR) } catch (e) { return { ok: false, reason: pageErr(e) } }
    if (!data || !data.ok) return { ok: false, reason: (data && data.reason) || '读不到排班数据' }
    const r = healthReport(data, opts)
    note({ op: 'sched-health', critical: r.critical, idle: r.summary && r.summary.idle })
    return r
  }

  async function opBoard(opts = {}) {
    let data = null
    try { data = await pageOnly(boardExpr(opts.days || 14)) } catch (e) { return { ok: false, reason: pageErr(e) } }
    if (!data || !data.ok) return { ok: false, reason: (data && data.reason) || '读不到看板数据' }
    const r = boardView(data, opts)
    note({ op: 'board', net: r.avgNet })
    return r
  }

  // ---- v0.4：油库向导 / 扩张流水线 -----------------------------------------

  /** 油库向导（只读）：满库要撑 ≥3 天，容量阶梯 + 按油价补油 */
  async function opFuelPlan(opts = {}) {
    let data = null
    try { data = await pageOnly(FUEL_EXPR, 30000) } catch (e) { return { ok: false, reason: pageErr(e) } }
    if (!data || !data.ok) return { ok: false, reason: (data && data.reason) || '读不到燃油数据' }
    const r = fuelPlan(data, { targetDays: opts.targetDays, cashFloor: opts.cashFloor != null ? opts.cashFloor : cfg.cashFloor })
    note({ op: 'fuel-plan', fuelDays: r.fuelDays, capacityDays: r.capacityDays, cost: r.totalCost })
    return r
  }

  /** 油库执行（写）：按方案扩容量 + 补油；一次跑完，写后复查 */
  async function opFuelApply(a = {}) {
    const plan = await opFuelPlan({ targetDays: a.targetDays })
    if (!plan.ok) return plan
    const upgradeSteps = (plan.upgrade.affordableSteps || []).length
    const refillLiters = Math.round(plan.refill.liters || 0)
    if (!upgradeSteps && refillLiters <= 0) return { ok: true, skipped: true, reason: '油库容量与油量都已达标（满库 ≥' + plan.targetDays + ' 天、油量 ≥' + plan.refill.wantDays + ' 天）', plan }
    const cost = plan.totalCost
    if (a.confirm !== true) return { ok: false, needConfirm: true, plan, reason: '写操作：确认后传 confirm=true（扩容 ' + upgradeSteps + ' 步 + 补油 ' + Math.round(refillLiters / 10000) + ' 万升，共 ' + cost + ' 万）' }
    if (cost > 5000 && a.secondConfirm !== true) return { ok: false, needSecondConfirm: true, cost, plan, reason: '本次花费 ' + cost + ' 万 > 5,000 万，需 secondConfirm=true' }
    // 只扩到「目标容量」且每步前先看现金：现金不够就停，不会把油库扩到一半再报错
    const expr = `(() => {
      const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
      if (!G) return JSON.stringify({ ok: false, reason: 'GameState 未就绪' })
      const targetCap = ${Math.round(plan.targetCapacity)}
      const wantLiters = ${refillLiters}
      const before = { cap: Number(G.fuelCapacity || 0), fuel: Math.round(Number(G.fuelRemaining || 0)), money: +Number(G.money || 0).toFixed(2) }
      const ups = []
      for (let i = 0; i < 40 && Number(G.fuelCapacity || 0) < targetCap; i++) {
        const capNow = Number(G.fuelCapacity || 0)
        const info = (typeof getFuelUpgradeInfo === 'function') ? getFuelUpgradeInfo(capNow) : null
        const stepCost = info ? Number(info.costWan || 0) : 0
        if (stepCost > 0 && Number(G.money || 0) < stepCost) { ups.push({ ok: false, err: '现金不足，剩 ' + Math.round(stepCost) + ' 万才能扩下一步' }); break }
        const r = upgradeFuelCapacity()
        if (!r || !r.success) { ups.push({ ok: false, err: (r && r.msg) || '扩容失败' }); break }
        ups.push({ ok: true, cap: Number(G.fuelCapacity || 0), cost: Number(r.costWan || stepCost) })
      }
      let buy = null
      if (wantLiters > 0) {
        const room = Math.max(0, Number(G.fuelCapacity || 0) - Number(G.fuelRemaining || 0))
        const liters = Math.min(wantLiters, room)
        if (liters > 1000) {
          const br = buyFuel(liters / 10000)
          buy = { ok: !!(br && br.success), liters: Math.round(liters), cost: br ? +Number(br.costWan || 0).toFixed(2) : null, err: (br && br.msg) || null }
        }
      }
      const upsOk = ups.filter(function (x) { return x.ok }).length
      return JSON.stringify({
        ok: upsOk === ups.length && (!buy || buy.ok),
        before: before,
        after: { cap: Number(G.fuelCapacity || 0), fuel: Math.round(Number(G.fuelRemaining || 0)), money: +Number(G.money || 0).toFixed(2) },
        upgraded: upsOk, upgradeFailed: ups.filter(function (x) { return !x.ok }), buy: buy
      })
    })()`
    let res = null
    try { res = await pageOnly(expr, 60000) } catch (e) { return { ok: false, reason: pageErr(e), plan } }
    note({ op: 'fuel-apply', upgraded: res && res.upgraded, buy: res && res.buy && res.buy.liters, cost })
    // 写后复查：油量/容量实际变化 + 是否仍低于 3 天
    let after = null
    try { after = await opFuelPlan({ targetDays: a.targetDays }) } catch (e) {}
    return {
      ok: !!(res && res.ok),
      applied: res,
      after: after && after.ok ? { fuelDays: after.fuelDays, capacityDays: after.capacityDays, fuel: after.fuel, capacity: after.capacity, cash: after.cash } : null,
      warn: after && after.ok && after.fuelDays != null && after.fuelDays < plan.targetDays ? '补完仍不足 ' + plan.targetDays + ' 天（扩容步数或现金受限），可再跑一次' : null,
    }
  }

  /** 扩张流水线（只读）：把「今天该做什么」排成有序清单（红线→排班→油→开线→买机） */
  /** 机场查询：三级基地以上（含 hub）机场的维修点 / 夜间停靠 / 维修航班 → 写工作区 xlsx（同名覆盖） */
  async function opAirportQuery(opts = {}) {
    try { await game.connect() } catch (e) { return { ok: false, reason: '未连接游戏：' + String((e && e.message) || e) } }
    let data
    try {
      const raw = await game.evalRaw(AIRPORT_QUERY_EXPR, 60000)
      data = typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch (e) {
      return { ok: false, reason: '页面采集失败：' + String((e && e.message) || e) }
    }
    if (!data || !data.ok) return { ok: false, reason: (data && data.reason) || '页面采集失败' }

    const workspace = prof.workspace
    const saveDir = findSaveDir(workspace)
    const saveBase = latestSaveBase(saveDir)
    const gameDate = fmtGameDate(data.gameTime)
    const base = saveBase || ('AUTO-manual_' + gameDate)
    const wantName = opts.file || ('机场查询_' + base + '.xlsx')
    const outFile = path.isAbsolute(wantName) ? wantName : path.join(workspace, wantName)

    let file = outFile
    let warn = null
    try {
      writeXlsx(outFile, buildSheets(data))
    } catch (e) {
      // 最常见：表单正被 Excel 打开（EBUSY / EPERM）→ 不丢数据，换时间戳名并提示
      const alt = path.join(workspace, '机场查询_' + base + '_' + Date.now() + '.xlsx')
      try {
        writeXlsx(alt, buildSheets(data))
        file = alt
        warn = '原文件写入失败（' + String((e && e.message) || e) + '，通常是 Excel 正开着它），已改写到 ' + path.basename(alt)
      } catch (e2) {
        return { ok: false, reason: '写 Excel 失败：' + String((e2 && e2.message) || e2) }
      }
    }

    note({ op: 'airport-query', file, rows: data.rows.length, faultFixed: data.faultFixed })
    const brief = briefRows(data)
    return {
      ok: true,
      file,
      fileName: path.basename(file),
      warn: warn || undefined,
      saveBase,
      gameDate,
      gameTime: data.gameTime,
      faultFixed: data.faultFixed,
      rowsCount: data.rows.length,
      rows: brief,
      table: brief,
      nightRedline: (data.allNight || []).filter((r) => r.slots <= 0 && r.parked > 0).map((r) => r.name + '×' + r.parked),
    }
  }

  async function opExpandPlan(opts = {}) {
    const st = await opStatus()
    if (!st.ok) return { ok: false, reason: st.error || '未连接游戏' }
    let fuel = null, health = null, route = null, buy = null
    try { fuel = await opFuelPlan({ targetDays: opts.targetDays }) } catch (e) { fuel = { ok: false, reason: pageErr(e) } }
    try { health = await opSchedHealth({ limit: 6 }) } catch (e) { health = { ok: false, reason: pageErr(e) } }
    if (opts.route !== false) { try { route = await opRoutePlan({ limit: Math.max(2, Math.floor(Number(opts.maxRoutes) || 2) + 2), maxDestinations: 80 }) } catch (e) { route = { ok: false, reason: pageErr(e) } } }
    if (opts.buy !== false) { try { buy = await opBuyPlan({ limit: Math.max(2, Math.floor(Number(opts.maxAircraft) || 1) + 2), budget: opts.budget, reserve: opts.reserve }) } catch (e) { buy = { ok: false, reason: pageErr(e) } } }
    const r = expandPlan({ status: st.status, fuel, health, route, buy }, opts)
    note({ op: 'expand-plan', steps: r.steps && r.steps.length, plannedCost: r.summary && r.summary.plannedCost })
    return r
  }

  // ---- 三步排班：选航线（游戏里）→ 选飞机（HUD 里）→ 确认写入 ---------------

  const hhmm = (m) => (m == null ? '--' : String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'))

  /** 规划「改排」时要把这架飞机自己已有的起飞时刻从占用表里摘掉，否则它会绕着自己的旧班表排 */
  function stateWithoutAircraft(state, acId) {
    const occ = (state.occ || []).map((day) => (day || []).filter((o) => o && o.id !== acId))
    return Object.assign({}, state, { occ })
  }

  /** 这架飞机整周（7 天）的段数：判「闲置 / 要不要清旧班」必须看整周 ——
   *  只看周一（legs，来自 expr 的 d0）会被「周一空、周二~周日有班」的飞机骗到 */
  function weekLegsOf(ac) {
    return Number((ac && (ac.legsWeek != null ? ac.legsWeek : ac.legs)) || 0)
  }

  /** 维修窗口：night=只保证夜间 ≥3h（免费）；day=白天强留一段；none=不管 */
  function maintOpts(mode) {
    const m = String(mode || 'night')
    if (m === 'none') return null
    if (m === 'day') return { mode: 'day', need: 180, dayStart: 600 }   // 10:00–13:00
    return { mode: 'night', need: 180 }
  }

  // 维修位闸门（四查 C1/C3）：夜停机场没有维修位就不排。一律严格，没有「放行」开关（2026-10-19 用户要求）
  const maintCfg = (a) => ({ requireMaint: !(a && a.allowNoMaint) })

  function planFor(state, acId, rid, maxLegs, maint, allowNoMaint, startAt, maxUtil) {
    return planFleet(state, {
      aircraftIds: [acId], routeId: rid, turn: 'auto',
      turnWide: cfg.turnWide, turnNarrow: cfg.turnNarrow,
      firstMin: cfg.firstMin, lastArr: cfg.lastArr, maxLegs: maxLegs || cfg.maxLegs,
      maintenance: maintOpts(maint),
      requireMaint: true,   // 强制严格：维修窗口必须在有维修位的机场
      requireReturn: true,  // 一天必须偶数段（用户 2026-10-20 指令）：末段回到起飞机场过夜
      maxUtil: maxUtil != null ? Number(maxUtil) : 0.85,
      startAt: startAt || null,
    })
  }

  /** 维修位负载上限（四查 C2）：cap = 维修位×3；load = 各机场夜停机数（可排除某架） */
  function maintCapacity(state, excludeId) {
    const cap = {}
    // 传维修位数，乘几个班次由 sched 按「夜间/白天」决定
    for (const [ap, slots] of Object.entries(state.maint || {})) cap[ap] = Number(slots)
    const load = {}
    for (const a of (state.aircraft || [])) {
      if (excludeId && a.id === excludeId) continue
      const ap = a.nightTo || null
      if (!ap) continue
      // 只有健康 <95 的飞机才算「要用维修位」，健康的不吃产能
      if (Number(a.health == null ? 100 : a.health) >= 95) continue
      load[ap] = (load[ap] || 0) + 1
    }
    return { cap, load }
  }

  /** 夜停机场的维修位信息（给人看的） */
  function maintInfoOf(state, ap) {
    const slots = state && state.maint ? state.maint[ap] : null
    return { airport: ap, slots: slots == null ? null : Number(slots), ok: slots == null ? null : Number(slots) > 0 }
  }

  /** 调机：把飞机挪到航线端点（引擎：不花时间成本、要航程够、不能在飞/维修） */
  async function opFerry(a = {}) {
    const acId = String(a.acId || '')
    const to = String(a.to || '')
    if (!acId || !to) return { ok: false, reason: '需要 acId 与 to（目标机场）' }
    const expr = `(() => {
  const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
  const ac = (G.aircrafts || []).find(function (x) { return x && x.id === ${JSON.stringify(acId)} })
  if (!ac) return JSON.stringify({ ok: false, reason: '找不到飞机' })
  const from = ac.currentAirport
  const TO = ${JSON.stringify(to)}
  if (!G.ferryState) G.ferryState = {}
  const fs = G.ferryState[ac.id] || null
  const KNOWN = ['ferrying', 'temp', 'temp_done', 'temp_waiting', 'returning', 'inspection', 'retrofit', 'cargo', 'charter', 'positioned', 'returned']
  const tempEmpty = function (f) { return !(f && f.tempSchedule && f.tempSchedule.length) }
  const clearTo = function (f, toPhase) {
    f.phase = toPhase; f.active = false; f._departed = false; f._readyTime = null
    delete f._autoPositioning
  }
  // 已经到目的地但还残留 active：必须清掉。
  // 引擎在「调机到达 + 临时时刻表为空」时会 setPaused(true) 弹「临时航班」对话框 —— 飞机就卡在 phase='temp' 不动
  if (from === TO) {
    if (fs && fs.active) {
      clearTo(fs, 'positioned')
      return JSON.stringify({ ok: true, already: true, from: from, to: from, repaired: '已到目的地但 ferryState 还 active（引擎在等临时航班对话框、游戏会被暂停）：已清成 positioned，正常航班恢复', phase: 'positioned' })
    }
    return JSON.stringify({ ok: true, already: true, from: from, to: from })
  }
  if (fs && fs.active) {
    if (fs.destAirport === TO) {
      if (KNOWN.indexOf(String(fs.phase)) < 0) {
        fs.phase = 'ferrying'; fs._departed = false; fs._readyTime = null
        return JSON.stringify({ ok: true, from: from, to: TO, repaired: '未知 phase 修成 ferrying', phase: 'ferrying', readyInMin: 30, note: '已修复卡住的调机任务：值机 30 分钟后起飞，推进游戏时间后才会飞' })
      }
      if ((fs.phase === 'temp' || fs.phase === 'temp_done' || fs.phase === 'temp_waiting') && tempEmpty(fs)) {
        clearTo(fs, 'positioned')
        return JSON.stringify({ ok: true, from: from, to: TO, repaired: '残留在 temp（引擎弹“临时航班”对话框并暂停游戏）：已清成 positioned', phase: 'positioned', note: '飞机已在该机场，航班按正常时刻表恢复' })
      }
      return JSON.stringify({ ok: true, pending: true, from: from, to: TO, phase: fs.phase, departed: !!fs._departed, note: '之前已经排过这条调机（' + fs.phase + '）：推进游戏时间等它落地，别重复点' })
    }
    return JSON.stringify({ ok: false, reason: '已有一条去「' + fs.destAirport + '」的调机任务未完成（phase=' + fs.phase + '）；先等它完成，或清掉 ferryState[' + ac.id + '] 再调', from: from, to: TO })
  }
  let done = false, err = null
  try { done = scheduleFerryToAirport(${JSON.stringify(acId)}, TO, 'ferrying') } catch (e) { err = String((e && e.message) || e) }
  if (!done) {
    let why = err || '调机失败'
    if (ac.status === 'flying') why = '飞机在飞，落地后再调'
    else if (ac.maintenanceStatus === 'in_progress') why = '维修中不能调机'
    else if (ac.inspectionStatus === 'in_progress') why = '检修中不能调机'
    else { try { const v = validateAircraftFlightRange(ac, { from: from, to: TO }); if (v && v.success === false) why = '航程不够：' + (v.msg || '') } catch (e) {} }
    return JSON.stringify({ ok: false, reason: why, from: from, to: TO })
  }
  // 静默定位：到达后不弹窗、不暂停（跟引擎自己的自动调机一致，否则落地会弹「临时航班」对话框把游戏停住）
  try { const f2 = G.ferryState[ac.id]; if (f2) f2._autoPositioning = true } catch (e) {}
  return JSON.stringify({ ok: true, from: from, to: TO, phase: 'ferrying', silent: true, readyInMin: 30, note: '调机已排入（静默定位，落地不弹窗）：值机 30 分钟后起飞，要推进游戏时间它才会真的飞' })
})()`
    let r = null
    try { r = await pageOnly(expr, 30000) } catch (e) { return { ok: false, reason: pageErr(e) } }
    note({ op: 'ferry', acId, to, ok: !!(r && r.ok) })
    return r || { ok: false, reason: '调机失败' }
  }

  /** 第一步：读游戏里选中的航线 + 给闲置飞机出「能不能排」的清单 */
  async function opSchedPick(opts = {}) {
    let sel = null
    try { sel = await pageOnly(SELECTED_ROUTE_EXPR, 20000) } catch (e) { return { ok: false, reason: pageErr(e) } }
    if (!sel || !sel.ok) return { ok: false, reason: '读不到页面上的选中航线' }
    if (!sel.rid || !sel.found) {
      return { ok: false, needSelect: true, selected: sel, reason: '请先在游戏右侧航线列表里点选一条航线（高亮后再点「排班」）' }
    }
    const state = await game.readState()
    if (!state || !state.ok) return { ok: false, reason: '读不到时刻表数据' }
    const route = (state.routes || []).find((r) => String(r.id) === String(sel.rid))
    if (!route) return { ok: false, reason: '选中的航线不在时刻表数据里' }
    // 全公司维修位总数：新局所有机场都是 normal（0 个维修位）→ 任何排班都过不了「维修位严格」闸门，
    // 这时候要明确告诉用户「先升 hub」，而不是让他以为插件没读到飞机（2026-10-20 实测踩到）
    const slotsTotal = Object.values(state.maint || {}).reduce((s, v) => s + (Number(v) || 0), 0)
    const km = Number(route.km) || 0
    const wantAc = opts.acId ? String(opts.acId) : null
    const maint = maintOpts(opts.maint)
    const allowNoMaint = false   // 已取消「放行」：一律严格
    // 利用率上限：0=不限制；默认 0.70（报告实测 87% 的飞机每班晚 76 分）
    const maxUtil = opts.maxUtil != null ? Number(opts.maxUtil) : 0.70
    // 起飞城市：航线两端随便选。默认取「闲置机实际所在的那一端」（这样写进去的班飞机真能飞），
    // 飞机不在两端时退回 from 端并提示先调机
    const endpoints = [route.from, route.to].filter(Boolean)
    // 「闲置」= 整周（7 天）完全没有排班。只看周一（state.aircraft[].legs）会把「周一空、周二~周日有班」
    // 的飞机当成闲置挂出来（2026-10-25 实测：全队 72 架全有班表，面板却列出 8 架已有航班的飞机）
    const weekLegs = (a) => Number((a && (a.legsWeek != null ? a.legsWeek : a.legs)) || 0)
    const idle = state.aircraft.filter((a) => weekLegs(a) === 0 && (!wantAc || a.id === wantAc))
    const idlePos = idle.map((a) => a.cur || a.base).filter(Boolean)
    const defaultStart = idlePos.find((ap) => endpoints.includes(ap)) || route.from
    const startAt = opts.startAt && endpoints.includes(String(opts.startAt)) ? String(opts.startAt) : defaultStart
    const mcPick = maintCapacity(state, null)
    const planned = planFleet(state, {
      aircraftIds: idle.map((a) => a.id),
      routeId: sel.rid,
      turn: 'auto',
      turnWide: cfg.turnWide, turnNarrow: cfg.turnNarrow,
      firstMin: cfg.firstMin, lastArr: cfg.lastArr, maxLegs: opts.maxLegs || cfg.maxLegs,
      maintenance: maint,
      requireMaint: true,   // 强制严格：维修窗口必须在有维修位的机场
      requireReturn: true,  // 一天必须偶数段（用户 2026-10-20 指令）：末段回到起飞机场过夜
      maxUtil,
      startAt,
      maintCap: mcPick.cap,
      maintLoad: mcPick.load,
    })
    const byId = new Map(state.aircraft.map((a) => [a.id, a]))
    const aircraft = (planned.plans || []).map((p) => {
      const ac = byId.get(p.id) || {}
      const row = {
        id: p.id, reg: p.ac, model: ac.model || '', seats: ac.seats || 0, wide: !!ac.wide,
        range: ac.range || null, legs: p.ok ? p.legs : 0,
        first: p.ok ? p.first : null, last: p.ok ? p.last : null,
        ok: !!p.ok, reason: p.ok ? null : (p.reason || '排不下'),
        maint: p.maint || null,
        nightAirport: p.nightAirport || null,
        maintAtNight: p.maintAtNight == null ? null : p.maintAtNight,
        needMaint: p.needMaint || null,
      }
      // 夜停机场没有维修位：「放行」开关已按用户要求删除，一律严格 —— 说清怎么解
      if (!row.ok && row.needMaint) {
        row.reason = slotsTotal <= 0
          ? '本局全公司维修位 = 0（新局每座机场都是 normal）：任何排班都会被「维修位严格」拦下 → 先给一个机场升 hub（约 500 万给 1 个维修位，停机位顺带 2→5）'
          : '夜停机场「' + row.needMaint + '」维修位 = 0（四查 C1/C3）：改从有维修位的那端起飞排偶数段，或给「' + row.needMaint + '」升基地拿维修位'
      }
      // 位置只做提示、不再拦：跟游戏手动排班一致（飞机可以在别处，排完先调机/引擎自己定位）
      const cur = ac.cur || ac.base || null
      row.startAt = startAt
      row.positionNote = row.ok && cur && cur !== startAt
        ? '飞机现在在 ' + cur + '，这条线从 ' + startAt + ' 起飞：排完后需先调机到 ' + startAt + '（HUD 有「调机→' + startAt + '」）'
        : null
      // planFleet 不查航程，这里补一刀（航程 0.92 安全系数，和买机向导一致）
      if (row.ok && row.range && km > row.range * 0.92) {
        row.ok = false
        row.reason = '航程不够：' + Math.round(row.range) + 'km × 0.92 < ' + km + 'km'
      }
      row.capacity = row.ok ? row.seats * row.legs : 0
      return row
    })
    // 已有排班的飞机一律不进列表（用户 2026-10-25 指令：「这种已有航线在飞的飞机就不要了，
    // 直接提示无闲置飞机」）→ 面板只列整周完全没排班的飞机，没有就报「无闲置飞机」
    const all = aircraft
    all.sort((x, y) => (y.ok - x.ok) || (y.capacity - x.capacity))
    const usable = all.filter((x) => x.ok)
    // 推荐：日运力最接近「需求 × 60%」的那架
    const target = (sel.demand || 0) * 0.6
    let recommended = null
    for (const a of usable) {
      if (!recommended) { recommended = a; continue }
      if (Math.abs(a.capacity - target) < Math.abs(recommended.capacity - target)) recommended = a
    }
    const busyCount = state.aircraft.filter((a) => weekLegs(a) > 0).length
    // 没有可用飞机时：告诉用户「闲置机所在机场能排哪些线」，省得在游戏里来回试
    let suggestRoutes = []
    if (!usable.length) {
      const posSet = new Set(state.aircraft.filter((a) => weekLegs(a) === 0).map((a) => a.cur || a.base).filter(Boolean))
      const seenPair = new Set()
      for (const r of state.routes) {
        if (String(r.id) === String(sel.rid)) continue
        if (!posSet.has(r.from) && !posSet.has(r.to)) continue
        const key = [r.from, r.to].sort().join('|')
        if (seenPair.has(key)) continue
        seenPair.add(key)
        suggestRoutes.push({
          rid: String(r.id),
          route: r.from + ' → ' + r.to,
          km: r.km,
          demand: Number(r.demand) || 0,
          aircraftAt: [r.from, r.to].filter((x) => posSet.has(x)),
        })
      }
      suggestRoutes.sort((a, b) => b.demand - a.demand)
      suggestRoutes = suggestRoutes.slice(0, 5)
    }
    note({ op: 'sched-pick', rid: sel.rid, usable: usable.length })
    return {
      ok: true,
      rid: String(sel.rid),
      route: sel.route || (route.from + ' → ' + route.to),
      from: route.from, to: route.to, km, demand: sel.demand,
      selectedBy: sel.how,
      aircraft: all,
      usable: usable.length,
      allowNoMaint,
      slotsTotal,
      maintNote: slotsTotal <= 0 ? '本局全公司维修位 = 0：先升 hub（约 500 万 / 1 个维修位）才能排班' : null,
      endpoints,
      startAt,
      recommended: recommended ? recommended.id : null,
      suggestRoutes,
      idleCount: idle.length,
      busyCount,
      note: usable.length
        ? '选一架 → 点「确认排班」写入；第一架是按需求 60% 推荐的；默认从 ' + startAt + ' 起飞（面板可切另一端）'
        : (idle.length === 0
          ? '无闲置飞机：全队 ' + state.aircraft.length + ' 架都已经有排班（面板只列整周完全没有班表的飞机）。要给这条线加运力就先买飞机（hjyt_buy_plan → hjyt_buy_apply），或把已有班表的飞机改派过来（hjyt_sched_apply_pick + mode:"replace"，写前自动快照、可 hjyt_rollback 回滚）'
          : (slotsTotal <= 0
            ? '本局全公司维修位 = 0（新局每座机场都是 normal）：维修位一律严格 → 任何排班都过不了。先把一个机场升到 hub（约 500 万：1 个维修位、停机位 2→5）再回来排'
            : (suggestRoutes.length
              ? '这条线没有能排的飞机。闲置机在 ' + Array.from(new Set(suggestRoutes.map((s) => s.aircraftAt.join('/')))).join('、') + '：可以改选 ' + suggestRoutes[0].route + '（需求 ' + suggestRoutes[0].demand + '），或直接点「调机」把飞机挪到 ' + startAt
              : (all.some((x) => x.needPosition && x.needPosition.to)
                ? '闲置机停在别的机场：点「调机→X」先挪到航线端点，到站后再排'
                : '这条航线没有能排的闲置飞机：要么都在飞、要么航程不够')))),
    }
  }

  /** 第二步：把选中的飞机会排到选中航线上（写前快照 + 写后自检，复用 opApplySched） */
  /** 一键排班（写）：只按这架飞机**自己现有的航线**重排，绝不换线；默认偶数段、夜里回起飞机场 */
  async function opSchedFix(a = {}) {
    let acId = String(a.acId || '')
    const wantReg = String(a.reg || '')
    if (!acId && !wantReg) return { ok: false, reason: '需要 acId 或 reg' }
    const state = await game.readState()
    if (!state || !state.ok) return { ok: false, reason: '读不到时刻表数据' }
    let ac = acId ? state.aircraft.find((x) => x.id === acId) : null
    if (!ac && wantReg) ac = state.aircraft.find((x) => x.reg === wantReg)
    if (!ac) return { ok: false, reason: '找不到这架飞机：' + (acId || wantReg) }
    acId = ac.id
    let rid = String(a.rid || '') || (ac.routeIds || [])[0]
    let ridFrom = a.rid ? 'param' : 'schedule'
    if (!rid) {
      // 新机（还没有班表）没有「自己的航线」→ 退回到「游戏里当前选中的航线」
      let sel = null
      try { sel = await pageOnly(SELECTED_ROUTE_EXPR, 20000) } catch (e) {}
      if (sel && sel.ok && sel.rid && sel.found) { rid = String(sel.rid); ridFrom = 'selected' }
      else return { ok: false, reason: ac.reg + ' 还没有班表，也没在游戏里选中航线：先点选一条航线（右侧列表高亮），再点「一键排班」' }
    }
    // 自动换组合：原来的「起飞端 × 维修窗口」排不下时，换成另一端 / 另一种窗口再试，
    // 而不是直接拒绝（用户 2026-10-19：维修位占满时应该自己换组合）
    const planState = weekLegsOf(ac) > 0 ? stateWithoutAircraft(state, acId) : state
    const routeOf = (state.routes || []).find((r) => String(r.id) === String(rid)) || {}
    const starts = Array.from(new Set([a.startAt, ac.firstFrom, ac.cur, routeOf.from, routeOf.to].filter(Boolean)))
    const modes = Array.from(new Set([String(a.maint || 'night'), 'night', 'day']))
    const tried = []
    let p = null
    let combo = null
    for (const sAt of starts) {
      for (const md of modes) {
        const mc = maintCapacity(state, acId)
        const out = planFleet(planState, {
          aircraftIds: [acId], routeId: rid, turn: 'auto',
          turnWide: cfg.turnWide, turnNarrow: cfg.turnNarrow,
          firstMin: cfg.firstMin, lastArr: cfg.lastArr, maxLegs: a.maxLegs || cfg.maxLegs,
          maintenance: maintOpts(md),
          requireMaint: true,   // 强制严格（放行模式已取消）
          maxUtil: a.maxUtil != null ? Number(a.maxUtil) : 0.85,
          requireReturn: a.requireReturn !== false,
          startAt: sAt,
          maintCap: mc.cap,
          maintLoad: mc.load,
        })
        const cand = (out.plans || []).find((x) => x.ok)
        if (cand) {
          // 取所有可行组合里段数最多的（同段数时取利用率高的）
          const better = !p || cand.legs > p.legs || (cand.legs === p.legs && Number(cand.maint && cand.maint.gapMin || 0) > 0 && !p.maint)
          if (better) { p = cand; combo = { startAt: sAt, maint: md } }
        } else {
          tried.push({ startAt: sAt, maint: md, why: ((out.plans || [])[0] || {}).reason || null })
        }
      }
    }
    if (!p) {
      const uniq = Array.from(new Set(tried.map((t) => t.why).filter(Boolean)))
      const noSlots = Object.values(state.maint || {}).reduce((s, v) => s + (Number(v) || 0), 0) <= 0
      return {
        ok: false, routeId: rid, tried, noSlots,
        reason: '按原航线（' + rid + '）所有组合都排不下：' + (uniq.slice(0, 2).join('；') || '没有可行时段')
          + (noSlots ? '｜注意：本局全公司维修位 = 0，先升一个机场到 hub（约 500 万 / 1 个维修位）再排班' : ''),
      }
    }
    const res = await opApplySched([p])
    note({ op: 'sched-fix', acId, rid, legs: p.legs, ok: !!res.ok })
    return Object.assign({}, res, {
      fix: true, routeId: rid, ridFrom, route: p.route, legs: p.legs,
      combo,
      autoAdjusted: !!(combo && (combo.startAt !== (a.startAt || ac.firstFrom) || combo.maint !== String(a.maint || 'night'))),
      nightAirport: p.nightAirport || null, maintAtNight: p.maintAtNight == null ? null : p.maintAtNight,
      sequence: (p.detail || []).map((l) => hhmm(l.dep) + ' ' + l.from + '→' + l.to + ' ' + hhmm(l.arr)),
    })
  }

  async function opSchedApplyPick(a = {}) {
    const rid = String(a.rid || '')
    const acId = String(a.acId || '')
    if (!rid || !acId) return { ok: false, reason: '需要 rid 与 acId' }
    const state = await game.readState()
    if (!state || !state.ok) return { ok: false, reason: '读不到时刻表数据' }
    const ac = state.aircraft.find((x) => x.id === acId)
    if (!ac) return { ok: false, reason: '找不到这架飞机：' + acId }
    const replace = a.mode === 'replace'
    const acWeek = weekLegsOf(ac)
    if (acWeek > 0 && !replace) {
      return { ok: false, needMode: true, reason: ac.reg + ' 已有 ' + acWeek + ' 段/周；要清空重排请传 mode:"replace"（写入前会快照，可回滚）' }
    }
    const route = (state.routes || []).find((r) => String(r.id) === rid)
    if (!route) return { ok: false, reason: '找不到这条航线：' + rid }
    if (ac.range && Number(route.km) > ac.range * 0.92) {
      return { ok: false, reason: ac.reg + ' 航程不够：' + Math.round(ac.range) + 'km × 0.92 < ' + route.km + 'km' }
    }
    const mcApply = maintCapacity(state, acId)
    const planned = planFleet(acWeek > 0 ? stateWithoutAircraft(state, acId) : state, {
      aircraftIds: [acId], routeId: rid, turn: 'auto',
      turnWide: cfg.turnWide, turnNarrow: cfg.turnNarrow,
      firstMin: cfg.firstMin, lastArr: cfg.lastArr, maxLegs: a.maxLegs || cfg.maxLegs,
      maintenance: maintOpts(a.maint),
      requireMaint: true,   // 强制严格（放行模式已取消）
      maxUtil: a.maxUtil != null ? Number(a.maxUtil) : 0.85,
      startAt: a.startAt || null,
      maintCap: mcApply.cap,
      maintLoad: mcApply.load,
    })
    const p = (planned.plans || []).find((x) => x.ok)
    if (!p) {
      const why = (planned.plans || []).map((x) => x.reason).filter(Boolean)[0] || '没有可行时段'
      return { ok: false, reason: '排不下：' + why }
    }
    // 位置提醒：飞机不在首段起飞机场 → 引擎不会自动搬机，会干等到超时记严重延误（2026-10-19 实测 615 分钟）
    const firstFrom = p.detail && p.detail[0] ? p.detail[0].from : null
    const atAp = ac.cur || ac.base || null
    const positionWarn = firstFrom && atAp && firstFrom !== atAp
      ? '⚠ 飞机在 ' + atAp + '，班表却从 ' + firstFrom + ' 起飞：引擎不会搬机，今天大概率记严重延误（上次这样记了 615 分钟）。先「调机→' + firstFrom + '」，或把起飞城市改成 ' + atAp
      : null
    const res = await opApplySched([p])
    note({ op: 'sched-apply-pick', rid, acId, legs: p.legs, mode: replace ? 'replace' : 'new', ok: !!res.ok, positionWarn: !!positionWarn })
    return Object.assign({}, res, {
      mode: replace && acWeek > 0 ? 'replace' : 'new',
      replacedLegs: replace && acWeek > 0 ? acWeek : 0,
      route: route.from + ' → ' + route.to,
      aircraft: { id: acId, reg: ac.reg, seats: ac.seats },
      legs: p.legs,
      maint: p.maint || null,
      positionWarn,
      first: p.first, last: p.last,
      sequence: (p.detail || []).map((l) => hhmm(l.dep) + ' ' + l.from + '→' + l.to + ' ' + hhmm(l.arr)),
    })
  }

  // ---- 一键航线设置：票价 + 精品餐食 + 精品快线 ------------------------------

  async function opRouteSetup(opts = {}) {
    const fare = Object.assign({ F: 2, J: 2, S: 1.05, Y: 0.45 }, opts.fare || {})
    const state = await game.readState()
    if (!state || !state.ok) return { ok: false, reason: '读不到时刻表数据' }
    const all = (state.routes || [])
    let targets = []
    let how = null
    if (opts.all) {
      targets = all.slice()
      how = 'all'
    } else {
      let sel = null
      try { sel = await pageOnly(SELECTED_ROUTE_EXPR, 20000) } catch (e) { return { ok: false, reason: pageErr(e) } }
      if (!sel || !sel.ok) return { ok: false, reason: '读不到页面上的选中航线' }
      if (!sel.rid || !sel.found) {
        return { ok: false, needSelect: true, reason: '请先在游戏里点选一条航线；要一次性设置全部航线就传 all:true' }
      }
      const r = all.find((x) => String(x.id) === String(sel.rid))
      if (!r) return { ok: false, reason: '选中的航线不在时刻表数据里' }
      const rev = all.find((x) => x.from === r.to && x.to === r.from)
      targets = rev ? [r, rev] : [r]
      how = 'selected'
    }
    const seen = new Set()
    targets = targets.filter((t) => t && !seen.has(String(t.id)) && seen.add(String(t.id)))
    if (!targets.length) return { ok: false, reason: '没有要设置的航线' }
    const rows = targets.map((r) => ({ id: String(r.id), from: r.from, to: r.to }))
    let res = null
    try { res = await pageOnly(routePolicyExpr(rows, fare), 60000) } catch (e) { return { ok: false, reason: pageErr(e) } }
    if (!res || !res.ok && !(res.rows && res.rows.length)) return { ok: false, reason: '设置失败', detail: res }
    const fails = (res.rows || []).filter((x) => !x.ok)
    const changed = (res.rows || []).filter((x) => x.changed).length
    note({ op: 'route-setup', how, n: rows.length, changed, fails: fails.length })
    return {
      ok: fails.length === 0,
      how,
      fare,
      total: (res.rows || []).length,
      changed,
      routes: (res.rows || []).map((x) => ({
        from: x.from, to: x.to, ok: x.ok, err: x.err, errStep: x.errStep, changed: x.changed,
        catering: x.after ? x.after.catering : null,
        express: x.after ? x.after.express : null,
        fare: x.after ? x.after.fare : null,
      })),
      note: fails.length
        ? fails.length + ' 条没设成功：' + fails.map((f) => f.from + '→' + f.to + '(' + (f.err || f.errStep) + ')').join('、')
        : '已设置 ' + (res.rows || []).length + ' 条航线：票价 ' + JSON.stringify(fare) + ' · 精品餐食 · 精品快线' + (changed === 0 ? '（本来就是这个配置）' : ''),
    }
  }

  // ---- HUD 命令路由 -------------------------------------------------------

  game.handlers = {
    status: async () => {
      const s = await opStatus()
      return s
    },
    daily: async (c) => await opDaily(c.n || 1),
    daily5: async () => {
      const ledger = runner.readLedger()
      const n = 5 - (ledger.length % 5)
      return await opDaily(n === 5 ? 5 : n)
    },
    save: async () => await opSave(),
    checks: async () => await (runner.fiveChecks() || (await opChecks())),
    audit: async () => await opAudit(),
    plan: async () => await opPlanSched({ mode: 'idle', maxLegs: 8 }),
    apply: async (c) => await opApplySched(c.plans || []),
    // 三步排班：HUD 点「排班」拿候选机清单；点「确认排班」写入
    sched_pick: async (c) => {
      const r = await opSchedPick({ acId: c && c.acId, maint: c && c.maint, allowNoMaint: !!(c && c.allowNoMaint), startAt: c && c.startAt, maxUtil: c && c.maxUtil })
      try { await game.evalRaw('window.__HJYT_PICK = ' + JSON.stringify(Object.assign({ ts: Date.now() }, r))) } catch (e) {}
      return r
    },
    ferry: async (c) => await opFerry({ acId: c && c.acId, to: c && c.to }),
    routesetup: async (c) => await opRouteSetup({ all: !!(c && c.all) }),
    aclist: async () => {
      const r = await opAircraftList()
      try { await game.evalRaw('window.__HJYT_AC = ' + JSON.stringify(Object.assign({ ts: Date.now() }, r))) } catch (e) {}
      return r
    },
    cabinrebuild: async (c) => {
      const r = await opCabinRebuild({ apply: !(c && c.apply === false), pitch: c && c.pitch })
      try { await game.evalRaw('window.__HJYT_CABIN = ' + JSON.stringify(Object.assign({ ts: Date.now() }, r))) } catch (e) {}
      return r
    },
    renameroute: async (c) => await opRenameByRoute({ apply: !(c && c.apply === false) }),
    acrename: async (c) => {
      const r = await opRenameAircraft({ acId: c && c.acId, name: c && c.name })
      try { await game.evalRaw('window.__HJYT_AC = null') } catch (e) {}
      return r
    },
    buyquote: async (c) => {
      const r = await opBuyQuote({ model: c && c.model, count: c && c.count })
      try { await game.evalRaw('window.__HJYT_BUY = ' + JSON.stringify(Object.assign({ ts: Date.now() }, r))) } catch (e) {}
      return r
    },
    buyauto: async (c) => {
      const cabin = c && c.cabin && typeof c.cabin === 'object' ? c.cabin : 'auto'
      const cnt = Math.max(1, Math.min(10, Math.floor(Number(c && c.count) || 1)))
      const r = await opBuyApply({ model: c && c.model, base: c && c.base, count: cnt, cabin, confirm: true, secondConfirm: true })
      // 把「已完成」的结果写回同一块面板（以前清成 null，HUD 会一直停在「下单中…」）
      try {
        await game.evalRaw('window.__HJYT_BUY = ' + JSON.stringify(Object.assign({ ts: Date.now(), done: true }, r)))
      } catch (e) {}
      return r
    },
    sched_fix: async (c) => await opSchedFix({ acId: c && c.acId, reg: c && c.reg, maint: c && c.maint, allowNoMaint: !!(c && c.allowNoMaint), maxUtil: c && c.maxUtil }),
    sched_apply_pick: async (c) => {
      const r = await opSchedApplyPick({ rid: c.rid, acId: c.acId, mode: c.mode, maint: c && c.maint, allowNoMaint: !!(c && c.allowNoMaint), startAt: c && c.startAt, maxUtil: c && c.maxUtil })
      try { await game.evalRaw('window.__HJYT_PICK = null') } catch (e) {}
      return r
    },
    refuel: async () => {
      const s = await opStatus()
      if (!s.ok) return s
      const days = s.status.fuel.days
      if (days >= 3) return { ok: true, skipped: true, reason: `油量 ${days} 天，无需补油` }
      const r = await game.evalJson(`(() => {
        const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
        const price = Number(G.fuelPrice || 0)
        const cap = Number(G.fuelCapacity || 0)
        const need = Math.max(0, cap - Number(G.fuelRemaining || 0))
        if (need <= 0) return JSON.stringify({ ok: true, skipped: true, reason: '油库已满' })
        const wantDays = price <= 5 ? 99 : price <= 7 ? 3 : 1.5
        const liters = Math.min(need, Math.max(0, wantDays * 70000))
        const cost = liters * price / 10000
        if (G.money < cost) return JSON.stringify({ ok: false, reason: '现金不足', cost })
        buyFuel(liters / 10000)
        return JSON.stringify({ ok: true, liters: Math.round(liters), cost: +cost.toFixed(2), price, fuelNow: Math.round(G.fuelRemaining) })
      })()`)
      note({ op: 'refuel', ...r })
      return r
    },
    inspect: async () => {
      const r = runner.runNode('insp_sched.js', [], 180000)
      note({ op: 'inspect', code: r.code, spawnError: r.spawnError })
      if (r.spawnError) return { ok: false, reason: '本地脚本无法执行（' + r.spawnError + '）：受限环境里请用宿主会话调用，或直接在游戏里手动预约检修', spawnError: r.spawnError }
      return { ok: r.code === 0, stdout: r.stdout.trim().slice(-800), stderr: r.stderr.trim().slice(-300) }
    },
    rollback: async (c) => await opRollback(c.index, !!(c && c.force)),
    snapshots: async () => ({ ok: true, list: SNAPSHOTS.map((sn, i) => ({ index: i, label: sn.label, ts: sn.ts })) }),
    // v0.3 面板入口
    buyplan: async (c) => await opBuyPlan({ budget: c && c.budget, limit: 8 }),
    health: async (c) => {
      // 防连击（2026-10-20）：页面上可能残留多个历史 HUD 实例，一处 push 会被放大成「每秒 N 条 health」，
      // 而 health 现在会顺带跑利润优化（读 PROFIT_EXPR + 可能重复写票价）→ 5 秒内重复请求直接复用上一次结果。
      const apply = !(c && c.apply === false)
      if (!game.__healthGuard) game.__healthGuard = { at: 0, apply: null, p: null, r: null }
      const hg = game.__healthGuard
      if (hg.p) return hg.p                                    // 正在跑 → 共用同一个 Promise
      if (hg.r && hg.apply === apply && Date.now() - hg.at < 5000) {
        return hg.r                                            // 5 秒内重复 → 直接给缓存
      }
      hg.p = (async () => {
        const r = await opSchedHealth({ limit: 50 })
        // 体检 = 排班体检 + 利润最大化：票价/配舱不是最优就直接改（客座率只要不触发报警）
        try { r.profit = await opProfitOptimize({ apply }) } catch (e) { r.profit = { ok: false, reason: String((e && e.message) || e) } }
        try { await game.evalRaw('window.__HJYT_HEALTH = ' + JSON.stringify(Object.assign({ ts: Date.now() }, r))) } catch (e) {}
        hg.at = Date.now(); hg.r = r; hg.apply = apply
        return r
      })()
      try { return await hg.p } finally { hg.p = null }
    },
    board: async () => await opBoard({ days: 14, limit: 8 }),
    routeplan: async () => await opRoutePlan({ limit: 10, maxDestinations: 80 }),
    // v0.4：油库 / 今日清单
    fuelplan: async (c) => {
      const r = await opFuelPlan({ targetDays: c && c.targetDays })
      try { await game.evalRaw('window.__HJYT_FUEL = ' + JSON.stringify(Object.assign({ ts: Date.now() }, r))) } catch (e) {}
      return r
    },
    fuelapply: async () => {
      const r = await opFuelApply({ confirm: true, secondConfirm: true })
      try { await game.evalRaw('window.__HJYT_FUEL = null') } catch (e) {}
      return r
    },
    // v0.5：航线开发（油库按钮改成开线面板）
    routedev: async (c) => {
      const r = await opRouteDev({ airport: c && (c.airport || c.from), model: c && c.model, top: c && c.top, pitch: c && c.pitch })
      try { await game.evalRaw('window.__HJYT_DEV = ' + JSON.stringify(Object.assign({ ts: Date.now() }, r))) } catch (e) {}
      return r
    },
    // v0.5：一键部署（开线面板里选中一条 → 补开线 + 买 1 架 + 排班）
    deploy: async (c) => {
      const r = await opRouteDeploy({ from: c && (c.from || c.airport), to: c && c.to, model: c && c.model, cabin: c && c.cabin, fare: c && c.fare, both: !(c && c.both === false), maint: c && c.maint, maxUtil: c && c.maxUtil, force: !!(c && c.force), pitch: c && c.pitch, confirm: !!(c && c.confirm), secondConfirm: !!(c && c.secondConfirm) })
      try { await game.evalRaw('window.__HJYT_DEPLOY = ' + JSON.stringify(Object.assign({ ts: Date.now() }, r))) } catch (e) {}
      return r
    },
    expand: async () => await opExpandPlan({ maxRoutes: 2, maxAircraft: 1 }),
    airportquery: async (c) => await opAirportQuery({ file: c && c.file }),
    ping: async () => ({ ok: true, pong: Date.now() }),
  }
  game.pumpQueue = () => game.pollQueue()

  // ---- HUD 队列轮询 -------------------------------------------------------

  if (cfg.autoQueue) {
    const timer = setInterval(() => { game.pollQueue().catch(() => {}) }, 2500)
    if (timer.unref) timer.unref()
    try {
      if (typeof ctx.on === 'function') ctx.on('dispose', () => {
        clearInterval(timer)
        try { note({ op: 'plugin-dispose' }) } catch (e2) {}
        game.close()
      })
    } catch (e) {}
  }

  // ---- HTTP 路由（/hjyt/*） ------------------------------------------------
  // 2026-10-20 教训：只依赖宿主 webServer 服务注册前缀路由不可靠 —— 重启后 tools 注册成功、
  // plugin-ready 也有日志，但 /hjyt/* 仍然 404（register 抛的错被宿主吞掉，看不到）。
  // 现在双管齐下：① 仍然往宿主 webServer 注册（能在 GUI 端口访问）；② 自己起 127.0.0.1:9778 兜底，
  //    保证 /hjyt/* 永远可用。工具和 HUD 都不走 HTTP，这里只服务排查与 /hjyt/panel 面板页。

  const sendHjyt = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' })
    res.end(body)
  }
  const jsonHjyt = (res, code, obj) => sendHjyt(res, code, JSON.stringify(obj))

  const hjytHandler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      const p = url.pathname
      if (p === '/hjyt/state' || p === '/hjyt/status') return jsonHjyt(res, 200, await opStatus())
      if (p === '/hjyt/log') return jsonHjyt(res, 200, { ok: true, log: recentLog(50) })
      if (p === '/hjyt/board') return jsonHjyt(res, 200, await opBoard({ days: Number(url.searchParams.get('days')) || 14, limit: 8 }))
      if (p === '/hjyt/health') return jsonHjyt(res, 200, await opSchedHealth({ limit: 6 }))
      if (p === '/hjyt/buyplan') return jsonHjyt(res, 200, await opBuyPlan({ limit: 8 }))
      if (p === '/hjyt/routeplan') return jsonHjyt(res, 200, await opRoutePlan({ limit: 10 }))
      if (p === '/hjyt/fuelplan') return jsonHjyt(res, 200, await opFuelPlan({}))
      if (p === '/hjyt/expand') return jsonHjyt(res, 200, await opExpandPlan({ maxRoutes: 2, maxAircraft: 1 }))
      if (p === '/hjyt/airportquery') return jsonHjyt(res, 200, await opAirportQuery({ file: url.searchParams.get('file') }))
      if (p === '/hjyt/cmd') {
        let body = ''
        for await (const chunk of req) body += chunk
        let cmd = {}
        try { cmd = JSON.parse(body || '{}') } catch (e) {}
        const h = game.handlers[cmd.cmd]
        if (!h) return jsonHjyt(res, 400, { ok: false, error: '未知命令 ' + cmd.cmd })
        return jsonHjyt(res, 200, await game.runCommand(cmd))
      }
      if (p === '/hjyt/panel' || p === '/hjyt/panel/') {
        return sendHjyt(res, 200, fs.readFileSync(PANEL_PATH, 'utf8'), 'text/html; charset=utf-8')
      }
      if (p === '/hjyt/hud.js') {
        return sendHjyt(res, 200, fs.readFileSync(HUD_PATH, 'utf8'), 'application/javascript; charset=utf-8')
      }
      return jsonHjyt(res, 404, { ok: false, error: 'not found' })
    } catch (e) {
      return jsonHjyt(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
  }

  // ① 宿主 webServer（GUI 端口）：成功/失败都写日志，失败不再静默
  let webRoutesOk = null
  const mountWebRoutes = () => {
    try {
      ctx.inject(['webServer'], (wctx) => {
        if (webRoutesOk === true) return
        try {
          wctx.webServer.register({ name: 'hjyt', kind: 'prefix', path: '/hjyt', handler: hjytHandler })
          webRoutesOk = true
          let port = null
          try { port = wctx.webServer.port } catch (e) {}
          try { note({ op: 'web-routes-ok', port }) } catch (e2) {}
        } catch (e) {
          const msg = String((e && e.message) || e)
          if (/duplicate/i.test(msg)) { webRoutesOk = true; try { note({ op: 'web-routes-dup-ok' }) } catch (e2) {} }
          else { try { note({ op: 'web-routes-fail', err: msg }) } catch (e2) {} }
        }
      })
    } catch (e) {
      try { note({ op: 'web-routes-inject-fail', err: String((e && e.message) || e) }) } catch (e2) {}
    }
  }
  mountWebRoutes()
  const webWatch = setInterval(() => { if (webRoutesOk === true) clearInterval(webWatch) }, 5000)
  if (webWatch && typeof webWatch.unref === 'function') webWatch.unref()

  // ② 自建端口兜底：不依赖任何宿主服务，/hjyt/* 永远有个地方能访问
  try {
    const selfPort = Number(cfg.httpPort || process.env.HJYT_HTTP_PORT || 9778)
    const srv = http.createServer((req, res) => {
      const p0 = String((req.url || '').split('?')[0])
      if (p0 === '/hjyt' || p0.indexOf('/hjyt/') === 0) return hjytHandler(req, res)
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: '只提供 /hjyt/*' }))
    })
    srv.on('error', (e) => { try { note({ op: 'http-self-fail', port: selfPort, err: String((e && e.message) || e) }) } catch (e2) {} })
    srv.listen(selfPort, '127.0.0.1', () => { try { note({ op: 'http-self-ok', port: selfPort }) } catch (e) {} })
    if (srv.unref) srv.unref()
    try { if (typeof ctx.on === 'function') ctx.on('dispose', () => { try { srv.close() } catch (e) {} }) } catch (e) {}
  } catch (e) {
    try { note({ op: 'http-self-fail', err: String((e && e.message) || e) }) } catch (e2) {}
  }

  // ---- Agent 工具 ---------------------------------------------------------
  // DSH 的 tools 是「需要 inject 的服务」：直接读 ctx.tools 会抛
  // `cannot get property "tools" without inject`（v0.5 之前 29 个工具就是这样全部注册失败的）。
  // 所以先收集定义，最后一次性 ctx.inject(['tools'], …) 注册；
  // 另外 defineTool 必须声明 output { schema, render }，否则抛 must declare output（下面的 TEXT_OUTPUT 统一补上）。

  // 2026-10-21 修：这里写**作者 DSL**（属性级 `required: true`），由 lib/schema.js
  // 的 defineRawTool 统一编译成宿主认的 raw JSON Schema（对象级 `required: ['text']`）。
  // 旧版把作者 DSL 直接交给 register → 32 个工具全部报
  // `schema.properties.text.required is not supported on type "string"`（count=0）。
  const TEXT_OUTPUT = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string', required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: (value && value.text) != null ? String(value.text) : '' }],
  }

  const pendingTools = []
  const T = (o) => {
    const inner = o.execute
    pendingTools.push({
      ...o,
      output: o.output || TEXT_OUTPUT,
      execute: async (args, exec) => {
        const out = await inner(args, exec)
        return { text: typeof out === 'string' ? out : JSON.stringify(out) }
      },
    })
  }

  T({
    name: 'hjyt_status',
    description: '读取航迹云途当前盘面（日期/现金/机队/班次/客座/延误/健康/油量/声誉/机场点数）',
    parameters: {},
    execute: async () => JSON.stringify(await opStatus()),
  })

  T({
    name: 'hjyt_daily',
    description: '推进 N 个游戏日（含幽灵飞行自愈、检修、补油、五项校验；出现红线立即停止）',
    parameters: { days: { type: 'number', description: '推进天数，默认 1' } },
    execute: async ({ days }) => JSON.stringify(await opDaily(days && days > 0 ? days : 1)),
  })

  T({
    name: 'hjyt_save',
    description: '立即存档（磁盘 AUTO-N 轮换 + 游戏内槽双写）',
    parameters: {},
    execute: async () => JSON.stringify(await opSave()),
  })

  T({
    name: 'hjyt_checks',
    description: '五项校验（延误/检修/检测/资金/燃油）：有本地 daily_check.js 用它，否则用页面侧通用校验',
    parameters: {},
    execute: async () => JSON.stringify(runner.fiveChecks() || (await opChecks())),
  })

  T({
    name: 'hjyt_profit_optimize',
    description: '利润最大化：按引擎真值公式（票价倍率→票价→需求弹性→客座率→收入）全量重算每条航线的 F/J/S/Y 倍率与每架飞机的舱位分配，不是最优就直接改（默认写入；客座率只需不触发报警）。传 apply=false 只看不写',
    parameters: {
      apply: { type: 'boolean', description: '是否直接写入，默认 true' },
      minLF: { type: 'number', description: '期望客座率下限，默认 0.62（引擎连续 3 天 <60% 才报警）' },
      applyMinGain: { type: 'number', description: '低于这个收益增幅就不动，默认 0.005' },
    },
    execute: async (args) => JSON.stringify(await opProfitOptimize(args || {})),
  })

  T({
    name: 'hjyt_profit_plan',
    description: '利润最大化方案（只看不写）：每条航线建议票价倍率 + 每架飞机建议舱位分配 + 预估日均收入变化 + 改装费',
    parameters: {
      minLF: { type: 'number', description: '期望客座率下限，默认 0.62' },
    },
    execute: async (args) => JSON.stringify(await opProfitOptimize(Object.assign({ apply: false }, args || {}))),
  })

  T({
    name: 'hjyt_audit',
    description: '全量排查时刻表：最小过站、末班落地、机场起飞间隔（页面侧现算，不依赖本地脚本）',
    parameters: {},
    execute: async () => JSON.stringify(await opAudit()),
  })

  T({
    name: 'hjyt_plan_sched',
    description: '生成排班方案（默认给所有当前停场飞机按缺口选线并自动最大化段数），只出方案不写入',
    parameters: {
      aircraftIds: { type: 'string', description: '逗号分隔的飞机 id；留空=按 mode 选' },
      mode: { type: 'string', enum: ['idle', 'all'], description: 'idle=停场机，all=全队' },
      routeId: { type: 'string', description: '指定航线 id（可选）' },
      maxLegs: { type: 'number', description: '每日最多段数，默认 10' },
      turn: { type: 'number', description: '过站分钟，默认 75' },
      startAt: { type: 'string', description: '起飞城市（航线端点之一）；不传就按飞机所在机场' },
      maxUtil: { type: 'number', description: '利用率上限（默认 0.7；0=不限）' },
    },
    execute: async (a) => JSON.stringify(await opPlanSched({
      aircraftIds: a.aircraftIds ? String(a.aircraftIds).split(',').map((s) => s.trim()).filter(Boolean) : null,
      mode: a.mode || 'idle',
      routeId: a.routeId,
      maxLegs: a.maxLegs,
      turn: a.turn,
      maxUtil: a.maxUtil,
    })),
  })

  T({
    name: 'hjyt_apply_sched',
    description: '应用 hjyt_plan_sched 返回的方案：把该工具返回 JSON 里的 plans 数组原样传进来（含 detail），写完自动跑时刻表自检 + 游戏内校验（validateFullSchedule）',
    parameters: { plans: { type: 'string', required: true, description: 'hjyt_plan_sched 返回对象中的 plans 数组（JSON 字符串，含 detail 字段）' } },
    execute: async ({ plans }) => {
      let arr = plans
      if (typeof plans === 'string') { try { arr = JSON.parse(plans) } catch (e) { return JSON.stringify({ ok: false, reason: 'plans 不是合法 JSON：' + String(e && e.message) }) } }
      return JSON.stringify(await opApplySched(arr))
    },
  })

  T({
    name: 'hjyt_sched_pick',
    description: '三步排班第 1 步（只读）：读「游戏里当前选中的航线」，列出闲置飞机谁排得下（座位/段数/时刻/航程）；夜停机场必须有维修位（四查 C1/C3，一律严格、没有放行开关）；全公司维修位 = 0 时直接提示先升 hub',
    parameters: {
      maxLegs: { type: 'number', description: '单机每日最多段数，默认用配置的 10' },
      startAt: { type: 'string', description: '起飞城市（航线端点之一，默认 from 端）；不再要求飞机先停在端点' },
      maxUtil: { type: 'number', description: '利用率上限（0.7 默认 / 0.85 / 0=不限）；长航线想排满 2 个往返就调高' },
    },
    execute: async (a) => JSON.stringify(await opSchedPick({ maxLegs: a.maxLegs, startAt: a.startAt, maxUtil: a.maxUtil })),
  })

  T({
    name: 'hjyt_sched_apply_pick',
    description: '三步排班第 2 步（写）：把指定飞机排到指定航线上；飞机已排满时传 mode="replace" 才允许覆盖（写前快照、写后自检）',
    parameters: {
      rid: { type: 'string', required: true, description: '航线 id（hjyt_sched_pick 返回的 rid）' },
      acId: { type: 'string', required: true, description: '飞机 id（hjyt_sched_pick 返回的 aircraft[].id）' },
      mode: { type: 'string', enum: ['replace'], description: '飞机已有班时传 replace（清空重排），否则会被拒绝' },
      maxLegs: { type: 'number', description: '单机每日最多段数' },
      startAt: { type: 'string', description: '起飞城市（航线端点之一）；要和 sched_pick 选的一致' },
      maxUtil: { type: 'number', description: '利用率上限（要和 sched_pick 一致）' },
    },
    execute: async (a) => JSON.stringify(await opSchedApplyPick({ rid: a.rid, acId: a.acId, mode: a.mode, maxLegs: a.maxLegs, startAt: a.startAt, maxUtil: a.maxUtil })),
  })

  T({
    name: 'hjyt_sched_fix',
    description: '一键排班（写）：只按这架飞机**自己现在的航线**重排段数与时刻，不换线；默认偶数段、夜里回起飞机场过夜（避免外站无维修位 + 次日首段错位）。写前快照、写后自检',
    parameters: {
      acId: { type: 'string', description: '飞机 id（与 reg 二选一）' },
      reg: { type: 'string', description: '飞机名，如「上海-广州」（与 acId 二选一，面板行没有 id 时用这个）' },
      maxLegs: { type: 'number', description: '最多段数（默认 10，会向下取偶数）' },
      maxUtil: { type: 'number', description: '利用率上限（默认 0.85；0=不限）' },
      maint: { type: 'string', enum: ['night', 'day', 'none'], description: '维修窗口：night 夜间（默认）/ day 白天 10:00–13:00 / none 不预留' },
      startAt: { type: 'string', description: '起飞城市（留空=按现班表首段起点）；排不下会自动换另一端重试' },
      requireReturn: { type: 'boolean', description: '默认 true：必须回起飞机场过夜（偶数段）' },
    },
    execute: async (a) => JSON.stringify(await opSchedFix({ acId: a.acId, reg: a.reg, maxLegs: a.maxLegs, maxUtil: a.maxUtil, maint: a.maint, startAt: a.startAt, requireReturn: a.requireReturn !== false })),
  })

  T({
    name: 'hjyt_rollback',
    description: '回滚排班写入（快照落盘、滚动 5 份）；快照之后又改过则默认拒绝，需 force=true',
    parameters: {
      index: { type: 'number', description: '快照序号（0 最旧），留空=最近一次' },
      force: { type: 'boolean', description: '快照之后又改过时是否强制覆盖（默认 false=拒绝）' },
    },
    execute: async ({ index, force }) => JSON.stringify(await opRollback(index, force === true)),
  })

  T({
    name: 'hjyt_buy_plan',
    description: '买机向导（只读）：按预算/基地/机型给买机清单，含每段净利、日净利、回本天数、机库位与油库 3 天红线',
    parameters: {
      budget: { type: 'number', description: '预算（万元），默认=全部现金' },
      reserve: { type: 'number', description: '预留现金（万元），预算=现金-预留' },
      base: { type: 'string', description: '只看某个基地机场（全名）' },
      model: { type: 'string', description: '只看某个机型（名称或子串）' },
      count: { type: 'number', description: '想买几架，默认 1' },
      minSeats: { type: 'number', description: '最小座位数' },
      maxSeats: { type: 'number', description: '最大座位数' },
      limit: { type: 'number', description: '返回条数，默认 12' },
    },
    execute: async (a) => JSON.stringify(await opBuyPlan({
      budget: a.budget, reserve: a.reserve, base: a.base, model: a.model,
      count: a.count, minSeats: a.minSeats, maxSeats: a.maxSeats, limit: a.limit,
    })),
  })

  T({
    name: 'hjyt_ferry',
    description: '调机（写）：把飞机从当前机场调到目标机场（不花现金，要航程够、不能在飞/维修）；到达后才能排该机场的航线',
    parameters: {
      acId: { type: 'string', required: true, description: '飞机 id' },
      to: { type: 'string', required: true, description: '目标机场全名' },
    },
    execute: async (a) => JSON.stringify(await opFerry({ acId: a.acId, to: a.to })),
  })

  T({
    name: 'hjyt_cabin_rebuild',
    description: '客舱重建（写）：按每架在飞飞机主力航线的分舱位需求重配 F/J/S（Y 按剩余空间算），默认座椅间距 74cm；apply=false 只预览费用',
    parameters: {
      apply: { type: 'boolean', description: '默认 true=直接重建并扣费；false=只预览' },
      pitch: { type: 'number', description: '座椅间距 cm（71–102），默认 74' },
      acId: { type: 'string', description: '只重建这一架（留空=全部在飞的）' },
      demand: { type: 'string', description: '直接指定分舱日需求，如 {"F":29,"J":128,"S":177,"Y":1775}（没排班时用）' },
      legs: { type: 'number', description: '没排班时假定的每日段数（默认按现班表）' },
    },
    execute: async (a) => {
      let dem = null
      if (a.demand) { try { dem = typeof a.demand === 'string' ? JSON.parse(a.demand) : a.demand } catch (e) { return JSON.stringify({ ok: false, reason: 'demand 不是合法 JSON' }) } }
      return JSON.stringify(await opCabinRebuild({ apply: a.apply !== false, pitch: a.pitch, acId: a.acId, demand: dem, legs: a.legs }))
    },
  })

  T({
    name: 'hjyt_rename_by_route',
    description: '按起降城市自动改名：把每架飞机改成它当天主航线的「起-降」城市名（同城对加 ②③），闲置机不动；apply=false 只预览',
    parameters: { apply: { type: 'boolean', description: '默认 true=直接改；false=只返回计划' } },
    execute: async (a) => JSON.stringify(await opRenameByRoute({ apply: a.apply !== false })),
  })
  T({
    name: 'hjyt_aircraft_list',
    description: '机队清单（只读）：id / 机号 / 机型 / 座位 / 状态 / 基地，供改名或指定飞机用',
    parameters: {},
    execute: async () => JSON.stringify(await opAircraftList()),
  })

  T({
    name: 'hjyt_rename_aircraft',
    description: '飞机改名（写）：只改机号 regName（id 不变，排班和账单不受影响）；校验非空/≤24字/全队不重名',
    parameters: {
      acId: { type: 'string', required: true, description: '飞机 id（hjyt_aircraft_list 里的 id）' },
      name: { type: 'string', required: true, description: '新机号，如 浦东一号' },
    },
    execute: async (a) => JSON.stringify(await opRenameAircraft({ acId: a.acId, name: a.name })),
  })
  T({
    name: 'hjyt_buy_quote',
    description: '买机报价（只读）：输入机型 → 按选中航线（无则需求最大的航线）自动配舱 + 装全设施 + 节油发动机，给出舱位/装备/落地总价',
    parameters: {
      model: { type: 'string', required: true, description: '机型名，如 B737-800 / A320neo / B787-9' },
      count: { type: 'number', description: '想买几架，默认 1（1..10，给出批量总价）' },
    },
    execute: async (a) => JSON.stringify(await opBuyQuote({ model: a.model, count: a.count })),
  })

  T({
    name: 'hjyt_buy_apply',
    description: '按机型+基地买机（写操作）：先不带 confirm 看方案，确认后传 confirm=true；花费 >5,000 万还要 secondConfirm=true；count 可一次买多架（总价按等比级数 ×1.015 计）。质量闸门：黑名单机型会拒（force=true 强买）；客座率只作提示、不拦',
    parameters: {
      model: { type: 'string', required: true, description: '机型名（须与 hjyt_buy_plan 返回的 model 完全一致）' },
      base: { type: 'string', description: '基地机场全名（如 上海浦东）；留空=不指定归属，引擎自动分配' },
      count: { type: 'number', description: '买几架，默认 1（批量总价按等比级数 ×1.015 计价）' },
      confirm: { type: 'boolean', description: '确认执行' },
      secondConfirm: { type: 'boolean', description: '单次 >5,000 万时的二次确认' },
      force: { type: 'boolean', description: '绕过质量闸门（黑名单机型 / LF<89%）' },
      cabin: { type: 'string', description: '客舱布局 JSON，如 {"F":6,"J":33,"S":28,"Y":68}；留空=标准布局' },
    },
    execute: async (a) => {
      let cabin = a.cabin
      if (typeof cabin === 'string' && cabin.trim()) {
        if (cabin.trim() === 'auto') cabin = 'auto'          // 自动按航线需求配舱
        else { try { cabin = JSON.parse(cabin) } catch (e) { return JSON.stringify({ ok: false, reason: 'cabin 不是合法 JSON（也可直接写 "auto"）' }) } }
      }
      return JSON.stringify(await opBuyApply({
        model: a.model, base: a.base, count: a.count, confirm: a.confirm === true, secondConfirm: a.secondConfirm === true, force: a.force === true, cabin,
      }))
    },
  })

  T({
    name: 'hjyt_route_plan',
    description: '开线向导（只读）：从基地机场出发现算候选新航线（需求/航距/开线费/起飞间隔/建议机型与班次）',
    parameters: {
      fromAirports: { type: 'string', description: '出发机场，逗号分隔；留空=主线基地(base1/base2)' },
      limit: { type: 'number', description: '返回条数，默认 15' },
      intl: { type: 'boolean', description: 'true=只看国际线，false=只看境内线' },
      minKm: { type: 'number', description: '最短航距，默认 200' },
      maxKm: { type: 'number', description: '最长航距' },
      minOwn: { type: 'number', description: '本司可获得需求下限（默认用引擎门槛：境内 180 / 国际 250）' },
      model: { type: 'string', description: '只按指定机型给建议' },
    },
    execute: async (a) => JSON.stringify(await opRoutePlan({
      fromAirports: a.fromAirports ? String(a.fromAirports).split(',').map((x) => x.trim()).filter(Boolean) : null,
      limit: a.limit, intl: a.intl, minKm: a.minKm, maxKm: a.maxKm, minOwn: a.minOwn, model: a.model,
    })),
  })

  T({
    name: 'hjyt_route_apply',
    description: '开线（写操作，默认双向）：开线四步=建线→票价→精品餐食→精品快线；先不带 confirm 看方案',
    parameters: {
      from: { type: 'string', required: true, description: '出发机场全名' },
      to: { type: 'string', required: true, description: '到达机场全名' },
      both: { type: 'boolean', description: '是否同时开反向线，默认 true' },
      confirm: { type: 'boolean', description: '确认执行' },
      secondConfirm: { type: 'boolean', description: '单次 >5,000 万时的二次确认' },
      fare: { type: 'string', description: '票价策略 JSON，默认 {"F":2,"J":2,"S":1.05,"Y":0.45}' },
    },
    execute: async (a) => {
      let fare = a.fare
      if (typeof fare === 'string' && fare.trim()) { try { fare = JSON.parse(fare) } catch (e) { return JSON.stringify({ ok: false, reason: 'fare 不是合法 JSON' }) } }
      return JSON.stringify(await opRouteApply({ from: a.from, to: a.to, both: a.both, confirm: a.confirm === true, secondConfirm: a.secondConfirm === true, fare }))
    },
  })

  T({
    name: 'hjyt_route_setup',
    description: '一键设置航线策略：票价 + 精品餐食 + 精品快线（默认作用于游戏里选中的航线及其反向；all=true 作用于全部航线），返回逐条改前/改后',
    parameters: {
      all: { type: 'boolean', description: 'true=设置全部航线；省略=用游戏里选中的航线（含反向）' },
      fare: { type: 'string', description: '票价策略 JSON，默认 {"F":2,"J":2,"S":1.05,"Y":0.45}' },
    },
    execute: async (a) => {
      let fare = a.fare
      if (typeof fare === 'string' && fare.trim()) {
        try { fare = JSON.parse(fare) } catch (e) { return JSON.stringify({ ok: false, reason: 'fare 不是合法 JSON' }) }
      }
      return JSON.stringify(await opRouteSetup({ all: a.all === true, fare }))
    },
  })

  T({
    name: 'hjyt_sched_health',
    description: '排班体检：闲置/欠排/过站偏紧/末班过早/首班过晚/夜停超容/机场起飞间隔，给可执行建议（只读）',
    parameters: { limit: { type: 'number', description: '每类列几条，默认 10' } },
    execute: async (a) => JSON.stringify(await opSchedHealth({ limit: a.limit })),
  })

  T({
    name: 'hjyt_sched_verify',
    description: '游戏内校验（只读）：直接调引擎自带 validateFullSchedule（= 游戏时刻表里点「校验」的同一套规则：跨日/跨周航线相连、周闭环、周转 ≥50 分、机场最小起飞间隔、机场停靠上限），逐架给「通过 / 通过但可能晚点 / 不通过」+ 具体到第几天第几段的问题',
    parameters: {
      acId: { type: 'string', description: '只校验这架（飞机 id）' },
      reg: { type: 'string', description: '按注册号校验，如 B757-200' },
      limit: { type: 'number', description: '不传 acId/reg 时校验全队已排班的前 N 架，默认 60' },
    },
    execute: async (a) => JSON.stringify(await opSchedVerify({ acId: a.acId, reg: a.reg, limit: a.limit })),
  })

  T({
    name: 'hjyt_board',
    description: '日贡献看板：近 N 天收入/乘客/油费/净利趋势、成本结构、燃油天数、弱航线（客座低或单位收入低）',
    parameters: {
      days: { type: 'number', description: '回看天数，默认 14' },
      limit: { type: 'number', description: '弱航线列几条，默认 10' },
    },
    execute: async (a) => JSON.stringify(await opBoard({ days: a.days, limit: a.limit })),
  })

  T({
    name: 'hjyt_route_dev',
    description: '航线开发（只读）：给一个机场（支持模糊搜索），筛出「最值得开的 N 条航线」（候选只取已开通区域），每条给出引擎真值最优票价/配舱、单架 B757-200 日收入、这条线能养几架、已有几架还能加几架、开线费',
    parameters: {
      airport: { type: 'string', description: '出发机场，支持模糊：浦东 / PVG / 上海 / 东京（命中多个会返回候选列表）' },
      model: { type: 'string', description: '按哪个机型估（默认 B757-200，230 座 → 71cm 改舱后 255 座）' },
      top: { type: 'number', description: '返回前几条，默认 5' },
      lfTarget: { type: 'number', description: '算「能养几架」用的目标客座率，默认 0.85' },
      pitch: { type: 'number', description: '座位间距（cm），默认 71' },
    },
    execute: async (a) => JSON.stringify(await opRouteDev({ airport: a.airport, model: a.model, top: a.top, lfTarget: a.lfTarget, pitch: a.pitch })),
  })

  T({
    name: 'hjyt_route_deploy',
    description: '一键部署（写）：给一条航线（from→to）自动「补开线（双向）→ 买 1 架（含装备 + 按需求配舱）→ 排班（偶数段）」。先不带 confirm 看方案与花费，再传 confirm=true；>5,000 万要 secondConfirm',
    parameters: {
      from: { type: 'string', description: '出发机场（支持模糊：浦东 / PVG）' },
      to: { type: 'string', description: '到达机场（支持模糊）' },
      model: { type: 'string', description: '买哪个机型，默认 B757-200' },
      both: { type: 'boolean', description: '双向开线，默认 true（偶数段要靠反向航线回程）；false 只开单向' },
      cabin: { type: 'object', additionalProperties: true, properties: { F: { type: 'number' }, J: { type: 'number' }, S: { type: 'number' }, Y: { type: 'number' } }, description: '舱位配比 {F,J,S,Y}，默认用该航线的利润最优配舱' },
      fare: { type: 'object', additionalProperties: true, properties: { F: { type: 'number' }, J: { type: 'number' }, S: { type: 'number' }, Y: { type: 'number' } }, description: '票价倍率 {F,J,S,Y}，默认用该航线的利润最优倍率' },
      maint: { type: 'string', description: '维修窗口 night/day，默认 night' },
      maxUtil: { type: 'number', description: '利用率上限，默认 0.85' },
      force: { type: 'boolean', description: '航线已吃满也硬加' },
      confirm: { type: 'boolean', description: '确认执行' },
      secondConfirm: { type: 'boolean', description: '花费 >5,000 万时的二次确认' },
    },
    execute: async (a) => JSON.stringify(await opRouteDeploy({ from: a.from, to: a.to, model: a.model, both: a.both, cabin: a.cabin, fare: a.fare, maint: a.maint, maxUtil: a.maxUtil, force: a.force === true, confirm: a.confirm === true, secondConfirm: a.secondConfirm === true })),
  })

  T({
    name: 'hjyt_fuel_plan',
    description: '油库向导（只读）：按「满库必须撑 ≥3 天」算容量缺口（阶梯报价）+ 按油价的补油方案（≤5 加满 / 5–7 补 3 天 / >7 补 1.5 天）',
    parameters: {
      targetDays: { type: 'number', description: '满库目标天数，默认 3（铁律）' },
    },
    execute: async (a) => JSON.stringify(await opFuelPlan({ targetDays: a.targetDays })),
  })

  T({
    name: 'hjyt_fuel_apply',
    description: '油库执行（写）：按 hjyt_fuel_plan 的方案真扩容量 + 真补油；先不带 confirm 看方案，>5,000 万还要 secondConfirm=true',
    parameters: {
      targetDays: { type: 'number', description: '满库目标天数，默认 3' },
      confirm: { type: 'boolean', description: '确认执行' },
      secondConfirm: { type: 'boolean', description: '花费 >5,000 万时的二次确认' },
    },
    execute: async (a) => JSON.stringify(await opFuelApply({ targetDays: a.targetDays, confirm: a.confirm === true, secondConfirm: a.secondConfirm === true })),
  })

  T({
    name: 'hjyt_expand_plan',
    description: '扩张流水线（只读）：把「今天该做什么」排成有序清单（红线 → 排班补产能 → 补油/扩油库 → 开线 → 买机），每步带花费、工具与 args',
    parameters: {
      reserve: { type: 'number', description: '预留现金（万元），默认 0（有钱就投）' },
      maxRoutes: { type: 'number', description: '本次最多排几条开线，默认 2' },
      maxAircraft: { type: 'number', description: '本次最多买几架，默认 1' },
      paybackLimit: { type: 'number', description: '只看回本 ≤N 天的机型，默认 25' },
      buy: { type: 'boolean', description: 'false=不算买机（更快）' },
      route: { type: 'boolean', description: 'false=不算开线（更快）' },
    },
    execute: async (a) => JSON.stringify(await opExpandPlan({
      reserve: a.reserve, maxRoutes: a.maxRoutes, maxAircraft: a.maxAircraft,
      paybackLimit: a.paybackLimit, buy: a.buy, route: a.route,
    })),
  })

  T({
    name: 'hjyt_airport_query',
    description: '机场查询（写文件）：三级基地以上（含 hub）机场的维修点数量、夜间停靠数量（实际）、夜间/白天维修航班数量（B 口径）+ 开线建议，写成工作区里的 机场查询_<存档名>.xlsx（同名覆盖）',
    parameters: {
      file: { type: 'string', description: '输出文件名（默认 机场查询_<最新存档名>.xlsx，写在工作区根目录）' },
    },
    execute: async (a) => JSON.stringify(await opAirportQuery({ file: a.file })),
  })

  // 注册 agent 工具：等 tools 服务就绪（inject 回调）后一次性注册；服务一直不来就记一条日志，方便排查
  let toolsRegistered = false
  const registerAgentTools = (tctx) => {
    let okCount = 0
    for (const o of pendingTools) {
      try { tctx.tools.register(defineRawTool(o)); okCount++ } catch (e) { note({ op: 'tool-register-fail', name: o && o.name, err: String(e && e.message) }) }
    }
    toolsRegistered = okCount > 0
    note({ op: 'tool-register-ok', count: okCount, total: pendingTools.length })
  }
  try {
    ctx.inject(['tools'], registerAgentTools)
  } catch (e) {
    note({ op: 'tool-register-fail', name: '(inject)', err: String(e && e.message) })
  }
  const toolsWatch = setTimeout(() => {
    if (!toolsRegistered) note({ op: 'tool-register-none', total: pendingTools.length, hint: 'tools 服务没就绪（宿主版本不提供 inject("tools")？）' })
  }, 5000)
  if (toolsWatch && typeof toolsWatch.unref === 'function') toolsWatch.unref()

  note({ op: 'plugin-ready', workspace: cfg.workspace, cdp: `${cfg.cdpHost}:${cfg.cdpPort}` })
  // 启动时静默尝试接入，失败不报错（游戏可能还没开）
  setTimeout(() => { game.pollQueue().catch(() => {}) }, 3000)
  // HUD 看门狗：Browser Control 模式没有「新文档脚本」，页面读档 / 刷新 / 整页重绘以后
  // HUD 会跟着消失。每 8 秒轻推一次（一次 eval ≈ 10ms），版本不对就整段重注入。
  // CDP 模式有 Page.addScriptToEvaluateOnNewDocument，不用这个（也就不额外占用 eval）。
  const hudTimer = setInterval(() => {
    if (game.mode !== 'bridge') return
    game.ensureHud(true).catch(() => {})
  }, 8000)
  if (hudTimer && typeof hudTimer.unref === 'function') hudTimer.unref()
}
