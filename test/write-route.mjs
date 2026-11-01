// 开线写路径联调（会真的改游戏数据）：
//   node test/write-route.mjs                 只看方案（不写）
//   node test/write-route.mjs --run           真开线 → 自检 → 立即删回原状
//   node test/write-route.mjs --run --keep    真开线并保留
import { apply, GameClient } from '../lib/index.js';
import { resolveProfile } from '../lib/profile.js';
const RUN = process.argv.includes('--run');
const KEEP = process.argv.includes('--keep');
const FROM = process.env.HJYT_FROM || '上海浦东';
const TO = process.env.HJYT_TO || '杭州萧山';

const tools = {};
await apply({
  tools: { register: (t) => { tools[t.name] = t; return () => {}; } },
  inject(names, cb) { cb({ webServer: { register: () => () => {} } }); },
  on() {}, effect() {},
}, {});
const J = async (t, a) => JSON.parse(await tools[t].execute(a, {}));

const before = await J('hjyt_status');
const fleet0 = before.status.fleet;
const money0 = before.status.cash;

const preview = await J('hjyt_route_apply', { from: FROM, to: TO });
console.log('[preview]', preview.needConfirm ? 'needConfirm ✓' : 'UNEXPECTED', JSON.stringify(preview.plan || preview).slice(0, 400));
if (!RUN) process.exit(0);

const applied = await J('hjyt_route_apply', { from: FROM, to: TO, confirm: true, secondConfirm: true });
console.log('[apply]', applied.ok ? 'OK' : 'FAIL', JSON.stringify({ created: applied.created, verify: applied.verify, warn: applied.warn }).slice(0, 1200));

// 删回原状
if (!KEEP) {
  const g = new GameClient(resolveProfile({}));
  const del = await g.evalJson(`(() => {
    const G = (typeof GameState !== 'undefined') ? GameState : window.GameState
    const pairs = ${JSON.stringify([[FROM, TO], [TO, FROM]])}
    const out = []
    for (const pr of pairs) {
      const r = (G.routes || []).find(function (x) { return x && x.from === pr[0] && x.to === pr[1] })
      if (!r) { out.push({ pair: pr.join('→'), ok: false, reason: 'not found' }); continue }
      let res = null
      try { res = deleteRoute(r.id) } catch (e) { res = { success: false, msg: String((e && e.message) || e) } }
      out.push({ pair: pr.join('→'), ok: !!(res && res.success), rid: r.id, msg: (res && res.msg) || null })
    }
    return JSON.stringify({ ok: out.every(function (x) { return x.ok }), out, routes: (G.routes || []).length })
  })()`);
  console.log('[rollback]', JSON.stringify(del).slice(0, 500));
  g.close();
}

const after = await J('hjyt_status');
console.log('[after]', after.status.date, Math.round(after.status.cash) + '万', after.status.fleet + '架',
  '现金变化', (after.status.cash - money0).toFixed(2) + '万', '机队变化', after.status.fleet - fleet0);
process.exit(0);
