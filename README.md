# 聚集性胃肠事件清消

本项目提供聚集性胃肠事件处置的服务端能力。假期高峰时，电话、门店工单与物业记录会同时涌入区域值班台；服务按共同就餐、发生时段与场所分区把多来源线索聚合为事件（各自来源保留），再依据已登记的清消规则安排污染物清理、防护用品、方案步骤与作用时长，并以复开检查、复查与逾期升级、食品处理人员返岗评估管控分区的关闭与复开。

## 能力边界

- 不作医学诊断：线索仅记录症状观察，携带诊断字段或请求诊断动作都会被拒绝。
- 酒精擦拭不被认作满足诺如病毒清消要求；是否合规按规则登记的消毒剂与作用时长评估。
- 事实冲突未解决、关键步骤跳过、作用时间不足或方案依据的规则版本过期时，相关分区保持关闭。
- 食品处理人员返岗须由独立于门店经理的合格角色（食品安全员、公卫医师、职业健康医师）决定。
- 值班人员推进模拟时钟观察复查与逾期升级；时钟与全部计时依据持久化于存储，重启服务不会重置。

## 目录

- `src/clock.js` 真实时钟与可持久化的模拟时钟。
- `src/store.js` 进程内集合存储，支持快照与恢复。
- `src/domain.js` 纯领域规则：线索聚合匹配、方案差距评估、返岗评估。
- `src/rules.js` 诺如病毒清消规则样例。
- `src/service.js` 应用服务：登记、聚合、处置、复开、返岗、时钟推进与查询。
- `src/api.js` 进程内 JSON 请求分发。
- `src/cli.js` 标准输入入口。
- `test/` 覆盖聚合、清消复开、时钟升级、返岗与接口行为。

## 请求动作

`health`、`register`、`find`（基础登记）；
`registerVenue`、`registerRule`、`registerMealBatch`、`verifyMealBatch`（登记与批次核查）；
`reportClue`、`getIncident`、`flagConflict`、`resolveConflict`（线索聚合与事实冲突）；
`startCleanup`、`recordStep`、`recordRecheck`、`inspectZone`（清消处置与复开检查）；
`flagFoodHandler`、`decideReturnToWork`（返岗管控）；
`advanceClock`、`listEscalations`（模拟时钟与逾期升级）；
`zoneStatus`（分区视图：关闭或复开理由、尚待核查的就餐批次、当时适用的处置规则）。

## 运行

运行测试：`npm test`

检查构建：`npm run build`

本地冒烟：`printf '%s' '{"action":"health"}' | npm run cli --silent`

项目只使用 Node.js 内置能力，运行期间不连接其他服务。
