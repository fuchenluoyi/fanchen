# 凡尘·需求台（fanchen-desk）

> 一个网页版原型：**和 AI 角色聊天，AI 话里冒出的"需求"会被自动接成任务，落到右边的任务清单里。**
> 底层是真实的 AI Agent（函数调用 + 结构化抽取），不是写死的剧本。

参考《不问凡尘》那种"与 NPC 对话、接取任务"的感觉。视觉按需求先用简洁矩形框实现，没有美术素材。

---

## 1. 快速开始

### 1.1 环境准备

只需要 **Node.js ≥ 20**（`node -v` 能打印版本即可）。

**pnpm 没装也能跑**——本项目所有脚本都是直接调 `node` 的，与包管理器无关。两套命令任选一套：

| 操作 | 用 pnpm | 用 npm |
| --- | --- | --- |
| 安装依赖 | `pnpm install` | `npm install` |
| 启动开发服务 | `pnpm dev` | `npm run dev` |
| 构建 | `pnpm build` | `npm run build` |
| 类型检查 | `pnpm typecheck` | `npm run typecheck` |
| 单元测试 | `pnpm test` | `npm test` |
| 渲染自检 | `pnpm run check:render` | `npm run check:render` |
| 端到端冒烟 | `pnpm run smoke` | `npm run smoke` |
| 全量验证 | `pnpm run verify` | `npm run verify` |
| 生产模式启动 | `pnpm start` | `npm start` |

> **遇到「pnpm 不是内部或外部命令」？** 说明 pnpm 没装，任选其一：
> - 装一个：`npm install -g pnpm`，装完**重开终端**，之后就能照本文档用 pnpm；
> - 或者直接用 npm，上表右列的命令完全等价；
> - 或者**双击项目根目录的 `dev.cmd`**，它会自动检查环境并启动。

### 1.2 启动

```bash
# 装依赖（只需一次）
pnpm install     # 没有 pnpm 就用： npm install

# 启动（同时拉起前端 5173 与后端 8787）
pnpm dev         # 没有 pnpm 就用： npm run dev
```

看到这样的输出就成功了：

```
[dev] 后端 http://127.0.0.1:8787
[dev] 前端 http://127.0.0.1:5173
```

打开 <http://127.0.0.1:5173> → 点右上角「设置」→ 填 API Key → 保存 → 开始聊。

| 配置项 | 说明 |
| --- | --- |
| Base URL | 默认 `https://api.deepseek.com/v1`。任何 OpenAI 兼容服务都行（OpenAI / DeepSeek / Ollama / vLLM…） |
| API Key | 只存在浏览器 localStorage；后端仅转发，不落盘、不写日志 |
| 模型 | 默认 `deepseek-chat`；可点「拉取列表」从服务端取 |

> 不想在页面里填 Key？复制 `.env.example` 为 `.env`，填 `AI_API_KEY`，后端会作为兜底（前端留空即用）。

## 2. 怎么用

1. 随便聊。比如：「我想做一个给团队用的值班排班工具，需要支持换班申请和自动提醒。」
2. 凡尘回复的同时，可能**直接调用 `create_task`** 把需求登记下来。
3. 就算模型不支持工具调用也没关系：回复结束后会走**抽取通道**——先用关键词规则判断这段话里有没有需求，命中了再让模型结构化一次；没有 Key 时纯规则也能出候选。
4. 右侧出现**任务卡**（标题 / 详情 / 优先级 / 来源原话 / 置信度）→ 点「接取任务」正式入列。
5. 任务可标记进行中 / 完成 / 废弃，可筛选、排序、删除，刷新页面不丢。
6. 想追溯某条任务从哪句话来？展开任务 → 点「查看原话」，左边对话会滚过去并高亮。

## 3. 可用脚本

> 下表用 pnpm 写；没装 pnpm 就把 `pnpm <x>` 换成 `npm run <x>`（`pnpm test` → `npm test`）。完整对照表见 §1.1。

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 前端 + 后端一起起（开发模式）；也可双击 `dev.cmd` |
| `pnpm build` | 类型检查 + 打包到 `dist/` |
| `pnpm start` | 单端口跑生产包（后端托管 `dist/`，默认 <http://127.0.0.1:8787>） |
| `pnpm typecheck` | 只做类型检查（零错误是硬要求） |
| `pnpm test` | 40 个单元用例（规则引擎 / 去重 / 抽取编排 / JSON 容错 / 路径安全 / SSE） |
| `pnpm run check:render` | 无浏览器渲染自检，排除"一打开就白屏" |
| `pnpm run smoke` | 端到端冒烟：自带模拟上游，验证流式与工具调用拼装 |
| `pnpm run verify` | 以上全跑一遍 |

## 4. 目录结构

```
specs/                 规范文档（先读 000-index.md）
server/
  index.mjs            路由 + 静态托管
  lib/ai.mjs           上游调用、URL 归一化、JSON 容错、tool_calls 拼装
  lib/sse.mjs          SSE 编解码
  lib/http.mjs         请求体解析、响应输出、CORS、静态文件、路径穿越防护
src/
  components/          纯展示组件
  state/store.tsx      唯一状态容器（唯一触网 / 唯一读写 localStorage 的地方）
  lib/rules.ts         规则引擎（纯函数）
  lib/dedupe.ts        相似度与去重（纯函数）
  lib/extract.ts       抽取通道编排
  lib/api.ts           HTTP / SSE 客户端
tests/                 node --test 用例
scripts/               dev / smoke / render-check
```

## 5. 架构要点

**双通道提取**（详见 `specs/007-decisions.md` ADR-003）

| 通道 | 触发方 | 特点 |
| --- | --- | --- |
| 工具通道 | 模型主动调用 `create_task` | 即时、自然，但依赖模型支持 function calling |
| 抽取通道 | 回复结束后由规则触发 | 通用、省钱（规则不命中就不调模型），可纯离线降级 |

两个通道产出的候选会**统一去重**（中文短标题用「二元组 Dice + 最长公共子串」，并对「导出 vs 导入」这类动词冲突降权）。

**降级链**：模型不支持 tools → 去掉 tools 重试 → 仍不行则只靠抽取通道；没有凭据 → 纯规则候选（标记 `rule`）；模型返回非法 JSON → 容错解析 → 再不行回退规则。

**协议收敛**：上游 OpenAI 兼容格式的差异（`delta.content` / `reasoning_content` / 分片 `tool_calls`）全部在服务端收敛成 6 类事件，前端只认这套协议，换模型不用改 UI。

## 6. 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 顶部显示「后端未连接」 | 后端没起来。单独跑 `pnpm dev:api` 看报错；确认 8787 没被占用 |
| 提示缺少 apiKey | 页面设置里没填，且服务端也没有 `AI_API_KEY` |
| 401 / 403 | Key 无效或无该模型权限 |
| 404 | `baseUrl` 或模型名不对（baseUrl 填到 `/v1` 即可，写全 `/chat/completions` 也认） |
| 429 | 限流或额度不足 |
| 模型从不调用工具 | 该模型不支持 function calling，会自动降级；抽取通道仍能出任务 |
| 任务重复冒出来 | 调高设置里的「去重阈值」（越接近 1 越宽松） |
| 候选太多太吵 | 把「抽取策略」改成「只用规则引擎」或调严阈值，也可直接关掉抽取通道 |

## 7. 已知限制

- 视觉是简洁矩形风格，没有古风皮肤（用户明确要求先这样，换肤只需改 `src/styles.css`）。
- 候选任务的标题暂不支持内联编辑。
- 多标签页各自持有 localStorage 快照，不做跨页同步。
- 上下文只取最近 N 条（默认 20），长对话不会自动摘要。
- 没有账号体系、云端同步与多人协作。

## 8. 规范文档

实现严格按 SDD 流程走：先定规范 → 定依赖 → 拆任务 → 逐条实现 → 按验收标准回验。

从 [`specs/000-index.md`](specs/000-index.md) 开始读，里面有需求编号（FR/NFR）、验收标准、任务依赖 DAG 与需求→任务→测试的追溯矩阵。
