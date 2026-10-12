# 008 NPC 委托领域层（Quest Domain）

> 项目代号：`fanchen-quest-domain`
> 交付物：`src/lib/quest/` —— NPC 背包、道具与珍贵等级、奖励系统、目标原语、涌现式任务与裁决层。
> 配套验证：`tests/quest.domain.test.ts`、`tests/quest.adjudicate.test.ts`、`scripts/quest-smoke.ts`
> 关联需求：[FR-015 ~ FR-020](./002-requirements.md)、[NFR-009 ~ NFR-010](./002-requirements.md)
> 关联决策：[ADR-010 ~ ADR-012](./007-decisions.md)

## 1. 为什么先做这一层，而不是先做对话

交接文档 §7 的原话：**这一层对了，接 LLM 只是把它变成一个更灵活的输入方式；
这一层错了，接上 LLM 只会让 bug 变得更难复现。**

所以本层刻意不依赖任何模型：入参全是普通对象，出参全是可以断言的结果，
用命令行就能把整条链路跑完（`pnpm run smoke:quest`）。

## 2. 语义：所求者是 NPC

| 角色 | 是谁 | 说明 |
| --- | --- | --- |
| 所求者（requester） | **NPC** | 任务内容里"想要东西"的一方，`Quest.requesterId` |
| 奖励出借方 | **NPC** | 奖励只能出自该 NPC 自己的背包或自身功能 |
| 接取方（taker） | 玩家 | `Quest.takerId` |
| 交付方 | 玩家 | 交付道具、达成目标 |

**与现有原型的关系**：`src/lib/{rules,extract,dedupe}.ts` 与 `src/state/store.tsx` 记录的是
**玩家**的需求（NPC 问玩家要什么），与本层语义正好相反。本轮不改动现有链路，
两条链路暂时并存；接入 UI 时再决定替换还是融合（见 §10）。

## 3. 三层分离在本层的落点

| 层 | 谁定 | 在本层的落点 |
| --- | --- | --- |
| 叙事层 | LLM 自由 | `Quest.title` / `Quest.want`：自由文本，代码**不校验内容、不干涉措辞** |
| 门控层 | 代码 | `tier`、`offerLevel`、NPC 库存、串行任务链 —— 全部为布尔/枚举判定 |
| 经济层 | 代码守恒 | 道具只在玩家与 NPC 之间转移；奖励必须先在 NPC 背包里预留 |

## 4. 数据模型

| 类型 | 关键字段 | 说明 |
| --- | --- | --- |
| `ItemDef` | `id / name / tier / value / kind / stackable / tags` | 道具白名单里的一条 |
| `ItemStack` | `itemId / count` | 一堆道具 |
| `Inventory` | `ownerId / stacks / holds` | 背包；`stacks` 可用，`holds` 已预留 |
| `Hold` | `id / questId / itemId / count` | 奖励预留锁 |
| `NpcState` | `id / name / title / generosity / inventory` | `generosity` 是本轮唯一启用的性格参数 |
| `PlayerState` | `inventory / affinity / abilities / knowledge / talks` | 玩家侧状态 |
| `Quest` | `id / requesterId / takerId / title / want / tier / objective / reward / offerLevel / rewardReservation / status / provenance / delivered / history` | 一条委托 |
| `QuestProvenance` | `npcId / sourceDialogueId / draftedBy / createdAt` | 涌现式任务的溯源，替代策划模板 ID |
| `World` | `player / npcs / quests / questOrder / events / processed / seq` | 可序列化纯数据，可整体克隆 |
| `QuestEvent` | `id / at / type / questId / npcId / detail` | 事件流水，回答"这条任务为什么存在" |

**不变式**：`拥有总量(item) = 可用 + 已预留`；玩家背包不出现预留；道具总量在世界内守恒。

## 5. 珍贵等级与奖励档位

### 5.1 五档珍贵等级

| 等级 | 中文 | 参考价值区间 |
| --- | --- | --- |
| `common` | 凡品 | 1 – 5 |
| `fine` | 良品 | 6 – 20 |
| `rare` | 上品 | 21 – 80 |
| `epic` | 珍品 | 81 – 300 |
| `legendary` | 绝品 | 301 – 1000 |

道具定价必须落在自己那一档的区间内 —— 否则"绝品标 1 文"，等级就成了纯装饰。
`auditItemTable()` 做数据自检，单测断言它恒为空。

### 5.2 三档奖励档位

| 档位 | 中文 | 道具价值上限 | 好感度上限 |
| --- | --- | --- | --- |
| 1 | 薄礼 | 20 | +3 |
| 2 | 中酬 | 80 | +6 |
| 3 | 重谢 | 300 | +10 |

档位上限 `maxOfferLevel({ questTier, generosity })`：
以任务重要性为基准（小事 1 / 正事 2 / 大事 3），`generosity ≥ 0.7` 抬一档、`< 0.3` 压一档，结果夹在 1–3。
**模型只能在档位内让步，不能自己加档** —— 自报 `offerLevel` 超过上限即拒绝。

### 5.3 三条硬约束

1. 奖励只能从白名单枚举里选，不能凭空生成道具 id；
2. 数值由代码按档位查表裁决，模型不得直接决定数值；
3. **发布任务时预留锁定奖励**（见 §8）。

## 6. 目标原语白名单

| 原语 | 含义 | 消耗道具 | 可用状态 |
| --- | --- | --- | --- |
| `deliver_item` | 把指定道具交给该 NPC | ✅ 扣除并转移 | `supported` |
| `has_item` | 只需持有（证明有） | ❌ | `supported` |
| `talk_count` | 与该 NPC 累计对话 N 轮 | ❌ | `supported` |
| `affinity_at_least` | 好感度达标 | ❌ | `supported` |
| `defeat` | 击败目标 | ❌ | `pending_dependency`（依赖战斗系统，拒绝登记） |

`deliver_item` 永远不能靠"读一眼背包"判定完成，它只能走提交流程（先扣道具再结算）。

## 7. 接口签名与校验规则表

### 7.1 裁决层接口（`adjudicate.ts`）

```ts
proposeQuest(world, { requestId, npcId, title, want, tier, objective, reward,
                      offerLevel?, sourceDialogueId?, draftedBy?, now? })  // 发布
acceptQuest(world,  { requestId, questId, now? })                          // 接取
submitQuest(world,  { requestId, questId, deliver?: ItemStack, now? })     // 提交并结算
declineQuest(world, { requestId, questId, reason?, now? })                 // 婉拒（释放预留）
cancelQuest(world,  { requestId, questId, reason?, now? })                 // 撤销（释放预留）
expireQuest(world,  { requestId, questId, reason?, now? })                 // 过期（释放预留）
```

返回：成功 `{ ok:true, world, quest, replay, applied[] }`；拒绝 `{ ok:false, world, code, message, quest }`。
`world` 是**新世界**（入参不被修改）；拒绝时 `world` 与入参是同一个引用。

### 7.2 拒绝码表（`QuestErrorCode`）

| 拒绝码 | 触发条件 |
| --- | --- |
| `invalid_field` | 标题/`want` 为空、缺 `requestId`、预留 id 不存在 |
| `unknown_npc` | NPC 不在世界里 |
| `unknown_item` | 目标或奖励引用了未登记的道具 |
| `unknown_ability` | 奖励引用了未登记的能力 |
| `invalid_tier` | 任务重要性不是 1 / 2 / 3 |
| `invalid_offer_level` | 档位不是 1 / 2 / 3 |
| `idempotency_key_reused` | 同一 `requestId` 换了参数复用 |
| `invalid_objective` | 目标形状不合法（数量非正整数、缺 targetId 等） |
| `unsupported_objective` | 原语依赖尚不存在的系统（`defeat`） |
| `invalid_reward` | 奖励形状不合法（数量非正、情报主题为空或过长） |
| `reward_not_owned` | NPC 背包里根本没有这件奖励道具 |
| `reward_over_cap` | 奖励超过档位上限；或自报档位超过代码上限；或能力奖励出现在非"大事"上 |
| `npc_reward_unavailable` | 该奖励已被其他任务预留，当前可用不足 |
| `npc_has_open_quest` | 该 NPC 已有未完结委托（串行任务链） |
| `self_loop_objective_reward` | 任务所要之物与奖励是同一件（自循环套利） |
| `quest_not_found` | 任务 id 不存在 |
| `quest_not_offered` | 只有"已发布"的委托能接取/婉拒 |
| `quest_not_accepted` | 只有"已接取"的委托能提交 |
| `quest_not_submittable` | 已结算的委托不能再提交；已结束的委托不能撤销 |
| `deliver_required` | 交付型目标没带 `deliver` |
| `deliver_forbidden` | 非交付型目标夹带了 `deliver` |
| `deliver_mismatch` | 提交的道具不是任务所要的那一种 |
| `deliver_count_too_low` | 提交数量少于任务要求 |
| `player_item_insufficient` | 玩家背包里这件道具不够 |
| `objective_not_met` | 非交付型目标尚未达成 |
| `insufficient_items` | 背包层通用库存不足（防御性兜底） |

**校验顺序**（固定，便于预期错误码）：先校验请求自身的合法性
（字段 → 目标 → 档位 → 奖励 → 自循环），再看世界状态（串行链 → 库存预留）。

## 8. 四条纪律

| 纪律 | 落点 | 验收方式 |
| --- | --- | --- |
| **幂等** | `World.processed[requestId]` 记录成功操作；重放返回原结果且世界不变 | 单测：同一 requestId 重放 `replay === true` 且 `world` 为同一引用 |
| **原子** | 操作在深拷贝的草案世界上进行；失败丢弃草案，返回入参世界 | 单测：失败的提交后 `JSON.stringify(world)` 与拒绝前逐字节一致 |
| **预留锁** | `holdItem` 把奖励从"可用"挪进"已预留"；婉拒/撤销/过期释放，结算核销 | 单测：预留后可用 −1、总量不变；婉拒后可用恢复 |
| **守恒** | 道具只在玩家与 NPC 之间转移 | 单测 / 冒烟：`worldTotalOf(item)` 结算前后相等 |

## 9. 状态机与串行任务链

```
offered ──accept──▶ accepted ──submit──▶ settled
   │                    │
   ├─decline──▶ declined └─cancel/expire──▶ cancelled / expired
   └─cancel/expire──▶ cancelled / expired
```

- 同一 NPC **一次性只挂一个未完结委托**（`offered` / `accepted`），了结后才触发下一个；
- 每次流转都写 `Quest.history`，每次裁决都写 `World.events`。

## 10. 本轮范围之外（明确不做）

- `honesty` / `openness` 性格参数、分阶段揭示门控（`computeRevealStage`）、`generated_lore` 固化；
- `debt_ledger`（狡诈 NPC 赖账转债）与 `bound` / `unbound` 承诺模式；
- LLM 侧工具（`propose_quest` / `submit_quest_item`）与 SSE 事件扩展、系统提示词改写；
- 任何 UI（NPC 面板、任务卡奖励展示、命令行之外的交互）；
- 持久化（世界已保证可序列化，但尚未接 localStorage / 服务端）；
- 战斗系统（`defeat` 原语已登记为 `pending_dependency`）。

## 11. 验证快照

| 项 | 结果 |
| --- | --- |
| `tsc --noEmit` | 零错误 |
| `tests/quest.domain.test.ts` | 28 / 28 |
| `tests/quest.adjudicate.test.ts` | 24 / 24 |
| 全仓库单测 | 92 / 92（原有 40 + 本轮 52） |
| `node scripts/quest-smoke.ts` | 通过（退出码 0，含 5 条拒绝路径与守恒核对） |

## 12. 工具通道与前端接入（T9 + T10）

**已完成（服务端）**

- `server/lib/quest-tools.mjs`：三个提案型工具的定义（`propose_quest` / `submit_quest` / `decline_quest`）
  与参数归一化。模型给的是扁平参数，这里收敛成领域层要的 `{ title, want, tier, objective, reward, offerLevel? }`。
- `server/index.mjs`：请求体带 `questTools: true` 时把这三个工具一并交给模型，并把工具调用映射成
  `quest_proposal` / `quest_submit` / `quest_decline` 三类 SSE 事件（非流式走 `questCalls` 数组）；
  归一化失败发 `notice`（`quest_call_rejected`）。不带该字段时行为与从前完全一致。
- 契约见 [004 §2.3](./004-api-contract.md)，决策见 [ADR-013](./007-decisions.md)。

**验证**：`tests/quest.tools.test.ts` 14 例通过；另做过一次进程内端到端验证
（模拟上游分三片吐 `tool_calls` + 真起后端，流式 / 未开启 / 非流式三条路径全通），验证脚本跑完即删。

**已完成（前端接入 · T10）**

- `src/lib/quest/prompt.ts`：`buildNpcSystemPrompt(world, npcId, lastRuling, customPersona)` ——
  只注入 NPC 自身视角（**不含玩家背包**，ADR-013），并把上一轮裁决当**事实**回注（AC-21.5）。
- `src/lib/quest/bridge.ts`：`applyQuestEvent` / `applyPlayerAccept` / `applyPlayerDecline` ——
  事件→裁决接线，产出 `QuestRuling` 事实（纯函数）。提案载荷**不含 `npcId`**：出面人由设置注入，模型说了不算。
- `src/lib/quest/persist.ts`：`normalizeStoredWorld` —— 存档容错，复用领域层 `holdItem` 重建预留锁。
- `src/components/QuestPanel.tsx`：委托区 UI（复用现有类名，未改 CSS）。
- `src/types.ts` / `storage.ts` / `settings.ts` / `api.ts` / `store.tsx` / `TaskPanel.tsx` /
  `SettingsDialog.tsx` / `labels.ts`：对话模式（`npc` 默认 / `desk` 原样）、出面 NPC、`questTools` 标志、
  三类事件消费、世界持久化、裁决留痕（拒绝绝不静默）、npc 模式跳过抽取通道。

**遗留 / 待办**

- `scripts/render-check.mjs` 在沙箱内跑不了（Vite 用 esbuild 打包配置需 spawn 子进程）：
  **需在正常终端复跑** `npm run check:render`，它是「一打开就白屏」的唯一自动防线。
- `store.tsx` 的 React 胶水（send 的事件分支与收尾）没有自动化测试：`node --test` 无法直接导入 `.tsx`，
  只能靠 typecheck 与 SSR 探针间接覆盖。
- `World.processed`（幂等记录）与 `World.events`（事件流水）目前**无上限**，会随会话累积进 localStorage。
