# 004 接口契约

Base：开发环境 `http://localhost:8787`（Vite 会把 `/api/*` 代理过来）；生产环境同源。

统一错误响应体：

```json
{ "error": { "code": "upstream_401", "message": "模型服务返回 401：API Key 无效或无权限" } }
```

请求体上限 **1 MB**，超限返回 `413 payload_too_large`。
所有接口均返回 `Content-Type: application/json`（`/api/chat` 流式时除外）。

---

## 1. `GET /api/health`

连通性与服务端默认配置探测。前端启动时调用。

**响应 200**
```json
{
  "ok": true,
  "name": "fanchen-desk",
  "version": "0.1.0",
  "defaults": {
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "hasKey": false
  }
}
```
`defaults` 反映服务端环境变量 `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` 的存在性。`hasKey=false` 表示前端必须自己填 Key。

---

## 2. `POST /api/chat`

对话主接口，支持流式。

**请求**
```json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-xxx",
  "model": "deepseek-chat",
  "temperature": 0.8,
  "stream": true,
  "enableTools": true,
  "messages": [
    { "role": "system", "content": "你是..." },
    { "role": "user", "content": "我需要一个排班工具" }
  ]
}
```

字段缺省规则：`baseUrl`/`apiKey`/`model` 为空时回落到服务端环境变量；`temperature` 默认 `0.8`；`stream` 默认 `true`；`enableTools` 默认 `true`。

**校验错误**

| 状态 | code | 触发 |
| --- | --- | --- |
| 400 | `missing_credentials` | 合流后仍无 `apiKey` 或 `baseUrl` |
| 400 | `invalid_base_url` | 非 http/https，或无法解析 |
| 400 | `invalid_messages` | 空数组 / 角色非法 |
| 413 | `payload_too_large` | body > 1 MB |

### 2.1 流式响应（`stream: true`）

`Content-Type: text/event-stream`，逐条 `data: <JSON>\n\n`。

**错误返回位置的约定**（实现后回填的澄清）：
- **建流之前**发生的错误（凭据缺失、URL 非法、上游 4xx/5xx、连不上）→ 直接返回 **JSON 错误体 + 对应 HTTP 状态码**，不开 SSE。理由：HTTP 语义清晰，便于 curl/冒烟脚本断言。
- **建流之后**发生的错误（流中途断开、超时）→ 只能发流内 `error` 事件，随后关闭连接。

客户端必须同时处理这两种形态。事件类型共 6 种：

| type | 载荷 | 说明 |
| --- | --- | --- |
| `delta` | `{ "text": "片段" }` | 正文增量 |
| `reasoning` | `{ "text": "片段" }` | 思维链增量（若上游返回 `reasoning_content`），前端折叠展示 |
| `tool_call` | `{ "index": 0, "task": {...} }` | 一个**已拼装完整**的任务参数对象 |
| `notice` | `{ "code": "tools_unsupported", "message": "..." }` | 非致命提示（如降级重试） |
| `usage` | `{ "usage": {...} }` | token 用量（若上游提供） |
| `done` | `{}` | 正常结束 |
| `error` | `{ "code": "...", "message": "..." }` | 致命错误，之后连接关闭 |

`tool_call.task` 结构（与 `Task` 输入字段一致）：
```json
{
  "title": "换班申请",
  "detail": "支持员工发起换班申请并走审批",
  "category": "feature",
  "priority": "P1",
  "acceptance": ["可发起申请", "审批人有通知"]
}
```

**错误码（流内 `error` 事件）**

| code | 含义 |
| --- | --- |
| `upstream_401` | Key 无效/无权限 |
| `upstream_403` | 被拒绝（地区/模型权限） |
| `upstream_404` | baseUrl 或模型名不对 |
| `upstream_429` | 触发限流/额度不足 |
| `upstream_4xx` | 其他 4xx |
| `upstream_5xx` | 上游服务异常 |
| `upstream_unreachable` | DNS/连接失败/超时 |
| `upstream_stream_error` | 流中途断开 |

### 2.2 非流式响应（`stream: false`）

```json
{
  "text": "好的，我记下了。",
  "reasoning": "",
  "toolCalls": [ { "index": 0, "task": { "title": "...", "detail": "..." } } ],
  "questCalls": [ { "index": 0, "id": "call_1", "event": { "type": "quest_proposal", "proposal": { } } } ],
  "notices": [ { "code": "tools_unsupported", "message": "..." } ],
  "usage": { "prompt_tokens": 12, "completion_tokens": 34 }
}
```

### 2.3 委托工具通道（可选，`questTools: true`）

请求体带上 `"questTools": true` 时，服务端在 `create_task` 之外再暴露三个**提案型**工具
（`propose_quest` / `submit_quest` / `decline_quest`，定义见 `server/lib/quest-tools.mjs`）；
不带该字段时行为与从前完全一致。

| SSE 事件 | 载荷 | 含义 |
| --- | --- | --- |
| `quest_proposal` | `{ index, proposal }` | NPC 提议发布一条委托；`proposal` 已归一化为领域层输入：`{ title, want, tier, objective, reward, offerLevel? }` |
| `quest_submit` | `{ index, submission }` | 模型识别到"玩家把东西交给你"，请求系统核验并结算：`{ questId, deliver? }` |
| `quest_decline` | `{ index, decline }` | 玩家表示不接这条委托：`{ questId, reason? }` |

归一化失败（缺字段、枚举不对、类型错）**不发**上述事件，改发一条 `notice`：
`code = "quest_call_rejected"`，`message` 带可读原因。

**职责边界（ADR-013）**：服务端只做**形状**归一化（枚举、必填、类型）；
**规则**裁决（道具白名单、奖励档位、库存预留、幂等、守恒）全部在前端领域层 `src/lib/quest/` 完成 ——
服务端不复制那套规则，也不持有世界状态。

---

## 3. `POST /api/extract`

把一段文本结构化为任务数组。服务端使用 JSON 模式 + 容错解析。

**请求**
```json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-xxx",
  "model": "deepseek-chat",
  "text": "……助手回复原文……",
  "context": "……可选的用户上一句……",
  "maxTasks": 5
}
```

**响应 200**
```json
{
  "tasks": [
    {
      "title": "导出 Excel",
      "detail": "排班结果需要能导出为 Excel 文件",
      "category": "feature",
      "priority": "P2",
      "acceptance": ["导出内容与页面一致"],
      "confidence": 0.72
    }
  ]
}
```
无需求时返回 `{ "tasks": [] }`（这是**正常**结果，不是错误）。

**错误**

| 状态 | code | 触发 |
| --- | --- | --- |
| 400 | `missing_credentials` | 无凭据 |
| 400 | `invalid_text` | `text` 为空或超长（> 8000 字符，超出部分截断而非报错） |
| 422 | `invalid_json` | 上游返回无法解析为 JSON 的内容（附 `raw` 前 500 字符） |
| 502 | `upstream_error` | 上游非 2xx |

**服务端抽取提示词要点**（见 `server/lib/ai.mjs`）
- 只输出 JSON，形如 `{"tasks":[...]}`；
- 只提取**文本中确实表达**的需求，不得脑补；
- 标题 ≤ 20 字；`detail` 忠实原意；`acceptance` 0–3 条；
- 没有需求就返回空数组；
- `priority`：阻塞主流程=P0，明显重要=P1，锦上添花=P2。

---

## 4. `POST /api/models`

代拉上游模型列表，用于设置面板下拉。

**请求** `{ "baseUrl": "...", "apiKey": "..." }`
**响应 200** `{ "models": ["deepseek-chat", "deepseek-reasoner"] }`
**错误** `missing_credentials` / `upstream_error`（上游不支持 `/models` 时前端提示手动填写，不阻塞）。

---

## 5. SSE 客户端解析约定

前端 `src/lib/api.ts` 必须：
1. 用 `fetch` + `ReadableStream` 读取，而非 `EventSource`（后者无法带 POST body）。
2. 以 `\n\n` 切分事件块；忽略 `:` 注释行与空 `data:`。
3. 单条 JSON 解析失败**不得中断整个流**，记为一条 `notice`。
4. 支持 `AbortSignal`，中断时不视为错误。

## 6. 安全约定

- 服务端**不记录** `apiKey`；错误消息中也不包含。
- `baseUrl` 仅允许 `http:` / `https:` 协议。
- 静态托管对解析后的绝对路径做前缀校验，防 `..` 穿越。
