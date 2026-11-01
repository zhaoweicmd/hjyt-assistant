# hjyt-assistant · 航迹云途辅助插件

把「航迹云途」里每天重复的手工操作（推进、补油、检修、校验、排班、存档）和要动脑的经营动作（买机、开线、排班体检、日贡献看板、油库、扩张流水线）收进一个 DSH 插件。
游戏内有一个只读 **HUD**（12 个按钮），DSH 侧有**面板**和 **33 个 agent 工具**；所有写操作都在插件宿主里按白名单执行、写前快照、写后自检、可回滚。

| 项 | 当前值 |
|---|---|
| 版本 | **v0.7.4**（显示值是 `0.7.3+<hud.src.js 字节数>`，HUD 版本指纹靠它判断是否需要重注入） |
| agent 工具 | **33 个** `hjyt_*` |
| HUD 按钮 | 12 个 |
| 依赖 | 无第三方构建步骤；只需 profile 里的 `ws`；**不需要** `@deepseek-ai/dsh-tools`（见 §3） |
| 生效方式 | 宿主侧改动 → 重启 DSH；HUD 改动 → 刷新游戏页 |

## 目录

1. [运行形态与能力](#1-运行形态与能力)
2. [安装 / 更新 / 生效](#2-安装--更新--生效)
3. [自测](#3-自测)
4. [配置（全部可省略）](#4-配置全部可省略)
5. [两种运行模式](#5-两种运行模式)
6. [传输层：桥优先，CDP 兜底](#6-传输层桥优先cdp-兜底)
7. [界面](#7-界面)
8. [Agent 工具（32 个）](#8-agent-工具32-个)
9. [安全边界](#9-安全边界)
10. [关键实现坑](#10-关键实现坑)
11. [文件结构](#11-文件结构)
12. [已验证](#12-已验证)
13. [未做 / 已知限制](#13-未做--已知限制)
14. [变更记录](#14-变更记录)

---

## 1. 运行形态与能力

- **不绑定任何存档、工作区、脚本目录**：工作区 / 脚本目录 / 账本 / 传输层 / 游戏标签页全部自动探测；探测不到本地脚本也能跑（推进用引擎 `advanceGameTime()`，排查与五项校验收在页面侧表达式里，账本自动新建）。
- **只读面**：日期、现金、前日利润、声誉、机队、班次、健康最低、油量、可飞天数、夜停占用、延误计数 + 告警行。
- **写操作**：进阶一天、补油、扩油库、预约检修、存档、排班写入、买机、开线、改舱、改名、调机、回滚。
- **花真钱的写操作一律两次确认**：先不带 `confirm` 看方案，带 `confirm:true` 执行，单次 >5,000 万再加 `secondConfirm:true`。

---

## 2. 安装 / 更新 / 生效

插件以「本地 link」方式挂在 DSH 桌面 profile 上，源码就在本目录。

```bash
# 首次安装（2026-10-19 已手工完成，等价于下面这条命令）
dsh plugin --profile desktop add "link:…/插件/hjyt-assistant"
```

当前安装状态：

- `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 里有 `"hjyt-assistant": "link:…/插件/hjyt-assistant"`，`dsh.profile.bundles` 末尾追加了 `hjyt-assistant`
- `~/.dsh/profiles/desktop/node_modules/hjyt-assistant` → 软链到本目录（丢了就跑根目录 `修插件链接.cmd`）
- 本目录 `node_modules/ws` → 软链到 profile 的 `node_modules`
- **`@deepseek-ai/dsh-tools` 不再需要**：工具 schema 由本插件 `lib/schema.js` 自己编译成宿主认识的 raw JSON Schema

生效方式：

| 改了什么 | 怎么生效 |
|---|---|
| `lib/index.js` / `lib/profile.js` / `lib/plan.js` / `lib/sched.js` / `lib/schema.js` / `lib/gamecheck.js` / `lib/expr.js` | 宿主侧 → **必须重启 DSH**（双击根目录 `重启DSH.cmd`；agent 不能在会话内跑它，会把自己杀掉） |
| `lib/hud.src.js` / `lib/panel.html` | 刷新游戏页 / 面板页即可（HUD 版本指纹变了会自动重注入） |

判断宿主侧有没有真的加载成功：看 `脚本与数据/.plugin-state/<主机名>/plugin_log.jsonl` 尾部是否有

```json
{"op":"tool-register-ok","count":32,"total":32}
```

`count:32` 才是真的全注册；`tool-register-none` / `count:0` 说明 registrar 没就绪或 schema 被拒（后者每条都带 `schema.…is not supported on type "…"`）。

---

## 3. 自测

不需要宿主，`cd 插件/hjyt-assistant` 后：

```bash
export NO_PROXY=127.0.0.1,localhost   # Windows: $env:NO_PROXY='127.0.0.1,localhost'

node test/smoke.mjs --no-page   # 配置解析 + 32 工具注册 + schema 审计 + /hjyt 路由注册
node test/smoke.mjs             # 连真游戏页：只读工具 + 写操作闸门 + 实盘 sched_verify
node test/schema.test.mjs       # 11 条：作者 DSL → raw JSON Schema 编译 + 非法 schema 反例
node test/gamecheck.test.mjs    # 18 条：「周X第N段」文案 / 硬错软警分级 / 分批（100ms 上限）
node test/plan.test.mjs         # 199 条纯函数断言（买机/闸门/开线/体检/看板/油库/流水线/五项校验/配舱/维修窗口/改名/偶数段/航时/利润最大化/航线开发/部署成本）
node test/profile.test.mjs      # 42 条：工作区/账本/传输层探测与跨平台 remap
node test/cdp.test.mjs          # 9 条传输层断言（假 CDP 服务；需要 node_modules/ws）
node test/bridge.test.mjs       # 14 条 Browser Control 桥断言（假桥服务）
node test/http.mjs              # 8 条 /hjyt/* 路由（假 webServer）
node test/hud-check.mjs         # HUD 注入自检（版本 / 挂载 / DOM 不叠加）
node test/write-route.mjs       # 开线写路径：只出方案
node test/write-route.mjs --run # 真开线 → 自检 → 删回原状（约 3.32 万开线费）
node test/tool.mjs hjyt_fuel_plan              # 像 agent 一样调任意工具
node test/tool.mjs hjyt_fuel_apply @args.json  # 参数带双引号时写进文件（PowerShell 会吃内层引号）
```

- 工具的 `execute` 返回 **JSON 字符串**，`T()` 注册层会把它包成 `{text}` → 自测里要先取 `.text` 再 `JSON.parse`。
- `test/tool.mjs` 需要参数（`--no-page` 或文件路径），`node --test` 形式的 runner 在 Sync 盘会 `spawn EPERM`，所以统一直接 `node test/xxx.test.mjs`。

---

## 4. 配置（全部可省略）

省略任何一项都会走自动探测，所以「新玩家、新存档、换机器」都不用改代码。

| 键 | 省略时的行为 |
|---|---|
| `workspace` | `HJYT_WORKSPACE` → `~/.dsh/hjyt/workspace.txt` → 配置路径（先跨平台 remap 再 resolve）→ 自动扫描（mac `~/Library/CloudStorage/SynologyDrive*/` 等；win `%USERPROFILE%\Library\CloudStorage`、各盘 `X:\SynologyDrive*`、`X:\Users`）→ 从 cwd 向上找 |
| `scriptsDir` | 自动找含 `tick_day.js` / `daily_check.js` / `run_day.js` 的目录（脚本名 → `scripts/` → `tools/` → 根目录） |
| `dataDir` | 有脚本目录就用它，否则 `工作区/.hjyt/`（`plugin_log.jsonl` / `plugin_snapshots.json` / 自动账本） |
| `ledger` | `HJYT_LEDGER` → `~/.dsh/hjyt/ledger.txt` → 自动挑最近修改、≥64 B、非 `.bak`/冲突副本的 `days_*.json`；一个都没有就新建 `days_auto.json` |
| `tickMode` | 有 `tick_day.js` → `script`（含幽灵飞行自愈、自动补油、票价微调）；否则 `engine`（只用 `advanceGameTime`） |
| `transport` | `auto`（默认，**先桥后 CDP**）/ `bridge` / `cdp` |
| `cdpHost` / `cdpPort` | `127.0.0.1` / 9222，并按 `9222→9223→9222→9224→9225` 探测哪个端口真通 |
| `bridgeUrl` / `bridgeToken` | `http://127.0.0.1:9777` / `dsh-local`（DSH Browser Control 的 HTTP 入口与 Bearer） |
| `gameHostHints` / `gameTitles` | 先按 URL 片段（默认 `hangjiyuntu.cn`，可用 `gameHostHints` 覆盖）再按标题（`航迹云途`）；都匹配不上就逐标签页探 `GameState` |
| `turnWide` / `turnNarrow` | 75 / 60 分钟（宽体 / 窄体），由 `getAircraftModel().isWideBody` 现判（引擎硬下限 `GROUND_TURNAROUND = 50`） |
| `firstMin` / `lastArr` / `maxLegs` | 5 / 1390 / 10 |
| `cashIdle` | HUD「现金闲置」阈值，默认 1500 万 |

环境变量同名覆盖：`HJYT_WORKSPACE`、`HJYT_SCRIPTS`、`HJYT_LEDGER`、`HJYT_CDP_HOST`、`HJYT_CDP_PORT`、`HJYT_TICK_MODE`、`HJYT_TRANSPORT`、`HJYT_BRIDGE_URL`、`HJYT_BRIDGE_TOKEN`。

运行态文件按主机分家：`脚本与数据/.plugin-state/<主机名>/`（日志 / 快照 / 体检基线）。

---

## 5. 两种运行模式

| 模式 | 触发条件 | 推进 | 排查 | 五项校验 | 存档 |
|---|---|---|---|---|---|
| **script**（信息最全） | 工作区有 `tick_day.js` + `daily_check.js` + `save5.js` | 跑 `tick_day.js`（幽灵飞行自愈、自动补油、票价微调） | 页面侧现算 + `verify_sched.js` 交叉校验 | `daily_check.js` 全文输出 | `save5.js`（磁盘 AUTO 轮换 + 游戏内槽） |
| **engine**（零依赖） | 没有本地脚本 | 引擎 `advanceGameTime(3600) × 24` | 页面侧现算 | 页面侧五项（延误 / 间隔 / 健康 / 燃油 / 现金） | 触发引擎 `autoSaveGame()` |

---

## 6. 传输层：桥优先，CDP 兜底

插件先试 **DSH Browser Control 桥**（浏览器扩展 + 宿主内 `POST http://127.0.0.1:9777/api/command`，Bearer `dsh-local`），连不上再退回 Chrome 远程调试端口（9222）。
**普通启动的 Chrome 即可，不需要 `--remote-debugging-port`**——注意带调试端口启动的 Chrome 会停用扩展，二者只能选一个。
`hjyt_status` 返回的 `env.transport` 显示当前实际走的是 `bridge` 还是 `cdp`。

> ⚠️ 桥的 `eval` 有 **100ms 硬上限**。任何「一次读全队」的页面表达式都必须分批（游戏内校验见 §7.2；48 架 `validateFullSchedule` 约 100–120ms，一次跑必超时）。

---

## 7. 界面

### 7.1 游戏内 HUD

右下角浮窗，拖标题栏移动，`－` 折叠，`×` 关闭（关闭后刷新页面或重连会重新注入；HUD 掉了先看右下角有没有 `🛩 HUD` 徽标，点它即可恢复，或双击根目录 `打开HUD.cmd`）。

**抗读档三层兜底**：① 页面脚本每秒自检，没被 `×` 关掉但节点不在 DOM 里就自己挂回去；② 宿主每 8 秒核对 `window.__HJYT_HUD_VER__`，不对就整段重注入；③ 手动 `open_hud.js`。

**「已读档/换日：上一次的结果已清空」是怎么来的**：面板里各工具的结果（买机报价 / 排班方案 / 体检 / 配舱 / 开线）来自页面缓存 `window.__HJYT_*`，宿主只是写、面板每秒只负责显示。`render()` 每秒算一次会话指纹 = **游戏日期（y-m-d）+ 机队 id 列表 + 当日班次总数**，指纹变了才清缓存并隐藏面板，并在 20 秒内提示这句话。所以这句只在「读档 / 换局 / 推进到第二天」时出现，**不用处理**，需要就重新点一次按钮。⚠ 不要再用 `GameState.gameTime` 做指纹：游戏内时钟每秒走 1 分钟，会每秒触发一次清空（v0.7.5 已修，见变更记录）。

显示行：日期 / 现金 / **前日利润** / 声誉 / 机队 / 班次 / 健康最低 / 油量 / **可飞天数**（用引擎记录的昨日实际耗油）/ **夜停占用**（最紧的机场 占用/上限）/ 延误计数 + 告警行。

**前日利润**口径：最近一个已结束营业日的 `modules.*.dailyStats` 求和，收入（`revenue + orderRevenue + eventReward + compensation`）− 支出（`fuelExpense + maintenanceCost + equipmentExpense + cateringExpense`，账单为负）。**不含设备投资与买机款**，所以不等于当日现金变化；亏损时告警行追加提醒。

12 个按钮：

| 按钮 | 作用 |
|---|---|
| `推进1天` / `推到5日节点` | `hjyt_daily`，出红线即停 |
| `航线设置` | 一键给全部航线设票价 `{F:2,J:2,S:1.05,Y:0.45}` + 精品餐食 + 精品快线（工具侧 `all:false` 可只作用于选中航线） |
| `检修` | 预约检修（走 `insp_sched.js` 字段直改，不碰会弹窗的 UI 函数） |
| `排班` | 三步排班（§7.2） |
| `购买飞机` | 输入机型 → 自适应配舱 + 全设施 + 节油发动机 → 两次点击购买；`数量 − N ＋` 支持一次买 1..10 架 |
| `改名(按城市)` | 按当天主航线改成「起-降」**完整城市名**（法兰克福-伦敦 / 上海-新加坡，同城对加 ②③） |
| `客舱重建` | 按主力航线分舱位需求重配 F/J/S |
| `看板` | `hjyt_board` 摘要（收入 / 乘客 / 油费 / 净利 / 成本结构 / 弱航线） |
| `体检` | 排班体检 **+ 利润最大化**（§7.4） |
| `开线` | 航线开发 + 一键部署（§7.3） |
| `今日待办` | `hjyt_expand_plan`：红线 → 排班 → 补油/扩库 → 开线 → 买机，每步带花费 |

按钮**只往 `window.__HJYT_QUEUE` 压命令**，宿主每 2.5 秒取走执行，结果回写到 HUD 底部一行。
`补油` / `存档` 已从 HUD 撤下（`refuel` / `save` 命令仍在，可由面板或 agent 工具触发）。

`render()` 每秒跑一次，**禁止在 render 里发命令或写 `GameState`**（历史事故：一按被 N 个残留实例放大成每秒 N 条）；面板刷新一律走「点击后的一次性轮询」，消费完 `window.__HJYT_LAST` 立刻置 `null`。宿主对 `health` 命令另有 5 秒防连击。

### 7.2 三步排班（选航线 → 选飞机 → 确认）

1. 在游戏右侧航线列表**点选一条航线**（出现高亮；插件读 `.route-item.selected` 的 `data-route-id`，退回 `_currentRouteDetailId`）
2. HUD 点 **排班** → 候选列表**只列「整周（7 天）完全没有排班」的飞机**（v0.7.5，2026-10-25 用户指令：已有航线在飞的飞机一律不列）；排得下的显示 `180座 · 9段 00:27–21:39`，排不下的写原因（航程不够 / 时段或维修位排不下）；全队都有班表时直接提示 **「无闲置飞机」**（旧版只数周一那一天，会把「周一空、周二~周日有班」的飞机误列成闲置）
3. 选一架 → **确认：XXX 排 N 段** → 写入 → 自动自检 → 结果回 HUD

**硬规则**：

| 规则 | 说明 |
|---|---|
| **偶数段**（`requireReturn:true`） | 末段必须回到起飞机场过夜；只能排出奇数段时**直接拒绝**并写明差在哪（奇数段=外站过夜=次日首段错位=记严重延误） |
| **夜停机场必须有维修位**（四查 C1/C3，**一律严格**） | 面板没有「放行」开关；全公司维修位=0 时提示先升 hub（约 500 万 / 1 个位） |
| **末班落地 ≤ `lastArr`（默认 1390）** | 严禁 `arrivalMin = 1440`（午夜落地会被判跨日） |
| **过站 ≥ `turnWide/turnNarrow`（75/60）** | 引擎硬下限 50 是极限值，不按它排 |
| **利用率默认 85%**（面板可切 70 / 不限） | 70% 是旧的保守值：浦东↔乌鲁木齐单程 265 分，4 段=73.6% 会被砍成 2 段；85% 才能排满 2 个往返 |
| **航时按本机巡航速度现算** | `round(km ÷ cruiseSpeed × 60)`：B757-200 850km/h → 78 分、B737 MAX 8 750 → 88、C909 700 → 94 |
| **机场最小起飞间隔现算** | `AIRPORT_LEVELS[level].minDepartureInterval`：normal 40 / hub 20 / base3 10 / base2 5 / base1 0 |

**起飞城市可选**：面板「起飞 [A] [B]」，从哪一端起飞点哪个；**不要求飞机先停在航线一端**（与手动排班一致），不在起飞地时给位置提醒 + 「调机→X」。

**维修窗口三选一**（引擎只要求「停住 + 距下一班 ≥3h + 有维修位」）：

| 选择 | 行为 |
|---|---|
| **夜间**（默认） | 只保证末班 → 次日首班 ≥180 分，不牺牲段数 |
| **白天** | 在 10:00–13:00 强留 180 分（停机从上一段落地起算 `max(10:00+180, 落地+180)`），少飞 2~4 段，日产能×2 |
| **不预留** | 不管维修窗口，纯最大化段数 |

**写完自动跑「游戏内校验」**（v0.7，用户要求）：三个入口（HUD 一键排班 / 三步排班确认 / 一键部署）写盘后，除插件侧自检（最小过站 / 末班落地 / 机场起飞间隔），再自动调引擎 **`validateFullSchedule`**（= 游戏时刻表对话框「校验」按钮的同一套规则：跨日/跨周航线相连、周闭环、周转 ≥50 分、机场最小起飞间隔、机场停靠上限）。结论直接写在 HUD 结果行 / 部署面板 / 工具返回值（`gameCheck` / `gameText` / `gameCheckOk`），例如：

```
❌ 游戏内校验不通过：B757-200：跨日或跨周航线不相连（周五第2段）（游戏里这种状态点不了「确认」）
⚠ 游戏内校验通过但可能晚点：…（晚点预警：不符合机场最小起飞间隔）
✅ 游戏内校验通过（48 架）
```

> 全队校验按 **8 架一批**顺序调（v0.7.2）：某批仍超时就对半再切；个别读不到的架不冒充硬错误，文案补「另有 N 架没读到」并在返回值 `unread` 里列出。

### 7.3 航线开发 + 一键部署

`开线` 面板（工具 `hjyt_route_dev`）：

- 输入机场（**模糊**：`浦东` / `PVG` / `上海` / `东京`，只在 `GameState.unlockedRegions` 内找；命中多个给候选按钮）→ 列出**最值得开的 5 条线**：航距 · 每日段数（偶数段）· 单架日收入 · 建议配舱与最优票价 · **能养几架**（日需求池 ÷ 单架日需求，扣已有飞机数与两端空余停机位，给出「已有几架 / 还能加几架」）· 开线费与回本天数
- 机型默认 **B757-200 @71cm = 255 座**（`floor(230×79/71)`），可用 `model` 换

**选中一条 → 「一键部署 A → B」**（工具 `hjyt_route_deploy`）：

| 点击 | 行为 |
|---|---|
| 第 1 次 | **只算账**：回填买机 + 开线费 + 花完剩多少 |
| 第 2 次 | **真执行**：补开线（双向，只补缺的方向）→ 买 1 架（含装备 + 该线利润最优配舱）→ 排班（偶数段、夜停有维修位） |

- 配舱按「买机安全空间」算：引擎买机走 `validateCabinLayout(layout, model.seats)`，总量必须 ≤ **机型座位数**（B757-200 = 230）→ 71cm 的 255 座要**买完再改舱**（返回里 `buySpace / canRetrofit` 标出）
- 默认**双向开线**（偶数段要靠反向航线回程），票价 / 配舱用这条线的利润最优值
- **安全阀**：算过账的「下次点击=执行」只对**当前选中那一行**有效，换选另一行立刻解除（按钮变回「一键部署」，必须重新点两次）；点「取消」/ 换日 / 读档也会清空
- 排班失败不回滚（开线 + 买机已生效），面板会说明原因（常见：维修位不够 / 这条线吃满了）

### 7.4 体检 = 排班体检 + 利润最大化

HUD 点 **体检**：

1. 列出 闲置 / 欠排 / 利用率低 / 末班偏早 的飞机，每行一个 **一键排班** 按钮；夜停超容、起飞间隔违反只报警（要换基地 / 停飞）
2. **同时按引擎真值公式做利润最大化**：重算每条航线的 `F/J/S/Y` 倍率与每架机的舱位分配，**不是最优就直接写**——票价免费先改；配舱要花钱，只用「现金 − 800 万运营垫」，按「收益 ÷ 改装费」排序能改几架改几架。约束只有一条：**客座率不触发报警**（下限 62%；引擎连续 3 天 <60% 才报警）。面板顶部显示「✓ 利润优化：改了 N 条票价 / M 架配舱 · 预估日均收入 X → Y（+Z%）」

> 引擎每舱需求 `pax = min(座位, 当日池, round(loadFactor × 座位 × clamp(m^(−e), 0.5, 1.8)))`，`e = {F:0.6, J:0.9, S:1.2, Y:1.5}`；`Y ≤ 0.7375` 时涨价纯赚（弹性被 1.8 截断）。声誉公式没有票价项，涨价不掉声誉。

体检里两条容易混：

- **`misplaced`（提示，不算红线）**：飞机当前位置 ≠ 当日首段起飞地。**正常**——引擎会自己放到起飞地
- **`stuckFerry`（红线）**：`ferryState.active=true` 却没起飞、`phase` 不是引擎认识的（`ferrying/temp/returning/inspection/retrofit/cargo/positioned`）→ `ui.js` 会跳过该机所有航班，飞机原地空转

### 7.5 DSH 侧面板

访问 `http://127.0.0.1:<DSH端口>/hjyt/panel`（端口见运行时上下文的 Web GUI URL）。
只读盘面 + 同款按钮 + 「洞察」卡片（看板 / 体检 / 买机 / 开线速览）+ 输出日志。
HTTP 路由：`/hjyt/state|status|log|cmd|panel|hud.js|board|health|buyplan|routeplan`。

---

## 8. Agent 工具（33 个）

写操作分两档确认：`confirm:true` 才真执行；单次花费 >5,000 万再加 `secondConfirm:true`。

**盘面 / 校验**

| 工具 | 作用 |
|---|---|
| `hjyt_status` | 读盘面（不写任何东西） |
| `hjyt_checks` | 五项校验（延误 / 检修 / 检测 / 资金 / 燃油），无脚本时走页面侧 |
| `hjyt_audit` | 全量时刻表排查（最小过站 / 末班落地 / 机场起飞间隔），页面侧现算 |
| `hjyt_sched_health` | 排班体检：闲置 / 欠排 / 过站偏紧 / 末班过早 / 首班过晚 / 夜停超容 / 起飞间隔 / stuckFerry；红线只认夜停超容、间隔违反、过站 <50 |
| `hjyt_sched_verify` | **游戏内校验**（只读）：调引擎 `validateFullSchedule`，逐架给「通过 / 通过但可能晚点 / 不通过」+ 具体到「周X第N段」；不传 `acId`/`reg` 就查全队已排班飞机（分批 8 架） |
| `hjyt_board` | 日贡献看板：近 N 天收入 / 乘客 / 油费 / 净利趋势、成本结构、燃油天数、弱航线（客座低 / 单位收入低） |
| `hjyt_aircraft_list` | 机队清单：id / 机号 / 机型 / 座位 / 状态 / 基地 |

**推进 / 存档 / 回滚**

| 工具 | 作用 |
|---|---|
| `hjyt_daily` | 推进 N 天：tick_day → 五项校验，出红线即停 |
| `hjyt_save` | 立即存档（磁盘 AUTO 轮换 + 游戏内槽） |
| `hjyt_rollback` | 回滚排班写入（快照落盘、滚动 5 份）；快照之后又改过则拒绝，需 `force:true` |

**排班**

| 工具 | 作用 |
|---|---|
| `hjyt_plan_sched` | 生成排班方案（只出表，不写） |
| `hjyt_apply_sched` | 应用方案（写前快照，写后自检 + 游戏内校验） |
| `hjyt_sched_pick` | 三步排班第 1 步（只读）：读「游戏里选中的航线」，**只列整周（7 天）完全没有排班的闲置机** + 推荐一架；全队都有班表 → `idleCount:0` + note「无闲置飞机」；夜停必须维修位 |
| `hjyt_sched_apply_pick` | 三步排班第 2 步（写）：把该机排到该航线；已有班要 `mode:"replace"` |
| `hjyt_sched_fix` | 面板「一键排班」同款（写）：按这架飞机**自己现在的航线**只重排段数与时刻，不换线；默认偶数段、夜里回起飞机场过夜 |

**买机 / 改舱 / 改名 / 调机**

| 工具 | 作用 |
|---|---|
| `hjyt_buy_plan` | 买机清单（只读）：按预算 / 基地 / 机型算每段净利、日净利、回本天数、机库位、油库 3 天缺口 |
| `hjyt_buy_quote` | 买机报价（只读）：机型 + `count`（1..10）→ 自动配舱 + 全设施 + 节油发动机，给舱位 / 装备 / 单价 / 批量总价 |
| `hjyt_buy_apply` | 买机（写）：不带 `confirm` 只回方案；`count` 一次买多架（等比级数总价）；写后自检机队数与现金差；机型黑名单会拦（`force:true` 强买） |
| `hjyt_cabin_rebuild` | 客舱重建（写）：按主力航线分舱位需求重配 F/J/S（Y 按剩余空间算），默认间距 74cm；`apply:false` 只预览费用 |
| `hjyt_rename_aircraft` | 飞机手动改名（写）：只改 `regName`（id 不变），校验非空 / ≤24 字 / 不重名 |
| `hjyt_rename_by_route` | 按起降城市自动改名（写）：改成当天主航线的「起-降」**完整城市名**（不再截断成 2 字），同城对加 ②③，闲置机不动 |
| `hjyt_ferry` | 调机（写）：调到目标机场（不花钱，需航程够、不在飞 / 维修）；到站后才能排该机场的航线 |

**开线 / 部署**

| 工具 | 作用 |
|---|---|
| `hjyt_route_plan` | 开线候选（只读）：从基地现算需求 / 航距 / 开线费 / 起飞间隔余量，给建议机型与班次（目标吃掉约 25% 需求） |
| `hjyt_route_dev` | 航线开发（只读）：机场名模糊 → 最值得开的 N 条线 + 「能养几架」+ 开线费与回本 |
| `hjyt_route_apply` | 开线（写，默认双向）：建线 → 票价 → 精品餐食 → 精品快线，四步全自检 |
| `hjyt_route_setup` | 一键航线设置（写）：给选中航线（含反向）或 `all:true` 全部航线设票价 + 精品餐食 + 精品快线 |
| `hjyt_route_deploy` | 一键部署（写）：补开线（双向）→ 买 1 架 → 排班（偶数段）；先不带 `confirm` 看花费；花完低于 800 万运营垫会警告 |

**油库 / 扩张 / 利润**

| 工具 | 作用 |
|---|---|
| `hjyt_fuel_plan` | 油库向导（只读）：容量按「满库 4 天」报价（铁律下限 3 天）+ 补油方案（触发线 `max(3 天, 库容 30%)`、目标 `max(4 天, 95% 库容)`、油价 ≤5 加满、>7 且高于 7 日均价 5% 只补到触发线 +0.5 天、库存 <1 天断油兜底） |
| `hjyt_fuel_apply` | 油库执行（写）：按方案扩容量（逐级 + 现金检查）+ 真补油；写后复查可飞天数 |
| `hjyt_expand_plan` | 扩张流水线（只读）：红线 → 排班补产能 → 补油 / 扩油库 → 开线 → 买机，每步带花费、工具、args、现金余量 |
| `hjyt_profit_optimize` | 利润最大化（体检同款）：重算票价倍率 + 配舱，不是最优直接改（`apply:false` 只看、`only:'fare'/'cabin'` 只改一半） |
| `hjyt_profit_plan` | 利润最大化方案（只看不写）：建议票价 / 配舱 / 预估日均收入变化 / 改装费 |

---

## 9. 安全边界

1. **写操作白名单**：`tick_day`（推进）、`buyFuel`、`upgradeFuelCapacity`、`insp_sched.js`（预约检修）、`save5.js`、`GameState.schedule[acId]`（排班）、快照回滚、`buyAircraftWithEquipment` / `buyAircraft`、`createRoute` + `setRouteFarePolicy` + `setRouteServicePolicy` + `setExpressLevel`（开线四步）。
2. **禁止调用 UI 型函数**：`doBookInspection`、`toggleInspectionManaged`、任何 `open*Dialog` / `showLoadDialog`（2026-10-19 被它们锁死过页面，CDP 连 `terminateExecution` 都无响应）。
3. 五项校验出红线**立即停**，不再推进。
4. 排班写入前自动快照（`plugin_snapshots.json`，滚动 5 份，存完整 before/after），写后自动页面侧自检 + 游戏内校验；回滚时若发现这些飞机在快照之后又被改过，**默认拒绝覆盖**（需 `force:true`）。
5. 游戏页与 DSH 跨域，**HUD 不做任何网络请求**：显示读页面内 `GameState`，命令走页面内队列。

---

## 10. 关键实现坑

> 改代码前先看这一节，每条都是实测踩过的。

**页面表达式**

- **`GameState` 是全局词法绑定，不是 `window.GameState`**：页面用 `const GameState = …` 声明 → `typeof window.GameState === 'undefined'`，但裸写 `GameState` 是对象。插件里一律 `(typeof GameState !== 'undefined') ? GameState : window.GameState`
- `lib.evaluate` **不支持返回 Promise**：所有页面表达式必须是同步 IIFE，返回 `JSON.stringify(...)`；异步操作走「触发 → 等几秒 → 再读」
- **桥 `eval` 100ms 硬上限**：全队级页面表达式必须分批；48 架 `validateFullSchedule` 分 4 批（或每批 8 架）才安全

**引擎数据结构**

- `G.routes` 是 **Array**（`from`/`to` 是机场名字符串），`G.airports` 是**按名字索引的对象**（`(G.airports||[]).find` 会抛 `TypeError`）
- `G.schedule[acId]` 必须是 **7 元素数组**；段字段 `{routeId, departureMin, arrivalMin, flightTime, _id, cancelled, _fuelDeducted}`，**段里没有 from/to**（方向靠 `routeId` 反查）
- **`AIRCRAFT_MODELS[k]` 没有 `seats`**：机队座位只能对 `cabinLayout` 求和，用 `a.seats` 会全得 0
- **`GameState.dailyHistory[].fuelCost` 恒为 0**：真实成本要 join `modules[].dailyStats`（支出为负，`date` 可能是字符串）
- `canOperateAircraft(model, moduleId)` **必须传模块名**
- **`buyFuel(amount)` 单位是「万升」**（页面输入框就是万升）→ 传升会多买 1 万倍
- **`getFuelUpgradeInfo(currentCapacity)` 必须传当前容量**：不传会直接落进最贵那档

**价格 / 收益**

- **舱位收益必须乘基础价系数 F10 / J4 / S1.7 / Y1**：只拿倍率比空间会把空间全给 S/J、F 拿 0 座
- **配舱唯一算法 = 报告黄金公式**（v0.7.8 起，`bestCabin` 是三个入口的唯一实现）：
  `A = min(1, 航线声誉/100 × 健康/100 × 1.1 × I(Y倍率))` → `K_c = min(1, A × clamp(倍率^−弹性,0.5,1.8))` → `该舱需求座位 = 每班需求 ÷ K_c` → 按「每空间收入 = 倍率×基础价系数÷空间」降序装满，Y 至少 12 座兜底。
  引擎源码核对：`doDeparture` 里 `intentionIndex = transferFactor × healthFactor × 1.1 × fareIntent`（**不是 1.05**），`allocateRouteCabinPassengers` 里 `pax = min(座位, 池, round(load × 座位 × fareDemandFactor × serviceFactor))`。
- **不要用「抬 Y 票价」去追报告 P0**：`A` 随 Y 倍率上升而下降，Y 抬到 0.75 时 A 从 1.0 掉到 0.75，黄金公式会把空间推给 F/J、Y 只剩几十座，收入反而下降（北京线实测 169.4 → 166.1 万）。**只有航线声誉 ≥75（A 仍能封顶）时抬 Y 才划算**。
- **买机空间 = 机型座位数（230），重建空间 = floor(230×79/71) = 255**：同一套 F/J/S 在 71cm 重建时 Y 会多出 25 座（北京线 Y98 → Y123，日收入 169.4 → 177.0 万）。两个口径不能混用。
- **需求只用 `route.demandByCabin`**；`getRouteDemandQuote()` / `getRouteDemandByCabin()` 走报价，低需求航线是周口径×7 且含外部市场，实测虚高 4~6 倍
- **改舱费按目标布局全量计**：`F×2 + J×0.8 + S×0.3`（万/座，Y 免费）
- **批量购机是等比级数**：每买 1 架全场 ×1.015（封顶 31 倍、卖机不回退）→ 总价 `单价×(1.015^N−1)/0.015`，不是「单价×架数」

**排班引擎**

- 排班硬约束：周期 `P = 航时 + 过站`（不能拿最小间隔反推）；base 机场起飞 `T, T+2P, T+4P`，对端 `T+P, T+3P`
- **两套「机场最小起飞间隔」语义不同**：`validateFullSchedule` 用 `Math.abs(dep − other) < minInterval`（**差 0 分也算冲突**）；`validateRouteScheduleForAdd` 多一个 `> 0` 条件（同分钟不算）→ 排班一律按前者留余量
- 引擎「严重延误」口径会放大（`settleDailyDelays` 拿全场延误总和对 180 判）；真实口径是**单班最大延误 ≥180**，插件按后者判红
- **`validateFullSchedule` 的机场间隔检查不跳过 `cancelled` 段**：资金/燃油不足导致的取消会让班表看起来「断链」，日切后自愈，**不要为此重排**

**调机 / 故障**

- **`scheduleFerryToAirport(id, to, purpose)` 的 purpose 必须传 `'ferrying'`**：引擎只处理 `phase ∈ ferrying/temp/returning/inspection/retrofit`；传别的 → 飞机永远不飞、还留 `active=true`
- **调机落地会弹「临时航班」对话框并暂停**：插件调机后自动设 `_autoPositioning=true` 走静默定位；已卡在 `temp` 的再调一次同目标即可
- **`ferryState.phase==='temp_waiting'` = 这架机所有航班被取消**：`processWaitingDepartures` 只要 `ferryState.active` 就跳过每一次起飞，日志 `[processWaitingDepartures-调机冲突]`、`totalFlightHours` 永远是 0
- **黑名单机型 `capabilities.supported=false`**（B767-300ER / C909 / A319 / Yak-42 / ATR72 / CRJ / MD / Tu-204 / Dash8）：永远不能改发动机 / WiFi / 小翼，买来硬件锁死
- `faultSystemEnabled` 会被**存档载入覆盖回 `true`**：读档后必须复查

**插件自身**

- **`String.replace('__HJYT_VERSION__', v)` 只换第一处**：占位符在 HUD 源码里出现两次（版本守卫 + `VERSION`），必须 `split().join()`，否则守卫恒不等、每注入一次叠一层 HUD
- **`getAircraftFactoryEquipmentQuote(model, cfg)` 严格校验键**：只许 `version/winglets/engineProfile/wifi/ptv`；机型能力要单独传
- **工具 schema 必须自己编译成 raw JSON Schema**（v0.7.1 事故）：宿主 `ToolRuntime.register()` 只做 `assertSupportedJsonSchema(output.schema)`，**不编译 `parameters`**。旧版用 `await import('@deepseek-ai/dsh-tools')` 取宿主 `defineTool`，新版宿主解析不到 → 静默退化成恒等函数 → 作者 DSL 原样进 register → 32 个工具全被拒（`schema.properties.text.required is not supported on type "string"`）。现在由 `lib/schema.js` 编译：属性级 `required:true` 提升成对象级 `required:[...]`、object 必须显式 `additionalProperties` 布尔、只保留 `type/properties/required/additionalProperties/items/enum/const` + 注解
- **`catch(e){}` 静默降级必须留痕**：上面那条事故就是因为降级无声，日志里只有 `tool-register-fail` 却没人看

---

## 11. 文件结构

```
插件/hjyt-assistant/
├─ package.json          DSH 插件清单（dsh.bundle.patch 指向 cordis.patch.yml）
├─ cordis.patch.yml      挂载声明 + config（workspace / cdpPort / ledger / transport）
├─ lib/index.js          宿主：传输层（CDP / Browser Control 桥）、白名单操作、33 个工具、路由、队列轮询、快照
├─ lib/profile.js        运行环境探测（工作区 / 脚本目录 / 账本 / 传输层 / 模式）
├─ lib/expr.js           页面侧表达式（状态 / 排班输入 / 全量排查 / 游戏内校验 / 推进一天）
├─ lib/sched.js          排班算法（纯函数：planOne / planFleet / occupy）
├─ lib/plan.js           规划器（纯函数：buyPlan / routePlan / healthReport / boardView / fuelPlan / expandPlan / fuelCapacityCost）
├─ lib/schema.js         作者 DSL → raw JSON Schema 编译器（工具注册用，附离线镜像校验）
├─ lib/gamecheck.js      游戏内校验结果规范化 + 文案 + 分批（纯函数，可单测）
├─ lib/hud.src.js        游戏内 HUD（注入网页，带版本指纹自愈）
├─ lib/panel.html        DSH 侧面板
├─ test/                 单测与实盘 smoke（见 §3）
└─ node_modules/         指回 profile 的软链（ws）
```

---

## 12. 已验证

**v0.7.7（2026-10-31，修「点购买飞机总是关闭」）**

- 根因：HUD 的「会话指纹」用了 `String(GameState.gameTime)`，那是**游戏内时钟**（每秒走 1 分钟）→ 指纹每秒都变 → `resetPanelsForNewSession()` 每秒执行 → 买机/排班/体检/配舱/开线面板**每秒被隐藏一次**，输入框根本来不及填；黄字「已读档/换日」也因 `__HJYT_STALE_AT` 每秒刷新而常驻。
- 修法：指纹改为 **游戏日期（y-m-d）+ 机队 id 列表 + 当日班次总数**。日期/机队/班次不变就绝不清面板；保留班次总数是为了兜住「同一天读另一个存档」（AUTO-1..5 常停在同一游戏日，只靠日期分不出来）。
- 顺带：`lib/index.js` 里硬编码的 HUD 版本 `0.7.4` 改为读 `package.json`（`PKG_VERSION`），页面版本指纹不再和 package.json 对不上。
- 实测：`ver 0.7.7+72540` 下连点两次报价（B757-200 744.5 万 / A320neo 823.8 万）面板全程 `display:block` 并正常回填「确认购买」；人为改坏 `__HJYT_SIG` → 下一次 tick 面板立刻隐藏、`staleAge` 归零，证明真换日仍会清面板。`plan.test` 199 通过 / 0 失败。

**v0.7.6（2026-10-25，改名写完整城市名）**

- `lib/plan.js` 的 `cityOf` 不再 `slice(0, 2)`：新增 `CITY_NAMES`（约 150 个城市全名）+ `CITY_SORTED`（按长度降序），机场名去掉「机场/国际机场」后取**最长前缀城市**，认不出就原样返回全名。实测本局 44 个机场全对：法兰克福机场→法兰克福、新加坡樟宜机场→新加坡、班加罗尔Kempegowda国际机场→班加罗尔、伊斯坦布尔萨比哈·格克琴机场→伊斯坦布尔、米兰马尔彭萨机场→米兰。
- 本局 73 架已按新规则重命名 16 架（上海-新加→上海-新加坡、法兰-伦敦→法兰克福-伦敦、米兰-法兰→米兰-法兰克福…），`maxLen 10`、无重名。
- `node test/plan.test.mjs` → 199 通过 / 0 失败。

**v0.7.4（2026-10-25，机场查询 + 故障开关自愈）**

- HUD 第 12 个按钮「今日待办」改为「机场查询」：一键把**三级基地以上（含 hub）**机场的「维修点数量 / 夜间停靠数量(实际) / 夜间维修航班数量 / 白天维修航班数量(B 口径)」+ 开线建议写成工作区 `机场查询_<最新存档名>.xlsx`（同名覆盖；Excel 正开着时改写成带时间戳的名字，不丢数据）。第二张 sheet 是「夜停分布(全机场)」，用来找「外站夜停但维修位=0」的红线机场。
- 新增 agent 工具 `hjyt_airport_query`；HTTP 路由 `/hjyt/airportquery`；CLI `node 脚本与数据/airport_query.js`（与 HUD 同一套逻辑，逻辑在 `lib/airport_query.js` + `lib/xlsx_min.js`）。
- **故障开关自愈**：队列轮询（每 2.5 s）顺带检查 `GameState.faultSystemEnabled`，一旦被存档载回 `true` 就地关掉、清 `faultStatus` 与 `departureDelay` 里的 `fault` blocker、跑一次 `updateFaultAlert()`，全程不打扰用户。
- 白天/夜间维修的归类口径：引擎不记录维修开始时间 → 白窗取引擎自带「白天维修窗口 10:00–13:00」，其余时刻的维修算夜间（按查询时刻快照）。

**v0.7.3（2026-10-22，全量自检 · 实盘 2027-02-11）**

- 静态：`lib/*.js` 8 个文件 `node --check` 全通过；无 `TODO/FIXME` 残留；`cordis.patch.yml` 无硬编码机器路径
- 单测 293 条全绿：bridge 14 / cdp 9 / gamecheck 18 / plan 199 / profile 42 / schema 11
- `node test/smoke.mjs`（实盘，58 架 / 100 航线 / 376 段/日）：`[schema] 32 个工具 · 违规 0`、`[audit] stop 0 / interval 0`、`[write-guard] OK`、`[fuel-write-guard] OK`
- `node test/smoke.mjs --no-page`（离线）：32 工具 schema 编译零违规
- 宿主侧全队校验（分批）：`checked 58 / passed 57 / failed 1`，`unread: []` —— v0.7.2 分批在真宿主里生效
- HUD 注入自检：`mounted:true`、单层 DOM、12 按钮、读到实盘 `2027-02-11` 与「油量 800/800 万升 · 可飞 2.8 天」
- HTTP：宿主口 `/hjyt/state|panel|hud.js` 均 200；兜底口 `127.0.0.1:9778/hjyt/state` 200；`/hjyt/log` 可读
- 读工具延迟：status 0.2 s，audit / board / fuel_plan / route_dev / sched_verify / checks 各约 0.1 s
- 日志：`plugin_log.jsonl` 438 KB / 766 行（历史坏启动累积 356 条 `register-fail`）→ 新增 1.5 MB / 留 400 行的自动裁剪

**v0.7.2（2026-10-21，实盘 2027-02-05）**

- 工具注册：`plugin_log.jsonl` 出现 `{"op":"tool-register-ok","count":32,"total":32}`；`hjyt_status` 走 `transport:"bridge"`
- `node test/smoke.mjs`：`[schema] 32 个工具 · 违规 0`、`[sched_verify] pass · 通过 48 · 可能晚点 0 · 不通过 0`、`[status] 2027-02-05 3507万 48架 342段 声誉39.03`
- 单测：schema 11 / gamecheck 18 / plan 199 / profile 42 全绿；`hud-check` 注入单层 DOM、`mounted:true`
- 游戏内校验：48 架全部 `passed:true`（分批 8 架后不再超时）

**历史关键验证**

| 版本 | 结论 |
|---|---|
| v0.7 | 三个排班入口写盘后自动跑 `validateFullSchedule`；3 架曾报 `4-1`「航线不相连」的经验证是资金取消段的假断链，日切自愈 |
| v0.7.1 | 32 工具注册失败根因定位（宿主只收 raw schema）；`test/schema.test.mjs` 用线上那条错做反例 |
| v0.6 | 航线开发 + 一键部署（两次点击）；机场模糊搜索 |
| v0.5 | 报告口径对齐：油库 / 票价 / 购机闸门 / 排班 / 配舱 / 间距 / 五项校验 |
| v0.4 | 油库向导 + 执行（`buyFuel` 真跑：129.74 万买到 20 万升，可飞 2.16 → 3.0 天）；扩张流水线 |
| v0.3 | 四个向导（买机 / 开线 / 体检 / 看板）+ 写操作 `confirm` 闸门 |
| v0.2 | 排班写入 → 回滚**字节一致**；纯页面模式（无本地脚本）全通；标签页三级识别 |

---

## 13. 未做 / 已知限制

- **买机写路径**只在有 base 机场的局验证过闸门与自检，未覆盖卖机回收
- 体检发现欠排后仍要串 `hjyt_plan_sched` → `hjyt_apply_sched` 补段（面板可以一键，agent 侧两步）
- 扩张流水线**只排队不执行**：没有 `hjyt_expand_apply`（写操作保持人工逐步确认）
- 流水线的买机没把「油库增量」折进方案：每架 B757 4 段 ≈ +2.7 万升/日 → 容量需 +8.1 万升，买前要 `hjyt_fuel_plan` 复核
- HUD 还是浮窗不是侧栏常驻；快照只滚动 5 份不按天留存；不支持多存档并行对比
- `test/` 下的 `probe_three.mjs` / `probe_three_health.mjs` 是一次性排查探针，不属于回归测试
- `test/_tmp_dev.mjs` 是早期一次性脚本（功能已被 `hjyt_route_dev` 取代），不属于回归测试
- 同一宿主里若插件被加载两次，第二个实例绑 `127.0.0.1:9778` 会 `EADDRINUSE`（已优雅降级：只记 `http-self-fail`，web 路由照常）

---

## 14. 变更记录

| 版本 | 要点 |
|---|---|
| **v0.7.3** | 全量自检后的收口：`package.json` / HUD 版本指纹从 `0.4.0` 对齐到语义版本 `0.7.3`；`plugin_log.jsonl` 加自动裁剪（>1.5 MB 只留最近 400 行）；README 重写为 14 章 |
| **v0.7.2** | 全队游戏内校验按 8 架一批（桥 `eval` 100ms 上限），某批超时对半再切；读不到的架标 `unread` 不冒充硬错误 |
| **v0.7.1** | 工具注册改由 `lib/schema.js` 自己编译 raw JSON Schema，不再依赖宿主 `defineTool`；修 `hjyt_route_deploy` 的 `cabin`/`fare` 缺 `additionalProperties` |
| **v0.7** | 三个排班入口写盘后自动跑引擎 `validateFullSchedule`；新增只读工具 `hjyt_sched_verify` |
| **v0.6** | HUD「油库」→「开线」：航线开发（模糊搜机场 / 能养几架）+ 选中一条「一键部署」（两次点击） |
| **v0.5** | 报告口径对齐（油库 / 票价 / 闸门 / 排班 / 配舱 / 间距 / 五项校验）；HUD 加「前日利润」、一次买多架 |
| **v0.4** | `hjyt_fuel_plan` / `hjyt_fuel_apply`（油库）+ `hjyt_expand_plan`（扩张流水线） |
| **v0.3** | `hjyt_buy_plan` / `hjyt_route_plan` / `hjyt_sched_health` / `hjyt_board` 四个向导 |
| **v0.2** | 传输层通用化（CDP / 桥 / 纯页面模式）、快照与回滚、HUD 版本指纹自愈 |
