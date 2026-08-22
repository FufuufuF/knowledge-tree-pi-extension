# Byte Mentor 设计走读笔记

> 本文档记录对现有实现（`pi-mvp-design.md` / `memory-requirements.md` 的落地代码）逐步走读后确认的共识、发现的偏差和待决事项。不是原始设计文档的替代品——原始文档描述"意图"，本文档描述"走读后我们认可/想改的东西"。
>
> **状态**：走读已完成，最终设计决策已定（§2），待实现项见 §4。

## 1. 总体架构（已确认）

三层 Agent 接力，写入权限逐层收窄：

| 角色 | 形态 | 产出 | 写权限 |
|---|---|---|---|
| Planner | 隔离 AgentSession | TeachingPlan | 无（只读） |
| Actor | 主会话（导师人格） | 教学 + Markdown plan（事实层） | 仅 checkpoint_start/finish + plan 文件 |
| Memory Agent | 隔离 AgentSession | EvidenceProposal + NotePatch | 无（只填 sink） |
| Memory Committer | 纯代码 | 节点对齐 + 证据落库 + 状态归约 | SQLite 唯一事务写入方 |
| Note Patch Applier | 纯代码 | 受控区块 upsert | Markdown 唯一写入方 |

核心原则：**LLM 只做判断和提案，一切持久化由确定性代码完成**。可审计性由此而来（§2.5）。

## 2. 最终设计决策

### 2.1 Plan 双轨：SQLite 存引用，Markdown 供 Actor 消费

- Planner 产出 plan 后**写 Markdown 到工作区**（Actor 的主消费物），SQLite `teaching_plans` 只存引用 `(path, content_hash, lesson_run_id)`。
- **Actor 可自由读写 Markdown plan**，记录教学事实层（教了什么、用户答错什么、暴露什么误解）。它是 Actor 的 todo list 和过程记录。
- **Memory Agent 消费 plan 快照（checkpoint_finish 时的原文，§2.4）**，不读当前文件——不受 Actor 之后修改影响。
- **信任边界**：Actor 的 plan 内容分两类——事实层（教了什么、发生了什么）可信度高；评估层（"g1 已达成"）**不可信**。Memory Agent 以 plan 为线索，以 transcript 对照校验；最终判定仍走 Committer 证据归约，Actor 自评永不直接进知识树。

### 2.2 Checkpoint 双调用：checkpoint_start / checkpoint_finish

- **`checkpoint_start`**（模块开始时调用）：抓 `fromEntryId`（当前 leaf），INSERT 一条 checkpoint 记录（`toEntryId = NULL, status = 'started'`）。幂等键 = `stableKey(sessionId, lessonRunId, moduleId)`，UNIQUE(lesson_run_id, module_id)。moduleId 由代码派生（run 内模块序号 hash）或 Actor 输入，**不随执行漂移**。
- **`checkpoint_finish`**（模块结束时调用）：抓 `toEntryId`，UPDATE 同一条记录（`toEntryId, plan_snapshot, status → 'ready'`），天然幂等（引用闭合，非新键）。
- 范围 = [fromEntryId, toEntryId]，覆盖**完整模块生命周期**（修复现状"单次调用 + 隐式游标"范围不完整的缺陷）。
- 触发 Memory Agent 在 finish 之后进行。

### 2.3 会话约束：同一会话同时只允许一个 learn

- `/learn` 时已有 active run → 拒绝（先 `/learn stop` 才能开新的）。不允许"停旧建新"。
- 效果：遗留 started job 问题消失——run 不切换，started job 永远有主人，Actor 从上下文 + plan 感知未闭合模块并继续 finish。

### 2.4 Plan 快照：checkpoint_finish 时存原文

- finish 时把 plan 文件**全文**存入 checkpoint 记录（新字段 `plan_snapshot`）。
- 意义：锁定"教学时刻的计划态"，Memory Agent 读取零依赖、不受 Actor 后续修改影响。

### 2.5 幂等键设计总表

原则：① 幂等键 = 输入参数或确定性派生值，**绝不用执行时抓的游标**；② 事务原子性把幂等粒度从"操作级"抬升到"checkpoint 级"——能靠事务解决的就不需要复杂键。

| 操作 | 幂等键 | 粒度 | 原理 |
|---|---|---|---|
| Plan 写入 | `stableKey(sessionId, lessonRunId)` | 每 run | 一个 run 一份 |
| checkpoint_start | `stableKey(sessionId, lessonRunId, moduleId)` | 每模块 | 输入参数，不漂移 |
| checkpoint_finish | 无新键（UPDATE 同行） | — | 引用闭合天然幂等 |
| 知识树批提交 | `checkpointId`（commit_results 主键） | 每 checkpoint | 事务原子，无部分成功 |
| 证据行 | `observationId = stableKey(checkpointId, goalRef, source, ordinal)` | 每行 | 双保险 |
| 笔记写 | `(checkpointId, noteId)` | 每笔记 | 逐文件原子 + 重试 |

### 2.6 完整流程（一轮模块教学）

```
阶段0 /learn <目标>
  拒绝已有 active run → 创建 LessonRun（落库）→ 跑 Planner
阶段1 Planner
  只读渐进检索（listChildren 主干 + search fallback）→ 产出 plan
  → 写 Markdown + SQLite 存引用（幂等键 stableKey(sessionId, lessonRunId)）
  → plan 路径注入 Actor system prompt（before_agent_start）
阶段2 Actor 教学（多轮）
  每轮 before_agent_start 追加 plan 路径 + 极简摘要（systemPrompt 字段，追加语义）
  Actor 自由读写 Markdown plan（事实层）
阶段3 checkpoint_start（模块开始）
  抓 fromEntryId → INSERT（status='started', toEntryId=NULL）
  幂等键 stableKey(sessionId, lessonRunId, moduleId)
阶段4 高强度教学
  多轮对话，Actor 在 plan 上记录事实
阶段5 checkpoint_finish（模块结束）
  抓 toEntryId → 解析 plan 文件全文 → UPDATE（toEntryId, plan_snapshot, status='ready'）
  天然幂等（UPDATE 同行）
阶段6 Memory Agent 提案
  读 transcript（from→to）+ plan 快照（事实层线索）
  只读渐进检索知识树 → 产出完整 EvidenceProposal（打包）
  读是渐进的，写是一次性打包
阶段7 Committer 单事务落库
  BEGIN IMMEDIATE
    对齐每个 item → 幂等追加 evidence → 全量证据归约 state
    → 存 artifact + note_update_requests + commit_result → 推进 job
  COMMIT
  幂等键 checkpointId（commit_results 主键）
阶段8 笔记写
  Memory Agent 产出 NotePatch（基于最终 state）
  逐文件原子写（tmp + rename）+ note_patch_jobs 记录
  幂等键 (checkpointId, noteId)
阶段9 收尾与恢复
  job → completed
  session_start：恢复 active run + plan 引用；started job 不处理（等 finish）
  ready job（toEntryId 非空）重跑，幂等键挡重复
```

### 2.7 进行中模块的语义（阶段 9 澄清）

- started job（toEntryId=NULL）是**正常中间态**，不需要特殊处理——它就躺在 SQLite 里等 finish。
- 崩溃/关闭后重开：同一个 run 还 active、plan 还在，Actor 从上下文 + plan 感知未闭合模块，继续教，教完 finish。
- drainRunnableCheckpoints 只处理 toEntryId 非空的 ready job；started job 本来就不该被处理（范围不完整）。

### 2.8 审计与恢复边界

- 知识状态链：transcript → evidence（append-only）→ state（含 evidence_ids + version）→ commit_results / artifacts → needs_review 挂起。可审计，但**防篡改 ≠ 可审计**（无签名/哈希链，有 DB 写权限者可改）。
- plan 变更历史靠工作区 git（如果有）；系统不维护 plan 的确定性变更日志。
- 笔记：note_patch_jobs outbox（完整 patch JSON 先落库再写盘）+ 受控 marker 区块 + 哈希冲突检测。
- state 是原地 upsert，历史状态靠证据重放推导（无重放工具）。

## 3. 已盘清的现状机制（保留参考）

- **Planner 检索**：用户目标原样进 prompt，LLM 自主拆解成工具调用；SQL 侧只有点查/子层查询/LIKE 子串匹配，无向量检索。树因懒生长天然很小，逐层浏览代价低。
- **Committer 职责**：归属校验（goalRef ∈ job.goalRefs）→ 节点对齐（exact → 归一化 → 歧义 needs_review → 懒创建）→ 单事务落库 → 推进状态机。Agent 的 proposedMastery 被丢弃，state 由纯函数从全量证据重算。
- **plan 注入**：现状用 before_agent_start 返回 message（customType，display:false）——不落库、不堆积（每次 run 重建 messages）。**已查证** pi 的 emitBeforeAgentStart 支持 systemPrompt 字段（替换语义，event.systemPrompt 携带当前值），context hook 只支持 messages 不支持 systemPrompt。
- **checkpoint 现状**：单次调用 + 隐式游标，fromEntryId=调用瞬间叶子，toEntryId=run 结束固化。范围不含模块开始前教学（缺陷，已由 §2.2 修复）。
- **Session 恢复现状**：session_start 恢复 active run + plan，drainRunnableCheckpoints 重跑非终态 job。
- **原子写现状**：NotePatchApplier.atomicWrite = tmp + rename，POSIX 原子。逐文件原子 + 幂等键重试覆盖跨文件一致性，不需要 .bak 批次。

## 4. 待办 / 待决

- [ ] **修 planner prompt 定序**：流程改为硬步骤——① `listChildren()` 读根层判断归属 → ② 逐层下钻 → ③ 仅不确定归属时才用 `catalog_search` 全局跳转 → ④ 确认不存在标 `unknown`，不得臆断。
- [ ] （可选）`listChildren` 返回附带每个子节点的 `childCount`，让模型判断哪支值得下钻。
- [ ] （待讨论）冷启动阶段 Planner 检索必然空转，是否需要在 prompt 中明示"树为空时直接产出全 unknown 的初始 plan"，减少无意义的重试。
- [ ] （待讨论）state 历史快照/证据重放工具：目前验证历史状态需手工按 `state-reducer.ts` 重算。
- [ ] **plan 注入改为 systemPrompt**：before_agent_start 返回 `{ systemPrompt: event.systemPrompt + plan 摘要 }`（追加，不替换）；`context` hook 保留 pendingText 的 messages 注入，删除 plan 重复注入（system prompt 不受压缩影响）。
- [ ] **实现 §2 的最终设计**：双调用 checkpoint（start/finish）、plan 双轨 + 快照、单 learn 约束、幂等键总表落地。

## 5. 走读进度

- [x] 总体架构与写入权限
- [x] Planner：检索机制与渐进加载
- [x] Committer：输入、校验、落库
- [x] 可审计性机制与边界
- [x] Plan → Actor 交接（hooks 注入 + tool_call 前置校验）
- [x] Checkpoint 捕获机制（现状 + 缺陷识别）
- [x] 幂等键设计（plan / checkpoint / 知识树 / 笔记）
- [x] 恢复与状态机（含进行中模块语义、单 learn 约束）
- [x] Memory Agent 工作细节（提案打包、事务落库）
- [x] 笔记更新流程细节（逐文件原子写、幂等重试）
