// 离线算法测试：只吃 test/fixtures/*.json（页面侧表达式抓下来的快照），不需要游戏、不需要 CDP。
//
// 用法：
//   node test/plan.test.mjs                 跑 fixtures 里已有的部分；缺的自动跳过
//   node test/dump.mjs buy                   （游戏开着时）抓新快照到 fixtures/
//
// 断言全部是「与存档无关的不变量」，换局/换存档重抓快照后仍然成立。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buyPlan, routePlan, healthReport, boardView, fuelCapacityCost, cityOf, buildRenamePlan, fuelPlan, fuelUpgradeSteps, expandPlan, sopChecks, bestCabin, profitPlan, routeDevPlan, deployCost } from '../lib/plan.js'
import { planFleet } from '../lib/sched.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FX = path.join(HERE, 'fixtures')
let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 240) : '')) }
}
const load = (n) => {
  const p = path.join(FX, n + '.json')
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null }
}
const skip = (n) => console.log('  · 缺 fixtures/' + n + '.json，跳过（游戏开着时跑 node test/dump.mjs ' + n + '）')

console.log('== 1. 油库扩容阶梯（纯函数）==')
// <500万 → +50万/1000万；500万–2000万 → +100万/2500万；≥2000万 → +200万/6000万
ok(fuelCapacityCost(0, 500000) === 1000, '满库 0 加 50 万升 = 1,000 万')
ok(fuelCapacityCost(0, 1000000) === 2000, '满库 0 加 100 万升 = 2,000 万（两档 50 万）')
ok(fuelCapacityCost(12e6, 1e6) === 2500, '满库 1,200 万升再加 100 万升 = 2,500 万')
ok(fuelCapacityCost(25e6, 2e6) === 6000, '满库 2,500 万升再加 200 万升 = 6,000 万')
ok(fuelCapacityCost(12e6, 0) === 0, '不需要扩容时花费 0')
ok(fuelCapacityCost(12e6, 3.2e6) > fuelCapacityCost(12e6, 1e6), '加得越多越贵（单调）')

console.log('== 1.5 按城市改名（纯函数）==')
ok(cityOf('上海浦东') === '上海', '上海浦东 → 上海', cityOf('上海浦东'))
ok(cityOf('北京首都') === '北京', '北京首都 → 北京', cityOf('北京首都'))
ok(cityOf('拉萨贡嘎') === '拉萨', '拉萨贡嘎 → 拉萨', cityOf('拉萨贡嘎'))
ok(cityOf('乌鲁木齐天山') === '乌鲁木齐', '3 字城市：乌鲁木齐天山 → 乌鲁木齐', cityOf('乌鲁木齐天山'))
ok(cityOf('东京羽田机场') === '东京', '东京羽田机场 → 东京', cityOf('东京羽田机场'))
ok(cityOf('首尔仁川国际机场') === '首尔', '首尔仁川国际机场 → 首尔', cityOf('首尔仁川国际机场'))
{
  const plan = buildRenamePlan([
    { id: 'a', reg: 'X-001', model: 'B737', totalLegs: 9, legs: [{ from: '上海浦东', to: '北京首都', n: 5 }, { from: '北京首都', to: '上海浦东', n: 4 }] },
    { id: 'b', reg: 'X-002', model: 'B737', totalLegs: 8, legs: [{ from: '上海浦东', to: '北京首都', n: 8 }] },
    { id: 'c', reg: 'X-003', model: 'C909', totalLegs: 0, legs: [] },
  ])
  ok(plan.rows[0].name === '上海-北京②', '同一城市对第一架加 ②', plan.rows[0].name)
  ok(plan.rows[1].name === '上海-北京③', '同一城市对第二架加 ③', plan.rows[1].name)
  ok(plan.rows[2].name === null && plan.skipped.length === 1, '闲置机不改名', plan.rows[2])
  ok(plan.changed === 2, 'changed 只算真正改名的', plan.changed)
  ok(plan.rows[0].cities.join('|') === '上海|北京', '城市对顺序按航线', plan.rows[0].cities)
}


console.log('== 1.6 维修窗口（排班）==')
{
  const state = {
    aircraft: [{ id: 'a1', reg: 'T-1', base: 'A', seats: 180, wide: false, legs: 0, first: null, last: null, routeIds: [], model: 'X' }],
    routes: [{ id: 'r1', from: 'A', to: 'B', km: 1200, demand: 3000 }, { id: 'r2', from: 'B', to: 'A', km: 1200, demand: 3000 }],
    ft: { r1: 100, r2: 100 }, need: { A: 40, B: 40 }, occ: [[], [], [], [], [], [], []], routeSeats: {}, money: 1000,
  }
  const plan = (maint) => planFleet(state, { aircraftIds: ['a1'], routeId: 'r1', turn: 60, maxLegs: 8, firstMin: 5, lastArr: 1390, maintenance: maint }).plans[0]
  const chainOk = (p) => { let pos = 'A'; for (const l of p.detail) { if (l.from !== pos) return false; pos = l.to } return true }

  const night = plan({ mode: 'night', need: 180 })
  ok(night.maint && night.maint.mode === 'night', '夜间模式标注 maint', night.maint)
  ok((1440 - night.last + night.first) >= 180, '夜间模式：末班到次日首班 ≥180 分', 1440 - night.last + night.first)
  ok(chainOk(night), '夜间模式：机场位置连续')

  const day = plan({ mode: 'day', need: 180, dayStart: 600 })
  ok(day.maint && day.maint.mode === 'day' && day.maint.start === 600 && day.maint.end === 780, '白天模式留出 600–780 窗口', day.maint)
  const inWindow = day.detail.filter((l) => l.arr > 600 && l.dep < 780)
  ok(inWindow.length === 0, '白天窗口内没有航班', inWindow)
  ok(chainOk(day), '白天模式：机场位置连续（跳段不破链）')
  ok(day.legs <= night.legs, '白天模式段数不再被砍（顺延而不是删段）', { day: day.legs, night: night.legs })

  const none = plan(null)
  ok(none.maint === null, '不预留：没有 maint', none.maint)
}

console.log('== 1.7 维修位闸门（排班四查 C1/C3）==')
{
  const mkState = (maint) => ({
    aircraft: [{ id: 'a1', reg: 'T-1', base: 'A', seats: 180, wide: false, legs: 0, first: null, last: null, routeIds: [], model: 'X' }],
    routes: [{ id: 'r1', from: 'A', to: 'B', km: 1200, demand: 3000 }, { id: 'r2', from: 'B', to: 'A', km: 1200, demand: 3000 }],
    ft: { r1: 100, r2: 100 }, need: { A: 40, B: 40 }, occ: [[], [], [], [], [], [], []], routeSeats: {}, money: 1000, maint,
  })
  const base = (st, opts) => planFleet(st, Object.assign({ aircraftIds: ['a1'], routeId: 'r1', turn: 60, maxLegs: 10, firstMin: 5, lastArr: 1390 }, opts)).plans[0]

  // A 有维修位、B 没有 → 必须回 A 过夜（偶数段），不能停在 B
  const p1 = base(mkState({ A: 2, B: 0 }), {})
  ok(p1.ok === true, 'A 有维修位 → 可排', p1.reason)
  ok(p1.legs % 2 === 0, '段数为偶数 → 末段飞回 A 过夜', p1.legs)
  ok(p1.nightAirport === 'A' && p1.maintAtNight === 2, '夜停机场 = A（维修位 2）', { night: p1.nightAirport, slots: p1.maintAtNight })

  // 允许外站过夜 → 可以停在 B（奇数段）
  const p2 = base(mkState({ A: 2, B: 0 }), { requireMaint: false })
  ok(p2.ok === true, 'requireMaint=false 时放行', p2.reason)

  // 两端都没维修位 → 拒排，并说明原因
  const p3 = base(mkState({ A: 0, B: 0 }), {})
  ok(p3.ok === false && /没有维修位/.test(String(p3.reason || '')), '两端都没维修位 → 拒排并给原因', p3.reason)
  ok(p3.needMaint === 'A' || p3.needMaint === 'B', '拒排时带 needMaint（指出哪个机场）', p3.needMaint)

  // 没有 maint 数据（旧存档）→ 不拦（向后兼容）
  const p4 = base(mkState(null), {})
  ok(p4.ok === true, '没有维修位数据时不阻断（向后兼容）', p4.reason)
}

console.log('== 1.8 起飞城市（startAt）与「不要求停在端点」==')
{
  const st = (baseAp) => ({
    aircraft: [{ id: 'a1', reg: 'T-1', base: baseAp, seats: 180, wide: false, legs: 0, first: null, last: null, routeIds: [], model: 'X' }],
    routes: [{ id: 'r1', from: 'A', to: 'B', km: 1200, demand: 3000 }, { id: 'r2', from: 'B', to: 'A', km: 1200, demand: 3000 }],
    ft: { r1: 100, r2: 100 }, need: { A: 40, B: 40 }, occ: [[], [], [], [], [], [], []], routeSeats: {}, money: 1000, maint: { A: 2, B: 2 },
  })
  const run = (baseAp, startAt) => planFleet(st(baseAp), { aircraftIds: ['a1'], routeId: 'r1', turn: 60, maxLegs: 6, firstMin: 5, lastArr: 1390, startAt }).plans[0]

  const pA = run('C', 'A')
  ok(pA.ok === true, '飞机停在 C（不在航线两端）+ startAt=A → 仍可排（跟手动排班一致）', pA.reason)
  ok(pA.detail[0].from === 'A', '首段从 A 起飞', pA.detail[0])
  ok(pA.detail.every((l) => l.from === 'A' || l.from === 'B'), '所有航段只在 A/B 之间', pA.detail.map((l) => l.from))
  ok(pA.detail[0].rid === 'r1', '从 A 起飞用 A→B 的航线 id', pA.detail[0].rid)

  const pB = run('C', 'B')
  ok(pB.ok === true && pB.detail[0].from === 'B', 'startAt=B → 首段从 B 起飞', pB.detail[0])
  ok(pB.detail[0].rid === 'r2', '从 B 起飞用 B→A 的航线 id（方向修好了）', pB.detail[0].rid)

  // 不传 startAt：仍按飞机自己的机场（旧行为）
  const pNone = run('A', null)
  ok(pNone.ok === true && pNone.detail[0].from === 'A', '不传 startAt → 从飞机所在机场起飞', pNone.detail[0])
}

console.log('== 1.9 利用率上限（长航线 2 个往返）==')
{
  // 上海浦东↔乌鲁木齐 3312km，单程 265 分：4 段 = 1060 分 = 73.6%
  const st = {
    aircraft: [{ id: 'a1', reg: 'T-1', base: 'A', seats: 180, wide: false, legs: 0, first: null, last: null, routeIds: [], model: 'X' }],
    routes: [{ id: 'r1', from: 'A', to: 'B', km: 3312, demand: 2000 }, { id: 'r2', from: 'B', to: 'A', km: 3312, demand: 2000 }],
    ft: { r1: 265, r2: 265 }, need: { A: 20, B: 40 }, occ: [[], [], [], [], [], [], []], routeSeats: {}, money: 1000, maint: { A: 2, B: 0 },
  }
  const run = (maxUtil, requireMaint, requireReturn) => planFleet(st, { aircraftIds: ['a1'], routeId: 'r1', turn: 60, maxLegs: 10, firstMin: 5, lastArr: 1390, maxUtil, requireMaint, requireReturn, startAt: 'A' }).plans[0]

  // 旧口径（显式允许奇数段）下，利用率闸门怎么砍段
  const old70 = run(0.7, false, false)
  ok(old70.ok && old70.legs === 3, '显式 requireReturn:false → 利用率 70% 砍成 3 段（旧行为）', old70.legs)
  // 现行口径：一天必须偶数段（默认 requireReturn:true，用户 2026-10-20 指令）
  const p70 = run(0.7, true)
  const p85 = run(0.85, true)
  ok(p70.ok && p70.legs === 2, '偶数段 + 利用率 70% → 2 段（4 段 73.6% 超限、3 段是奇数不排）', p70.legs)
  ok(p85.ok && p85.legs === 4, '偶数段 + 利用率 85% → 4 段（2 个往返）', p85.legs)
  const ftSum = p85.detail.reduce((t, l) => t + l.ft, 0)
  ok(Math.abs(ftSum / 1440 - 0.736) < 0.02, '4 段飞行 1060 分 ≈ 73.6% 利用率', ftSum)
  ok(p85.detail[0].from === 'A' && p85.detail[3].to === 'A', '4 段回到起点（首段 A 起飞、末段回 A）', p85.detail.map((l) => l.from + '→' + l.to))

  // 严格维修位：4 段回到 A（有维修位）→ 允许；若 maxLegs 只给 3 段，末段落在 B（无维修位）→ 拒
  const strict3 = planFleet(st, { aircraftIds: ['a1'], routeId: 'r1', turn: 60, maxLegs: 3, firstMin: 5, lastArr: 1390, maxUtil: 0.85, requireMaint: true, startAt: 'A' }).plans[0]
  ok(strict3.ok === true && strict3.legs === 2, '严格模式 + 最多 3 段 → 自动退到 2 段（偶数、回 A 过夜）', { legs: strict3.legs, night: strict3.nightAirport })
  ok(strict3.nightAirport === 'A' && strict3.maintAtNight === 2, '严格模式夜停落在有维修位的 A', { night: strict3.nightAirport, slots: strict3.maintAtNight })
  const loose3 = planFleet(st, { aircraftIds: ['a1'], routeId: 'r1', turn: 60, maxLegs: 3, firstMin: 5, lastArr: 1390, maxUtil: 0.85, requireMaint: false, requireReturn: false, startAt: 'A' }).plans[0]
  ok(loose3.ok === true && loose3.legs === 3, '显式 requireReturn:false → 3 段可排（旧行为）', loose3.legs)
}

console.log('== 1.9b 一端没有维修位：偶数段回不来 → 不排（乌鲁木齐-上海 的真实情况）==')
{
  // A = 乌鲁木齐天山（维修位 0）、B = 上海浦东（维修位 4），单程 265 分
  const mk = (maint) => ({
    aircraft: [{ id: 'a1', reg: 'T-1', base: 'A', seats: 180, wide: false, legs: 0, first: null, last: null, routeIds: [], model: 'X' }],
    routes: [{ id: 'r1', from: 'A', to: 'B', km: 3312, demand: 2000 }, { id: 'r2', from: 'B', to: 'A', km: 3312, demand: 2000 }],
    ft: { r1: 265, r2: 265 }, need: { A: 40, B: 40 }, occ: [[], [], [], [], [], [], []], routeSeats: {}, money: 1000, maint,
  })
  const stDead = mk({ A: 0, B: 4 })
  const opts = (extra) => Object.assign({ aircraftIds: ['a1'], routeId: 'r1', turn: 60, maxLegs: 10, firstMin: 5, lastArr: 1390, maxUtil: 0.85, requireMaint: true, maintenance: { mode: 'night', need: 180 } }, extra)

  const dead = planFleet(stDead, opts({ startAt: 'A' })).plans[0]
  ok(dead.ok === false && dead.oddOnly === 3, '从没维修位的一端起飞 → 偶数段回不来，只剩 3 段（奇数）被拒', { ok: dead.ok, oddOnly: dead.oddOnly })
  ok(/偶数段/.test(String(dead.reason || '')), '报错说清「一天必须偶数段」并给改法', dead.reason)
  ok(dead.oddNightAt === 'B', '并指出奇数段会停在外站 B', dead.oddNightAt)

  const fromB = planFleet(stDead, opts({ startAt: 'B' })).plans[0]
  ok(fromB.ok === true && fromB.legs % 2 === 0 && fromB.nightAirport === 'B', '换有维修位的一端起飞 → 偶数段可排、夜里回 B', { legs: fromB.legs, night: fromB.nightAirport })

  const odd = planFleet(stDead, opts({ startAt: 'A', requireMaint: false, requireReturn: false, maxUtil: 0.7, maxLegs: 3 })).plans[0]
  ok(odd.ok === true && odd.legs === 3, '显式 requireReturn:false + requireMaint:false + 段数上限 3 → 才能排 3 段', odd.legs)
}

console.log('== 1.10 白天维修窗口必须落在有维修位的机场 ==')
{
  const mk = (maint) => ({
    aircraft: [{ id: 'a1', reg: 'T-1', base: 'A', seats: 180, wide: false, legs: 0, first: null, last: null, routeIds: [], model: 'X' }],
    routes: [{ id: 'r1', from: 'A', to: 'B', km: 1200, demand: 3000 }, { id: 'r2', from: 'B', to: 'A', km: 1200, demand: 3000 }],
    ft: { r1: 100, r2: 100 }, need: { A: 40, B: 40 }, occ: [[], [], [], [], [], [], []], routeSeats: {}, money: 1000, maint,
  })
  const run = (maint, requireMaint) => planFleet(mk(maint), {
    aircraftIds: ['a1'], routeId: 'r1', turn: 60, maxLegs: 8, firstMin: 5, lastArr: 1390,
    maintenance: { mode: 'day', need: 180, dayStart: 600 }, requireMaint, requireReturn: true, startAt: 'A',
  }).plans[0]

  // B 没维修位：白天窗口只能落在 A
  const p1 = run({ A: 2, B: 0 }, true)
  ok(p1.ok === false || (p1.maint && p1.maint.mode === 'day' && p1.maint.at === 'A'), '白天窗口只落在有维修位的 A（B 有 0 个位）', p1.maint || p1.reason)

  // 两端都没维修位：严格模式必须排不下
  const p2 = run({ A: 0, B: 0 }, true)
  ok(p2.ok === false && /没有维修位/.test(String(p2.reason || '')), '两端都无维修位 → 白天模式拒排', p2.reason)

  // 放行模式：能排（窗口照样留，但不再拦）
  const p3 = run({ A: 0, B: 0 }, false)
  ok(p3.ok === true, '放行模式 → 白天模式可排', p3.reason)
}

console.log('== 1.10b 航时按机型巡航速度 + 白天窗口只留 180 分（B757 北京-上海 实测）==')
{
  // 引擎实测：flightTime = round(km / cruiseSpeed * 60)
  //   B757-200 850km/h → 1100km = 78 分；B737 MAX 8 750 → 88 分；C909 700 → 94 分
  const mk = (cruise, ftMap) => ({
    aircraft: [{ id: 'a1', reg: 'T-1', base: 'PEK', seats: 200, wide: false, legs: 0, first: null, last: null, routeIds: [], model: 'B757-200', cruise, health: 100 }],
    routes: [{ id: 'r1', from: 'PEK', to: 'PVG', km: 1100, demand: 5000 }, { id: 'r2', from: 'PVG', to: 'PEK', km: 1100, demand: 5000 }],
    ft: ftMap, need: { PEK: 40, PVG: 20 }, occ: [[], [], [], [], [], [], []], routeSeats: {}, money: 1000, maint: { PEK: 0, PVG: 2 },
  })
  const opts = {
    aircraftIds: ['a1'], routeId: 'r1', turn: 60, maxLegs: 10, firstMin: 5, lastArr: 1390,
    maintenance: { mode: 'day', need: 180, dayStart: 600 }, requireMaint: true, requireReturn: true, startAt: 'PEK', maxUtil: 0.7,
  }
  // 旧代码把「probe 飞机」的航时套给所有机型（实测 state.ft 给的是 88 分）
  const p = planFleet(mk(850, { r1: 88, r2: 88 }), opts).plans[0]
  ok(p.ok === true && p.detail[0].ft === 78, '航时按本机巡航速度现算（850km/h → 78 分），不采信 state.ft 的 88', p.detail[0])
  ok(p.detail.every((l) => l.ft === 78), '每一段都用 78 分', p.detail.map((l) => l.ft))
  ok(p.legs === 8, '北京-上海 一天排 8 段（旧逻辑只能排 6 段，用户手排也是 8 段）', p.legs)
  let maxGap = 0
  for (let i = 1; i < p.detail.length; i++) maxGap = Math.max(maxGap, p.detail[i].dep - p.detail[i - 1].arr)
  ok(maxGap >= 180 && maxGap <= 240, '白天维修空档 ≈180 分（旧逻辑白等到 13:00 起飞 → 300+ 分）', maxGap)
  ok(p.maint && p.maint.at === 'PVG', '维修窗口落在有维修位的 PVG（不是 0 位的 PEK）', p.maint)

  // 没有巡航速度（旧数据/测试桩）→ 退回 state.ft，保持向后兼容
  const legacy = planFleet(mk(null, { r1: 100, r2: 100 }), opts).plans[0]
  ok(legacy.ok === true && legacy.detail[0].ft === 100, '没有巡航速度时退回 state.ft（向后兼容）', legacy.detail[0])
}

console.log('== 1.11 维修位负载上限（四查 C2：机数 ≤ 维修位×3）==')
{
  const mk = () => ({
    aircraft: [{ id: 'a1', reg: 'T-1', base: 'A', seats: 180, wide: false, legs: 0, first: null, last: null, routeIds: [], model: 'X', health: 80 }],
    routes: [{ id: 'r1', from: 'A', to: 'B', km: 1200, demand: 3000 }, { id: 'r2', from: 'B', to: 'A', km: 1200, demand: 3000 }],
    ft: { r1: 100, r2: 100 }, need: { A: 40, B: 40 }, occ: [[], [], [], [], [], [], []], routeSeats: {}, money: 1000, maint: { A: 2, B: 2 },
  })
  const run = (cap, load) => planFleet(mk(), {
    aircraftIds: ['a1'], routeId: 'r1', turn: 60, maxLegs: 6, firstMin: 5, lastArr: 1390,
    requireMaint: true, requireReturn: true, startAt: 'A', maintenance: { mode: 'night', need: 180 },
    maintCap: cap, maintLoad: load,
  }).plans[0]

  // A 有 2 个维修位：夜间只能停 2 架维修
  const p1 = run({ A: 2, B: 2 }, { A: 2, B: 0 })
  ok(p1.ok === false && /排满/.test(String(p1.reason || '')), 'A 夜间已满（2 架 / 2 个维修位）→ 拒排并说明排满', p1.reason)

  const p2 = run({ A: 2, B: 2 }, { A: 1, B: 0 })
  ok(p2.ok === true, 'A 还有 1 个空位（1 架 / 2 位）→ 可排', p2.reason)

  // 白天走第二个班次：2 个位 = 上限 4
  const runDay = (load) => planFleet(mk(), {
    aircraftIds: ['a1'], routeId: 'r1', turn: 60, maxLegs: 6, firstMin: 5, lastArr: 1390,
    requireMaint: true, requireReturn: true, startAt: 'A', maintenance: { mode: 'day', need: 180, dayStart: 600 },
    maintCap: { A: 2, B: 2 }, maintLoad: { A: load, B: 0 },
  }).plans[0]
  const d1 = runDay(3)
  ok(d1.ok === true, '白天第 4 架（2 位 × 2 班次）仍可排', d1.reason)
  const d2 = runDay(4)
  ok(d2.ok === false || (d2.maint && d2.maint.at === 'B'), '白天第 5 架 → A 已满，改到 B（或排不下）', d2.maint || d2.reason)
}

console.log('== 2. 买机向导 ==')
const buy = load('buy')
if (!buy) skip('buy')
else {
  const r = buyPlan(buy, { limit: 50 })
  ok(r.ok === true, '返回 ok')
  ok(Array.isArray(r.candidates), '返回候选数组', r.totalCandidates)
  ok(r.totalCandidates > 0 || (typeof r.reason === 'string' && r.reason.length > 0), '0 候选时必须给出 reason（新局没有 base 会走到这里）', { n: r.totalCandidates, reason: r.reason })
  const bad = r.candidates.filter((c) =>
    !(c.price > 0) || !(c.totalCost > 0) || c.totalCost > r.budget + 1e-6 ||
    !(c.legsPerDay >= 1 && c.legsPerDay <= 8) || !(c.route.km > 0) ||
    (c.paybackDays != null && !(c.paybackDays > 0)) || !(c.fuel.extraPerDay >= 0))
  ok(bad.length === 0, '候选自洽（价格/预算/段数/航距/回本/耗油）', bad.slice(0, 2))
  const sorted = r.candidates.map((c) => (c.paybackDays == null ? 1e9 : c.paybackDays))
  ok(sorted.every((v, i) => i === 0 || sorted[i - 1] <= v + 1e-9), '按回本天数升序')
  ok(r.candidates.every((c) => c.fuel.daysAfter == null || c.fuel.daysAfter >= 0), '油库可用天数非负')
  ok(r.assumptions && r.assumptions.litersPerKm > 0, '假设里有实测升/公里', r.assumptions && r.assumptions.litersPerKm)
  ok((r.blocked || []).every((b) => typeof b.reason === 'string'), 'blocked 都带原因')
  ok((r.byModel || []).every((b) => b.model && b.base), 'byModel 每项有机型与基地')
  const neg = r.candidates.filter((c) => c.dailyNet <= 0).length
  console.log('    · 候选 ' + r.totalCandidates + ' 条，其中日净利 ≤0 的 ' + neg + ' 条（有 warnings 提示）')
}

console.log('== 3. 开线向导 ==')
const route = load('route')
if (!route) skip('route')
else {
  const r = routePlan(route, { limit: 50 })
  ok(r.ok === true, '返回 ok')
  ok(r.matched >= 0 && Array.isArray(r.candidates), '有候选结构', r.matched)
  const minKm = 200
  const city = (n) => (String(n || '').match(/^[\u4e00-\u9fa5]{2,3}/) || [String(n).slice(0, 2)])[0]
  const bad = r.candidates.filter((c) =>
    c.km < minKm || city(c.from) === city(c.to) ||
    !(c.own >= c.threshold) || !(c.createCost >= 0) ||
    (c.serveShare != null && (c.serveShare < 0 || c.serveShare > 1.5)))
  ok(bad.length === 0, '候选自洽（航距/不同城/需求过门槛/开线费/覆盖比）', bad.slice(0, 2))
  ok(r.candidates.every((c) => c.suggestFlightsPerDay >= 2 && c.suggestFlightsPerDay <= 6), '建议班次 2–6')
  ok(r.candidates.every((c) => c.suggestModel == null || c.suggestSeats > 0), '建议机型带座位数')
  const s = r.candidates.map((c) => c.own)
  ok(s.every((v, i) => i === 0 || s[i - 1] >= v), '按需求降序')
}

console.log('== 4. 排班体检 ==')
const health = load('health')
if (!health) skip('health')
else {
  const r = healthReport(health, { limit: 999 })
  ok(r.ok === (r.critical === 0), 'ok 与 critical 一致', { ok: r.ok, critical: r.critical })
  ok(r.critical === r.summary.overflow + r.summary.badGap + r.summary.belowGround, '红线只由 夜停超容/间隔违反/过站低于硬下限 组成', r.summary)
  ok(r.summary.idle === r.idle.length && r.summary.underused === r.underused.length, '闲置/欠排计数与列表一致（limit 够大）', r.summary)
  ok(Array.isArray(r.advice) && r.advice.every((a) => typeof a === 'string'), '建议是可读字符串')
  ok(r.fleet === (health.aircraft || []).length, '机队数与页面一致')
  const legs = (health.aircraft || []).filter((a) => a.util > 0).length
  ok(r.baseline && r.baseline.util >= 0, '有队内中位数基线', r.baseline)
  console.log('    · 有排班的飞机 ' + legs + ' 架，中位利用率 ' + r.baseline.util)
}

console.log('== 4b. 调机卡在 temp_waiting / 游戏被暂停 → 红线 ==')
{
  // 2026-10-20 实测：北京-上海 B757 的 ferryState 卡在 {active:true, phase:'temp_waiting', tempSchedule:[]}
  // → 引擎 processWaitingDepartures 每次都 cancelAircraftDepartureDelay() + setPaused(true)，两天没起飞
  const mkAc = (ferry) => ({
    id: 'a1', reg: 'T-1', status: 'parked', curAirport: '北京首都', firstFrom: '北京首都',
    legs: 8, util: 0.43, blockMin: 624, turnWant: 60, first: 0, last: 1144, health: 100,
    nightTo: '北京首都', maintAtNight: 0, routes: 2, ferry,
  })
  const base = (ac, paused) => ({
    ok: true, date: '2027-01-02', fleet: 1, legsDay0: 8, groundTurn: 50, paused,
    aircraft: [ac], airports: [], gaps: {}, issues: [], maintSlots: {},
    money: 749, reputation: 21, routes: 6, delay: { med: 0, sev: 0 },
    fuel: { remaining: 1e6, capacity: 1e6, price: 7, consumedYesterday: 0 }, alerts: [],
  })
  const stuck = { active: true, phase: 'temp_waiting', _departed: false, tempSchedule: [] }
  const r1 = healthReport(base(mkAc(stuck), false), { limit: 99 })
  ok(r1.summary.stuckFerry === 1 && r1.ok === false, 'phase=temp_waiting + 空临时时刻表 → 判为调机卡死红线', r1.summary)
  const r2 = healthReport(base(mkAc(Object.assign({}, stuck, { tempSchedule: [{ routeId: 'r1' }] })), false), { limit: 99 })
  ok(r2.summary.stuckFerry === 0, '有临时时刻表时不误报（确实在等临时航班）', r2.summary.stuckFerry)
  const r3 = healthReport(base(mkAc({ active: true, phase: 'positioned' }), false), { limit: 99 })
  ok(r3.summary.stuckFerry === 0, 'phase=positioned 不报', r3.summary.stuckFerry)
  const r4 = healthReport(base(mkAc({ active: false, phase: 'positioned' }), true), { limit: 99 })
  ok(r4.paused === true && r4.ok === false && r4.critical === 1, '游戏暂停 → 红线（时间不动、所有航班都不起飞）', { paused: r4.paused, critical: r4.critical })
  ok(typeof r4.pausedHint === 'string' && /暂停/.test(r4.pausedHint), '暂停时给可读提示', r4.pausedHint)
  const r5 = healthReport(base(mkAc({ active: false, phase: 'positioned' }), false), { limit: 99 })
  ok(r5.paused === false && r5.pausedHint === null, '没暂停时不给提示', r5.pausedHint)
}

console.log('== 5. 日贡献看板 ==')
const board = load('board')
if (!board) skip('board')
else {
  const r = boardView(board, { days: 14, limit: 50 })
  ok(r.ok === true, '返回 ok')
  ok(r.trend.length <= 14, '趋势不超过窗口', r.trend.length)
  if (r.costMix.length) {
    ok(r.costMix.some((x) => x.item === '收入') && r.costMix.some((x) => x.item === '油费'), '成本结构含收入与油费', r.costMix.map((x) => x.item))
    ok(r.costMix.filter((x) => x.item !== '收入').every((x) => x.value <= 0), '支出项为负')
  } else {
    ok(r.avgNet === null, '开局第 1 天没有成本结构时 avgNet 为 null', r.avgNet)
  }
  ok(r.avgNet === null || typeof r.avgNet === 'number', '日均净利为数字或 null', r.avgNet)
  ok(r.routes.weak.every((w) => w.flags && w.flags.length > 0), '弱航线都带标记')
  ok(r.fuel.days == null || r.fuel.days >= 0, '油量天数非负')
  ok(r.trend.every((t) => t.net == null || Number.isFinite(t.net)), '每日净利可算')
  console.log('    · ' + r.date + ' 今日收入 ' + (r.today || {}).revenue + ' 万 · 日均净利 ' + r.avgNet + ' 万 · 弱航线 ' + r.routes.weak.length + ' 条')
}

console.log('== 6. 油库向导（纯函数）==')
{
  // 阶梯：0 → 50 万升 1 步；4.9M → 6.4M 走「50 万 + 100 万」两档
  const s1 = fuelUpgradeSteps(0, 500000)
  ok(s1.length === 1 && s1[0].cost === 1000 && s1[0].capAfter === 500000, '0 → 50 万升：1 步 1,000 万', s1)
  const s2 = fuelUpgradeSteps(4.9e6, 6e6)
  ok(s2.length === 2 && s2[0].cost === 1000 && s2[1].cost === 2500, '4.9M → 6M：50 万档 + 100 万档', s2.map((x) => x.cost))
  ok(fuelUpgradeSteps(1e6, 1e6).length === 0, '已达标不产生扩容步')

  // 规则（报告/客座率修复:100-115）：触发 max(3 天, 30% 库容)、目标 max(4 天, 95% 库容)、≤5 元加满
  const f1 = fuelPlan({ ok: true, price: 6, capacity: 1e6, fuel: 5e5, perDay: 250000, consumedYesterday: 250000, cash: 10000 })
  ok(f1.ok && f1.targetCapacity === 1e6, '容量目标 = 日耗 × 4 天', f1.targetCapacity)
  ok(f1.upgrade.steps.length === 0 && f1.upgrade.cost === 0, '容量 4 天够用，不扩容', f1.upgrade)
  ok(f1.refill.triggerLiters === 750000, '触发线 = max(3 天, 30% 库容) = 75 万升', f1.refill.triggerLiters)
  ok(f1.refill.liters === 500000, '补到 max(4 天, 95% 库容) = 100 万 − 已有 50 万', f1.refill)
  ok(f1.totalCost === 300, '补油花费 50 万升 × 6 元 = 300 万', f1.totalCost)
  ok(f1.fuelDays === 2 && f1.capacityDays === 4, '可飞/满库天数按实耗算', { f: f1.fuelDays, c: f1.capacityDays })

  // 没跌到触发线：不补（避免高价频繁小额买入）
  const notTrig = fuelPlan({ ok: true, price: 6, capacity: 1e6, fuel: 9e5, perDay: 2e5, cash: 1e4 })
  ok(notTrig.refill.triggered === false && notTrig.refill.liters === 0, '油 4.5 天 ≥ 触发线 → 不补', notTrig.refill)

  // 容量不足：真需求 2 步（60 → 110 → 160 万升）；现金 500 万一步都执行不了
  const f2 = fuelPlan({ ok: true, price: 6.5, capacity: 6e5, fuel: 1e5, perDay: 3e5, cash: 500 })
  ok(f2.upgrade.steps.length === 2 && f2.upgrade.steps[0].cost === 1000, '容量 2 天 → 真需求扩 2 步（+50 万 ×2）', f2.upgrade.steps)
  ok(f2.upgrade.affordableSteps.length === 0, '现金 500 万时一步都执行不了', f2.upgrade.affordableSteps)
  ok(f2.upgrade.stillShort === true && f2.upgrade.shortCost > 0, '现金不够时会标 stillShort 并给缺口价', f2.upgrade)
  const f2b = fuelPlan({ ok: true, price: 6.5, capacity: 6e5, fuel: 1e5, perDay: 3e5, cash: 5000 })
  ok(f2b.upgrade.affordableSteps.length === 2 && f2b.upgrade.cost === 2000, '现金够时扩 2 步 2,000 万', f2b.upgrade)

  // 油价 ≤5 加满
  const cheap = fuelPlan({ ok: true, price: 4.5, capacity: 1e6, fuel: 2e5, perDay: 2e5, cash: 1e4 })
  ok(cheap.refill.liters === 8e5 && /加满/.test(cheap.refill.reason), '油价 ≤5：加满', cheap.refill)
  // 油价 >7 且高于 7 日均价 → 只补到触发线 +0.5 天（不追高）
  const hold = fuelPlan({
    ok: true, price: 8, capacity: 1e6, fuel: 3e5, perDay: 2e5, cash: 1e4,
    priceHistory: [{ price: 5 }, { price: 5 }, { price: 5 }, { price: 5 }, { price: 5 }, { price: 5 }, { price: 5 }],
  })
  ok(hold.refill.liters === 4e5 && hold.priceBand === 'hold', '油价 8 元高于均价 5 元 → 只补到 3 天 +0.5 天', hold.refill)
  ok(cheap.priceBand === 'cheap' && f1.priceBand === 'normal', '油价档位标注', { cheap: cheap.priceBand, hold: hold.priceBand, normal: f1.priceBand })

  // 断油兜底：库存 <1 天 → 忽略价格，先补到 3 天
  const emergency = fuelPlan({ ok: true, price: 9, capacity: 1e6, fuel: 1e5, perDay: 2e5, cash: 1e4, priceHistory: [{ price: 5 }] })
  ok(/断油兜底/.test(emergency.refill.reason) && emergency.refill.liters >= 6e5, '库存 0.5 天 → 断油兜底补到 3 天', emergency.refill)

  // 现金不够：补油量按现金裁剪，差额进 shortfall，总额永远付得起（运营垫设 0，专测裁剪）
  const tight = fuelPlan({ ok: true, price: 6, capacity: 1e6, fuel: 1e5, perDay: 3e5, cash: 60 }, { cashFloor: 0 })
  ok(tight.refill.wantLiters === 9e5 && tight.refill.liters === 1e5, '容量封顶 90 万升，现金 60 万只够买 10 万升', tight.refill)
  ok(tight.refill.shortfall === 8e5, 'shortfall 记下差 80 万升', tight.refill.shortfall)
  ok(tight.totalCost === 60 && tight.cashAfter === 0, '总额按裁剪后算，花光现金不超支', { total: tight.totalCost, after: tight.cashAfter })
  ok(tight.refill.affordable === false, 'affordable 仍如实标 false（提示现金紧张）', tight.refill.affordable)

  // 运营垫：现金 800 万以下不再花钱（断油除外）
  const floorTest = fuelPlan({ ok: true, price: 6, capacity: 1e6, fuel: 5e5, perDay: 3e5, cash: 900 })
  ok(floorTest.spendable === 100 && floorTest.refill.liters <= Math.floor(100 * 10000 / 6), '现金 900 万 → 只花超出 800 万运营垫的 100 万', { spendable: floorTest.spendable, liters: floorTest.refill.liters })
  ok(floorTest.cashAfter >= 800, '花完仍不少于运营垫', floorTest.cashAfter)

  // 空局（还没在飞航班）：日耗 0 → 不补油、不给"几天"
  const empty = fuelPlan({ ok: true, price: 7, capacity: 1e6, fuel: 1e6, perDay: 0, cash: 1500 })
  ok(empty.refill.triggered === false && empty.refill.liters === 0, '日耗 0 的新局：不补油', empty.refill)
  ok(empty.refill.triggerLiters === 0 && empty.refill.wantDays === null, '日耗 0：触发线与天数都为 0/null', { t: empty.refill.triggerLiters, d: empty.refill.wantDays })

  ok(fuelPlan({ ok: false, reason: 'x' }).ok === false, '页面数据失败时直接透传失败')
}

console.log('== 7. 扩张流水线（纯函数）==')
{
  const status = {
    date: '2027-01-04', cash: 1000, fleet: 6, routes: 12, legsPerDay: 31,
    delays: { medium: 0, severe: 0 }, fuel: { days: 1.9, capacity: 1e6, perDay: 260000 },
  }
  const fuel = {
    ok: true, fuelDays: 1.9, capacityDays: 3.8, targetDays: 3, targetCapacity: 780000, capacity: 1e6,
    refill: { liters: 250000, cost: 160, wantDays: 3, affordable: true },
    upgrade: { steps: [], cost: 0, capAfter: 1e6, stillShort: false },
  }
  const health = { ok: true, critical: 0, summary: { idle: 1, underused: 0, overflow: 0, badGap: 0, belowGround: 0, earlyLast: 3 } }
  const route = {
    ok: true, matched: 2, candidates: [
      { from: '上海浦东', to: '深圳宝安', km: 1200, own: 3000, createCostRound: 40, suggestModel: 'B737-800', suggestFlightsPerDay: 3 },
      { from: '上海浦东', to: '成都天府', km: 1660, own: 2200, createCostRound: 35, suggestModel: 'A320neo', suggestFlightsPerDay: 3 },
    ],
  }
  const buy = { ok: true, totalCandidates: 1, blocked: [], candidates: [{ model: 'B757-200', seats: 195, base: '上海浦东', price: 500, dailyNet: 20, paybackDays: 20 }] }
  const r = expandPlan({ status, fuel, health, route, buy }, { maxRoutes: 2, maxAircraft: 1, reserve: 0 })
  ok(r.ok === true, '返回 ok')
  const kinds = r.steps.map((s) => s.kind)
  ok(kinds[0] === 'sched', '第一步是排班（零成本先吃满运力）', kinds)
  ok(kinds.includes('refuel') && kinds.indexOf('refuel') < kinds.indexOf('route'), '补油排在开线之前', kinds)
  ok(kinds.indexOf('route') < kinds.lastIndexOf('aircraft'), '开线排在买机之前', kinds)
  ok(r.summary.plannedCost === 160 + 40 + 35 + 500, '计划花费 = 补油 + 两条线 + 一架机', r.summary.plannedCost)
  ok(r.summary.cashAfter === 1000 - r.summary.plannedCost, '剩余现金自洽', r.summary.cashAfter)
  ok(r.steps.every((s) => s.tool && s.title), '每步都有工具与标题')

  const squeeze = expandPlan({ status, fuel, health, route, buy }, { maxRoutes: 1, maxAircraft: 1 })
  ok(squeeze.steps.filter((s) => s.kind === 'route').length === 1, 'maxRoutes 限制开线条数', squeeze.steps.filter((s) => s.kind === 'route').length)

  const poor = expandPlan({ status: { ...status, cash: 50 }, fuel, health, route, buy }, {})
  ok(poor.steps.filter((s) => s.kind === 'aircraft').every((s) => s.ready === false || s.cost === 0), '现金不够时买机标为不可执行', poor.steps.filter((s) => s.kind === 'aircraft'))

  const danger = expandPlan({
    status: { ...status, delays: { medium: 2, severe: 1 } },
    fuel, health: { ...health, summary: { ...health.summary, overflow: 1 }, overflow: [{ name: '上海浦东', parked: 31, parkedCap: 30 }] },
    route, buy,
  }, {})
  ok(danger.blockers.length >= 2, '夜停超容 + 严重延误都进 blockers', danger.blockers)
  ok(danger.blockers.some((b) => b.indexOf('夜停超容') >= 0), 'blocker 里点名夜停超容', danger.blockers)
  ok(expandPlan({ status: {} }).ok === false, '缺盘面字段时返回失败')
}

console.log('== 8. 购机质量闸门（纯函数）==')
{
  const mkBuy = (over = {}) => Object.assign({
    ok: true, dayIndex: 10, money: 10000,
    fuel: { remaining: 1e6, capacity: 1e6, price: 6, consumedYesterday: 2e5, consumedToday: 2e5 },
    fleet: { count: 6, legsDay0: 30, kmDay0: 30000, fcAvg: 4.8, avgKmPerLeg: 1000, seatAvg: 160, lf7: 0.95, aircraftByRoute: {} },
    models: [{ name: 'B757-200', seats: 175, range: 7000, cruiseSpeed: 800, fuelConsumption: 4.2, isWideBody: false, price: 800, quote: { totalPrice: 96 }, eq: { version: 1 }, caps: { supported: true } }],
    bases: [{ name: '上海浦东', level: 'base3', hangarLeft: 10, hangarCap: 10, parkedNow: 2, parkedCap: 10 }],
    routes: [{ id: 'r1', from: '上海浦东', to: '广州白云', km: 1200, demand: 3000, remaining: 2000, seatsWeek: 0, flightsWeek: 0, wk: null, fromLevel: 'base3', toLevel: 'normal', toIntl: false }],
    cost: null,
  }, over)

  const okCase = buyPlan(mkBuy(), {})
  ok(okCase.gateReason === null && okCase.candidates.length === 1, 'LF 95% + Day10 → 放行', { gate: okCase.gateReason, n: okCase.candidates.length })
  ok(okCase.candidates[0].ready === true, '候选标 ready', okCase.candidates[0].ready)

  const lfCase = buyPlan(mkBuy({ fleet: { ...mkBuy().fleet, lf7: 0.8 } }), {})
  ok(lfCase.gateReason === null && lfCase.candidates.length === 1, 'LF 80% 不再冻结购机（客座率闸门已按用户要求移除）', lfCase.gateReason)
  ok(lfCase.gates && lfCase.gates.lf && lfCase.gates.lf.warn === true && lfCase.gates.lf.blocked === false, 'LF 80% 仍给警告但不再拦', lfCase.gates && lfCase.gates.lf)

  // 阶段闸门（Day0–3 不买机）已按用户要求移除：Day2 也应当放行
  const phaseCase = buyPlan(mkBuy({ dayIndex: 2 }), {})
  ok(phaseCase.gateReason === null && phaseCase.candidates.length === 1, 'Day2 不再冻结购机（阶段闸门已移除）', phaseCase.gateReason)

  const parkCase = buyPlan(mkBuy({ bases: [{ name: '上海浦东', level: 'base3', hangarLeft: 10, hangarCap: 10, parkedNow: 9, parkedCap: 10 }] }), {})
  ok(parkCase.candidates.length === 0 && parkCase.blocked.some((b) => /驻场/.test(b.reason)), '驻场已 9/10 → 不允许再加（85% 上限）', parkCase.blocked)

  const routeFull = buyPlan(mkBuy({ fleet: { ...mkBuy().fleet, aircraftByRoute: { r1: 2 } } }), {})
  ok(routeFull.candidates.length === 0 && routeFull.blocked.some((b) => /投满 2 架/.test(b.reason)), '单航线对已 2 架 → 不再加', routeFull.blocked)

  const black = buyPlan(mkBuy({ models: [{ ...mkBuy().models[0], name: 'B767-300ER' }] }), {})
  ok(black.candidates.length === 0 && black.blocked.some((b) => /黑名单/.test(b.reason)), '黑名单机型被挡', black.blocked)

  const batch = buyPlan(mkBuy(), { count: 3 })
  ok(batch.candidates.length === 0 || batch.candidates[0].totalCost > batch.candidates[0].price * 3 * 0.99, '批量总价 > 单价×3（等比级数）', batch.candidates[0] && { total: batch.candidates[0].totalCost, unit: batch.candidates[0].price })
}

console.log('== 9. 五项校验（纯函数）==')
{
  const mkHealth = (over = {}) => Object.assign({
    ok: true, date: '2027-01-04', fleet: 6, routes: 12, money: 3000, points: 12,
    aircraft: [
      { reg: 'A-1', health: 95, legs: 6, minStop: 60, faultStatus: 'none', faultResolved: false, maintenanceStatus: 'none', inspectionStatus: 'none', todayMaxDelay: 0 },
    ],
    airports: [], gaps: {}, delay: { med: 0, sev: 0 }, fuel: { remaining: 5e5, capacity: 1e6, price: 6, consumedYesterday: 2e5 }, alerts: [],
  }, over)
  const good = sopChecks(mkHealth(), null)
  ok(good.exitCode === 0 && good.red.length === 0, '干净盘面 → 0 红线', good.red)

  const ghost = sopChecks(mkHealth({ aircraft: [{ reg: 'A-1', health: 95, legs: 0, minStop: null, faultStatus: 'level1', faultResolved: true, maintenanceStatus: 'none', inspectionStatus: 'none', todayMaxDelay: 0 }] }), null)
  ok(ghost.red.some((x) => /幽灵故障/.test(x)), 'faultResolved 但 faultStatus≠none → 幽灵故障红线', ghost.red)

  const lowHealth = sopChecks(mkHealth({ aircraft: [{ reg: 'A-1', health: 80, legs: 6, minStop: 60, faultStatus: 'none', faultResolved: false, maintenanceStatus: 'none', inspectionStatus: 'none', todayMaxDelay: 0 }] }), null)
  ok(lowHealth.red.some((x) => /健康 <85%/.test(x)), '健康 <85 且未进维修队列 → 红线', lowHealth.red)

  const severe = sopChecks(mkHealth({ aircraft: [{ reg: 'A-1', health: 95, legs: 6, minStop: 60, faultStatus: 'none', faultResolved: false, maintenanceStatus: 'none', inspectionStatus: 'none', todayMaxDelay: 200 }] }), null)
  ok(severe.red.some((x) => /单班最大延误 200/.test(x)), '单班 200 分 → 真实严重延误红线', severe.red)

  const engineOnly = sopChecks(mkHealth({ delay: { med: 0, sev: 3 } }), null)
  ok(engineOnly.info.some((x) => /全场总和/.test(x)) && !engineOnly.red.some((x) => /严延/.test(x)), '引擎记严延但单班很低 → 只提示口径放大，不判红', engineOnly.info)

  const fuelRed = sopChecks(mkHealth({ fuel: { remaining: 1e5, capacity: 1e6, price: 6, consumedYesterday: 2e5 } }), null)
  ok(fuelRed.red.some((x) => /燃油仅够/.test(x)), '燃油 <1 天 → 红线', fuelRed.red)

  const cashLow = sopChecks(mkHealth({ money: 500 }), null)
  ok(cashLow.red.some((x) => /运营垫/.test(x)), '现金 <800 万 → 红线', cashLow.red)

  const prev = { delay: { med: 0, sev: 0 }, fleet: 6, routes: 12, points: 12 }
  const idle = sopChecks(mkHealth({ money: 3000 }), prev)
  ok(idle.red.some((x) => /现金滞留/.test(x)), '现金 >1500 万且当日无投放 → 现金滞留红线', idle.red)

  const invested = sopChecks(mkHealth({ money: 3000, fleet: 7 }), prev)
  ok(!invested.red.some((x) => /现金滞留/.test(x)), '机队变了 → 不算滞留', invested.red)

  const alert = sopChecks(mkHealth({ alerts: [{ id: 'load', title: '连续低客座率', items: [{ severity: 'critical', title: '浦东→广州 3 天 <60%', reason: '客座率 55%' }] }] }), null)
  ok(alert.red.some((x) => /连续低客座率/.test(x)), '运营预警 critical → 红线', alert.red)
}

console.log('== 10. 配舱：基础价系数与 Y 兜底 ==')
{
  const cab = bestCabin({ seats: 180, legs: 4, demand: { F: 40, J: 120, S: 160, Y: 900 }, fares: { F: 2, J: 2, S: 1.05, Y: 0.45 } })
  ok(cab.spaceValue.F > cab.spaceValue.J && cab.spaceValue.J > cab.spaceValue.S && cab.spaceValue.S > cab.spaceValue.Y, '每空间收益序 F>J>S>Y（含基础价系数）', cab.spaceValue)
  ok(cab.layout.F > 0, 'F 舱不会被挤成 0 座', cab.layout)
  ok(cab.layout.Y >= cab.minY, 'Y 至少 minY 座', { y: cab.layout.Y, min: cab.minY })

  const noY = bestCabin({ seats: 120, legs: 2, demand: { F: 60, J: 200, S: 300, Y: 0 }, fares: { F: 2, J: 2, S: 1.05, Y: 0.45 }, minY: 12 })
  ok(noY.layout.Y >= 12, 'Y 需求为 0 时也强制留 12 座兜底', noY.layout)
}

console.log('== 11. 利润最大化：票价倍率与配舱（体检）==')
{
  const mkProfit = (routeOver = {}, acOver = {}, fareOver = null) => ({
    ok: true, reputation: 50, basePerKm: 0.77,
    coeff: { F: 10, J: 4, S: 1.7, Y: 1 }, space: { F: 6, J: 3, S: 1.5, Y: 1 }, money: 3000,
    routes: [Object.assign({
      id: 'r1', from: 'A', to: 'B', km: 1100,
      fare: Object.assign({ F: 2, J: 2, S: 1.05, Y: 0.45 }, fareOver || {}),
      routeRep: 80,
      demandByCabin: { F: 40, J: 160, S: 200, Y: 2000 },
      poolByCabin: { F: 40, J: 160, S: 200, Y: 2000 },
      legsWeek: 28, flights: [{ acId: 'ac1', legs: 28, transfer: 1 }], lfActual: 0.85,
      weekly: { flights: 28, seats: 230 * 28, passengers: 0, revenue: 0 },
    }, routeOver)],
    aircraft: [Object.assign({
      id: 'ac1', reg: 'A-B', model: 'B757-200', modelSeats: 230, wide: false, pitch: 79, catering: 'premium',
      health: 100, demandFactor: 1.03, seatCapacity: 230,
      layout: { F: 7, J: 32, S: 44, Y: 26 }, idle: false, routes: [{ rid: 'r1', legs: 28 }],
    }, acOver)],
  })

  const p = profitPlan(mkProfit(), { minLF: 0.62 })
  ok(p.ok === true && p.routes.length === 1 && p.aircraft.length === 1, 'profitPlan 返回航线级 + 飞机级计划', { r: p.routes.length, a: p.aircraft.length })
  ok(p.revDayNow > 0 && p.revDayWant >= p.revDayNow - 1e-6, '不会把收入改差（安全阀）', { now: p.revDayNow, want: p.revDayWant })

  // Y=0.45 时弹性系数被 1.8 截断 → 涨价在客流未饱和前是纯赚
  const cheap = profitPlan(mkProfit({}, {}, { Y: 0.45 }), { minLF: 0.5 })
  ok(cheap.routes[0].fareWant.Y > cheap.routes[0].fareNow.Y, 'Y=0.45 被"1.8 倍截断"抬成低票价 → 建议涨价', cheap.routes[0].fareWant)
  ok(cheap.routes[0].gain > 0, '涨价方案确实增收', cheap.routes[0].gain)

  // 票价已经很高（1.6）→ 高弹性（1.5）会把 Y 压回来
  const pricey = profitPlan(mkProfit({}, {}, { Y: 1.6 }), { minLF: 0.5 })
  ok(pricey.routes[0].fareWant.Y < 1.6, 'Y=1.6 太贵 → 建议降价（e=1.5 时收入随价升而降）', pricey.routes[0].fareWant)

  // 客座率下限：给一个下限很高、需求不够的航线，票价不能为了涨价把客座率砸到报警线下
  const lowDemand = profitPlan(mkProfit({ demandByCabin: { F: 4, J: 10, S: 12, Y: 40 }, poolByCabin: { F: 4, J: 10, S: 12, Y: 40 } }), { minLF: 0.62 })
  ok(lowDemand.routes[0].lfWant >= lowDemand.routes[0].lfNow - 1e-6,
    '需求本身撑不起客座率时：可以改价，但客座率不许改差', { lfNow: lowDemand.routes[0].lfNow, lfWant: lowDemand.routes[0].lfWant })

  // 配舱：Y 底座不破、空间不超容、F/J/S 不越需求饱和
  const ac = p.aircraft[0]
  const used = ac.layoutWant.F * 6 + ac.layoutWant.J * 3 + ac.layoutWant.S * 1.5 + ac.layoutWant.Y
  ok(ac.layoutWant.Y >= 12, '配舱保留 Y 底座 ≥12 座', ac.layoutWant)
  ok(used <= ac.cap + 0.001, '配舱占座不超机舱容量', { used, cap: ac.cap })
  ok(ac.lfWant >= 0.62 - 1e-6 || !ac.layoutChanged, '配舱改完客座率不跌破下限（否则退回原配舱）', { lf: ac.lfWant, changed: ac.layoutChanged })

  // 空局（没排班 / 没需求）→ 不动
  const empty = profitPlan(mkProfit({ demandByCabin: { F: 0, J: 0, S: 0, Y: 0 }, poolByCabin: { F: 0, J: 0, S: 0, Y: 0 } }), { minLF: 0.62 })
  ok(empty.aircraft[0].layoutChanged === false, '没有分舱需求数据 → 配舱保持原样', empty.aircraft[0].layoutWant)
}

console.log('\n== 12. 航线开发：某机场最值得开的 5 条线 + 每条能养几架 ==')
{
  const mkDev = (rows) => ({
    ok: true, froms: ['上海浦东'], unlocked: ['china', 'eastAsia'],
    modelName: 'B757-200', model: { name: 'B757-200', seats: 230, range: 7222, cruiseSpeed: 850 },
    pitch: 71, seatCap: 255, coeff: { F: 10, J: 4, S: 1.7, Y: 1 }, space: { F: 6, J: 3, S: 1.5, Y: 1 },
    basePerKm: 0.77, reputation: 40.8, money: 2000, rows: rows
  })
  const row = (over) => Object.assign({
    from: '上海浦东', to: '兰州中川', km: 1779, level: 'normal', intl: false, region: 'china',
    demand: 1420, own: 1420, byCabin: { F: 17, J: 78, S: 113, Y: 1212 },
    exists: false, rid: null, fareNow: null, routeRep: 60, flightTime: 126, createCost: 17.79,
    needFrom: 40, needTo: 40, parkCapFrom: 100, parkCapTo: 5, parkedFrom: 5, parkedTo: 0, acCount: 0, segWeek: 0
  }, over || {})
  const data = mkDev([
    row({ to: '乌鲁木齐天山', km: 3312, byCabin: { F: 18, J: 77, S: 109, Y: 976 }, exists: true, rid: 'rt_w', createCost: null, acCount: 0 }),
    row({}),
    row({ to: '昆明长水', km: 1965, byCabin: { F: 23, J: 106, S: 149, Y: 1536 }, exists: true, rid: 'rt_k', createCost: null, acCount: 3 }),
    row({ to: '空需求机场', km: 900, byCabin: { F: 0, J: 0, S: 0, Y: 0 }, exists: false, createCost: 5 })
  ])
  const r = routeDevPlan(data, { top: 5 })
  ok(r.ok === true && r.kind === 'route-dev', '航线开发返回 ok + kind', r.kind)
  ok(r.top.length === 4, '候选不足 5 条时全给', r.top.length)
  ok(r.top.every((t) => t.legs % 2 === 0 && t.legs >= 2), '一天段数一律偶数段且 ≥2', r.top.map((t) => t.legs))
  ok(r.top.every((t) => t.seats === 255), '单机座位按 71cm 算 = 255', r.top.map((t) => t.seats))
  const long = r.top.find((t) => t.to === '乌鲁木齐天山')
  ok(long.ftMin === 234, '航时按本机 850km/h 算（3312km → 234 分，不是时刻表里的 265）', long.ftMin)
  ok(long.legs === 2, '3312km 一天只能排 2 段（4 段放不进 05:00–23:15）', long)
  ok(long.layout.Y >= 12, '配舱保留 Y 底座 ≥12 座', long.layout)
  const used = long.layout.F * 6 + long.layout.J * 3 + long.layout.S * 1.5 + long.layout.Y
  ok(used <= 255 + 0.001, '配舱占座不超机舱容量', { used })
  ok(long.capacityAircraft >= 1 && long.canAdd === long.capacityAircraft - long.acCount, '可养架数 ≥1，还能加 = 可养 − 已有', { cap: long.capacityAircraft, add: long.canAdd })
  const newLine = r.top.find((t) => t.to === '兰州中川')
  ok(newLine.exists === false && newLine.createCost === 17.79, '新线带开线费', newLine.createCost)
  ok(newLine.paybackDays >= 1 && newLine.paybackDays === Math.max(1, Math.round(17.79 / newLine.revPerPlane)), '新线回本天数 = 开线费 ÷ 单架日收入', { days: newLine.paybackDays, rev: newLine.revPerPlane })
  ok(newLine.mults.F === 2 && newLine.mults.J === 2, 'F/J 倍率固定 2.0（弹性<1，顶上限最赚）', newLine.mults)
  ok(newLine.mults.Y >= 0.6 && newLine.mults.Y <= 2, 'Y 倍率在引擎取值范围内', newLine.mults.Y)
  const full = r.top.find((t) => t.to === '昆明长水')
  ok(full.acCount === 3 && full.canAdd === 0, '已有飞机吃满的线 → 还能加 0', { ac: full.acCount, add: full.canAdd })
  ok(/吃满/.test(full.note || ''), '吃满的线要说明别再加', full.note)
  const noDemand = r.top.find((t) => t.to === '空需求机场')
  ok(noDemand.revPerPlane === 0 && noDemand.canAdd === 0, '没有需求数据的线 → 收入 0 不可加', noDemand)
  const sc = r.top.map((t) => t.score || 0)
  ok(sc.every((v, i) => i === 0 || sc[i - 1] + 1e-9 >= v), '按「单架日收入 × 有无扩容空间」降序', sc)

  // 期望：输入异常时给原因，不抛
  const bad = routeDevPlan({ ok: false, reason: '机场不在已开通区域' })
  ok(bad.ok === false && /已开通区域/.test(bad.reason), '页面数据不可用 → 透传原因', bad.reason)
  const empty = routeDevPlan(mkDev([]))
  ok(empty.ok === false && /没有候选/.test(empty.reason), '没有候选 → 明确说没有候选', empty.reason)
}

console.log('== 12. 一键部署：买机 + 开线 成本估算 ==')
{
  const unit = 745.2 + 162.45 + 52.8
  const one = deployCost({ modelPrice: 745.2, equipmentPrice: 162.45, cabinCost: 52.8, createCost: 33.2, directions: 2, count: 1, money: 2000 })
  ok(Math.abs(one.unit - unit) < 0.01, '单价 = 机体 + 装备 + 改舱', one.unit)
  ok(Math.abs(one.createCost - 66.4) < 0.01, '开线费按「缺的方向」累加（双向 ×2）', one.createCost)
  ok(Math.abs(one.total - (unit + 66.4)) < 0.01, '1 架总价 = 单价 + 开线费', one.total)
  ok(one.canAfford === true && one.after > 0, '现金够 → canAfford 且算出余额', one)

  const two = deployCost({ modelPrice: 745.2, equipmentPrice: 162.45, cabinCost: 52.8, createCost: 33.2, directions: 2, count: 2, money: 5000 })
  ok(Math.abs(two.buyTotal - unit * 2.015) < 0.01, '2 架按等比级数 ×2.015（不是单价 ×2）', two.buyTotal)

  const dup = deployCost({ modelPrice: 745.2, equipmentPrice: 162.45, cabinCost: 0, createCost: 33.2, directions: 0 })
  ok(dup.createCost === 0 && Math.abs(dup.total - (745.2 + 162.45)) < 0.01, '两个方向都已存在 → 不收开线费', dup)

  const oneDir = deployCost({ modelPrice: 100, createCost: 33.2, both: false })
  ok(oneDir.directions === 1 && Math.abs(oneDir.createCost - 33.2) < 0.01, 'both=false → 只算单向开线费', oneDir)

  const poor = deployCost({ modelPrice: 900, createCost: 33.2, directions: 2, count: 1, money: 500, cashFloor: 800 })
  ok(poor.canAfford === false, '现金不够 → canAfford false', poor.money)
  ok(poor.underFloor === true, '花完低于运营垫 → underFloor 提示', poor.after)
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
