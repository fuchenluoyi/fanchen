# 005 任务拆解与执行顺序

## 1. 拆解原则

- 每个任务**可独立验收**：有自己的产出物、DoD、验证命令。
- 任务粒度以"一次能做完并验证"为准，避免跨天任务。
- 依赖只允许**向后**（后置任务依赖前置任务的产出），不允许循环。
- 实现顺序 = DAG 的拓扑序，允许并行时并行（T3 与 T2 无强依赖，但 T3 的联调依赖 T2）。

## 2. 依赖 DAG

```
            ┌───────────────────────────────┐
            │ T1 脚手架与构建链路             │  产出：package.json / vite / tsconfig / 最小 React 页
            └───────────────┬───────────────┘
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
   ┌────────────────────┐      ┌────────────────────┐
   │ T2 服务端代理       │      │ T3 前端骨架与对话区  │
   │ /api/chat /extract  │      │ 布局/设置/流式渲染   │
   │ /health /models     │      │                    │
   └─────────┬──────────┘      └─────────┬──────────┘
             │                            │
             └──────────┬─────────────────┘
                        ▼
            ┌────────────────────────┐
            │ T4 需求抽取管线         │  规则引擎 + 去重 + LLM 精抽 + 降级
            └───────────┬────────────┘
                        ▼
            ┌────────────────────────┐
            │ T5 状态容器与任务面板    │  store + 任务卡 + 清单 + 持久化 + 审计
            └───────────┬────────────┘
                        ▼
            ┌────────────────────────┐
            │ T6 测试与单测用例        │  node --test 覆盖纯函数与解析器
            └───────────┬────────────┘
                        ▼
            ┌────────────────────────┐
            │ T7 集成、构建与文档      │  端到端冒烟、README、验收回填
            └────────────────────────┘
```

**关键路径**：`T1 → T2 → T4 → T5 → T7`（T3/T6 可与主线并行，但 T5 需要 T3 的组件容器）。

## 3. 任务清单

### T1 脚手架与构建链路
**依赖**：无
**产出**：`package.json`、`vite.config.ts`、`tsconfig.json`、`index.html`、`src/main.tsx`、`src/App.tsx`（占位）、`scripts/dev.mjs`、`.gitignore`、`.env.example`
**实现要点**
- `pnpm dev` 用 `scripts/dev.mjs` 并行拉起 `vite` 与 `node server/index.mjs`（`stdio: 'inherit'`）。
- `vite.config.ts` 配置 `server.proxy['/api'] → http://localhost:8787`。
- tsconfig：`strict`、`noEmit`、`moduleResolution: bundler`、`allowImportingTsExtensions`（供 node 直跑 TS）。
**DoD**
- [ ] `pnpm install` 成功，无 peer 冲突
- [ ] `pnpm typecheck` 零错误
- [ ] `pnpm build` 产出 `dist/index.html` 与 JS
- [ ] 关联需求：NFR-003 / NFR-008

### T2 服务端代理
**依赖**：T1
**产出**：`server/index.mjs`、`server/lib/http.mjs`、`server/lib/ai.mjs`、`server/lib/sse.mjs`
**实现要点**
- `GET /api/health`、`POST /api/models`、`POST /api/chat`、`POST /api/extract`。
- 流式：解析上游 SSE，聚合 `tool_calls` 分片（按 `index`），转成自定义事件。
- tools 被拒时去 tools 重试一次并发 `notice`。
- 静态托管 `dist`（存在时）+ 防路径穿越；`--serve-dist` 单端口模式。
- 上游错误映射为契约中的 `upstream_*` 码。
**DoD**
- [ ] `node server/index.mjs` 启动，`/api/health` 返回 200 JSON
- [ ] 无凭据调用 `/api/chat` 返回 400 `missing_credentials`
- [ ] `..%2f` 之类路径穿越请求返回 403/404，不泄露文件
- [ ] 关联需求：FR-003 / FR-004 / FR-005 / NFR-001 / NFR-006

### T3 前端骨架与对话区
**依赖**：T1（联调需 T2）
**产出**：`src/App.tsx`、`src/components/{ChatPanel,MessageList,Composer,SettingsDialog,StatusBar}.tsx`、`src/styles.css`、`src/lib/api.ts`、`src/lib/settings.ts`、`src/lib/storage.ts`、`src/lib/id.ts`、`src/types.ts`
**实现要点**
- 两栏矩形布局（对话主区 + 右侧任务区占位）。
- 设置面板：baseUrl/apiKey/model/temperature/systemPrompt/stream/enableTools/extractMode/autoAccept。
- SSE 客户端：`fetch` + reader，按契约解析 6 类事件；支持 `AbortController`。
- 错误映射为中文提示，以错误气泡插入消息流。
**DoD**
- [ ] 无 Key 时点发送 → 明确提示而不是白屏
- [ ] 填对 Key 后能流式收到回复
- [ ] 生成中"停止"按钮可中断，部分内容保留
- [ ] 关联需求：FR-001 / FR-002 / FR-003 / FR-012 / FR-013 / NFR-005 / NFR-007

### T4 需求抽取管线
**依赖**：T2、T3
**产出**：`src/lib/rules.ts`、`src/lib/dedupe.ts`、`src/lib/extract.ts`
**实现要点**
- 规则引擎：强触发词 + 情态动词 + 动作动词 + 列表结构加权，输出 `score` 与 `reasons`；必要时切分候选句。
- 相似度：字符三元组 Jaccard；`dedupe.ts` 提供 `isDuplicate`。
- `extract.ts` 编排：模式判定 → 规则/LLM → 去重 → 产出候选；异常一律回退规则。
- 服务端 `parseJsonLoose` 容错解析。
**DoD**
- [ ] 纯函数无副作用，可被 `node --test` 直接 import
- [ ] `extractMode='off'` 时不产生候选
- [ ] 无凭据时 `origin='rule'`，不抛错
- [ ] 关联需求：FR-005 / FR-006 / FR-009 / FR-014 / NFR-004

### T5 状态容器与任务面板
**依赖**：T3、T4
**产出**：`src/state/store.tsx`、`src/components/{TaskPanel,TaskCard,AuditDrawer}.tsx`
**实现要点**
- `useReducer` 单一状态树：`messages / tasks / candidates / settings / health / busy / audits`。
- 副作用集中：`send()`（对话 + 工具事件 + 抽取）、持久化 `useEffect`。
- 任务面板：候选卡（采纳/忽略）、任务列表（状态流转、筛选、删除、优先级）、审计区。
- localStorage 版本化读取，损坏回退默认。
**DoD**
- [ ] 采纳候选后任务进入清单，候选消失
- [ ] 状态流转与筛选正确；刷新后数据仍在
- [ ] "查看原话"能定位来源消息
- [ ] 关联需求：FR-007 / FR-008 / FR-010 / FR-011 / FR-014

### T6 测试与用例
**依赖**：T4（可先写用例再补实现）
**产出**：`tests/rules.test.ts`、`tests/dedupe.test.ts`、`tests/extract.test.ts`、`tests/parse-json.test.ts`、`tests/http-safety.test.ts`
**DoD**
- [ ] `pnpm test` 全绿
- [ ] 覆盖 006 中 U-01..U-06
- [ ] 关联需求：NFR-004

### T7 集成、构建与文档
**依赖**：T2、T5、T6
**产出**：`README.md`、端到端冒烟脚本 `scripts/smoke.mjs`、规范状态回填
**DoD**
- [ ] `pnpm build && pnpm start` 后单端口可访问页面
- [ ] `node scripts/smoke.mjs` 完成 health → 校验错误码 的链路自检
- [ ] README 含启动步骤、配置说明、故障排查
- [ ] 005/006 验收项逐条勾选
- [ ] 关联需求：NFR-008 / FR-003

## 4. 执行记录

| 任务 | 状态 | 产出 / 备注 |
| --- | --- | --- |
| T1 | ✅ | `package.json`、`vite.config.ts`、`tsconfig.json`、`scripts/dev.mjs`。React 19.3 / Vite 8.3 / TS 7.0 |
| T2 | ✅ | `server/index.mjs` + `server/lib/{http,sse,ai}.mjs`，零第三方依赖 |
| T3 | ✅ | 两栏矩形布局、设置面板、SSE 客户端、错误气泡、停止生成 |
| T4 | ✅ | `src/lib/{rules,dedupe,extract}.ts`，双通道 + 三级降级 |
| T5 | ✅ | `src/state/store.tsx` + 任务面板 / 候选卡 / 审计区，localStorage 版本化 |
| T6 | ✅ | 4 个测试文件、40 个用例全绿 |
| T7 | ✅ | `scripts/{smoke,render-check}.mjs`、README、规范回填 |

**一次验证通过情况**

| 验证项 | 结果 |
| --- | --- |
| `pnpm typecheck` | ✅ 零错误 |
| `pnpm test` | ✅ 40/40 |
| `pnpm build` | ✅ JS 257 KB（gzip 83.6 KB）≪ NFR-002 上限 |
| `pnpm run check:render` | ✅ 组件树渲染成功，关键文案齐全 |
| `pnpm run smoke` | ✅ 10/10（含模拟上游的流式与工具调用拼装） |
| `pnpm dev` | ✅ 前端 5173 + 后端 8787 同时可用，Vite 代理 `/api` 正常 |

## 5. 验证阶段发现并修复的缺陷

SDD 的价值就在这里——规范里写死的验收标准把下面这些问题逼了出来：

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| D-1 | 规则引擎漏掉 `2. 自动提醒` 这类短列表项 | 最小句长阈值（6 字）对列表项过严 | 列表项阈值降到 3 字（`rules.ts`），并补测试 |
| D-2 | 「最好还能导出成 Excel」判为无需求 | 软需求标记 `最好能` 匹配不到 `最好还能` | 放宽为 `最好.{0,2}能`，并补 `还能…` 分支 |
| D-3 | `makeTitle()` 直接调用时残留 `**` | 去装饰只发生在 `splitUnits()` 里 | `makeTitle()` 内部也过一遍 `stripDecorations()` |
| D-4 | `%2e%2e` / `..` 路径穿越返回 200（index.html） | ① WHATWG URL 解析器会先把双点段归一化掉，② SPA 回退把未知路径都当页面 | 在 `new URL()` **之前**用原始请求目标拦截 `..`；静态资源缺失时不再回退到 index.html |
| D-5 | `ftp://` 协议返回 502「连不上上游」 | `chatEndpoint()` 在 `try` 内部抛错，被误导为网络故障 | 端点归一化移到 `try` 之外，协议错误如实冒泡成 400 |
| D-6 | `pnpm dev` 提示 127.0.0.1 但连不上 | Vite 默认只绑定 IPv6 `::1` | `vite.config.ts` 显式 `host: '127.0.0.1'` |
| D-7 | 用户终端里 `pnpm` 不是内部或外部命令 | 本机只装了 Node.js（自带 npm），没有 pnpm | ① 所有 scripts 内部改为直接调 `node`，`npm run <x>` 与 `pnpm <x>` 等价；② `verify` 不再嵌套 pnpm；③ 新增 `dev.cmd` 双击启动 |
| D-8 | `dev.cmd` 启动后满屏「不是内部或外部命令」 | 按 UTF-8 + LF 写批处理，中文 cmd（codepage 936）把中文读成乱码当命令执行 | 改以 **GBK + CRLF** 写盘，并去掉中途 `chcp`（切码页会让 cmd 的字节偏移错位） |

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 模型不支持 function calling | 工具通道失效 | 自动去 tools 重试 + 抽取通道兜底（FR-005/FR-006） |
| 模型返回非法 JSON | 抽取失败 | `parseJsonLoose` 容错 + 规则回退 |
| 流式 tool_calls 分片拼装出错 | 任务参数残缺 | 按 `index` 聚合，参数不合法的调用被丢弃并审计（AC-4.4） |
| 对话越聊越长导致上下文超限 | 请求报错 | `historyLimit` 截断最近 N 条（AC-11.2） |
| 规则引擎误报，候选噪音多 | 体验差 | 阈值 + 去重 + 需人工采纳（FR-007/FR-009） |
| Windows 沙箱下 pwsh 崩溃 | 无法执行命令 | 已确认需以 full-access 运行命令（环境限制，非代码问题） |
