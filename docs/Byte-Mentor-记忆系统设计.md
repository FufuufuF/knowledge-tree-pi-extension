# Byte Mentor 记忆系统设计文档

> 用途：设计审阅稿。覆盖 Planner / Actor / Memory Agent 的写入职责、数据库表设计、幂等与可恢复性设计。
> 目标：跨会话持续演进的个性化学习闭环——"历史误解召回 → 针对性教学 → 即时验证 → 延迟复测 → 状态更新"。

---

## 0. 设计目标与不变量

**三个不变量（任何简化/改动不得破坏）：**

| 不变量 | 含义 | 违背后果 |
|---|---|---|
| **不丢** | 教学事件要么完整落库，要么完全不落库；不存在"进度记了但记忆没更新"的半程状态 | 静默数据丢失，无重试可救 |
| **不重** | 同一教学事件被重放/重试多次，效果等于一次 | 证据重复计数，状态被错误推高 |
| **可查** | 状态、时间类查询是 SQL 查询，不是文本解析 | 延迟复测、计划对账退化为脆弱代码 |

**两条核心原则：**

1. **LLM 提议，程序裁决**：LLM 负责从教学上下文提取"证据提议"，确定性 Committer 负责状态变更。LLM 永远不能越过程序边界直接改写正式记忆。
2. **幂等锚必须来自重试无法改变的地方**：执行期生成的身份（LLM 现场编的 ID）会在崩溃重试时丢失/变化；持久化的身份（工具生成的 episode_id）才能当锚。

**设计哲学备注**：LLM 的非确定性不需要被消灭，而是被"提交语义"包住——只要提交是全有或全无的，重放只会发生在"什么都没落库"之后，此时 LLM 重新解释的结果即使不同也毫无危害。

---

## 1. 总体架构与数据流

```
┌──────────┐   教学计划    ┌──────────┐   教学表现    ┌─────────────────────┐
│ Planner  │ ───────────▶ │  Actor   │ ───────────▶ │  Memory Agent +      │
│ (规划)    │   plan(DB+md) │ (教学)    │  episode     │  Committer (消费)    │
└──────────┘              └──────────┘  finish      └─────────────────────┘
     │                         │    ▲                     │
     │                         │    └─ 读取 plan 当 todo  │
     │                         │                          │
     │                         └── episode_start ──▶ episode 表 (status=started)
     │                                                  │
     └── 查询 active plan（幂等）                        ▼
                                            episode 表 (status=finished)
                                                  │
                                        原子认领 + LLM 解释 + 单事务提交
                                                  │
                                    ┌─────────────┼─────────────┐
                                    ▼             ▼             ▼
                               evidence 表   knowledge_state 投影   episode (done)
```

**组件职责与写权限矩阵（谁写什么）：**

| 组件 | 可以写 | 不可以写 | 备注 |
|---|---|---|---|
| **Planner** | plan 表（创建/完成）；plan markdown（生成） | 一切记忆数据 | 幂等：先查 session 的 active plan |
| **Actor** | episode 表（start / finish）；plan markdown（勾选 todo） | evidence、knowledge_state —— **不感知知识树** | 与记忆系统单向解耦，只输出"表现" |
| **Memory Agent**（LLM 部分） | 无（只产出"解释结果"） | — | 将表现 payload 解释为 node_key + evidence 提议 |
| **Committer**（确定性部分） | evidence、knowledge_state、episode 状态机 | — | 唯一允许写正式记忆的组件 |

**关键解耦**：Actor 不感知 knowledgeState——它只负责教学和汇报表现；"表现 → 知识点映射"由 Memory Agent 在消费时完成（LLM 参与消费是架构的固有属性）。

---

## 2. 组件详述

### 2.1 Planner

- 输入：学习目标；渐进检索知识树 + 历史证据。
- 输出：
  - **计算层**：plan 表一行（session_id, status='active'）——只存状态机需要的字段。
  - **人读层**：plan markdown（固定模板，含模块列表，每个模块带稳定 `module_ref` 标签）——Actor 的 todo list。
- **幂等**：创建前查 `plan WHERE session_id=? AND status='active'`，存在则复用，不重复创建。
- 完成：全部模块勾选后（或显式结束），status → 'completed'。

### 2.2 Actor

- 读取 plan markdown 作为 todo list，自由教学（**可漂移到计划之外**）。
- 工具一：`episode_start(ref, topic)` → 返回 `episode_id`（工具生成 UUID）。
  - 计划内教学：`ref = module_ref`；漂移教学：`ref = null`。
  - 计划内模块防重复 start（唯一约束）；漂移内容每次 start 即新 episode。
  - **可选增强**：start 时记录"教学前快照"（用户在该主题的既有状态/自评），供消费端区分"教学前已具备"与"教学后学习结果"。
- 工具二：`episode_finish(episode_id, payload)` → 写入用户表现的结构化描述。
  - payload 不包含任何节点 ID——定位由 Memory Agent 消费时完成。
  - 同一条 UPDATE 同时完成"标记完成 + 写入消息内容"（原子性靠同一行）。
- Actor 全程不感知知识树，也不直接写任何记忆。

### 2.3 Memory Agent + Committer（消费端）

消费流程（每个 finished episode）：

```
① 原子认领:
   UPDATE episode SET status='processing'
   WHERE episode_id=? AND status='finished'
   -- 影响 0 行 → 已被他人认领，跳过

② 解释（LLM，事务外）:
   读 payload（必要时拉取教学上下文）
   → 产出 node_key 列表 + 每条证据的 evidence_type + 内容

③ 单事务提交（Committer，全部原子）:
   BEGIN
     INSERT INTO evidence ... ON CONFLICT DO NOTHING
     重算涉及节点的 knowledge_state（投影 = 证据集的纯函数）
     UPDATE episode SET status='done' WHERE episode_id=? AND status='processing'
   COMMIT
```

失败处理：解释失败或提交异常 → retry_count++，保留 processing；超限 → status='dead'（毒消息隔离，不阻塞队列）。

---

## 3. 数据库表设计（SQLite）

### 3.1 plan —— 教学计划（计算层）

```sql
CREATE TABLE plan (
  plan_id      TEXT PRIMARY KEY,            -- UUID
  session_id   TEXT NOT NULL,               -- 会话标识
  status       TEXT NOT NULL DEFAULT 'active',  -- active | completed
  created_at   INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX idx_plan_session ON plan(session_id, status);
```

### 3.2 episode —— 教学片段（合并 checkpoint + outbox 职责）

一张表承载两个串行生命周期：**教学阶段**（started → finished）与**消费阶段**（processing → done）。

```sql
CREATE TABLE episode (
  episode_id   TEXT PRIMARY KEY,            -- 工具生成 UUID（执行身份，幂等锚）
  plan_id      TEXT REFERENCES plan(plan_id),  -- 可空：漂移内容
  module_ref   TEXT,                        -- 计划模块标签，可空
  status       TEXT NOT NULL,               -- started | finished | processing | done | dead
  payload      TEXT,                        -- finish 时写入：用户表现结构化描述
  retry_count  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,            -- = episode_start 时间
  finished_at  INTEGER,                     -- = episode_finish 时间（延迟复测查询锚点）
  processed_at INTEGER,
  UNIQUE (plan_id, module_ref)              -- 计划内模块防重复 start（NULL 不参与唯一性）
);
CREATE INDEX idx_episode_status ON episode(status, finished_at);
```

**合并理由**：checkpoint 的生命周期和 outbox 的生命周期是同一个状态机的两个阶段，串起来就是一条线。合并后 `episode_finish` 的"标记完成 + 写入 payload"是**同一行的单条 UPDATE**——原子性由结构保证，而非事务。代价约束：**一个 episode 对应一条消息**（payload 内可含多个知识点的更新，消费端一个事务处理全部）。

### 3.3 evidence —— 证据日志（事件日志）

```sql
CREATE TABLE evidence (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  node_key      TEXT NOT NULL,              -- 知识点键（消费时由 Memory Agent 解析）
  evidence_type TEXT NOT NULL,              -- taught | practiced | verified | retested | retested_failed
  source_id     TEXT NOT NULL,              -- = episode_id（稳定幂等锚）
  payload       TEXT NOT NULL,              -- 证据内容（结构化）
  created_at    INTEGER NOT NULL,
  UNIQUE (node_key, evidence_type, source_id)   -- ← 幂等键，重放安全的核心
);
CREATE INDEX idx_evidence_node ON evidence(node_key);
```

### 3.4 knowledge_state —— 掌握度投影（缓存，可重建）

```sql
CREATE TABLE knowledge_state (
  node_key      TEXT PRIMARY KEY,
  state         TEXT NOT NULL,              -- unknown | partial | unstable | stable
  misconception TEXT,                       -- 个人误解记录
  updated_at    INTEGER NOT NULL
);
```

**投影语义**：knowledge_state 不是被"更新"的，而是从 evidence 集**重算**出来的（`state = fold(evidence_set, rules)`）。删掉整张表可从 evidence 全量重建——它是缓存，不是真相。

### 3.5 表关系

```
plan 1 ──── N episode 1 ──── N evidence N ──── 1 knowledge_state
（计划）      （教学片段=消息）   （事件日志）       （投影，按 node_key 聚合）
```

---

## 4. 知识掌握度状态机

**证据类型**：`taught`（教学发生）/ `practiced`（用户练习）/ `verified`（即时验证通过）/ `retested`（延迟复测通过）/ `retested_failed`（延迟复测失败）

**迁移规则（保守提升，激进降级）：**

```
提升（需要多条独立证据）:
  unknown → partial : 同一教学闭环内 taught(≥1) + verified(≥1)
  partial → unstable: 来自【不同 episode】的独立应用证据 ≥1（practiced / verified）
  unstable → stable : 延迟复测通过（retested，跨会话，间隔 ≥ 阈值）

降级（单条失败证据即触发）:
  stable → unstable / unstable → partial : retested_failed

误解（misconception）:
  证据显示错误理解并被纠正 → 记录
  带误解的节点不得直接升级；纠正后必须"再验证通过"才允许进入 partial
```

**两个关键性质：**

1. **不对称性**：提升要凑证据，降级一次就够——防止"运气好答对一次"污染状态，同时及时反映遗忘。
2. **顺序无关性**：规则只依赖证据的**计数和时间戳**，不依赖处理顺序 → 消费顺序无所谓、重放安全、并发无需按节点加锁。

**延迟复测触发**：`SELECT node_key FROM knowledge_state WHERE state IN ('unstable','stable') AND updated_at < now()-阈值`，配合 `episode WHERE status='finished' AND finished_at < now()-阈值` —— 由 SQL 查询驱动，不开新机制。

---

## 5. 幂等与可恢复性设计

### 5.1 幂等锚原则

> 幂等锚必须来自**重试无法改变的地方**。

| 写入点 | 幂等锚 | 来源 |
|---|---|---|
| Planner 建 plan | session_id + status | 会话（持久） |
| episode_start（计划内） | 唯一约束 (plan_id, module_ref) | 计划（持久） |
| episode_start（漂移） | 无——孤儿 start 无害（见下） | — |
| episode_finish | episode_id + 条件 status | 工具生成的执行身份（持久） |
| 消费重放 | evidence 唯一约束 | episode_id（持久） |

**为什么执行身份够用**：证据只在 finish 写入，**孤儿 start 无害**——start 重复最多产生无人认领的 `started` 行（sweep 清理），不产生任何证据。身份稳定性只要求"一次教学片段的生命周期内稳定"：Actor 通过持久化的对话历史（transcript）复用 start 返回的 episode_id。

### 5.2 各写入点的幂等实现

| 操作 | SQL / 机制 | 重复调用效果 |
|---|---|---|
| 创建 plan | 先查 active，存在即复用 | 不重复创建 |
| episode_start（计划内） | `INSERT ... ON CONFLICT (plan_id, module_ref) DO NOTHING` | 返回已有 episode_id |
| episode_start（漂移） | 每次新 episode | 旧行孤儿化，无害 |
| episode_finish | `UPDATE ... SET status='finished', payload=? WHERE episode_id=? AND status='started'` | 0 行，no-op（或返回已 finished） |
| 消费认领 | `UPDATE ... SET status='processing' WHERE episode_id=? AND status='finished'` | 0 行，跳过 |
| 消费提交 | 单事务：evidence 冲突跳过 + 投影重算 + status='done' | 重放安全（见 5.3） |

**失败要响亮，不要静默**：finish 引用不存在的 episode_id → 影响 0 行 → 工具显式报错（"episode 不存在或已完成"），Actor 从历史对账。

### 5.3 崩溃场景推演

| 场景 | 落库状态 | 恢复机制 | 结果 |
|---|---|---|---|
| finish 后、认领前崩溃 | `finished` | 正常认领 | 无损失 |
| 认领后、消费事务提交前崩溃 | `processing` | sweep 超时重置为 `finished` → 重放 | **无害**：上次什么都没落库，LLM 重新解释即可 |
| 消费事务提交后崩溃 | `done` | 不再认领 | 无影响 |
| episode_finish 调用两次 | 条件更新 0 行 | — | 幂等 |
| episode_start 重试（计划内） | 唯一约束 | 返回已有行 | 幂等 |
| episode_start 重试（漂移） | 新 episode | 旧行孤儿化，sweep 清理超时 `started` | 无证据，无害 |
| 消费逻辑异常（毒消息） | `processing` + retry_count | 超限 → `dead` 标记 | 不阻塞队列 |

**sweep 职责**：① `processing` 超时 → 重置 `finished`；② `started` 超时 → 孤儿清理；③ `dead` 告警。

### 5.4 原子性边界

- **单库事务**：消费提交（evidence + 投影 + done）在一个 SQLite 事务内，全有或全无。
- **同行动态**：episode_finish 的"业务状态 + 消息 payload"是同一行的单条 UPDATE——这是 outbox 模式"业务写入与消息写入同事务"铁律的最强形式（同一行，连事务都不需要）。
- **跨系统（未来迁移 Kafka）**：跨系统原子性不存在。分层保证"有效一次"：业务写 + outbox 同事务（不丢）→ CDC relay 至少一次投递 → Kafka 至少一次投递 → **幂等消费（证据唯一约束）把重复收敛掉**。幂等建在 schema 层而非机制层，迁移只删认领代码，幂等设计原封不动。

---

## 6. 设计边界与待确认问题（审阅重点）

1. **plan markdown 与 plan 表的一致性**：Actor 自由勾选 markdown 时，表里的状态如何对账？已讨论两种方案——(a) markdown 是 DB 的物化视图（Actor 写 DB，文件重新渲染，一致性最强，但 Actor 不能"自由操作文件"）；(b) 文件为准、episode.module_ref 定期对账（Actor 自由，但需解析文本）。**当前设计倾向 (b)，需确认对账机制细节。**
2. **episode 粒度**：Actor 自由决定 start/finish 时机（计划内=模块，漂移=片段）。太粗（整节课一个 episode）会稀释证据独立性；太细（每轮对话）会增加工具调用开销。需确认粒度约定。
3. **payload 结构**：尚未定稿的字段——教学前快照如何记录、表现描述的结构化程度（影响 Memory Agent 解释的稳定性）、是否需要"用户自述"与"客观表现"分字段（前者不可信，后者可驱动状态）。
4. **node_key 解析失败**：Memory Agent 把表现解释为 node_key 时，若解析到不存在的知识点——懒创建策略（直接建节点）还是挂起待人工确认？（倾向：懒创建，因为树是教学过程的投影）
5. **单消费者假设**：认领机制防并发，但当前设计假设只有一个消费进程。多进程部署时认领仍成立（条件更新是原子的），sweep 需加分布式锁或容忍竞态。
6. **状态机阈值**："独立应用证据 ≥1""复测间隔阈值"等具体数值未定，需用真实教学数据校准。
7. **死信人工介入**：`dead` 状态的消息如何恢复（重放按钮？人工修正 payload？）。

---

## 7. 与简历叙事的对应

| 简历表述 | 设计落点 |
|---|---|
| 懒创建 KnowledgeTree | node_key 首次出现时创建节点（5.1 / 待确认 4） |
| 区分教学前已具备的知识与教学后学习结果 | episode_start 教学前快照 + finish payload 对照（2.2） |
| 确定性 Memory Committer | 单事务提交 + 投影重算 + 幂等键（2.3 / 5） |
| 证据幂等追加 | evidence 唯一约束 (node_key, evidence_type, source_id)（3.3） |
| 保守状态归约 | 提升凑证据、降级一次就够（第 4 节） |
| 跨会话闭环 | 延迟复测由 SQL 驱动新一轮 episode（第 4 节） |
| 双层记忆（AI 状态 + 用户 Markdown） | 表 = 计算层；notes/plan markdown = 人读投影（第 1 节） |
