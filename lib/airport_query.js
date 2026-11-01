// 机场查询（Airport Query）
// ---------------------------------------------------------------------------
// 目的：给「哪些机场还能开线」这个判断提供一张表。
// 范围：三级基地以上（base1 / base2 / base3）+ hub。
// 字段：维修点数量、夜间停靠数量（实际）、夜间维修航班数量、白天维修航班数量，以及扩容/开线判断用的辅助列。
//
// 用户口径（2026-10-25 m00053 确认）：
//   ① 机场范围含 hub
//   ② 夜间停靠数量看**实际**（今日班表末段落地在该机场过夜的机数；无班闲置机按当前所在机场计）
//   ③ 维修航班按 **B 口径** = 实际 maintenanceStatus='in_progress' 的机数
//      （引擎的 maintenanceSlots 是「有几位维修位」，不是「今晚修几架」，A 口径会高估到接近夜停数）
//   ④ 每次查询覆盖同一张表（文件名跟随最新存档名）
//
// 本模块是纯逻辑：不访问网络、不依赖 ctx，方便单测。
import fs from 'fs'
import path from 'path'

export const TARGET_LEVELS = ['base1', 'base2', 'base3', 'hub']

export const LEVEL_CN = {
  base1: '一级基地', base2: '二级基地', base3: '三级基地',
  hub: '枢纽(hub)', normal: '普通机场', unknown: '未知',
}

// ---------------------------------------------------------------------------
// 页面侧采集表达式：一次 eval 拿全（桥的 eval 有 100ms 硬上限，必须一次算完）
// ---------------------------------------------------------------------------
export const AIRPORT_QUERY_EXPR = `(() => {
  const G = (typeof GameState !== 'undefined') ? GameState : window.GameState;
  if (!G) return JSON.stringify({ ok: false, reason: '读不到 GameState（页面没进游戏？）' });

  // 顺带自愈：故障系统被存档载回 true → 关掉（用户要求：自动检测，发现就关，不打扰）
  let faultFixed = 0;
  try {
    if (G.faultSystemEnabled === true) {
      G.faultSystemEnabled = false;
      faultFixed = 1;
      const list = (G.aircrafts || []).filter(a => !a.hasSold);
      for (const a of list) {
        try {
          if (a.faultStatus && a.faultStatus !== 'none' && !a.faultResolved && typeof resolveFault === 'function') resolveFault(a.id);
        } catch (e) { try { a.faultStatus = 'none'; } catch (e2) {} }
        try {
          const d = a.departureDelay;
          if (d && d.active && Array.isArray(d.active.blockers)) d.active.blockers = d.active.blockers.filter(b => b && b.code !== 'fault');
        } catch (e) {}
      }
      if (typeof updateFaultAlert === 'function') { try { updateFaultAlert(); } catch (e) {} }
    }
  } catch (e) {}

  const DAY = 1440;
  const acs = (G.aircrafts || []).filter(a => !a.hasSold);
  const wd = (typeof getWeekdayIndex === 'function') ? getWeekdayIndex(G.gameTime) : 0;
  const gt = new Date(G.gameTime);
  const nowMin = gt.getHours() * 60 + gt.getMinutes();
  const routeById = (typeof getRouteById === 'function') ? getRouteById : () => null;
  const maxParked = (typeof getAirportMaxParked === 'function') ? getAirportMaxParked : () => 0;
  const apList = Object.values(G.airports || {});
  const apByName = {};
  for (const ap of apList) apByName[ap.name] = ap;

  function segsOf(a) {
    const s = G.schedule && G.schedule[a.id];
    if (!s) return [];
    const day = s[wd] || s[0] || [];
    return (day || []).filter(x => x && !x.cancelled);
  }

  const acInfo = acs.map(a => {
    const segs = segsOf(a);
    const legs = segs.map(s => {
      const r = routeById(s.routeId);
      return { dep: s.departureMin, arr: s.arrivalMin, from: r ? r.from : null, to: r ? r.to : null };
    }).sort((x, y) => x.dep - y.dep);
    let nightParkedAt;
    if (legs.length) nightParkedAt = legs[legs.length - 1].to || a.currentAirport;
    else nightParkedAt = a.currentAirport;
    let firstDep = DAY, lastArr = 0;
    for (const l of legs) { if (l.dep < firstDep) firstDep = l.dep; if (l.arr > lastArr) lastArr = l.arr; }
    return {
      id: a.id, reg: a.regName, at: a.currentAirport, st: a.status,
      ms: a.maintenanceStatus || 'none',
      nightParkedAt, segs: legs.length, firstDep, lastArr, legs,
    };
  });

  function nightStay(ai) {
    if (!ai.segs) return DAY;
    return (DAY - ai.lastArr) + ai.firstDep;
  }
  function dayGapsAt(ai, A) {
    let n = 0, arrAtA = null;
    for (const l of ai.legs) {
      if (l.to === A) arrAtA = l.arr;
      if (l.from === A && arrAtA !== null) {
        if (l.dep - arrAtA >= 180) n++;
        arrAtA = null;
      }
    }
    return n;
  }

  const TARGET = ['base1', 'base2', 'base3', 'hub'];
  const aps = apList.filter(ap => TARGET.indexOf(ap.level) >= 0);
  const routes = G.routes || [];

  const rows = aps.map(ap => {
    const A = ap.name;
    const nightParked = acInfo.filter(ai => ai.nightParkedAt === A).length;
    const cap = Number(maxParked(A) || 0);
    const nightA3 = acInfo.filter(ai => ai.nightParkedAt === A && nightStay(ai) >= 180).length;

    const touchA = acInfo.filter(ai => ai.at === A || ai.legs.some(l => l.from === A || l.to === A));
    let fd = DAY, la = 0;
    for (const ai of touchA) { if (ai.segs) { if (ai.firstDep < fd) fd = ai.firstDep; if (ai.lastArr > la) la = ai.lastArr; } }
    const noService = (fd >= DAY);

    // 维修落在哪个窗口：白窗取引擎的「白天维修窗口」10:00–13:00（插件 maint='day' 用的就是这段），
    // 其余时刻的维修一律算夜间（引擎不记录维修开始时间，只能按查询时刻快照归类）。
    const isDayMaint = (nowMin >= 600 && nowMin < 780);

    const maintAc = acInfo.filter(ai => ai.ms === 'in_progress' && ai.at === A);
    const maintTotal = maintAc.length;
    const maintDay = isDayMaint ? maintTotal : 0;
    const maintNight = maintTotal - maintDay;

    let dayGaps = 0;
    for (const ai of touchA) dayGaps += dayGapsAt(ai, A);
    let depCnt = 0, arrCnt = 0;
    for (const ai of acInfo) for (const l of ai.legs) { if (l.from === A) depCnt++; if (l.to === A) arrCnt++; }

    const rs = routes.filter(r => r.from === A || r.to === A);
    const demandSum = rs.reduce((s, r) => s + Number(r.baseDailyDemand || r.dailyDemand || 0), 0);
    const remainSum = rs.reduce((s, r) => s + Number(r.remainingDemand || 0), 0);

    return {
      name: A, level: ap.level, iata: ap.iata || '', region: ap.region || '', intl: !!ap.isInternational,
      throughput: Number(ap.throughput || 0),
      maintSlots: Number(ap.maintenanceSlots || 0),
      maintSpeed: Number(ap.maintenanceSpeed || 0),
      maintUsed: Number(ap.maintenanceUsed || 0),
      inspSlots: Number(ap.inspectionSlots || 0),
      cap, nightParked, nightFree: cap - nightParked, nightA3, dayGaps,
      maintTotal, maintNight, maintDay,
      depCnt, arrCnt, routes: rs.length, demandSum, remainSum,
      nowMin, isDayMaint,
      firstDep: fd >= DAY ? null : fd, lastArr: la, noService,
    };
  });

  const order = { base1: 0, base2: 1, hub: 2, base3: 3 };
  const sorted = rows.sort((a, b) => {
    const oa = order[a.level] === undefined ? 9 : order[a.level];
    const ob = order[b.level] === undefined ? 9 : order[b.level];
    if (oa !== ob) return oa - ob;
    return b.nightParked - a.nightParked;
  });

  // 全机场夜间停机分布（含 normal）—— 用于发现「外站夜停但维修位=0」红线
  const byNight = {};
  for (const ai of acInfo) {
    const A = ai.nightParkedAt;
    if (!A) continue;
    if (!byNight[A]) byNight[A] = 0;
    byNight[A]++;
  }
  const allNight = Object.keys(byNight).map(k => {
    const ap = apByName[k];
    return {
      name: k,
      level: ap ? ap.level : 'unknown',
      slots: ap ? Number(ap.maintenanceSlots || 0) : 0,
      speed: ap ? Number(ap.maintenanceSpeed || 0) : 0,
      cap: ap ? Number(maxParked(k) || 0) : 0,
      parked: byNight[k],
    };
  }).sort((a, b) => (a.slots - b.slots) || (b.parked - a.parked));

  return JSON.stringify({
    ok: true, faultFixed,
    gameTime: String(G.gameTime), weekday: wd, nowMin,
    money: Number(G.money || 0), airportPoints: Number(G.airportPoints || 0),
    reputation: Number(G.reputation || 0),
    rows: sorted, allNight,
  });
})()`

// ---------------------------------------------------------------------------
// 纯逻辑：命名 / 格式化 / 表格
// ---------------------------------------------------------------------------

/** 找到工作区里的存档目录（存档 / saves / save） */
export function findSaveDir(workspace) {
  if (!workspace) return null
  for (const n of ['存档', 'saves', 'save']) {
    const p = path.join(workspace, n)
    try { if (fs.statSync(p).isDirectory()) return p } catch (e) {}
  }
  return null
}

/** 最新存档的文件名（不含扩展名），用于「文件名以存档名来」 */
export function latestSaveBase(saveDir) {
  if (!saveDir) return null
  try {
    const files = fs.readdirSync(saveDir).filter((f) => /\.json$/i.test(f) && !/\.bak$/i.test(f))
    if (!files.length) return null
    let best = null, bestT = -1
    for (const f of files) {
      try {
        const st = fs.statSync(path.join(saveDir, f))
        if (st.mtimeMs > bestT) { bestT = st.mtimeMs; best = f }
      } catch (e) {}
    }
    return best ? best.replace(/\.json$/i, '') : null
  } catch (e) { return null }
}

export function fmtGameDate(s) {
  const d = new Date(s)
  if (isNaN(d.getTime())) return 'unknown'
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function hhmm(m) {
  if (m === null || m === undefined) return ''
  const x = Math.round(m)
  return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0')
}

/** 「这个机场还能不能开线/加线」一句话结论 */
export function advise(r) {
  if (r.nightFree < 0) return '❌ 夜停已超容（红线）'
  if (r.maintSlots <= 0) return '❌ 无维修位，不能外站过夜'
  if (r.noService) return '⚠ 无航班，可开线'
  if (r.nightFree <= 0 && r.maintUsed >= r.maintSlots) return '⚠ 容量已满，先扩维修位/停机位'
  if (r.nightFree <= 0) return '⚠ 停机位满，先扩停机位'
  if (r.remainSum > 0) return `✅ 可继续加线（剩需求 ${Math.round(r.remainSum)}）`
  return `✅ 有余量（夜停余 ${r.nightFree} 位），需新开航线`
}

export const SHEET1_COLS = [18, 12, 8, 10, 8, 12, 11, 10, 12, 18, 10, 10, 18, 18, 18, 18, 11, 11, 12, 12, 11, 13, 11, 40]
export const SHEET2_COLS = [18, 12, 9, 10, 11, 11, 46]

export const NOTES = [
  '① 机场范围：三级基地以上，含 hub（base1 / base2 / base3 / hub）。',
  '② 夜间停靠数量：看实际 = 今日班表末段落地在该机场过夜的机数；无班闲置机按当前所在机场计。',
  '③ 夜间/白天维修航班数量：B 口径 = 实际处于 maintenanceStatus=in_progress 的飞机数，按查询时刻归类——白窗取引擎的白天维修窗口 10:00–13:00，其余时刻算夜间（引擎不记录维修开始时间，只能按查询时刻快照）。',
  '④「夜停≥3h机数」「白天可修机数」为 A 口径理论值（有多少机能用上维修位），判断扩容余量时看这两列。',
  '⑤ 该表每次查询覆盖同名文件；文件名跟随最新存档名。',
]

/** 把采集数据整理成 xlsx_min 需要的 sheets 结构 */
export function buildSheets(data) {
  const rows = data.rows || []
  const head = [
    '机场', '等级', '三字码', '区域', '国际?', '吞吐量',
    '维修点数量', '维修速度', '维修位占用',
    '夜间停靠数量(实际)', '夜停容量', '夜停余量',
    '夜间维修航班数量', '白天维修航班数量',
    '夜停≥3h机数(参考)', '白天可修机数(参考)',
    '首班起飞', '末班落地',
    '今日起飞段', '今日落地段', '已开航线', '日需求合计', '剩余需求',
    '开线建议',
  ]
  const out = []
  out.push(head.map((h) => ({ v: h, bold: true })))
  for (const r of rows) {
    out.push([
      r.name, LEVEL_CN[r.level] || r.level, r.iata, r.region, r.intl ? '国际' : '境内', r.throughput,
      r.maintSlots, r.maintSpeed, `${r.maintUsed}/${r.maintSlots}`,
      r.nightParked, r.cap, r.nightFree,
      r.maintNight, r.maintDay,
      r.nightA3, r.dayGaps,
      hhmm(r.firstDep), hhmm(r.lastArr),
      r.depCnt, r.arrCnt, r.routes,
      Math.round(r.demandSum), Math.round(r.remainSum),
      advise(r),
    ])
  }
  out.push([])
  out.push([{ v: '口径说明', bold: true }])
  for (const n of NOTES) out.push([n])

  const sheets = [{ name: '机场查询', rows: out, cols: SHEET1_COLS, freezeRows: 1 }]

  // Sheet2：全机场夜间停机分布（外站夜停红线排查）
  const an = data.allNight || []
  const out2 = []
  out2.push(['机场', '等级', '维修位', '维修速度', '停机容量', '夜停机数', '状态'].map((h) => ({ v: h, bold: true })))
  for (const r of an) {
    const bad = r.slots <= 0
    out2.push([
      r.name, LEVEL_CN[r.level] || r.level, r.slots, r.speed, r.cap, r.parked,
      bad ? '❌ 无维修位，夜停红线（四查 C1/C3 会拦）' : '✅ 有维修位',
    ])
  }
  sheets.push({ name: '夜停分布(全机场)', rows: out2, cols: SHEET2_COLS, freezeRows: 1 })

  return sheets
}

/** 顺手给 HUD / 工具返回用的精简表 */
export function briefRows(data) {
  return (data.rows || []).map((r) => ({
    机场: r.name, 等级: LEVEL_CN[r.level] || r.level,
    维修点: r.maintSlots, 夜停: r.nightParked, 夜停容量: r.cap,
    夜间维修: r.maintNight, 白天维修: r.maintDay,
    建议: advise(r),
  }))
}
