// 离线测试：profile.js 的多机路径解析 / 账本挑选 / 状态目录。
// 不碰游戏、不碰真实工作区（全部用 os.tmpdir() 里现搭的假工作区），沙箱里也能跑。
//
// 用法：node test/profile.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  remapWorkspace, expandPath, looksLikeWorkspace, findWorkspaceUp, findScriptsDir,
  findLatestLedger, isLedgerCandidate, stateFile, localStateDir, hostTag, resolveProfile,
} from '../lib/profile.js'

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 240) : '')) }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hjyt-prof-'))
// 本机记录（~/.dsh/hjyt/workspace.txt、ledger.txt）会压过配置，测试必须隔离到临时目录，
// 否则会读到真机上的记录（source 变成 local）。profile.js 支持 HJYT_LOCAL_STATE 覆盖。
process.env.HJYT_LOCAL_STATE = path.join(tmpRoot, 'local-state')
delete process.env.HJYT_WORKSPACE
delete process.env.HJYT_LEDGER
const mkdirp = (p) => { fs.mkdirSync(p, { recursive: true }); return p }
const write = (p, s) => { mkdirp(path.dirname(p)); fs.writeFileSync(p, s); return p }

try {
  console.log('== 1. 跨平台换根 remapWorkspace（显式 platform，便于测试）==')
  const win = remapWorkspace('C:/Users/demo/Library/CloudStorage/SynologyDrive/Projects/airline', 'darwin')
  ok(win === '/Users/demo/Library/CloudStorage/SynologyDrive/Projects/airline', 'Windows 路径 → macOS 路径', win)
  const win2 = remapWorkspace('D:\\Games\\航迹云途', 'darwin')
  ok(win2 === '/Games/航迹云途', '反斜杠 + 非 C 盘也能换根', win2)
  const posix = remapWorkspace('/Users/demo/SynologyDrive/x', 'win32')
  ok(posix && /^[A-Za-z]:\\Users\\demo\\SynologyDrive\\x$/.test(posix), 'macOS 路径 → Windows 路径', posix)
  ok(remapWorkspace('relative/dir', 'darwin') === null, '相对路径不换根')
  ok(remapWorkspace('', 'darwin') === null, '空字符串返回 null')
  ok(remapWorkspace('/Users/a/b', 'darwin') === null, '本来就是 POSIX 路径 → null（不需要换）')

  console.log('== 2. 配置里的 ~ / %VAR% 展开 ==')
  ok(expandPath('~') === os.homedir(), '~ → 家目录', expandPath('~'))
  ok(expandPath('~/x') === path.join(os.homedir(), 'x'), '~/x → 家目录/x')
  ok(expandPath('%USERPROFILE%\\x') === path.join(os.homedir(), 'x'), '%USERPROFILE%\\x → 家目录/x', expandPath('%USERPROFILE%\\x'))
  ok(expandPath('"C:/a b"') === 'C:/a b', '去掉外层引号', expandPath('"C:/a b"'))
  ok(expandPath('') === '', '空字符串原样返回')

  console.log('== 3. 账本过滤（不写死文件名，也不选空壳/备份）==')
  ok(isLedgerCandidate('days_g5.json', 6_217_902) === true, '6MB 的 days_g5.json 参选')
  ok(isLedgerCandidate('days_g7.json', 2) === false, '2 字节空壳不参选（实测被误选过）')
  ok(isLedgerCandidate('days_g5.bak2.json', 5_000_000) === false, '.bak2 备份不参选')
  ok(isLedgerCandidate('days_g5.bak_20261019.json', 4_000_000) === false, '.bak_日期 备份不参选')
  ok(isLedgerCandidate('days_g5 (1).json', 1000) === false, '同步盘冲突副本 (1) 不参选')
  ok(isLedgerCandidate('days_同步冲突.json', 1000) === false, '「同步冲突」副本不参选')
  ok(isLedgerCandidate('days-2027.json', 1000) === true, 'days- 前缀也认')
  ok(isLedgerCandidate('其他.json', 1000) === false, '非 days_ 前缀不参选')

  const ledgerDir = mkdirp(path.join(tmpRoot, 'ledger'))
  write(path.join(ledgerDir, 'days_old.json'), 'x'.repeat(200))
  write(path.join(ledgerDir, 'days_new.json'), 'x'.repeat(300))
  write(path.join(ledgerDir, 'days_empty.json'), '')                       // 0 字节，最新
  write(path.join(ledgerDir, 'days_new.bak.json'), 'x'.repeat(400))        // 更新但该排除
  const now = Date.now() / 1000
  const touch = (f, sec) => fs.utimesSync(path.join(ledgerDir, f), sec, sec)
  touch('days_old.json', now - 300)
  touch('days_new.json', now - 200)
  touch('days_empty.json', now - 10)
  touch('days_new.bak.json', now - 5)
  const latest = findLatestLedger(ledgerDir)
  ok(latest && latest.name === 'days_new.json', '挑最近修改的非空非备份账本', latest && latest.name)
  ok(latest && latest.skipped === 2, '统计到被排除的 2 个（空壳 + 备份）', latest && latest.skipped)

  console.log('== 4. 工作区识别 ==')
  const ws = mkdirp(path.join(tmpRoot, 'demo', 'workspace'))
  const scripts = mkdirp(path.join(ws, '脚本与数据'))
  write(path.join(scripts, 'tick_day.js'), '// x')
  write(path.join(scripts, 'daily_check.js'), '// x')
  const saves = mkdirp(path.join(ws, '存档'))
  ok(looksLikeWorkspace(ws) === true, '有 脚本与数据/tick_day.js → 是工作区')
  ok(looksLikeWorkspace(saves) === false, '只有空 存档 目录也能认（save 目录判据）', looksLikeWorkspace(saves))
  ok(findScriptsDir(ws) === scripts, '找到脚本目录')
  ok(findWorkspaceUp(path.join(scripts, 'sub', 'deep')) === ws, '从深目录向上找到工作区')
  ok(findWorkspaceUp(tmpRoot) === null || findWorkspaceUp(tmpRoot) === ws, '向上查找不会误报 tmphjyt 根（有存档目录时可能命中 ws）')

  console.log('== 5. resolveProfile：显式工作区 + 自动账本 + 状态目录按机器分家 ==')
  write(path.join(scripts, 'days_test.json'), 'y'.repeat(500))
  const notes = []
  const prof = resolveProfile({ workspace: ws }, (m) => notes.push(m))
  ok(prof.workspace === path.resolve(ws), 'workspace 命中配置值', prof.workspace)
  ok(prof.workspaceSource === 'config', 'workspaceSource = config', prof.workspaceSource)
  ok(prof.scriptsDir === scripts, 'scriptsDir = 脚本与数据', prof.scriptsDir)
  ok(prof.ledgerName === 'days_test.json', '账本自动选中 days_test.json', prof.ledgerName)
  ok(prof.ledgerSource === 'auto', 'ledgerSource = auto', prof.ledgerSource)
  ok(prof.host === hostTag() && !!prof.host, 'host 有值', prof.host)
  ok(prof.stateDir && prof.stateDir.endsWith(path.join('.plugin-state', prof.host)), 'stateDir 带主机名分段', prof.stateDir)
  ok(fs.existsSync(prof.stateDir), 'stateDir 已创建')
  ok(stateFile(prof, 'plugin_log.jsonl') === path.join(prof.stateDir, 'plugin_log.jsonl'), 'stateFile 落在 stateDir')
  const lsBackup = process.env.HJYT_LOCAL_STATE
  delete process.env.HJYT_LOCAL_STATE
  ok(localStateDir().endsWith(path.join('.dsh', 'hjyt')), '机器本地目录 = ~/.dsh/hjyt', localStateDir())
  process.env.HJYT_LOCAL_STATE = lsBackup

  console.log('== 6. stateDir 退化时文件名带主机后缀（防止多机互相覆盖）==')
  const fakeProf = { dataDir: path.join(tmpRoot, 'flatdata'), stateDir: path.join(tmpRoot, 'flatdata') }
  const flat = stateFile(fakeProf, 'plugin_snapshots.json')
  ok(flat.endsWith('plugin_snapshots.' + hostTag() + '.json'), '共享目录下快照名带主机后缀', flat)
  ok(stateFile({ dataDir: path.join(tmpRoot, 'z') }, 'plugin_log.jsonl').includes('plugin_log.'), '没有 stateDir 时也加后缀')

  console.log('== 7. 账本显式指定优先（配置 / 环境变量 / 机器本地记录）==')
  write(path.join(scripts, 'days_pick.json'), 'z'.repeat(500))
  const prof2 = resolveProfile({ workspace: ws, ledger: 'days_pick.json' }, () => {})
  ok(prof2.ledgerName === 'days_pick.json' && prof2.ledgerSource === 'config', '配置 ledger 优先', prof2.ledgerName + '/' + prof2.ledgerSource)
  process.env.HJYT_LEDGER = path.join(scripts, 'days_test.json')
  const prof3 = resolveProfile({ workspace: ws }, () => {})
  delete process.env.HJYT_LEDGER
  ok(prof3.ledgerName === 'days_test.json' && prof3.ledgerSource === 'env', 'HJYT_LEDGER 覆盖自动挑选', prof3.ledgerName + '/' + prof3.ledgerSource)
  const prof4 = resolveProfile({ workspace: ws, ledger: 'days_missing.json' }, () => {})
  ok(prof4.ledgerSource === 'auto', '指定了不存在的账本 → 落回自动挑选', prof4.ledgerSource)

  console.log('== 8. 环境变量 HJYT_WORKSPACE 优先级最高 ==')
  process.env.HJYT_WORKSPACE = ws
  const prof5 = resolveProfile({ workspace: path.join(tmpRoot, '不存在的目录') }, () => {})
  delete process.env.HJYT_WORKSPACE
  ok(prof5.workspace === path.resolve(ws) && prof5.workspaceSource === 'env', 'HJYT_WORKSPACE 压过配置', prof5.workspaceSource)
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
}

console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + `：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
