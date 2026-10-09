# 003 架构设计

## 1. 系统上下文

```
┌──────────────┐        HTTP/SSE        ┌──────────────────┐      HTTPS       ┌─────────────────┐
│  浏览器 SPA   │ ─────────────────────▶ │  Node 代理服务    │ ───────────────▶ │ OpenAI 兼容服务  │
│ React + TS   │ ◀───────────────────── │  (零依赖, :8787)  │ ◀─────────────── │ DeepSeek/OpenAI │
└──────────────┘   delta / tool_call    └──────────────────┘   流式 chunk     │ Ollama / vLLM   │
       │                                         │                            └─────────────────┘
       └── localStorage：设置 / 消息 / 任务          └── 只读环境变量，绝不落盘 Key
```

为什么需要服务端：① Key 不进入浏览器网络面板之外的持久位置、避免 CORS 限制；② 统一处理流式 tool_calls 拼装；③ 生产环境单端口托管静态文件。

## 2. 前端分层

```
┌─────────────────────────────────────────────────────────────┐
│ 视图层 components/   纯展示，不含业务规则                       │
│  ChatPanel  MessageList  Composer  TaskPanel  TaskCard        │
│  SettingsDialog  StatusBar  AuditDrawer                       │
├─────────────────────────────────────────────────────────────┤
│ 状态层 state/store.tsx   React Context + useReducer           │
│  唯一可变更状态的地方；副作用（网络/持久化）集中在此             │
├─────────────────────────────────────────────────────────────┤
│ 领域层 lib/  纯函数，可被 node --test 直接测试                  │
│  rules.ts(规则引擎)  dedupe.ts(相似度)  extract.ts(抽取编排)   │
│  api.ts(HTTP/SSE 客户端)  settings.ts  storage.ts  id.ts      │
├─────────────────────────────────────────────────────────────┤
│ 类型层 types.ts  全项目共享的 Task / Settings / ChatMessage 等 │
└─────────────────────────────────────────────────────────────┘
```

## 3. 服务端结构

```
server/
  index.mjs          路由分发 + 参数解析 + 静态托管入口
  lib/http.mjs       readJson / sendJson / sendSse / serveStatic（含路径穿越防护）
  lib/ai.mjs         上游调用：streamChat(SSE 透传+tool_call 拼装) / jsonChat / listModels / parseJsonLoose
  lib/sse.mjs        SSE 事件编码 + 上游流解析器
```

## 4. 数据模型

```ts
type Role = 'system' | 'user' | 'assistant';

interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  status?: 'streaming' | 'done' | 'aborted' | 'error';
  errorText?: string;
  /** 本条消息触发的候选任务 id，用于"查看原话"反查 */
  producedCandidateIds?: string[];
}

type TaskCategory = 'feature' | 'bug' | 'content' | 'question' | 'other';
type TaskPriority = 'P0' | 'P1' | 'P2';
type TaskStatus   = 'pending' | 'active' | 'done' | 'dropped';
type Origin       = 'llm' | 'rule';

interface TaskCandidate {          // 尚未采纳
  id: string;
  title: string;
  detail: string;
  category: TaskCategory;
  priority: TaskPriority;
  acceptance: string[];
  confidence: number;              // 0..1
  origin: Origin;
  evidence: string;                // 原话片段
  sourceMessageId: string | null;
  triggerReasons: string[];
  createdAt: number;
}

interface Task extends Omit<TaskCandidate, 'evidence' | 'triggerReasons'> {
  status: TaskStatus;
  evidence: string;
  triggerReasons: string[];
  updatedAt: number;
}

interface Settings {
  baseUrl: string;       // 默认 https://api.deepseek.com/v1
  apiKey: string;
  model: string;         // 默认 deepseek-chat
  temperature: number;   // 默认 0.8
  systemPrompt: string;  // NPC 人格
  stream: boolean;       // 默认 true
  enableTools: boolean;  // 默认 true
  extractMode: 'auto' | 'llm' | 'rule' | 'off';  // 默认 auto
  autoAccept: boolean;   // 默认 false
  historyLimit: number;  // 默认 20 条
  dedupeThreshold: number; // 默认 0.62
}
```

### 任务状态机

```
                ┌──────────── 废弃 ────────────┐
                ▼                              │
  [候选] --采纳--> pending(待办) ──开始──▶ active(进行中) ──完成──▶ done(完成)
                     │                        │
                     └────────废弃────────────┴──▶ dropped(废弃)
                                    │
                          恢复 ─────┘（任意状态可回到 pending）
```

## 5. 关键时序

### 5.1 一轮对话（含工具通道）

```
用户输入
  └─▶ store.send()
        ├─ 追加 user 消息，持久化
        ├─ POST /api/chat (stream=true, tools=[create_task])
        │     └─ 服务端 fetch 上游 → 逐块解析 SSE
        │           ├─ delta      → SSE {type:'delta'}     → 前端追加文本
        │           └─ tool_calls → 按 index 聚合 arguments
        │                          → 完整后 SSE {type:'tool_call'} → 前端生成候选
        ├─ 收到 done → 消息标记完成
        ├─ 抽取通道：rules.analyzeForRequirements(回复文本)
        │     ├─ 未命中 → 记录审计，结束
        │     └─ 命中 → (有凭据? POST /api/extract : 规则候选)
        │                → 与既有任务 + 本轮已有候选去重
        │                → 生成候选卡 / autoAccept 直接入列
        └─ 持久化 + 更新审计面板
```

### 5.2 决策点与降级

| 决策点 | 条件 | 行为 |
| --- | --- | --- |
| 是否带 tools | `enableTools=false` | 不发 tools，只走抽取通道 |
| 上游拒绝 tools | 400 且报文含 tool/function 关键词 | 去掉 tools 重试 1 次，发 `notice` |
| 抽取走哪条路 | `extractMode` | `off` 跳过 / `rule` 只规则 / `llm` 强制 LLM / `auto` 规则触发再 LLM |
| 无凭据 | `apiKey` 空且服务端无 env | 降级为规则候选，`origin='rule'` |
| LLM 抽取失败 | 网络/JSON 错误 | 回退规则候选，审计记录失败原因 |

## 6. 依赖关系

### 6.1 模块依赖（谁 import 谁）

```
types.ts ──────────────┐（被所有模块依赖，自身零依赖）
                       │
id.ts ─────────────────┤
storage.ts ────────────┤
                       ▼
                  settings.ts ──▶ types, storage
                  rules.ts ─────▶ types（纯函数，零运行时依赖）
                  dedupe.ts ────▶ types
                       │
                       ▼
                  extract.ts ───▶ rules, dedupe, api, types
                  api.ts ───────▶ types, settings（读配置）
                       │
                       ▼
                  state/store.tsx ──▶ extract, api, storage, settings, rules, types
                       │
                       ▼
                  components/* ──▶ state/store, types（禁止直接 import api/storage）
                       │
                       ▼
                  App.tsx ──▶ components/*

server/lib/sse.mjs ──▶ （零依赖）
server/lib/http.mjs ─▶ node:http, node:fs, node:path
server/lib/ai.mjs ───▶ server/lib/sse.mjs
server/index.mjs ────▶ server/lib/*
```

**架构约束**：`components/*` 不得直接触网或读写 localStorage —— 一切副作用经 `state/store.tsx`，保证可测与状态唯一。

### 6.2 任务依赖 DAG（详见 005）

```
T1 脚手架 ──▶ T2 服务端 ──▶ T4 抽取管线 ──▶ T5 状态与任务面板 ──▶ T7 集成与文档
                  │                    ▲                          ▲
                  └──▶ T3 前端骨架 ────┴──▶ T6 测试 ──────────────┘
```

## 7. 目录结构

```
D:\exampleProduct\
├─ specs/                 规范文档（本目录）
├─ server/                零依赖 Node 代理
├─ src/
│  ├─ components/         展示组件
│  ├─ state/store.tsx     状态容器
│  ├─ lib/                纯函数领域逻辑
│  ├─ types.ts
│  ├─ App.tsx
│  ├─ main.tsx
│  └─ styles.css
├─ tests/                 node --test 用例
├─ scripts/dev.mjs        并行启动前端与后端
├─ index.html
├─ vite.config.ts
├─ tsconfig.json
├─ package.json
├─ .env.example
└─ README.md
```

## 8. 技术选型理由（摘要，详见 007）

| 选择 | 理由 |
| --- | --- |
| Vite + React + TS | 用户选定；HMR 快，生态成熟 |
| 零依赖 `node:http` 后端 | 少一层依赖风险，代理逻辑本身简单 |
| 自定义 SSE 事件协议 | 上游差异（delta/tool_calls/错误）在服务端收敛，前端只认 5 种事件 |
| localStorage | 原型阶段无账号体系，最省事且离线可用 |
| `node --test` + 原生 TS 剥离 | 不为测试引入 vitest/jest，纯函数直接跑 |
