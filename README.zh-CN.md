# dsh-subagent-admission

[English](README.md)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
子代理的实验性**共享生命周期准入协议与参考策略内核**。

本项目针对官方仓库
[Discussion #131](https://github.com/deepseek-ai/deepseek-harness/discussions/131)
报告的故障形态：嵌套子代理可以持续扩张，直至一个 Web Host 失去响应。
它不是另一个编排器，而是把“是否允许创建或重新激活子代理”变成所有官方
runtime 调用者共同经过的、原子的、由真实生命周期持有的决策。

> **候选版本状态：** `0.1.0-rc.1` 目前只是本地、尚未发布的候选版本。
> 这是独立社区项目，不是 DeepSeek 官方组件，未获得 DeepSeek 背书或采纳，
> 也没有生产环境验证。

## 为什么需要共享协议

现有 DSH 插件已经解决了一些真实问题。`dsh-background-agents` 会限制由它
自己的工具发起的启动、按 parent 串行化这些启动，并统计已有 continuable
children；AgentTeams 限制团队成员数量；Delegate 对显式依赖进行门控。
这些都是应该承认的前例，而不是可以抹掉的空白。

剩余的 infra 问题不同：工具内部的锁无法原子约束同时由内置工具、其他插件、
provider、SDK 或直接 `ctx.subagents` 调用发起的启动。Host 级容量规则还必须
覆盖 one-shot、continuable、cold resume 和官方 cleanup 边界。当前逐项主源
比较记录在[生态审计](compatibility/ecosystem-audit.md)中。

因此本仓库明确分成两部分：

- 一个最小、可选的 **protocol-v1 runtime seam**：在 provider 工作或 child
  materialisation 前请求准入，并报告 bind/release 生命周期边；
- 一个外置的**参考策略内核**：实现原子的 global/root active 容量、持久化的
  root/parent 累计配额、所有权恢复、类型化拒绝、遥测和只读原生 GUI。

面向官方的贡献是小协议；完整插件只是一个策略实现和 conformance 载体，
并不是要求把整个产品表面搬进 DSH core。

## 真实的运行模式

| 模式 | Runtime | 行为 |
| --- | --- | --- |
| **Audit** | npm 原版 `@deepseek-ai/dsh-subagent@0.1.0-rc.6` | 观察和解释活动，绝不声称能够阻止启动。 |
| **Strict** | 精确 patched source target `47f943859bef60e4160492346772ded9b24f765a` / source package `0.1.0-rc.5` | 注册 protocol v1，在 provider 工作前执行全有或全无的准入。 |
| **Unavailable** | 任何未经验证或条件不完整的 Strict 环境 | fail closed，不静默降级为 Audit 或原版行为。 |

仅有 semver 或方法存在不够。精确 source identity、protocol version、patch
hash、storage/bootstrap 状态和单进程 ownership guard 必须全部匹配。详见
[兼容性说明](docs/compatibility.md)。

## 策略语义

v0.1 没有队列，采用 fail-fast。默认值来自启动配置，GUI 不可修改：

| 限制 | 默认值 | 含义 |
| --- | ---: | --- |
| Global active | 6 | 当前 DSH 进程中的 live subagent activations |
| Per-root active | 4 | 一个持久化 root conversation 拥有的 live activations |
| Per-root admitted total | 24 | root 进入 coverage 后允许的新 child 总数 |
| Per-parent admitted children | 8 | coverage 后一个 parent 允许的新 direct children 总数 |

新的 one-shot 和 continuable child 同时消耗 active 与累计容量。Cold resume
只重新消耗 active，不再次消耗累计配额；resident follow-up 复用已有 activation，
不新增消耗。已经接受的 permit 会一直持有到官方 runtime 达到 quiescent
cleanup；仅仅返回 result 不是释放证据。

v0.1 不提供等待队列、优先级、抢占、强制释放、配额重置或 GUI 写操作。

## 构建和安装候选包

前置要求：Node `^22.19.0 || >=24.0.0`，pnpm `11.7.0`。

```bash
pnpm install --frozen-lockfile
pnpm pack:plugin
pnpm exec dsh plugin --profile web add \
  "$(pwd)/dist/dsh-subagent-admission-0.1.0-rc.1.tgz"
```

bundle 默认是 Audit。这个命令不会让原版 DSH 获得容量 enforcement。Strict
只适用于[最小 upstream seam 提案](docs/upstream-seam.md)中记录的精确 source
target 和 reference patch：

`patches/dsh-subagent-admission-seam.patch` SHA-256：
`1340a9ffabde8310f68a7d66c4dacecda5dba263dd51666740801f5ec2c69135`。

```bash
# 证明 fixture 在未打 patch 的目标上是 RED。
pnpm exec tsx scripts/verify-seam-patch.mts --expect-unpatched-failure

# 在一次性精确目标 worktree 中应用并验证 protocol v1。
pnpm exec tsx scripts/verify-seam-patch.mts
```

这些命令都不会调用模型。安装 tarball、收到 HTTP 200 或渲染 GUI，都不是
模型/API、生产部署、采用或官方接受的证据。

## 架构

```mermaid
flowchart LR
  C["内置工具、插件、provider、SDK 调用者"] --> R["官方 SubagentRuntime"]
  R --> V["普通 DSH validation"]
  V --> P["Protocol-v1 prepare"]
  P -->|拒绝| D["类型化 fail-fast denial"]
  P -->|permit| M["Provider 工作与 materialisation"]
  M --> B["绑定 child identity"]
  B --> Q["官方执行与 child-owned cleanup"]
  Q --> X["Quiescent release"]
  P <--> K["参考策略内核"]
  K --> L["持久化累计 ledger"]
  K --> A["进程内 active leases"]
  K --> O["只读 snapshot 与原生 GUI"]
```

协议不会接收 prompt、模型输出、tool arguments、provider 对象、`Agent`、
credentials 或 disposal authority。详细不变量见[架构说明](docs/architecture.md)。

## 原生只读 GUI

![Admission Control 界面](docs/assets/admission-control.png)

该图片由隔离的 packed DSH Web profile 在 1440×900 自动截取。它证明 package
能在原生 conversation UI 中启动、保留 Chat 与 Trajectory tabs、渲染四张
quota cards 和有界历史，并且没有 mutation controls。它只是自动化本地集成
与视觉证据，不是人工评审、模型运行、生产部署或 DeepSeek 背书。

## 可复现证据

机器生成的证据放在被忽略的 `evidence/`。仓库跟踪 producer、validator 和一张
晋升后的截图，而不把某一台机器的 JSON 冒充成普适证明。

```bash
pnpm baseline:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e -- tests/packed-install.e2e.ts
pnpm release:evidence
pnpm release:evidence:check
```

release evidence collector 会生成并校验：

- 精确目标 Strict 与原版 Audit conformance；
- JSON 和 SQLite crash/restart persistence fixtures；
- packed Audit/Strict 安装和原生 GUI capture；
- 带环境身份的原始 admission timing samples；
- 对 #131 的有界、无模型结构复现；
- 绑定 source fingerprint、patch、package、client bundle、reports 和晋升截图
  的 hash manifest。

安全边界见[复现说明](docs/reproduction.md)。GitHub Actions 已配置 Linux Node
22.19/24 和 macOS/Windows Node 24 smoke，但“已经配置”不等于这个尚未发布的
branch 上“已经执行”。本地证据与远端证据始终分开。

## 明确边界

- 正确性范围是一个 cooperative DSH host process；没有多进程、多 host 或
  distributed lock。
- 这是 admission control，不是 OS process isolation、内存沙箱、provider
  rate limit、token budget、调度或编排。
- Audit 只能观察；只有精确验证的 protocol-v1 target 才能 enforce。
- 累计配额从明确的安全 bootstrap 开始，不重建或虚构历史工作。
- 恶意的进程内插件处在同一 Host trust boundary；v0.1 不隔离 peer plugins。
- reference patch 是提案和测试载体，不是已经被 upstream 接受的修改。

## 项目文档

- [架构与不变量](docs/architecture.md)
- [兼容矩阵与升级 gate](docs/compatibility.md)
- [最小 upstream seam](docs/upstream-seam.md)
- [新颖性与生态审计](compatibility/ecosystem-audit.md)
- [安全复现 #131](docs/reproduction.md)
- [安全策略](SECURITY.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)
- [变更记录](CHANGELOG.md)

## License

MIT，详见 [LICENSE](LICENSE)。DeepSeek Harness 和其他第三方组件保留各自的
license 与 notices。
