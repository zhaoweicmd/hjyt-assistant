// 临时：不依赖宿主，直接跑「航线开发」表达式 + 计划器
import { GameClient } from '../lib/index.js'
import { resolveProfile } from '../lib/profile.js'
import { ROUTE_DEV_EXPR } from '../lib/expr.js'
import { routeDevPlan } from '../lib/plan.js'

const airport = process.argv[2] || '上海浦东'
const g = new GameClient(resolveProfile({}))
try {
  await g.connect()
  const t0 = Date.now()
  const raw = await g.evalRaw(ROUTE_DEV_EXPR({ fromAirports: [airport], model: 'B757-200', pitch: 71 }), 40000)
  const t1 = Date.now()
  const data = JSON.parse(raw)
  const r = routeDevPlan(data, { top: 5 })
  console.log('expr ms=' + (t1 - t0) + ' rows=' + (data.rows || []).length + ' apCount=' + data.apCount + ' unlocked=' + JSON.stringify(data.unlocked) + ' seatCap=' + data.seatCap)
  if (!r.ok) { console.log('PLAN FAIL ' + r.reason); process.exit(0) }
  console.log('from=' + r.from + ' candidates=' + r.candidates)
  for (const t of r.top) {
    console.log('#' + t.rank + ' ' + t.from + '↔' + t.to + ' | ' + t.km + 'km ' + t.ftMin + '分/' + t.legs + '段 用率' + Math.round(t.util * 100) + '%' +
      ' | 池' + t.demand.total + ' 配舱F' + t.layout.F + 'J' + t.layout.J + 'S' + t.layout.S + 'Y' + t.layout.Y +
      ' | 单架' + t.revPerPlane + '万 ' + t.paxPerPlane + '人 实售LF' + Math.round(t.lfRealized * 100) + '%' +
      ' | 养' + t.capacityAircraft + '架 有' + t.acCount + ' 加' + t.canAdd +
      ' | ' + (t.exists ? '已开线' : '开线费' + t.createCost + '万 回本' + t.paybackDays + '天') + ' | ' + t.note)
  }
} catch (e) {
  console.log('ERROR ' + String((e && e.message) || e))
} finally {
  try { await g.close() } catch (e) {}
}
process.exit(0)
