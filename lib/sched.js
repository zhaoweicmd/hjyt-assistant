// 一键排班核心算法（纯函数，不碰页面）
//
// 输入：
//   ac        { id, reg, base, seats }
//   route     { ab, ba, from, to, ftAb, ftBa, demand }
//   occupied  7 个元素，每个元素是 [{ap, t}] —— 已被占用的起飞时刻
//   opts      { turn, firstMin, lastArr, maxLegs, minLegs }
//
// 输出：
//   { ok:true, L, T, legs:[{rid, from, to, dep, arr, ft}], reason }
//
// 硬约束（对应设计稿第九节）：
//   C1 周期 P = 航时 + 过站（不能用最小间隔反推）
//   C2 base 在 A：A 起飞 T, T+2P, T+4P…；对端 B 起飞 T+P, T+3P…
//   C3 同一机场起飞时刻两两间隔 ≥ 该机场最小起飞间隔
//   C4 末班落地 ≤ lastArr
//   C5 所有时刻必须是有限数

export const DEFAULT_OPTS = {
  turn: 75,        // 过站分钟（宽体 75 / 窄体 60）
  firstMin: 5,     // 每机首班最早 00:05
  lastArr: 1390,   // 末班落地 ≤ 23:10
  maxLegs: 10,
  minLegs: 2,
  // 单机日利用率上限（飞行分钟/1440）。报告实测：利用率 87% 的飞机每班晚 75.8 分，
  // 64% 的只晚 8.9 分 → 「排满 1440 分」是过时结论，现行 ≤70%（清单:41/43/210）
  maxUtil: 0.85,   // 默认 85%（优先吃满运力）；报告实测保守值 0.70，可传 maxUtil:0.7
  // 维修位闸门：夜停机场必须有维修位（引擎只在有空闲维修位时才修；normal 机场=0）。
  // 报告/停场窗口与维修排班规则.md 维修四查 C1/C3。
  requireMaint: true,
  // 必须回起飞机场过夜（偶数段）：奇数段会把飞机留外站，和次日首段错位
  // 用户 2026-10-20 指令：「排班在一天一定要是偶数段」→ 默认开
  requireReturn: true,
}

function conflicts(occupied, ap, t, need) {
  const list = occupied[0] || []
  for (let i = 0; i < list.length; i++) {
    const o = list[i]
    if (o.ap !== ap) continue
    if (Math.abs(o.t - t) < need) return o
  }
  return null
}

// 生成某个方案的时刻序列
function buildSeq(base, other, ftBase, ftOther, L, T, P) {
  const legs = []
  for (let k = 0; k < L; k++) {
    const atBase = k % 2 === 0
    const dep = T + k * P
    const ft = atBase ? ftBase : ftOther
    const arr = dep + ft
    legs.push({ atBase, dep, arr, ft })
  }
  return legs
}

/**
 * 为单架飞机搜索可行方案。成功返回 ok:true 与 legs。
 */
export function planOne(ac, route, occupied, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts }
  // 起飞城市：默认从飞机所在/归属机场起飞；opts.startAt 可强制指定航线某一端（排班面板的「起飞」开关）
  const base = o.startAt || ac.base
  if (!base) return { ok: false, reason: '飞机没有 base 机场（baseAirport 与 currentAirport 都为空）' }
  const other = base === route.from ? route.to : base === route.to ? route.from : null
  if (!other) return { ok: false, reason: `飞机 base=${base} 不在这条航线上（${route.from}↔${route.to}）` }

  // 航时按「这架飞机自己的巡航速度」现算：引擎实测 flightTime = round(km / cruiseSpeed * 60)
  //   B757-200 850km/h → 1100km 78 分；B737 MAX 8 750 → 88 分；C909 700 → 94 分。
  //   旧代码用 state.ft（只拿一架 probe 飞机算所有航线的航时）→ B757 被按 88 分排，
  //   一天最多只能排 6 段，而同样这条线手工排能排 8 段（用户 2026-10-20 实测对比）。
  const kmRoute = Number(route.km) || 0
  const cruiseAc = Number(ac.cruise) || 0
  const ftBySpeed = (kmRoute > 0 && cruiseAc > 0) ? Math.round(kmRoute / cruiseAc * 60) : null
  const ftBase = ftBySpeed || (base === route.from ? route.ftAb : route.ftBa)
  const ftOther = ftBySpeed || (base === route.from ? route.ftBa : route.ftAb)
  // 段的方向必须跟着「从哪一端起飞」走：base 是 to 端时，去程用 ba、回程用 ab
  const ridFromBase = base === route.from ? route.ab : route.ba
  const ridFromOther = base === route.from ? route.ba : route.ab
  if (!Number.isFinite(ftBase) || !Number.isFinite(ftOther)) {
    return { ok: false, reason: '航时不是有限数（C5）——请先确认航线数据' }
  }

  const P = Math.max(ftBase, ftOther) + o.turn
  const needOf = (ap) => (occupied.need && occupied.need[ap] != null ? occupied.need[ap] : 40)
  let sawNoMaint = null
  let sawCap = null
  // 维修位产能（用户 2026-10-19 口径）：
  //   夜间停靠维修 → 每机场最多 = 维修位数（2 个位 = 2 架）
  //   白天停靠维修 → 另算一个班次，上限 = 维修位 × 2
  const capOf = (ap, mode) => {
    if (!o.maintCap) return Infinity
    const slots = Number(o.maintCap[ap])
    if (!Number.isFinite(slots) || slots <= 0) return Infinity
    return mode === 'day' ? slots * 2 : slots
  }
  // 健康度够高的飞机不占维修位（只是过夜），只有真要修的才吃产能
  const selfNeedsMaint = Number(ac.health == null ? 100 : ac.health) < 95
  const capOk = (ap, mode) => {
    if (!selfNeedsMaint) return true
    const cap = capOf(ap, mode)
    if (!Number.isFinite(cap)) return true
    const load = (o.maintLoad && Number(o.maintLoad[ap])) || 0
    return load + 1 <= cap
  }

  for (let L = o.maxLegs; L >= o.minLegs; L--) {
    // 必须回起飞机场过夜（requireReturn）：段数从 base 交替飞，奇数段会停在外站 →
    // 外站常没维修位，次日首段又在基地 = 位置错位（实测会记严重延误）。偶数段才回得来。
    if (o.requireReturn && L % 2 !== 0) continue
    // 末段落地 = T + (L-1)*P + ft(last)
    const lastFt = (L - 1) % 2 === 0 ? ftBase : ftOther
    const maxT = o.lastArr - (L - 1) * P - lastFt
    for (let T = o.firstMin; T <= maxT; T++) {
      const seq = buildSeq(base, other, ftBase, ftOther, L, T, P)
      let bad = null
      for (const s of seq) {
        if (!Number.isFinite(s.dep) || !Number.isFinite(s.arr)) { bad = { reason: 'C5 时刻非有限数' }; break }
        const ap = s.atBase ? base : other
        const c = conflicts(occupied, ap, s.dep, needOf(ap))
        if (c) { bad = { ap, t: s.dep, other: c }; break }
      }
      if (bad) continue
      let legs = seq.map((s) => ({
        rid: s.atBase ? ridFromBase : ridFromOther,
        from: s.atBase ? base : other,
        to: s.atBase ? other : base,
        dep: s.dep,
        arr: s.arr,
        ft: s.ft,
      }))
      // 维修窗口：引擎只要求「停靠 + 距下一班 ≥3h + 有机位」，不分昼夜
      //   night = 保证末班到次日首班之间 ≥ need 分钟（免费，优先）
      //   day   = 在白天强行留出一段空档（把维修位的日产能翻倍，但少飞几段）
      let maintWindow = null
      const mt = o.maintenance
      if (mt && mt.mode === 'day') {
        const s0 = Number(mt.dayStart != null ? mt.dayStart : 600)
        const len = Number(mt.need || 180)
        // 白天维修：不删段，而是把「第一段起飞落在窗口之后的航班」整体后挪，让飞机在
        // 地面连续停 len 分钟（引擎的判定是「停靠 + 距下一班 ≥ 3h + 有空闲维修位」，不看钟点）。
        // 停靠机场 = 该航班的起飞机场（也就是上一段的落地机场）——旧写法记成了「起飞机场」
        // 还一律等到 s0+len 起飞，既认错机场又白等 1~2 小时（2026-10-20 实测：B757 北京-上海
        // 手工排 8 段，插件只排 6 段）。
        let shifted = null
        let winAt = null
        for (let extra = 0; extra <= 60; extra += 5) {
          let shift = 0
          let wAt = null
          let prevArr = null
          const out = []
          let bad = false
          for (const l of legs) {
            const dep0 = l.dep + shift
            if (wAt == null && dep0 > s0) {
              // 停靠时长从「上一段的落地时刻」算起（这一段的起飞时刻不算停机）
              wAt = l.from
              const fromArr = prevArr == null ? dep0 - o.turn : prevArr
              const target = Math.max(s0 + len, fromArr + len) + extra
              shift += target - dep0
            }
            const dep = l.dep + shift
            const arr = l.arr + shift
            const c0 = conflicts(occupied, l.from, dep, needOf(l.from))
            if (c0) { bad = true; break }
            out.push(Object.assign({}, l, { dep, arr }))
            prevArr = arr
          }
          if (bad) continue
          if (!out.length) continue
          if (out[out.length - 1].arr > o.lastArr) continue
          shifted = out
          winAt = wAt
          break
        }
        if (!shifted) continue
        let at = winAt
        if (!at) {
          for (const l of shifted) if (l.arr <= s0) at = l.to
          at = at || base
        }
        const slotsAtDay = (occupied.maint && occupied.maint[at] != null) ? Number(occupied.maint[at]) : null
        if (o.requireMaint !== false && slotsAtDay != null && slotsAtDay <= 0) { sawNoMaint = at; continue }
        if (!capOk(at, 'day')) { sawCap = at; continue }
        legs = shifted
        maintWindow = { mode: 'day', start: s0, end: s0 + len, at }
      } else if (mt && mt.mode === 'night') {
        const lastArr2 = legs.length ? legs[legs.length - 1].arr : T
        const nightGap = (1440 - lastArr2) + T
        const need = Number(mt.need || 180)
        if (nightGap < need) continue
        if (!capOk(base, 'night')) { sawCap = base; continue }
        maintWindow = { mode: 'night', gapMin: nightGap, need, start: lastArr2, end: 1440 + T, at: base }
      }
      // 利用率闸门：飞行分钟 / 1440 ≤ maxUtil（默认 0.70）。超过就少排 1 段重试。
      if (Number(o.maxUtil) > 0) {
        const ftSum = legs.reduce((t, l) => t + Number(l.ft || 0), 0)
        if (ftSum > Number(o.maxUtil) * 1440) continue
      }
      // 维修位闸门（四查 C1/C3）：夜停机场必须有维修位，否则这架机永远进不了维修
      // （引擎只在「当前机场有空闲维修位」时启动维修；正常机场 maintenanceSlots=0）
      if (o.requireMaint !== false && occupied.maint && (!mt || mt.mode === 'night')) {
        const nightAp = legs[legs.length - 1].to
        const slots = occupied.maint[nightAp]
        if (slots != null && Number(slots) <= 0) {
          sawNoMaint = nightAp
          continue // 换段数/时段，尽量让飞机回有维修位的机场过夜
        }
      }
      return { ok: true, L: legs.length, T, P, legs, maint: maintWindow }
    }
  }
  // 只能排出奇数段、但「一天必须偶数段」→ 说清差在哪儿（别笼统回「排不下」）
  if (o.requireReturn) {
    const alt = planOne(ac, route, occupied, Object.assign({}, o, { requireReturn: false }))
    if (alt && alt.ok) {
      const lastTo = alt.legs[alt.legs.length - 1].to
      let why = ''
      if (sawNoMaint) why = '；偶数段要回「' + base + '」过夜，而「' + sawNoMaint + '」没有维修位（C1/C3）'
      else if (sawCap) why = '；偶数段要回「' + base + '」过夜，而「' + sawCap + '」维修位已排满'
      return {
        ok: false,
        oddOnly: alt.legs.length,
        oddNightAt: lastTo,
        reason: '只能排出 ' + alt.legs.length + ' 段（奇数段：末段停在「' + lastTo + '」，回不到 ' + base + '）；排班要求「一天必须偶数段」→ 不排' + why + '。换另一端起飞，或给「' + base + '」加维修位/升基地',
      }
    }
  }
  if (sawCap && !sawNoMaint) {
    return { ok: false, needMaintCap: sawCap, reason: '「' + sawCap + '」的维修位已经排满（夜间 = 维修位数、白天 = 维修位×2 班次），再加这架就得排队；换另一端起飞、或改白天窗口、或先把别架挪走' }
  }
  if (sawNoMaint) {
    return {
      ok: false,
      reason: '维修机场「' + sawNoMaint + '」没有维修位（maintenanceSlots=0），按维修四查 C1/C3 不排（夜停或白天停场都得在有维修位的机场）；先调回有维修位的机场、或把该机场升级，或允许外站过夜（allowNoMaint）',
      needMaint: sawNoMaint,
    }
  }
  return { ok: false, reason: '没有可行的起飞槽位（机场间隔饱和或时段不够），建议减段/换线/升基地' }
}

/** 把方案写进占用表，供下一架飞机避让 */
export function occupy(occupied, legs) {
  for (const d of occupied) {
    for (const l of legs) d.push({ ap: l.from, t: l.dep })
  }
}

/** 方案表里的预计日贡献（粗估）：段数 × 座位 × 客座率 × 票价里程收益 */
export function estimateDaily(legs, seats, demand, coverage) {
  // 收益 ∝ 座位 × 客座率；需求越高、现有覆盖越低，客座率越高
  const load = Math.min(0.9, Math.max(0.55, 0.55 + 0.35 * (coverage < 0.3 ? 0.6 : 0.3)))
  const perPaxKm = 0.6 // 均价折算：Y 舱 0.6 × BASE_FARE 0.77 ≈ 0.46 元/座公里，含 F/J 上浮取 0.6
  let total = 0
  for (const l of legs) total += seats * load * (l.ft / 60) * 0.77 * 8 * perPaxKm * 0.6
  return Math.round(total)
}

/**
 * 整队排班：state 来自页面 STATE_EXPR，返回方案数组（不改页面）。
 * opts: { mode, aircraftIds, minLegsNow, routeId, routeName, turn, firstMin, lastArr, maxLegs, minLegs }
 */
export function planFleet(state, opts = {}) {
  const explicitIds = Array.isArray(opts.aircraftIds) && opts.aircraftIds.length ? opts.aircraftIds : null
  const mode = opts.mode || 'underused'
  const minLegsNow = Number(opts.minLegsNow || 4)

  // 判「闲置」一律看整周段数：expr 只给了周一（legs）时会被「周一空、周二~日有班」骗到
  const weekLegs = (a) => Number(a && (a.legsWeek != null ? a.legsWeek : a.legs) || 0)
  let targets
  if (explicitIds) targets = state.aircraft.filter((a) => explicitIds.includes(a.id))
  else if (mode === 'idle') targets = state.aircraft.filter((a) => weekLegs(a) === 0)
  else if (mode === 'all') targets = state.aircraft.slice()
  else targets = state.aircraft.filter((a) => weekLegs(a) < minLegsNow)

  if (!targets.length) {
    return { plans: [], issues: [], targets: 0, note: `没有需要排班的飞机（mode=${mode}）` }
  }

  const seen = new Set()
  const routes = []
  for (const r of state.routes) {
    if (seen.has(r.id)) continue
    const rev = state.routes.find((x) => x.from === r.to && x.to === r.from)
    if (rev) seen.add(rev.id)
    seen.add(r.id)
    routes.push({ ab: r.id, ba: rev ? rev.id : r.id, from: r.from, to: r.to, km: r.km, demand: r.demand, ftAb: state.ft[r.id], ftBa: rev ? state.ft[rev.id] : state.ft[r.id] })
  }
  const seatsServed = Object.assign({}, state.routeSeats || {})
  const occupied = [0, 1, 2, 3, 4, 5, 6].map((wd) => (state.occ[wd] || []).slice())
  occupied.need = state.need
  occupied.maint = state.maint || null

  // 「改排」时要把这架飞机自己的旧起飞时刻从占用表里摘掉，否则它会绕着自己的旧班表排
  // （实测：同一架 B757 带着旧班表排 → 00:40 起飞、空档 318 分、只有 8 段里 5 段前置；
  //   摘掉旧班表 → 00:05 起飞、空档正好 180 分。占用表里只有当天[0]，其余天无影响）
  const occFor = (acId) => {
    const occ2 = occupied.slice()
    occ2[0] = (occupied[0] || []).filter((o) => !o || o.id !== acId)
    occ2.need = occupied.need
    occ2.maint = occupied.maint
    return occ2
  }

  // 过站分钟：支持固定值、'auto'（宽体/窄体分开）、或 (ac) => 分钟
  const turnOf = (ac) => {
    if (typeof opts.turn === 'function') return Number(opts.turn(ac)) || DEFAULT_OPTS.turn
    if (opts.turn === 'auto') return ac.wide ? Number(opts.turnWide || 75) : Number(opts.turnNarrow || 60)
    return Number(opts.turn || DEFAULT_OPTS.turn)
  }

  const opts2 = {
    turn: Number(opts.turn && opts.turn !== 'auto' ? opts.turn : DEFAULT_OPTS.turn),
    firstMin: Number(opts.firstMin || DEFAULT_OPTS.firstMin),
    lastArr: Number(opts.lastArr || DEFAULT_OPTS.lastArr),
    maxLegs: Number(opts.maxLegs || DEFAULT_OPTS.maxLegs),
    minLegs: Number(opts.minLegs || DEFAULT_OPTS.minLegs),
    maxUtil: opts.maxUtil != null ? Number(opts.maxUtil) : DEFAULT_OPTS.maxUtil,
    requireMaint: opts.requireMaint != null ? !!opts.requireMaint : DEFAULT_OPTS.requireMaint,
    startAt: opts.startAt || null,
    requireReturn: opts.requireReturn != null ? !!opts.requireReturn : DEFAULT_OPTS.requireReturn,
    maintCap: opts.maintCap || null,
    maintLoad: opts.maintLoad || null,
    maintenance: opts.maintenance || null,
  }

  const fixedRoute = opts.routeId ? routes.find((r) => r.ab === opts.routeId || r.ba === opts.routeId) : null
  const plans = []

  for (const ac of targets) {
    let route = fixedRoute
    if (!route && opts.routeName) route = routes.find((r) => `${r.from}↔${r.to}`.includes(opts.routeName) || `${r.from}-${r.to}`.includes(opts.routeName))
    if (!route) {
      const cand = routes
        .filter((r) => r.from === ac.base || r.to === ac.base)
        .map((r) => ({ r, gap: (r.demand || 0) - ((seatsServed[r.ab] || 0) + (seatsServed[r.ba] || 0)) }))
        .filter((x) => Number.isFinite(x.r.ftAb))
        .sort((a, b) => b.gap - a.gap)
      route = cand.length ? cand[0].r : null
    }
    if (!route) { plans.push({ ac: ac.reg, id: ac.id, ok: false, reason: '该机基地没有可用航线（或航时缺失）' }); continue }

    const p = planOne(ac, route, occFor(ac.id), Object.assign({}, opts2, { turn: turnOf(ac) }))
    if (!p.ok) {
      plans.push({
        ac: ac.reg, id: ac.id, route: `${route.from}↔${route.to}`, ok: false, reason: p.reason,
        needMaint: p.needMaint || null,
        oddOnly: p.oddOnly || null, oddNightAt: p.oddNightAt || null,
      })
      continue
    }
    occupy(occupied, p.legs)
    for (const l of p.legs) seatsServed[l.rid] = (seatsServed[l.rid] || 0) + ac.seats
    plans.push({
      ac: ac.reg, id: ac.id, ok: true, maint: p.maint || null,
      route: `${route.from}↔${route.to}`,
      demand: route.demand,
      legs: p.L,
      first: p.legs[0].dep,
      last: p.legs[p.legs.length - 1].arr,
      nightAirport: p.legs[p.legs.length - 1].to,
      maintAtNight: occupied.maint ? Number(occupied.maint[p.legs[p.legs.length - 1].to]) : null,
      seq: p.legs.map((l) => `${l.from.slice(0, 2)}${l.dep}`).join(' / '),
      detail: p.legs,
    })
  }

  return {
    plans,
    issues: plans.filter((x) => !x.ok).map((x) => `${x.ac}：${x.reason}`),
    targets: targets.length,
    opts: opts2,
  }
}
