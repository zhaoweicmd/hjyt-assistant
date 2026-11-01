// 航迹云途 · 游戏内 HUD（由插件通过 CDP 注入，只读显示 + 命令队列）
// 约束：本脚本绝不直接调用游戏写接口；按钮只往 window.__HJYT_QUEUE 压命令，
//       真正的写操作由插件宿主执行（白名单 + 快照 + 日志）。
;(function () {
  var VERSION = '__HJYT_VERSION__'
  window.__HJYT_HUD_VER__ = VERSION
  // 已经挂过同版本、而且节点还在页面上 → 什么都不做（避免叠层）
  // 注意：读档 / 游戏整页重绘会把 HUD 节点摘掉，这时 window.__HJYT_HUD 还在，
  // 只按 version 判断会误以为「已挂载」，面板就此永远消失 —— 必须一起看 DOM。
  var alive = null
  try {
    // 只认「在场且可见」的那一份：被置灰的旧实例残骸也会命中 [data-hjyt-hud]，
    // 若把它当活体，重注入就会被误判为「已挂载」直接返回（面板再也回不来）
    var cands = document.querySelectorAll('[data-hjyt-hud]')
    for (var ci = 0; ci < cands.length; ci++) {
      if (cands[ci].isConnected && cands[ci].style.display !== 'none') { alive = cands[ci]; break }
    }
  } catch (e) {}
  alive = !!alive
  if (window.__HJYT_HUD && window.__HJYT_HUD.version === VERSION && alive) return
  // 实例令牌：同一页面会被重复注入（版本升级、看门狗重推），只有**最新实例**的定时器有权
  // 自愈 / 清理面板；旧实例看到令牌变了就 clearInterval 退休 —— 否则每个旧实例都会把自己
  // 那份 root 每秒挂回 DOM，屏幕上就叠出好几个面板（2026-10-20 用户报「一开就开了几个面板」）
  var TOKEN = VERSION + '#' + Date.now() + '#' + Math.random().toString(36).slice(2)
  window.__HJYT_HUD_TOKEN = TOKEN
  // 换版本重新注入时：清掉旧 HUD 的 DOM（否则会叠多层）并解除「已关闭」
  window.__HJYT_HUD_OFF = false
  try {
    var olds = document.querySelectorAll('[data-hjyt-hud]')
    for (var oi = 0; oi < olds.length; oi++) { olds[oi].parentNode && olds[oi].parentNode.removeChild(olds[oi]) }
  } catch (e) {}
  window.__HJYT_QUEUE = window.__HJYT_QUEUE || []

  function el(tag, style, text) {
    var d = document.createElement(tag)
    if (style) d.setAttribute('style', style)
    if (text != null) d.textContent = text
    return d
  }

  var root = el('div', [
    'position:fixed', 'right:14px', 'bottom:14px', 'z-index:2147483000',
    // 宽度自适应：默认按内容撑开（飞机名/改排按钮不再被挤成竖排），最宽不超过屏幕 92%；右下角可手动拖宽
    'width:max-content', 'min-width:250px', 'max-width:min(92vw,520px)', 'max-height:92vh',
    'box-sizing:border-box', 'resize:horizontal', 'overflow:auto',
    'padding:10px 12px', 'border-radius:12px',
    'background:rgba(16,20,28,0.92)', 'color:#e8eef7',
    'font:12px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
    'box-shadow:0 10px 30px rgba(0,0,0,0.45)', 'border:1px solid rgba(120,170,255,0.28)',
    'user-select:none', 'backdrop-filter:blur(6px)'
  ].join(';'))
  root.setAttribute('data-hjyt-hud', VERSION)

  var head = el('div', 'display:flex;align-items:center;justify-content:space-between;cursor:move;margin-bottom:6px')
  var title = el('div', 'font-weight:600;font-size:12px;color:#8fb8ff', '航迹云途 HUD')
  var btns = el('div', 'display:flex;gap:6px')
  var toggle = el('span', 'cursor:pointer;opacity:.75;font-size:13px', '－')
  var close = el('span', 'cursor:pointer;opacity:.5;font-size:13px', '×')
  btns.appendChild(toggle); btns.appendChild(close)
  head.appendChild(title); head.appendChild(btns)

  var body = el('div', '')
  var grid = el('div', 'display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;font-variant-numeric:tabular-nums')
  var act = el('div', 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px')
  var warnBox = el('div', 'margin-top:7px;font-size:11px;line-height:1.45;color:#ffcf7a;display:none')
  var lastBox = el('div', 'margin-top:6px;font-size:11px;line-height:1.45;color:#93e2b4;display:none')

  // 三步排班的选择区：选航线（游戏里）→ 选飞机（这里）→ 确认
  var pickBox = el('div', 'margin-top:8px;border-top:1px solid rgba(120,170,255,0.18);padding-top:7px;display:none')
  var pickTitle = el('div', 'font-size:11px;color:#9fc0ff;margin-bottom:5px;line-height:1.4')
  var pickList = el('div', 'display:flex;flex-direction:column;gap:4px;max-height:190px;overflow:auto')
  var pickActions = el('div', 'display:flex;gap:6px;margin-top:6px')
  var pickConfirm = el('button', 'flex:1;padding:5px;border-radius:7px;border:1px solid rgba(120,255,180,0.4);background:rgba(40,160,90,0.3);color:#d8ffe9;cursor:pointer;font:11px/1.2 inherit', '确认排班')
  var pickCancel = el('button', 'flex:0 0 62px;padding:5px;border-radius:7px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.06);color:#cfd8e6;cursor:pointer;font:11px/1.2 inherit', '取消')
  pickActions.appendChild(pickConfirm)
  pickActions.appendChild(pickCancel)
  var maintMode = 'night'
  var pickMaintRow = el('div', 'display:flex;gap:4px;align-items:center;margin-top:6px;font-size:10.5px')
  var pickMaintLabel = el('span', 'color:#8b9bb0;margin-right:2px', '维修窗口')
  var maintBtns = {}
  ;['night', 'day', 'none'].forEach(function (m) {
    var b = el('button', 'padding:2px 7px;border-radius:5px;cursor:pointer;font:10px/1.2 inherit;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.05);color:#cfd8e6', m === 'night' ? '夜间' : m === 'day' ? '白天' : '不预留')
    b.onclick = function () {
      maintMode = m
      paintMaint()
      // 换了窗口就按当前航线/飞机重算一遍方案
      window.__HJYT_QUEUE.push({ cmd: 'sched_pick', acId: lastPickAc, maint: maintMode, maxUtil: utilCap, ts: Date.now() })
    }
    maintBtns[m] = b
    pickMaintRow.appendChild(b)
  })
  pickMaintRow.insertBefore(pickMaintLabel, maintBtns.night)
  function paintMaint() {
    ;['night', 'day', 'none'].forEach(function (m) {
      var on = m === maintMode
      var b = maintBtns[m]
      if (!b) return
      b.style.border = '1px solid ' + (on ? 'rgba(120,200,255,0.7)' : 'rgba(255,255,255,0.15)')
      b.style.background = on ? 'rgba(70,140,220,0.35)' : 'rgba(255,255,255,0.05)'
      b.style.color = on ? '#e8f2ff' : '#cfd8e6'
    })
  }
  var lastPickAc = null
  var fixedMark = {}   // 本会话里已跑过一键排班的机名 → 面板里标「已重排」
  // 起飞城市：这条航线的两端，点哪个就从哪端起飞（跟游戏手动排班一样，不要求飞机已经在那儿）
  var depRow = el('div', 'display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-top:4px;font-size:10.5px')
  var depLabel = el('span', 'color:#8b9bb0;margin-right:2px', '起飞')
  var depKey = ''
  function paintDep(p) {
    var eps = (p && p.endpoints) || []
    var key = eps.join('|') + '#' + (p && p.startAt)
    if (key === depKey) return
    depKey = key
    depRow.textContent = ''
    depRow.appendChild(depLabel)
    if (!eps.length) return
    eps.forEach(function (ap) {
      var on = p && ap === p.startAt
      var b = el('button', 'padding:2px 7px;border-radius:5px;cursor:pointer;font:10px/1.2 inherit;white-space:nowrap;border:1px solid ' +
        (on ? 'rgba(120,200,255,0.7)' : 'rgba(255,255,255,0.15)') + ';background:' +
        (on ? 'rgba(70,140,220,0.35)' : 'rgba(255,255,255,0.05)') + ';color:' + (on ? '#e8f2ff' : '#cfd8e6'), String(ap).slice(0, 6))
      b.onclick = function () {
        window.__HJYT_QUEUE.push({ cmd: 'sched_pick', acId: lastPickAc, maint: maintMode, startAt: ap, ts: Date.now() })
      }
      depRow.appendChild(b)
    })
  }
  // 利用率上限：85%（默认，优先吃满运力）/ 70%（报告实测保守值）/ 不限
  var utilCap = 0.85
  var utilRow = el('div', 'display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-top:4px;font-size:10.5px')
  var utilLabel = el('span', 'color:#8b9bb0;margin-right:2px', '利用率')
  var utilBtns = {}
  ;[['70', 0.7], ['85', 0.85], ['不限', 0]].forEach(function (pair) {
    var k = String(pair[1])
    var b = el('button', 'padding:2px 7px;border-radius:5px;cursor:pointer;font:10px/1.2 inherit;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.05);color:#cfd8e6', pair[0])
    b.onclick = function () {
      utilCap = Number(pair[1])
      paintUtil()
      window.__HJYT_QUEUE.push({ cmd: 'sched_pick', acId: lastPickAc, maint: maintMode, maxUtil: utilCap, ts: Date.now() })
    }
    utilBtns[k] = b
    utilRow.appendChild(b)
  })
  utilRow.insertBefore(utilLabel, utilBtns['0.7'])
  function paintUtil() {
    Object.keys(utilBtns).forEach(function (k) {
      var on = Math.abs(Number(k) - utilCap) < 1e-6
      var b = utilBtns[k]
      b.style.border = '1px solid ' + (on ? 'rgba(120,200,255,0.7)' : 'rgba(255,255,255,0.15)')
      b.style.background = on ? 'rgba(70,140,220,0.35)' : 'rgba(255,255,255,0.05)'
      b.style.color = on ? '#e8f2ff' : '#cfd8e6'
    })
  }
  paintUtil()
  pickBox.appendChild(pickTitle)
  pickBox.appendChild(pickList)
  pickBox.appendChild(depRow)
  pickBox.appendChild(utilRow)
  pickBox.appendChild(pickMaintRow)
  pickBox.appendChild(pickActions)

  function mkBtn(label, cmd, arg) {
    var b = el('button', [
      'flex:1 0 44%', 'padding:5px 6px', 'border-radius:7px', 'cursor:pointer',
      'border:1px solid rgba(120,170,255,0.35)', 'background:rgba(70,120,220,0.22)',
      'color:#dbe7fb', 'font:11px/1.2 inherit'
    ].join(';'), label)
    b.onclick = function () {
      window.__HJYT_QUEUE.push(Object.assign({ cmd: cmd, ts: Date.now() }, arg || {}))
      b.style.background = 'rgba(120,170,255,0.5)'
      setTimeout(function () { b.style.background = 'rgba(70,120,220,0.22)' }, 260)
    }
    return b
  }

  act.appendChild(mkBtn('推进1天', 'daily', { n: 1 }))
  act.appendChild(mkBtn('推到5日节点', 'daily5'))
  act.appendChild(mkBtn('航线设置', 'routesetup', { all: true }))
  act.appendChild(mkBtn('检修', 'inspect'))
  var schedBtn = mkBtn('排班', 'noop')
  schedBtn.onclick = function () {
    window.__HJYT_QUEUE.push({ cmd: 'sched_pick', acId: lastPickAc, maint: maintMode, maxUtil: utilCap, ts: Date.now() })
    schedBtn.style.background = 'rgba(120,170,255,0.5)'
    setTimeout(function () { schedBtn.style.background = 'rgba(70,120,220,0.22)' }, 260)
  }
  act.appendChild(schedBtn)
  var buyBtn = mkBtn('购买飞机', 'noop')
  buyBtn.onclick = function () {
    buyBox.style.display = buyBox.style.display === 'none' ? '' : 'none'
    if (buyBox.style.display === '') { try { buyInput.focus() } catch (e) {} }
  }
  act.appendChild(buyBtn)
  act.appendChild(mkBtn('改名(按城市)', 'renameroute', { apply: true }))
  act.appendChild(mkBtn('客舱重建', 'cabinrebuild', { apply: false }))

  act.appendChild(mkBtn('看板', 'board'))
  act.appendChild(mkBtn('体检', 'health'))
  var devBtn = mkBtn('开线', 'noop')
  devBtn.onclick = function () { openDev() }
  act.appendChild(devBtn)
  act.appendChild(mkBtn('机场查询', 'airportquery'))

  // ---- 买机区（输入机型 → 自动配舱 + 全设施 + 节油发动机）----
  var buyBox = el('div', 'margin-top:8px;border-top:1px solid rgba(120,170,255,0.18);padding-top:7px;display:none')
  var buyInput = el('input', [
    'width:100%', 'box-sizing:border-box', 'padding:5px 6px', 'border-radius:6px',
    'border:1px solid rgba(120,170,255,0.35)', 'background:rgba(0,0,0,0.35)', 'color:#e8eef7', 'font:11px/1.2 inherit', 'outline:none'
  ].join(';'))
  buyInput.setAttribute('placeholder', '输入机型：B737-800 / A320neo / B787-9 / B757-200')
  var buyRow1 = el('div', 'display:flex;gap:6px;margin-top:6px')
  var buyQuery = el('button', 'flex:1;padding:5px;border-radius:7px;border:1px solid rgba(120,170,255,0.45);background:rgba(70,120,220,0.3);color:#dbe7fb;cursor:pointer;font:11px/1.2 inherit', '查报价')
  var buyClose = el('button', 'flex:0 0 58px;padding:5px;border-radius:7px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.05);color:#cfd8e6;cursor:pointer;font:11px/1.2 inherit', '取消')
  buyRow1.appendChild(buyQuery)
  buyRow1.appendChild(buyClose)
  // 数量：一次买多架（引擎每买 1 架全场涨价 1.5%，总价按等比级数累加，不是单价×架数）
  var buyQty = 1
  var buyQtyRow = el('div', 'display:flex;gap:6px;margin-top:6px;align-items:center')
  var buyQtyTxt = el('div', 'flex:1;font-size:11px;color:#cfe3ff', '数量：1 架')
  var buyQtyMinus = el('button', 'flex:0 0 34px;padding:4px;border-radius:7px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.05);color:#cfd8e6;cursor:pointer;font:11px/1.2 inherit', '−')
  var buyQtyPlus = el('button', 'flex:0 0 34px;padding:4px;border-radius:7px;border:1px solid rgba(120,170,255,0.45);background:rgba(70,120,220,0.3);color:#dbe7fb;cursor:pointer;font:11px/1.2 inherit', '＋')
  buyQtyRow.appendChild(buyQtyTxt)
  buyQtyRow.appendChild(buyQtyMinus)
  buyQtyRow.appendChild(buyQtyPlus)
  var buyResult = el('div', 'margin-top:6px;font-size:11px;line-height:1.5;color:#cfe3ff')
  var buyOk = el('button', 'width:100%;margin-top:6px;padding:5px;border-radius:7px;border:1px solid rgba(120,255,180,0.45);background:rgba(40,160,90,0.32);color:#d8ffe9;cursor:pointer;font:11px/1.2 inherit;display:none', '确认购买')
  buyBox.appendChild(buyInput)
  buyBox.appendChild(buyRow1)
  buyBox.appendChild(buyQtyRow)
  buyBox.appendChild(buyResult)
  buyBox.appendChild(buyOk)

  // ---- 体检面板（可点一键修复）----
  var healthBox = el('div', 'margin-top:8px;border-top:1px solid rgba(120,170,255,0.18);padding-top:7px;display:none')
  var healthTitle = el('div', 'font-size:11px;color:#9fc0ff;margin-bottom:5px')
  var healthList = el('div', 'display:flex;flex-direction:column;gap:3px;max-height:170px;overflow:auto;font-size:11px')
  healthBox.appendChild(healthTitle)
  healthBox.appendChild(healthList)

  // ---- 客舱重建面板 ----
  var cabBox = el('div', 'margin-top:8px;border-top:1px solid rgba(120,170,255,0.18);padding-top:7px;display:none')
  var cabTitle = el('div', 'font-size:11px;color:#9fc0ff;margin-bottom:5px')
  var cabList = el('div', 'display:flex;flex-direction:column;gap:3px;max-height:150px;overflow:auto;font-size:11px')
  var cabRow = el('div', 'display:flex;gap:6px;margin-top:6px')
  var cabOk = el('button', 'flex:1;padding:5px;border-radius:7px;border:1px solid rgba(120,255,180,0.45);background:rgba(40,160,90,0.32);color:#d8ffe9;cursor:pointer;font:11px/1.2 inherit', '确认重建')
  var cabClose = el('button', 'flex:0 0 58px;padding:5px;border-radius:7px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.05);color:#cfd8e6;cursor:pointer;font:11px/1.2 inherit', '取消')
  cabRow.appendChild(cabOk)
  cabRow.appendChild(cabClose)
  cabBox.appendChild(cabTitle)
  cabBox.appendChild(cabList)
  cabBox.appendChild(cabRow)

  // ---- 航线开发面板（输入机场 → 最值得开的 5 条线 + 每条能养几架 B757-200）----
  var devBox = el('div', 'margin-top:8px;border-top:1px solid rgba(120,170,255,0.18);padding-top:7px;display:none')
  var devTitle = el('div', 'font-size:11px;color:#9fc0ff;margin-bottom:5px')
  var devInputRow = el('div', 'display:flex;gap:6px')
  var devInput = el('input', [
    'flex:1', 'min-width:0', 'box-sizing:border-box', 'padding:5px 6px', 'border-radius:6px',
    'border:1px solid rgba(120,170,255,0.35)', 'background:rgba(0,0,0,0.35)', 'color:#e8eef7', 'font:11px/1.2 inherit', 'outline:none'
  ].join(';'))
  devInput.placeholder = '机场名可模糊：浦东 / PVG / 上海 / 东京'
  var devGo = el('button', 'flex:0 0 44px;padding:5px;border-radius:7px;border:1px solid rgba(120,255,180,0.45);background:rgba(40,160,90,0.32);color:#d8ffe9;cursor:pointer;font:11px/1.2 inherit', '查')
  var devClose = el('button', 'flex:0 0 52px;padding:5px;border-radius:7px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.05);color:#cfd8e6;cursor:pointer;font:11px/1.2 inherit', '取消')
  devInputRow.appendChild(devInput)
  devInputRow.appendChild(devGo)
  devInputRow.appendChild(devClose)
  var devList = el('div', 'display:flex;flex-direction:column;gap:4px;max-height:230px;overflow:auto;font-size:11px;margin-top:6px')
  devBox.appendChild(devTitle)
  devBox.appendChild(devInputRow)
  devBox.appendChild(devList)
  var devDeployRow = el('div', 'display:flex;flex-direction:column;gap:4px;margin-top:6px')
  var devDeploy = el('button', 'padding:6px;border-radius:7px;border:1px solid rgba(120,170,255,0.45);background:rgba(70,120,220,0.28);color:#e6eefc;cursor:pointer;font:11px/1.2 inherit;opacity:.45', '一键部署（先点选一条线）')
  var devDeployHint = el('div', 'font-size:10px;color:#9fb6d4;line-height:1.35')
  var devResult = el('div', 'font-size:11px;color:#cfe3ff;line-height:1.4;white-space:pre-wrap')
  devDeployRow.appendChild(devDeploy)
  devDeployRow.appendChild(devDeployHint)
  devDeployRow.appendChild(devResult)
  devBox.appendChild(devDeployRow)



  body.appendChild(grid)
  body.appendChild(act)
  body.appendChild(warnBox)
  body.appendChild(pickBox)
  body.appendChild(buyBox)
  body.appendChild(cabBox)
  body.appendChild(healthBox)
  body.appendChild(devBox)
  body.appendChild(lastBox)
  root.appendChild(head)
  root.appendChild(body)

  // ---- 排班选择区 ----
  var pickData = null, pickIdx = -1, pickTs = 0, pickArmed = -1
  function hh(m) { return m == null ? '--' : String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') }

  function renderPick() {
    var p = window.__HJYT_PICK
    if (!p || !p.ok || !p.rid) { pickBox.style.display = 'none'; pickData = null; pickIdx = -1; return }
    if (p.ts !== pickTs) {
      pickTs = p.ts
      pickData = p
      pickIdx = -1
      pickArmed = -1
      var list0 = p.aircraft || []
      // 默认选推荐的那架
      for (var k = 0; k < list0.length; k++) if (p.recommended && list0[k].id === p.recommended && list0[k].ok) { pickIdx = k; break }
      if (pickIdx < 0) for (var k2 = 0; k2 < list0.length; k2++) if (list0[k2].ok) { pickIdx = k2; break }
    }
    pickBox.style.display = ''
    paintMaint()
    pickTitle.textContent = '排哪架飞「' + p.route + '」（' + p.km + 'km，需求 ' + (p.demand || 0) + '/日）？'
    pickList.textContent = ''
    paintDep(p)
    var list = p.aircraft || []
    if (!list.length) {
      pickList.appendChild(el('div', 'font-size:11px;color:#ffcf7a', '没有可用飞机'))
    }
    var usable = 0
    for (var ui = 0; ui < list.length; ui++) if (list[ui].ok) usable++
    // 一架都排不下时：直接告诉用户「去改选哪条线」，比让他自己猜/白调机快
    if (!usable && p.suggestRoutes && p.suggestRoutes.length) {
      var sr = p.suggestRoutes[0]
      pickList.appendChild(el('div', 'font-size:11px;color:#ffcf7a;margin-bottom:4px;line-height:1.5',
        '闲置机在 ' + ((sr.aircraftAt || []).join('/') || '?') + '：去游戏里改选「' + sr.route + '」（需求 ' + sr.demand + '/日）再点排班；或点下面的「调机」把它挪到航线端点'))
    }
    for (var i = 0; i < list.length; i++) {
      (function (idx) {
        var a = list[idx]
        // 已有排班的飞机不进列表（宿主侧已过滤）→ 列表里只有「整周完全没排班」的闲置机
        var canPick = !!a.ok
        var on = idx === pickIdx && canPick
        var armed = idx === pickArmed
        var row = el('div', [
          'display:flex', 'gap:6px', 'align-items:center', 'padding:4px 6px', 'border-radius:6px', 'font-size:11px',
          'cursor:' + (canPick ? 'pointer' : 'default'),
          'border:1px solid ' + (armed ? 'rgba(255,140,140,0.8)' : (on ? 'rgba(120,200,255,0.75)' : 'rgba(255,255,255,0.08)')),
          'background:' + (armed ? 'rgba(200,60,60,0.28)' : (on ? 'rgba(70,140,220,0.32)' : 'rgba(255,255,255,0.03)')),
          'opacity:' + (canPick ? 1 : 0.72)
        ].join(';'))
        var name = el('div', 'flex:1;min-width:0;color:#dfe9f7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', (on ? '● ' : '○ ') + a.reg)
        var infoTxt
        if (a.ok) {
          infoTxt = a.seats + '座 · ' + a.legs + '段 ' + hh(a.first) + '–' + hh(a.last)
          if (a.maintWarn) infoTxt += ' · ⚠维修位0'
          if (a.maint) {
            infoTxt += a.maint.mode === 'day'
              ? (' · 修昼 ' + hh(a.maint.start) + '–' + hh(a.maint.end))
              : (' · 修夜 ' + (a.maint.gapMin || 0) + '分')
          }
        }
        else if (a.busy) infoTxt = (a.seats ? a.seats + '座 · ' : '') + '已有 ' + a.legs + ' 段'
        else infoTxt = a.reason || '不可用'
        var info = el('div', 'color:#9dbbd9;text-align:right;white-space:nowrap;margin-right:2px', infoTxt)
        row.appendChild(name)
        row.appendChild(info)
        if (canPick) {
          row.onclick = function () { pickArmed = -1; pickIdx = idx; renderPick() }
        }
        // 飞机不在起飞地：给一个「调机→起飞地」按钮（不再拦排班，只是提醒要先挪）
        if (a.positionNote && p.startAt) {
          var fer2 = el('button', [
            'padding:2px 6px', 'border-radius:5px', 'cursor:pointer', 'font:10px/1.2 inherit', 'white-space:nowrap',
            'border:1px solid rgba(255,220,120,0.45)', 'background:rgba(180,150,40,0.3)', 'color:#fff0c2'
          ].join(';'), '调机→' + String(p.startAt).slice(0, 2))
          fer2.onclick = function (ev) {
            if (ev && ev.stopPropagation) ev.stopPropagation()
            window.__HJYT_QUEUE.push({ cmd: 'ferry', acId: a.id, to: p.startAt, ts: Date.now() })
            fer2.textContent = '调机中…'
            fer2.disabled = true
          }
          row.appendChild(fer2)
        }
        if (a.needPosition && a.needPosition.to) {
          var fer = el('button', [
            'padding:2px 6px', 'border-radius:5px', 'cursor:pointer', 'font:10px/1.2 inherit', 'white-space:nowrap',
            'border:1px solid rgba(255,220,120,0.45)', 'background:rgba(180,150,40,0.3)', 'color:#fff0c2'
          ].join(';'), '调机→' + String(a.needPosition.to).slice(0, 2))
          fer.onclick = function (ev) {
            if (ev && ev.stopPropagation) ev.stopPropagation()
            window.__HJYT_QUEUE.push({ cmd: 'ferry', acId: a.id, to: a.needPosition.to, ts: Date.now() })
            fer.textContent = '调机中…'
            fer.disabled = true
          }
          row.appendChild(fer)
        }
        pickList.appendChild(row)
      })(i)
    }
    // 已有排班的飞机不进列表（宿主侧已过滤掉）：一架都没有时直说「无闲置飞机」
    if (!usable) {
      pickList.appendChild(el('div', 'font-size:10.5px;color:#ffcf7a;margin-top:3px;line-height:1.45',
        p.idleCount === 0
          ? '无闲置飞机：全队飞机都已经有排班（面板只列整周完全没有班表的飞机）。要给这条线加运力 → 先买飞机（「购买飞机」），或把已有班表的飞机改派过来（hjyt_sched_apply_pick + mode:replace，写前自动快照、可 hjyt_rollback 回滚）'
          : '没有能排这条线的闲置机：要么航程不够、要么时段/维修位排不下（可切另一端起飞，或先「调机」把飞机挪过来）'))
    }
    var cur = list[pickIdx]
    var curOk = !!(cur && cur.ok)
    pickConfirm.style.opacity = curOk ? 1 : 0.4
    pickConfirm.textContent = curOk ? ('确认：' + cur.reg + ' 排 ' + cur.legs + ' 段') : '确认排班'
  }

  pickConfirm.onclick = function () {
    if (window.__HJYT_INFLIGHT) return           // 防重复提交：上一次还没回来就忽略
    var cur = pickData && pickData.aircraft ? pickData.aircraft[pickIdx] : null
    if (!cur || !cur.ok) return
    window.__HJYT_INFLIGHT = true
    setTimeout(function () { window.__HJYT_INFLIGHT = false }, 2500)
    // 记住这架：下次点「排班」还聚焦它（否则默认会飘到下一架能排的，容易误把第二架也排上去）
    lastPickAc = cur.id
    var msg = { cmd: 'sched_apply_pick', rid: pickData.rid, acId: cur.id, maint: maintMode, startAt: pickData.startAt, maxUtil: utilCap, ts: Date.now() }
    window.__HJYT_QUEUE.push(msg)
    window.__HJYT_PICK = null
    pickBox.style.display = 'none'
    pickData = null
  }
  pickCancel.onclick = function () {
    window.__HJYT_PICK = null
    pickBox.style.display = 'none'
    pickData = null
  }

  // 拖动
  ;(function () {
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0
    head.addEventListener('mousedown', function (e) {
      dragging = true
      sx = e.clientX; sy = e.clientY
      var r = root.getBoundingClientRect()
      ox = r.left; oy = r.top
      root.style.right = 'auto'; root.style.bottom = 'auto'
      root.style.left = ox + 'px'; root.style.top = oy + 'px'
      e.preventDefault()
    })
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return
      root.style.left = ox + (e.clientX - sx) + 'px'
      root.style.top = oy + (e.clientY - sy) + 'px'
    })
    window.addEventListener('mouseup', function () { dragging = false })
  })()

  var collapsed = false
  toggle.onclick = function () {
    collapsed = !collapsed
    body.style.display = collapsed ? 'none' : ''
    toggle.textContent = collapsed ? '＋' : '－'
  }
  close.onclick = function () {
    window.__HJYT_HUD_OFF = true
    root.remove()
    showChip()
  }

  // 「×」只是收起：右下角留一个能点开的小徽标，否则关掉之后只能靠命令行重开
  var chip = null
  function showChip() {
    try {
      if (chip && chip.isConnected) return
      if (!document.body) return
      chip = el('div', [
        'position:fixed', 'right:14px', 'bottom:14px', 'z-index:2147483000',
        'padding:6px 10px', 'border-radius:999px', 'cursor:pointer', 'user-select:none',
        'background:rgba(16,20,28,0.92)', 'color:#8fb8ff', 'font-size:11px;font-weight:600',
        'border:1px solid rgba(120,170,255,0.28)', 'box-shadow:0 6px 18px rgba(0,0,0,0.45)'
      ].join(';'), '🛩 HUD')
      chip.setAttribute('data-hjyt-chip', VERSION)
      chip.title = '点一下重新打开航迹云途 HUD'
      chip.onclick = function () { reopenHud() }
      document.body.appendChild(chip)
    } catch (e) {}
  }
  function hideChip() {
    try { if (chip && chip.isConnected) chip.remove() } catch (e) {}
  }
  function reopenHud() {
    window.__HJYT_HUD_OFF = false
    hideChip()
    try {
      if (!root.isConnected && document.body) document.body.appendChild(root)
      render()
    } catch (e) {}
  }

  function fmtMoney(v) {
    if (v == null) return '--'
    if (v >= 10000) return (v / 10000).toFixed(2) + ' 亿'
    return v.toFixed(0) + ' 万'
  }

  function row(k, v, color) {
    var a = el('div', 'opacity:.62', k)
    var b = el('div', 'text-align:right;font-weight:600' + (color ? ';color:' + color : ''), v)
    return [a, b]
  }

  // 读档 / 换局 / 推进一天：游戏时间或机队变了 → 上一次的工具结果全部作废，
  // 否则面板会一直显示「旧飞机、旧时段」（用户 2026-10-20 报「插件没重读飞机状态」）
  function resetPanelsForNewSession() {
    window.__HJYT_LAST = null
    window.__HJYT_PICK = null
    window.__HJYT_AC = null
    window.__HJYT_BUY = null
    window.__HJYT_HEALTH = null
    window.__HJYT_CABIN = null
    window.__HJYT_FUEL = null
    try { pickData = null; pickIdx = -1; pickTs = 0; pickArmed = -1 } catch (e) {}
    try { buyData = null; buyTs = 0; buyArmed = false } catch (e) {}
    try { healthTs = 0; fixedMark = {} } catch (e) {}
    try { window.__HJYT_HEALTH_ASKED = null } catch (e) {}
    try { cabData = null; cabTs = 0 } catch (e) {}
    try { devData = null; devTs = 0 } catch (e) {}
    try { devSel = -1; devDeployArmed = false; devArmedFor = ''; devDeployBusy = false; devResult.textContent = ''; devDeployHint.textContent = ''; paintDevDeploy() } catch (e) {}
    try { pickBox.style.display = 'none' } catch (e) {}
    try { buyBox.style.display = 'none'; buyResult.textContent = ''; buyOk.style.display = 'none' } catch (e) {}
    try { buyQty = 1; paintQty() } catch (e) {}
    try { healthBox.style.display = 'none' } catch (e) {}
    try { cabBox.style.display = 'none' } catch (e) {}
    try { devBox.style.display = 'none' } catch (e) {}
    try { lastBox.style.display = 'none' } catch (e) {}
  }

  var lastRendered = 0
  function render() {
    try {
      if (window.__HJYT_HUD_OFF) return
      var G = (typeof GameState !== 'undefined') ? GameState : window.GameState
      if (!G) { grid.textContent = ''; grid.appendChild(el('div', 'grid-column:1/3;opacity:.6', '等待进入游戏…')); return }
      var acs = (G.aircrafts || []).filter(function (a) { return !a.hasSold })
      var sched = G.schedule || {}
      var legs = 0
      for (var i = 0; i < acs.length; i++) {
        var d = sched[acs[i].id]
        if (!Array.isArray(d) || !Array.isArray(d[0])) continue
        for (var k = 0; k < d[0].length; k++) if (d[0][k] && !d[0][k].cancelled) legs++
      }
      // 会话指纹 = 游戏「日期」+ 机队 id + 班次总数：变了才是「读档 / 换局 / 推进到第二天」→ 清空上次的工具结果
      // ⚠ 原来用 String(G.gameTime)：游戏时钟每秒走 1 分钟，指纹每秒都变 → 所有面板每秒被隐藏一次，
      //   买机输入框根本来不及填（2026-10-31 用户报「点购买飞机总是关闭」）。日期/机队/班次不变就绝不清面板。
      // 班次总数进指纹是为了兜住「同一天读另一个存档」（AUTO-1..5 常停在同一游戏日）。
      var _dt = new Date(G.gameTime)
      var _dstr = _dt.getFullYear() + '-' + (_dt.getMonth() + 1) + '-' + _dt.getDate()
      var sig = _dstr + '|' + acs.map(function (a) { return a.id }).join(',') + '|' + legs
      if (window.__HJYT_SIG !== sig) {
        var hadSession = window.__HJYT_SIG != null
        window.__HJYT_SIG = sig
        resetPanelsForNewSession()
        if (hadSession) window.__HJYT_STALE_AT = Date.now()
      }
      var t = new Date(G.gameTime)
      var dateStr = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0')
      var healths = acs.map(function (a) { return Number(a.health != null ? a.health : 100) })
      var hmin = healths.length ? Math.min.apply(null, healths) : 100
      var fuel = Number(G.fuelRemaining || 0), cap = Number(G.fuelCapacity || 0)
      // 日耗优先用引擎记录的昨日实际耗油；没有就按「每段 6,800L × 航距/1233」粗估
      var perDay = Number(G.fuelConsumedYesterday || 0) || Number(G.fuelConsumedToday || 0)
      if (!perDay) perDay = legs > 0 ? legs * 6800 * 0.55 : 0
      var fdays = perDay > 0 ? Math.round((fuel / perDay) * 100) / 100 : null
      // 夜停占用：按机场统计「当前停留的飞机 / 停机位上限」，超容是唯一的事故源
      var apNow = {}, apCap = {}, apOver = []
      var airportObj = G.airports || {}
      for (var an in airportObj) {
        if (!Object.prototype.hasOwnProperty.call(airportObj, an)) continue
        var o = airportObj[an]
        if (!o) continue
        apCap[an] = (typeof getAirportMaxParked === 'function') ? getAirportMaxParked(o) : (AIRPORT_LEVELS && AIRPORT_LEVELS[o.level || 'normal'] ? AIRPORT_LEVELS[o.level || 'normal'].maxParked : 2)
      }
      for (var ai = 0; ai < acs.length; ai++) {
        var cur = acs[ai].currentAirport || (acs[ai].status === 'parked' ? acs[ai].baseAirport : null)
        if (!cur) continue
        apNow[cur] = (apNow[cur] || 0) + 1
      }
      var worstAp = null
      for (var an2 in apNow) {
        if (!Object.prototype.hasOwnProperty.call(apNow, an2)) continue
        var c2 = apCap[an2] || 0
        if (apNow[an2] > c2) apOver.push(an2 + ' ' + apNow[an2] + '/' + c2)
        if (!worstAp || apNow[an2] / Math.max(1, c2) > apNow[worstAp] / Math.max(1, apCap[worstAp] || 1)) worstAp = an2
      }

      // 前日利润：取「最近一个已结束的营业日」各模块账单汇总
      // 口径 = 收入（客运 revenue + 包机订单 orderRevenue + 事件奖励 + 赔偿）
      //      − 支出（燃油 / 维修 / 设备 / 餐食，账单里都是负数）
      // 不含 equipmentInvestment（买 WiFi/发动机等属资本开支，一次性砸穿单日利润）
      var prevProfit = null, prevDay = null
      try {
        var pnum = function (v) { var x = Number(v); return isFinite(x) ? x : 0 }
        var _t0 = new Date(G.gameTime)
        _t0.setHours(0, 0, 0, 0)
        var _todayKey = _t0.getFullYear() + '-' + String(_t0.getMonth() + 1).padStart(2, '0') + '-' + String(_t0.getDate()).padStart(2, '0')
        var _mods = G.modules || {}
        for (var _m1 in _mods) {
          if (!Object.prototype.hasOwnProperty.call(_mods, _m1)) continue
          var _ds1 = _mods[_m1] && _mods[_m1].dailyStats
          if (!Array.isArray(_ds1)) continue
          for (var _i1 = 0; _i1 < _ds1.length; _i1++) {
            var _e1 = _ds1[_i1]
            if (!_e1 || !_e1.date || _e1.date >= _todayKey) continue
            if (!prevDay || _e1.date > prevDay) prevDay = _e1.date
          }
        }
        if (prevDay) {
          var _sum = 0, _any = false
          for (var _m2 in _mods) {
            if (!Object.prototype.hasOwnProperty.call(_mods, _m2)) continue
            var _ds2 = _mods[_m2] && _mods[_m2].dailyStats
            if (!Array.isArray(_ds2)) continue
            for (var _i2 = 0; _i2 < _ds2.length; _i2++) {
              var _e2 = _ds2[_i2]
              if (!_e2 || _e2.date !== prevDay) continue
              _sum += pnum(_e2.revenue) + pnum(_e2.orderRevenue) + pnum(_e2.eventReward) + pnum(_e2.compensation)
                + pnum(_e2.fuelExpense) + pnum(_e2.maintenanceCost) + pnum(_e2.equipmentExpense) + pnum(_e2.cateringExpense)
              _any = true
            }
          }
          if (_any) prevProfit = _sum
        }
      } catch (e) {}

      title.textContent = '航迹云途 HUD · ' + dateStr
      grid.textContent = ''
      var pairs = [
        ['现金', fmtMoney(G.money)],
        ['前日利润' + (prevDay ? ' ' + prevDay.slice(5) : ''), prevProfit == null ? '--' : ((prevProfit >= 0 ? '+' : '') + prevProfit.toFixed(1) + ' 万'), prevProfit == null ? '' : (prevProfit < 0 ? '#ff9a9a' : '#93e2b4')],
        ['声誉', (Number(G.reputation || 0)).toFixed(1) + '%'],
        ['机队', String(acs.length) + ' 架'],
        ['班次/日', String(legs)],
        ['健康最低', hmin.toFixed(1), hmin < 85 ? '#ff9a9a' : ''],
        ['油量', (fuel / 10000).toFixed(0) + '/' + (cap / 10000).toFixed(0) + ' 万升'],
        ['可飞', fdays == null ? '--' : fdays.toFixed(1) + ' 天', fdays != null && fdays < 3 ? '#ff9a9a' : ''],
        ['夜停', worstAp ? (apNow[worstAp] + '/' + (apCap[worstAp] || 0)) : '--', apOver.length ? '#ff9a9a' : ''],
        ['延误', '中' + (G.mediumDelayDays || 0) + ' 严' + (G.severeDelayDays || 0), (G.severeDelayDays || G.mediumDelayDays) ? '#ff9a9a' : ''],
      ]
      for (var p = 0; p < pairs.length; p++) {
        var r = row(pairs[p][0], pairs[p][1], pairs[p][2])
        grid.appendChild(r[0]); grid.appendChild(r[1])
      }

      var warn = []
      if (window.__HJYT_STALE_AT && Date.now() - window.__HJYT_STALE_AT < 20000) warn.push('已读档/换日：上一次的结果已清空，需要时重新点一次')
      if ((G.severeDelayDays || 0) > 0) warn.push('有严重延误记录（不可逆，检查卡死飞机）')
      else if ((G.mediumDelayDays || 0) > 0) warn.push('有中等延误记录')
      if (fdays != null && fdays < 3) warn.push('油量不足 3 天，建议补油')
      if (prevProfit != null && prevProfit < 0) warn.push('前日亏损 ' + prevProfit.toFixed(1) + ' 万（' + prevDay + '）：查燃油/维修/餐食哪一项超支')
      if (apOver.length) warn.push('夜停超容：' + apOver.join('、') + '（会盘旋+巨额延误）')
      if (hmin < 85) warn.push('有飞机健康 < 85')
      var CASH_IDLE = Number(window.__HJYT_CASH_IDLE || 1500)
      if (Number(G.money || 0) > CASH_IDLE) warn.push('现金闲置（>' + CASH_IDLE + ' 万），可投机队')
      if (warn.length) { warnBox.style.display = ''; warnBox.textContent = '⚠ ' + warn.join('；') }
      else warnBox.style.display = 'none'

      var last = window.__HJYT_LAST
      if (typeof last === 'string') { try { last = JSON.parse(last) } catch (e) { last = null } }
      if (last) {
        var o = last
        lastBox.style.display = ''
        var txt = ''
        // 游戏内校验（validateFullSchedule）的结论，排班三个入口都会带回来
        var gtxt = o.gameText ? (' · ' + String(o.gameText).slice(0, 150)) : ''
        if (o.cmd === 'daily') txt = o.ok ? '已推进' : ('推进失败：' + (o.reason || o.error || ''))
        else if (o.cmd === 'refuel') txt = o.skipped ? (o.reason || '无需补油') : (o.ok ? '补油 ' + (o.liters / 10000).toFixed(1) + ' 万升 / ' + o.cost + ' 万' : ('补油失败：' + (o.reason || o.error || '')))
        else if (o.cmd === 'save') txt = o.ok ? '已存档 ' + (o.file || '') : '存档失败'
        else if (o.cmd === 'audit') txt = o.ok ? '自检通过' : '自检有异常'
        else if (o.cmd === 'plan') txt = o.ok ? ('生成 ' + (o.plans || []).length + ' 架方案，确认后应用') : ('排班失败：' + (o.reason || o.error || ''))
        else if (o.cmd === 'inspect') txt = o.ok ? '检修已安排' : '检修失败'
        if (o.cmd === 'sched_fix' && o.ok) {
          // 只记「已排」标记；不要在这里发命令（render 每秒跑一次，会变成每秒一条 health）
          try { if (o.applied && o.applied[0] && o.applied[0].reg) fixedMark[o.applied[0].reg] = true } catch (e) {}
        }
        else if (o.cmd === 'sched_fix') txt = o.ok ? (('一键排班：' + (o.legs || 0) + ' 段 · ' + (o.route || '') + ' · 夜停 ' + (o.nightAirport || '?')) + gtxt) : ('一键排班失败：' + (o.reason || o.error || ''))
        else if (o.cmd === 'ferry') txt = o.ok ? (o.already ? '本来就在 ' + o.to : '已排调机 ' + (o.from || '') + ' → ' + (o.to || '') + '（到站后才能排这条线）') : ('调机失败：' + (o.reason || ''))
        else if (o.cmd === 'cabinrebuild') txt = o.ok ? ((o.apply ? '客舱已重建 ' + ((o.plan || []).filter(function (p) { return p.applied }).length) + ' 架 / ' + (o.total || 0) + ' 万' : '客舱预览：' + (o.total || 0) + ' 万，确认后执行')) : ('客舱重建失败：' + (o.reason || ''))
        else if (o.cmd === 'renameroute') txt = o.ok ? ('已按起降城市改名 ' + (o.changed || 0) + ' 架' + ((o.skipped && o.skipped.length) ? ('；' + o.skipped.length + ' 架闲置未改') : '') + (o.applied ? ('：' + o.applied.map(function (x) { return (x.before || '') + '→' + (x.after || '') }).join('，')) : '')) : ('改名失败：' + (o.reason || ''))
        else if (o.cmd === 'acrename') txt = o.ok ? ('已改名：' + (o.before || '') + ' → ' + (o.after || '')) : ('改名失败：' + (o.reason || ''))
        else if (o.cmd === 'buyauto') txt = o.ok ? ('已买入 ' + ((((o.bought || [])[0] || {}).reg) || '') + (((o.autoCabin || {}).route) ? (' · ' + o.autoCabin.route.from + '→' + o.autoCabin.route.to + ' · ' + (((o.cabin || {}).F || 0) + ((o.cabin || {}).J || 0) + ((o.cabin || {}).S || 0) + ((o.cabin || {}).Y || 0)) + ' 座') : '')) : ('买机失败：' + (o.reason || ''))
        else if (o.cmd === 'routesetup') txt = o.ok ? ((o.note || ('已设置 ' + o.total + ' 条航线')) + (o.changed != null ? '（本次实际改动 ' + o.changed + ' 条）' : '')) : ('航线设置：' + (o.reason || '失败') + ((o.routes || []).filter(function (r) { return r.err }).map(function (r) { return ' / ' + r.from + '→' + r.to + ':' + r.err }).join('')))
        else if (o.cmd === 'board') txt = o.ok ? ('今日收入 ' + ((o.today || {}).revenue || '-') + ' 万 · 净利 ' + (o.avgNet == null ? '-' : o.avgNet) + ' 万/日 · 弱航线 ' + (((o.routes || {}).weak || []).length) + ' 条') : ('看板失败：' + (o.reason || ''))
        else if (o.cmd === 'health') txt = o.ok ? ('排班体检：红线 ' + (o.critical || 0) + ' · 闲置 ' + ((o.summary || {}).idle || 0) + ' · 欠排 ' + ((o.summary || {}).underused || 0) + ' · 末班早 ' + ((o.summary || {}).earlyLast || 0)) : ('体检有红线：' + ((o.advice || [])[0] || ''))
        else if (o.cmd === 'sched_pick') txt = o.ok ? ('「' + o.route + '」可排 ' + (o.usable || 0) + ' 架，选一架再点确认') : ('排班：' + (o.reason || '失败'))
        else if (o.cmd === 'sched_apply_pick') txt = o.ok ? ('已排 ' + ((o.aircraft || {}).reg || '') + ' ' + (o.legs || 0) + ' 段：' + (o.sequence || []).join(' / ') + (gtxt || ((o.audit && o.audit.ok) ? ' · 自检通过' : ' · 自检有异常'))) : ('排班失败：' + (o.reason || ''))
        else if (o.cmd === 'fuelplan') txt = o.ok ? ('油库：可飞 ' + o.fuelDays + ' 天 · 满库 ' + o.capacityDays + ' 天 · 方案 ' + (o.totalCost || 0) + ' 万') : ('油库读取失败：' + (o.reason || ''))
        else if (o.cmd === 'fuelapply') txt = o.ok ? ('已扩容 ' + ((o.applied || {}).upgraded || 0) + ' 步 · 补油 ' + ((((o.applied || {}).buy || {}).liters || 0) / 10000).toFixed(1) + ' 万升 → 可飞 ' + ((o.after || {}).fuelDays == null ? '?' : (o.after || {}).fuelDays) + ' 天') : ('扩容/补油失败：' + (o.reason || o.warn || ''))
        else if (o.cmd === 'routedev') txt = o.ok ? ('开线候选 ' + ((o.top || []).length) + ' 条 · 首选 ' + ((((o.top || [])[0] || {}).to) || '-') + ' · 单架 ' + ((o.top || [])[0] || {}).revPerPlane + ' 万/日 · 可养 ' + ((o.top || [])[0] || {}).capacityAircraft + ' 架' + ((o.top && o.top[0] && o.top[0].acCount) ? ('（已有 ' + o.top[0].acCount + '）') : '')) : ('开线查询失败：' + (o.reason || ''))
        else if (o.cmd === 'expand') txt = o.ok ? ('今日待办 ' + ((o.steps || []).length) + ' 步 · 计划花 ' + (((o.summary || {}).plannedCost) == null ? 0 : o.summary.plannedCost) + ' 万 · 剩 ' + (((o.summary || {}).cashAfter) == null ? '?' : o.summary.cashAfter) + ' 万' + (((o.blockers || []).length) ? (' · ⚠ 红线 ' + o.blockers.length + ' 条') : '')) : ('今日待办失败：' + (o.reason || ''))
        else if (o.cmd === 'airportquery') txt = o.ok ? ('机场查询：' + (o.rowsCount || 0) + ' 个机场 → ' + (o.fileName || '') + (((o.nightRedline || []).length) ? (' · ⚠ 无维修位夜停 ' + o.nightRedline.length + ' 处') : '') + (o.warn ? (' · ' + o.warn) : '')) : ('机场查询失败：' + (o.reason || ''))
        else txt = JSON.stringify(o).slice(0, 120)
        lastBox.textContent = '✓ ' + txt
        if (Date.now() - lastRendered > 12000) lastBox.style.display = 'none'
      }
      renderPick()
      renderBuy()
      renderCab()
      renderHealth()
      renderDev()
      renderDeploy()
      tickDevDeploy()
    } catch (e) {
      grid.textContent = ''
      grid.appendChild(el('div', 'grid-column:1/3;color:#ff9a9a', 'HUD 异常：' + (e && e.message)))
    }
  }

  // ---- 买机区交互：输入机型 + 选数量 → 查报价（自动配舱）→ 两次点击购买 ----
  var buyData = null, buyTs = 0, buyArmed = false

  function batchOf(unit, n) { return n <= 1 ? unit : unit * (Math.pow(1.015, n) - 1) / 0.015 }
  function paintQty() {
    buyQtyTxt.textContent = '数量：' + buyQty + ' 架' + (buyQty > 1 ? '（每架 +1.5% 通胀）' : '')
    buyQtyMinus.style.opacity = buyQty <= 1 ? '.35' : '1'
    buyQtyPlus.style.opacity = buyQty >= 10 ? '.35' : '1'
  }
  function paintBuy() {
    if (!buyData) return
    var unit = Number(buyData.unitTotal != null ? buyData.unitTotal : buyData.total) || 0
    var bt = batchOf(unit, buyQty)
    var c = buyData.cabin || {}
    var money = Number(buyData.money != null ? buyData.money : 0)
    var enough = !money || bt <= money
    buyResult.textContent = '✓ ' + buyData.model + ' · ' + buyData.seats + ' 座空间\n'
      + '机体 ' + buyData.price + ' 万 + 装备 ' + buyData.equipmentPrice + ' 万（小翼/WiFi/PTV + 节油发动机）\n'
      + '舱位 F' + c.F + ' J' + c.J + ' S' + c.S + ' Y' + c.Y + '（共 ' + ((buyData.cabinInfo || {}).seats || 0) + ' 座，' + ((buyData.cabinInfo || {}).method || '') + '）\n'
      + '主飞 ' + buyData.route.from + '→' + buyData.route.to + ' · ' + buyData.legs + ' 段/日\n'
      + (buyQty > 1
        ? ('第 1 架 ' + unit.toFixed(1) + ' 万 · ' + buyQty + ' 架共 ' + bt.toFixed(1) + ' 万（每买 1 架全场涨价 1.5%）\n')
        : ('落地总价 ' + unit.toFixed(1) + ' 万（机体 + 装备 + 改舱）\n'))
      + (money ? ('现金 ' + money.toFixed(0) + ' 万' + (enough ? '' : ' · ✗ 不够，最多买 ' + (buyData.maxAffordable || 0) + ' 架')) : '')
      + (buyData.batchTotal == null ? '\n（当前宿主还不支持批量参数：会逐架排队执行，总价一样；重启 DSH 后可一次买完）' : '')
    buyOk.style.display = ''
    buyOk.textContent = enough ? ('确认购买 ' + buyQty + ' 架（' + bt.toFixed(1) + ' 万）') : ('✗ 现金不足（' + bt.toFixed(1) + ' 万）')
    buyOk.style.background = enough ? 'rgba(40,160,90,0.32)' : 'rgba(140,60,60,0.45)'
    buyArmed = false
  }
  paintQty()
  buyQtyMinus.onclick = function () { if (buyQty > 1) { buyQty--; paintQty(); paintBuy() } }
  buyQtyPlus.onclick = function () { if (buyQty < 10) { buyQty++; paintQty(); paintBuy() } }

  function buyFind() {
    var v = (buyInput.value || '').trim()
    if (!v) return
    window.__HJYT_QUEUE.push({ cmd: 'buyquote', model: v, count: buyQty, ts: Date.now() })
    buyResult.textContent = '查价中…（约 3 秒）'
    buyOk.style.display = 'none'
    buyArmed = false
  }
  buyQuery.onclick = buyFind
  buyInput.onkeydown = function (e) { if (e && e.key === 'Enter') buyFind() }
  buyClose.onclick = function () {
    buyBox.style.display = 'none'
    window.__HJYT_BUY = null
    buyOk.style.display = 'none'
  }

  function renderBuy() {
    var b = window.__HJYT_BUY
    if (!b || b.ts === buyTs) return
    buyTs = b.ts
    buyResult.style.whiteSpace = 'pre-line'
    if (b.done) {
      buyOk.style.display = 'none'
      buyData = null
      buyArmed = false
      if (b.ok) {
        var list = (b.bought || []).filter(function (x) { return x && x.ok !== false }).map(function (x) { return x.reg || x.id || '' })
        var c2 = (b.plan && b.plan.cabin) || b.cabin || {}
        var paid = b.plan && b.plan.totalCost != null ? b.plan.totalCost : ''
        buyResult.textContent = '✓ 已买入 ' + (list.length || 1) + ' 架' + (list.length ? '：' + list.join(' / ') + '\n' : '\n')
          + '舱位 F' + (c2.F || 0) + ' J' + (c2.J || 0) + ' S' + (c2.S || 0) + ' Y' + (c2.Y || 0) + ' · 合计 ' + paid + ' 万\n'
          + '（可再查报价买下一批；新机记得排班）'
      } else {
        buyResult.textContent = '✗ 买机失败：' + (b.reason || '未知原因')
      }
      return
    }
    if (!b.ok) {
      buyResult.textContent = '✗ ' + (b.reason || '报价失败') + ((b.suggestions && b.suggestions.length) ? '\n相近机型：' + b.suggestions.join('、') : '')
      buyOk.style.display = 'none'
      return
    }
    buyData = b
    // 只有宿主真的回了 count 才覆盖本地选择：旧宿主不认 count，改了就会把用户选的数量重置成 1
    if (b.count != null) buyQty = Math.max(1, Math.min(10, Math.floor(Number(b.count) || 1)))
    buyArmed = false
    paintQty()
    paintBuy()
  }

  buyOk.onclick = function () {
    if (!buyData) return
    var unit = Number(buyData.unitTotal != null ? buyData.unitTotal : buyData.total) || 0
    var bt = batchOf(unit, buyQty)
    if (!buyArmed) {
      buyArmed = true
      buyOk.textContent = '再点一次确认（' + buyQty + ' 架 / ' + bt.toFixed(1) + ' 万）'
      buyOk.style.background = 'rgba(200,120,40,0.45)'
      return
    }
    if (buyData.batchTotal != null) {
      // 新宿主：一次买 N 架（单次快照 + 单次自检）
      window.__HJYT_QUEUE.push({ cmd: 'buyauto', model: buyData.model, cabin: buyData.cabin || null, count: buyQty, ts: Date.now() })
    } else {
      // 旧宿主还没有 count：逐架排队（引擎自己按 +1.5% 通胀加价，总价与批量一致）
      for (var q0 = 0; q0 < buyQty; q0++) window.__HJYT_QUEUE.push({ cmd: 'buyauto', model: buyData.model, cabin: buyData.cabin || null, ts: Date.now() + q0 })
    }
    buyOk.style.display = 'none'
    buyResult.textContent = '下单中…（' + buyQty + ' 架' + (buyData.batchTotal != null ? '' : '，宿主逐架执行，约 ' + (buyQty * 3) + ' 秒') + '）'
    buyArmed = false
    window.__HJYT_BUY = null
  }
  // ---- 体检面板 ----
  var healthTs = 0
  function hhmm2(m) { return m == null ? '--' : String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') }

  function fixRow(ac, label) {
    var row = el('div', 'display:flex;gap:6px;align-items:center;padding:3px 6px;border-radius:6px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03)')
    var shownLabel = (fixedMark[ac.reg] ? (label + ' · 已重排') : label) + (ac.maxed ? ' · 已最优' : '')
    var txt = el('div', 'flex:1;color:' + (fixedMark[ac.reg] ? '#9fe6bf' : '#dfe9f7') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis', shownLabel)
    if (ac.maxed) {
      row.appendChild(txt)
      row.appendChild(el('span', 'font-size:10px;color:#7f8fa6;white-space:nowrap', '已最优'))
      return row
    }
    // 本会话已经排过一次 → 按钮消失，只留「✓ 已排 N 段」（用户 2026-10-20：排完之后按钮应该消失）
    if (fixedMark[ac.reg]) {
      row.appendChild(txt)
      row.appendChild(el('span', 'font-size:10px;color:#9fe6bf;white-space:nowrap', '✓ 已排' + (typeof fixedMark[ac.reg] === 'number' ? ' ' + fixedMark[ac.reg] + ' 段' : '')))
      return row
    }
    var btn = el('button', 'padding:2px 8px;border-radius:5px;cursor:pointer;font:10px/1.2 inherit;border:1px solid rgba(120,255,180,0.45);background:rgba(40,160,90,0.3);color:#d8ffe9;white-space:nowrap', '一键排班')
    btn.onclick = function () {
      if (window.__HJYT_INFLIGHT) return
      window.__HJYT_INFLIGHT = true
      setTimeout(function () { window.__HJYT_INFLIGHT = false }, 2500)
      lastPickAc = ac.id
      window.__HJYT_PICK = null
      pickBox.style.display = 'none'
      pickData = null
      // 一键排班 = 只在这架飞机**自己现有的航线**上重排（不换线），偶数段、夜里回起飞机场
      window.__HJYT_QUEUE.push({ cmd: 'sched_fix', acId: ac.id || null, reg: ac.reg || null, maint: maintMode, maxUtil: utilCap, ts: Date.now() })
      btn.textContent = '排班中…'
      btn.disabled = true
      var seen = false
      var poll = setInterval(function () {
        var last = window.__HJYT_LAST
        if (typeof last === 'string') { try { last = JSON.parse(last) } catch (e) { last = null } }
        if (!last || last.cmd !== 'sched_fix') return
        var mine = (last.acId && ac.id && String(last.acId) === String(ac.id)) || (last.reg && ac.reg && last.reg === ac.reg)
        if (!mine) return
        seen = true
        clearInterval(poll)
        // 消费完就清空，避免页面里遗留的旧版 HUD 实例每秒重复读这条结果、重复发 health
        window.__HJYT_LAST = null
        if (last.ok) {
          fixedMark[ac.reg] = Number(last.legs) || true
          btn.textContent = '✓ 已排 ' + (Number(last.legs) || '') + ' 段'
          btn.style.cursor = 'default'
          btn.style.borderColor = 'rgba(120,255,180,0.35)'
          btn.style.background = 'rgba(40,160,90,0.16)'
          btn.style.color = '#9fe6bf'
          try { txt.style.color = '#9fe6bf' } catch (e) {}
          setTimeout(function () { try { if (btn.parentNode) btn.remove() } catch (e) {} }, 1200)
          try { window.__HJYT_QUEUE.push({ cmd: 'health', ts: Date.now() + 1 }) } catch (e) {}
        } else {
          btn.textContent = '一键排班'
          btn.disabled = false
          lastBox.style.display = ''
          lastBox.style.color = '#ffb4b4'
          lastBox.textContent = '一键排班失败：' + (last.error || last.reason || '未知错误') + (String(last.error || '').indexOf('not a function') >= 0 ? '（宿主还是旧版本，请重启 DSH）' : '')
        }
      }, 300)
      // 兜底：10 秒没等到结果就复原，避免宿主旧版/报错时按钮永久卡在「排班中…」
      setTimeout(function () {
        if (seen) return
        clearInterval(poll)
        window.__HJYT_LAST = null
        btn.textContent = '一键排班'
        btn.disabled = false
      }, 10000)
    }
    row.appendChild(txt)
    row.appendChild(btn)
    return row
  }

  function fmtLay(l) { return l ? ('F' + l.F + ' J' + l.J + ' S' + l.S + ' Y' + l.Y) : '—' }

  function renderHealth() {
    var d = window.__HJYT_HEALTH
    if (!d || d.ts === healthTs) { return }
    healthTs = d.ts
    healthBox.style.display = ''
    healthList.textContent = ''
    var sm = d.summary || {}
    healthTitle.textContent = '体检 ' + (d.date || '') + ' · 红线 ' + (d.critical || 0) + ' · 闲置 ' + (sm.idle || 0) + ' · 欠排 ' + (sm.underused || 0) + ' · 过站紧 ' + (sm.tightStop || 0) + ' · 夜停超容 ' + (sm.overflow || 0)
    // 维修位负载（四查 C2）：ratio>1 说明同一天多架要修就会排队，>3 就是过载
    var ml = (d.maintLoad || []).filter(function (x) { return x.level && x.level !== 'ok' })
    if (ml.length) {
      var over = ml.some(function (x) { return x.level === 'over' })
      healthList.appendChild(el('div', 'font-size:10.5px;line-height:1.5;margin-bottom:2px;color:' + (over ? '#ffb4b4' : '#ffcf7a'),
        '维修位紧张：' + ml.map(function (x) { return x.name + ' ' + x.aircraft + '架 / ' + x.slots + '位（' + x.ratio + 'x）' }).join('、') + ' — 同一天多架要修会排队'))
    }
    // 利润最大化（体检顺手做）：票价倍率 / 舱位配比不是最优就直接改
    var pf = d.profit
    if (pf) {
      if (pf.ok === false) {
        healthList.appendChild(el('div', 'color:#ff9a9a;white-space:pre-wrap', '利润优化失败：' + (pf.reason || '?')))
      } else {
        var fN = (pf.fareApplied || []).length, cN = (pf.cabinApplied || []).length
        if (fN || cN) {
          healthList.appendChild(el('div', 'color:#93e2b4;white-space:pre-wrap;margin-bottom:2px',
            '✓ 利润优化：改了 ' + fN + ' 条票价 / ' + cN + ' 架配舱' + (pf.cabinCost ? ('（改装费 ' + pf.cabinCost + ' 万）') : '') +
            ' · ' + (pf.cabinSkipped ? '理论最优日均收入 ' : '日均收入 ') + fmtMoney(pf.revDayNow) + ' → ' + fmtMoney(pf.revDayWant) + '（+' + Math.round((pf.gain || 0) * 100) + '%）'))
          for (const f of (pf.fareApplied || [])) {
            healthList.appendChild(el('div', 'font-size:10px;color:#8b9bb0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
              f.route + ' F' + f.from.F + 'J' + f.from.J + 'S' + f.from.S + 'Y' + f.from.Y + ' → F' + f.to.F + 'J' + f.to.J + 'S' + f.to.S + 'Y' + f.to.Y))
          }
          for (const x of (pf.cabinApplied || [])) {
            healthList.appendChild(el('div', 'font-size:10px;color:#8b9bb0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
              x.reg + ' ' + fmtLay(x.from) + ' → ' + fmtLay(x.to) + (x.cost ? (' · ' + x.cost + ' 万') : '')))
          }
        } else {
          // 「没改」有两种：真最优 / 票价最优但配舱没钱改 —— 别把后者说成「没有需要改的」
          var waitN = (pf.after && pf.after.cabinChangesLeft) || 0
          healthList.appendChild(el('div', 'color:#93e2b4;white-space:pre-wrap',
            waitN
              ? ('✓ 票价已是当前声誉下的最优；还有 ' + waitN + ' 架配舱要改，等现金够了再点一次体检')
              : ('✓ 利润体检：这次没有需要改的（票价已是当前声誉下的最优）· 日均收入 ' + fmtMoney(pf.revDayNow) + ' 万')))
        }
        if (pf.cabinSkipped) {
          healthList.appendChild(el('div', 'color:#ffcf7a;white-space:pre-wrap', '◇ 配舱暂未改：' + pf.cabinSkipped))
        }
        if (pf.after && pf.after.gainLeft != null && pf.after.gainLeft > 0.02) {
          healthList.appendChild(el('div', 'color:#ffcf7a;white-space:pre-wrap',
            '◇ 离理论最优还差 ' + Math.round(pf.after.gainLeft * 100) + '%（' + (pf.after.cabinChangesLeft ? ('主要是 ' + pf.after.cabinChangesLeft + ' 架待改配舱') : '需求池会随实际客流修正') + '，下次点体检可继续收敛）'))
        }
      }
    }
    var fixed = 0
    for (const a of (d.idle || [])) { healthList.appendChild(fixRow(a, a.reg + ' 完全闲置（0 段）')); fixed++ }
    for (const a of (d.underused || [])) { healthList.appendChild(fixRow(a, a.reg + ' 欠排（' + a.legs + ' 段，' + hhmm2(a.first) + '–' + hhmm2(a.last) + '）')); fixed++ }
    for (const a of (d.lowUtil || [])) { healthList.appendChild(fixRow(a, a.reg + ' 利用率低（' + Math.round((a.util || 0) * 100) + '%）')); fixed++ }
    for (const a of (d.earlyLast || [])) { healthList.appendChild(fixRow(a, a.reg + ' 末班偏早（' + hhmm2(a.last) + ' 就收工）')); fixed++ }
    for (const ap of (d.overflow || [])) {
      healthList.appendChild(el('div', 'color:#ff9a9a', '✗ 夜停超容：' + ap.name + ' ' + ap.parked + '/' + ap.parkedCap + '（需换基地或停飞）'))
      fixed++
    }
    for (const g of (d.badGap || [])) {
      healthList.appendChild(el('div', 'color:#ff9a9a', '✗ 起飞间隔违反：' + (g.ap || '') + ' 最紧 ' + (g.min || '?') + ' 分（要求 ' + (g.req || '?') + '）'))
      fixed++
    }
    if (!fixed) healthList.appendChild(el('div', 'color:#93e2b4', '✓ 没有需要修的：闲置/欠排/过站/间隔/夜停全部正常'))
    else healthList.appendChild(el('div', 'color:#8b9bb0;font-size:10px;margin-top:2px', '点「一键排班」会按当前选中的航线 + 维修窗口（' + (maintMode === 'night' ? '夜间' : maintMode === 'day' ? '白天' : '不预留') + '）出方案'))
  }

  // ---- 客舱重建面板交互 ----
  var cabData = null, cabTs = 0
  function fmtCab(l) { return l ? ('F' + l.F + ' J' + l.J + ' S' + l.S + ' Y' + l.Y) : '—' }

  function renderCab() {
    var d = window.__HJYT_CABIN
    if (!d || d.ts === cabTs) return
    cabTs = d.ts
    cabData = d
    cabBox.style.display = ''
    cabList.textContent = ''
    if (!d.ok) {
      cabTitle.textContent = '客舱重建失败：' + (d.reason || '')
      cabOk.style.display = 'none'
      return
    }
    cabTitle.textContent = (d.apply ? '客舱已重建（' : '预览：') + '合计 ' + (d.total || 0) + ' 万 · 间距 ' + (d.pitch || 74) + 'cm'
    for (const p of (d.plan || [])) {
      var line = el('div', 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:' + (p.ok ? '#cfe3ff' : '#ff9a9a'),
        p.reg + ' · ' + fmtCab(p.before) + ' → ' + fmtCab(p.after) + (p.cost ? (' · ' + p.cost + ' 万') : ' · 无需改装'))
      cabList.appendChild(line)
    }
    for (const sk of (d.skipped || [])) {
      cabList.appendChild(el('div', 'color:#8b9bb0', sk.reg + ' · 跳过（' + sk.reason + '）'))
    }
    cabOk.style.display = d.apply ? 'none' : ''
    cabOk.textContent = '确认重建（' + (d.total || 0) + ' 万）'
  }

  cabOk.onclick = function () {
    if (!cabData) return
    window.__HJYT_QUEUE.push({ cmd: 'cabinrebuild', apply: true, pitch: cabData.pitch, ts: Date.now() })
    window.__HJYT_CABIN = null
    cabOk.style.display = 'none'
    cabTitle.textContent = '重建中…'
  }
  cabClose.onclick = function () {
    cabBox.style.display = 'none'
    window.__HJYT_CABIN = null
    cabData = null
  }

  // ---- 航线开发面板交互：输入机场 → host routedev 命令 → window.__HJYT_DEV ----
  var devData = null, devTs = 0
  var devSel = -1, devDeployArmed = false, devArmedFor = '', devDeployBusy = false, devDeployTs = 0, devDeployAt = 0

  function yuanOf(x) {
    var v = Number(x)
    return isFinite(v) && v > 0 ? String(Math.round(v)) : '-'
  }

  function renderDev() {
    var d = window.__HJYT_DEV
    if (!d || d.ts === devTs) return
    devTs = d.ts
    devData = d
    devBox.style.display = ''
    devList.textContent = ''
    if (!d.ok) {
      devTitle.textContent = '开线查询失败：' + (d.reason || '')
      // 模糊搜索命中多个机场 → 直接给可点的候选
      var hits = d.matches || []
      if (hits.length) {
        devTitle.textContent = '「' + (d.q || d.from || '') + '」匹配到 ' + (d.total || hits.length) + ' 个机场，点一个：'
        for (var m0 = 0; m0 < hits.length; m0++) {
          (function (hit) {
            var name = String(hit.name || '')
            var extras = []
            if (hit.iata) extras.push(hit.iata)
            if (hit.level && hit.level !== 'normal') extras.push(hit.level)
            if (hit.parked) extras.push('停 ' + hit.parked + ' 架')
            if (hit.slots) extras.push(hit.slots + ' 维修位')
            var b = el('button', 'text-align:left;padding:4px 6px;border-radius:6px;border:1px solid rgba(120,170,255,0.3);background:rgba(70,120,220,0.18);color:#dbe7fb;cursor:pointer;font:11px/1.3 inherit;margin-bottom:3px', name + (extras.length ? '（' + extras.join(' · ') + '）' : ''))
            b.onclick = function () {
              try { devInput.value = name } catch (e) {}
              devFind()
            }
            devList.appendChild(b)
          })(hits[m0])
        }
      }
      return
    }
    var m = d.model || {}
    devTitle.textContent = '开线 · ' + (d.from || '') + ' · ' + (m.name || 'B757-200') + ' @' + (m.pitch || 71) + 'cm = ' +
      (m.seatCap || '?') + ' 座 · 已开通 ' + ((d.unlocked || []).join('/') || '-') + ' · 现金 ' + Math.round(d.money || 0) + ' 万'
    var top = d.top || []
    if (!top.length) {
      devList.appendChild(el('div', 'color:#ffd479', '没有候选航线（机场名不对，或不在已开通区域）'))
      return
    }
    for (var i = 0; i < top.length; i++) {
      var t = top[i]
      var wrap = el('div', 'border-top:1px dashed rgba(120,170,255,0.15);padding:3px 4px;border-radius:6px;cursor:pointer;' +
        (devSel === i ? 'background:rgba(70,120,220,0.22);outline:1px solid rgba(120,170,255,0.45);' : '') +
        (i === 0 ? 'border-top:0;padding-top:0' : ''))
      wrap.onclick = function (idx) { return function () { devSel = idx; devTs = 0; devDeployArmed = false; devArmedFor = ''; devDeployTs = 0; devResult.textContent = ''; renderDev() } }(i)
      wrap.appendChild(el('div', 'color:#cfe3ff;font-weight:600', '#' + t.rank + ' ' + t.from + ' ↔ ' + t.to + ' · ' + t.km + 'km · ' + t.legs + ' 段/日 · 单架 ' + t.revPerPlane + ' 万/日'))
      wrap.appendChild(el('div', 'color:' + (t.canAdd > 0 ? '#93e2b4' : '#ffd479'), '可养 ' + t.capacityAircraft + ' 架（已有 ' + t.acCount + '，还能加 ' + t.canAdd + '）· 停机余 ' + ((t.parkFree || {}).sum == null ? '?' : (t.parkFree || {}).sum)))
      var lay = t.layout || {}
      var f = t.fares || {}
      wrap.appendChild(el('div', 'color:#9fb6d4', '配舱 F' + (lay.F || 0) + ' J' + (lay.J || 0) + ' S' + (lay.S || 0) + ' Y' + (lay.Y || 0) +
        ' · 票价 F' + yuanOf(f.F && f.F.yuan) + '/J' + yuanOf(f.J && f.J.yuan) + '/S' + yuanOf(f.S && f.S.yuan) + '/Y' + yuanOf(f.Y && f.Y.yuan) + ' 元'))
      var tail = (t.exists ? '已开线' : ('新线 开线费 ' + (t.createCost == null ? '?' : t.createCost) + ' 万' + (t.acCount ? '' : '')))
      if (t.util != null) tail += ' · 用率 ' + Math.round(Number(t.util) * 100) + '%'
      if (t.paybackDays != null) tail += ' · 回本 ' + t.paybackDays + ' 天'
      if (t.note) tail += ' · ' + t.note
      wrap.appendChild(el('div', 'color:#9fb6d4', tail))
      devList.appendChild(wrap)
    }
    if (devSel >= top.length) devSel = -1
    paintDevDeploy()
  }

  function devSelected() {
    var d = devData
    if (!d || !d.ok || !d.top || devSel < 0 || devSel >= d.top.length) return null
    return d.top[devSel]
  }

  // 是否「已经算过账、下一次点击就真执行」：直接从宿主最后回的报价推出来（不依赖闭包变量，换行/超时自然失效）
  function armedState(t) {
    try {
      var p = window.__HJYT_DEPLOY
      if (!p || !p.needConfirm || !p.plan || !t) return false
      if (String(p.plan.from || '') !== String(t.from || '')) return false
      if (String(p.plan.to || '') !== String(t.to || '')) return false
      var age = Date.now() - Number(p.ts || 0)
      if (!(age >= 0 && age < 180000)) return false
      return true
    } catch (e) { return false }
  }

  function paintDevDeploy() {
    if (!devDeploy) return
    var t = devSelected()
    if (devDeployBusy) {
      devDeploy.textContent = '部署中…（开线 → 买机 → 排班，约 20–40 秒）'
      devDeploy.style.opacity = '.6'
      return
    }
    if (!t) {
      devDeploy.textContent = '一键部署（先点选一条线）'
      devDeploy.style.opacity = '.45'
      devDeployHint.textContent = ''
      return
    }
    var armedNow = armedState(t)
    try {
      window.__HJYT_ARM = { armedNow: armedNow, armedFlag: devDeployArmed, armedFor: devArmedFor, busy: devDeployBusy, sel: devSel, ts: window.__HJYT_DEPLOY && window.__HJYT_DEPLOY.ts, at: Date.now() }
    } catch (e) {}
    devDeploy.style.opacity = '1'
    devDeploy.textContent = armedNow
      ? ('再点一次确认：' + t.from + ' → ' + t.to)
      : ('一键部署 ' + t.from + ' → ' + t.to + '（开线 + 买 1 架 + 排班）')
    if (devDeployHint) devDeployHint.textContent = armedNow ? '⚠ 已经在花真钱：确认后立刻开线并买机' : '第一次点击只是算账（会显示要花多少），第二次才真执行'
  }

  // 部署超时兜底：宿主还是旧版本（没有 deploy 命令）时不会回任何结果
  function tickDevDeploy() {
    if (!devDeployBusy || !devDeployAt) return
    if (Date.now() - devDeployAt < 25000) return
    devDeployBusy = false
    devDeployArmed = false
    devResult.style.color = '#ff9a9a'
    devResult.textContent = '没收到部署结果（25 秒）：宿主的插件实例可能已经掉线（HUD 也收不到心跳）→ 双击根目录 重启DSH.cmd 后再点一次'
    paintDevDeploy()
  }

  function renderDeploy() {
    var r = window.__HJYT_DEPLOY
    if (!r || r.ts === devDeployTs) return
    devDeployTs = r.ts
    devDeployBusy = false
    devResult.textContent = ''
    if (r.needConfirm) {
      devDeployArmed = true
      devArmedFor = String(r.from || '') + '|' + String(r.to || '')
      var c = (r.plan && r.plan.cost) || {}
      var lines = []
      lines.push('将花 ' + c.total + ' 万：买机 ' + c.buyTotal + '（' + (r.plan && r.plan.model || '') + ' 含装备/改舱）+ 开线 ' + c.createCost + ' 万（' + ((r.plan && r.plan.missing) || []).join(' / ') + '）')
      lines.push('花完剩 ' + c.after + ' 万（现金 ' + c.money + ' 万）' + (c.underFloor ? ' · ⚠ 低于 800 万运营垫' : ''))
      if (r.plan && r.plan.cabin) {
        lines.push('配舱 F' + (r.plan.cabin.F || 0) + ' J' + (r.plan.cabin.J || 0) + ' S' + (r.plan.cabin.S || 0) + ' Y' + (r.plan.cabin.Y || 0) + (r.plan.legs ? ' · ' + r.plan.legs + ' 段/日' : ''))
      }
      devResult.textContent = lines.join('\n')
      paintDevDeploy()
      return
    }
    if (r.ok) {
      var bits = []
      var missing = (r.route && r.route.missing) || []
      bits.push(missing.length ? ('开线 ' + missing.join(' / ')) : '航线已存在')
      bits.push('买机 ' + ((r.aircraft && r.aircraft.reg) || '?'))
      bits.push(r.schedule ? ('排班 ' + r.schedule.legs + ' 段（夜停 ' + (r.schedule.nightAirport || '?') + '）') : ('排班未成：' + (r.schedErr || '')))
      bits.push('花费 ' + r.spent + ' 万')
      devResult.textContent = '✓ ' + r.from + ' → ' + r.to + '：' + bits.join(' · ')
      devResult.style.color = r.schedule ? '#93e2b4' : '#ffd479'
      if (r.note) devResult.textContent += '\n' + r.note
      // 游戏内校验结论（排完自动跑的 validateFullSchedule）
      if (r.gameText) devResult.textContent += '\n' + r.gameText
      if (r.gameCheck && r.gameCheck.verdict === 'fail') devResult.style.color = '#ff9a9a'
      // 部署完重查一次列表（acCount / 可养架数会变）
      try { if (devInput && devInput.value) devFind() } catch (e) {}
    } else {
      devResult.style.color = '#ff9a9a'
      devResult.textContent = '✗ 部署失败' + (r.stage ? '（' + r.stage + '）' : '') + '：' + (r.reason || '')
      if (r.plan && r.plan.cost) devResult.textContent += '\n花费估计 ' + r.plan.cost.total + ' 万'
      var cands = r.matches || []
      if (cands.length) {
        devResult.textContent += '\n候选机场：' + cands.map(function (x) { return x.name }).join(' / ')
      }
    }
    paintDevDeploy()
  }

  function openDev() {
    devBox.style.display = ''
    try { devInput.focus() } catch (e) {}
    if (!devData) devTitle.textContent = '输入机场 → 查最值得开的 5 条线（候选只取已开通区域，按 B757-200 @71cm 估）'
  }

  function devFind() {
    var v = (devInput.value || '').trim()
    if (!v) { devTitle.textContent = '先输入机场名（例：上海浦东）'; return }
    devBox.style.display = ''
    devTitle.textContent = '查「' + v + '」…'
    devList.textContent = ''
    window.__HJYT_QUEUE.push({ cmd: 'routedev', airport: v, model: 'B757-200', ts: Date.now() })
  }

  devDeploy.onclick = function () {
    var t = devSelected()
    if (!t || devDeployBusy) return
    if (!devData || !devData.model) return
    devDeployBusy = true
    devDeployAt = Date.now()
    devResult.style.color = '#cfe3ff'
    if (armedState(t)) {
      devDeployArmed = false
      devArmedFor = ''
      try { window.__HJYT_DEPLOY = null } catch (e) {}
      devResult.textContent = '部署中…（开线 → 买机 → 排班，约 20–40 秒，别关面板）'
      window.__HJYT_QUEUE.push({ cmd: 'deploy', from: t.from, to: t.to, model: devData.model.name || 'B757-200', confirm: true, ts: Date.now() })
    } else {
      devResult.textContent = '正在算这笔账…'
      window.__HJYT_QUEUE.push({ cmd: 'deploy', from: t.from, to: t.to, model: devData.model.name || 'B757-200', ts: Date.now() })
    }
    paintDevDeploy()
  }

  devGo.onclick = devFind
  devInput.onkeydown = function (e) { if (e && e.key === 'Enter') devFind() }
  devClose.onclick = function () {
    devBox.style.display = 'none'
    window.__HJYT_DEV = null
    devData = null
  }

  window.__HJYT_HUD = { version: VERSION, root: root, render: render }

  var tickTimer = null
  function tick() {
    // 令牌变了 = 有更新的实例接管：本实例退休（否则旧 root 会每秒自愈成叠层）
    if (window.__HJYT_HUD_TOKEN !== TOKEN) {
      try { if (tickTimer) clearInterval(tickTimer) } catch (e) {}
      return
    }
    try {
      // 清掉别的实例残留的面板（同一页面被重复注入过时会出现好几个）
      // 老实例没有令牌机制、会把自己那份 root 每秒挂回来，所以先置灰再摘：即使被挂回也看不见
      var olds = document.querySelectorAll('[data-hjyt-hud]')
      for (var i = 0; i < olds.length; i++) {
        if (olds[i] !== root) { try { olds[i].style.display = 'none'; olds[i].remove() } catch (e) {} }
      }
      if (window.__HJYT_HUD_OFF) {
        showChip()
      } else {
        hideChip()
        if (root && !root.isConnected && document.body) document.body.appendChild(root)
      }
    } catch (e) {}
    render()
  }

  function boot() {
    if (!document.body) { setTimeout(boot, 500); return }
    document.body.appendChild(root)
    render()
    // 每秒一跳：渲染 + **自愈**。读档、切模块、引擎重绘都可能把 HUD 节点从 DOM 摘掉，
    // 这里发现「没关掉但不在页面上」就自己挂回去，不用等插件重新注入。
    tickTimer = setInterval(tick, 1000)
  }
  boot()
})()

