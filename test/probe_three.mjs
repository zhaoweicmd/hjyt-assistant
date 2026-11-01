// 一次性探针：对指定 3 架跑「游戏内校验 + 排班体检」，走插件同一条代码路径
import { apply } from '../lib/index.js';

const IDS = ['ac_1792484100178_2', 'ac_1792494326536_75', 'ac_1792497954807_12'];
const tools = {};
await apply({
  tools: { register: (t) => { tools[t.name] = t; return () => delete tools[t.name]; } },
  inject(names, cb) {
    const webServer = { register: () => () => {} };
    cb({ tools: { register: (t) => { tools[t.name] = t; return () => delete tools[t.name]; } }, webServer });
  },
  on() {}, effect() {},
}, {});

const J = async (t, a = {}) => {
  const r = await tools[t].execute(a, {});
  const raw = (r && typeof r === 'object' && r.text != null) ? r.text : r;
  return JSON.parse(raw);
};

for (const id of IDS) {
  const v = await J('hjyt_sched_verify', { acId: id });
  console.log('[verify]', id, JSON.stringify({ verdict: v.verdict, text: v.text, checked: v.checked, items: (v.items || []).map(i => ({ reg: i.reg, passed: i.passed, partial: i.partial, issues: (i.issues || []).slice(0, 3) })) }).slice(0, 900));
}

const h = await J('hjyt_sched_health', {});
const regs = ['上海-拉萨', '上海-厦门', '上海-首尔②'];
const rows = (h.rows || h.aircraft || h.items || []);
const pick = rows.filter((r) => regs.some((x) => String(r.reg || r.regName || '').includes(x)));
console.log('[health]', JSON.stringify({ ok: h.ok, total: rows.length, pick: pick.slice(0, 6), reds: (h.reds || h.issues || []).slice(0, 8) }).slice(0, 2000));
