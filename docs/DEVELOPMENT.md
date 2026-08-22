# pi 插件开发指南

本文档面向在 pi 上开发 extension（插件）的开发者，覆盖：插件是什么、代码放哪里、代码怎么写、如何被加载进运行时、事件系统全景、以及如何影响 LLM 的 Context。

## 本地 pi 源码（查阅索引）

pi 本体仓库在本机：

```
/Users/user/Desktop/personal-projects/pi
```

查阅源码时，以下文件最值得看（按优先级）：

| 文件 | 内容 |
|---|---|
| `packages/coding-agent/src/core/extensions/types.ts` | **一切类型的源头**：`ExtensionAPI`、34 种事件类型、`ExtensionRuntime`、`Extension`、`ToolDefinition`。写插件时对照这个文件 |
| `packages/coding-agent/src/core/extensions/loader.ts` | Loader 层：`loadExtensions`、jiti 编译、`VIRTUAL_MODULES`、`createExtensionRuntime`（throwing stubs） |
| `packages/coding-agent/src/core/extensions/runner.ts` | Runner 层：`ExtensionRunner`、`bindCore`、`emit`（事件派发）、`emitContext`、`emitToolCall` |
| `packages/coding-agent/src/core/extensions/wrapper.ts` | Wrapper 层：`wrapRegisteredTool`（extension 工具 → 核心 AgentTool） |
| `packages/coding-agent/src/core/agent-session.ts` | 核心系统：`_bindExtensionCore`（能力注入点）、`_runAgentPrompt`、`before_agent_start` 处理、消息持久化 |
| `packages/coding-agent/examples/extensions/` | **官方示例插件**（几十个，从 hello 到 snake 游戏），开发前先翻这里 |

官方文档（已安装的包内）：

```
/Users/user/.nvm/versions/node/v24.14.1/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md
/Users/user/.nvm/versions/node/v24.14.1/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/
```

---

## 心智模型

你写的不是主逻辑，而是挂在主逻辑上的钩子（hooks）。

- **不能替换**：agent loop 本身、状态归约、消息变换管道内部、session 只能追加不能改。
- **可以干预**：在循环的每个决策点拦截/改写 —— 工具调用可 block、用户输入可接管、发给 LLM 的消息可整体替换、bash 后端可完全替换、provider 请求 payload 可整体改写。

> 一句话：extension 拿不到方向盘，但在每个路口都设了关卡。

---

## 代码放哪里

| 位置 | 作用域 |
|---|---|
| `~/.pi/agent/extensions/*.ts` | 全局（所有项目） |
| `~/.pi/agent/extensions/<name>/index.ts` | 全局（多文件/带依赖） |
| `.pi/extensions/*.ts` | 项目本地（仅当前项目，需项目被信任） |
| `.pi/extensions/<name>/index.ts` | 项目本地 |

临时测试：`pi -e ./my-extension.ts`（不自动发现，不能 `/reload`）。

自动发现目录里的插件可以用 `/reload` 热重载。

**安全提示**：插件拥有你的完整系统权限（可执行任意代码），只装可信来源。

---

## 插件基本结构

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 注册事件、工具、命令……（见下文）
}
```

硬性要求：
1. `export default` 一个工厂函数（可 async，pi 会等待它完成再继续启动）。
2. 工厂函数是**注册阶段**：只做 `pi.on()` / `registerTool()` / `registerCommand()` 这类登记。
3. 动作类方法（`sendMessage`、`setModel` 等）在注册阶段调用会**抛错** —— 这是设计（throwing stubs），不是 bug。

### 注册 vs 执行分离（两阶段初始化）

| 阶段 | 谁能做什么 |
|---|---|
| setup（工厂函数执行） | 只能**注册**（往登记表写条目）；`registerProvider` 只能排队 |
| bindCore（核心系统就绪后） | runner 把真实实现注入共享 runtime；之后事件 handler 里才能调 `pi.sendMessage()` 等 |

原因：注册必须早（工具要进 system prompt、provider 要影响模型选择），动作必须晚（session/agent loop 尚未就绪）。

### 三种文件形态

| 形态 | 结构 | 适用 |
|---|---|---|
| 单文件 | `extensions/foo.ts` | 简单插件 |
| 目录 | `extensions/foo/index.ts` + 其他模块 | 多文件 |
| 带依赖的包 | `extensions/foo/package.json` + `node_modules/`（`npm install` 后） | 需要第三方 npm 包 |

### 可用 import（virtual modules，无需安装）

- `@earendil-works/pi-coding-agent` —— 类型 + 运行时工具（`isToolCallEventType`、`SessionManager` 等）
- `typebox` —— 工具参数 schema（`Type` / `Static` / `TSchema`）
- `@earendil-works/pi-ai`、`@earendil-works/pi-tui` —— AI 工具、TUI 组件
- `node:*` —— Node 内置模块

第三方 npm 包：目录形态下建 `package.json` 并 `npm install`。

---

## 加载机制（Loader → Runner → Wrapper 三层）

```
loadExtensions(paths)
  └─ 每个路径串行：
       ├─ resolvePath             路径解析
       ├─ jiti import             运行时编译 TS（无需预编译）
       ├─ createExtension         建"登记表"（空 Map 集合）
       ├─ createExtensionAPI      包装 pi 对象（引用共享 runtime）
       └─ factory(api)            执行你的代码 = 填表
  ↓
核心系统构造 ExtensionRunner（持有登记表们 + runtime + session + 模型）
  ↓
bindCore(actions)                 核心系统把真实能力注入共享 runtime
  ↓
session_start 事件                之后一切正常运转
```

| 层 | 文件 | 职责 |
|---|---|---|
| Loader | `loader.ts` | 文件 → 数据（登记表 + 工具箱），一次性，可重放（支撑 `/reload`） |
| Runner | `runner.ts` | 查表派发事件、bindCore 注入能力、每次事件现造 `ctx` |
| Wrapper | `wrapper.ts` | extension 工具格式 ↔ 核心 AgentTool 格式翻译 |

关键设计：
- **共享 runtime**：所有 extension 共用一个 runtime 对象；bindCore 是"改对象内容，不换引用"。
- **事件派发**（`runner.emit`）：按加载顺序遍历登记表 → 查该事件 handler → 逐个调用，每个 handler 单独 try/catch（一个崩了不影响其他）。
- **ctx 每次现造**：`createContext()`，值在调用时解析。
- **runtime 所有权**：`ResourceLoader` 预创建空壳 → `loadExtensions` 内部 `?? createExtensionRuntime()` 兜底创建/复用 → AgentSession 取出传给 Runner → bindCore 注入。

---

## 事件全景（34 个，四分类）

### A 类：观察型（返回值被忽略）

| 事件 | 能看到什么 |
|---|---|
| `session_start` / `session_shutdown` | 会话生命周期（reason: startup/new/resume/fork/reload） |
| `agent_start` / `agent_end` / `agent_settled` | agent 运行起止（settled = 彻底停稳） |
| `turn_start` / `turn_end` | 每一轮（LLM 响应 + 工具调用） |
| `message_start` / `message_update` | 消息开始、流式更新 |
| `tool_execution_start/update/end` | 工具执行过程 |
| `model_select` / `thinking_level_select` | 模型 / 思考级别切换 |
| `session_compact` / `session_tree` | 压缩、树导航完成 |
| `after_provider_response` | HTTP 状态码 + 响应头 |

### B 类：干预型（能改变行为）—— 最值得掌握

| 事件 | 干预方式 | 力度 |
|---|---|---|
| `input` | 返回 `{ action: "transform" }` 改写输入，或 `{ action: "handled" }` 完全接管（跳过 LLM） | 高 |
| `tool_call` | 返回 `{ block: true }` 禁止执行；`event.input` 可变，直接改参数 | 高 |
| `tool_result` | 返回部分补丁（content/details/isError/usage），链式叠加 | 中 |
| `context` | 返回替换后的消息列表（深拷贝，不持久化） | **高** |
| `before_agent_start` | 注入持久消息 + 整体替换 system prompt（多 handler 链式） | **高** |
| `before_provider_headers` | 改请求头（置 null 删除） | 中 |
| `before_provider_request` | 返回任意值即替换整个 payload | **高** |
| `message_end` | 返回替换版本的消息（持久化，影响未来轮次） | 高 |
| `user_bash` | 替换/包装 `!` `!!` 的 bash 后端（可做 SSH） | 高 |
| `project_trust` | 直接决定是否信任项目（yes/no 拥有决定权） | 高 |

### C 类：会话前拦截（可取消）

`session_before_switch` / `session_before_fork` / `session_before_compact` / `session_before_tree`
—— 返回 `{ cancel: true }` 取消；compact/tree 还可提供**自定义摘要**。

### D 类：资源贡献

`resources_discover` —— 返回 skill/prompt/theme 路径，插件可自带资源。

---

## 注册型 API

| API | 提供什么 |
|---|---|
| `registerTool` | 给 LLM 新工具（参数用 `typebox` 的 `Type.Object` 定义；`promptSnippet`/`promptGuidelines` 直接注入 system prompt） |
| `registerCommand` | `/mycommand`（唯一能拿到会话控制权 `ctx.newSession()` / `fork()` / `switchSession()` / `reload()` 的入口） |
| `registerShortcut` / `registerFlag` | 快捷键 / CLI flag |
| `registerProvider` / `registerNativeProvider` | 整个模型 provider（认证/模型刷新/自定义流式） |

### ctx 能力（事件 handler 的第二参数）

- `ctx.ui`：`select` / `confirm` / `input`（阻塞弹窗）、`notify`、`setWidget` / `setFooter` / `setHeader`
- `ctx.sessionManager`：**只读**访问会话（entries、branch）
- `ctx.model` / `ctx.modelRegistry` / `ctx.thinkingLevel`：模型与认证解析
- `ctx.signal`：abort 信号（配合 fetch 等做可取消异步）
- `ctx.isIdle()` / `ctx.compact()` / `ctx.shutdown()` / `ctx.getSystemPrompt()`

---

## 影响 Context 的完整图景

Context = System Prompt（静态装配）+ Messages（每次请求的消息列表）。

```
System Prompt 链路：
  ① resources_discover        → 自带 skill/prompt/theme
  ② registerTool              → 工具 snippet/guidelines 注入 prompt
  ③ before_agent_start        → 整体替换 system prompt
Messages 链路：
  ④ input                     → 改写用户输入
  ⑤ context 事件              → 替换发给 LLM 的消息列表（出口，一次性）
  ⑥ tool_result               → 修改工具结果
  ⑦ message_end               → 替换 finalize 的消息（持久化）
  ⑧ session_before_compact    → 自定义压缩摘要
出口：
  ⑨ before_provider_request   → 替换整个 payload
  ⑩ before_provider_headers   → 改请求头
```

### 入口 vs 出口（关键区分）

| | `before_agent_start` 注入 | `context` 修改 |
|---|---|---|
| 位置 | 消息流**入口**（agent 处理前） | 消息流**出口**（发送管道最后一关） |
| 持久化 | ✅ 随正常路径写进 session | ❌ 一次性 |
| 未来轮次可见 | ✅ | ❌ |
| 触发次数 | 每次 agent 运行前 | **每次 LLM 调用前**（一个 turn 可能多次） |

注意：
- `context` 修改**每次调用都重新构建**，不自动延续 —— 要持续过滤就得每次重复做。
- `context` 修改不更新 UI —— 模型看到的世界 ≠ TUI 里显示的历史。
- `before_agent_start` 注入的消息 `display: false` 时 UI 不显示但仍发给 LLM、仍进 session。
- 持久化修改的正规途径：`message_end` 替换、`before_agent_start` 注入、`pi.sendMessage()` / `sendUserMessage()`。

---

## 调试与验证

1. **快速测试**：`pi -e ./my-extension.ts`（临时加载，错误会打印到启动日志）。
2. **验证两阶段**：在工厂函数顶层调 `pi.sendMessage()` → 应看到 `Extension runtime not initialized` 报错；在事件 handler 里调 → 正常。
3. **热重载**：插件放自动发现目录，改完在 pi 里 `/reload`（闭包状态会重置，跨 reload 的状态用 `appendEntry` 持久化、在 `session_start` 恢复）。
4. **加载失败**：`loadExtensions` 对每个文件单独容错，单个插件报错不影响其他插件和进程。
5. **Handler 崩溃**：`runner.emit` 对每个 handler 单独 try/catch，错误通过 `emitError` 上报，不影响其他 handler。
6. **参考官方示例**：`packages/coding-agent/examples/extensions/` 下每个文件都是可运行的完整插件（推荐先读 `hello.ts`、`tools.ts`、`permission-gate.ts`、`custom-compaction.ts`、`prompt-customizer.ts`）。

---

## 常见坑

- 在工厂函数（setup）里调用动作方法 → 抛错。把动作放进事件 handler / 工具 execute / 命令 handler。
- `newSession()` / `fork()` / `switchSession()` 之后旧 `pi` / `ctx` 失效，后续逻辑必须放进 `withSession` 回调，用回调传入的新 ctx。
- `ctx.signal` 只在活跃 turn 期间存在，空闲时是 `undefined`。
- 不要在工厂函数里启动后台资源（进程/定时器/文件监听）；推迟到 `session_start`，并在 `session_shutdown` 里清理。
- 工具参数 schema 用 `typebox`（不是 `@sinclair/typebox`，后者只是别名）。
- `sessionManager` 只读，改历史用 `message_end`，追加用 `appendEntry`。
