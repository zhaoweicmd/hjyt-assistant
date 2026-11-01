// 假 webServer 驱动 /hjyt/* 路由（不需要 DSH 宿主）
import { apply } from '../lib/index.js';
const tools = {};
let handler = null;
await apply({
  tools: { register: (t) => { tools[t.name] = t; return () => {}; } },
  inject(names, cb) { cb({ webServer: { register: (r) => { handler = r.handler; return () => {}; } } }); },
  on() {}, effect() {},
}, {});
if (!handler) { console.log('no handler'); process.exit(1); }
const call = async (path) => {
  let code = 0, body = '';
  const res = { writeHead: (c) => { code = c }, end: (b) => { body = b } };
  await handler({ url: path }, res);
  return { code, body };
};
for (const p of ['/hjyt/state', '/hjyt/panel', '/hjyt/board?days=7', '/hjyt/health', '/hjyt/buyplan', '/hjyt/routeplan']) {
  const t0 = Date.now();
  const r = await call(p);
  let j = null; try { j = JSON.parse(r.body) } catch (e) {}
  const brief = p === '/hjyt/panel' ? (r.body.length + ' bytes html')
    : (j && (j.ok === false ? 'FAIL ' + (j.reason || j.error) : 'ok')) ;
  console.log(String(r.code).padEnd(4), p.padEnd(26), String(Date.now() - t0).padStart(6) + 'ms', brief);
}
process.exit(0);
