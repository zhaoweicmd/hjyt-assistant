// 独立烟测：不需要 DSH 宿主，用假 ctx 加载插件并跑只读工具。
// 用法：node test/smoke.mjs            全部只读工具
//       node test/smoke.mjs --no-page  不连游戏，只验证注册与配置解析
import { apply } from '../lib/index.js';
import * as profile from '../lib/profile.js';

const noPage = process.argv.includes('--no-page');

// 1) 配置解析
const p = profile.resolveProfile({});
console.log('[profile]', {
  workspace: p.workspace,
  scriptsDir: p.scriptsDir,
  tickMode: p.tickMode,
  ledger: p.ledgerName,
  cdpPort: p.cdpPort,
  turnWide: p.turnWide, turnNarrow: p.turnNarrow, maxLegs: p.maxLegs,
});

// 2) 假 ctx 注册
const tools = {};
const routes = [];
let disposer;
await apply({
  tools: { register: (t) => { tools[t.name] = t; return () => delete tools[t.name]; } },
  inject(names, cb) {
    const webServer = { register: (r) => { routes.push(r); return () => {}; } };
    cb({ tools: { register: (t) => { tools[t.name] = t; return () => delete tools[t.name]; } }, webServer });
  },
  on() {}, effect(fn) { disposer = fn; },
}, {});
console.log('[tools]', Object.keys(tools).join(','));
console.log('[routes]', routes.map(r => r.path || r.kind).join(','));

// 2b) 全部工具的 schema 必须已经是宿主认的 raw JSON Schema
// （2026-10-21 事故：作者 DSL 原样进 register → 32 个工具全挂）
const { assertRawSchema } = await import('../lib/schema.js');
const schemaBads = [];
for (const t of Object.values(tools)) {
  for (const [kind, s] of [['parameters', t.parameters], ['output.schema', t.output && t.output.schema]]) {
    for (const msg of assertRawSchema(s, kind)) schemaBads.push(t.name + ': ' + msg);
  }
}
console.log('[schema]', Object.keys(tools).length + ' 个工具 · 违规 ' + schemaBads.length);
if (schemaBads.length) {
  for (const m of schemaBads.slice(0, 20)) console.log('  ✗ ' + m);
  process.exit(1);
}
if (noPage) process.exit(0);

// 3) 只读工具实跑
// 注意：T() 注册时会把返回值包成 { text }（DSH 输出格式），这里要拆开再 JSON.parse
const J = async (t, a = {}) => {
  const r = await tools[t].execute(a, {})
  const raw = (r && typeof r === 'object' && r.text != null) ? r.text : r
  return JSON.parse(raw)
};

const st = await J('hjyt_status');
if (!st.status) { console.log('[status] failed:', JSON.stringify(st).slice(0, 400)); process.exit(1); }
const s = st.status;
console.log('[status]', s.date, Math.round(s.cash) + '万', s.fleet + '架', s.legsPerDay + '段', '声誉' + s.reputation);

const at = await J('hjyt_audit');
const a = at.result || at.audit || at;
console.log('[audit]', { fleet: a.fleet, legs: a.legsDay0, minStop: a.minStop, maxArr: a.maxArr, stop: a.stopIssues, interval: a.intervalIssues });

// 排班方案（只读）：新局常见「飞机没有 base 机场」，要看得到原因而不是崩
const ps = await J('hjyt_plan_sched', { mode: 'idle', maxLegs: 8 });
const planned = (ps.plans || []).filter((p) => p.ok);
console.log('[plan_sched]', ps.ok ? `目标 ${ps.generatedFor} 架 · 可排 ${planned.length} 架 / 共 ${ps.totalLegs || 0} 段` + (ps.issues && ps.issues.length ? ' · 阻塞：' + ps.issues.slice(0, 2).join('；') : '') : 'FAIL ' + JSON.stringify(ps).slice(0, 300));

const c = await J('hjyt_checks');
console.log('[checks]', c.source, 'exit=' + c.exitCode, ((c.warn || []).slice(0, 3)));

// v0.3 四个只读向导（断言与存档无关：新局/老局/空局都要能跑）
const bp = await J('hjyt_buy_plan', { limit: 5 });
if (!bp.ok) console.log('[buy_plan] FAIL', JSON.stringify(bp).slice(0, 300));
else if (!bp.totalCandidates) console.log('[buy_plan] 0 候选（正常：预算/机库位不允许）· 预算 ' + bp.budget + ' 万 · 首个拦截原因：' + (((bp.blocked || [])[0] || {}).reason || '无'));
else {
  const t = bp.candidates[0];
  console.log('[buy_plan]', `候选 ${bp.totalCandidates} 条 · 预算 ${bp.budget} 万 · top: ${t.model}@${t.base} ${t.seats}座 回本 ${t.paybackDays} 天 / 日净利 ${t.dailyNet} 万`);
}

const rp = await J('hjyt_route_plan', { limit: 5 });
if (!rp.ok) console.log('[route_plan] FAIL', JSON.stringify(rp).slice(0, 300));
else {
  const t = rp.candidates[0] || {};
  console.log('[route_plan]', `出港 ${(rp.froms || []).join('/')} · 匹配 ${rp.matched} 条 · top: ${t.from || '-'}→${t.to || '-'} own ${t.own || 0} · 建议 ${t.suggestModel || '-'} ${t.suggestSeats || 0}座×${t.suggestFlightsPerDay || 0}/日`);
}

const hh = await J('hjyt_sched_health', { limit: 3 });
if (hh.ok == null) console.log('[sched_health] FAIL', JSON.stringify(hh).slice(0, 300));
else {
  console.log('[sched_health]', `critical ${hh.critical} · ${JSON.stringify(hh.summary)}`);
  if (hh.advice && hh.advice.length) console.log('   建议：' + hh.advice[0]);
}

// 游戏内校验（validateFullSchedule）：和游戏时刻表对话框点「校验」同一套规则
const sv = await J('hjyt_sched_verify', { limit: 60 });
if (sv && sv.verdict) {
  console.log('[sched_verify]', (sv.verdict || '-') + ' · 通过 ' + (sv.passed || 0) + ' · 可能晚点 ' + (sv.partial || 0) + ' · 不通过 ' + (sv.failed || 0) + ' · ' + String(sv.text || '').slice(0, 200));
  const bad = (sv.items || []).filter((x) => x.ok && (x.hasHardError || x.confirmable === false));
  for (const x of bad.slice(0, 3)) console.log('   × ' + (x.reg || x.id) + ' ' + (x.legs || 0) + ' 段/周：' + (x.issues || []).slice(0, 2).map((i) => i.text + (i.where ? '（' + i.where + '）' : '')).join('；'));
} else console.log('[sched_verify] FAIL', JSON.stringify(sv).slice(0, 300));

// 三步排班第 1 步（只读）：靠「游戏里选中的航线」
const sp = await J('hjyt_sched_pick');
if (sp.needSelect) console.log('[sched_pick] 未选航线（正常）：' + sp.reason);
else if (!sp.ok) console.log('[sched_pick] FAIL', JSON.stringify(sp).slice(0, 300));
else {
  const okList = (sp.aircraft || []).filter((a) => a.ok).map((a) => a.reg + ' ' + a.legs + '段');
  console.log('[sched_pick]', `「${sp.route}」${sp.km}km · 可排 ${sp.usable} 架：${okList.join('、') || '无'} · 推荐 ${sp.recommended}`);
}

const bd = await J('hjyt_board', { days: 7, limit: 5 });
if (!bd.ok) console.log('[board] FAIL', JSON.stringify(bd).slice(0, 300));
else {
  const t = bd.today || {};
  console.log('[board]', `今日 ${t.revenue == null ? '—（开局第 1 天，无历史）' : t.revenue + ' 万'} · 日均净利 ${bd.avgNet == null ? '—' : bd.avgNet + ' 万'} · 弱航线 ${((bd.routes || {}).weak || []).length} 条 · 油 ${(bd.fuel || {}).days == null ? '—' : (bd.fuel || {}).days + ' 天'}`);
}

// v0.4：油库向导（只读）
const fp = await J('hjyt_fuel_plan');
if (!fp.ok) console.log('[fuel_plan] FAIL', JSON.stringify(fp).slice(0, 300));
else {
  const canSteps = (fp.upgrade.affordableSteps || []).length;
  const needSteps = (fp.upgrade.steps || []).length;
  console.log('[fuel_plan]', `可飞 ${fp.fuelDays} 天 · 满库 ${fp.capacityDays} 天（铁律 ≥${fp.minDays} 天，目标 ${fp.targetDays}）· 扩容 ${canSteps}/${needSteps} 步 · 补油 ${Math.round((fp.refill.liters || 0) / 10000)} 万升 · 共 ${fp.totalCost} 万 · 油价 ${fp.price} 元（${fp.priceBand}）· 可花 ${fp.spendable} 万（留运营垫 ${fp.cashFloor}）`);
}

// v0.4：扩张流水线（只读；默认关掉开线/买机扫描以缩短烟测时间）
const ep = await J('hjyt_expand_plan', { buy: false, route: false });
if (!ep.ok) console.log('[expand_plan] FAIL', JSON.stringify(ep).slice(0, 300));
else {
  console.log('[expand_plan]', `${(ep.steps || []).length} 步（可执行 ${ep.summary.ready}）· 红线 ${(ep.blockers || []).length} 条 · 计划花 ${ep.summary.plannedCost} 万 · 剩 ${ep.summary.cashAfter} 万`);
  for (const st of (ep.steps || []).slice(0, 4)) console.log('   · ' + (st.ready ? '✓' : '✗') + ' ' + st.title + (st.cost ? '（' + st.cost + ' 万）' : ''));
}

// 写操作必须默认拒绝（不带 confirm）；质量闸门（黑名单/Day0–3/LF）与业务性拒绝（机库位/现金/机场）都算通过
const guard = await J('hjyt_buy_apply', { model: 'B737-800', base: '上海浦东' });
const refused = guard.needConfirm || guard.needSecondConfirm || !!guard.gate || /机库位不足|现金不足|基地不存在|机型不存在|不买机|客座率|黑名单/.test(String(guard.reason || ''));
console.log('[write-guard]', refused ? 'OK 未确认即拦下' : 'BAD ' + JSON.stringify(guard).slice(0, 300), guard.reason ? '（' + guard.reason + '）' : '');

const fguard = await J('hjyt_fuel_apply');
const fRefused = fguard.needConfirm || fguard.needSecondConfirm || fguard.skipped === true;
console.log('[fuel-write-guard]', fRefused ? 'OK 未确认即拦下' : 'BAD ' + JSON.stringify(fguard).slice(0, 300), fguard.reason ? '（' + fguard.reason + '）' : '');

disposer && disposer();
process.exit(0);
