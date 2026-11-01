// 纯函数规划器（v0.3）：买机向导 / 开线向导 / 排班体检 / 日贡献看板
//
// 设计原则：
//   - 只吃页面侧表达式返回的 JSON（lib/expr.js 的 BUY_EXPR / routeExpr / HEALTH_EXPR / boardExpr）
//   - 不访问网络、不读文件、不依赖存档结构 → 可以直接在 Node 里单测
//   - 所有阈值来自「实测数据 + 本仓铁律」，并把假设写回结果（assumptions），方便 agent 复核

const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d)
const r2 = (x, n = 2) => (x == null || !Number.isFinite(Number(x)) ? null : Number(Number(x).toFixed(n)))
const clamp = (x, a, b) => Math.min(b, Math.max(a, x))
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0)
const median = (arr) => {
  const a = arr.filter((x) => Number.isFinite(x)).slice().sort((x, y) => x - y)
  if (!a.length) return null
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}
// 「同城」判断与「按城市命名」共用 cityOf（定义在文件末尾的 7) 节，函数声明会提升）

// 硬件改装黑名单：永远不能改发动机 / 小翼 / WiFi / PTV（`capabilities.supported=false`）。
// 出处：报告/租赁与自购对比（含硬件改装限制）.md:131、报告/座椅间距与发动机硬件优化分析.md:100-115
export const BLACKLIST_MODELS = ['B767-300ER', 'C909', 'A319', 'Yak-42', 'ATR 72', 'ATR72', 'CRJ', 'MD-8', 'MD-9', 'MD-1', 'Tu-204', 'Dash 8']
export function isBlacklistedModel(name) {
  return BLACKLIST_MODELS.some((t) => String(name).toUpperCase().indexOf(t.toUpperCase()) >= 0)
}

// ---------------------------------------------------------------------------
// 1) 买机向导
// ---------------------------------------------------------------------------
// 输入：BUY_EXPR 的返回；opts = { budget, reserve, model, base, count, maxLegs,
//   firstMin, lastArr, turn, minKmPerLeg, fillFuelDays, limit }
//
// 推演模型（写回 assumptions，方便复核）：
//   每段收入 = 航线实测「每班收入」× (新机座位 / 该航线每班已排座位)
//            （航线无实测周统计时，退回「全队每段收入 × 航距比 × 座位比」）
//   每段成本 = 油（实测升/公里 × 机型油耗系数 × 油价）+ 餐食/维修（按座位比）
//   每天段数 = floor(可用时间窗 / (2×航时 + 2×过站))，上限 maxLegs
//   回本天数 = 全包价 / 日净利
export function buyPlan(data, opts = {}) {
  if (!data || !data.ok) return { ok: false, reason: (data && data.reason) || '页面数据不可用' }
  const firstMin = num(opts.firstMin, 5)
  const lastArr = num(opts.lastArr, 1390)
  const maxLegs = num(opts.maxLegs, 8)
  const turn = num(opts.turn, 60)
  const fillDays = num(opts.fillFuelDays, 4)
  const count = Math.max(1, Math.floor(num(opts.count, 1)))
  const reserve = num(opts.reserve, 0)
  const money = num(data.money)
  const budget = opts.budget != null ? Math.max(0, num(opts.budget)) : Math.max(0, money - reserve)
  const price = num(data.fuel.price)
  const fuelL = num(data.fuel.remaining)
  const fuelCap = num(data.fuel.capacity)
  const kmDay0 = Math.max(1, num(data.fleet.kmDay0))
  const fcAvg = num(data.fleet.fcAvg, 4.8)
  const avgKmPerLeg = Math.max(200, num(data.fleet.avgKmPerLeg, 1200))
  const seatRef = Math.max(60, num(data.fleet.seatAvg, opts.fleetSeatAvg || 160))
  const fuelPerDay = num(data.fuel.consumedYesterday) || num(data.fuel.consumedToday)
  // 实测每公里耗油（升）：用「昨日实际耗油 / 当日排班总航距」倒推，比固定 6800L/1233km 可靠
  const litersPerKm = fuelPerDay > 0 ? fuelPerDay / kmDay0 : (6800 / 1233) * (fcAvg / 4.8)
  const cost = data.cost || {}
  const perLegRevenue = num(cost.perLegRevenue)
  const perLegCatering = num(cost.perLegCatering)
  const perLegMaint = num(cost.perLegMaint)
  const span = Math.max(120, lastArr - firstMin)

  // ---- 购机质量闸门（报告/重开优化清单.md:38/72/104/211-217/243）----
  // ① 全队 LF <89% 冻结购机（<84% 更要告警）
  // ② 单航线对已投 ≥2 架 → 不再加第 3 架
  // ③ 单机场驻场 > 停机位容量×0.85 → 禁新增归属
  // ④ 机型黑名单（不能改发动机/WiFi/小翼，买来就锁死）
  // 注：「开局 Day0–3 不买机」那条按用户 2026-10-19 要求已移除
  const dayIndex = data.dayIndex == null ? null : num(data.dayIndex)
  const lf7 = data.fleet && data.fleet.lf7 != null ? num(data.fleet.lf7) : null
  const lfMin = num(opts.lfMin, 0.89)
  const lfWarnAt = num(opts.lfWarn, 0.84)
  const parkFill = num(opts.parkFill, 0.85)
  const maxPerRoute = Math.max(1, Math.floor(num(opts.maxPerRoute, 2)))
  const BLACKLIST = BLACKLIST_MODELS
  const isBlack = isBlacklistedModel
  // 客座率闸门取消（用户 2026-10-19）：lf7 只作提示，不再阻止买机
  const lfBlocked = false
  const gates = {
    dayIndex, lf7, lfMin, lfWarnAt, parkFill, maxPerRoute,
    lf: { blocked: false, rule: '客座率仅作提示（闸门已取消）', warn: lf7 != null && lf7 < lfWarnAt },
    blacklist: BLACKLIST,
  }
  const gateReason = lfBlocked
    ? '客座率闸门：全队 LF ' + Math.round(lf7 * 100) + '% < ' + Math.round(lfMin * 100) + '%，先修配舱/票价/健康，不买机'
    : null

  // 航线：补上「每班座位 / 每班收入」，并算出真实缺口
  const routes = (data.routes || []).map((r) => {
    const wk = r.wk || null
    const spfFromWk = wk && wk.flights > 0 ? wk.seats / wk.flights : 0
    const spfFromSch = r.flightsWeek > 0 ? num(r.seatsWeek) / r.flightsWeek : 0
    const seatsPerFlight = spfFromWk || spfFromSch || seatRef
    const revPerFlight = wk && wk.flights > 0 ? wk.revenue / wk.flights : null
    const paxPerDay = wk ? num(wk.passengers) / 7 : 0
    return {
      ...r,
      seatsPerFlight,
      revPerFlight,
      gapPerDay: Math.max(0, num(r.demand) - paxPerDay),
    }
  })

  const models = (data.models || []).filter((m) => {
    if (opts.model) {
      const want = String(opts.model)
      if (m.name !== want && !new RegExp(want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(m.name)) return false
    }
    if (opts.minSeats != null && num(m.seats) < num(opts.minSeats)) return false
    if (opts.maxSeats != null && num(m.seats) > num(opts.maxSeats)) return false
    if (opts.category && m.category !== opts.category) return false
    return true
  })

  const bases = (data.bases || []).filter((b) => {
    if (opts.base) {
      const want = String(opts.base)
      return b.name === want || b.name.includes(want)
    }
    return num(b.hangarLeft) > 0 || /^base/.test(String(b.level))
  })
  // 开局常见状态：机场只有 hub 级（机库 0），根本没法归属飞机 → 直接说清楚
  const noBase = bases.length === 0
  const noBaseHint = noBase
    ? '没有可用基地：所有机场的机库位都是 0（开局只有 hub 级机场）。先把某个机场升到 base3 及以上（`base3` 基础花费 2,000 万，含涨幅），或换一个有 base 的存档再买机。'
    : null

  const assumptions = {
    unit: '万元（现金/收入/成本/花费均为万元）',
    costWindow: cost.days ? `${cost.from} ~ ${cost.to}（${cost.days} 天均值）` : '无已结账日数据（退回全队均值）',
    litersPerKm: r2(litersPerKm, 3),
    fuelPrice: r2(price, 3),
    fleet: { count: num(data.fleet.count), legsDay0: num(data.fleet.legsDay0), kmDay0: Math.round(kmDay0), avgKmPerLeg: Math.round(avgKmPerLeg), fcAvg: r2(fcAvg, 2), seatAvg: seatRef, fuelPerDay: Math.round(fuelPerDay) },
    perLeg: { revenue: r2(perLegRevenue), catering: r2(perLegCatering), maint: r2(perLegMaint) },
    window: { firstMin, lastArr, maxLegs, turn },
    fuelRuleDays: fillDays,
    formula: '收入按航线每班座位缩放；成本=油(实测升/公里×油耗系数×油价)+餐食+维修(按座位比)',
  }

  const candidates = []
  const blocked = []
  // 批量购机总价：每买 1 架全场 ×1.015（前 2 架 1.0×，封顶 31 倍）→ 必须按等比级数累加，
  // 直接「单价×架数」会低估（买 50 架约差 30~50%）。报告/Day89_飞机涨价逻辑源码分析.md:65-72
  const batchCost = (unit, n) => (n <= 1 ? unit * n : unit * (Math.pow(1.015, n) - 1) / 0.015)
  for (const base of bases) {
    // 该基地能飞的航线：从该机场出发或到达（航线双向）；同基地自环排除
    const baseRoutes = routes.filter((r) => (r.from === base.name || r.to === base.name))
    if (!baseRoutes.length) {
      blocked.push({ base: base.name, reason: '该基地没有任何航线（需先开线）' })
      continue
    }
    for (const m of models) {
      const unitPrice = num(m.price) + num(m.quote && m.quote.totalPrice)
      const allIn = batchCost(unitPrice, count)
      const blacklisted = isBlack(m.name)
      if (blacklisted && opts.includeBlacklisted !== true) {
        blocked.push({ model: m.name, base: base.name, reason: '黑名单机型（不能改发动机/WiFi/小翼，买来硬件锁死）' })
        continue
      }
      if (allIn > budget) {
        blocked.push({ model: m.name, base: base.name, reason: '预算不足', need: r2(allIn), budget: r2(budget) })
        continue
      }
      // 机库位不再作为买机前置条件（没机库也能买），只在结果里当提示
      if (base.parkedNow != null && base.parkedCap != null && num(base.parkedNow) + count > num(base.parkedCap) * parkFill) {
        blocked.push({ model: m.name, base: base.name, reason: '驻场会超停机位容量 ' + Math.round(parkFill * 100) + '%', parkedNow: base.parkedNow, parkedCap: base.parkedCap })
        continue
      }
      const acOf = (r) => num((data.fleet && data.fleet.aircraftByRoute || {})[String(r.id)])
      const usable = baseRoutes.filter((r) => (!m.range || num(r.km) <= num(m.range) * 0.92) && num(r.km) >= num(opts.minKmPerLeg, 150) && acOf(r) < maxPerRoute)
      if (!usable.length) {
        blocked.push({ model: m.name, base: base.name, reason: baseRoutes.some((r) => acOf(r) >= maxPerRoute) ? '该基地航程内航线都已投满 ' + maxPerRoute + ' 架（单航线对上限）' : '该基地没有航程内的航线（需先开线）', routes: baseRoutes.length })
        continue
      }
      const fc = num(m.fuelConsumption, fcAvg)
      const fcRatio = fc / Math.max(1, fcAvg)
      const seatRatio = num(m.seats) / seatRef
      // 逐条航线推演，取「日净利」最高的那一条当该机型在本基地的主战航线
      let best = null
      for (const r of usable) {
        const km = num(r.km, avgKmPerLeg)
        const ftMin = Math.round((km / Math.max(300, num(m.cruiseSpeed, 750))) * 60 / 0.85) + 25
        const legs = clamp(Math.floor(span / (2 * ftMin + 2 * turn)), 1, maxLegs)
        const revPerLeg = r.revPerFlight != null
          ? r.revPerFlight * (num(m.seats) / Math.max(1, r.seatsPerFlight))
          : perLegRevenue * (km / avgKmPerLeg) * seatRatio
        const fuelPerLeg = km * litersPerKm * fcRatio * price / 10000
        const otherPerLeg = (perLegCatering + perLegMaint) * seatRatio
        const costPerLeg = fuelPerLeg + otherPerLeg
        const dailyNet = legs * (revPerLeg - costPerLeg)
        if (!best || dailyNet > best.dailyNet) {
          best = { r, km, ftMin, legs, revPerLeg, fuelPerLeg, otherPerLeg, costPerLeg, dailyNet }
        }
      }
      const dailyNet = best.dailyNet
      const paybackDays = dailyNet > 0 ? unitPrice / dailyNet : null
      // 油库铁律：满库要撑 ≥3 天（含新机）
      const extraFuelPerDay = best.legs * 2 * best.km * litersPerKm * fcRatio
      const fleetDailyAfter = fuelPerDay + extraFuelPerDay
      const needCap = fleetDailyAfter * fillDays
      const capAdd = Math.max(0, needCap - fuelCap)
      const capCost = fuelCapacityCost(fuelCap, capAdd)
      candidates.push({
        model: m.name,
        base: base.name,
        baseLevel: base.level,
        seats: num(m.seats),
        wide: !!m.isWideBody,
        range: num(m.range),
        price: r2(unitPrice),
        listPrice: r2(num(m.price)),
        equipment: r2(num(m.quote && m.quote.totalPrice)),
        equipmentDetail: m.eq,
        count,
        totalCost: r2(allIn),
        homeSide: base.name === best.r.from ? 'from' : 'to',
        route: {
          id: best.r.id, from: best.r.from, to: best.r.to, km: best.km,
          demand: num(best.r.demand), gapPerDay: r2(best.r.gapPerDay, 0),
          revPerFlight: r2(best.r.revPerFlight), seatsPerFlight: Math.round(best.r.seatsPerFlight),
        },
        estFtMin: best.ftMin,
        legsPerDay: best.legs,
        revPerLeg: r2(best.revPerLeg),
        costPerLeg: r2(best.costPerLeg),
        fuelPerLeg: r2(best.fuelPerLeg),
        netPerLeg: r2(best.revPerLeg - best.costPerLeg),
        dailyNet: r2(dailyNet),
        monthlyNet: r2(dailyNet * 30, 0),
        affordableCount: unitPrice > 0 ? Math.floor(budget / unitPrice) : null,
        perSeatCost: num(m.seats) > 0 ? r2(unitPrice / num(m.seats), 1) : null,
        aircraftOnRoute: acOf(best.r),
        blacklisted,
        ready: !gateReason,
        blockedBy: gateReason || null,
        batchNote: count > 1 ? '总价按等比级数（每架 ×1.015），不是单价×' + count : null,
        thinSample: !!(best.r.wk && best.r.wk.flights > 0 && best.r.wk.flights < 3),
        paybackDays: r2(paybackDays, 1),
        fleetAfter: num(data.fleet.count) + count,
        fuel: {
          extraPerDay: Math.round(extraFuelPerDay),
          fleetDailyAfter: Math.round(fleetDailyAfter),
          daysAfter: fleetDailyAfter > 0 ? r2(fuelL / fleetDailyAfter, 2) : null,
          needCapacity3d: Math.round(needCap),
          capacityNow: Math.round(fuelCap),
          capacityAdd: Math.round(capAdd),
          capacityCost: r2(capCost),
        },
        warnings: [
          ifThen(num(m.seats) > 300 && !m.isWideBody, '大座级窄体：舒适度吃亏'),
          ifThen(paybackDays != null && paybackDays > 20, '回本天数偏长（>20 天）'),
          ifThen(best.km > num(m.range) * 0.8, '航段接近机型航程上限'),
          ifThen(capAdd > 0 && capCost > budget * 0.2, '需要配套扩容油库'),
          ifThen(!(m.caps && m.caps.supported), '该机型不支持加装装备（只能用标准构型）'),
          ifThen(best.r.wk && best.r.wk.flights > 0 && best.r.wk.flights < 3, '该航线周统计样本少（<3 班），收入估计偏差可能大'),
        ].filter(Boolean),
      })
    }
  }
  candidates.sort((a, b) => {
    const pa = a.paybackDays == null ? 1e9 : a.paybackDays
    const pb = b.paybackDays == null ? 1e9 : b.paybackDays
    if (pa !== pb) return pa - pb
    return b.dailyNet - a.dailyNet
  })
  // 同一条航线会被两端基地各算一遍（航线双向）→ 按 机型+航线 去重，优先保留 base==from 的那条
  const seen = new Map()
  const dedup = []
  for (const c of candidates) {
    const key = c.model + '|' + c.route.id
    const prev = seen.get(key)
    if (!prev) { seen.set(key, c); dedup.push(c) } else if (prev.homeSide === 'to' && c.homeSide === 'from') {
      dedup[dedup.indexOf(prev)] = c
      seen.set(key, c)
    }
  }
  candidates.length = 0
  candidates.push(...dedup)
  // 同一机型可能出现在多个基地：标注「本机型最优基地」
  const bestPerModel = new Map()
  for (const c of candidates) {
    if (!bestPerModel.has(c.model) || num(c.paybackDays) < num(bestPerModel.get(c.model).paybackDays)) bestPerModel.set(c.model, c)
  }
  for (const c of candidates) c.bestBaseForModel = bestPerModel.get(c.model) === c
  const limit = Math.max(1, Math.floor(num(opts.limit, 12)))
  const byModel = [...bestPerModel.values()]
    .sort((a, b) => num(a.paybackDays) - num(b.paybackDays))
    .slice(0, Math.min(20, limit * 2))
    .map((c) => ({ model: c.model, base: c.base, seats: c.seats, price: c.price, dailyNet: c.dailyNet, paybackDays: c.paybackDays, legsPerDay: c.legsPerDay, route: `${c.route.from}→${c.route.to} ${c.route.km}km` }))
  return {
    ok: true,
    kind: 'buy-plan',
    date: data.date,
    money: r2(money),
    budget: r2(budget),
    reserve: r2(reserve),
    count,
    online: !!data.online,
    assumptions,
    gates,
    gateReason,
    candidates: candidates.slice(0, limit).map((c) => { const { ...rest } = c; return rest }),
    byModel,
    totalCandidates: candidates.length,
    blocked: (noBase ? [{ base: '(全部)', reason: noBaseHint }].concat(blocked) : blocked).slice(0, 8),
    reason: candidates.length === 0 ? (noBaseHint || '没有候选：预算/机库位/单航线 2 架上限卡住了，看 blocked') : (gateReason || null),
    note: '只读推演：收入优先用该航线自身周统计并按座位缩放；回本天数 = 全包价 / 日净利（批量按等比级数计价）。质量闸门：全队 LF ≥89%、单航线对 ≤2 架、驻场 ≤容量 85%、机型黑名单。真买之前请先 hjyt_status 看现金。',
  }
}

// 油库扩容阶梯（源码 getFuelUpgradeInfo）：<500万 → +50万/1000万；500万–2000万 → +100万/2500万；≥2000万 → +200万/6000万
export function fuelCapacityCost(capNow, addLiters) {
  let cap = num(capNow)
  let need = Math.max(0, num(addLiters))
  let cost = 0
  let steps = 0
  while (need > 0 && steps < 500) {
    let add, price
    if (cap < 5e6) { add = 5e5; price = 1000 }
    else if (cap < 2e7) { add = 1e6; price = 2500 }
    else { add = 2e6; price = 6000 }
    cap += add
    need -= add
    cost += price
    steps += 1
  }
  return cost
}

// 阶梯明细版：扩容到目标容量要几步、每步多少万（引擎规则同上，纯函数便于单测）
export function fuelUpgradeSteps(capNow, targetCap, maxSteps = 40) {
  const steps = []
  let cap = num(capNow)
  const target = num(targetCap)
  while (cap < target && steps.length < maxSteps) {
    const info = cap < 5e6 ? { add: 5e5, cost: 1000 } : cap < 2e7 ? { add: 1e6, cost: 2500 } : { add: 2e6, cost: 6000 }
    cap += info.add
    steps.push({ add: info.add, cost: info.cost, capAfter: cap })
  }
  return steps
}

// ---------------------------------------------------------------------------
// 1.5) 油库向导：容量（满库 ≥3 天铁律，目标 4 天留头寸）+ 补油（报告实测规则）
// ---------------------------------------------------------------------------
// 规则出处（报告/客座率修复与欧洲枢纽建设报告.md:100-115、报告/每日推进校验规则.md:49-57）：
//   触发线：库存 < max(3 天用量, 库容 30%)
//   目标量：max(4 天用量, 库容 95%)
//   低价加满：油价 ≤5 元/L
//   断油兜底：库存 <1 天 时忽略价格，先补到 3 天
//   本插件追加「不追高」：油价 >7 元且高于 7 日均价 5% 时，只补到触发线 +0.5 天（等回落）
// 输入：FUEL_EXPR 的返回；opts 见下
export function fuelPlan(data, opts = {}) {
  if (!data || !data.ok) return { ok: false, reason: (data && data.reason) || '页面数据不可用' }
  const targetDays = num(opts.targetDays, 4)          // 容量目标（天）——满库 4 天，铁律下限 3 天
  const minDays = num(opts.minDays, 3)                // 铁律红线：满库必须 ≥3 天
  const triggerDays = num(opts.triggerDays, 3)        // 补油触发线（天）
  const triggerPct = num(opts.triggerPct, 0.30)       // 补油触发线（库容占比）
  const targetPct = num(opts.targetPct, 0.95)         // 补油目标（库容占比）
  const cheapPrice = num(opts.cheapPrice, 5)
  const holdPrice = num(opts.holdPrice, 7)
  const holdAbove = num(opts.holdAbove, 1.05)         // 高于 7 日均价 5% 视为"追高"
  const emergencyDays = num(opts.emergencyDays, 1)
  const price = num(data.price)
  const cap0 = num(data.capacity)
  const fuel0 = num(data.fuel)
  const cash = num(data.cash)
  // 日耗优先用引擎记录的「昨日实际耗油」（不受排班变动影响），没有才用排班估算
  const perDayYest = num(data.consumedYesterday)
  const perDayEst = num(data.perDay)
  const perDay = perDayYest > 0 ? perDayYest : perDayEst
  const perDaySource = perDayYest > 0 ? 'yesterday' : 'schedule'
  const fuelDays = perDay > 0 ? r2(fuel0 / perDay) : null
  const capacityDays = perDay > 0 ? r2(cap0 / perDay) : null
  // 运营垫：现金 800 万以下不再花（报告/每日推进校验规则.md:49-54）。断油（<1 天）时破例。
  const cashFloor = num(opts.cashFloor, 800)
  const emergency = fuelDays != null && fuelDays < num(opts.emergencyDays, 1)
  const spendable = emergency ? cash : Math.max(0, cash - cashFloor)
  const targetCapacity = perDay > 0 ? Math.ceil(perDay * Math.max(minDays, targetDays)) : 0

  // 容量阶梯：只扩到「满库 ≥targetDays 天」，不多买（越往上越贵：20/25/30 元一升）
  // steps = 真需求（要扩到目标容量需要几步）；affordableSteps = 现金够、这次真能执行的；
  // 两者分开，才能同时说清「需要多少」和「现在能扩多少」。
  const needAdd = Math.max(0, targetCapacity - cap0)
  const allSteps = fuelUpgradeSteps(cap0, targetCapacity)
  let cashLeft = spendable
  const affordableSteps = []
  for (const st of allSteps) {
    if (st.cost > cashLeft) break
    cashLeft -= st.cost
    affordableSteps.push(st)
  }
  const upgradeCost = sum(affordableSteps, (s) => s.cost)
  const capAfterUpgrade = affordableSteps.length ? affordableSteps[affordableSteps.length - 1].capAfter : cap0
  const upgradeGap = Math.max(0, targetCapacity - capAfterUpgrade)

  // 补油规则（报告实测版）
  const capForFill = capAfterUpgrade
  const room = Math.max(0, capForFill - fuel0)
  // 触发线（升）：需要补到多少才算"脱离危险"（日耗 0 时没有"几天"的概念，按 0 算）
  const triggerLiters = perDay > 0 ? Math.max(triggerDays * perDay, capForFill * triggerPct) : 0
  // 目标量（升）：max(4 天用量, 库容 90%)
  let wantLiters = Math.max(targetDays * perDay, capForFill * targetPct) - fuel0
  let refillReason = '正常补油：补到 max(4 天, 库容 95%)'
  const avg7 = (data.priceHistory || []).length
    ? sum(data.priceHistory.map((h) => num(h.price)), (x) => x) / data.priceHistory.length
    : null
  if (price <= cheapPrice) {
    wantLiters = room
    refillReason = '油价 ≤' + cheapPrice + ' 元：加满'
  } else if (price > holdPrice && avg7 && price > avg7 * holdAbove) {
    wantLiters = Math.max(0, triggerLiters + 0.5 * perDay - fuel0)
    refillReason = '油价 ' + r2(price, 2) + ' 元高于 7 日均价 ' + r2(avg7, 2) + '（>' + Math.round((holdAbove - 1) * 100) + '%）→ 只补到触发线 +0.5 天，等回落'
  }
  if (fuelDays != null && fuelDays < emergencyDays) {
    wantLiters = Math.max(wantLiters, triggerLiters - fuel0)
    refillReason = '⚠ 断油兜底：库存不足 ' + emergencyDays + ' 天，忽略油价先补到 ' + triggerDays + ' 天'
  }
  const triggered = perDay > 0 && (fuelDays == null || fuel0 < triggerLiters)
  if (perDay <= 0) {
    // 新局还没有在飞航班：日耗 0，谈不上"几天"，也不该补油
    wantLiters = 0
    refillReason = '日耗为 0（还没有在飞航班），暂不补油'
  } else if (!triggered) {
    // 还没跌到触发线：不补（报告规则：触发才补，避免高价频繁小额买入）
    wantLiters = 0
    refillReason = '库存 ' + fuelDays + ' 天 ≥ 触发线 ' + r2(triggerLiters / Math.max(1, perDay)) + ' 天，暂不补油'
  }
  const liters = Math.min(room, Math.max(0, wantLiters))
  const refillCost = liters * price / 10000
  // 现金不够就按现金裁剪补油量（宁可少补也别让执行时被引擎拒），差额记在 shortfall
  const affordableLiters = refillCost <= cashLeft ? liters : (price > 0 ? Math.floor((cashLeft * 10000) / price) : 0)
  const refill = {
    triggered,
    liters: Math.round(affordableLiters),
    wantLiters: Math.round(liters),
    shortfall: Math.round(Math.max(0, liters - affordableLiters)),
    triggerLiters: Math.round(triggerLiters),
    targetLiters: Math.round(Math.max(targetDays * perDay, capForFill * targetPct)),
    cost: r2(affordableLiters * price / 10000),
    wantDays: perDay > 0 ? r2((Math.max(targetDays * perDay, capForFill * targetPct)) / perDay, 2) : null,
    reason: refillReason,
    price: r2(price, 4),
    avgPrice7d: avg7 == null ? null : r2(avg7, 3),
    cappedByCapacity: wantLiters > room + 1,
    affordable: refillCost <= cashLeft,
  }

  const totalCost = r2(upgradeCost + (refill.affordable ? refillCost : affordableLiters * price / 10000))
  const actions = []
  if (needAdd > 0) {
    actions.push({
      kind: 'upgrade',
      text: upgradeGap > 0
        ? `油库容量不足：${Math.round(capacityDays * 100) / 100} 天 < ${targetDays} 天，需扩 ${allSteps.length} 步 +${Math.round(needAdd / 10000)} 万升（约 ${r2(fuelCapacityCost(cap0, needAdd))} 万）；现金只够扩 ${affordableSteps.length} 步（还差 ${Math.round(upgradeGap / 10000)} 万升 ≈ ${r2(fuelCapacityCost(capAfterUpgrade, upgradeGap))} 万）`
        : `油库容量 ${Math.round(capacityDays * 100) / 100} 天 < ${targetDays} 天，扩 ${affordableSteps.length} 步 +${Math.round(upgradeCost ? sum(affordableSteps, (s) => s.add) / 10000 : 0)} 万升，花 ${upgradeCost} 万`,
      steps: allSteps,
      affordableSteps,
      cost: upgradeCost,
      capAfter: capAfterUpgrade,
    })
  }
  if (refill.liters > 0) {
    actions.push({
      kind: 'refill',
      text: `油量 ${fuelDays == null ? '未知' : fuelDays + ' 天'}（触发线 ${r2(triggerLiters / Math.max(1, perDay))} 天）→ 补 ${Math.round(refill.liters / 10000)} 万升到 ${r2(refill.targetLiters / Math.max(1, perDay))} 天，花 ${refill.cost} 万；${refill.reason}` + (refill.shortfall > 0 ? `；现金不够，还差 ${Math.round(refill.shortfall / 10000)} 万升` : ''),
      cost: refill.cost,
      affordable: refill.affordable,
    })
  }
  const priceBand = price <= cheapPrice ? 'cheap' : (price > holdPrice && avg7 && price > avg7 * holdAbove) ? 'hold' : 'normal'
  return {
    ok: true,
    kind: 'fuel-plan',
    price: r2(price, 4),
    priceBand,
    cash: r2(cash),
    cashFloor,
    spendable: Math.round(spendable),
    emergency,
    capacity: cap0,
    fuel: Math.round(fuel0),
    perDay: Math.round(perDay),
    perDaySource,
    fuelDays,
    capacityDays,
    targetDays,
    minDays,
    targetCapacity,
    needAdd: Math.round(needAdd),
    upgrade: {
      steps: allSteps,
      affordableSteps,
      cost: upgradeCost,
      capAfter: capAfterUpgrade,
      stillShort: upgradeGap > 0,
      shortCost: upgradeGap > 0 ? fuelCapacityCost(capAfterUpgrade, upgradeGap) : 0,
    },
    refill,
    totalCost,
    cashAfter: r2(cash - upgradeCost - (refill.cost || 0)),
    actions,
    note: '油库规则来自实测报告：触发线 max(3 天, 库容 30%)、目标 max(4 天, 库容 95%)、油价 ≤5 元加满、>7 元且高于 7 日均价不追高、库存 <1 天断油兜底；容量按「满库 ≥' + targetDays + ' 天」扩容（铁律下限 ' + minDays + ' 天）。扩容阶梯：<500 万升 +50 万/1000 万；500 万–2000 万 +100 万/2500 万；≥2000 万 +200 万/6000 万。',
  }
}

// ---------------------------------------------------------------------------
// 1.6) 扩张流水线：把「今天该做什么」排成有序清单
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 1.55) 五项校验（页面侧，按 报告/每日推进校验规则.md）
// ---------------------------------------------------------------------------
// 输入：HEALTH_EXPR 的返回（已含 aircraft 状态 / airports / gaps / fuel / alerts）
//       prev = 上次校验的快照（用于判断"增量"和"当日是否有投放"），没有就只做绝对判定
// 口径要点：
//   - 延误：中/严 看「计数器增量」；真实严重按「单班最大延误 ≥180」
//     （引擎 settleDailyDelays 用的是「全场延误分钟总和」，千班规模必然触发，属口径放大；
//      见 报告/Day188_延误归因与机场升级评估.md:23-26）
//   - 检修：faultResolved=true 且 faultStatus≠none 是幽灵故障（每天空转 1,440 分）
//   - 检测：健康 <85 且没排进维修/检修 → 红线（报告:41-47）
//   - 资金：现金 <800 万运营垫 → 红；>1,500 万且当日无投放 → 红（现金滞留）
//   - 运营预警：getOperationsAlerts 的 critical → 红，其余 → 告警
export function sopChecks(data, prev = null, opts = {}) {
  if (!data || !data.ok) return { ok: false, exitCode: 3, red: ['页面数据不可用'], warn: [], info: [], source: 'page' }
  const cashIdle = num(opts.cashIdle, 1500)
  const cashFloor = num(opts.cashFloor, 800)
  const fuelWarn = num(opts.fuelWarn, 3)
  const fuelRed = num(opts.fuelRed, 1)
  const groundTurn = num(data.groundTurn, 50)
  const red = [], warn = [], info = []
  const acs = (data.aircraft || []).slice()
  const fuel = data.fuel || {}
  const perDay = num(fuel.consumedYesterday) || num(data.perDay) || 0
  const fuelDays = perDay > 0 ? r2(num(fuel.remaining) / perDay, 2) : null
  const price = num(fuel.price)

  // ① 延误
  const maxD = acs.reduce((m, a) => Math.max(m, num(a.todayMaxDelay)), 0)
  const maxRow = acs.find((a) => num(a.todayMaxDelay) === maxD) || null
  const dMed = num(data.delay && data.delay.med)
  const dSev = num(data.delay && data.delay.sev)
  if (prev) {
    if (dMed > num(prev.delay && prev.delay.med)) red.push(`中等延误 +${dMed - num(prev.delay && prev.delay.med)} 天（计数器只增不减，永久扣声誉）`)
    if (dSev > num(prev.delay && prev.delay.sev)) red.push(`严重延误 +${dSev - num(prev.delay && prev.delay.sev)} 天（永久 -0.2 声誉/天）`)
  } else if (dMed || dSev) {
    warn.push(`延误计数 中${dMed}/严${dSev}（没有上次基线，先记下；下次起按增量判红线）`)
  }
  if (maxD >= 180) red.push(`单班最大延误 ${maxD} 分（${maxRow ? maxRow.reg : '?'}）≥180 → 真实严重延误`)
  else if (maxD >= 60) warn.push(`单班最大延误 ${maxD} 分（${maxRow ? maxRow.reg : '?'}）>60，未达 180`)
  if (dSev > 0 && maxD < 180) info.push(`引擎记了 ${dSev} 天严延，但单班最大只有 ${maxD} 分：settleDailyDelays 用「全场总和」对 180，阈值的本意是单架（报告/Day188:23-26）`)
  const gaps = Object.entries(data.gaps || {}).filter(([, g]) => g && g.ok === false)
  if (gaps.length) red.push(`机场起飞间隔违规：${gaps.map(([ap, g]) => ap + ' 最紧 ' + g.min + '/' + g.req).join('、')}`)
  const over = (data.airports || []).filter((a) => num(a.over) > 0)
  if (over.length) red.push(`夜停超容：${over.map((a) => a.name + ' ' + a.parked + '/' + a.parkedCap).join('、')}`)
  const below = acs.filter((a) => a.minStop != null && num(a.minStop) < groundTurn)
  if (below.length) red.push(`过站低于引擎硬下限 ${groundTurn} 分：${below.map((a) => a.reg).join('、')}`)

  // ② 检修
  const ghost = acs.filter((a) => a.faultResolved && a.faultStatus && a.faultStatus !== 'none')
  if (ghost.length) red.push(`幽灵故障（已修复但标志未清，每天空转 1,440 分）：${ghost.map((a) => a.reg + '(' + a.faultStatus + ')').join('、')}`)
  const faulty = acs.filter((a) => a.faultStatus && a.faultStatus !== 'none' && !a.faultResolved)
  if (faulty.length) red.push(`故障未处理：${faulty.map((a) => a.reg + '(' + a.faultStatus + ')').join('、')}`)
  const maintStuck = acs.filter((a) => a.maintenanceStatus === 'in_progress' && num(a.legs) === 0)
  if (maintStuck.length) warn.push(`维修中且当日 0 班（连续 2 日视为卡死）：${maintStuck.map((a) => a.reg).join('、')}`)

  // ③ 检测
  const lowNoInsp = acs.filter((a) => num(a.health) < 85 && a.inspectionStatus === 'none' && a.maintenanceStatus === 'none')
  if (lowNoInsp.length) red.push(`健康 <85% 且没进维修/检修队列：${lowNoInsp.map((a) => a.reg + ' ' + a.health.toFixed(1) + '%').join('、')}`)
  const low90 = acs.filter((a) => num(a.health) >= 85 && num(a.health) < 90)
  if (low90.length) warn.push(`健康 <90%：${low90.map((a) => a.reg + ' ' + a.health.toFixed(1) + '%').join('、')}`)
  const inspAlert = (data.alerts || []).find((g) => g.id === 'inspection')
  if (inspAlert && (inspAlert.items || []).length) warn.push(`运营预警·即将检修：${(inspAlert.items || []).map((it) => it.title).join('、')}`)

  // ④ 资金
  if (num(data.money) < cashFloor) red.push(`现金 ${r2(data.money)} 万 < 运营垫 ${cashFloor} 万（油款风险）`)
  if (num(data.money) > cashIdle) {
    if (!prev) warn.push(`现金 ${r2(data.money)} 万 > ${cashIdle} 万（没有基线，下次起按「当日必须有投放」判红线）`)
    else {
      const invested = num(prev.fleet) !== num(data.fleet) || num(prev.routes) !== num(data.routes) || (prev.points != null && num(prev.points) !== num(data.points))
      if (!invested) red.push(`现金 ${r2(data.money)} 万 > ${cashIdle} 万且当日无投放（机队/航线/点数都没变）→ 现金滞留`)
    }
  }
  if (fuelDays != null) {
    if (fuelDays < fuelRed) red.push(`燃油仅够 ${r2(fuelDays)} 天（<${fuelRed} 天，优先补油）`)
    else if (fuelDays < fuelWarn) warn.push(`燃油 ${r2(fuelDays)} 天（<${fuelWarn} 天；触发线 max(3 天, 库容 30%)）`)
  }
  if (price > 0 && price <= 5) info.push(`油价 ${r2(price, 2)} 元 ≤5 → 按规则可加满`)

  // ⑤ 运营预警
  for (const g of data.alerts || []) {
    for (const it of g.items || []) {
      const line = '[' + g.title + '] ' + it.title + (it.reason ? '：' + String(it.reason).slice(0, 80) : '')
      if (it.severity === 'critical') red.push(line)
      else warn.push(line)
    }
  }

  const snapshot = {
    at: Date.now(), date: data.date || null,
    fleet: num(data.fleet), routes: num(data.routes), points: num(data.points),
    cash: r2(data.money), delay: { med: dMed, sev: dSev }, maxDelay: maxD, fuelDays: fuelDays == null ? null : r2(fuelDays),
  }
  return {
    ok: red.length === 0,
    exitCode: red.length ? 2 : 0,
    red, warn, info,
    snapshot,
    source: 'page',
    groups: {
      delay: { maxDelay: maxD, maxReg: maxRow ? maxRow.reg : null, medium: dMed, severe: dSev },
      maint: { ghost: ghost.map((a) => a.reg), faulty: faulty.map((a) => a.reg) },
      inspection: lowNoInsp.map((a) => a.reg),
      cash: { cash: r2(data.money), fuelDays: fuelDays == null ? null : r2(fuelDays) },
      alerts: (data.alerts || []).reduce((n, g) => n + (g.items || []).length, 0),
    },
    note: '按 报告/每日推进校验规则.md 五项；严延真实口径 = 单班最大延误 ≥180 分（引擎 settleDailyDelays 用全场总和会放大）。',
  }
}

// 输入：{ status, health, route, buy, fuel } 都是已算好的结果；opts = { reserve, maxRoutes, maxAircraft, paybackLimit }
export function expandPlan(input, opts = {}) {
  // status 是 opStatus().status（页面 STATUS_EXPR 的返回，本身没有 ok 字段）
  const status = input && input.status
  if (!status || status.cash == null) return { ok: false, reason: '缺少盘面数据' }
  const cash = num(status.cash)
  const reserve = num(opts.reserve, 0)
  const maxRoutes = Math.max(1, Math.floor(num(opts.maxRoutes, 2)))
  const maxAircraft = Math.max(1, Math.floor(num(opts.maxAircraft, 1)))
  const paybackLimit = num(opts.paybackLimit, 25)
  const steps = []
  const blockers = []
  let avail = cash - reserve
  const fy = input.fuel && input.fuel.ok ? input.fuel : null
  const hl = input.health && input.health.ok !== false ? input.health : null
  const rp = input.route && input.route.ok ? input.route : null
  const bp = input.buy && input.buy.ok ? input.buy : null

  // 0) 红线（会直接造成延误/事故，必须先处理，不排入正常流程）
  if (hl) {
    if (num(hl.summary && hl.summary.overflow) > 0) blockers.push('夜停超容：' + (hl.overflow || []).map((a) => a.name + ' ' + a.parked + '/' + a.parkedCap).join('、') + ' → 换基地/停飞/调机，超容会空中盘旋 + 巨额延误')
    if (num(hl.summary && hl.summary.badGap) > 0) blockers.push('起飞间隔违反：' + (hl.badGap || []).map((g) => g.ap).join('、') + ' → 先把同机场航班错开')
    if (num(hl.summary && hl.summary.belowGround) > 0) blockers.push('过站低于引擎硬下限 50 分：' + (hl.belowGround || []).map((a) => a.reg).join('、') + ' → 必须重排')
  }
  if (num(status.delays && status.delays.severe) > 0) blockers.push('存在严重延误 ' + status.delays.severe + ' 天（不可逆，先查幽灵飞行/卡死故障）')

  // 1) 排班：零成本先吃掉现有运力（容量是闸门不是钱）
  if (hl && (num(hl.summary.idle) > 0 || num(hl.summary.underused) > 0)) {
    const idle = num(hl.summary.idle)
    const under = num(hl.summary.underused)
    steps.push({
      kind: 'sched',
      title: `补齐排班：${idle} 架闲置 + ${under} 架欠排`,
      detail: '闲置机不排班就是烧钱；先 hjyt_sched_pick（游戏里点选航线）→ hjyt_sched_apply_pick 或体检面板「一键排班」',
      cost: 0,
      tool: 'hjyt_sched_health',
      args: { limit: 10 },
      ready: true,
    })
  }

  // 2) 油：先补到「max(4 天, 90% 库容)」，再谈扩张（新机每架都会加日耗）
  if (fy) {
    if (fy.refill && fy.refill.liters > 0) {
      // liters 已按现金裁剪过，所以只要还有量就是付得起的
      const ready = true
      const targetD = fy.refill.targetLiters && fy.perDay ? r2(fy.refill.targetLiters / fy.perDay) : fy.refill.wantDays
      steps.push({
        kind: 'refuel',
        title: `补油 ${Math.round(fy.refill.liters / 10000)} 万升（油 ${fy.fuelDays == null ? '?' : fy.fuelDays} 天 → ${targetD} 天）`,
        detail: `油价 ${fy.price} 元/升；花 ${fy.refill.cost} 万；${fy.refill.reason}` + (fy.refill.shortfall > 0 ? `；现金不够，还差 ${Math.round(fy.refill.shortfall / 10000)} 万升` : ''),
        cost: fy.refill.cost,
        tool: 'hjyt_fuel_apply',
        args: { confirm: true },
        ready,
        reason: null,
      })
      avail -= fy.refill.cost
    }
    if (fy.targetCapacity > 0 && fy.capacity < fy.targetCapacity) {
      const upCost = fy.upgrade.cost
      const needSteps = (fy.upgrade.steps || []).length
      const canSteps = (fy.upgrade.affordableSteps || []).length
      const ready = upCost > 0 && upCost <= avail
      steps.push({
        kind: 'fuelcap',
        title: `扩油库到 ${Math.round(fy.targetCapacity / 10000)} 万升（满库 ≥${fy.targetDays} 天）`,
        detail: fy.upgrade.stillShort
          ? `需 ${needSteps} 步，现金只够 ${canSteps} 步（花 ${upCost} 万）；还差 ${Math.round((fy.targetCapacity - fy.upgrade.capAfter) / 10000)} 万升 ≈ ${fy.upgrade.shortCost} 万`
          : `分 ${canSteps} 步，花 ${upCost} 万`,
        cost: upCost,
        tool: 'hjyt_fuel_apply',
        args: { confirm: true },
        ready,
        reason: ready ? null : (upCost === 0 ? '没有可执行的扩容步（现金不足一步）' : '现金不够扩容'),
      })
      if (ready) avail -= upCost
    }
  }

  // 3) 开线：需求大、开线费够、一次别开太多（用户口径：不要一次性开完）
  if (rp) {
    const picks = (rp.candidates || [])
      .filter((c) => c.createCostRound == null || num(c.createCostRound) <= avail)
      .slice(0, maxRoutes)
    if (picks.length) {
      for (const c of picks) {
        const cost = num(c.createCostRound)
        const ready = cost <= avail
        steps.push({
          kind: 'route',
          title: `开线 ${c.from}→${c.to}（${c.km}km · 需求 ${c.own}）`,
          detail: `建议 ${c.suggestModel} × ${c.suggestFlightsPerDay} 班/日，开线费 ${cost} 万`,
          cost,
          tool: 'hjyt_route_apply',
          args: { from: c.from, to: c.to, both: true, confirm: true },
          ready,
          reason: ready ? null : '现金不够开线费',
        })
        if (ready) avail -= cost
      }
    } else {
      steps.push({ kind: 'route', title: '开线：没有符合现金条件的候选', detail: '跑 hjyt_route_plan 调整 minOwn/maxKm，或先攒开线费', cost: 0, tool: 'hjyt_route_plan', args: {}, ready: false })
    }
  }

  // 4) 买机：先过质量闸门（开局 3 天 / 全队 LF ≥89%），再看回本、机库位、现金
  if (bp) {
    if (bp.gateReason) {
      steps.push({
        kind: 'aircraft',
        title: '买机：被质量闸门冻结',
        detail: bp.gateReason + '（先改配舱/间距/服务/票价，把 LF 提到 89% 以上）',
        cost: 0,
        tool: 'hjyt_buy_plan',
        args: {},
        ready: false,
        reason: bp.gateReason,
      })
    } else {
      const picks = (bp.candidates || [])
        .filter((c) => num(c.paybackDays) > 0 && num(c.paybackDays) <= paybackLimit && num(c.totalCost || c.price) <= avail)
        .slice(0, maxAircraft)
      if (picks.length) {
        for (const c of picks) {
          const cost = num(c.totalCost || c.price)
        const ready = cost <= avail
        steps.push({
          kind: 'aircraft',
          title: `买机 ${c.model}（${c.seats} 座 · ${c.base || '自动分配'} · ${c.paybackDays} 天回本）`,
          detail: `日净利 ${c.dailyNet} 万；买前确认机库位与夜停容量，买后跑 hjyt_fuel_plan 复查油库 3 天`,
          cost,
          tool: 'hjyt_buy_apply',
          args: { model: c.model, confirm: true, secondConfirm: true, cabin: 'auto' },
          ready,
          reason: ready ? null : '现金不够机价',
        })
        if (ready) avail -= cost
      }
    } else {
      steps.push({
        kind: 'aircraft',
        title: '买机：没有符合「回本 ≤' + paybackLimit + ' 天 + 现金够」的候选',
        detail: (bp.blocked || []).length ? '机库/基地限制：' + (bp.blocked || []).map((b) => b.base + ' ' + b.reason).join('；') : '跑 hjyt_buy_plan 放宽预算/机型',
        cost: 0,
        tool: 'hjyt_buy_plan',
        args: {},
        ready: false,
      })
    }
    }
  }

  const total = sum(steps, (s) => (s.ready ? num(s.cost) : 0))
  return {
    ok: true,
    kind: 'expand-plan',
    date: status.date || null,
    cash: r2(cash),
    reserve,
    available: r2(cash - reserve),
    blockers,
    steps,
    summary: {
      steps: steps.length,
      ready: steps.filter((s) => s.ready).length,
      plannedCost: r2(total),
      cashAfter: r2(cash - total),
      fuelDays: fy ? fy.fuelDays : null,
      capacityDays: fy ? fy.capacityDays : null,
      idle: hl ? num(hl.summary.idle) : null,
      underused: hl ? num(hl.summary.underused) : null,
      fleet: status.fleet,
      routes: status.routes,
    },
    note: '顺序 = 红线（夜停超容/间隔/过站）→ 排班（零成本吃满运力）→ 补油 + 扩油库（满库 ≥3 天）→ 开线 → 买机。现金只按「有钱就投、不囤钱」算，reserve 可调。',
  }
}

const ifThen = (cond, text) => (cond ? text : null)

// ---------------------------------------------------------------------------
// 2) 开线向导
// ---------------------------------------------------------------------------
// 输入：routeExpr 的返回；opts = { fromAirports, limit, minKm, minOwn, intl, level, excludeCities, maxKm, model }
export function routePlan(data, opts = {}) {
  if (!data || !data.ok) return { ok: false, reason: (data && data.reason) || '页面数据不可用' }
  const minKm = num(opts.minKm, 200)
  const maxKm = num(opts.maxKm, 0)
  const th = data.thresholds || { domestic: 180, international: 250 }
  const minOwn = opts.minOwn != null ? num(opts.minOwn) : null
  const models = (data.models || []).filter((m) => {
    if (!opts.model) return true
    const want = String(opts.model)
    return m.name === want || new RegExp(want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(m.name)
  }).sort((a, b) => a.seats - b.seats)
  const excludeCities = new Set((opts.excludeCities || []).map(String))
  const pairs = (data.pairs || []).filter((p) => {
    if (p.exists) return false
    if (num(p.km) < minKm) return false
    if (maxKm > 0 && num(p.km) > maxKm) return false
    if (cityOf(p.from) === cityOf(p.to)) return false
    if (opts.intl === true && !p.toIntl) return false
    if (opts.intl === false && p.toIntl) return false
    if (opts.level && p.toLevel !== opts.level) return false
    if (excludeCities.has(cityOf(p.to))) return false
    const need = p.toIntl ? th.international : th.domestic
    const want = minOwn != null ? minOwn : need
    return num(p.own) >= want
  })
  const rows = pairs.map((p) => {
    const need = p.toIntl ? th.international : th.domestic
    const own = num(p.own)
    // 建议班次：需求越大排越多，封顶 6 班/日（再多也吃不下，还要留起飞间隔）
    const perDay = clamp(Math.round(own / 900) + 1, 2, 6)
    // 目标：吃掉约 25% 需求（实测本司在热门航线只吃 4~5%，需求池远大于运力）
    const targetSeats = clamp(Math.round((own * 0.25) / perDay), 90, 550)
    const fit = models.filter((m) => !m.range || num(p.km) <= num(m.range) * 0.92)
    let pick = fit.slice().sort((a, b) => Math.abs(a.seats - targetSeats) - Math.abs(b.seats - targetSeats))[0] || null
    const servedPax = pick ? perDay * pick.seats * 0.7 : null
    return {
      from: p.from,
      to: p.to,
      km: p.km,
      own: own,
      demand: p.demand,
      threshold: need,
      level: p.toLevel,
      intl: !!p.toIntl,
      region: p.toRegion,
      createCost: p.cost,
      createCostRound: p.cost == null ? null : r2(num(p.cost) * 2),
      suggestModel: pick ? pick.name : null,
      suggestSeats: pick ? pick.seats : null,
      suggestFlightsPerDay: perDay,
      targetSeats,
      serveShare: own > 0 && servedPax ? r2(servedPax / own, 3) : null,
      minutesPerLeg: Math.round((p.km / 750) * 60 / 0.85) + 25,
      needDepartureGap: p.needTo,
      score: r2(Math.log(1 + own) * Math.min(3, 2000 / Math.max(200, p.km))),
    }
  })
  rows.sort((a, b) => b.own - a.own || a.km - b.km)
  const limit = Math.max(1, Math.floor(num(opts.limit, 15)))
  const costSum = sum(rows.slice(0, limit), (r) => num(r.createCostRound))
  return {
    ok: true,
    kind: 'route-plan',
    date: null,
    froms: data.froms,
    money: r2(num(data.money)),
    thresholds: th,
    considered: (data.pairs || []).length,
    matched: rows.length,
    candidates: rows.slice(0, limit),
    topLimitCost: r2(costSum),
    note: '需求与开线费都是页面公式现算；写入走「开线四步」（createRoute → 票价 → 精品餐食 → 精品快线）。',
  }
}

// ---------------------------------------------------------------------------
// 3) 排班体检
// ---------------------------------------------------------------------------
// 输入：HEALTH_EXPR 的返回；opts = { medianMargin, lateFirst, earlyLast }
export function healthReport(data, opts = {}) {
  if (!data || !data.ok) return { ok: false, reason: (data && data.reason) || '页面数据不可用' }
  const acs = (data.aircraft || []).slice()
  const groundTurn = num(data.groundTurn, 50)
  const withLegs = acs.filter((a) => a.legs > 0)
  const medUtil = median(withLegs.map((a) => num(a.util)))
  const medFirst = median(withLegs.filter((a) => a.first != null).map((a) => a.first))
  const medLast = median(withLegs.filter((a) => a.last != null).map((a) => a.last))
  const medLegs = median(withLegs.map((a) => a.legs))
  const utilMargin = num(opts.utilMargin, 0.12)
  const timeMargin = num(opts.timeMargin, 180)

  const flags = {
    idle: acs.filter((a) => a.legs === 0),
    underused: acs.filter((a) => a.legs > 0 && a.legs <= 2),
    tightStop: acs.filter((a) => a.minStop != null && num(a.minStop) < num(a.turnWant)),
    belowGround: acs.filter((a) => a.minStop != null && num(a.minStop) < groundTurn),
    lateFirst: acs.filter((a) => a.first != null && medFirst != null && num(a.first) > medFirst + timeMargin),
    earlyLast: acs.filter((a) => a.last != null && medLast != null && num(a.last) < medLast - timeMargin),
    lowUtil: acs.filter((a) => a.legs > 0 && medUtil != null && num(a.util) < medUtil - utilMargin),
    // 利用率红线：实测 87% 的飞机每班晚 75.8 分、64% 只晚 8.9 分 → 现行上限 70%
    highUtil: acs.filter((a) => a.legs > 0 && num(a.util) > num(opts.maxUtil, 0.70)),
    overflow: (data.airports || []).filter((ap) => num(ap.over) > 0),
    // 位置与首段起飞地不一致：只作提示（引擎会按时刻表把飞机放到起飞地，实测 上海-北京 就是正常的）
    misplaced: acs.filter((a) => a.legs > 0 && a.status !== 'flying' && a.firstFrom && a.curAirport && a.firstFrom !== a.curAirport),
    // 真红线：调机任务卡死（active 但没起飞、phase 又不是引擎认识的）→ 引擎会跳过这架机的所有航班
    stuckFerry: acs.filter((a) => {
      if (!a.ferry || !a.ferry.active || a.ferry._departed) return false
      const ph = String(a.ferry.phase)
      // phase = temp / temp_waiting / temp_done 表示「引擎在等临时时刻表」；表是空的就是死锁：
      //   gameLoop.js 的 processWaitingDepartures 只要看到 ferryState.active 就会
      //   cancelAircraftDepartureDelay(ac)（记成「航班已取消」）并 continue，永远不起飞；
      //   同时引擎会 setPaused(true) 弹「临时航班」对话框把整个游戏冻住。
      //   2026-10-20 实测：北京-上海 B757 卡在 temp_waiting 两天，6 个班次全被取消、游戏时间冻结。
      if (ph === 'temp' || ph === 'temp_waiting' || ph === 'temp_done') {
        return !(a.ferry.tempSchedule && a.ferry.tempSchedule.length)
      }
      const okPhases = ['ferrying', 'returning', 'inspection', 'retrofit', 'cargo', 'charter', 'positioned', 'returned']
      return okPhases.indexOf(ph) < 0
    }),
    badGap: Object.entries(data.gaps || {}).filter(([, g]) => g && g.ok === false && g.min != null).map(([ap, g]) => ({ ap, ...g })),
  }
  // 还能不能靠「多排 2 段」提升利用率：按当前平均段时长 + 过站估时间够不够
  const canAdd2 = (a) => {
    const legs = num(a.legs)
    if (!legs) return true
    const ft = num(a.blockMin) / legs
    const turn = num(a.turnWant) || 60
    const first = num(a.first)
    if (!Number.isFinite(ft) || !Number.isFinite(first) || !Number.isFinite(num(a.last))) return true
    const need = first + (legs + 1) * (ft + turn) + ft
    return need <= 1390
  }
  const row = (a) => ({
    id: a.id, reg: a.reg,
    maxed: !canAdd2(a), base: a.base, model: a.model, legs: a.legs, first: a.first, last: a.last,
    minStop: a.minStop, util: a.util, spanMin: a.last != null && a.first != null ? a.last - a.first : null,
    slackBefore: a.first != null ? a.first : null, slackAfter: a.last != null ? 1440 - a.last : null,
    routes: a.routes,
    cur: a.curAirport || null,
    firstFrom: a.firstFrom || null,
    ferryPhase: a.ferry ? String(a.ferry.phase) + (a.ferry._departed ? '(已起飞)' : '(未起飞)') : null,
  })
  // 维修位负载（四查 C2：同机场待修机数 ÷ 维修位 ≤ 3）
  // 只管「该机场有维修位」的那些；按夜停机场统计，比例 >3 就是过载，>1 说明同时要修就会排队
  const slotsOf = data.maintSlots || {}
  const loadMap = new Map()
  for (const a of acs) {
    const ap = a.nightTo || a.curAirport || null
    if (!ap) continue
    const slots = num(slotsOf[ap])
    if (slots <= 0) continue
    if (!loadMap.has(ap)) loadMap.set(ap, { name: ap, slots, aircraft: [] })
    loadMap.get(ap).aircraft.push(a.reg)
  }
  const maintLoad = Array.from(loadMap.values()).map((x) => {
    const cnt = x.aircraft.length
    const ratio = x.slots ? cnt / x.slots : null
    return {
      name: x.name, slots: x.slots, aircraft: cnt, ratio: r2(ratio, 2),
      // 夜间产能 = 维修位数；白天另有一个班次（×2）。ratio>1 夜间就要排队，>2 连白天也吃不下
      level: ratio == null ? null : (ratio > 2 ? 'over' : (ratio > 1 ? 'tight' : 'ok')),
      regs: x.aircraft.slice(0, 12),
    }
  }).sort((a, b) => (b.ratio || 0) - (a.ratio || 0))
  const limit = Math.max(1, Math.floor(num(opts.limit, 10)))
  const trim = (list) => list.slice(0, limit).map(row)
  // 游戏被暂停 = 时间不动、所有航班都不起飞（引擎弹「临时航班」对话框时必然暂停）→ 也算红线
  const paused = !!data.paused
  const critical = (paused ? 1 : 0) + flags.overflow.length + flags.badGap.length + flags.belowGround.length + flags.stuckFerry.length
  return {
    ok: critical === 0,
    kind: 'sched-health',
    date: data.date,
    fleet: data.fleet,
    legsDay0: data.legsDay0,
    groundTurn,
    paused,
    pausedHint: paused ? '游戏处于暂停状态（引擎弹窗/手动暂停）：时间不动、所有航班都不起飞 → 先点「继续」' : null,
    baseline: { util: r2(medUtil, 3), first: medFirst, last: medLast, legs: medLegs },
    summary: {
      idle: flags.idle.length,
      underused: flags.underused.length,
      tightStop: flags.tightStop.length,
      belowGround: flags.belowGround.length,
      lateFirst: flags.lateFirst.length,
      earlyLast: flags.earlyLast.length,
      lowUtil: flags.lowUtil.length,
      highUtil: flags.highUtil.length,
      overflow: flags.overflow.length,
      badGap: flags.badGap.length,
      misplaced: flags.misplaced.length,
      stuckFerry: flags.stuckFerry.length,
    },
    critical,
    idle: trim(flags.idle),
    underused: trim(flags.underused),
    tightStop: trim(flags.tightStop),
    belowGround: trim(flags.belowGround),
    misplaced: trim(flags.misplaced),
    maintLoad,
    stuckFerry: trim(flags.stuckFerry),
    lateFirst: trim(flags.lateFirst),
    earlyLast: trim(flags.earlyLast),
    lowUtil: trim(flags.lowUtil),
    highUtil: trim(flags.highUtil),
    overflow: flags.overflow,
    badGap: flags.badGap.slice(0, limit),
    advice: healthAdvice(flags, row, limit),
    airports: (data.airports || []).map((ap) => ({
      name: ap.name,
      parked: ap.parked,
      parkedCap: ap.parkedCap,
      over: ap.over,
      hangarCap: ap.hangarCap,
      idle: (ap.idle || []).slice(0, 6),
    })),
    note: '「偏晚/偏早/偏低」是与本队中位数比较（不是绝对红线）；红线只有：夜停超容、间隔违反、过站低于引擎硬下限。',
  }
}

function healthAdvice(flags, row, limit) {
  const lines = []
  if (flags.idle.length) lines.push(`${flags.idle.length} 架完全闲置：${flags.idle.slice(0, limit).map((a) => a.reg).join('、')} → 不排班就等于烧钱，要么排满要么封存`)
  if (flags.underused.length) lines.push(`${flags.underused.length} 架欠排（≤2 段/日）：${flags.underused.slice(0, limit).map((a) => a.reg + '(' + a.legs + '段)').join('、')} → 可补段`)
  if (flags.belowGround.length) lines.push(`⚠ ${flags.belowGround.length} 架过站低于引擎硬下限 ${flags.belowGround[0] && flags.belowGround[0].minStop || ''} 分 → 必须修排班`)
  if (flags.tightStop.length) lines.push(`${flags.tightStop.length} 架过站偏紧（低于本机型目标余量）→ 延误风险`)
  if (flags.earlyLast.length) {
    const best = flags.earlyLast.slice().sort((a, b) => num(a.last) - num(b.last))[0]
    lines.push(`${flags.earlyLast.length} 架末班偏早（<中位数-3h，最早 ${best.reg} 落地 ${best.last} 分）→ 还有可用时段，可加密`)
  }
  if (flags.lateFirst.length) lines.push(`${flags.lateFirst.length} 架首班偏晚（>中位数+3h）→ 早高峰时段空着`)
  if (flags.lowUtil.length) lines.push(`${flags.lowUtil.length} 架 block 利用率低于队内中位数 12 个点 → 单机排班偏松`)
  if (flags.highUtil && flags.highUtil.length) lines.push(`⚠ ${flags.highUtil.length} 架利用率 >70%（${flags.highUtil.slice(0, 5).map((a) => a.reg + ' ' + Math.round(num(a.util) * 100) + '%').join('、')}）→ 减 1~2 段：实测 87% 的飞机每班晚 76 分，64% 的只晚 9 分`)
  if (flags.overflow.length) lines.push(`⚠ 夜停超容：${flags.overflow.map((ap) => ap.name + ' ' + ap.parked + '/' + ap.parkedCap).join('、')} → 会盘旋+巨额延误，必须处理`)
  if (flags.badGap.length) lines.push(`⚠ 起飞间隔违反：${flags.badGap.map((g) => g.ap).join('、')}`)
  return lines
}

// ---------------------------------------------------------------------------
// 4) 日贡献看板
// ---------------------------------------------------------------------------
// 输入：boardExpr 的返回；opts = { days, limit }
export function boardView(data, opts = {}) {
  if (!data || !data.ok) return { ok: false, reason: (data && data.reason) || '页面数据不可用' }
  const days = Math.max(1, Math.floor(num(opts.days, 14)))
  const daily = (data.daily || []).slice(-days)
  const cash = (data.cash || []).slice(-days)
  const mods = data.modules || {}
  // dailyHistory 里的 fuelCost 恒为 0（引擎没写），改用模块日账 join 出真实成本
  const modByDay = new Map()
  for (const [mid, list] of Object.entries(mods)) {
    for (const st of list || []) if (st && st.day) modByDay.set(st.day + '|' + mid, st)
  }
  const sideOf = (day) => (modByDay.get(day + '|passenger') || modByDay.get(day + '|cargo') || null)
  const last = daily.length ? daily[daily.length - 1] : null
  const prev = daily.length > 1 ? daily[daily.length - 2] : null
  const trend = daily.map((d, i) => {
    const p = i > 0 ? daily[i - 1] : null
    const side = sideOf(d.day)
    return {
      day: d.day,
      revenue: r2(d.revenue),
      passengers: d.passengers,
      fuelCost: r2(side ? -num(side.fuel) : num(d.fuelCost)),
      cost: side ? r2(['fuel', 'catering', 'maint', 'equipment', 'compensation', 'lease', 'alliance'].reduce((t, k) => t + Math.abs(num(side[k])), 0)) : null,
      net: side ? r2(num(d.revenue) - ['fuel', 'catering', 'maint', 'equipment', 'compensation', 'lease', 'alliance'].reduce((t, k) => t + Math.abs(num(side[k])), 0)) : null,
      revPerPax: d.passengers ? r2(d.revenue / d.passengers, 4) : null,
      deltaRevenue: p ? r2(d.revenue - p.revenue) : null,
      deltaPax: p ? d.passengers - (p.passengers || 0) : null,
    }
  })
  const paxMod = mods.passenger || []
  const closed = paxMod.filter((s) => num(s.revenue) > 0)
  const win = closed.slice(-Math.min(7, Math.max(1, closed.length)))
  const avg = (f) => (win.length ? num(sum(win, (s) => num(s[f])) / win.length) : null)
  const costMix = win.length
    ? [
      { item: '收入', value: r2(avg('revenue')) },
      { item: '油费', value: r2(avg('fuel')) },
      { item: '餐食', value: r2(avg('catering')) },
      { item: '维修', value: r2(avg('maint')) },
      { item: '设备', value: r2(avg('equipment')) },
      { item: '赔付', value: r2(avg('compensation')) },
      { item: '补贴', value: r2(avg('subsidy')) },
      { item: '联盟费', value: r2(avg('alliance')) },
    ].filter((x) => x.value != null)
    : []
  const net = costMix.length ? r2(costMix[0].value - sum(costMix.slice(1), (x) => Math.abs(x.value))) : null
  // 航线边际：本周实际收入 / 座位 / 飞行班次
  const seenPair = new Set()
  const routes = (data.routes || []).filter((r) => {
    if (!(r.wk && r.wk.flights > 0)) return false
    const key = [r.from, r.to].sort().join('|')
    if (seenPair.has(key)) return false
    seenPair.add(key)
    return true
  }).map((r) => {
    const wk = r.wk
    const revPerFlight = wk.revenue / wk.flights
    const lf = wk.seats > 0 ? wk.passengers / wk.seats : null
    const revPerSeat = wk.seats > 0 ? wk.revenue / wk.seats : null
    const revPerKmSeat = wk.seats > 0 && r.km > 0 ? wk.revenue / (wk.seats * r.km) : null
    return {
      id: r.id, from: r.from, to: r.to, km: r.km,
      flights: wk.flights, seats: wk.seats, passengers: wk.passengers, revenue: r2(wk.revenue),
      revPerFlight: r2(revPerFlight), loadFactor: r2(lf, 3), revPerSeat: r2(revPerSeat, 4), revPerKmSeat: r2(revPerKmSeat, 7),
      demand: r.demand,
    }
  })
  // 「每班收入」受航距影响很大 → 用「每座位公里收入」归一后再比，才算得出真·弱航线
  const medRevPerFlight = median(routes.map((r) => num(r.revPerFlight)))
  const medRevPerKmSeat = median(routes.map((r) => num(r.revPerKmSeat)))
  for (const r of routes) {
    r.revPerKmSeatIdx = medRevPerKmSeat ? r2(num(r.revPerKmSeat) / medRevPerKmSeat, 3) : null
    r.flags = [
      r.loadFactor != null && r.loadFactor < 0.55 ? '客座低' : null,
      r.revPerKmSeatIdx != null && r.revPerKmSeatIdx < 0.65 ? '单位收入低' : null,
    ].filter(Boolean)
  }
  const weak = routes.filter((r) => r.flags.length > 0)
    .sort((x, y) => (x.flags.length - y.flags.length) || num(x.revPerKmSeatIdx) - num(y.revPerKmSeatIdx))
  const strong = routes.slice().sort((a, b) => num(b.revPerFlight) - num(a.revPerFlight))
  const fuel = data.fuel || {}
  return {
    ok: true,
    kind: 'board',
    date: data.date,
    money: r2(num(data.money)),
    today: last ? { ...trend[trend.length - 1], closed: last.revenue > 0 } : null,
    yesterday: prev ? trend[trend.length - 2] : null,
    trend,
    cash: cash.map((c) => ({ day: c.day, balance: r2(c.balance) })),
    costMix,
    avgNet: net,
    avgWindow: win.length ? { days: win.length, from: win[0].day, to: win[win.length - 1].day } : null,
    fuel: {
      price: r2(num(fuel.price), 3),
      history: (fuel.history || []).slice(-days),
      consumedYesterday: Math.round(num(fuel.consumedYesterday)),
      remaining: Math.round(num(fuel.remaining)),
      capacity: Math.round(num(fuel.capacity)),
      days: num(fuel.consumedYesterday) > 0 ? r2(num(fuel.remaining) / num(fuel.consumedYesterday), 2) : null,
    },
    routes: {
      count: routes.length,
      medianRevPerFlight: r2(medRevPerFlight),
      medianRevPerKmSeat: r2(medRevPerKmSeat, 7),
      weak: weak.slice(0, Math.max(1, Math.floor(num(opts.limit, 10)))),
      strong: strong.slice(0, 5),
    },
    delay: data.delay,
    note: '航线收入是本周累计（routeWeeklyStats）；「弱航线」= 客座 <55% 或 单位收入（每座位公里）低于全队中位数 65%。',
  }
}

// ---------------------------------------------------------------------------
// 6) 最佳舱位（买机 / 航线开发 / 体检 三处共用的唯一配舱算法）
// ---------------------------------------------------------------------------
// 口径 = 报告「黄金公式」（报告/重开优化清单.md:26-28、报告/机场升级与客舱优化报告.md:152-161）：
//
//   spaceCap = floor(机型座位 × 79 / 座椅间距)                    ← 空间是零和的
//   客座率基数 A = min(1, 航线声誉/100 × 健康/100 × 1.1 × I(Y倍率))
//   K_c   = min(1, A × clamp(倍率^(−弹性), 0.5, 1.8))            ← 该舱「能卖出的座位比例」
//   该舱需求座位 = 该舱每班需求 ÷ K_c                              ← 「每舱座位 = 该舱每段需求 ÷ K_c」
//   装满顺序 = 每空间收入 = 倍率 × 基础价系数(F10/J4/S1.7/Y1) ÷ 空间(F6/J3/S1.5/Y1) 降序
//             （报告实测 1233km：F 2232 > J 1454 > S 1139 > Y 488，F 是 Y 的 4.6 倍）
//   装不下就按这个顺序截断，Y 最后兜底 → 「宁可少 Y 也不能少 F」（重开优化清单:233）
//
// 为什么不再用旧的「收益指数比较 / 贪心填空间」：那两版都不模拟「需求池饱和」，
// 会把空间全给池子挖空的舱位。2026-10-31 北京线实测：旧算法给 F1/J9/S14/Y176（日收入 110 万），
// 黄金公式给 F4/J26/S20/Y98（日收入 169 万），差 54%。
//
// 注意：报告明确「客座率是过程指标，收入才是结果指标」（机场升级与客舱优化报告:211-215），
// 所以本函数不强制拉高客座率，只保证 Y 有底座（minY），避免把基础客流丢掉。
export function bestCabin(opts = {}) {
  const weight = Object.assign({ F: 6, J: 3, S: 1.5, Y: 1 }, opts.space || {})
  const fares = Object.assign({ F: 2, J: 2, S: 1.05, Y: 0.45 }, opts.fares || {})
  // 舱位基础价系数与需求弹性（游戏写死的，报告/多舱位票价配比分析.md:13-18）
  // 只算「倍率」会漏掉基础价差：F 的基础价是 Y 的 10 倍，所以真实每空间收益是 F≫J≫S≫Y
  const COEFF = Object.assign({ F: 10, J: 4, S: 1.7, Y: 1 }, opts.coeff || {})
  const ELAST = Object.assign({ F: 0.6, J: 0.9, S: 1.2, Y: 1.5 }, opts.elastic || {})
  const cabins = ['F', 'J', 'S', 'Y']
  const seats = Math.max(1, Math.floor(num(opts.seats, 0)))
  const legs = Math.max(1, Math.floor(num(opts.legs, 1)))
  const demandDay = opts.demand || {}
  const perFlight = {}
  for (const c of cabins) perFlight[c] = Math.max(0, num(demandDay[c]) / legs)
  // 弹性因子 K_c = clamp(倍率^(−弹性), 0.5, 1.8)：涨价掉客流，降价涨客流（Y 最敏感）
  const kOf = (c) => clamp(Math.pow(num(fares[c], 1), -num(ELAST[c], 1)), 0.5, 1.8)
  // 服务系数（premium 1.06）对所有舱位同乘，不改变排序，只影响绝对值
  const demandFactor = clamp(num(opts.demandFactor, 1), 0.8, 1.12)

  const used = (layout) => cabins.reduce((t, c) => t + layout[c] * weight[c], 0)
  // 每空间收入（报告口径）：倍率 × 基础价系数 ÷ 占用空间
  const spaceValue = (c) => (num(fares[c], 1) * num(COEFF[c], 1)) / weight[c]
  // 装满顺序：每空间收入降序（F > J > S > Y，Y 恒为兜底）
  const order = cabins.slice().sort((x, y) => spaceValue(y) - spaceValue(x))

  // —— 黄金公式的核心：客座率基数 A 与每舱需求座位 ——
  // A = min(1, 航线声誉/100 × 健康/100 × 1.1 × I(Y倍率))
  // I(x) 是引擎的购票意向函数（getRouteFareIntent 原样实现，见 fareIntentOf）
  const routeRep = clamp(num(opts.routeRep, 100), 0, 100)
  const health = clamp(num(opts.health, 100), 0, 100)
  const transfer = clamp(num(opts.transfer, 1), 0.5, 1.5)
  const A = Math.min(1, (routeRep / 100) * (health / 100) * 1.1 * transfer * fareIntentOf(num(fares.Y, 1)))
  // K_c = min(1, A × 该舱弹性因子)：该舱「能卖出的座位比例」
  const K = {}
  for (const c of cabins) K[c] = Math.min(1, A * kOf(c))
  // 该舱需求座位 = 该舱每班需求 ÷ K_c（K=0 时视为无穷大需求，交给截断处理）
  const needSeats = {}
  for (const c of cabins) needSeats[c] = K[c] > 0 ? perFlight[c] / K[c] : (perFlight[c] > 0 ? Infinity : 0)

  // Y 兜底（防 Y=0 丢基础客流）：报告/2026-10-18_Day1-7运行复盘与优化建议.md:64-68 踩过
  const minY = Math.max(0, Math.floor(num(opts.minY, 12)))

  // 「贪心 + 需求饱和截断」：先给 Y 预留底座，再按每空间收入降序填 F/J/S，Y 最后吃剩余
  const fill = (capSeats, capOf) => {
    const L = { F: 0, J: 0, S: 0, Y: 0 }
    let remain = capSeats
    // ① 先预留 Y 底座（Y 空间权重 = 1，1 座 = 1 点空间），避免被高价舱位吃干
    const yBase = Math.min(minY, Math.max(0, Math.floor(remain)))
    remain -= yBase
    // ② 按每空间收入降序填 F/J/S，每舱填到「需求座位」为止
    for (const c of order) {
      if (c === 'Y') continue
      const bySpace = Math.floor(remain / weight[c])
      const byNeed = capOf[c] === Infinity ? bySpace : Math.floor(capOf[c])
      const n = Math.max(0, Math.min(bySpace, byNeed))
      if (n > 0) { L[c] = n; remain -= n * weight[c] }
    }
    // ③ Y 吃剩余空间，上限是需求座位（capOf.Y = Infinity 时吃满）
    const yNeed = capOf.Y === Infinity ? Infinity : Math.floor(capOf.Y)
    const yFromRemain = Math.floor(remain)
    L.Y = yBase + Math.max(0, Math.min(yFromRemain, Math.max(0, yNeed - yBase)))
    return L
  }

  // 主方案：按「需求座位」截断（黄金公式原样）
  const golden = fill(seats, needSeats)
  // 备选：Y 座位数放宽到「基础客流全吃」（报告的口径是 Y 只需把客流基数打满）
  // Y 需求量 = min(每班池, A×座位…)，这里用 Infinity 需求让 Y 吃满剩余空间，用于对照
  const yUncapped = fill(seats, Object.assign({}, needSeats, { Y: Infinity }))

  // 收益真值（引擎口径）：pax = min(座位, 每班池, round(A × 座位 × k))，收入 = 段数 × pax × 票价
  const basePerKm = num(opts.basePerKm, 0.77)
  const km = num(opts.km, 0)
  const fareOf = (c, m) => Math.round(km * basePerKm * num(COEFF[c], 1) * num(m, 1))
  const revenueOf = (layout) => {
    let rev = 0, pax = 0, seatDay = 0
    for (const c of cabins) {
      const s = Math.max(0, Math.floor(num(layout[c])))
      if (!s) continue
      const p = Math.max(0, Math.min(s, perFlight[c], Math.round(A * s * kOf(c))))
      rev += legs * (km > 0 ? fareOf(c, fares[c]) : 1) * p
      pax += legs * p
      seatDay += legs * s
    }
    return {
      rev: km > 0 ? +(rev / 10000).toFixed(2) : +(rev).toFixed(2),
      pax: Math.round(pax),
      lf: seatDay > 0 ? +(pax / seatDay).toFixed(4) : 0,
    }
  }

  const cands = [
    { key: 'golden-formula', layout: golden },
    { key: 'golden-Y-full', layout: yUncapped },
  ]
  for (const cand of cands) {
    cand.space = +used(cand.layout).toFixed(1)
    const rv = revenueOf(cand.layout)
    cand.revenue = rv.rev
    cand.pax = rv.pax
    cand.lf = rv.lf
    cand.coverage = Object.fromEntries(cabins.map((k) => [k, perFlight[k] > 0 ? +Math.min(1, cand.layout[k] / perFlight[k]).toFixed(2) : null]))
  }
  // 主方案优先（黄金公式是口径基准）；只有备选严格更赚才改用它
  const pick = cands[1].revenue > cands[0].revenue * 1.02 ? cands[1] : cands[0]

  return {
    ok: true,
    layout: pick.layout,
    seats: cabins.reduce((t, c) => t + pick.layout[c], 0),
    spaceUsed: pick.space,
    spaceCap: seats,
    revenueIndex: pick.revenue,
    revenueDay: pick.revenue,
    paxDay: pick.pax,
    lf: pick.lf,
    method: pick.key,
    A: +A.toFixed(4),
    K: Object.fromEntries(cabins.map((c) => [c, +K[c].toFixed(3)])),
    needSeats: Object.fromEntries(cabins.map((c) => [c, c === 'Y' || needSeats[c] !== Infinity ? +Math.min(9999, needSeats[c]).toFixed(1) : null])),
    coverage: pick.coverage,
    alternatives: cands.map((c) => ({ method: c.key, layout: c.layout, seats: cabins.reduce((t, x) => t + c.layout[x], 0), revenueIndex: c.revenue, lf: c.lf })),
    perFlight: Object.fromEntries(cabins.map((c) => [c, +perFlight[c].toFixed(2)])),
    legs,
    km,
    fares,
    weight,
    coeff: COEFF,
    elastic: ELAST,
    elasticityFactor: Object.fromEntries(cabins.map((c) => [c, +kOf(c).toFixed(3)])),
    spaceValue: Object.fromEntries(cabins.map((c) => [c, +spaceValue(c).toFixed(2)])),
    routeRep,
    health,
    demandFactor,
    minY,
    note: '黄金公式（报告口径）：客座率基数 A=' + A.toFixed(3) + ' → K_c=' + cabins.map((c) => c + K[c].toFixed(2)).join('/')
      + '；每舱需求座位 = 每班需求 ÷ K_c；按每空间收入（F' + spaceValue('F').toFixed(1) + '>J' + spaceValue('J').toFixed(1)
      + '>S' + spaceValue('S').toFixed(1) + '>Y' + spaceValue('Y').toFixed(1) + '）降序装满，Y 至少 ' + minY + ' 座兜底。'
      + '客座率是过程指标，收入才是结果指标（报告/机场升级与客舱优化报告.md:211-215）。',
  }
}

// ---------------------------------------------------------------------------
// 6·5) 利润体检：票价倍率 + 舱位配比的联合最优（引擎真实公式）
// ---------------------------------------------------------------------------
// 引擎口径（routeEconomy.js / gameLoop.js / cabinService.js，2026-10-21 复核）：
//   客座率 LF = min(1, 航线声誉/100 × 换乘系数 × 健康度/100 × 1.1 × 票价意向(Y 倍率))
//   票价意向 I(x)：x≤1 → exp(ln3·((1-x)/0.7)^2)；x≥1 → exp(ln0.1·(x-1)^2)   ← 只喂 Y 倍率
//   舱位客流 = min(座位, 需求池/班次, round(max(LF,0.01) × 座位 × 倍率^(-弹性) × 客舱服务系数))，弹性 F0.6/J0.9/S1.2/Y1.5，clamp[0.5,1.8]
//   票价 = round(航距 × 0.77 × 舱位系数(F10/J4/S1.7/Y1) × 声誉系数 × 倍率)   元
//   空间 = 6F + 3J + 1.5S + Y ≤ floor(机型座位 × 79 / 间距)
// 直接推论：F/J 弹性<1 → 只要需求池没打满就把倍率顶到 2.0；S 最优点在 clamp 上界（≈0.6）；
// Y 既控票价又控 LF → 用网格搜「LF 不低于不报警线」下的收入最大点。
const PROFIT_ELAST = { F: 0.6, J: 0.9, S: 1.2, Y: 1.5 }
const PROFIT_CABINS = ['F', 'J', 'S', 'Y']

/** 票价意向 I(x)：玩家实际票价 / 基准票价 → 客流乘子（引擎 getRouteFareIntent 原样实现） */
export function fareIntentOf(x) {
  let v = Number(x)
  if (!Number.isFinite(v) || v <= 0) v = 1
  return v <= 1 ? Math.exp(Math.log(3) * Math.pow((1 - v) / 0.7, 2)) : Math.exp(Math.log(0.1) * Math.pow(v - 1, 2))
}

/**
 * 利润体检：给定 PRORFIT_EXPR 的数据，算「票价倍率 + 客舱配比」的联合最优。
 * @param {object} data  页面 PROFIT_EXPR 的返回
 * @param {object} opts  minLF（客座率不报警线，默认 0.62）/ minY / step / applyMinGain（收入提升不到这个比例就不改）
 */
export function profitPlan(data, opts = {}) {
  const cabins = PROFIT_CABINS
  const ELAST = Object.assign({}, PROFIT_ELAST, opts.elastic || {})
  const coeff = Object.assign({ F: 10, J: 4, S: 1.7, Y: 1 }, (data && data.coeff) || {}, opts.coeff || {})
  const space = Object.assign({ F: 6, J: 3, S: 1.5, Y: 1 }, (data && data.space) || {}, opts.space || {})
  const basePerKm = num(opts.basePerKm != null ? opts.basePerKm : data && data.basePerKm, 0.77)
  const repFactor = num(opts.repFactor != null ? opts.repFactor : data && data.repFactor, 1)
  const minLF = clamp(num(opts.minLF, 0.62), 0, 1)
  const minY = Math.max(0, Math.floor(num(opts.minY, 12)))
  const step = num(opts.step, 0.02)
  const gainFloor = num(opts.applyMinGain, 0.01)
  const grid = []
  for (let m = 0.3; m <= 2 + 1e-9; m += step) grid.push(+m.toFixed(2))
  const kOf = (c, m) => clamp(Math.pow(num(m, 1), -num(ELAST[c], 1)), 0.5, 1.8)
  const fareOf = (km, c, m) => Math.round(num(km) * basePerKm * num(coeff[c], 1) * repFactor * num(m, 1))
  const acById = {}
  for (const a of (data && data.aircraft) || []) acById[a.id] = a
  const routes = ((data && data.routes) || []).filter((r) => r && (r.flights || []).some((f) => num(f.legs) > 0))

  // 一条路线的 LF 曲线（按机型加权），mY 决定 LF
  const lfAt = (route, mY) => {
    let sum = 0, w = 0
    for (const f of route.flights || []) {
      const legs = num(f.legs)
      if (!(legs > 0)) continue
      const ac = acById[f.acId] || {}
      const base = Math.min(1, (num(route.routeRep) / 100) * num(f.transfer, 1) * (num(ac.health, 100) / 100) * 1.1)
      sum += Math.min(1, base * fareIntentOf(mY)) * legs
      w += legs
    }
    return w > 0 ? sum / w : 0
  }
  // 某个倍率组合下：日客流 / 日收入（万元）
  const simulate = (route, mults) => {
    let revDay = 0, paxDay = 0, legDay = 0, seatDay = 0
    const poolT = cabins.reduce((t, c) => {
      const p = route.poolByCabin && route.poolByCabin[c] != null ? num(route.poolByCabin[c]) : null
      return p == null ? t : t + p
    }, 0)
    const hasPoolT = cabins.some((c) => route.poolByCabin && route.poolByCabin[c] != null)
    for (const f of route.flights || []) {
      const legsWeek = num(f.legs)
      if (!(legsWeek > 0)) continue
      const legsDay = legsWeek / 7
      const ac = acById[f.acId] || {}
      const lfBase = Math.min(1, (num(route.routeRep) / 100) * num(f.transfer, 1) * (num(ac.health, 100) / 100) * 1.1)
      const lfF = Math.min(1, lfBase * fareIntentOf(mults.Y))
      const layout = ac.layout && typeof ac.layout === 'object' ? ac.layout : { Y: num(ac.seatCapacity) }
      const pax = {}
      let sum = 0
      for (const c of cabins) {
        const seatsC = Math.max(0, Math.floor(num(layout[c])))
        if (!seatsC) { pax[c] = 0; continue }
        const pool = route.poolByCabin && route.poolByCabin[c] != null ? num(route.poolByCabin[c]) : Infinity
        pax[c] = Math.max(0, Math.min(seatsC, pool, Math.round(Math.max(lfF, 0.01) * seatsC * kOf(c, mults[c]) * num(ac.demandFactor, 1))))
        sum += pax[c]
      }
      if (hasPoolT && sum > poolT) {
        const scale = poolT / sum
        for (const c of cabins) pax[c] = Math.floor(pax[c] * scale)
        sum = cabins.reduce((t, c) => t + pax[c], 0)
      }
      let seatSum = 0
      for (const c of cabins) seatSum += Math.max(0, Math.floor(num(layout[c])))
      for (const c of cabins) revDay += (legsDay * fareOf(route.km, c, mults[c]) * pax[c]) / 10000
      paxDay += legsDay * sum
      seatDay += legsDay * seatSum
      legDay += legsDay
    }
    // 客座率口径 = 引擎/周报口径（真实售出座位 ÷ 座位数），不是「概率客座率」
    return { revDay: +revDay.toFixed(3), paxDay: +paxDay.toFixed(1), avgLF: seatDay > 0 ? +(paxDay / seatDay).toFixed(4) : 0 }
  }
  // 单舱在给定 mY 下的最优倍率（其它舱不影响它的客流）；用「当前倍率」做种子，平手时保持不动
  const bestCabinMult = (route, c, mY, baseMults, curM) => {
    const seed = Object.assign({}, baseMults, { [c]: curM })
    let best = { m: curM, revDay: simulate(route, Object.assign({}, seed, { Y: mY })).revDay }
    for (const m of grid) {
      const trial = Object.assign({}, baseMults, { [c]: m })
      const sim = simulate(route, Object.assign({}, trial, { Y: mY }))
      if (sim.revDay > best.revDay + 1e-9) best = { m, revDay: sim.revDay, sim }
    }
    return best
  }

  const routePlans = []
  for (const route of routes) {
    const cur = { F: num(route.fare && route.fare.F, 1), J: num(route.fare && route.fare.J, 1), S: num(route.fare && route.fare.S, 1), Y: num(route.fare && route.fare.Y, 1) }
    const now = simulate(route, cur)
    // 该航线上各舱的实际座位总量（0 = 这条线没人配该舱，改倍率没有意义）
    const seatsOfC = {}
    for (const c of cabins) {
      seatsOfC[c] = (route.flights || []).reduce((t, f) => {
        const ac = acById[f.acId] || {}
        const layout = ac.layout && typeof ac.layout === 'object' ? ac.layout : { Y: num(ac.seatCapacity) }
        return t + num(f.legs) * Math.max(0, Math.floor(num(layout[c])))
      }, 0)
    }
    // 种子 = 当前政策（平手不动，避免把没人坐的舱位乱改）
    let best = { mults: cur, sim: now, feasible: now.avgLF >= minLF - 1e-9 }
    // 网格：先定 Y（决定 LF），再各舱独立最优；取「满足客座率约束且收入最高」
    const sims = []
    for (const mY of grid) {
      const base = { F: cur.F, J: cur.J, S: cur.S, Y: mY }
      const mults = { F: cur.F, J: cur.J, S: cur.S, Y: mY }
      for (const c of ['F', 'J', 'S']) {
        if (!(seatsOfC[c] > 0)) continue
        const pick = bestCabinMult(route, c, mY, base, cur[c])
        mults[c] = pick ? pick.m : cur[c]
      }
      const sim = simulate(route, mults)
      sims.push({ mults, sim, feasible: sim.avgLF >= minLF - 1e-9 })
      void base
    }
    const feas = sims.filter((x) => x.feasible)
    // 有可行解就只在可行解里挑收入最高的
    // 没有可行解（需求本身撑不起客座率，涨价降价都改不了）→ 至少不许把客座率改差
    const pool = feas.length ? feas : sims.filter((x) => x.sim.avgLF >= now.avgLF - 1e-9)
    for (const x of pool) {
      if (x.sim.revDay > best.sim.revDay + 1e-9) best = { mults: x.mults, sim: x.sim, feasible: x.feasible }
    }
    const gain = now.revDay > 0 ? (best.sim.revDay - now.revDay) / now.revDay : 1
    routePlans.push({
      route, fareNow: cur, fareWant: best.mults,
      revDayNow: now.revDay, revDayWant: best.sim.revDay, gain, lfNow: now.avgLF, lfWant: best.sim.avgLF,
      feasible: best.feasible, seatsOfC,
      fareChanged: cabins.some((c) => Math.abs(num(cur[c]) - num(best.mults[c])) >= 0.005),
      weekly: route.weekly || null, lfActual: route.lfActual != null ? +Number(route.lfActual).toFixed(4) : null,
    })
  }
  const routeById = {}
  for (const rp of routePlans) routeById[rp.route.id] = rp

  // ---- 客舱配比：按「每空间收益」贪心（引擎里客流对座位是线性的，故贪心最优）----
  const revOfLayout = (ac, layout, faresByRid) => {
    let revDay = 0, paxDay = 0, seatDay = 0
    for (const r of ac.routes || []) {
      const rp = routeById[r.rid]
      if (!rp) continue
      const route = rp.route
      const legsDay = num(r.legs) / 7
      if (!(legsDay > 0)) continue
      const f = (route.flights || []).find((x) => x.acId === ac.id) || {}
      const lfBase = Math.min(1, (num(route.routeRep) / 100) * num(f.transfer, 1) * (num(ac.health, 100) / 100) * 1.1)
      const lf = Math.min(1, lfBase * fareIntentOf(num(faresByRid[route.id].Y, 1)))
      for (const c of cabins) {
        const seatsC = Math.max(0, Math.floor(num(layout[c])))
        if (!seatsC) continue
        const pool = route.poolByCabin && route.poolByCabin[c] != null ? num(route.poolByCabin[c]) : Infinity
        const pax = Math.max(0, Math.min(seatsC, pool, Math.round(Math.max(lf, 0.01) * seatsC * kOf(c, faresByRid[route.id][c]) * num(ac.demandFactor, 1))))
        revDay += (legsDay * fareOf(route.km, c, faresByRid[route.id][c]) * pax) / 10000
        paxDay += legsDay * pax
      }
      let seatSum = 0
      for (const c2 of cabins) seatSum += Math.max(0, Math.floor(num(layout[c2])))
      seatDay += legsDay * seatSum
    }
    return { rev: +revDay.toFixed(3), lf: seatDay > 0 ? +(paxDay / seatDay).toFixed(4) : 0 }
  }
  const aircraftPlans = []
  for (const ac of (data && data.aircraft) || []) {
    if (!ac || !(ac.routes || []).length) continue
    const faresByRid = {}
    for (const r of ac.routes) {
      const rp = routeById[r.rid]
      if (rp) faresByRid[r.rid] = rp.fareWant
    }
    if (!Object.keys(faresByRid).length) continue
    const cap = Math.max(1, Math.floor(num(ac.seatCapacity)))
    const layoutNow = ac.layout && typeof ac.layout === 'object'
      ? { F: Math.max(0, Math.floor(num(ac.layout.F))), J: Math.max(0, Math.floor(num(ac.layout.J))), S: Math.max(0, Math.floor(num(ac.layout.S))), Y: Math.max(0, Math.floor(num(ac.layout.Y))) }
      : { F: 0, J: 0, S: 0, Y: cap }
    // 每舱「每座位每班收入」与「座位饱和上限」（同一架机飞多线 → 按段数加权）
    // 引擎：pax ≈ min(seats, pool, round(seats·q))，q = lf·k(fare)·demandFactor
    //   → 座位数 < pool/q 时每座位收入 = fare·q（线性）；到 pool/q 就饱和，再多也不多卖
    const valPerSeat = { F: 0, J: 0, S: 0, Y: 0 }
    const seatCap = { F: 0, J: 0, S: 0, Y: 0 }
    let wsum = 0
    for (const r of ac.routes) {
      const rp = routeById[r.rid]
      if (!rp) continue
      const route = rp.route
      const legs = num(r.legs)
      if (!(legs > 0)) continue
      wsum += legs
      const f = (route.flights || []).find((x) => x.acId === ac.id) || {}
      const lfBase = Math.min(1, (num(route.routeRep) / 100) * num(f.transfer, 1) * (num(ac.health, 100) / 100) * 1.1)
      const lf = Math.min(1, lfBase * fareIntentOf(num(rp.fareWant.Y, 1)))
      for (const c of cabins) {
        const q = Math.max(0, Math.min(1, Math.max(lf, 0.01) * kOf(c, rp.fareWant[c]) * num(ac.demandFactor, 1)))
        valPerSeat[c] += legs * fareOf(route.km, c, rp.fareWant[c]) * q
        const pool = route.poolByCabin && route.poolByCabin[c] != null ? num(route.poolByCabin[c]) : Infinity
        const need = pool === Infinity ? Infinity : (q > 0 ? pool / q : 0)
        seatCap[c] = (seatCap[c] === Infinity || need === Infinity) ? Infinity : Math.max(seatCap[c], need)
      }
    }
    if (!wsum) continue
    // 贪心：先保 Y 底座，再按「每空间收益」从高到低填，填到需求饱和座位数为止
    const want = { F: 0, J: 0, S: 0, Y: 0 }
    let remain = cap
    want.Y = Math.min(minY, remain)
    remain -= want.Y
    const ratio = (c) => (space[c] > 0 ? valPerSeat[c] / space[c] : 0)
    for (const c of ['F', 'J', 'S'].sort((a, b) => ratio(b) - ratio(a))) {
      if (!(valPerSeat[c] > 0)) continue
      let n = Math.floor(remain / space[c])
      const capC = seatCap[c] === Infinity ? Infinity : Math.max(0, Math.floor(seatCap[c]))
      n = Math.min(n, capC)
      if (n > 0) { want[c] = n; remain -= n * space[c] }
    }
    want.Y += Math.floor(remain)
    // 需求池为空（这条线还没飞过）→ 不动配舱，避免把飞机配成全经济舱
    const anyPool = cabins.some((c) => routePlans.some((rp) => (ac.routes || []).some((r) => r.rid === rp.route.id) && rp.route.poolByCabin && rp.route.poolByCabin[c] != null && num(rp.route.poolByCabin[c]) > 0))
    const faresNowByRid = Object.fromEntries(Object.keys(faresByRid).map((rid) => [rid, routeById[rid].fareNow]))
    const mNow = revOfLayout(ac, layoutNow, faresNowByRid)
    const mKeep = revOfLayout(ac, layoutNow, faresByRid)   // 只改票价、配舱不动
    let layoutWant = anyPool ? want : layoutNow
    let mWant = anyPool ? revOfLayout(ac, want, faresByRid) : mKeep
    // 安全阀 1：贪心还不如「配舱不动」→ 退回不动（宁可少赚也不多花改装费）
    if (mWant.rev < mKeep.rev - 1e-6) { layoutWant = layoutNow; mWant = mKeep }
    // 安全阀 2：客座率掉到报警线以下而原本不会 → 退回不动（用户要求：客座率满足不报警就可以）
    if (mWant.lf < minLF - 1e-6 && mKeep.lf >= mWant.lf) { layoutWant = layoutNow; mWant = mKeep }
    const revNow = mNow.rev, revWant = mWant.rev
    const layoutChanged = cabins.some((c) => layoutWant[c] !== layoutNow[c])
    aircraftPlans.push({
      id: ac.id, reg: ac.reg, model: ac.model, cap, legsWeek: wsum,
      pitch: num(ac.pitch, 79), layoutNow, layoutWant,
      revDayNow: revNow, revDayWant: revWant, lfNow: mNow.lf, lfWant: mWant.lf,
      gain: revNow > 0 ? +((revWant - revNow) / revNow).toFixed(4) : 0,
      layoutChanged,
      cost: layoutChanged ? +((num(layoutWant.F, 0) * 2 + num(layoutWant.J, 0) * 0.8 + num(layoutWant.S, 0) * 0.3)).toFixed(2) : 0,
      valPerSeat: Object.fromEntries(cabins.map((c) => [c, +valPerSeat[c].toFixed(1)])),
      poolCap: Object.fromEntries(cabins.map((c) => [c, seatCap[c] === Infinity ? null : +Number(seatCap[c]).toFixed(1)])),
      skipReason: anyPool ? null : '这条线还没有分舱需求数据（没飞过）→ 配舱保持原样',
    })
  }

  // 总量口径：有飞机级计划时以飞机为准（票价 + 配舱一起生效），否则退回航线级
  const acNow = aircraftPlans.reduce((t, a) => t + a.revDayNow, 0)
  const acWant = aircraftPlans.reduce((t, a) => t + a.revDayWant, 0)
  const revNow = aircraftPlans.length ? acNow : routePlans.reduce((t, rp) => t + rp.revDayNow, 0)
  const revWant = aircraftPlans.length ? acWant : routePlans.reduce((t, rp) => t + rp.revDayWant, 0)
  return {
    ok: true, reputation: data && data.reputation, repFactor, basePerKm,
    minLF, minY, step,
    routes: routePlans.map((rp) => ({
      id: rp.route.id, from: rp.route.from, to: rp.route.to, km: rp.route.km,
      fareNow: rp.fareNow, fareWant: rp.fareWant, fareChanged: rp.fareChanged,
      revDayNow: rp.revDayNow, revDayWant: rp.revDayWant, gain: +rp.gain.toFixed(4),
      lfNow: rp.lfNow, lfWant: rp.lfWant, lfActual: rp.lfActual, feasible: rp.feasible,
    })),
    aircraft: aircraftPlans,
    revDayNow: +revNow.toFixed(2), revDayWant: +revWant.toFixed(2),
    gain: revNow > 0 ? +((revWant - revNow) / revNow).toFixed(4) : 0,
    fareChanges: routePlans.filter((rp) => rp.fareChanged).length,
    cabinChanges: aircraftPlans.filter((a) => a.layoutChanged).length,
    cabinCost: +aircraftPlans.reduce((t, a) => t + (a.layoutChanged ? a.cost : 0), 0).toFixed(2),
    gainFloor,
    note: '口径：LF=min(1, 航线声誉/100×换乘×健康/100×1.1×票价意向(Y))；票价=round(航距×0.77×系数(F10/J4/S1.7/Y1)×声誉系数×倍率)；空间 6F+3J+1.5S+Y ≤ floor(座位×79/间距)。约束：期望客座率 ≥ ' + Math.round(minLF * 100) + '%（游戏报警线 60%，连续 3 天才报）。',
  }
}

// ---------------------------------------------------------------------------
// 7) 按起降城市自动命名
// ---------------------------------------------------------------------------
const CITY_3 = ['乌鲁木齐', '呼和浩特', '哈尔滨', '石家庄', '西双版纳', '张家界', '牡丹江', '佳木斯', '齐齐哈尔', '鄂尔多斯', '克拉玛依', '呼和浩特', '乌鲁木齐', '阿尔山']
const CIRCLE = ['', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']

/** 城市全名表（2026-10-25 用户指令：改名要写完整城市名，不要只取前 2 字）
 *  匹配方式：去掉「机场/国际机场」后，取「是名字前缀的最长城市」——上海浦东→上海、法兰克福→法兰克福、
 *  班加罗尔Kempegowda→班加罗尔、伊斯坦布尔萨比哈·格克琴→伊斯坦布尔。没收录的原样返回全名。 */
const CITY_NAMES = [
  // 中国
  '上海', '北京', '广州', '深圳', '成都', '重庆', '杭州', '南京', '武汉', '西安', '昆明', '长沙', '郑州', '青岛',
  '大连', '沈阳', '哈尔滨', '长春', '济南', '合肥', '福州', '厦门', '南昌', '南宁', '贵阳', '海口', '三亚', '拉萨',
  '兰州', '西宁', '银川', '太原', '石家庄', '呼和浩特', '乌鲁木齐', '天津', '温州', '宁波', '无锡', '常州', '徐州',
  '烟台', '威海', '珠海', '汕头', '湛江', '桂林', '丽江', '大理', '西双版纳', '张家界', '敦煌', '喀什', '克拉玛依',
  '阿尔山', '包头', '鄂尔多斯', '呼伦贝尔', '牡丹江', '佳木斯', '齐齐哈尔', '香港', '澳门', '台北', '高雄', '台中',
  // 亚洲
  '东京', '大阪', '名古屋', '福冈', '那霸', '札幌', '首尔', '釜山', '新加坡', '吉隆坡', '曼谷', '雅加达', '马尼拉',
  '河内', '胡志明市', '金边', '仰光', '加德满都', '达卡', '科伦坡', '德里', '孟买', '班加罗尔', '卡拉奇', '伊斯兰堡',
  '迪拜', '阿布扎比', '多哈', '利雅得', '吉达', '科威特', '马斯喀特', '特拉维夫', '伊斯坦布尔', '安卡拉',
  // 欧洲
  '莫斯科', '圣彼得堡', '法兰克福', '慕尼黑', '柏林', '巴黎', '伦敦', '阿姆斯特丹', '布鲁塞尔', '米兰', '罗马',
  '马德里', '巴塞罗那', '里斯本', '苏黎世', '维也纳', '布拉格', '华沙', '斯德哥尔摩', '奥斯陆', '哥本哈根', '赫尔辛基', '都柏林',
  // 美洲
  '纽约', '洛杉矶', '旧金山', '西雅图', '芝加哥', '波士顿', '华盛顿', '多伦多', '温哥华', '墨西哥城', '圣保罗',
  '里约热内卢', '布宜诺斯艾利斯', '利马', '波哥大',
  // 大洋洲 / 非洲
  '悉尼', '墨尔本', '布里斯班', '珀斯', '奥克兰', '开罗', '内罗毕', '约翰内斯堡', '卡萨布兰卡', '亚的斯亚贝巴', '拉各斯',
]
// 长名字优先，避免「上海」抢掉「上海浦东」之类（当前表里同前缀少见，但按长度排更稳）
const CITY_SORTED = CITY_NAMES.slice().sort((a, b) => b.length - a.length)

/** 机场名 → 城市全名：去掉「机场/国际机场」→ 取最长前缀城市 → 兜底原样返回（绝不截断成 2 字） */
// ---------------------------------------------------------------------------
// 7.6) 航线开发：某个机场出发「最值得开的 N 条航线」+ 每条线能养几架（默认 B757-200）
// ---------------------------------------------------------------------------
// 输入 = expr.js 的 ROUTE_DEV_EXPR() 返回（已按 unlockedRegions 过滤候选机场）
// 口径（对齐引擎真值，见交接 D-02）：
//   · 航时 = round(km / cruiseSpeed * 60)；已开线直接读时刻表里的 flightTime
//   · 一天段数 = floor((lastArr − firstMin + turn) / (ft + turn))，向下取偶数、最少 2（偶数段铁律）
//   · 单机座位 = floor(机型座位 × 79 / 间距)；B757-200 @71cm = 255 座
//   · 每舱实收人数 = min(座位×段数, 当日需求池, round(LF × 座位×段数 × clamp(倍率^(−e),0.5,1.8)))
//   · LF = 航线声誉/100 × 1.1 × fareIntent(Y倍率)（换乘/健康按满值 → 偏乐观上限，返回里注明）
//   · 票价 = round(km × BASE_FARE_PER_KM × 舱位系数 × 声誉系数 × 倍率)
//   · F/J 倍率固定 2.0（弹性 0.6/0.9 < 1，需求池没打满前顶上限最赚）；S/Y 网格搜
//   · 可养架数 = floor(当日总需求 / (单机座位×段数×目标LF))，至少 1；再减这条线已有的飞机
export function routeDevPlan(data, opts = {}) {
  if (!data || !data.ok) return { ok: false, reason: (data && data.reason) || '页面数据不可用' }
  const rowsIn = data.rows || []
  if (!rowsIn.length) return { ok: false, reason: '没有候选航线：机场名可能写错，或该机场不在已开通区域里' }
  const CABINS = PROFIT_CABINS
  const pitch = num(opts.pitch, num(data.pitch, 71)) || 71
  const cruise = num(data.model && data.model.cruiseSpeed, 850) || 850
  const seatCap = num(data.seatCap, 0) || Math.floor(num(data.model && data.model.seats, 230) * 79 / pitch)
  // 买机时引擎用「机型座位数」当空间上限（validateCabinLayout(layout, model.seats)），
  // 只有改舱才按 pitch 算（getCabinSeatCapacity）。所以出的配舱必须 ≤ modelSeats，否则买机报
  // 「客舱配置不合法或超出空间容量。」
  const modelSeats = num(data.model && data.model.seats, 230) || 230
  const buySpace = Math.min(seatCap, modelSeats)
  const coeff = data.coeff || { F: 10, J: 4, S: 1.7, Y: 1 }
  const space = data.space || { F: 6, J: 3, S: 1.5, Y: 1 }
  const basePerKm = num(data.basePerKm, 0.77) || 0.77
  const rep = num(data.reputation)
  const repFactor = 1 + (rep / 100 - 0.5) * 0.2
  const top = Math.max(1, Math.floor(num(opts.top, 5)))
  const lfTarget = clamp(num(opts.lfTarget, num(opts.minLF, 0.85)), 0.3, 1)
  const turn = num(opts.turn, 60)
  const firstMin = num(opts.firstMin, 300)
  const lastArr = num(opts.lastArr, 1395)
  const maxLegs = num(opts.maxLegs, 10)

  const fareOf = (km, c, m) => Math.round(km * basePerKm * num(coeff[c], 1) * repFactor * num(m, 1))
  const kOf = (c, m) => clamp(Math.pow(num(m, 1), -num(PROFIT_ELAST[c], 1)), 0.5, 1.8)
  // 航时一律按「候选机型巡航速度」算：时刻表里那条线的 flightTime 可能是别的机型飞出来的
  // （实测 3312km 在 B737 上是 265 分、B757 是 234 分），按 265 估会把段数算少
  const ftOf = (row) => Math.max(30, Math.round(num(row.km, 0) / cruise * 60))
  const legsOf = (ft) => {
    if (!(ft > 0)) return 2
    let n = Math.floor((lastArr - firstMin + turn) / (ft + turn))
    n = Math.min(maxLegs, n)
    if (n % 2 === 1) n -= 1
    return Math.max(2, n)
  }

  const oneRoute = (row) => {
    const ft = ftOf(row)
    const legs = legsOf(ft)
    const pool = {}
    for (const c of CABINS) pool[c] = Math.max(0, num(row.byCabin && row.byCabin[c]))
    const poolTotal = CABINS.reduce((t, c) => t + pool[c], 0)
    const routeRep = row.routeRep != null ? clamp(num(row.routeRep), 0, 100) : clamp(45 + rep / 5 + (row.exists ? 10 : 0), 0, 100)
    const lfBase = clamp((routeRep / 100) * 1.1, 0, 1)
    const parkFreeFrom = Math.max(0, num(row.parkCapFrom) - num(row.parkedFrom))
    const parkFreeTo = Math.max(0, num(row.parkCapTo) - num(row.parkedTo))
    const base = {
      rank: 0, from: row.from, to: row.to, km: Math.round(num(row.km, 0)), intl: !!row.intl, level: row.level || 'normal',
      exists: !!row.exists, rid: row.rid || null, acCount: Math.max(0, Math.round(num(row.acCount))),
      demand: { total: poolTotal, F: pool.F, J: pool.J, S: pool.S, Y: pool.Y },
      ftMin: ft, legs: legs, seats: seatCap, buySpace: buySpace, canRetrofit: seatCap > buySpace,
      createCost: row.createCost == null ? null : +num(row.createCost).toFixed(2),
      parkFree: { from: parkFreeFrom, to: parkFreeTo, sum: parkFreeFrom + parkFreeTo }
    }
    if (poolTotal <= 0) {
      return Object.assign(base, { revPerPlane: 0, paxPerPlane: 0, lf: lfBase, capacityAircraft: 0, canAdd: 0, note: '这条线没有需求数据（新线且算不出需求）→ 没意义' })
    }
    let best = null
    for (let iy = 0; iy <= 20; iy++) {
      const mY = +(0.60 + iy * 0.05).toFixed(2)
      const lf = clamp(lfBase * fareIntentOf(mY), 0, 1)
      for (let is = 0; is <= 10; is++) {
        const mS = +(1.0 + is * 0.1).toFixed(2)
        const mults = { F: 2, J: 2, S: mS, Y: mY }
        let layout
        try {
          layout = bestCabin({ seats: buySpace, legs: legs, demand: pool, fares: mults, space: space, coeff: coeff, elastic: PROFIT_ELAST, minY: 12 }).layout
        } catch (e) {
          continue
        }
        let rev = 0
        let pax = 0
        const perC = {}
        for (const c of CABINS) {
          const seatsDay = num(layout[c], 0) * legs
          const p = Math.max(0, Math.min(seatsDay, pool[c], Math.round(lf * seatsDay * kOf(c, mults[c]))))
          perC[c] = p
          pax += p
          rev += p * fareOf(base.km, c, mults[c])
        }
        const score = rev / 10000
        if (!best || score > best.score + 1e-9) best = { score: score, pax: pax, lf: lf, mults: mults, layout: layout, perC: perC }
      }
    }
    if (!best) return Object.assign(base, { revPerPlane: 0, paxPerPlane: 0, lf: lfBase, capacityAircraft: 0, canAdd: 0, note: '配舱算不出来 → 跳过' })
    const fares = {}
    for (const c of CABINS) fares[c] = { mult: best.mults[c], yuan: fareOf(base.km, c, best.mults[c]) }
    // 需求侧能养几架：每架按目标 LF 能吃 seatCap × legs × lfTarget 人
    const perPlanePax = Math.max(1, Math.round(seatCap * legs * lfTarget))
    const capacityAircraft = Math.max(1, Math.floor(poolTotal / perPlanePax))
    const canAdd = Math.max(0, capacityAircraft - base.acCount)
    let note = ''
    if (base.acCount > 0 && canAdd === 0) note = '已吃满，别再加'
    else if (base.acCount > 0) note = '还能加 ' + canAdd + ' 架'
    else if (base.exists) note = '还没排飞机'
    else note = '能上 ' + canAdd + ' 架'
    const lfReal = seatCap > 0 && legs > 0 ? clamp(best.pax / (seatCap * legs), 0, 1) : 0
    if (best.lf < 0.6) note += '；按最优票价卖不满（概率 LF ' + Math.round(best.lf * 100) + '%）'
    return Object.assign(base, {
      revPerPlane: +best.score.toFixed(2), paxPerPlane: Math.round(best.pax), lf: +best.lf.toFixed(3),
      lfRealized: +lfReal.toFixed(3), util: +(legs * ft / 1440).toFixed(3),
      layout: best.layout, mults: best.mults, fares: fares,
      capacityAircraft: capacityAircraft, canAdd: canAdd,
      paybackDays: (!base.exists && base.createCost != null && best.score > 0.01) ? Math.max(1, Math.round(base.createCost / best.score)) : null,
      score: +(best.score * (canAdd > 0 ? 1 : 0.5)).toFixed(2), note: note
    })
  }

  const scored = rowsIn.map(oneRoute).map((r) => (r.score == null ? Object.assign({}, r, { score: r.revPerPlane || 0 }) : r))
  scored.sort((a, b) => (b.score || 0) - (a.score || 0))
  const picked = scored.slice(0, top).map((r, i) => Object.assign({}, r, { rank: i + 1 }))
  const from = (data.froms && data.froms[0]) || opts.from || ''
  return {
    ok: true,
    kind: 'route-dev',
    from: from,
    model: { name: (data.model && data.model.name) || data.modelName || 'B757-200', seats: num(data.model && data.model.seats), cruise: cruise, seatCap: seatCap, pitch: pitch },
    unlocked: data.unlocked || [],
    money: num(data.money),
    candidates: scored.length,
    assumptions: {
      window: Math.floor(firstMin / 60) + ':' + String(firstMin % 60).padStart(2, '0') + '–' + String(Math.floor(lastArr / 60)).padStart(2, '0') + ':' + String(lastArr % 60).padStart(2, '0'),
      turn: turn, evenLegs: true, lfTarget: lfTarget, seatCap: seatCap, pitch: pitch,
      demand: '当日分舱需求池（已开线用 route.demandByCabin；新线用 calculateDemandByCabin）',
      lfBasis: 'LF = 航线声誉/100 × 1.1 × fareIntent(Y)（换乘/健康按满值，偏乐观上限）'
    },
    top: picked,
    note: '按「每架飞机日收入 × 是否还有扩容空间」排序；F/J 倍率固定 2.0，S/Y 是引擎真值最优'
  }
}

// ---- 一键部署：成本估算（纯函数）----
// 单价 = 机体 + 装备 + 改舱；N 架按等比级数（每买 1 架全场 ×1.015）；开线费按「要补的方向」相加
export function deployCost(opts = {}) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const count = Math.max(1, Math.floor(n(opts.count) || 1))
  const unit = n(opts.modelPrice) + n(opts.equipmentPrice) + n(opts.cabinCost)
  const buyTotal = count <= 1 ? unit : unit * (Math.pow(1.015, count) - 1) / 0.015
  const directions = opts.directions == null ? (opts.both === false ? 1 : 2) : Math.max(0, Math.floor(n(opts.directions)))
  const createCost = n(opts.createCost) * (directions > 0 ? directions : 0)
  const total = buyTotal + createCost
  const money = n(opts.money)
  const floor = opts.cashFloor == null ? null : n(opts.cashFloor)
  return {
    ok: true,
    count: count,
    unit: +unit.toFixed(2),
    buyTotal: +buyTotal.toFixed(2),
    directions: directions,
    createCost: +createCost.toFixed(2),
    total: +total.toFixed(2),
    money: +money.toFixed(2),
    after: +(money - total).toFixed(2),
    cashFloor: floor,
    underFloor: floor == null ? null : (money - total) < floor,
    canAfford: money >= total,
  }
}

export function cityOf(name) {
  let s = String(name || '').replace(/国际机场$/, '').replace(/机场$/, '').trim()
  if (!s) return ''
  for (const c of CITY_SORTED) if (s.indexOf(c) === 0) return c
  for (const c of CITY_3) if (s.indexOf(c) === 0) return c
  return s
}

/**
 * 输入 AIRCRAFT_ROUTES_EXPR 的 aircraft[]，产出改名计划：
 *   名字 = 主力航线的「起-降」城市；同一对城市有多架时加 ②③…；闲置机不参与
 */
export function buildRenamePlan(list) {
  const rows = (list || []).map((a) => {
    const pairs = new Map()
    for (const l of (a.legs || [])) {
      if (!l.from || !l.to) continue
      const key = [cityOf(l.from), cityOf(l.to)].sort().join('|')
      const cur = pairs.get(key) || { from: l.from, to: l.to, n: 0 }
      cur.n += l.n
      pairs.set(key, cur)
    }
    const sorted = [...pairs.values()].sort((x, y) => y.n - x.n)
    const main = sorted[0] || null
    return {
      id: a.id, reg: a.reg, model: a.model, legs: a.totalLegs,
      from: main ? main.from : null, to: main ? main.to : null,
      cities: main ? [cityOf(main.from), cityOf(main.to)] : [],
      otherPairs: Math.max(0, sorted.length - 1),
      name: main ? [cityOf(main.from), cityOf(main.to)].join('-') : null,
      reason: main ? null : '闲置（0 段/日）',
    }
  })
  // 闲置机保留原名，名字要避开它们
  const taken = new Set(rows.filter((r) => !r.name).map((r) => String(r.reg).trim()))
  const groups = new Map()
  for (const r of rows) if (r.name) { if (!groups.has(r.name)) groups.set(r.name, []); groups.get(r.name).push(r) }
  for (const [name, arr] of groups) {
    if (arr.length === 1) {
      let final = name
      let i = 1
      while (taken.has(final) && i < CIRCLE.length) { final = name + CIRCLE[i]; i++ }
      arr[0].name = final
      taken.add(final)
      continue
    }
    arr.forEach((r, idx) => {
      const final = name + (CIRCLE[idx + 1] || ('-' + (idx + 1)))
      r.name = final
      taken.add(final)
    })
  }
  const changed = rows.filter((r) => r.name && r.name !== String(r.reg).trim())
  return {
    rows,
    changed: changed.length,
    renamed: changed.map((r) => ({ id: r.id, from: r.reg, to: r.name, cities: r.cities, legs: r.legs })),
    skipped: rows.filter((r) => !r.name).map((r) => ({ id: r.id, reg: r.reg, reason: r.reason })),
    pairs: rows.filter((r) => r.otherPairs > 0).map((r) => ({ reg: r.reg, name: r.name, otherPairs: r.otherPairs })),
    note: '名字 = 当天班表里腿数最多的那对「起降城市」；同城市对多机加 ②③；闲置机不动',
  }
}
