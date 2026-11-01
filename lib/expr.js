// 页面侧表达式（通用版：不假设任何一个存档、机队、机场或脚本目录）
//
// 约定：
//   - 游戏把 `GameState` 声明成全局词法绑定（const），不是 window 属性，
//     所以一律用 `typeof GameState !== 'undefined' ? GameState : window.GameState` 取。
//   - 所有表达式返回 JSON 字符串（CDP returnByValue 直接拿字符串再 JSON.parse）。
//   - 不读本地脚本、不依赖 `脚本与数据/`，只依赖游戏引擎自身的公开函数与数据。

const G_PRELUDE = `const G = (typeof GameState !== 'undefined') ? GameState : window.GameState;
  if (!G) return JSON.stringify({ ok: false, reason: 'GameState 未就绪（页面还停在主菜单/选档界面）' });
  const live = (G.aircrafts || []).filter(a => a && !a.hasSold);
  const sched = G.schedule || {};
  const segsOf = (id, wd) => {
    const d = sched[id];
    if (!Array.isArray(d)) return [];
    const day = d[wd === undefined ? 0 : wd];
    return Array.isArray(day) ? day.filter(s => s && !s.cancelled) : [];
  };
  const allRoutes = Array.isArray(G.routes) ? G.routes : Object.values(G.routes || {});
  const ridMap = {};
  for (const r of allRoutes) ridMap[r.id] = r;`

const STATUS_EXPR = `(() => {
  ${G_PRELUDE}
  let legs = 0;
  for (const a of live) legs += segsOf(a.id, 0).length;
  const t = new Date(G.gameTime);
  const date = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
  const hs = live.map(a => Number(a.health != null ? a.health : 100));
  // 各基地在用飞机数（通用：按 baseAirport 聚合，不再写死任何一个机场名）
  const bases = {};
  for (const a of live) {
    const b = a.baseAirport || a.currentAirport || '(未编基地)';
    bases[b] = (bases[b] || 0) + 1;
  }
  const homeBase = Object.keys(bases).sort((x, y) => bases[y] - bases[x])[0] || null;
  // 日耗油：按当天每段的实际航距 × 机型油耗系数估算（不再用固定 6800L）
  let fuelPerDay = 0;
  for (const a of live) {
    const m = (typeof getAircraftModel === 'function') ? (getAircraftModel(a.modelId || a.model) || {}) : {};
    const fc = Number(m.fuelConsumption) || 4.8;
    for (const s of segsOf(a.id, 0)) {
      const r = ridMap[s.routeId];
      const km = r ? Number(r.distance || r.km || 0) : 0;
      fuelPerDay += 6800 * (km ? km / 1233 : 1) * (fc / 4.8);
    }
  }
  const fuelCap = Number(G.fuelCapacity || 0);
  const fuel = Number(G.fuelRemaining || 0);
  return JSON.stringify({
    ok: true,
    date,
    gameTime: G.gameTime,
    cash: +(G.money || 0).toFixed(2),
    reputation: +(G.reputation || 0).toFixed(2),
    fleet: live.length,
    legsPerDay: legs,
    bases,
    homeBase,
    healthMin: hs.length ? Math.min.apply(null, hs) : 100,
    healthAvg: hs.length ? +(hs.reduce((a, b) => a + b, 0) / hs.length).toFixed(1) : 100,
    delays: { medium: G.mediumDelayDays || 0, severe: G.severeDelayDays || 0 },
    fuel: { liters: fuel, capacity: fuelCap, perDay: Math.round(fuelPerDay), days: fuelPerDay ? +(fuel / fuelPerDay).toFixed(2) : null },
    fuelPrice: Number(G.fuelPrice || G.currentFuelPrice || 0),
    points: G.airportPoints || 0,
    routes: allRoutes.filter(r => r.moduleId !== 'cargo').length,
    faultSystem: G.faultSystemEnabled,
    unlocked: G.unlockedRegions || [],
    region: G.startRegion || null
  })
})()`

// 油库专用：实耗 / 容量 / 阶梯报价 / 油价历史（v0.4 油库向导用）
const FUEL_EXPR = `(() => {
  ${G_PRELUDE}
  // 排班估算日耗（和 STATUS_EXPR 同一套公式，作为「昨日实耗」缺失时的兜底）
  let fuelPerDay = 0;
  for (const a of live) {
    const m = (typeof getAircraftModel === 'function') ? (getAircraftModel(a.modelId || a.model) || {}) : {};
    const fc = Number(m.fuelConsumption) || 4.8;
    for (const s of segsOf(a.id, 0)) {
      const r = ridMap[s.routeId];
      const km = r ? Number(r.distance || r.km || 0) : 0;
      fuelPerDay += 6800 * (km ? km / 1233 : 1) * (fc / 4.8);
    }
  }
  const cap = Number(G.fuelCapacity || 0);
  let up = null;
  try { if (typeof getFuelUpgradeInfo === 'function') up = getFuelUpgradeInfo(cap) } catch (e) {}
  const hist = (G.fuelPriceHistory || []).slice(-7).map(function (h) {
    return { day: h && h.dateKey ? String(h.dateKey).slice(0, 15) : null, price: +(Number(h && h.price) || 0).toFixed(2) }
  });
  return JSON.stringify({
    ok: true,
    price: Number(G.fuelPrice || G.currentFuelPrice || 0),
    capacity: cap,
    fuel: Number(G.fuelRemaining || 0),
    consumedYesterday: Number(G.fuelConsumedYesterday || 0),
    consumedToday: Number(G.fuelConsumedToday || 0),
    perDay: Math.round(fuelPerDay),
    cash: Number(G.money || 0),
    upgrade: up ? { addCapacity: Number(up.addCapacity || 0), newCapacity: Number(up.newCapacity || 0), costWan: Number(up.costWan || 0) } : null,
    priceHistory: hist
  })
})()`

const STATE_EXPR = `(() => {
  ${G_PRELUDE}
  // 机场最小起飞间隔（按等级现算，绝不写死）
  const need = {};
  // 维修位（引擎只在「当前机场有空闲维修位」时启动维修 → 夜停机场没位就永远修不了）
  const maint = {}, maintUsed = {}, inspCap = {}, maintSpeed = {};
  for (const [name, ap] of Object.entries(G.airports || {})) {
    const lv = (ap && ap.level) || 'normal';
    const cfg = (typeof AIRPORT_LEVELS !== 'undefined' && AIRPORT_LEVELS[lv]) || null;
    need[name] = cfg ? cfg.minDepartureInterval : 40;
    maint[name] = Number(ap && ap.maintenanceSlots) || 0;
    maintUsed[name] = Number(ap && ap.maintenanceUsed) || 0;
    inspCap[name] = Number(ap && ap.inspectionSlots) || 0;
    maintSpeed[name] = Number(ap && ap.maintenanceSpeed) || 1;
  }
  // 已占用的起飞时刻（7 天分别统计）
  const occ = [[], [], [], [], [], [], []];
  for (const a of live) {
    for (let wd = 0; wd < 7; wd++) {
      for (const s of segsOf(a.id, wd)) {
        const r = ridMap[s.routeId];
        if (!r) continue;
        occ[wd].push({ ap: r.from, t: s.departureMin, id: a.id });
      }
    }
  }
  const routeInfo = allRoutes.map(r => ({ id: r.id, from: r.from, to: r.to, km: Number(r.distance || r.km || 0), demand: r.dailyDemand || 0 }));
  // 航时用引擎现算，不信缓存
  const ftOf = {};
  const probeAc = live[0] ? live[0].id : null;
  if (probeAc) {
    for (const r of routeInfo) {
      try {
        const seg = buildScheduleFlightSegment(probeAc, 0, r.id, 300);
        if (seg && seg.segment && Number.isFinite(seg.segment.flightTime)) ftOf[r.id] = seg.segment.flightTime;
      } catch (e) {}
    }
  }
  // 航线 → 起点机场（查「首段起飞地 ≠ 飞机所在地」用）
  const routeFrom = {}, routeTo = {};
  for (const r of routeInfo) { routeFrom[r.id] = r.from; routeTo[r.id] = r.to; }
  const aircraftInfo = live.map(a => {
    const d0 = segsOf(a.id, 0);
    // 整周段数：判「闲置」必须看 7 天合计。只看周一（d0）会把「周二~周日有班、周一空着」的飞机
    // 当成闲置挂到排班面板上（2026-10-25 实测：全队 72 架全有班表，面板却列出 8 架「闲置」）
    const legsByDay = [0, 0, 0, 0, 0, 0, 0];
    for (let wd = 0; wd < 7; wd++) legsByDay[wd] = segsOf(a.id, wd).filter(x => x && !x.cancelled).length;
    const legsWeek = legsByDay.reduce((x, y) => x + y, 0);
    let wide = false, range = null, fc = null, cruise = null;
    try {
      const m = getAircraftModel(a.modelId || a.model);
      wide = !!(m && m.isWideBody);
      range = m && Number(m.range) ? Number(m.range) : null;
      fc = m && Number(m.fuelConsumption) ? Number(m.fuelConsumption) : null;
      // 巡航速度：引擎的航时 = round(km / cruiseSpeed * 60)，按机型不同（B757 850→78 分、B737 750→88、C909 700→94）
      cruise = m && Number(m.cruiseSpeed) ? Number(m.cruiseSpeed) : null;
    } catch (e) {}
    return {
      id: a.id,
      reg: a.regName || a.id,
      // 在飞的飞机 currentAirport 是 null，但 flight.to 是它马上要落地的机场 →
      // 用它兜底，否则「改排」永远报「飞机没有 base 机场」
      base: a.baseAirport || a.currentAirport || (a.flight && a.flight.to) || null,
      baseAirport: a.baseAirport || null,
      cur: a.currentAirport || (a.flight && a.flight.to) || null,
      flightTo: (a.flight && a.flight.to) || null,
      seats: Object.values(a.cabinLayout || {}).reduce((x, y) => x + (Number(y) || 0), 0),
      status: a.status,
      health: a.health,
      legs: d0.length,
      legsWeek, legsByDay,
      first: d0.length ? Math.min.apply(null, d0.map(x => x.departureMin)) : null,
      last: d0.length ? Math.max.apply(null, d0.map(x => x.arrivalMin)) : null,
      routeIds: Array.from(new Set(d0.map(x => x.routeId))),
      model: a.modelId || a.model || '',
      wide, range, fc, cruise
    };
  });
  // 夜停机场（末段落地）与首段起点：给「维修位负载」「位置错配」用
  for (const info of aircraftInfo) {
    info.nightTo = null;
    const list = segsOf(info.id, 0).filter(function (x) { return x && !x.cancelled; });
    if (list.length) {
      let last = list[0];
      for (const x of list) if (x.arrivalMin > last.arrivalMin) last = x;
      const direct = allRoutes.find(function (r) { return String(r.id) === String(last.routeId); });
      info.nightTo = direct && direct.to ? direct.to : null;
    }
  }
  // 当日首段的起飞机场：直接查 allRoutes（不用 routeFrom 映射，实测映射里取不到 from）
  for (const info of aircraftInfo) {
    info.firstFrom = null;
    const list = segsOf(info.id, 0).filter(function (x) { return x && !x.cancelled; });
    if (list.length) {
      let first = list[0];
      for (const x of list) if (x.departureMin < first.departureMin) first = x;
      const direct = allRoutes.find(function (r) { return String(r.id) === String(first.routeId); });
      info.firstFrom = direct && direct.from ? direct.from : null;
    }
  }
  const routeSeats = {};
  for (const info of aircraftInfo) {
    for (const seg of segsOf(info.id, 0)) routeSeats[seg.routeId] = (routeSeats[seg.routeId] || 0) + info.seats;
  }
  const maintSlotsOut = {}; for (const [nm, ap2] of Object.entries(G.airports || {})) maintSlotsOut[nm] = Number(ap2 && ap2.maintenanceSlots) || 0;
  return JSON.stringify({ ok: true, aircraft: aircraftInfo, routes: routeInfo, maintSlots: maintSlotsOut, ft: ftOf, need, occ, routeSeats, money: G.money, maint, maintUsed, inspCap, maintSpeed, groundTurn: (typeof GROUND_TURNAROUND !== 'undefined' ? GROUND_TURNAROUND : 50) })
})()`

// 全量排查：最小过站 / 末班落地 / 机场起飞间隔（纯页面侧，不依赖任何本地脚本）
const AUDIT_EXPR = `(() => {
  ${G_PRELUDE}
  const need = {};
  for (const [name, ap] of Object.entries(G.airports || {})) {
    const lv = (ap && ap.level) || 'normal';
    const cfg = (typeof AIRPORT_LEVELS !== 'undefined' && AIRPORT_LEVELS[lv]) || null;
    need[name] = cfg ? cfg.minDepartureInterval : 40;
  }
  const GROUND = (typeof GROUND_TURNAROUND !== 'undefined' ? GROUND_TURNAROUND : 50);
  const stopIssues = [];
  const intervalIssues = [];
  let legs = 0, minStop = 1e9, maxArr = -1;
  for (const a of live) {
    for (let wd = 0; wd < 7; wd++) {
      const segs = segsOf(a.id, wd).slice().sort((x, y) => x.departureMin - y.departureMin);
      if (wd === 0) legs += segs.length;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (wd === 0) maxArr = Math.max(maxArr, s.arrivalMin);
        if (i > 0) {
          const stop = s.departureMin - segs[i - 1].arrivalMin;
          if (stop < minStop) minStop = stop;
          if (stop < GROUND) stopIssues.push({ ac: a.regName || a.id, wd, stop, prev: segs[i - 1].routeId, next: s.routeId });
        }
        if (s.arrivalMin >= 1440) stopIssues.push({ ac: a.regName || a.id, wd, stop: null, prev: '跨日', next: s.routeId, arr: s.arrivalMin });
      }
    }
  }
  // 机场起飞间隔：按天、按机场两两比较
  for (let wd = 0; wd < 7; wd++) {
    const byAp = {};
    for (const a of live) {
      for (const s of segsOf(a.id, wd)) {
        const r = ridMap[s.routeId];
        if (!r) continue;
        (byAp[r.from] = byAp[r.from] || []).push({ t: s.departureMin, ac: a.regName || a.id });
      }
    }
    for (const [ap, list] of Object.entries(byAp)) {
      const req = need[ap] == null ? 40 : need[ap];
      list.sort((x, y) => x.t - y.t);
      for (let i = 1; i < list.length; i++) {
        const gap = list[i].t - list[i - 1].t;
        if (gap < req) intervalIssues.push({ ap, wd, gap, req, a: list[i - 1], b: list[i] });
      }
    }
  }
  return JSON.stringify({ ok: true, fleet: live.length, legsDay0: legs, minStop: minStop === 1e9 ? null : minStop, maxArr, stopIssues: stopIssues.slice(0, 20), intervalIssues: intervalIssues.slice(0, 20), stopCount: stopIssues.length, intervalCount: intervalIssues.length, groundTurn: GROUND })
})()`

// 游戏内自带校验：时刻表对话框「校验」按钮（verifyScheduleEdit）走的就是 validateFullSchedule，
// 规则 = a 跨日/当日航线相连 + b 周日→周一闭环 + c 相邻航班周转 ≥ GROUND_TURNAROUND(50 分)
//        + d 机场最小起飞间隔（软警告）+ e 机场停靠上限（软警告）+ 航程检查
// 返回：passed（全绿）/ partial（只有软警告，游戏里显示「⚠️ 通过校验，可能晚点」）/
//       confirmable（无硬错误，游戏里才允许「确认」）/ 逐段问题 day/seg/type/text
const GAME_VALIDATE_EXPR = (ids) => `(() => {
  ${G_PRELUDE}
  const ids = ${JSON.stringify(Array.isArray(ids) ? ids : [ids])};
  if (typeof validateFullSchedule !== 'function') {
    return JSON.stringify({ ok: false, reason: '页面没有 validateFullSchedule：这版游戏不支持游戏内校验' });
  }
  const items = [];
  for (const id of ids) {
    const ac = live.find(a => a.id === id) || null;
    const item = { id: id, reg: ac ? ac.regName : null, legs: 0, ok: false };
    if (!sched[id]) { item.reason = '这架飞机没有时刻表'; items.push(item); continue; }
    for (let d = 0; d < 7; d++) item.legs += segsOf(id, d).length;
    if (!item.legs) { item.reason = '时刻表是空的'; items.push(item); continue; }
    let r = null;
    try { r = validateFullSchedule(id) || {}; } catch (e) { item.reason = '校验抛错：' + String((e && e.message) || e); items.push(item); continue; }
    const issues = [];
    for (const key of Object.keys(r.issues || {})) {
      const kp = String(key).split('-');
      const day = Number(kp[0]);
      const seg = Number(kp[1]);
      for (const it of (r.issues[key] || [])) {
        issues.push({ day: day, seg: seg, type: (it && it.type) || 'error', text: (it && it.text) || '' });
      }
    }
    item.ok = true;
    item.passed = !!r.passed;
    item.partial = !!r.partial;
    item.confirmable = !!r.confirmable;
    item.hasHardError = !!r.hasHardError;
    item.hasSoftWarning = !!r.hasSoftWarning;
    item.issues = issues;
    item.dayWarnings = r.dayWarnings || {};
    items.push(item);
  }
  return JSON.stringify({ ok: true, items: items });
})()`

// 推进一天（引擎自带 advanceGameTime，任何存档都能用；不依赖 tick_day.js）
const tickExpr = (secondsPerStep = 3600, steps = 24) => `(() => {
  ${G_PRELUDE}
  const snap = () => ({
    money: +(G.money || 0),
    rep: +(G.reputation || 0),
    med: G.mediumDelayDays || 0,
    sev: G.severeDelayDays || 0,
    fuel: +(G.fuelRemaining || 0),
    points: G.airportPoints || 0,
    t: G.gameTime
  });
  const before = snap();
  const hs0 = live.map(a => Number(a.health != null ? a.health : 100));
  const legs = live.reduce((n, a) => n + segsOf(a.id, 0).length, 0);
  const t0 = Date.now();
  for (let i = 0; i < ${steps}; i++) advanceGameTime(${secondsPerStep});
  const after = snap();
  const hs1 = live.map(a => Number(a.health != null ? a.health : 100));
  const maint = live.filter(a => a.maintenanceStatus && a.maintenanceStatus !== 'none').length;
  const insp = live.filter(a => a.inspectionStatus && a.inspectionStatus !== 'none').length;
  return JSON.stringify({
    ok: true,
    dateKey: (function () { const d = new Date(before.t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') })(),
    dateEnd: String(after.t),
    ms: Date.now() - t0,
    cashBefore: +before.money.toFixed(2),
    cashAfter: +after.money.toFixed(2),
    cashDelta: +(after.money - before.money).toFixed(2),
    reputation: +after.rep.toFixed(2),
    repDelta: +(after.rep - before.rep).toFixed(2),
    ledger: { flights: legs },
    delay: { med: after.med, sev: after.sev, deltaMed: after.med - before.med, deltaSev: after.sev - before.sev, settledTotal: (G.delay && G.delay.yesterdayTotalMaxDelay) || 0 },
    fuel: { before: Math.round(before.fuel), after: Math.round(after.fuel), capacity: G.fuelCapacity },
    healthMin: hs1.length ? +Math.min.apply(null, hs1).toFixed(2) : 100,
    healthDrop: hs0.length ? +(Math.min.apply(null, hs0) - Math.min.apply(null, hs1)).toFixed(2) : 0,
    maintCount: maint,
    inspCount: insp,
    points: after.points
  })
})()`

// ---------------------------------------------------------------------------
// v0.3 新增：买机向导 / 开线向导 / 排班体检 / 日贡献看板
// ---------------------------------------------------------------------------

// 买机向导数据源：机型目录（现价+硬件报价）、基地容量、航线周收入、成本均摊
const BUY_EXPR = `(() => {
  ${G_PRELUDE}
  const moduleId = G.currentModule || 'passenger';
  const M = (typeof AIRCRAFT_MODELS !== 'undefined') ? AIRCRAFT_MODELS : (window.AIRCRAFT_MODELS || {});
  const key2 = (ms) => { const d = new Date(Number(ms)); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const apOf = G.airports || {};
  const intv = {}, parkCap = {}, hangCap = {};
  for (const [name, ap] of Object.entries(apOf)) {
    if (!ap) continue;
    const lv = ap.level || 'normal';
    const c = (typeof AIRPORT_LEVELS !== 'undefined' && AIRPORT_LEVELS[lv]) || null;
    intv[name] = c ? c.minDepartureInterval : 40;
    parkCap[name] = (typeof getAirportMaxParked === 'function') ? getAirportMaxParked(ap) : (c ? c.maxParked : 2);
    hangCap[name] = (typeof getAirportHangarCapacity === 'function') ? getAirportHangarCapacity(ap) : (c ? c.hangarCapacity : 0);
  }
  // ---- 机型目录（只留当前模块可运营的）----
  const models = [];
  for (const [name, m] of Object.entries(M)) {
    let operable = false;
    try { operable = !!canOperateAircraft(name, moduleId); } catch (e) { operable = false; }
    if (!operable) continue;
    let price = null;
    try { price = Number(getAircraftCurrentPrice(name, moduleId)); } catch (e) { price = null; }
    let caps = null;
    try { caps = getAircraftEquipmentCapabilities(name); } catch (e) { caps = null; }
    const engineProfiles = caps && caps.engineProfiles ? caps.engineProfiles : ['standard'];
    const eq = {
      version: 1,
      winglets: !!(caps && (caps.factoryWinglets || caps.winglets)),
      engineProfile: engineProfiles.indexOf('efficiency') >= 0 ? 'efficiency' : 'standard',
      wifi: !!(caps && caps.wifi),
      ptv: !!(caps && caps.ptv)
    };
    let quote = null;
    try {
      const q = getAircraftFactoryEquipmentQuote(name, eq);
      quote = q && q.success ? { totalPrice: q.totalPrice, equipmentCost: q.equipmentCost, installationCost: q.installationCost, changes: q.changes || [] } : { err: (q && q.msg) || '报价失败' };
    } catch (e) { quote = { err: String((e && e.message) || e) }; }
    models.push({
      name, seats: m.seats, range: m.range, cruiseSpeed: m.cruiseSpeed, fuelConsumption: m.fuelConsumption,
      isWideBody: !!m.isWideBody, category: m.category, basePrice: m.price, price, eq, quote,
      caps: {
        supported: !!(caps && caps.supported),
        winglets: !!(caps && caps.winglets), wifi: !!(caps && caps.wifi), ptv: !!(caps && caps.ptv),
        engineProfiles: engineProfiles
      }
    });
  }
  // ---- 基地容量与在用 ----
  const bases = [];
  for (const [name, ap] of Object.entries(apOf)) {
    if (!ap) continue;
    const lv = ap.level || 'normal';
    if (lv === 'normal') continue;
    const based = live.filter(a => a.baseAirport === name);
    const here = live.filter(a => a.currentAirport === name);
    bases.push({
      name, level: lv, throughput: ap.throughput || 0, isInternational: !!ap.isInternational, region: ap.region || 'china',
      minInterval: intv[name], hangarCap: hangCap[name], hangarUsed: based.length, hangarLeft: Math.max(0, (hangCap[name] || 0) - based.length),
      parkedCap: parkCap[name], parkedNow: here.length, parkedLeft: Math.max(0, (parkCap[name] || 0) - here.length)
    });
  }
  // ---- 航线：周统计 + 已排座位 ----
  const seatsOf = (a) => Object.values(a.cabinLayout || {}).reduce(function (x, y) { return x + (Number(y) || 0); }, 0);
  const wk = G.routeWeeklyStats || {};
  const seatsByRoute = {}, flightsByRoute = {};
  for (const a of live) for (let d = 0; d < 7; d++) for (const s of segsOf(a.id, d)) {
    if (!s.routeId) continue;
    seatsByRoute[s.routeId] = (seatsByRoute[s.routeId] || 0) + seatsOf(a);
    flightsByRoute[s.routeId] = (flightsByRoute[s.routeId] || 0) + 1;
  }
  const routes = [];
  for (const r of allRoutes) {
    if ((r.routeKind || 'passenger') !== 'passenger') continue;
    const from = apOf[r.from] || {}, to = apOf[r.to] || {};
    const km = Number(r.distance || r.distanceKm) || ((from.lat && to.lat && typeof haversineDistance === 'function') ? haversineDistance(from.lat, from.lng, to.lat, to.lng) : 0);
    const st = wk[String(r.id)] || null;
    routes.push({
      id: String(r.id), from: r.from, to: r.to, km: Math.round(km),
      demand: Number(r.dailyDemand || 0), remaining: Number(r.remainingDemand || 0),
      seatsWeek: seatsByRoute[String(r.id)] || 0, flightsWeek: flightsByRoute[String(r.id)] || 0,
      wk: st ? { flights: st.flights || 0, seats: st.seats || 0, passengers: st.passengers || 0, revenue: Number(st.revenue) || 0 } : null,
      fromLevel: from.level || 'normal', toLevel: to.level || 'normal', toIntl: !!to.isInternational, needFrom: intv[r.from], needTo: intv[r.to]
    });
  }
  // ---- 成本均摊（模块当日统计 / 当日段数）----
  const modStats = (G.modules && G.modules[moduleId] && G.modules[moduleId].dailyStats) || [];
  // 只取「已结账」的天（当日那条 revenue 还是 0，成本却已经开始记），最多 7 天取均值
  const closed = modStats.filter(function (s) { return Number(s && s.revenue) > 0; }).slice(-7);
  let legsAll = 0, kmAll = 0, fcWeighted = 0;
  const fcOf = (a) => {
    try { const m = getAircraftModel(a.modelId || a.model); return Number(m && m.fuelConsumption) || 4.8; } catch (e) { return 4.8; }
  };
  for (const a of live) {
    const d0 = segsOf(a.id, 0);
    legsAll += d0.length;
    const fc = fcOf(a);
    for (const s of d0) {
      const r = ridMap[s.routeId];
      if (r) kmAll += Number(r.distance || r.distanceKm || 0);
      fcWeighted += fc;
    }
  }
  let cost = null;
  if (closed.length) {
    const sumAbs = function (k) { let t = 0; for (const s of closed) t += Math.abs(Number(s[k]) || 0); return t; };
    const n = closed.length;
    const rev = sumAbs('revenue'), fuelC = sumAbs('fuelExpense'), cat = sumAbs('cateringExpense'), mtc = sumAbs('maintenanceCost');
    cost = {
      days: n,
      from: closed[0].date ? (typeof closed[0].date === 'string' ? closed[0].date : key2(closed[0].date)) : null,
      to: closed[n - 1].date ? (typeof closed[n - 1].date === 'string' ? closed[n - 1].date : key2(closed[n - 1].date)) : null,
      revenue: +(rev / n).toFixed(2),
      fuel: +(fuelC / n).toFixed(2),
      catering: +(cat / n).toFixed(2),
      maint: +(mtc / n).toFixed(2),
      equipment: +(sumAbs('equipmentExpense') / n).toFixed(2),
      compensation: +(sumAbs('compensation') / n).toFixed(2),
      lease: +(sumAbs('leaseExpense') / n).toFixed(2),
      legs: legsAll,
      perLegRevenue: legsAll ? +(rev / n / legsAll).toFixed(3) : null,
      perLegFuel: legsAll ? +(fuelC / n / legsAll).toFixed(3) : null,
      perLegCatering: legsAll ? +(cat / n / legsAll).toFixed(3) : null,
      perLegMaint: legsAll ? +(mtc / n / legsAll).toFixed(3) : null
    };
  }
  return JSON.stringify({
    ok: true,
    module: moduleId,
    date: key2(G.gameTime),
    dayIndex: (G.dailyHistory || []).length,
    money: Number(G.money || 0),
    online: !!(typeof AirlineOnline !== 'undefined' && AirlineOnline && AirlineOnline.active),
    fuel: {
      remaining: Number(G.fuelRemaining || 0), capacity: Number(G.fuelCapacity || 0), price: Number(G.fuelPrice || 0),
      consumedYesterday: Number(G.fuelConsumedYesterday || 0), consumedToday: Number(G.fuelConsumedToday || 0)
    },
    fleet: {
      count: live.length, legsDay0: legsAll, kmDay0: Math.round(kmAll), fcAvg: legsAll ? fcWeighted / legsAll : 4.8,
      avgKmPerLeg: legsAll ? kmAll / legsAll : 1200,
      seatAvg: live.length ? Math.round(live.reduce(function (t, a) { return t + seatsOf(a); }, 0) / live.length) : 160,
      wideCount: live.filter(function (a) { return seatsOf(a) > 240; }).length,
      // 全队周客座率（购机闸门 LF≥89% 用；只统计有周统计的航线）
      lf7: (function () {
        let pax = 0, seats = 0;
        for (const k of Object.keys(wk)) { const s = wk[k] || {}; pax += Number(s.passengers || 0); seats += Number(s.seats || 0) }
        return seats > 0 ? +(pax / seats).toFixed(3) : null;
      })(),
      // 每条航线已经投放了几架（单航线对 ≤2 架闸门用）
      aircraftByRoute: (function () {
        const set = {};
        for (const a of live) for (let d = 0; d < 7; d++) for (const s of segsOf(a.id, d)) {
          if (!s.routeId) continue;
          (set[String(s.routeId)] = set[String(s.routeId)] || {})[a.id] = 1;
        }
        const out = {};
        for (const k of Object.keys(set)) out[k] = Object.keys(set[k]).length;
        return out;
      })()
    },
    models, bases, routes, cost,
    groundTurn: (typeof GROUND_TURNAROUND !== 'undefined' ? GROUND_TURNAROUND : 50),
    reputation: Number(G.reputation || 0),
    thresholds: {
      domestic: (typeof getDemandThreshold === 'function' ? getDemandThreshold(false) : 180),
      international: (typeof getDemandThreshold === 'function' ? getDemandThreshold(true) : 250)
    }
  });
})()`

// 开线向导数据源：从若干出发点按需求公式现算候选航线（含新城市）
const routeExpr = (opts = {}) => {
  const froms = JSON.stringify(Array.isArray(opts.fromAirports) ? opts.fromAirports : [])
  const maxDest = Number(opts.maxDestinations || 90)
  return `(() => {
  ${G_PRELUDE}
  const froms = ${froms};
  const maxDest = ${maxDest};
  const unlocked = (G.unlockedRegions && G.unlockedRegions.length) ? G.unlockedRegions : ['china'];
  const apOf = G.airports || {};
  const intv = {}, parkCap = {}, hangCap = {}, lvOf = {};
  for (const [name, ap] of Object.entries(apOf)) {
    if (!ap) continue;
    const lv = ap.level || 'normal';
    lvOf[name] = lv;
    const c = (typeof AIRPORT_LEVELS !== 'undefined' && AIRPORT_LEVELS[lv]) || null;
    intv[name] = c ? c.minDepartureInterval : 40;
    parkCap[name] = (typeof getAirportMaxParked === 'function') ? getAirportMaxParked(ap) : (c ? c.maxParked : 2);
    hangCap[name] = (typeof getAirportHangarCapacity === 'function') ? getAirportHangarCapacity(ap) : (c ? c.hangarCapacity : 0);
  }
  const pk = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  const existing = {};
  for (const r of allRoutes) existing[pk(r.from, r.to)] = String(r.id);
  const destPool = Object.keys(apOf).filter(function (n) {
    const a = apOf[n];
    if (!a) return false;
    const reg = a.region || 'china';
    if (unlocked.indexOf(reg) < 0) return false;
    if (typeof isAirportAvailable === 'function') { try { if (!isAirportAvailable(n)) return false; } catch (e) { return false; } }
    return true;
  }).sort(function (x, y) { return (apOf[y].throughput || 0) - (apOf[x].throughput || 0); }).slice(0, maxDest);
  const pairs = [];
  for (const f of froms) {
    const fa = apOf[f];
    if (!fa) continue;
    for (const d of destPool) {
      if (d === f) continue;
      const da = apOf[d];
      if (!da) continue;
      if (!Number.isFinite(Number(fa.lat)) || !Number.isFinite(Number(da.lat))) continue;
      const km = haversineDistance(fa.lat, fa.lng, da.lat, da.lng);
      if (!(km > 0)) continue;
      let demand = 0, own = 0;
      try { demand = calculateDailyDemand(fa.throughput || 0, da.throughput || 0, shouldUseDistanceDecay(fa, da), km); } catch (e) { demand = 0; }
      try { own = getOwnDemand(demand); } catch (e) { own = demand; }
      let cost = null;
      try { cost = getRouteCreateCost(km); } catch (e) { cost = null; }
      pairs.push({
        from: f, to: d, km: Math.round(km), demand: Math.round(demand), own: Math.round(own), cost: cost == null ? null : +Number(cost).toFixed(2),
        exists: existing[pk(f, d)] || null, toLevel: lvOf[d] || 'normal', toIntl: !!da.isInternational, toRegion: da.region || 'china',
        needTo: intv[d], needFrom: intv[f]
      });
    }
  }
  const bases = [];
  for (const [name, ap] of Object.entries(apOf)) {
    if (!ap) continue;
    const lv = ap.level || 'normal';
    if (lv === 'normal') continue;
    bases.push({ name, level: lv, throughput: ap.throughput || 0, hangarCap: hangCap[name], hangarUsed: live.filter(a => a.baseAirport === name).length, parkedCap: parkCap[name], parkedNow: live.filter(a => a.currentAirport === name).length, minInterval: intv[name] });
  }
  return JSON.stringify({
    ok: true,
    froms: froms,
    destCount: destPool.length,
    pairs: pairs,
    bases: bases,
    money: Number(G.money || 0),
    reputation: Number(G.reputation || 0),
    unlocked: unlocked,
    thresholds: { domestic: (typeof getDemandThreshold === 'function' ? getDemandThreshold(false) : 180), international: (typeof getDemandThreshold === 'function' ? getDemandThreshold(true) : 250) },
    models: (function () {
      const M = (typeof AIRCRAFT_MODELS !== 'undefined') ? AIRCRAFT_MODELS : (window.AIRCRAFT_MODELS || {});
      const out = [];
      for (const [name, m] of Object.entries(M)) {
        let ok2 = false;
        try { ok2 = !!canOperateAircraft(name, G.currentModule || 'passenger'); } catch (e) { ok2 = false; }
        if (!ok2) continue;
        let price = null;
        try { price = Number(getAircraftCurrentPrice(name, G.currentModule || 'passenger')); } catch (e) {}
        out.push({ name, seats: m.seats, range: m.range, cruiseSpeed: m.cruiseSpeed, price });
      }
      return out;
    })()
  });
})()`
}

// 排班体检数据源：欠排 / 末班过早 / 过站偏紧 / 夜停超容 / 间隔余量
const HEALTH_EXPR = `(() => {
  ${G_PRELUDE}
  const GROUND = (typeof GROUND_TURNAROUND !== 'undefined' ? GROUND_TURNAROUND : 50);
  const key2 = (ms) => { const d = new Date(Number(ms)); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const need = {}, parkCap = {}, hangCap = {};
  for (const [name, ap] of Object.entries(G.airports || {})) {
    if (!ap) continue;
    const lv = ap.level || 'normal';
    const c = (typeof AIRPORT_LEVELS !== 'undefined' && AIRPORT_LEVELS[lv]) || null;
    need[name] = c ? c.minDepartureInterval : 40;
    parkCap[name] = (typeof getAirportMaxParked === 'function') ? getAirportMaxParked(ap) : (c ? c.maxParked : 2);
    hangCap[name] = (typeof getAirportHangarCapacity === 'function') ? getAirportHangarCapacity(ap) : (c ? c.hangarCapacity : 0);
  }
  const routeFrom = {}, routeTo = {};
  for (const r of (G.routes || [])) { routeFrom[String(r.id)] = r.from; routeTo[String(r.id)] = r.to; }
  const aircraft = [];
  const issues = { idle: [], underused: [], tightStop: [], overflow: [] };
  const nightOf = {};
  for (const a of live) {
    const name = a.modelId || a.model || '';
    let wide = false;
    try { const m = getAircraftModel(name); wide = !!(m && m.isWideBody); } catch (e) {}
    const d0 = segsOf(a.id, 0).slice().sort(function (x, y) { return x.departureMin - y.departureMin; });
    const seats = Object.values(a.cabinLayout || {}).reduce(function (x, y) { return x + (Number(y) || 0); }, 0);
    const first = d0.length ? d0[0].departureMin : null;
    const last = d0.length ? Math.max.apply(null, d0.map(function (x) { return x.arrivalMin; })) : null;
    let minStop = null;
    for (let i = 1; i < d0.length; i++) { const st = d0[i].departureMin - d0[i - 1].arrivalMin; if (minStop == null || st < minStop) minStop = st; }
    const turnWant = wide ? 75 : 60;
    const base = a.baseAirport || a.currentAirport || '(未编基地)';
    let blockMin = 0;
    for (const s of d0) blockMin += Math.max(0, Number(s.arrivalMin) - Number(s.departureMin));
    const row = {
      id: a.id, reg: a.regName || a.id, base, model: name, seats, wide, status: a.status, health: Number(a.health),
      legs: d0.length, first, last, minStop, turnWant, blockMin, util: +(blockMin / 1440).toFixed(3),
      spanMin: (first != null && last != null) ? last - first : null,
      routes: Array.from(new Set(d0.map(function (x) { return x.routeId; }))),
      // 检修/检测/延误三组状态（五项校验用）
      faultStatus: a.faultStatus || 'none',
      faultResolved: !!a.faultResolved,
      maintenanceStatus: a.maintenanceStatus || 'none',
      inspectionStatus: a.inspectionStatus || 'none',
      todayMaxDelay: Number(a.todayMaxDelay || 0),
      curAirport: a.currentAirport || null,
      firstFrom: d0.length ? (routeFrom[String(d0[0].routeId)] || null) : null,
      nightTo: d0.length ? (routeTo[String(d0[d0.length - 1].routeId)] || null) : null,
      ferry: (G.ferryState || {})[a.id] || null,
    };
    aircraft.push(row);
    (nightOf[base] = nightOf[base] || []).push(row);
    if (!d0.length) issues.idle.push(row);
    else {
      if (d0.length <= 2) issues.underused.push(row);
      if (minStop != null && minStop < turnWant) issues.tightStop.push(row);
    }
  }
  const maintSlots = {};
  for (const [name, ap] of Object.entries(G.airports || {})) maintSlots[name] = Number(ap && ap.maintenanceSlots) || 0;
  const airportsOut = Object.keys(nightOf).map(function (name) {
    const list = nightOf[name];
    const cap = parkCap[name] == null ? null : parkCap[name];
    const idle = list.filter(function (r) { return r.legs === 0; }).map(function (r) { return r.reg; });
    return { name, parked: list.length, parkedCap: cap, over: (cap == null ? null : Math.max(0, list.length - cap)), hangarCap: hangCap[name] == null ? null : hangCap[name], idle };
  });
  for (const ap of airportsOut) if (ap.over && ap.over > 0) issues.overflow.push(ap);
  // 机场起飞间隔余量（7 天里最紧的一次）
  const gaps = {};
  for (let wd = 0; wd < 7; wd++) {
    const byAp = {};
    for (const a of live) for (const s of segsOf(a.id, wd)) {
      const r = ridMap[s.routeId];
      if (!r) continue;
      (byAp[r.from] = byAp[r.from] || []).push({ t: s.departureMin, ac: a.regName || a.id });
    }
    for (const apName of Object.keys(byAp)) {
      const list = byAp[apName].sort(function (x, y) { return x.t - y.t; });
      const req = need[apName] == null ? 40 : need[apName];
      const cur = gaps[apName] || (gaps[apName] = { req, min: null, wd: null, count: 0, depCount: list.length });
      cur.count++;
      for (let i = 1; i < list.length; i++) {
        const gap = list[i].t - list[i - 1].t;
        if (cur.min == null || gap < cur.min) { cur.min = gap; cur.wd = wd; cur.minPair = [list[i - 1].ac, list[i].ac]; cur.minTimes = [list[i - 1].t, list[i].t]; }
      }
      for (const it of list) cur.depCount = cur.depCount || list.length;
    }
  }
  for (const k of Object.keys(gaps)) gaps[k].ok = (gaps[k].min == null) ? true : gaps[k].min >= gaps[k].req;
  let legsDay0 = 0;
  for (const a of live) legsDay0 += segsOf(a.id, 0).length;
  return JSON.stringify({
    ok: true, date: key2(G.gameTime), fleet: live.length, legsDay0, groundTurn: GROUND,
    // 游戏是否被暂停：引擎弹「临时航班」对话框、载入存档、用户点暂停都会置 true，
    // 暂停期间时间不动、所有航班都不起飞（2026-10-20 实测：北京-上海卡了两天就是这么来的）
    paused: !!G.isPaused,
    aircraft, airports: airportsOut, gaps, issues, maintSlots,
    money: Number(G.money || 0), reputation: Number(G.reputation || 0),
    routes: allRoutes.length,
    delay: { med: G.mediumDelayDays || 0, sev: G.severeDelayDays || 0 },
    // 五项校验（报告/每日推进校验规则.md）要用的字段：检修状态、单机最大延误、运营预警
    fuel: { remaining: Number(G.fuelRemaining || 0), capacity: Number(G.fuelCapacity || 0), price: Number(G.fuelPrice || 0), consumedYesterday: Number(G.fuelConsumedYesterday || 0) },
    points: G.airportPoints || 0,
    alerts: (function () {
      try {
        const al = (typeof getOperationsAlerts === 'function') ? getOperationsAlerts() : null;
        if (!al || !al.groups) return [];
        return al.groups.map(function (g) { return { id: g.id, title: g.title, items: (g.items || []).map(function (it) { return { severity: it.severity || 'info', title: it.title, reason: it.reason } }) } });
      } catch (e) { return []; }
    })()
  });
})()`

// 日贡献看板数据源：日收入/成本/现金/油/航线周统计
const boardExpr = (days = 14) => `(() => {
  ${G_PRELUDE}
  const N = ${days};
  const key2 = (ms) => { const d = new Date(Number(ms)); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const daily = (G.dailyHistory || []).slice(-N).map(function (h) {
    return { day: (h.date == null ? null : (typeof h.date === 'string' ? h.date : key2(h.date))), revenue: +(Number(h.revenue) || 0).toFixed(2), passengers: Number(h.passengers) || 0, fuelCost: +(Number(h.fuelCost) || 0).toFixed(2) };
  });
  const cash = (G.cashHistory || []).slice(-N).map(function (h) { return { day: h.day || null, balance: +(Number(h.balanceWan) || 0).toFixed(2) }; });
  const modules = {};
  for (const id of Object.keys(G.modules || {})) {
    const m = G.modules[id] || {};
    const st = m.dailyStats || [];
    if (!st.length) continue;
    modules[id] = st.slice(-N).map(function (s) {
      return {
        day: (s.date == null ? null : (typeof s.date === 'string' ? s.date : key2(s.date))),
        revenue: +(Number(s.revenue) || 0).toFixed(2),
        passengers: Number(s.passengers) || 0,
        fuel: +(Number(s.fuelExpense) || 0).toFixed(2),
        catering: +(Number(s.cateringExpense) || 0).toFixed(2),
        maint: +(Number(s.maintenanceCost) || 0).toFixed(2),
        equipment: +(Number(s.equipmentExpense) || 0).toFixed(2),
        compensation: +(Number(s.compensation) || 0).toFixed(2),
        lease: +(Number(s.leaseExpense) || 0).toFixed(2),
        subsidy: +(Number(s.routeSubsidyIncome) || 0).toFixed(2),
        alliance: +(Number(s.allianceFee) || 0).toFixed(2),
        order: +(Number(s.orderRevenue) || 0).toFixed(2),
        event: +(Number(s.eventReward) || 0).toFixed(2)
      };
    });
  }
  const wk = G.routeWeeklyStats || {};
  const routes = [];
  for (const r of allRoutes) {
    if ((r.routeKind || 'passenger') !== 'passenger') continue;
    const from = (G.airports || {})[r.from] || {}, to = (G.airports || {})[r.to] || {};
    const km = Number(r.distance || r.distanceKm) || ((from.lat && to.lat && typeof haversineDistance === 'function') ? haversineDistance(from.lat, from.lng, to.lat, to.lng) : 0);
    const st = wk[String(r.id)] || null;
    routes.push({
      id: String(r.id), from: r.from, to: r.to, km: Math.round(km), demand: Number(r.dailyDemand || 0),
      wk: st ? { flights: Number(st.flights) || 0, seats: Number(st.seats) || 0, passengers: Number(st.passengers) || 0, revenue: +(Number(st.revenue) || 0).toFixed(2) } : null
    });
  }
  const priceHistory = (G.fuelPriceHistory || []).slice(-N).map(function (h) {
    return { day: h.day || (h.date == null ? null : (typeof h.date === 'string' ? h.date : key2(h.date))), price: +(Number(h.price) || 0).toFixed(3) };
  });
  return JSON.stringify({
    ok: true, date: key2(G.gameTime), money: Number(G.money || 0), daily, cash, modules, routes,
    fuel: { price: Number(G.fuelPrice || 0), history: priceHistory, consumedYesterday: Number(G.fuelConsumedYesterday || 0), consumedToday: Number(G.fuelConsumedToday || 0), remaining: Number(G.fuelRemaining || 0), capacity: Number(G.fuelCapacity || 0) },
    delay: { med: G.mediumDelayDays || 0, sev: G.severeDelayDays || 0 },
    reputation: Number(G.reputation || 0),
    fleet: live.length
  });
})()`

// 当前在游戏里“选中”的航线：先看列表高亮项，再退回 _currentRouteDetailId，最后用详情标题兜底
const SELECTED_ROUTE_EXPR = `(() => {
  const G = (typeof GameState !== 'undefined') ? GameState : window.GameState;
  let rid = null, how = null;
  try {
    const sel = document.querySelector('.route-item.selected');
    if (sel) { rid = sel.getAttribute('data-route-id') || sel.getAttribute('data-id'); if (rid) how = 'list'; }
  } catch (e) {}
  if (!rid) {
    try { if (typeof _currentRouteDetailId !== 'undefined' && _currentRouteDetailId) { rid = String(_currentRouteDetailId); how = 'var'; } } catch (e) {}
  }
  const r = (G.routes || []).find((x) => x && String(x.id) === String(rid)) || null;
  let title = null;
  try { const t = document.getElementById('route-detail-title'); if (t) title = (t.textContent || '').trim() || null; } catch (e) {}
  return JSON.stringify({
    ok: true,
    rid: rid ? String(rid) : null,
    how,
    found: !!r,
    route: r ? (r.from + ' → ' + r.to) : title,
    from: r ? r.from : null,
    to: r ? r.to : null,
    km: r ? Math.round(Number(r.distance) || 0) : null,
    demand: r ? Math.round(Number(r.dailyDemand) || 0) : null,
    isIntl: r ? !!r.isInternational : null,
    title
  });
})()`

// 一键设置航线策略：票价 + 精品餐食 + 精品快线（开线四步里的后三步），返回改前/改后
const routePolicyExpr = (rows, fare) => `(() => {
  const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
  const rows = ${JSON.stringify(rows)}
  const fare = ${JSON.stringify(fare)}
  const readState = (rid) => {
    const r = (G.routes || []).find((x) => String(x.id) === rid)
    let f = null
    try { f = getRouteFarePolicy(rid) } catch (e) {}
    let catering = null
    if (r) {
      const key = JSON.stringify(['passenger', r.from, r.to])
      const pol = G.routeService && G.routeService.policies ? G.routeService.policies[key] : null
      catering = pol ? pol.cateringLevel : null
    }
    return { fare: f, catering, express: (G.expressRoutes || {})[rid] || null }
  }
  const out = []
  for (const row of rows) {
    const rid = String(row.id)
    const before = readState(rid)
    let err = null, errStep = null
    try { setRouteFarePolicy(rid, fare) } catch (e) { err = String((e && e.message) || e); errStep = 'fare' }
    if (!err) { try { setRouteServicePolicy(rid, 'premium') } catch (e) { err = String((e && e.message) || e); errStep = 'service' } }
    if (!err) {
      try {
        if (typeof setExpressLevel === 'function') setExpressLevel(rid, 'premium_express')
        else { G.expressRoutes = G.expressRoutes || {}; G.expressRoutes[rid] = 'premium_express' }
      } catch (e) { err = String((e && e.message) || e); errStep = 'express' }
    }
    const after = readState(rid)
    out.push({
      id: rid, from: row.from, to: row.to, ok: !err, err, errStep, before, after,
      changed: (JSON.stringify(before.fare) !== JSON.stringify(after.fare)) || before.catering !== after.catering || before.express !== after.express,
    })
  }
  return JSON.stringify({ ok: out.every((x) => x.ok), rows: out })
})()`

// 只改票价倍率（不动餐食/快线）：rows = [{ id, fare: {F,J,S,Y} }]
const routeFareExpr = (rows) => `(() => {
  const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
  const rows = ${JSON.stringify(rows)}
  const out = []
  for (const row of rows) {
    const rid = String(row.id)
    let before = null, err = null
    try { before = getRouteFarePolicy(rid) } catch (e) {}
    try { setRouteFarePolicy(rid, row.fare) } catch (e) { err = String((e && e.message) || e) }
    let after = null
    try { after = getRouteFarePolicy(rid) } catch (e) {}
    out.push({ id: rid, ok: !err, err: err, before: before, after: after })
  }
  return JSON.stringify({ ok: out.every((x) => x.ok), rows: out })
})()`

// 买机报价：机型 + 某条航线的分舱位需求 + 票价倍率 + 装备报价（舱位怎么分交给 plan.js 算）
const cabinQuoteExpr = (rid, modelName) => `(() => {
  const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
  const model = ${JSON.stringify(String(modelName))}
  const m = (typeof getAircraftModel === 'function') ? getAircraftModel(model) : null
  if (!m) return JSON.stringify({ ok: false, reason: '机型不存在：' + model })
  const routes = G.routes || []
  const want = ${JSON.stringify(String(rid || ''))}
  let r = want ? routes.find((x) => String(x.id) === want) : null
  if (!r && routes.length) {
    r = routes.slice().sort(function (a, b) { return (Number(b.dailyDemand) || 0) - (Number(a.dailyDemand) || 0) })[0]
  }
  if (!r) return JSON.stringify({ ok: false, reason: '存档里还没有航线' })
  let demand = { F: 0, J: 0, S: 0, Y: 0 }
  // 需求口径：route.demandByCabin 是面板分舱日需求（正确口径）；getRouteDemandByCabin 走报价，
  // 低需求航线是周口径 ×7 且含外部市场，实测虚高 4~6 倍（报告/Day90_闲置机回填与月度发展计划.md:27-31）
  try { demand = r.demandByCabin || getRouteDemandByCabin(r) } catch (e) {}
  // 航线声誉：黄金公式配舱的客座率基数 A 要用它（A = 声誉/100 × 健康/100 × 1.1 × I(Y倍率)）
  let routeRep = null
  try { routeRep = Number(getRouteReputation(String(r.id), { readOnly: true })) } catch (e) { routeRep = null }
  if (!Number.isFinite(routeRep)) routeRep = null
  let fare = { F: 1, J: 1, S: 1, Y: 1 }
  try { fare = getRouteFarePolicy(String(r.id)) || fare } catch (e) {}
  const caps = (typeof getAircraftEquipmentCapabilities === 'function') ? getAircraftEquipmentCapabilities(model) : null
  const profiles = caps && caps.engineProfiles ? caps.engineProfiles : ['standard']
  const eq = {
    version: 1,
    winglets: !!(caps && (caps.factoryWinglets || caps.winglets)),
    engineProfile: profiles.indexOf('efficiency') >= 0 ? 'efficiency' : 'standard',
    wifi: !!(caps && caps.wifi),
    ptv: !!(caps && caps.ptv)
  }
  let quote = null
  try { quote = (typeof getAircraftFactoryEquipmentQuote === 'function') ? getAircraftFactoryEquipmentQuote(model, eq) : null } catch (e) { quote = { err: String((e && e.message) || e) } }
  let price = null
  try { price = Number(getAircraftCurrentPrice(model)) } catch (e) {}
  return JSON.stringify({
    ok: true,
    model: m.name || model,
    seats: Number(m.seats) || 0,
    range: Number(m.range) || 0,
    cruiseSpeed: Number(m.cruiseSpeed) || 750,
    isWideBody: !!m.isWideBody,
    fuelConsumption: Number(m.fuelConsumption) || null,
    price, eq, quote,
    caps: { supported: !!(caps && caps.supported), engineProfiles: profiles, wifi: !!(caps && caps.wifi), ptv: !!(caps && caps.ptv) },
    route: { id: String(r.id), from: r.from, to: r.to, km: Math.round(Number(r.distance) || 0), demand: Math.round(Number(r.dailyDemand) || 0) },
    routeRep,
    demand, fare,
    space: { F: 6, J: 3, S: 1.5, Y: 1 },
    cabinModCost: (typeof calculateCabinModCost === 'function') ? calculateCabinModCost : null
  })
})()`

// 机队清单（改名面板用，轻量）
const AIRCRAFT_LIST_EXPR = `(() => {
  const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
  const list = (G.aircrafts || []).filter(function (a) { return a && !a.hasSold }).map(function (a) {
    let model = a.modelId || a.model || ''
    let seats = 0
    try { seats = Object.values(a.cabinLayout || {}).reduce(function (x, y) { return x + (Number(y) || 0) }, 0) } catch (e) {}
    return { id: a.id, reg: a.regName || a.id, model: model, seats: seats, status: a.status, base: a.baseAirport || a.currentAirport || null }
  })
  return JSON.stringify({ ok: true, aircraft: list })
})()`

// 飞机改名的规则以游戏为准：非空、长度上限、全队唯一（引擎里只改 regName，id 不变，所以不影响排班）
const renameAircraftExpr = (acId, name) => `(() => {
  const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
  const id = ${JSON.stringify(String(acId))}
  const raw = ${JSON.stringify(String(name))}
  const ac = (G.aircrafts || []).find(function (a) { return a && a.id === id })
  if (!ac) return JSON.stringify({ ok: false, reason: '找不到这架飞机' })
  const name = String(raw == null ? '' : raw).trim()
  if (!name) return JSON.stringify({ ok: false, reason: '名字不能为空' })
  if (name.length > 24) return JSON.stringify({ ok: false, reason: '名字太长（上限 24 字）' })
  if (/[\\u0000-\\u001f]/.test(name)) return JSON.stringify({ ok: false, reason: '名字里有非法字符' })
  const dup = (G.aircrafts || []).find(function (a) { return a && !a.hasSold && a.id !== id && String(a.regName || '').trim() === name })
  if (dup) return JSON.stringify({ ok: false, reason: '已经有同名的飞机：' + dup.regName })
  const before = ac.regName
  if (before === name) return JSON.stringify({ ok: true, unchanged: true, id: id, before: before, after: name })
  ac.regName = name
  return JSON.stringify({ ok: true, id: id, before: before, after: ac.regName })
})()`

// 每架飞机「在飞哪些航线」：按当天班表统计，用于按起降城市自动改名
const AIRCRAFT_ROUTES_EXPR = `(() => {
  const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
  const routes = G.routes || []
  const byId = {}
  for (const r of routes) byId[String(r.id)] = r
  const out = (G.aircrafts || []).filter(function (a) { return a && !a.hasSold }).map(function (a) {
    const day0 = ((G.schedule || {})[a.id] || [])[0] || []
    const cnt = {}
    for (const s of day0) {
      if (!s || s.cancelled || !s.routeId) continue
      const k = String(s.routeId)
      cnt[k] = (cnt[k] || 0) + 1
    }
    const legs = Object.keys(cnt).map(function (k) {
      const r = byId[k] || {}
      return { rid: k, from: r.from || null, to: r.to || null, km: Math.round(Number(r.distance) || 0), n: cnt[k] }
    }).sort(function (x, y) { return y.n - x.n })
    return { id: a.id, reg: a.regName || a.id, model: a.modelId || a.model || '', base: a.baseAirport || a.currentAirport || null, legs, totalLegs: day0.filter(function (s) { return s && !s.cancelled }).length }
  })
  return JSON.stringify({ ok: true, aircraft: out })
})()`

// 批量改名（只写 regName）
const applyRenameExpr = (pairs) => `(() => {
  const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
  const pairs = ${JSON.stringify(pairs)}
  const out = []
  for (const p of pairs) {
    const ac = (G.aircrafts || []).find(function (a) { return a && a.id === p.id })
    if (!ac) { out.push({ id: p.id, ok: false, reason: '找不到飞机' }); continue }
    const before = ac.regName
    if (String(before).trim() === p.name) { out.push({ id: p.id, ok: true, unchanged: true, before: before, after: before }); continue }
    ac.regName = p.name
    out.push({ id: p.id, ok: true, before: before, after: ac.regName })
  }
  return JSON.stringify({ ok: out.every(function (x) { return x.ok }), rows: out })
})()`


// 客舱重建：先取每架飞机的当前舱位/主力航线需求（host 侧算最佳配比，再回页面执行）
const CABIN_INPUT_EXPR = `(() => {
  const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
  const routes = G.routes || []
  const out = (G.aircrafts || []).filter(function (a) { return a && !a.hasSold }).map(function (a) {
    const day0 = ((G.schedule || {})[a.id] || [])[0] || []
    const cnt = {}
    for (const s of day0) { if (!s || s.cancelled || !s.routeId) continue; const k = String(s.routeId); cnt[k] = (cnt[k] || 0) + 1 }
    const mainRid = Object.keys(cnt).sort(function (x, y) { return cnt[y] - cnt[x] })[0] || null
    const r = mainRid ? routes.find(function (x) { return String(x.id) === mainRid }) : null
    let demand = { F: 0, J: 0, S: 0, Y: 0 }, fare = { F: 1, J: 1, S: 1, Y: 1 }
    let km = 0, routeRep = null
    if (r) {
      // 需求口径：优先用 route.demandByCabin（面板分舱日需求）；getRouteDemandByCabin 走报价，
      // 本司日需求 <300 时是「周口径 ×7」且含外部市场/换乘，实测虚高 4~6 倍（报告/Day90_闲置机回填:27-31）
      try { demand = r.demandByCabin || getRouteDemandByCabin(r) } catch (e) {}
      try { fare = getRouteFarePolicy(String(r.id)) || fare } catch (e) {}
      // 黄金公式配舱要的两个输入：航距（算票价真值）+ 航线声誉（算客座率基数 A）
      km = Math.round(Number(r.distance) || 0)
      try { routeRep = Number(getRouteReputation(String(r.id), { readOnly: true })) } catch (e) { routeRep = null }
      if (!Number.isFinite(routeRep)) routeRep = null
    }
    const m = (function () { try { return getAircraftModel(a.modelId || a.model) || {} } catch (e) { return {} } })()
    const svc = getCabinServiceSettings(a)
    let caps = null
    try { caps = getAircraftEquipmentCapabilities(a.modelId || a.model) } catch (e) {}
    const eq = a.equipment || {}
    return {
      id: a.id, reg: a.regName || a.id, model: a.modelId || a.model || '',
      spaceBase: Number(m.seats) || 0, pitch: svc.seatPitchCm, catering: svc.cateringLevel,
      layout: a.cabinLayout ? JSON.parse(JSON.stringify(a.cabinLayout)) : null,
      legs: day0.filter(function (s) { return s && !s.cancelled }).length,
      mainRid: mainRid, route: r ? (r.from + ' → ' + r.to) : null,
      demand: demand, fare: fare, inFlight: !!a.flight, km: km, routeRep: routeRep,
      // 71cm 前提：自有 + 白名单机型 + 已装 WiFi 与 PTV（报告/座椅间距…:50-51、租赁…:75）
      own: !a.lease && !(a.acquisition && a.acquisition.type === 'lease'),
      wifi: !!(eq.wifi), ptv: !!(eq.ptv),
      capsSupported: !!(caps && caps.supported),
    }
  })
  return JSON.stringify({ ok: true, aircraft: out })
})()`

// 执行重建：{id, F, J, S, pitch?}[] + 默认座椅间距 → 页面自己算 Y、算改装费、扣钱、写回
// 每架可以带自己的 pitch（自有+白名单+WiFi/PTV 才会是 71，其余 74），没带就用默认值
const cabinRebuildExpr = (items, pitch, apply) => `(() => {
  const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
  const items = ${JSON.stringify(items)}
  const defaultPitch = ${Number(pitch)}
  const apply = ${apply ? 'true' : 'false'}
  const plan = []
  let total = 0
  for (const it of items) {
    const ac = (G.aircrafts || []).find(function (a) { return a && a.id === it.id })
    if (!ac) { plan.push({ id: it.id, ok: false, reason: '找不到飞机' }); continue }
    const pitch = Number(it.pitch || defaultPitch)
    const cur = getCabinServiceSettings(ac)
    const svc = { seatPitchCm: pitch, cateringLevel: cur.cateringLevel }
    let layout = null, cost = 0, err = null
    try {
      layout = getCabinConfiguredLayout(ac, { F: it.F, J: it.J, S: it.S }, svc)
      cost = getCabinModificationCost(ac, layout, svc)
    } catch (e) { err = String((e && e.message) || e) }
    plan.push({ id: it.id, reg: ac.regName, model: ac.model, ok: !err, err: err, layout: layout, cost: Number(cost) || 0, pitch: pitch, before: ac.cabinLayout, beforePitch: cur.seatPitchCm, inFlight: !!ac.flight })
    total += Number(cost) || 0
  }
  total = Math.round(total * 100) / 100
  const money = Number(G.money || 0)
  if (!apply) return JSON.stringify({ ok: plan.every(function (x) { return x.ok }), dryRun: true, total: total, money: money, plan: plan })
  if (money < total) return JSON.stringify({ ok: false, reason: '资金不足：需要 ' + total + ' 万，现有 ' + money.toFixed(2) + ' 万', total: total, money: money, plan: plan })
  const done = []
  for (const p of plan) {
    if (!p.ok) { done.push(p); continue }
    const ac = (G.aircrafts || []).find(function (a) { return a && a.id === p.id })
    if (p.cost > 0) changeModuleMoney(ac.module || 'passenger', -p.cost)
    if (ac.flight && typeof snapshotFlightCabinLayout === 'function') { try { snapshotFlightCabinLayout(ac, ac.flight) } catch (e) {} }
    ac.cabinLayout = p.layout
    ac.seatPitchCm = Number(p.pitch || defaultPitch)
    done.push(Object.assign({}, p, { applied: true }))
  }
  return JSON.stringify({ ok: done.every(function (x) { return x.ok }), total: total, money: Number(G.money || 0), plan: done })
})()`

// 利润体检输入：按「有向航线 × 机」把引擎真实模型搬回来（源码 routeEconomy.js / gameLoop.js / cabinService.js）
//   LF      = min(1, 航线声誉/100 × 换乘系数 × 健康度/100 × 1.1 × getRouteFareIntent(Y 倍率))
//   客流    = min(座位, 需求池/班次, round(max(LF,0.01) × 座位 × clamp(倍率^-弹性,0.5,1.8) × 客舱服务系数))
//   票价    = round(航距 × 0.77 × CABIN_FARE_COEFF[舱] × 声誉系数 × 倍率)   ← 声誉系数 = 1+(rep/100-0.5)×0.2
//   空间    = 6F + 3J + 1.5S + Y ≤ floor(model.seats × 79 / 间距)
// host 侧 profitPlan() 再网格搜索倍率 + 线性配舱，不在这里算
const PROFIT_EXPR = `(() => {
  const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
  const num = function (v, d) { return Number.isFinite(Number(v)) ? Number(v) : (d == null ? 0 : d) }
  const cabins = ['F', 'J', 'S', 'Y']
  const mod = G.currentModule || 'passenger'
  const md = (G.modules && G.modules[mod]) || null
  const rep = num(mod === (G.currentModule || 'passenger') ? G.reputation : (md && md.reputation), 50)
  const repFactor = 1 + (rep / 100 - 0.5) * 0.2
  const basePerKm = (typeof BASE_FARE_PER_KM !== 'undefined') ? BASE_FARE_PER_KM : 0.77
  const coeff = (typeof CABIN_FARE_COEFF !== 'undefined') ? CABIN_FARE_COEFF : { F: 10, J: 4, S: 1.7, Y: 1 }
  const space = (typeof CABIN_SPACE !== 'undefined') ? CABIN_SPACE : { F: 6, J: 3, S: 1.5, Y: 1 }
  const live = (G.aircrafts || []).filter(function (a) { return a && !a.hasSold })
  const sched = G.schedule || {}
  const routes = Array.isArray(G.routes) ? G.routes : Object.values(G.routes || {})
  const wk = G.routeWeeklyStats || {}
  const acInfo = []
  const perAc = {}
  for (const a of live) {
    const m = (function () { try { return getAircraftModel(a.modelId || a.model) || {} } catch (e) { return {} } })()
    const svc = getCabinServiceSettings(a)
    let df = 1, cap = 0
    try { df = getCabinServiceMetrics(a, svc).demandFactor } catch (e) {}
    try { cap = getCabinSeatCapacity(a, svc) } catch (e) { cap = Math.floor(num(m.seats) * 79 / num(svc.seatPitchCm, 79)) }
    const layout = a.cabinLayout ? JSON.parse(JSON.stringify(a.cabinLayout)) : null
    const byRid = {}
    const days = sched[a.id] || []
    for (let wd = 0; wd < 7; wd++) {
      const day = days[wd] || []
      for (const s of day) {
        if (!s || s.cancelled || !s.routeId) continue
        const k = String(s.routeId)
        const row = byRid[k] || (byRid[k] = { rid: k, legs: 0, depSum: 0 })
        row.legs++
        row.depSum += num(s.departureMin)
      }
    }
    perAc[a.id] = byRid
    acInfo.push({
      id: a.id, reg: a.regName || a.id, model: a.modelId || a.model || '',
      modelSeats: num(m.seats), wide: !!m.isWideBody, pitch: num(svc.seatPitchCm, 79),
      catering: svc.cateringLevel, health: num(a.health, 100), demandFactor: df,
      seatCapacity: cap, layout: layout,
      idle: !Object.keys(byRid).length,
      routes: Object.keys(byRid).map(function (k) { return { rid: k, legs: byRid[k].legs } }),
    })
  }
  const apOf = G.airports || {}
  const out = []
  for (const r of routes) {
    if (!r || r.routeKind === 'cargo' || r.cargoOnly) continue
    const rid = String(r.id)
    let fare = { F: 1, J: 1, S: 1, Y: 1 }
    try { fare = getRouteFarePolicy(rid) || fare } catch (e) {}
    let routeRep = 0
    try { routeRep = num(getRouteReputation(rid, { readOnly: true }), 0) } catch (e) {}
    let q = null
    try { q = getRouteDemandQuote(r, mod) } catch (e) {}
    const demandByCabin = (r.demandByCabin && typeof r.demandByCabin === 'object') ? r.demandByCabin : null
    const flights = []
    let legsWeek = 0
    for (const a of live) {
      const row = perAc[a.id] ? perAc[a.id][rid] : null
      if (!row || !row.legs) continue
      let tr = 1
      try { tr = num(getTransferFactor(r, Math.round(row.depSum / row.legs)).factor, 1) } catch (e) {}
      legsWeek += row.legs
      flights.push({ acId: a.id, legs: row.legs, transfer: tr })
    }
    const st = wk[rid] || null
    const perDay = Math.max(1, legsWeek / 7)
    const poolByCabin = {}
    for (const c of cabins) {
      const pool = demandByCabin ? num(demandByCabin[c]) : (q && q.remainingByCabin ? num(q.remainingByCabin[c]) : 0)
      poolByCabin[c] = pool > 0 ? pool / perDay : null
    }
    out.push({
      id: rid, from: r.from, to: r.to, km: num(r.distance || r.km),
      fromLevel: (apOf[r.from] && apOf[r.from].level) || null,
      fare: { F: num(fare.F, 1), J: num(fare.J, 1), S: num(fare.S, 1), Y: num(fare.Y, 1) },
      routeRep: routeRep, express: (function () { try { return getExpressLevel(rid) } catch (e) { return null } })(),
      demandByCabin: demandByCabin, poolByCabin: poolByCabin,
      remainingByCabin: (q && q.remainingByCabin) || null, remainingTotal: q ? num(q.remainingTotal) : null,
      legsWeek: legsWeek, flights: flights,
      lfActual: st && num(st.seats) > 0 ? num(st.passengers) / num(st.seats) : null,
      weekly: st ? { flights: num(st.flights), seats: num(st.seats), passengers: num(st.passengers), revenue: num(st.revenue) } : null,
    })
  }
  return JSON.stringify({ ok: true, moduleId: mod, reputation: rep, repFactor: repFactor,
    basePerKm: basePerKm, coeff: coeff, space: space, money: num(G.money), routes: out, aircraft: acInfo })
})()`

// ---- 航线开发：某机场出发、只看已开通区域的候选航线（带现有飞机与分舱需求）----
const ROUTE_DEV_EXPR = (opts = {}) => {
  const froms = JSON.stringify(Array.isArray(opts.fromAirports) ? opts.fromAirports : (opts.from ? [opts.from] : []))
  const modelName = JSON.stringify(String(opts.model || 'B757-200'))
  const pitch = Number(opts.pitch) > 0 ? Number(opts.pitch) : 71
  return `(() => {
  ${G_PRELUDE}
  const froms = ${froms};
  const modelName = ${modelName};
  const pitch = ${pitch};
  const unlocked = (G.unlockedRegions && G.unlockedRegions.length) ? G.unlockedRegions : ['china'];
  const apOf = G.airports || {};
  const M = (typeof AIRCRAFT_MODELS !== 'undefined') ? AIRCRAFT_MODELS : {};
  const model = M[modelName] || null;
  const coeff = (typeof CABIN_FARE_COEFF !== 'undefined') ? CABIN_FARE_COEFF : { F: 10, J: 4, S: 1.7, Y: 1 };
  const space = (typeof CABIN_SPACE !== 'undefined') ? CABIN_SPACE : { F: 6, J: 3, S: 1.5, Y: 1 };
  const basePerKm = (typeof BASE_FARE_PER_KM !== 'undefined') ? BASE_FARE_PER_KM : 0.77;
  // 已开通区域内的机场（用户要求：航线只在已开通区域里选）
  const avail = Object.keys(apOf).filter(function (n) {
    const a = apOf[n];
    if (!a) return false;
    const reg = a.region || 'china';
    if (unlocked.indexOf(reg) < 0) return false;
    if (typeof isAirportAvailable === 'function') { try { if (!isAirportAvailable(n)) return false } catch (e) { return false } }
    return true;
  });
  const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  const ridByPair = {};
  const pairOfRid = {};
  for (const r of allRoutes) {
    const pk = pairKey(r.from, r.to);
    ridByPair[pk] = String(r.id);
    pairOfRid[String(r.id)] = pk;
  }
  // 现有飞机：每架每周在每条线上飞多少段（用来算「这条线已经有几架」）
  const legRec = {};
  for (const a of live) {
    const d = sched[a.id];
    if (!Array.isArray(d)) continue;
    for (let wd = 0; wd < 7; wd++) {
      const day = Array.isArray(d[wd]) ? d[wd] : [];
      for (const s of day) {
        if (!s || s.cancelled || !s.routeId) continue;
        const pk2 = pairOfRid[String(s.routeId)] || ('rid:' + String(s.routeId));
        const rec = legRec[pk2] || (legRec[pk2] = { acs: {}, segs: 0 });
        rec.acs[a.id] = 1;
        rec.segs += 1;
      }
    }
  }
  const lvl = (n) => (typeof AIRPORT_LEVELS !== 'undefined' && AIRPORT_LEVELS[n]) ? AIRPORT_LEVELS[n] : null;
  const parkedCap = (ap) => (typeof getAirportMaxParked === 'function') ? getAirportMaxParked(ap) : ((lvl(ap && ap.level) || {}).maxParked || 2);
  const rows = [];
  for (const f of froms) {
    const fa = apOf[f];
    if (!fa) continue;
    for (const d of avail) {
      if (d === f) continue;
      const da = apOf[d];
      if (!da) continue;
      if (!Number.isFinite(Number(fa.lat)) || !Number.isFinite(Number(da.lat))) continue;
      const km0 = haversineDistance(fa.lat, fa.lng, da.lat, da.lng);
      if (!(km0 > 0)) continue;
      if (model && Number(model.range) > 0 && km0 > Number(model.range) * 0.98) continue;
      const km = Math.round(km0);
      let demand = 0, own = 0;
      try { demand = calculateDailyDemand(fa.throughput || 0, da.throughput || 0, (typeof shouldUseDistanceDecay === 'function' ? shouldUseDistanceDecay(fa, da) : false), km0) } catch (e) {}
      try { own = getOwnDemand(demand) } catch (e) { own = demand }
      const rid = ridByPair[pairKey(f, d)] || null;
      let byCabin = null, fareNow = null, routeRep = null, flightTime = null;
      if (rid) {
        const rt = allRoutes.find(function (r) { return String(r.id) === String(rid) });
        if (rt && rt.demandByCabin) byCabin = rt.demandByCabin;
        try { fareNow = getRouteFarePolicy(String(rid)) } catch (e) {}
        try { routeRep = Number(getRouteReputation(String(rid), { readOnly: true })) } catch (e) {}
        // 已开线的实际航时（引擎按机型算，直接读时刻表里的 flightTime 更准）
        try {
          for (const a of live) {
            const day = (sched[a.id] && sched[a.id][0]) || [];
            const seg = day.find(function (s) { return s && String(s.routeId) === String(rid) });
            if (seg && Number(seg.flightTime) > 0) { flightTime = Number(seg.flightTime); break }
          }
        } catch (e) {}
      }
      if (!byCabin) { try { byCabin = calculateDemandByCabin(Math.round(own), km) } catch (e) { byCabin = null } }
      const rec = legRec[pairKey(f, d)] || null;
      let cost = null;
      try { cost = getRouteCreateCost(km) } catch (e) {}
      const lf = lvl(fa.level || 'normal'), lt = lvl(da.level || 'normal');
      rows.push({
        from: f, to: d, km: km, level: (da.level || 'normal'), intl: !!da.isInternational, region: da.region || 'china',
        demand: Math.round(demand), own: Math.round(own),
        byCabin: byCabin ? { F: Number(byCabin.F) || 0, J: Number(byCabin.J) || 0, S: Number(byCabin.S) || 0, Y: Number(byCabin.Y) || 0 } : null,
        exists: !!rid, rid: rid, fareNow: fareNow, routeRep: (routeRep != null && Number.isFinite(routeRep)) ? routeRep : null,
        flightTime: (flightTime != null && Number(flightTime) > 0) ? Math.round(flightTime) : null,
        createCost: cost == null ? null : +Number(cost).toFixed(2),
        needFrom: lf ? lf.minDepartureInterval : 40, needTo: lt ? lt.minDepartureInterval : 40,
        parkCapFrom: parkedCap(fa), parkCapTo: parkedCap(da),
        parkedFrom: live.filter(function (a) { return a.currentAirport === f }).length,
        parkedTo: live.filter(function (a) { return a.currentAirport === d }).length,
        acCount: rec ? Object.keys(rec.acs).length : 0, segWeek: rec ? rec.segs : 0
      });
    }
  }
  const seatCap = (model && Number(model.seats) > 0) ? Math.floor(Number(model.seats) * 79 / pitch) : null;
  return JSON.stringify({
    ok: true, froms: froms, unlocked: unlocked,
    modelName: modelName, model: model ? { name: modelName, seats: model.seats, range: model.range, cruiseSpeed: model.cruiseSpeed } : null,
    pitch: pitch, seatCap: seatCap, coeff: coeff, space: space, basePerKm: basePerKm,
    reputation: Number(G.reputation || 0), money: Number(G.money || 0), apCount: avail.length, rows: rows
  });
})()`
}

// ---- 机场模糊搜索：在已开通区域里按 名称/三字码/区域 匹配（HUD 输入框用）----
const AIRPORT_SEARCH_EXPR = (q) => {
  const query = JSON.stringify(String(q == null ? '' : q))
  return `(() => {
  ${G_PRELUDE}
  const q = String(${query} || '').trim();
  const needle = q.toLowerCase();
  const unlocked = (G.unlockedRegions && G.unlockedRegions.length) ? G.unlockedRegions : ['china'];
  const apOf = G.airports || {};
  const out = [];
  for (const n of Object.keys(apOf)) {
    const a = apOf[n];
    if (!a) continue;
    const reg = a.region || 'china';
    if (unlocked.indexOf(reg) < 0) continue;
    if (typeof isAirportAvailable === 'function') { try { if (!isAirportAvailable(n)) continue } catch (e) { continue } }
    const iata = String(a.iata || '').toUpperCase();
    const hay = (n + ' ' + iata + ' ' + reg + ' ' + String(a.country || '')).toLowerCase();
    if (needle && hay.indexOf(needle) < 0) continue;
    out.push({
      name: n, iata: iata, region: reg, country: a.country || '', level: a.level || 'normal',
      throughput: Number(a.throughput) || 0,
      parked: live.filter(function (x) { return x.currentAirport === n }).length,
      slots: Number(a.maintenanceSlots) || 0
    });
  }
  // 名字越短越像（「上海」先给 上海浦东 / 上海虹桥，而不是「上海浦东国际机场」这类）
  out.sort(function (x, y) {
    if (x.parked !== y.parked) return y.parked - x.parked;
    return x.name.length - y.name.length || (y.throughput - x.throughput);
  });
  return JSON.stringify({ ok: true, q: q, total: out.length, matches: out.slice(0, 30), unlocked: unlocked });
})()`
}

export { STATUS_EXPR, STATE_EXPR, AUDIT_EXPR, GAME_VALIDATE_EXPR, tickExpr, BUY_EXPR, routeExpr, HEALTH_EXPR, boardExpr, SELECTED_ROUTE_EXPR, routePolicyExpr, routeFareExpr, cabinQuoteExpr, AIRCRAFT_LIST_EXPR, renameAircraftExpr, AIRCRAFT_ROUTES_EXPR, applyRenameExpr, CABIN_INPUT_EXPR, cabinRebuildExpr, FUEL_EXPR, PROFIT_EXPR, ROUTE_DEV_EXPR, AIRPORT_SEARCH_EXPR }
