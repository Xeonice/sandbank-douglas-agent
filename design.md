# Sandbank 设计要素分析

> 本文基于仓库当前代码与文档（README 系列、`package.json`、`packages/*` 源码、`docs/` 目录、CLI 实现）整理，描述 Sandbank 的设计要素现状与改进建议。
>
> 重要前提：本仓库是一个 **纯 TypeScript SDK / CLI monorepo**，不包含任何 Web 前端或原生客户端代码（全仓库无 `.html` / `.tsx` / `.jsx` / `.vue` / `.css` 文件，`packages/*/package.json` 中无 react / vue / next / expo / react-native 等依赖）。因此它的"设计"主要体现在 **API 设计、CLI 交互设计、协议/事件设计和文档信息设计** 四个层面。Web App 与 Native App 章节按要求保留，并标注"不适用/未发现"。

---

## 1. 项目定位

- **一句话定位**（README.md 首行）："AI Agent 统一 Workspace Agent Harness — 一个 Workspace，多种后端沙盒。"
- 产品形态是 **面向 AI Agent 开发者的基础设施 SDK**：把 Agent 的身份、memory、artifact、audit log、文件和 checkpoint 固化在 `Workspace` 协议里，再把执行任务调度到 Sandbank Cloud、Dynamic Worker、E2B、BoxLite、Fly.io、Daytona、Cloudflare Workers 等后端沙盒。
- 定位经历过一次升级：从"统一沙箱接口"（root `package.json` 仍写 "Unified sandbox SDK for AI agents — write once, run on any cloud"）升级为"跨后端同步 Workspace 的 Agent Harness"（commit `3754af9` "reposition sandbank as workspace agent harness"）。README 已同步，但部分代码内文案仍滞留旧定位（见第 12 节设计债务）。
- 商业锚点：默认推荐 provider 是 **Sandbank Cloud**（托管 BoxLite），支持 API token 或 x402（USDC）按次付费（`@sandbank.dev/cloud`）。
- 明确的设计原则写在 README "设计原则" 一节，共五条：最小接口最大互操作、显式优于隐式、能力检测而非假实现、幂等操作、Provider 层与 Session 层完全解耦。这五条在代码中可验证（如 `CapabilityNotSupportedError`、`withVolumes()` 运行时能力探测、destroy 幂等）。

## 2. 产品 / 信息架构

### 2.1 分层架构

README 中的 ASCII 架构图与 `packages/` 目录一一对应，自上而下五层：

1. **Harness 层**：`sandbank`（Workspace Agent Harness、`AgentSupervisor`、Tool Use、provider scheduler、CLI / Worker entrypoints）
2. **协议层**：`@sandbank.dev/workspace`（持久 Workspace 协议与 checkpoint）
3. **SDK 基础层**：`@sandbank.dev/core`（Provider SDK、能力系统、错误类型）、`@sandbank.dev/skills`（Skill 注册表）、`@sandbank.dev/agent`（沙箱内客户端）、`@sandbank.dev/relay`（多 Agent 通信）
4. **Provider 适配层（计算）**：`cloud`、`boxlite`、`e2b`、`daytona`、`flyio`、`cloudflare` 六个适配器
5. **Service 适配层（数据）**：`@sandbank.dev/db9`（serverless PostgreSQL，唯一的 `services` 能力实现）

### 2.2 信息架构（文档侧）

- **根 README 四语镜像**：`README.md`（中文，默认入口）、`README.en.md`、`README.ja.md`、`README.zh-CN.md`。注意 `README.md` 与 `README.zh-CN.md` 内容完全相同（`diff` 验证为 identical）。
- **`docs/` 目录**：深度文档与研究笔记混放，包括 `sandbank-agent-configuration.md`（含 zh-CN / ja 两个本地化镜像）、`provider-scheduler-workspace.md`、`dynamic-worker-harness-architecture.md`、`db-native-agent-harness-research.md`（580 行，最长）、`boxlite-troubleshooting.md`、`research-db9-service-layer.md`、`TODO.md`。
- **包级 README**：13 个包中 10 个有自己的 README；`db9`、`skills`、`workspace` 缺失。
- **根目录 `plan.md`**：relay 跨仓库改进计划（2026-03-17），属工作文档而非产品文档，且引用的 `docs/2026-03-17-relay-review.md` 在仓库中不存在。

## 3. Web App

**不适用 / 未发现。**

- 本仓库不包含任何 Web 前端：无 HTML / JSX / TSX / Vue / Svelte / CSS 文件，无前端框架依赖，无 bundler 配置（除 TypeScript `tsc` 外）。
- 与"Web"最接近的两个东西都是 **无界面（headless）服务端**，不应误认为 Web App：
  - `packages/sandbank/src/harness-api.ts` + `harness-worker.ts`：DB-native harness 的 HTTP/SSE API（`GET /health`、`GET /api/db-native-agent-harness/capabilities`、`POST /api/sandbank-agent-harness/stream` 等），输出 `data: {...}` 格式的 SSE 事件流，无任何 HTML 页面。
  - `@sandbank.dev/core` 的 `terminal` 能力（`connectTerminal()`，封装 ttyd WebSocket 协议）：Web 终端的 UI 由各 provider 的 ttyd 提供，不在本仓库。
- 官网 `sandbank.dev` 与控制面 `cloud.sandbank.dev` 均为外部仓库，本仓库只通过 README 链接和 CLI 默认 API URL（`https://cloud.sandbank.dev`）引用它们。

## 4. Native App

**不适用 / 未发现。**

- 仓库中没有 iOS / Android / 桌面（Electron、Tauri 等）客户端代码，无 react-native / expo / swift / kotlin 相关文件或依赖。
- 最接近"本地运行的客户端"的是两个 **命令行程序**，但它们是 CLI 而非 Native App：
  - `sandbank` CLI（`packages/sandbank/src/cli/`，bin 名 `sandbank`）
  - `sandbank-agent` CLI（`packages/agent`，bin 名 `sandbank-agent`，运行在沙箱内部）
- CLI 的交互设计在第 7 节单独分析。

## 5. 视觉语言

虽无 GUI，仓库仍有明确、统一的视觉表达，集中在文档层：

- **品牌插画**：`docs/assets/sandbank-robots-vacation-pixel.png`（像素画风格，一群机器人 Agent 在沙洲/海滩度假，每个机器人有不同开发者角色）作为四语 README 的全宽 banner；另有非像素版 `sandbank-robots-vacation.png` 备用。插画扣题（sandbank = 沙洲/沙箱双关），并配有描述性 alt 文本。
- **像素画（pixel art）是当前的视觉基调**：呼应"沙箱/游戏化"的隐喻，区别于常见的企业级 SaaS 渐变风。
- **符号系统**：能力矩阵统一使用 ✅ / ❌ / ⚠️（带脚注）三态符号，跨四语 README 一致；架构图使用 ASCII box-drawing 字符（`┌─┤│└`），保证在终端和 GitHub 上均可渲染。
- **CLI 视觉**：纯文本、零色彩、零 spinner（代码中无 chalk / picocolors / ora / ANSI 转义）。对齐靠 `padEnd()`（如 `addons list` 的列对齐）。这是有意的极简——输出对管道、日志采集和无色终端完全友好，与"显式优于隐式"原则一致。
- **代码即视觉**：README 大量使用带语法高亮的 TypeScript 代码块作为主要"截图"，体现"API 就是产品界面"的定位。

## 6. 布局与导航

- **README 信息流**（开发者漏斗式布局）：定位标语 → banner 插画 → "为什么选择" → 最小可运行代码示例 → 架构图 → 包一览表 → Provider 支持矩阵 → 进阶主题（多 Agent、Workspace、Scheduler、Tool Use）→ 快速开始 → 开发/测试 → 设计原则 → 许可证。先给结论和代码，后给细节，符合开发者文档的"30 秒可判断是否相关"模式。
- **导航机制**：
  - 根 README 顶部的语言切换链接（官网 | English | 日本語）。
  - "包一览"表格中每个包名链接到 `./packages/<name>` 目录，相当于站内目录页。
  - 进阶文档通过行内链接跳转到 `docs/`（如 Provider Scheduler、Agent Configuration）。
- **CLI 导航**：`sandbank --help` / 无参数时输出全量命令清单（`help.ts`），按 命令 → 全局选项 → 环境变量 → 官网 四段布局；子命令用法错误时打印局部 `Usage:` 行（如 `Usage: sandbank addons create <type> [--intent "..."] [--box <id>]`）。
- **docs/ 目录无索引页**：文档靠 README 行内链接和文件名导航，研究笔记（`research-*`、`db-native-*`）与用户文档（`*-configuration`、`*-troubleshooting`）混在同一层。

## 7. 交互模式

### 7.1 SDK API（主交互面）

- **入口统一**：`createProvider(adapter)` 包装任意适配器；换 provider 只换 adapter 构造，业务代码不变（README 明确以此为卖点）。
- **能力检测而非假实现**：可选能力经 `withVolumes(provider)`、`withPortExpose(sandbox)` 等帮助函数在运行时安全探测；不支持时抛 `CapabilityNotSupportedError`（`packages/core/src/errors.ts`），绝不返回假数据。
- **错误层级**：`SandboxError` 基类下分 `SandboxNotFoundError` / `SandboxStateError` / `ExecTimeoutError` / `RateLimitError` / `ProviderError` / `CapabilityNotSupportedError`，调用方可按类型精确处理。
- **幂等**：destroy 已销毁的沙箱不报错。
- **两段式执行**：`preflightWorkspaceSandboxTask`（static 检查 + runtime 探测镜像内工具）与 `runWorkspaceSandboxTask` 分离，失败前置。

### 7.2 CLI

- **动词式子命令** + 常用别名（`ls`→`list`、`rm`→`destroy`、`harness-bench`→`harness-benchmark`），手写 argv 解析（`takeFlag` / `takeOption`），不依赖 commander/yargs。
- **双输出模式**：默认人类可读的紧凑单行输出（如 `Cloned <id> → <newId> (<status>)`），全局 `--json` 切换为机器可读 JSON（`printJson`）——明确同时服务人和脚本/Agent 两类用户。
- **上下文感知**：在沙箱内运行时自动读取 `SANDBANK_BOX_ID` 作为默认 box（`currentBoxId()`），命令如 `clone`、`addons` 可省略 id；错误信息会提示该机制（"Inside a sandbox, <id> defaults to the current box."）。
- **认证三通道**：`--api-key` / `--wallet-key`（x402 链上付费）/ 环境变量，`login` 命令持久化。
- **失败约定**：用法错误打印 `Usage:` 到 stderr 并 `process.exit(1)`。

### 7.3 HTTP / SSE 协议

- harness API 以 SSE（`data: {json}\n\n`）输出统一事件流：`run.*` 生命周期事件（含 `run.done` 携带 status: completed/failed）、metadata（runId、model、supervisor），run 输入/输出持久化到 Workspace 的 `/runs/...`，supervisor 状态与 audit 写入 `/agents/...`。
- **harness-benchmark** 是一个有意思的设计：把"交互质量"量化为 100 分制评分（HTTP/SSE transport、harness lifecycle、Workspace persistence、Dynamic Worker capsule、model streaming、expectations、latency 七维），即对自身 API 的体验做自动化验收。

### 7.4 权限与安全交互

- Tool Use 采用"先 policy 后执行"模型：`tool.use` 请求先经 `AgentSupervisor` 检查 allowedTools + resource grants + approval rules，再调用 handler 或 sandbox provider；Dynamic Worker capsule 内的 `SANDBANK_TOOLS.use()` 也走同一条 supervisor policy，不可绕过。
- resource 白名单粒度到 `kind/id/action`（如 `{ kind: 'cloudflare.d1', id: 'analytics', actions: ['read'] }`），写操作可声明 `requireApproval`。

## 8. 内容语气

- **直接、技术化、零营销腔**：README 不用形容词堆砌，卖点用可运行代码和能力矩阵呈现；"为什么选择 Sandbank?" 一节直接讲架构论点（Agent 需要可恢复、可审计、可迁移的 Workspace）而非口号。
- **中英混排为常态**：中文 README 保留大量英文术语原文（Workspace、checkpoint、provider、harness、materialize/sync），面向能读英文 API 的中文开发者，不强行翻译概念词。
- **诚实标注限制**：能力矩阵的 ⚠️ 均有脚注解释（如 Cloudflare 保留 3000 端口、E2B volumes 需 beta 权限）；README 主动说明 "当前没有开放'远程任意用户注册 tool'的管理端点" 这类边界。
- **CLI 文案极简**：错误信息一句话 + 一行 Usage，无寒暄无 emoji。
- **CHANGELOG 遵循 Keep a Changelog 体例**（Added / Fixed / Changed 分节），条目写到具体 API 与符号级别。
- 本地化语气一致：en/ja/zh 三语 README 同构（最近一次 commit `891f3de` 即 "sync sandbank cloud across localized readmes"），定位语句逐字对应。

## 9. 关键组件

按包列出各自的核心设计组件（多包仓库，逐包分述）：

| 包 | 关键组件 / 设计要素 |
|---|---|
| `sandbank`（v0.5.4，顶层） | `AgentSupervisor`（policy/memory/tool use 中枢）、`ToolUseRegistry` + `create*Tool` 工厂、provider scheduler（`selectSandboxProvider` / `preflightWorkspaceSandboxTask` / `runWorkspaceSandboxTask`）、agent memory（`memories.jsonl`，pinned/insight/session 三类注入 prompt）、`harness-api`/`harness-worker`（Node + Workers 双 entrypoint）、`harness-benchmark`（100 分制评分）、CLI（17 个命令文件） |
| `@sandbank.dev/core`（v0.3.6） | `createProvider` / `createSession`、能力系统（`capabilities.ts` + `with*` 探测函数）、错误层级（`errors.ts` 七类）、`connectTerminal()`（ttyd WebSocket 封装）、skill 注入、observer/hooks |
| `@sandbank.dev/workspace` | `WorkspaceAdapter` 协议、`MemoryWorkspaceAdapter`、`materializeWorkspaceToSandbox` / `syncWorkspaceFromSandbox`（含 `deleteMissing`、`checkpointLabel`）——provider 中立持久化的核心 |
| `@sandbank.dev/cloud` | `SandbankCloudAdapter`：托管 BoxLite，推荐默认 provider，API token 或 x402/USDC 双付费通道 |
| `@sandbank.dev/boxlite` | 自托管 Docker/KVM 适配器，唯一同时支持 `snapshot` + `sleep` + `exec.stream` 的后端 |
| `@sandbank.dev/cloudflare` | Workers 适配器 + `dynamic-worker-capsule` 子导出（受限 JS code mode 的执行胶囊，binding 限定 `ctx.search` / `ctx.workspace` / `ctx.runtime`） |
| `@sandbank.dev/daytona` / `flyio` / `e2b` | 各云后端适配器；flyio 零外部依赖（纯 fetch），e2b 依赖官方 `e2b` SDK |
| `@sandbank.dev/db9`（服务侧） | `ServiceProvider`（`services` 能力唯一实现），serverless PostgreSQL 绑定；覆盖率最高（语句 100%） |
| `@sandbank.dev/relay` | JSON-RPC 2.0 WebSocket 中继，session 级多 Agent 消息与共享 context（`plan.md` 记录了它被 cloud 当作 node 级基础设施使用而暴露的设计缺陷） |
| `@sandbank.dev/agent` | 沙箱内轻量客户端：`connect()` 自动读 `SANDBANK_*` 环境变量、`session.on('message')` / `send` / `complete` 事件模型，附 `sandbank-agent` CLI |
| `@sandbank.dev/skills` | Skill 注册表与本地文件系统加载器，由各 provider 的 `skills` 能力消费 |

跨包的质量设计：根目录 `test/conformance` + `vitest.conformance.config.ts` 提供 **跨 provider 一致性测试**——用同一套契约测试约束所有适配器行为，这是"最小接口，最大互操作"原则的执行机制。

## 10. 响应式 / 无障碍

GUI 意义上的响应式与无障碍 **不适用**（无界面）。按本仓库实际交互面评估等价关怀：

- **做得好的**：
  - README 插画带完整描述性 alt 文本（中英日三语各自本地化）。
  - 架构图用 ASCII 而非图片，屏幕阅读器和终端可读。
  - CLI 零色彩输出，不依赖颜色传达信息（对色觉障碍和无色终端天然友好）；`--json` 为辅助技术和脚本提供结构化通道。
  - SSE 事件均为结构化 JSON，错误带 `code` 字段，可编程消费。
- **可改进的**：
  - 能力矩阵依赖 ✅/❌/⚠️ emoji，部分屏幕阅读器播报体验差，可考虑补充文字（如 "Yes/No/Partial"）。
  - README banner `width="100%"` 在窄屏（手机 GitHub）下像素画细节不可辨，但属可接受取舍。
  - CLI 无 `NO_COLOR`/TTY 检测的需求（因为本来无色），但也没有 `--quiet`/`--verbose` 级别控制。

## 11. 设计债务与改进建议

按影响排序：

1. **定位文案漂移**（品牌一致性）：root `package.json` description 仍是旧定位 "Unified sandbox SDK"，CLI help 首行是 "sandbank — Sandbox SDK and CLI for AI agents"，而 README 与 `packages/sandbank/package.json` 已改为 "Workspace Agent Harness"。建议统一为 harness 定位，一次性梳理所有 description / help 文案。
2. **`README.md` 与 `README.zh-CN.md` 完全重复**：两份相同的中文 README 必然漂移。建议将 `README.zh-CN.md` 改为指向 `README.md` 的占位说明，或用脚本保证同步（参考已有的 readme-i18n 同步实践）。
3. **三个包缺 README**：`@sandbank.dev/db9`、`@sandbank.dev/skills`、`@sandbank.dev/workspace` 没有包级 README——而 workspace 恰是新定位的核心概念。npm 包页面将无介绍。建议优先补 workspace 和 db9。
4. **`plan.md` 引用不存在的文档**：`docs/2026-03-17-relay-review.md` 缺失；且 relay 的四类设计缺陷（trusted 单 session 总线被当成 node 级基础设施）本身是已知架构债，plan.md 中已有改进计划，建议跟进落地或归档。
5. **docs/ 缺索引与分类**：用户文档、研究笔记、troubleshooting 混在一层且无 `docs/README.md`。建议加索引页并区分 guides / research。
6. **CLI 解析逻辑重复**：`takeOption` 在 `cli/index.ts` 与 `commands/addons.ts` 各实现一份，应收敛到共享模块。
7. **help 文本与命令集合手工同步**：`help.ts` 是手写字符串，新增命令（如 `db-native-harness` 别名未列入 help）容易漏更新。建议从命令注册表生成 help。
8. **覆盖率表只列 2/13 个包**：README 测试覆盖率表只有 core 和 db9，给人覆盖不全的观感；要么补全要么改为徽章/链接 CI 报告。
9. **能力矩阵的维护成本**：四语 README 各有一份 ✅/❌ 矩阵，provider 能力变更需改 4 处（CHANGELOG 中已出现过 "README terminal capability updated from ❌ to ✅" 这类同步性修复）。长期可考虑由 conformance 测试结果生成矩阵。
10. **视觉资产单薄但方向正确**：像素画 banner 是唯一品牌资产。若未来出现 Web 控制台（cloud.sandbank.dev），建议以该像素风格为种子建立最小视觉规范（色板、机器人角色、图标），避免控制台与开源仓库观感割裂。
