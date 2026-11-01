// 检查 HUD 是否注入成功、渲染是否正常（只读）
import { GameClient } from '../lib/index.js';
import { resolveProfile } from '../lib/profile.js';
const g = new GameClient(resolveProfile({}));
await g.ensureHud();
const r = await g.evalJson(`(() => {
  const h = window.__HJYT_HUD
  const off = !!window.__HJYT_HUD_OFF
  const root = h && h.root
  return JSON.stringify({
    ok: !!h, version: h && h.version, off,
    mounted: !!(root && root.parentNode), rows: root ? root.innerText.split('\\n').filter(function (s) { return s.trim() }).length : 0,
    text: root ? root.innerText.replace(/\\n+/g, ' | ').slice(0, 260) : null,
    queue: (window.__HJYT_QUEUE || []).length,
  })
})()`);
console.log(JSON.stringify(r, null, 1));
g.close();
process.exit(0);
