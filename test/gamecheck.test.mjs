// 单测：游戏内校验（validateFullSchedule）结果整理
// 跑法：node test/gamecheck.test.mjs
import { normalizeGameItems, summarizeGameCheck, chunkIds, GAME_DAY_NAMES } from '../lib/gamecheck.js'

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name) } catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + (e && e.message)) }
}
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)) }
function ok(v, msg) { if (!v) throw new Error(msg || '断言失败') }

console.log('== 1. 位置文案（周X第N段）==')
t('0 基 day/seg → 周一第1段', () => {
  const [x] = normalizeGameItems([{ id: 'a', ok: true, issues: [{ day: 0, seg: 0, type: 'error', text: '航线不相连' }] }])
  eq(x.issues[0].where, '周一第1段')
})
t('day=4 seg=1 → 周五第2段（就是全队基线里 4-1 那两条）', () => {
  const [x] = normalizeGameItems([{ id: 'a', ok: true, issues: [{ day: 4, seg: 1, type: 'error', text: '跨日或跨周航线不相连' }] }])
  eq(x.issues[0].where, '周五第2段')
})
t('缺 day/seg → where=null', () => {
  const [x] = normalizeGameItems([{ id: 'a', ok: true, issues: [{ type: 'error', text: 'x' }] }])
  eq(x.issues[0].where, null)
})
t('空/非法输入不崩', () => {
  eq(normalizeGameItems(null), [])
  eq(normalizeGameItems([{ id: 'a' }])[0].issues, [])
})

console.log('== 2. 全通过 ==')
t('1 架 → pass，文案「✅ 游戏内校验通过」不带架数', () => {
  const s = summarizeGameCheck([{ id: 'a', reg: 'B757-200', ok: true, passed: true, partial: false, confirmable: true, issues: [] }])
  eq(s.verdict, 'pass')
  eq(s.text, '✅ 游戏内校验通过')
  eq(s.checked, 1); eq(s.passed, 1); eq(s.failed, 0); eq(s.confirmable, true)
})
t('2 架 → 带「（2 架）」', () => {
  const s = summarizeGameCheck([
    { id: 'a', reg: 'A', ok: true, passed: true, confirmable: true, issues: [] },
    { id: 'b', reg: 'B', ok: true, passed: true, confirmable: true, issues: [] },
  ])
  eq(s.text, '✅ 游戏内校验通过（2 架）')
})

console.log('== 3. 硬错误（游戏里点不了「确认」）==')
t('上海-拉萨 4-1 两条 → fail + 周五第2段 + confirmable=false', () => {
  const items = normalizeGameItems([{
    id: 'ac_1792484100178_2', reg: '上海-拉萨', ok: true,
    passed: false, partial: false, confirmable: false, hasHardError: true,
    issues: [
      { day: 4, seg: 1, type: 'error', text: '跨日或跨周航线不相连' },
      { day: 4, seg: 1, type: 'error', text: '航线不相连' },
    ],
  }])
  const s = summarizeGameCheck(items)
  eq(s.verdict, 'fail')
  eq(s.failed, 1); eq(s.confirmable, false)
  ok(s.text.indexOf('游戏内校验不通过') >= 0, '应有「不通过」')
  ok(s.text.indexOf('上海-拉萨') >= 0, '应带机型/注册名')
  ok(s.text.indexOf('周五第2段') >= 0, '应带位置')
})
t('多架都挂 → 各架用「；」隔开，每架最多 2 条', () => {
  const s = summarizeGameCheck([
    { id: 'a', reg: 'A', ok: true, confirmable: false, hasHardError: true, issues: [
      { type: 'error', text: 'e1', where: '周一第1段' }, { type: 'error', text: 'e2', where: '周一第2段' }, { type: 'error', text: 'e3', where: '周一第3段' }] },
    { id: 'b', reg: 'B', ok: true, confirmable: false, hasHardError: true, issues: [{ type: 'error', text: 'e4' }] },
  ])
  ok(s.text.indexOf('A：e1（周一第1段），e2（周一第2段）；B：e4') >= 0, '实际：' + s.text)
  ok(s.text.indexOf('e3') < 0, '第三条应被截掉')
})

console.log('== 4. 软警告（通过但可能晚点）==')
t('partial → verdict=partial，confirmable=true', () => {
  const s = summarizeGameCheck(normalizeGameItems([
    { id: 'a', reg: 'A', ok: true, passed: false, partial: true, confirmable: true, hasSoftWarning: true,
      issues: [{ day: 2, seg: 0, type: 'warning', text: '晚点预警：不符合机场最小起飞间隔' }] },
  ]))
  eq(s.verdict, 'partial'); eq(s.confirmable, true); eq(s.partial, 1)
  ok(s.text.indexOf('通过但可能晚点') >= 0)
  ok(s.text.indexOf('周三第1段') >= 0)
})
t('硬错误优先于软警告（同批有 fail 就报 fail）', () => {
  const s = summarizeGameCheck([
    { id: 'a', reg: 'A', ok: true, confirmable: false, hasHardError: true, issues: [{ type: 'error', text: 'e1' }] },
    { id: 'b', reg: 'B', ok: true, partial: true, confirmable: true, hasSoftWarning: true, issues: [{ type: 'warning', text: 'w1' }] },
  ])
  eq(s.verdict, 'fail'); eq(s.failed, 1); eq(s.partial, 1)
})

console.log('== 5. 空排班 / 全空 ==')
t('没排班的混进来 → 文案补「另有 N 架没有排班」', () => {
  const s = summarizeGameCheck(normalizeGameItems([
    { id: 'a', reg: 'A', ok: true, passed: true, confirmable: true, issues: [] },
    { id: 'b', ok: false, reason: '时刻表是空的' },
  ]))
  eq(s.verdict, 'pass'); eq(s.checked, 1)
  ok(s.text.indexOf('另有 1 架没有排班') >= 0, '实际：' + s.text)
})
t('全部没排班 → skip', () => {
  const s = summarizeGameCheck([{ id: 'b', ok: false, reason: '时刻表是空的' }])
  eq(s.verdict, 'skip')
  ok(s.text.indexOf('没有可校验的排班') >= 0)
})
t('空数组 → skip 不崩', () => {
  eq(summarizeGameCheck([]).verdict, 'skip')
  eq(summarizeGameCheck(null).verdict, 'skip')
})
t('GAME_DAY_NAMES 7 天', () => eq(GAME_DAY_NAMES.length, 7))

console.log('== 6. 分批（eval 100ms 硬上限）==')
t('48 架 → 6 批 × 8 架', () => {
  const ids = Array.from({ length: 48 }, (_, i) => 'ac_' + i)
  const ch = chunkIds(ids, 8)
  eq(ch.length, 6)
  eq(ch[0].length, 8)
  eq(ch[5][7], 'ac_47')
})
t('末批不足也保留', () => {
  const ch = chunkIds(['a', 'b', 'c'], 8)
  eq(ch.length, 1)
  eq(ch[0].length, 3)
})
t('空/单值/去脏值', () => {
  eq(chunkIds([]), [])
  eq(chunkIds('a'), [['a']])
  eq(chunkIds([null, '', 'a', undefined, ' b ']), [['a', 'b']])
})
t('size 兜底为≥1，不会死循环', () => {
  eq(chunkIds(['a', 'b'], 0).length, 2)
  eq(chunkIds(['a', 'b'], -5).length, 2)
})

console.log('')
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
