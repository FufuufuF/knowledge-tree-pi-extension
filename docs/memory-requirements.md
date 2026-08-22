# Byte Mentor 学习记忆架构设计

## 1. 文档状态

本文档记录当前已经确认的学习记忆架构，并替代此前以 `KnowledgeGraph`、`KnowledgeEdge` 和 `Graph Sync Plan` 为核心的设计。

当前结论是：

> Byte Mentor 不维护知识图谱。系统通过知识树定位知识单元，通过学习证据维护用户状态，通过 Planner 将长期记忆编译为本轮教学计划。

本文档只描述记忆和教学闭环，不展开 CLI、TUI、通用 Agent Runtime 或具体数据库选型。

## 2. 核心目标

Byte Mentor 的核心价值不是保存聊天记录，也不是生成一套完整的计算机知识百科，而是：

> 把用户在学习过程中的真实表现沉淀为可追溯的长期状态，并让这些状态改变后续教学行为。

系统需要回答：

- 用户接触、学习和练习过哪些知识点。
- 用户对哪些知识点掌握稳定、部分掌握或明显缺失。
- 用户暴露过哪些误解，以及这些误解是否已经被后续证据纠正。
- 下一次教学应该复习什么、跳过什么、诊断什么。
- 哪些内容应该整理为用户可读的复习笔记。

## 3. 明确不做的事情

MVP 不做以下能力：

- 不维护全局知识图谱。
- 不持久化 `prerequisite_of`、`mention_with`、`related_to` 等知识关系。
- 不预先生成完整学科目录。
- 不根据知识树中是否存在节点，直接判断用户是否掌握该知识。
- 不让教学 Agent 直接修改正式长期记忆。
- 不让 LLM 整篇覆盖用户可读 Markdown。
- 不要求 Markdown 维护 wikilink 或派生关系图。

知识之间的前置、类比和教学顺序由 Planner 根据当前学习目标临时判断，不作为长期事实维护。

## 4. 总体结构

```text
KnowledgeTree
  知识定位与语义边界
        │
        ├── UserKnowledgeState
        │     AI 消费的当前学习状态
        │
        ├── LearningEvidence
        │     支撑状态判断的不可变证据
        │
        └── UserReadableNote
              用户消费的 Markdown 笔记
```

教学闭环由五个组件完成：

```text
Planner
  -> TeachingPlan
  -> Actor
  -> Messages
  -> Observer
  -> MemoryUpdateProposal
  -> MemoryCommitter
  -> CommitResult
  -> NoteWriter
  -> Markdown Patch
```

职责原则：

- Planner 决定本轮应该如何教。
- Actor 负责实际教学。
- Observer 从用户表现中提出记忆更新建议。
- Memory Committer 校验、对齐并原子写入正式记忆。
- Note Writer 只根据已经提交的结果维护用户笔记。

## 5. 知识树

### 5.1 定位

知识树是面向教学记忆的目录，不是完整知识本体。

它只保存用户实际学习、测评或暴露误解时涉及的知识节点，并随用户学习过程懒创建。

```text
JavaScript
└── 异步编程
    ├── Event Loop 任务调度
    ├── 宏任务与微任务
    └── await 的暂停与恢复
```

### 5.2 节点结构

```ts
type KnowledgeNode = {
  id: string;
  parentId?: string;

  name: string;
  definition: string;
  learningGoals?: string[];

  assessable: boolean;

  createdAt: string;
  updatedAt: string;
};
```

字段约束：

- `id` 由程序生成并保持稳定。
- `parentId` 只表达规范目录位置，不表达教学依赖。
- `definition` 用于稳定知识边界和节点对齐，不保存完整讲义。
- `learningGoals` 描述该节点可以被教学或测评的目标。
- `assessable` 与是否拥有子节点无关。节点以后继续细分时，不需要迁移已有状态。

### 5.3 渐进式访问

Agent 不一次读取整棵树，只通过受限接口渐进浏览：

```ts
catalog.listChildren(parentId?: string)
catalog.search(query: string, parentId?: string)
catalog.getNode(nodeId: string)
```

Skill 负责描述定位和停止浏览的流程，Tool 负责实际数据访问。

MVP 优先使用：

- 路径和名称精确匹配。
- 规范化关键词匹配。
- 对少量候选进行 LLM 语义判断。

Embedding 检索不是 MVP 必需项。

### 5.4 节点创建规则

Planner 可以在本轮计划中自由提出候选知识点，但候选不会直接进入正式知识树。

只有满足以下条件的节点才允许创建：

- 用户实际展示了相关的既有知识。
- 本轮已经教学或测评了该知识。
- 用户在该知识上暴露了误解或缺失。

仅被 Planner 列为“未来可能需要”的知识点不创建。

创建前必须搜索已有节点并进行对齐。出现多个相似候选时，不静默创建新节点，而是保留待处理 proposal。

## 6. 用户知识状态

UserKnowledgeState 是 AI 消费的核心长期记忆，按 `(userId, knowledgeNodeId)` 唯一定位。

```ts
type UserKnowledgeState = {
  id: string;
  userId: string;
  knowledgeNodeId: string;

  exposure: "unseen" | "mentioned" | "studied" | "practiced";
  mastery: "unknown" | "missing" | "partial" | "unstable" | "stable";

  misconceptions: Array<{
    id: string;
    description: string;
    status: "active" | "resolved";
    evidenceIds: string[];
    updatedAt: string;
  }>;

  evidenceIds: string[];
  nextTeachingHint?: string;

  lastStudiedAt?: string;
  lastAssessedAt?: string;
  createdAt: string;
  updatedAt: string;
};
```

状态和知识节点必须分离：

- KnowledgeNode 描述“这个知识点是什么”。
- UserKnowledgeState 描述“某个用户目前对它怎么样”。

知识树中没有节点，只表示系统没有记录；不能据此判断用户不掌握。

## 7. 学习证据

LearningEvidence 是状态判断的事实来源，原则上只追加、不原地覆盖。

```ts
type LearningEvidence = {
  id: string;
  observationId: string;

  userId: string;
  knowledgeNodeId: string;
  sessionId: string;
  turnId: string;

  source:
    | "prior_knowledge"
    | "learning_outcome"
    | "self_report"
    | "delayed_recall";

  summary: string;
  result: "correct" | "partially_correct" | "incorrect" | "unclear";
  prompted: boolean;
  confidence: number;

  observedAt: string;
};
```

Evidence 与 State 的关系是：

```text
LearningEvidence = 历史事实
UserKnowledgeState = 当前投影
```

完整聊天记录继续由 Session 保存。Evidence 只保存支持状态判断的摘要和来源引用。

## 8. Planner

Planner 在学习目标清晰后执行一次前置规划。

它负责：

1. 判断学习目标包含哪些教学目标。
2. 推断可能需要的前置知识。
3. 渐进式搜索知识树中的对应节点。
4. 读取已有 UserKnowledgeState 和相关 Evidence。
5. 把外部记忆编译为本轮可执行的 TeachingPlan。

```ts
type TeachingPlan = {
  target: KnowledgeCandidate;

  prerequisites: Array<{
    candidate: KnowledgeCandidate;
    matchedNodeId?: string;
    importance: "required" | "helpful";
    userState: "known" | "weak" | "unknown";
    action: "use" | "diagnose" | "offer_remediation";
    reason: string;
  }>;

  teachingGoals: string[];
  approach: string;
  successCriteria: string[];
};
```

如果前置知识在树中不存在，Planner 必须标记为 `unknown`，不能标记为用户不会。

处理方式优先级：

1. 用一个低成本问题进行诊断。
2. 如果前置内容会显著扩大范围，再询问用户是否先补充学习。
3. 用户确认跳过时，在计划中明确风险，但不创建虚假状态。

Planner 的策略建议使用开放文本，Prompt 可以提供追问、预测、反例、类比等思考方式作为参考，但不把教学策略固定为 Tool 或封闭枚举。

## 9. Actor

Actor 是实际教学 Agent，由现有 Agent Runtime 承载。

它接收 TeachingPlan，但保留具体教学表达的自由，包括：

- 如何解释。
- 使用什么案例。
- 什么时候追问。
- 是否根据用户即时反应改变本轮展开方式。

Actor 可以读取记忆，但不能直接写入 KnowledgeNode、LearningEvidence 或 UserKnowledgeState。

## 10. Observer

Observer 观察教学过程并输出结构化 MemoryUpdateProposal。

它读取：

- 上次观察 checkpoint 之后的新消息。
- 当前 TeachingPlan。
- Actor 已执行过的教学动作及其 turn 边界。
- 当前涉及的候选知识单元。

Observer 不反复扫描完整会话，以降低成本并避免重复证据。

```ts
type MemoryUpdateProposal = {
  observationId: string;

  candidate: {
    name: string;
    definition: string;
    learningGoals?: string[];
    suggestedParentPath: string[];
  };

  source: "prior_knowledge" | "learning_outcome" | "self_report" | "delayed_recall";

  evidence: {
    sessionId: string;
    turnId: string;
    summary: string;
    result: "correct" | "partially_correct" | "incorrect" | "unclear";
    prompted: boolean;
  };

  proposedMastery: "unknown" | "missing" | "partial" | "unstable" | "stable";
  confidence: number;
  misconception?: string;
};
```

Observer 需要区分两类情况：

- `prior_knowledge`：用户在 Actor 教学前已经表现出的知识。
- `learning_outcome`：用户在本轮教学后表现出的学习结果。

用户自述“我会”只能产生 `self_report`，不能直接证明 `stable`。

## 11. Memory Committer

Memory Committer 是正式记忆的事务边界和防腐层，不负责理解原始对话。

### 11.1 节点对齐

对每个 candidate 执行：

```text
精确 ID / 路径 / 名称匹配
  -> 规范化文本候选检索
  -> 对少量候选做语义判断
  -> 复用已有节点、创建新节点或保留待确认 proposal
```

### 11.2 结构校验

创建节点前校验：

- ID 由程序生成。
- 父节点存在。
- 不产生目录循环。
- 名称、定义和节点边界完整。
- 同级不存在明确重复。
- 该知识点已经产生真实学习证据。

缺失的祖先 topic 可以在同一事务中补齐，但不能顺便创建未被教学的兄弟节点。

### 11.3 Evidence 幂等写入

`observationId` 必须唯一。Observer 重试时，Committer 返回原提交结果，不生成重复证据。

### 11.4 状态归约

Committer 不直接接受 Observer 提议的 `stable`，而是根据 Evidence 保守归约：

```text
仅自述掌握                    -> unknown / mentioned
教学前无提示答对一次          -> partial
教学后有提示答对              -> partial
多次独立答对                  -> unstable 或 stable
经过延迟复测仍能独立答对      -> stable
再次暴露相同误解              -> 降级并重新激活 misconception
```

掌握状态允许下降，以表达遗忘、误解复发或新证据推翻旧判断。

具体从 `partial`、`unstable` 到 `stable` 所需的证据数量，作为实现阶段的可配置策略，不写死在领域类型中。

### 11.5 原子写入

一次提交事务按以下顺序完成：

```text
创建或复用 KnowledgeNode
  -> 追加 LearningEvidence
  -> 归约 UserKnowledgeState
  -> 保存版本与审计信息
  -> 发布 NoteUpdateRequested
```

任一步失败时整批回滚。

```ts
type CommitResult = {
  resolvedNodeIds: string[];
  createdNodeIds: string[];
  evidenceIds: string[];
  changedStates: UserKnowledgeState[];
  dirtyNoteUnitIds: string[];
};
```

## 12. Note Writer

Note Writer 维护面向用户复习的 Markdown，不参与掌握状态判断。

### 12.1 文件粒度

一篇 Markdown 对应一个较大的 topic，可以覆盖多个 assessable 知识单元。知识单元与笔记文件的映射保存在 frontmatter：

```yaml
---
id: note-js-async
topicNodeId: js-async
knowledgeUnitIds:
  - js-event-loop
  - js-microtask
updatedAt: 2026-07-29
---
```

运行时从 frontmatter 派生：

```text
knowledgeUnitId -> Markdown 文件路径
```

KnowledgeNode 不再反向保存 `noteRef`，避免双写不一致。

### 12.2 更新方式

Note Writer 不整篇重写，也不无限追加会话日志，而是按知识单元维护稳定区块：

```markdown
<!-- byte-mentor:unit:js-event-loop:start -->
## Event Loop

### 核心理解

同步代码先执行，异步回调满足条件后进入任务队列。

### 我的易错点

- 不要把异步调度简单理解为 JavaScript 创建了新线程。

### 自测

为什么 `setTimeout(fn, 0)` 仍不会立即执行？
<!-- byte-mentor:unit:js-event-loop:end -->
```

Note Writer 输出结构化 patch，由程序负责替换或新增对应区块：

```ts
type NotePatch = {
  noteId: string;
  topicNodeId: string;
  upsertSections: Array<{
    knowledgeUnitId: string;
    title: string;
    markdown: string;
  }>;
};
```

### 12.3 内容规则

- 只记录 Committer 已经提交的知识单元。
- 正文以正确、简洁、适合复习为目标。
- 用户错误回答不能被写成知识事实。
- 已确认的个人误解可以进入“我的易错点”。
- 每个知识单元使用幂等 upsert，不重复追加同类内容。
- Note Writer 不修改 UserKnowledgeState。
- 默认在教学 checkpoint 或会话结束后更新，不在每个 turn 后重写文件。

用户是否直接编辑 AI 管理区块，以及发生并发编辑时如何合并，仍需在实现前确定。无论选择哪种方式，AI 管理区块之外的用户内容都不得被覆盖。

## 13. 完整运行链路

```text
用户提交清晰学习目标
  -> Planner 推断教学目标与候选前置知识
  -> Planner 渐进搜索 KnowledgeTree
  -> Planner 读取命中的 UserKnowledgeState / Evidence
  -> Planner 生成 TeachingPlan
  -> Actor 执行教学、诊断和追问
  -> Observer 在关键 checkpoint 提取 MemoryUpdateProposal
  -> Memory Committer 对齐节点并原子写入 Evidence / State
  -> Note Writer 在 checkpoint 或会话结束时更新 Markdown
  -> 下次 Planner 重新读取状态，改变后续教学
```

### 13.1 新知识的处理

Planner 可以临时规划多个知识点，但只有实际教学、测评或暴露误解的知识点才会经 Observer 和 Committer 进入正式知识树。

### 13.2 已有但未记录的知识

如果用户在教学前正确展示了某个知识点：

```text
Observer 标记 prior_knowledge
  -> Committer 对齐或创建节点
  -> 追加 Evidence
  -> 保守生成 UserKnowledgeState
```

如果用户只是自述“我已经会了”，只记录低强度 `self_report`，必要时由 Actor 做低成本诊断。

### 13.3 教学中新获得的知识

如果用户在 Actor 教学后完成追问或练习：

```text
Observer 标记 learning_outcome
  -> Committer 追加 Evidence
  -> 更新 mastery / misconception
  -> Note Writer 更新对应复习区块
```

一次即时答对通常不足以进入 `stable`；延迟复测是更强证据。

## 14. Plan and Act 中的记忆消费

外部记忆不直接以原始记录形式全部塞进 Actor Prompt。

Planner 先把相关状态编译成教学决策：

```yaml
target: Event Loop 任务调度

known:
  - 用户理解调用栈

misconceptions:
  - 用户曾把异步调度理解为自动创建新线程

teaching_advice:
  - 不重复解释调用栈基础
  - 先让用户预测执行顺序
  - 使用反例纠正线程误解

success_criteria:
  - 用户能区分回调执行时机与底层计时器实现
```

Actor 根据这份计划自由完成教学。技术约束作用于计划、证据和写入过程，不限制 Agent 的具体表达方式。

## 15. 写入时机

MVP 采用分层写入：

- 关键回答后：Observer 产生 proposal，并尽快提交重要 Evidence。
- 教学 checkpoint：归约 UserKnowledgeState。
- 会话结束：刷新未完成的状态投影并更新 Markdown。

不采用“每条消息都重写正式状态”，避免噪声和频繁抖动；也不采用“只在会话结束写全部内容”，避免异常退出后丢失关键学习证据。

## 16. 备选方案与取舍

### 16.1 知识图谱

已放弃。它引入节点关系维护、去重、对齐和边质量问题，但当前没有能被树与文本检索无法替代的教学收益。

### 16.2 自动生成 Skill

暂不采用。用户学习习惯是动态个人状态，不适合被固化为可执行 Skill。教学方式由 Planner 在 Prompt 提示下自由选择，效果可以作为 Evidence 或后续策略研究的输入。

### 16.3 整篇重写 Markdown

不采用。它容易覆盖用户编辑并导致内容漂移。当前选择按知识单元进行区块级 patch。

### 16.4 只保存最终掌握状态

不采用。没有 Evidence 就无法解释状态来源、处理冲突或重新归约状态。

## 17. MVP 验收闭环

第一条必须验证的跨会话闭环是：

1. 用户第一次学习某知识点并暴露误解。
2. Observer 提取可追溯 Evidence。
3. Committer 创建或复用节点并更新状态。
4. Note Writer 生成用户可读复习内容。
5. 下一次学习时 Planner 命中历史误解。
6. Actor 避免重复已掌握内容并进行针对性追问。
7. 延迟复测结果再次写回，状态能够升级、保持或降级。

评测至少比较：

- 无长期记忆的普通 Agent。
- 只注入原始记忆的 Agent。
- 使用 Planner 编译记忆的 Byte Mentor Agent。

关注指标包括历史误解命中率、重复讲解率、针对性诊断率和延迟复测表现。

## 18. 实现前仍需确认

- 教学 checkpoint 和正式会话结束的产品定义。
- 用户是否直接编辑 AI 管理的 Markdown 区块。
- 节点对齐歧义何时静默暂存、何时请求用户确认。
- 状态归约策略的具体阈值和时间衰减规则。
- Note Writer 的并发写入与冲突恢复方式。

这些问题不改变本文确定的组件边界，可以在对应模块实施前逐项决策。
