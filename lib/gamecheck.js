// 游戏内校验（引擎 validateFullSchedule）结果整理 —— 纯函数，方便单测
// 规则来源：游戏时刻表对话框的「校验」按钮 = verifyScheduleEdit → validateFullSchedule
//   a 逐天/跨日航线相连  b 周日→周一闭环  c 相邻航班周转 ≥ 50 分（硬错误）
//   d 机场最小起飞间隔  e 机场停靠上限（软警告，游戏里显示「⚠️ 通过校验，可能晚点」）
export const GAME_DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/** 把页面返回的 issues 摊平成带「周X第N段」位置的明细 */
export function normalizeGameItems(rawItems) {
  return (Array.isArray(rawItems) ? rawItems : []).map((x) => {
    const issues = (x && x.issues ? x.issues : []).map((it) => {
      const day = Number(it.day)
      const seg = Number(it.seg)
      const where = Number.isFinite(day) && Number.isFinite(seg)
        ? ((GAME_DAY_NAMES[day] || ('第' + (day + 1) + '天')) + '第' + (seg + 1) + '段')
        : null
      return { type: it.type || 'error', text: it.text || '', where }
    })
    return Object.assign({}, x, { issues })
  })
}

/**
 * 把飞机 id 切成小批 —— DSH 浏览器桥的 eval 有 **100ms 硬上限**，
 * 引擎 validateFullSchedule 单架 ~2ms、48 架一次跑会直接超时（2026-10-21 实测
 * hjyt_sched_verify 默认全队调用返回「eval timeout after 100ms」）。
 * 默认每批 8 架（≈20ms），超时还能对半再切。
 */
export function chunkIds(ids, size = 8) {
  const list = (Array.isArray(ids) ? ids : [ids])
    .map((x) => String(x == null ? '' : x).trim()).filter(Boolean)
  const raw = Number(size)
  const n = Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 8
  const out = []
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n))
  return out
}

/**
 * 汇总成 { verdict, text, checked, passed, partial, failed, confirmable }
 * verdict: 'fail'（有硬错误，游戏里点不了「确认」）/ 'partial'（只有软警告）/ 'pass' / 'skip'（没有可校验的排班）
 */
export function summarizeGameCheck(items) {
  const list = Array.isArray(items) ? items : []
  const live = list.filter((x) => x && x.ok)
  const failed = live.filter((x) => x.hasHardError || x.confirmable === false)
  const warnOnly = live.filter((x) => !failed.includes(x) && (x.partial || x.hasSoftWarning))
  const passedOk = live.filter((x) => !failed.includes(x) && !warnOnly.includes(x))
  const verdict = failed.length ? 'fail' : (warnOnly.length ? 'partial' : (live.length ? 'pass' : 'skip'))
  const brief = (arr, want, max) => arr.map((x) => {
    const texts = Array.from(new Set((x.issues || [])
      .filter((i) => want.includes(i.type))
      .map((i) => i.text + (i.where ? '（' + i.where + '）' : ''))))
    return (x.reg || x.id) + '：' + (texts.slice(0, max).join('，') || '排班有问题')
  }).join('；')
  let text = ''
  if (verdict === 'fail') text = '❌ 游戏内校验不通过：' + brief(failed, ['error'], 2) + '（游戏里这种状态点不了「确认」）'
  else if (verdict === 'partial') text = '⚠ 游戏内校验通过但可能晚点：' + brief(warnOnly, ['warning'], 2)
  else if (verdict === 'pass') text = '✅ 游戏内校验通过' + (live.length > 1 ? '（' + live.length + ' 架）' : '')
  else text = '游戏内校验：没有可校验的排班'
  const skipped = list.filter((x) => x && !x.ok)
  if (skipped.length) text += '；另有 ' + skipped.length + ' 架没有排班'
  return {
    verdict, text,
    checked: live.length, passed: passedOk.length, partial: warnOnly.length, failed: failed.length,
    confirmable: failed.length === 0,
  }
}
