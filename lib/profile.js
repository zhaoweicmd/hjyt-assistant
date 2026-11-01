// 运行环境探测（多机通用版）
//
// 目标：同一份插件目录在 macOS / Windows / Linux、任意用户名、任意盘符、任意同步盘下都能直接跑，
//       并且不绑定任何一台电脑的路径、不绑定某一局的账本。
// 解析顺序一律是：环境变量 > 机器本地记录 > 显式配置 > 自动探测 > 向上查找 > 兜底默认。
//
// 环境变量：
//   HJYT_WORKSPACE    游戏工作区根目录（最高优先级，临时覆盖用）
//   HJYT_SCRIPTS      脚本目录（默认自动找 tick_day.js / daily_check.js 所在目录）
//   HJYT_LEDGER       账本文件名或绝对路径（每个人的账本不同，所以永远不写死）
//   HJYT_CDP_HOST / HJYT_CDP_PORT / HJYT_TRANSPORT / HJYT_BRIDGE_URL
//   HJYT_TICK_MODE    engine | script
//   HJYT_SCAN_ROOTS   额外自动扫描的根目录（多个用平台路径分隔符隔开）
//
// 机器本地记录（在 ~/.dsh/hjyt 下，不进同步目录，每台机各一份）：
//   workspace.txt  一行：本机工作区绝对路径
//   ledger.txt     一行：本机账本文件名（或绝对路径）
// 自动探测成功后会写回 workspace.txt，下次启动直接命中，不再扫描。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SCRIPT_DIR_NAMES = ['脚本与数据', 'scripts', 'tools', 'bin']
const SCRIPT_MARKERS = ['tick_day.js', 'run_day.js', 'daily_check.js', 'lib_game.js']
const STATIC_SAVE_DIRS = ['存档', 'saves', 'save']
// 小于这个体量的 days_*.json 是空壳/占位（实测同步盘里会冒出 2 字节的同名文件）
const LEDGER_MIN_BYTES = 64
const SCAN_DIR_LIMIT = 500
const SKIP_DIR_NAMES = new Set(['node_modules', '$RECYCLE.BIN', 'System Volume Information', 'AppData', '.git', '.Trash', 'Library'])

function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch (e) { return false }
}
function isFile(p) {
  try { return fs.statSync(p).isFile() } catch (e) { return false }
}

/** ~/.dsh/hjyt —— 机器本地（不参与同步）的插件小状态目录；HJYT_LOCAL_STATE 可覆盖（测试/便携用） */
export function localStateDir() {
  const override = process.env.HJYT_LOCAL_STATE
  if (override) return expandPath(override)
  return path.join(os.homedir(), '.dsh', 'hjyt')
}

function localFile(name) {
  return path.join(localStateDir(), name)
}
function readLocal(name) {
  try {
    const s = fs.readFileSync(localFile(name), 'utf8').trim()
    return s || ''
  } catch (e) { return '' }
}
function writeLocal(name, value) {
  try {
    fs.mkdirSync(localStateDir(), { recursive: true })
    fs.writeFileSync(localFile(name), String(value).trim() + '\n', 'utf8')
    return true
  } catch (e) { return false }
}

/** 展开 ~ / %USERPROFILE% / $HOME 等写法（配置可以被不同电脑共用，路径不能） */
export function expandPath(raw) {
  let s = String(raw == null ? '' : raw).trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim()
  if (!s) return ''
  const home = os.homedir()
  if (s === '~') return home
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(home, s.slice(2))
  const named = {
    USERPROFILE: os.homedir(),
    HOME: os.homedir(),
    HOMEDRIVE: process.env.HOMEDRIVE || '',
    HOMEPATH: process.env.HOMEPATH || '',
    SystemDrive: process.env.SystemDrive || 'C:',
    USERNAME: process.env.USERNAME || process.env.USER || '',
    APPDATA: process.env.APPDATA || '',
  }
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, k) => {
    const hit = named[k] || named[k.toUpperCase()] || process.env[k] || process.env[k.toUpperCase()]
    return hit === undefined || hit === null || hit === '' ? m : hit
  })
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => {
    const k = a || b
    const hit = named[k] || process.env[k]
    return hit === undefined || hit === null || hit === '' ? m : hit
  })
  return s
}

/**
 * 同一份配置跨平台同步时，把 POSIX 绝对路径和 Windows 盘符路径互换一次。
 * 显式传 platform 便于离线测试（默认用当前平台）。
 */
export function remapWorkspace(p, platform = process.platform) {
  const s = String(p || '').trim()
  if (!s) return null
  const drive = process.env.SystemDrive || 'C:'
  if (platform === 'win32') {
    // Windows 上遇到 "/Users/<user>/..." → "C:\Users\<user>\..."
    // 注意：不能收紧成「单字母目录」，/Users、/Volumes 这类也要能换根；换出来不存在时上层会自然跳过
    if (/^\/[A-Za-z]/.test(s)) return path.win32.join(drive + '\\', s)
    return null
  }
  // 非 Windows 上遇到 "C:\Users\<user>\..." 或 "C:/Users/<user>/..." → "/Users/<user>/..."
  if (/^[A-Za-z]:[\\/]/.test(s)) {
    const rest = s.slice(2).replace(/\\/g, '/')
    return rest.startsWith('/') ? rest : '/' + rest
  }
  return null
}

/** 一段配置写法 → 若干可能的绝对路径（原样 / 换根 / 反斜杠转正斜杠） */
function workspaceCandidatesFrom(raw) {
  const out = []
  const push = (v) => { if (v && !out.includes(v)) out.push(v) }
  const base = expandPath(raw)
  if (!base) return out
  push(base)
  push(remapWorkspace(base))
  if (process.platform !== 'win32' && !/^[A-Za-z]:/.test(base) && base.includes('\\')) push(base.replace(/\\/g, '/'))
  return out.map((v) => path.resolve(v))
}

/** 目录里是否有游戏脚本 / 存档目录 —— 用来判断“这是不是一个游戏工作区” */
export function looksLikeWorkspace(dir, cache) {
  if (!dir || !isDir(dir)) return false
  if (cache && cache.has(dir)) return cache.get(dir)
  let hit = false
  try {
    if (fs.readdirSync(dir).some((f) => SCRIPT_MARKERS.includes(f))) hit = true
  } catch (e) {}
  if (!hit) {
    for (const d of SCRIPT_DIR_NAMES) {
      const p = path.join(dir, d)
      if (!isDir(p)) continue
      try {
        if (fs.readdirSync(p).some((f) => SCRIPT_MARKERS.includes(f))) { hit = true; break }
      } catch (e) {}
    }
  }
  if (!hit) hit = STATIC_SAVE_DIRS.some((d) => isDir(path.join(dir, d)))
  if (cache) cache.set(dir, hit)
  return hit
}

/** 从某个目录向上最多 5 层找工作区 */
export function findWorkspaceUp(start) {
  let dir = path.resolve(start || process.cwd())
  for (let i = 0; i < 6; i++) {
    if (looksLikeWorkspace(dir)) {
      // 命中「脚本与数据」这类子目录时，优先返回它的父级（那才是工作区根）
      const up = path.dirname(dir)
      if (SCRIPT_DIR_NAMES.includes(path.basename(dir)) && isDir(up) && looksLikeWorkspace(up)) return up
      return dir
    }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

/** 在目录里找脚本目录（含 tick_day.js 等标记的目录） */
export function findScriptsDir(ws) {
  for (const d of SCRIPT_DIR_NAMES) {
    const p = path.join(ws, d)
    if (!isDir(p)) continue
    try {
      if (fs.readdirSync(p).some((f) => SCRIPT_MARKERS.includes(f))) return p
    } catch (e) {}
  }
  // 兜底：工作区根目录自己就放脚本
  try {
    if (fs.readdirSync(ws).some((f) => SCRIPT_MARKERS.includes(f))) return ws
  } catch (e) {}
  for (const d of SCRIPT_DIR_NAMES) {
    const p = path.join(ws, d)
    if (isDir(p)) return p
  }
  return null
}

/** 账本文件名是否值得参与「最近修改」竞争 */
export function isLedgerCandidate(name, size) {
  if (!/^days[_-].*\.json$/i.test(name)) return false
  if (/\.bak|backup|conflict|冲突|\(\d+\)|\.syno|copy/i.test(name)) return false
  return Number(size) >= LEDGER_MIN_BYTES
}

/** 最新修改的 days_*.json（多局并存时选“正在跑”的那个；空壳/备份/冲突副本一律排除） */
export function findLatestLedger(dir) {
  let best = null
  let skipped = 0
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^days[_-].*\.json$/i.test(f)) continue
      const p = path.join(dir, f)
      let st
      try { st = fs.statSync(p) } catch (e) { continue }
      if (!st.isFile()) continue
      if (!isLedgerCandidate(f, st.size)) { skipped++; continue }
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: p, name: f, mtimeMs: st.mtimeMs, size: st.size }
    }
  } catch (e) {}
  if (best) best.skipped = skipped
  return best
}

/** 自动扫描的候选根目录（同步盘 / 云盘 / 各盘符的常见布局） */
export function workspaceRoots() {
  const home = os.homedir()
  const roots = []
  const push = (p) => { if (p && !roots.includes(p)) roots.push(p) }
  push(path.join(home, 'Library', 'CloudStorage'))
  push(path.join(home, 'CloudStorage'))
  push(path.join(home, 'SynologyDrive'))
  push(path.join(home, 'OneDrive'))
  push(path.join(home, 'Dropbox'))
  push(path.join(home, 'Documents'))
  if (process.platform === 'win32') {
    const up = process.env.USERPROFILE || home
    push(path.join(up, 'Library', 'CloudStorage'))
    push(path.join(up, 'SynologyDrive'))
    for (const ch of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const root = ch + ':\\'
      if (!isDir(root)) continue
      push(path.join(root, 'SynologyDrive'))
      push(path.join(root, 'Users'))
      push(path.join(root, 'CloudStorage'))
    }
  } else {
    push('/Volumes')
  }
  const extra = process.env.HJYT_SCAN_ROOTS || ''
  for (const p of extra.split(path.delimiter)) {
    if (p.trim()) push(expandPath(p.trim()))
  }
  return roots.filter((p) => isDir(p))
}

function recency(dir, cache) {
  let best = 0
  const touch = (p) => { try { best = Math.max(best, fs.statSync(p).mtimeMs) } catch (e) {} }
  touch(path.join(dir, 'AGENTS.md'))
  touch(path.join(dir, 'START_HERE_接手说明.md'))
  const scripts = findScriptsDir(dir)
  if (scripts) {
    try {
      for (const f of fs.readdirSync(scripts)) {
        if (!/^days[_-].*\.json$/i.test(f)) continue
        const p = path.join(scripts, f)
        try { if (fs.statSync(p).size >= LEDGER_MIN_BYTES) touch(p) } catch (e) {}
      }
    } catch (e) {}
  }
  return best
}

/** 在候选根目录下扫两层找工作区，返回按“最近活跃”降序的列表 */
export function scanWorkspaces(roots = workspaceRoots(), limit = SCAN_DIR_LIMIT) {
  const cache = new Map()
  const found = []
  let spent = 0
  const consider = (dir) => {
    if (spent >= limit) return
    spent++
    if (looksLikeWorkspace(dir, cache) && !found.includes(dir)) found.push(dir)
  }
  const EXACT = [['航迹云途'], ['games', '航迹云途'], ['game', '航迹云途'], ['游戏', '航迹云途']]
  for (const root of roots) {
    for (const rel of EXACT) consider(path.join(root, ...rel))
    let kids = []
    try { kids = fs.readdirSync(root, { withFileTypes: true }) } catch (e) { continue }
    for (const k of kids) {
      if (spent >= limit) break
      if (!k.isDirectory()) continue
      if (SKIP_DIR_NAMES.has(k.name) || k.name.startsWith('.')) continue
      const p = path.join(root, k.name)
      consider(p)
      let sub = []
      try { sub = fs.readdirSync(p, { withFileTypes: true }) } catch (e) { continue }
      for (const s of sub) {
        if (!s.isDirectory()) continue
        if (SKIP_DIR_NAMES.has(s.name) || s.name.startsWith('.')) continue
        consider(path.join(p, s.name))
      }
    }
  }
  return found.map((d) => ({ dir: d, recency: recency(d, cache) })).sort((a, b) => b.recency - a.recency)
}

/** 主机短名（状态文件按机器分家用） */
export function hostTag() {
  let h = ''
  try { h = os.hostname() } catch (e) {}
  h = String(h || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return h || 'default'
}

function makeStateDir(dataDir, host, notes) {
  const tries = [
    path.join(dataDir, '.plugin-state', host),
    path.join(localStateDir(), 'state', host),
  ]
  for (const d of tries) {
    try { fs.mkdirSync(d, { recursive: true }); return d } catch (e) {}
  }
  notes.push('状态目录不可写，回退数据目录（文件名自动带主机后缀）')
  return dataDir
}

/**
 * 状态文件路径：默认落在每台机自己的 stateDir 里；
 * 极端情况回退到共享 dataDir 时，自动把主机名插进文件名，避免多机互相覆盖。
 */
export function stateFile(prof, name) {
  const dir = (prof && prof.stateDir) || (prof && prof.dataDir) || localStateDir()
  const shared = !prof || !prof.stateDir || prof.stateDir === prof.dataDir
  if (!shared) return path.join(dir, name)
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length)
  return path.join(dir, base + '.' + hostTag() + ext)
}

/**
 * 解析本次运行的配置。
 * @returns {{workspace, workspaceSource, scriptsDir, scriptsDirHint, dataDir, stateDir, host,
 *            ledgerFile, ledgerName, ledgerSource, tickMode, transport, bridgeUrl, bridgeToken,
 *            cdpHost, cdpPort, cdpPorts, gameHostHints, gameTitles, turnWide, turnNarrow,
 *            firstMin, lastArr, maxLegs, notes:string[]}}
 */
export function resolveProfile(config = {}, log = () => {}) {
  const notes = []
  const cfg = config || {}
  const host = hostTag()

  // 1) 工作区：env > 机器本地记录 > 配置（含候选列表）> 自动扫描 > 向上查找 > cwd
  let workspace = ''
  let workspaceSource = ''
  const accept = (raw, source, strict) => {
    for (const abs of workspaceCandidatesFrom(raw)) {
      if (!isDir(abs)) continue
      if (strict && !looksLikeWorkspace(abs)) continue
      if (!strict && !looksLikeWorkspace(abs)) notes.push(`工作区缺少脚本/存档标记，仍按配置采纳：${abs}`)
      workspace = abs
      workspaceSource = source
      return true
    }
    return false
  }

  if (process.env.HJYT_WORKSPACE) {
    if (accept(process.env.HJYT_WORKSPACE, 'env', false)) notes.push(`工作区来自环境变量 HJYT_WORKSPACE：${workspace}`)
    else notes.push(`环境变量 HJYT_WORKSPACE 指向的目录不存在：${process.env.HJYT_WORKSPACE}`)
  }
  if (!workspace) {
    const remembered = readLocal('workspace.txt')
    if (remembered && accept(remembered, 'local', false)) {
      notes.push(`工作区来自本机记录（~/.dsh/hjyt/workspace.txt）：${workspace}`)
    } else if (remembered) {
      notes.push(`本机记录的工作区已失效：${remembered}`)
    }
  }
  if (!workspace) {
    const cfgWs = String(cfg.workspace == null ? '' : cfg.workspace).trim()
    if (cfgWs && !/^(auto|a|自动|default|)$/i.test(cfgWs)) {
      if (accept(cfgWs, 'config', false)) notes.push(`工作区来自配置 workspace：${workspace}`)
      else notes.push(`配置的 workspace 不存在：${cfgWs}，改为自动探测`)
    }
  }
  if (!workspace && cfg.workspaceCandidates) {
    const list = Array.isArray(cfg.workspaceCandidates)
      ? cfg.workspaceCandidates
      : String(cfg.workspaceCandidates).split(/[;；,，\n]/)
    for (const raw of list) {
      if (String(raw || '').trim() && accept(raw, 'config', false)) {
        notes.push(`工作区来自配置候选：${workspace}`)
        break
      }
    }
  }
  if (!workspace) {
    let hits = []
    try { hits = scanWorkspaces() } catch (e) { notes.push('自动扫描工作区失败：' + (e && e.message)) }
    if (hits.length) {
      workspace = hits[0].dir
      workspaceSource = 'auto'
      notes.push(`工作区自动扫描命中 ${hits.length} 处，取最近活跃的：${workspace}`)
    }
  }
  if (!workspace) {
    const found = findWorkspaceUp(process.cwd())
    if (found) {
      workspace = found
      workspaceSource = 'cwd'
      notes.push(`工作区由当前目录向上探测：${workspace}`)
    }
  }
  if (!workspace) {
    workspace = process.cwd()
    workspaceSource = 'cwd'
    notes.push(`未探测到工作区，回退当前目录：${workspace}（脚本/账本/存档相关功能不可用）`)
  }
  // 自动探测成功 → 记住，下次零扫描
  if (workspaceSource === 'auto' && readLocal('workspace.txt') !== workspace) {
    if (writeLocal('workspace.txt', workspace)) notes.push(`已记住本机工作区：${workspace}`)
  }

  // 2) 脚本目录（可能不存在 → 纯页面模式）
  //    显式配置优先且原样采纳（哪怕目录里没有标记文件，玩家可能自定义脚本）
  let scriptsDir = cfg.scriptsDir || process.env.HJYT_SCRIPTS || ''
  if (scriptsDir) {
    const cands = workspaceCandidatesFrom(scriptsDir)
    const rel = cands.find((p) => isDir(p)) || path.resolve(workspace, expandPath(scriptsDir))
    scriptsDir = isDir(rel) ? rel : ''
    if (!scriptsDir) {
      notes.push(`配置的脚本目录不存在：${expandPath(cfg.scriptsDir || process.env.HJYT_SCRIPTS)}，改为自动探测`)
      scriptsDir = findScriptsDir(workspace)
    }
  } else {
    scriptsDir = findScriptsDir(workspace)
  }
  // “有脚本”= 目录里真的有我这套脚本（有标记文件），而不是“目录存在”
  const hasMarkers = (dir) => {
    if (!dir) return false
    try { return fs.readdirSync(dir).some((f) => SCRIPT_MARKERS.includes(f)) } catch (e) { return false }
  }
  const hasScripts = hasMarkers(scriptsDir)
  if (!hasScripts) notes.push('未检测到本地脚本 → 仅用页面侧引擎函数（推进/排查/校验都能跑，账本自建）')

  // 3) 数据目录（插件自己的日志 / 快照 / 账本）
  const dataDir = cfg.dataDir
    ? path.resolve(workspace, expandPath(cfg.dataDir))
    : (hasScripts ? scriptsDir : path.join(workspace, '.hjyt'))
  try { fs.mkdirSync(dataDir, { recursive: true }) } catch (e) {}

  // 3b) 状态目录：按主机分家，多机同时开也不会互相覆盖日志/快照/基线
  const stateDir = makeStateDir(dataDir, host, notes)

  // 4) 账本：不写死任何文件名（每个人的账本都不一样）
  //    覆盖顺序：配置 ledger > 环境变量 HJYT_LEDGER > 本机记录 ledger.txt > 自动挑最新的
  let ledgerFile = ''
  let ledgerSource = ''
  const explicit = [
    ['config', cfg.ledger],
    ['env', process.env.HJYT_LEDGER],
    ['local', readLocal('ledger.txt')],
  ]
  for (const [src, raw] of explicit) {
    const v = String(raw == null ? '' : raw).trim()
    if (!v) continue
    const abs = path.isAbsolute(v) ? v : path.join(dataDir, v)
    if (isFile(abs)) {
      ledgerFile = abs
      ledgerSource = src
      if (src !== 'config') notes.push(`账本来自${src === 'env' ? '环境变量 HJYT_LEDGER' : '本机记录 ledger.txt'}：${path.basename(abs)}`)
      break
    }
    notes.push(`指定的账本不存在：${abs}，改为自动挑选`)
  }
  if (!ledgerFile) {
    const latest = findLatestLedger(dataDir)
    if (latest) {
      ledgerFile = latest.file
      ledgerSource = 'auto'
      const extra = latest.skipped ? `，已排除 ${latest.skipped} 个备份/空壳` : ''
      notes.push(`账本自动选中 ${latest.name}（最近修改，${(latest.size / 1024).toFixed(0)} KB${extra}）`)
    } else {
      ledgerFile = path.join(dataDir, 'days_auto.json')
      ledgerSource = 'new'
      notes.push(`未发现可用的 days_*.json → 新建账本 ${path.basename(ledgerFile)}`)
    }
  }

  // 5) CDP 端口（按顺序探测，谁先通就用谁）
  const cdpHost = cfg.cdpHost || process.env.HJYT_CDP_HOST || '127.0.0.1'
  const cdpPort = Number(cfg.cdpPort || process.env.HJYT_CDP_PORT || 9222)
  const cdpPorts = Array.from(new Set([cdpPort, 9223, 9222, 9224, 9225].filter((p) => p > 0)))

  // 5b) 传输层：优先 DSH Browser Control（扩展在线即可驱动普通 Chrome），
  //     连不上再退回 CDP（--remote-debugging-port）。transport: auto | bridge | cdp
  const transport = cfg.transport || process.env.HJYT_TRANSPORT || 'auto'
  const bridgeUrl = cfg.bridgeUrl || process.env.HJYT_BRIDGE_URL || 'http://127.0.0.1:9777'
  const bridgeToken = cfg.bridgeToken || process.env.HJYT_BRIDGE_TOKEN || 'dsh-local'

  // 6) 推进模式：有本地 tick_day.js 就用它（功能更全），否则用引擎自带 advanceGameTime
  const tickMode = cfg.tickMode || process.env.HJYT_TICK_MODE || (hasScripts && isFile(path.join(scriptsDir, 'tick_day.js')) ? 'script' : 'engine')

  // 7) 游戏识别线索（URL 片段 / 标题关键字），找不到会自动兜底探测 GameState
  const gameHostHints = cfg.gameHostHints || ['hangjiyuntu.cn']
  const gameTitles = cfg.gameTitles || ['航迹云途']

  // 8) 排班参数（宽体 / 窄体过站，末班等）
  const turnWide = Number(cfg.turnWide || 75)
  const turnNarrow = Number(cfg.turnNarrow || 60)
  const firstMin = Number(cfg.firstMin || 5)
  const lastArr = Number(cfg.lastArr || 1390)
  const maxLegs = Number(cfg.maxLegs || 10)

  const prof = {
    workspace,
    workspaceSource,
    scriptsDir: hasScripts ? scriptsDir : null,
    scriptsDirHint: scriptsDir,
    dataDir,
    stateDir,
    host,
    ledgerFile,
    ledgerName: path.basename(ledgerFile),
    ledgerSource,
    tickMode,
    transport,
    bridgeUrl,
    bridgeToken,
    cdpHost,
    cdpPorts,
    cdpPort: cdpPorts[0],
    gameHostHints,
    gameTitles,
    turnWide,
    turnNarrow,
    firstMin,
    lastArr,
    maxLegs,
    notes,
  }
  for (const n of notes) log('[hjyt] ' + n)
  return prof
}
