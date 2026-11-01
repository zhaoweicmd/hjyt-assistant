// 开发用：像 agent 一样调用插件里的某个工具（假 ctx 加载插件），打印返回的 JSON。
//
// 用法：node test/tool.mjs <工具名> '<参数JSON>'
//   例：node test/tool.mjs hjyt_status
//       node test/tool.mjs hjyt_plan_sched '{"aircraftIds":"ac_1","routeId":"rt_1","maxLegs":8}'
//       node test/tool.mjs hjyt_buy_plan '{"limit":3}'
//       node test/tool.mjs hjyt_fuel_apply @args.json     从文件读参数（PowerShell 会吃掉带双引号的参数）
// 注意：写操作工具（*_apply）会真的改游戏，务必先不带 confirm 跑一遍看方案。
import fs from 'node:fs'
import { apply } from '../lib/index.js'

const [name, argJson] = process.argv.slice(2)
if (!name) { console.log('用法: node test/tool.mjs <工具名> [参数JSON|@文件]'); process.exit(1) }
let args = {}
if (argJson) {
  let text = argJson
  if (argJson.startsWith('@')) {
    try { text = fs.readFileSync(argJson.slice(1), 'utf8') } catch (e) { console.log('读参数文件失败：' + e.message); process.exit(1) }
  }
  try { args = JSON.parse(text) } catch (e) { console.log('参数不是合法 JSON: ' + e.message); process.exit(1) }
}

const tools = {}
await apply({
  tools: { register: (t) => { tools[t.name] = t; return () => {}; } },
  inject(n, cb) { cb({ tools: { register: (t) => { tools[t.name] = t; return () => {}; } }, webServer: { register: () => () => {} } }) },
  on() {}, effect() {},
}, {})

const tool = tools[name]
if (!tool) { console.log('没有这个工具：' + name + '（可用：' + Object.keys(tools).join(', ') + '）'); process.exit(1) }
const raw = await tool.execute(args, {})
let out = raw
try { out = JSON.parse(raw) } catch (e) {}
console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1))
process.exit(0)
