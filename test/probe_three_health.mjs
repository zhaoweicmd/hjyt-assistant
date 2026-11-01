// 一次性探针：把三架在「排班体检」里命中的红项挑出来
import { apply } from '../lib/index.js';

const REGS = ['上海-拉萨', '上海-厦门', '上海-首尔②'];
const tools = {};
await apply({
  tools: { register: (t) => { tools[t.name] = t; return () => delete tools[t.name]; } },
  inject(names, cb) {
    const webServer = { register: () => () => {} };
    cb({ tools: { register: (t) => { tools[t.name] = t; return () => delete tools[t.name]; } }, webServer });
  },
  on() {}, effect() {},
}, {});
const r = await tools['hjyt_sched_health'].execute({}, {});
const h = JSON.parse((r && r.text != null) ? r.text : r);
const buckets = ['idle', 'underused', 'tightStop', 'belowGround', 'lateFirst', 'earlyLast', 'lowUtil', 'highUtil', 'overflow', 'badGap', 'misplaced', 'stuckFerry'];
const hits = {};
for (const b of buckets) {
  const arr = h[b] || [];
  const f = arr.filter((x) => REGS.some((rr) => String(x.reg || '').includes(rr)));
  if (f.length) hits[b] = f.map((x) => ({ reg: x.reg, legs: x.legs, first: x.first, last: x.last, util: x.util, minStop: x.minStop, cur: x.cur, firstFrom: x.firstFrom }));
}
console.log(JSON.stringify({ date: h.date, paused: h.paused, summary: h.summary, hits: hits }, null, 1));
