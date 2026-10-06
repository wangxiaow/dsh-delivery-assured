<div align="center">

# dsh-delivery-assured · DeepSeek Harness（DSH）交付状态与验收门禁插件

**把「我到底还欠什么、上一次为什么没过、什么才算做完」变成会话里的一次工具调用。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.2-4c6ef5.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](#要求与兼容性)
[![Install](https://img.shields.io/badge/install-仓库%20URL-1f6feb.svg)](https://github.com/wangxiaow/dsh-delivery-assured)

**8 个 `delivery_*` 工具 · 1 个运行期 Skill · 受保护路径 guard · Global Kernel · 零运行时依赖 · 即装即用**

</div>

---

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，把
[Delivery-Assured 操作包](../../packages/delivery-assured) 的交付事实接进会话：Contract 还欠什么、
覆盖关系如何重算、可信起点在哪、预算还剩几次、这一次验证为什么没过。事实由操作包的脚本算出，
插件只负责**解析路径、构造参数、跑脚本、把 JSON 讲给模型听**——它不重新实现任何一项检查。

它只通过 `cordis.patch.yml` 挂载，**零修改侵入 DSH 源码**；安装单元就是本仓库根，装完自带操作包，
不需要 junction、`--patch` 或手工 `packRoot`/`projectRoot`。

## 装上之后会发生什么

- **打开任意普通项目，直接说需求即可。** 项目根取**会话自身的 workspace**，新项目会被当作
  bootstrap 生命周期的第 1/5 步，而不是报「没有可检查的项目」；已交付或进行中的项目则直接给出
  可信起点、还欠什么、最后一次失败、剩余预算与下一项验证。
- **完成不是自称。** `delivery_iteration action=close` 先让操作包重算 `Delivered`；不成立就拒绝，
  **一行不写**。本地的一切输出都是诊断，不是凭证。
- **验收改不动。** 受保护路径 guard 同步拒绝会话对 `.agent/CONTRACT.yaml`、`tests/acceptance/spec/**`、
  `.agent/standards/**`、`ci/verifier.yaml` 等标准的写入——包括通过 shell 命令绕过去。
- **每次请求都带着状态。** Global Kernel 把项目、候选、验证后端、`Delivered` 判定、还欠项、预算与
  下一步注入系统提示，因此模型不需要凭记忆复述历史。

## 安装

**正常路径：按仓库 URL 安装。** 在 DSH 里走 **添加插件 → 输入仓库地址 → 安装 → 启用**：

```text
https://github.com/wangxiaow/dsh-delivery-assured
```

仓库根的 `package.json` 是这个安装单元（`dsh.bundle.patch` → `dsh-bundle.patch.yml`），`files` 把插件与
`../../packages/delivery-assured` 一起打进安装包，所以**装完自带操作包**；`dsh.profile.bundles` 由插件
管理器自动加上这一行（即「启用」），项目根由 bundle patch 里的 `projectRoot: '.'` 按会话 cwd 每次调用解析，
因此不需要 junction、`--patch`、手工 `packRoot`/`projectRoot`，也不需要本机存在这份仓库的工作树。
想固定到某个项目或换 pack，在 profile 自己的 `cordis.patch.yml` 里按 id 覆盖那一行即可。

非 `desktop` 的 profile 也可以用命令行走同一个受管路径：

```sh
dsh plugin --profile <profile> add github:wangxiaow/dsh-delivery-assured
```

`desktop` profile 的 manifest 归运行中的应用所有，所以那个 profile 请在应用内用插件页安装，
不要在应用运行时用命令行改它。

只有**本机开发 / 离线**场景才需要下面的安装器（它从本地工作树链入、写 profile 的
`cordis.patch.yml`、跑自检）：

> **安全策略（因为犯过一次错）**：安装器**不会**修改正在运行的 `desktop` profile——那个 manifest 归应用的插件管理器所有，它会在运行时重写，而一行它加载不了的插件配置会直接打挂当前会话。对 `desktop` 默认只打印步骤并**一行不写**；只有应用**完全关闭**时显式加 `--enable-desktop` 才写入。`--profile-dir` 指向的临时 profile（试装）不受此限制。

```powershell
# 先看计划（不写任何文件）
node <repo>/plugins/dsh-delivery-assured/install.mjs --project <你的业务仓库> --dry-run
# 关闭 DeepSeek Harness 之后：
node <repo>/plugins/dsh-delivery-assured/install.mjs --project <你的业务仓库> --enable-desktop
# 撤销：node <repo>/plugins/dsh-delivery-assured/install.mjs --uninstall
```

它会：把 `link:` 依赖写进 profile、在 profile 自己的 `cordis.patch.yml` 写入插件行与
`packRoot`/`projectRoot` 配置（`dsh.profile.bundles` **不动**，那个字段归应用的插件管理器）、保留
`package.json.delivery-backup`，然后跑一遍插件 smoke 与 v0.3 §4.3 探针，并对你指定的项目跑一次
`resume` 打印摘要。装完必须**重启应用**才生效；不要在应用运行时改这些文件。

## 它注册什么

| 工具 | 回答的问题 |
|---|---|
| `delivery_gaps` | 某一阶段的结构缺口：未处置的清单项、未映射的义务、未解决的 unknown、缺负向验收的 Critical 规则、Contract 里残留的占位符 |
| `delivery_coverage` | 重算出的 `义务 → Slice → 验收 → 证据` 映射，`mvp` 或 `slice` 两种视图 |
| `delivery_resume` | 可信起点、还欠什么、最后一次失败、剩余预算、`Delivered` 判定、下一项验证 |
| `delivery_attempts` | 尝试预算、同一标准与用例集上的进展、振荡判定、是否需要 Replan |
| `delivery_verify_independent` | **默认完成路径**：宿主实际执行冻结验收（含冻结标准校验），写入 Evidence、运行日志与 receipt；FAIL 时点出具体门与 Required case |
| `delivery_verify_local` | 5+1 门，作为本地诊断（不是证据） |
| `delivery_ci` | 可选高保障后端：派发/观测受保护 CI 工作流（不持有 Baseline 凭据） |
| `delivery_iteration` | 追加式迭代日志；`close` 只在重算出的 `Delivered` 判定成立时放行 |
| `delivery-assured`（Skill） | 工作流程：义务发现、Slice 纪律、三问分流、停止规则、默认完成路径 |

工具输出一律带 `authority: local_diagnostic` 或对应的判定结果，**没有任何工具名暗示「写路径」**——
插件自己的测试会断言这一点。

## 它刻意不做什么

它**不会**让会话自己宣告完成。完成由证据算出：

- `delivery_iteration action=close` 先让操作包重算判定；不是 `Delivered` 就拒绝，**一行不写**。
- 默认完成路径是**宿主自己实际执行**冻结验收：`delivery_verify_independent` 逐门真正运行，
  Required 不能跳过、不能筛选，记录必须携带本次 run token、逐门退出码、保留日志摘要与 harness
  结果摘要；手写一个 `PASS` 文件无法通过校验。
- 按构造，工具无法选择 Required 集合、无法把失败标成通过：那些事实来自冻结 manifest、Slice 与
  累积 Spine，并在记录写完后由独立的判定函数重算。
- 只有受保护 CI 的 Promotion job 能推进 `refs/heads/baseline/*`；它是**可选的高保障后端**，
  不是普通项目完成的前提。会话结束、workflow 完成、模型回复 "DONE" 都不构成完成。
- `delivery_verify_local` 固定带 `--local`，永远不产出证据。

## 约束层：guard 与 Global Kernel

除了只读工具与 Skill，插件还装两道**约束层**（v0.3 §9.2 A、§4.3 第 6 项；v0.5 §12）：

| 控制 | 机制 | 边界 |
|---|---|---|
| 受保护路径 guard | `ctx.tools.guard()`：对 `write`/`edit`/`str_replace_editor` 的目标路径与 shell 命令做**同步判定**，命中受保护标准（`.agent/CONTRACT.yaml`、`.agent/project.yaml`、`.agent/standards/**`（冻结标准锚点）、`tests/acceptance/spec/**`、`ci/verifier.yaml`、`.agent/evidence/**`、`ci/evidence/**`、`ci/baseline/**`、`ci/recording/**`，以及仓库的 `.github/workflows/**`、`ci/tools/**`、`packages/delivery-assured/**`）或权威 ref（`refs/heads/baseline`、`refs/heads/delivery-state`、`refs/heads/standards`）就**拒绝**；拒绝是单调的，后续监听器无法翻回允许 | 只拒绝、不授予；`tests/acceptance/driver/**` 刻意不保护（它是 Candidate 的适配面）。它拦的是注册工具调用，不是任意代码执行——记录的可信性来自宿主验证路径自身的执行与冻结标准校验 |
| Global Kernel | `ctx.systemPrompt.variable('delivery_kernel')` + 一个引用它的 prompt 段：每次请求都带上项目、候选、**验证后端与 accepted issuer**、`Delivered` 判定、**权威状态的读取结果**、可信起点、还欠什么、Critical、预算、下一步，以及"你不能自己宣布完成 + 不要写受保护路径"的铁律 | 内容由操作包自己的 `resume.mjs --durable-state --state-transport <auto / gh / git>` 渲染（与 `delivery_resume`、`delivery_iteration(action=status)` 同一来源、同一通道与同一预算计算，不另建账本）；权威状态读不到时写的是"读取失败或降级……下列数字来自工作树，不是恢复结果"，平台本就没有该引用时写"平台没有 refs/heads/delivery-state/main（不是读取失败）"，`stateSource: worktree` 时写"未读取（工作树来源）"。provider 是同步的，所以文本有缓存，未就绪时明确写"尚未就绪"而不是编一个摘要 |

`v0.3 §4.3` 的七项控制由 `test/trust-boundary.test.mjs` 在**锁定宿主**上实测，并逐条给出结论
（含"模型步骤只能观察、不能被拒绝"这一限制），而不是假设插件层可作可信边界。

## 架构与协议

插件只有一层「桥」：解析 → 构造 argv → 跑脚本 → 讲 JSON。事实全部来自操作包，插件不复制任何检查。

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 导出 `apply` / `inject` / `name`，与 `cordis.patch.yml` 里那一行镜像 |
| `lib/host.js` | 注册工具、Skill、guard、kernel；按调用解析项目（宿主级缓存会复用到别的会话） |
| `lib/bridge.js` | 解析 `packRoot` / 项目根 / Node 可执行文件，拼命令行，收集结构化结果 |
| `lib/iterations.js` | 追加式迭代日志：`open` / `note` / `status` / `close`，空账本与坏行只报告不抛错 |
| `lib/bootstrap.js` | 新项目生命周期：五步顺序、完成度、可写窗口 |
| `lib/guard.js` | 受保护路径与权威 ref 的同步拒绝判定 |
| `lib/kernel.js` | Global Kernel 的 prompt 段与变量 |
| `lib/define-tool.js` | 只从宿主自己的运行时解析 `defineTool`，解析不到就**不注册任何工具** |
| `lib/skill.js` | 运行期 Skill 的正文与元数据 |
| `lib/ci-request.js` | `delivery_ci` 的参数→请求白名单：每个 action 只取自己声明的输入 |

关键契约：

- **工具注册是「宁少不坏」的。** 解析不到宿主自己的 `defineTool`、或版本不在声明的 peer 线上、
  或某个定义的参数 schema 不是 object 根，插件就**一个工具都不注册**（Skill、guard、kernel 照常加载，
  并打印修复指引）。直通实现会把作者格式的 spec 原样交给 provider，provider 直接拒绝整个请求
  （`Invalid schema for function ... got 'type: null'`）——这正是它曾经打挂会话的方式。
- **命令接口是 0.2.x 的** `resolve(request) → execute(spec) → handle.result()`：`execute` 返回进程句柄，
  输出在 `result()` 上。插件把会话的 `sandboxPolicy` 与 `signal` 透传给 shell，否则子进程不受会话
  沙箱模式约束。
- **工具输出 schema 必须落在 DSH 的强制 JSON Schema 子集内**：`{ type: 'object', additionalProperties: true }`。
  `additionalProperties` 必须显式声明，`{ type: 'json' }` 不在子集里——两者都会抛 `JsonSchemaError`，
  导致整个 profile 起不来。
- **运行期 Skill 的正文键名是 `content`。** 键名写错不会报错，而是注册一个加载不到内容的空 Skill，
  所以有专门的测试用真实注册表把正文读回来。

## 配置

按仓库 URL 安装时这些键**都不需要填**（`packRoot` 由安装包内的同级目录解析，`projectRoot` 由 bundle
patch 取会话 workspace）。本机开发路径或要固定项目时才用：

| 键 | 环境变量回退 | 默认 | 含义 |
|---|---|---|---|
| `packRoot` | `DSH_DELIVERY_PACK` | 安装包内同级 `packages/delivery-assured` | 含 `scripts/resume.mjs` 的目录 |
| `projectRoot` | `DSH_DELIVERY_PROJECT` | 会话 workspace | 要检查的交付仓库 |
| `nodeBin` | `DSH_DELIVERY_NODE` | `PATH` 上的 `node`，否则宿主运行时 | 运行脚本所用的 Node 可执行文件 |
| `ghBin` | `DSH_DELIVERY_GH` | `PATH` 上的 `gh` | `delivery_ci` 调用的 GitHub CLI |
| `workspace` | — | 进程 cwd | 项目发现用的回退目录 |
| `stateSource` | — | `durable-ref` | `worktree` 时只读工作树，不读 `refs/heads/delivery-state/main` |
| `stateTransport` | — | `auto` | 读权威状态的通道：`auto` / `gh` / `git` |
| `stateRepo` / `ciRepo` | `DSH_DELIVERY_CI_REPO` | 从 `origin` 推断 | CI 状态与工作流所属的 `owner/repo` |
| `repoRoot` | — | 项目根的上一级 | 仓库级 CI 材料所在根 |
| `protectRepoMaterial` | — | `true` | guard 是否连仓库级材料（`.github/workflows`、`ci/tools`、`packages/delivery-assured`）一起保护；操作包自身仓库开发时设 `false` |

优先级是单向的：插件配置 > 环境变量 > 从 workspace 向上发现。
**已配置的相对路径不会被继承来的环境变量悄悄替换**——这正是会话报告错仓库的常见原因。

## 要求与兼容性

- **DSH desktop `0.2.0-rc.2`**，peer 依赖 `@deepseek-ai/dsh-tools` `^0.2.0-rc.2`。
  版本必须与宿主**同一条线**：预发布版本之间不互相满足，所以 `^0.1.5-rc.3` 在 `0.2.0-rc.2`
  上会被判定为不兼容，而 `^0.2.0` 也匹配不到 `0.2.0-rc.2`。
- 插件**只从宿主自己的运行时**加载 `defineTool`：先是显式的 `DSH_DELIVERY_DSH_TOOLS_DIR`，
  然后是宿主本地载荷（`process.resourcesPath` 下的 `app.asar/dsh/node_modules`），最后才是
  `$DSH_HOME` 的 profile 目录。**解析不到或版本线不一致时，插件不注册任何工具**，拒绝原因是可读的，
  回归测试见 `test/host-resolution.test.mjs`。
- `gh` 只在 `delivery_ci` 用得到（它按绝对路径调用）。会话脚本不需要 `gh` 也能跑。

## 手工验证

改动插件或怀疑它没生效时，按这个顺序手工确认（不需要读源码）：

1. 在一个**干净 profile** 里按仓库 URL 安装，确认 `dsh.profile.bundles` 自动多出
   `dsh-delivery-assured`，且 `node_modules/dsh-delivery-assured` 是真实目录而不是链接。
2. `dsh --profile <p> --dump-config` 里应出现 `id: delivery-assured`，`config.projectRoot: .`。
3. 打开一个**空的普通目录**开一个会话，用自然语言提一个需求。预期：Skill 自动加载，
   `delivery_resume` 把该目录报成当前项目与 `bootstrap 1/5`，`delivery_iteration action=open`
   把需求原文写进该目录的 `.agent/ITERATIONS.jsonl`。
4. 试一次 `delivery_verify_local`：在没有 `ci/verifier.yaml` 时应**明确说还不能跑**，
   而不是编一个诊断结果。
5. 让会话尝试写 `.agent/CONTRACT.yaml` 之外的受保护标准（例如 `tests/acceptance/spec/` 下的文件）：
   guard 应当**同步拒绝**，并在消息里点名它属于受保护标准。
6. 把宿主换到另一条版本线（例如只提供 `0.1.5-rc.3` 的 CLI），确认插件**不注册工具**但
   Skill/guard/kernel 仍在，且启动日志给出可执行的修复指引。

## 已知限制

- **本地输出不是凭证。** `delivery_verify_local` 永远是 `local_diagnostic`；它通过不代表交付完成。
- **权威状态要读得到才算数。** Baseline 元数据、Evidence、尝试账本与累积 Spine 在
  `refs/heads/delivery-state/main`，读它需要 `gh` 或 `git` 能访问远端。读不到时报告写明
  「下列数字来自工作树，不是恢复结果」，**绝不**降级成「什么都不欠」。
- **经插件 shell 接缝读仓库仍有已知缺口。** 在真实宿主里，`delivery_resume` 经接缝调用脚本时
  可能报 `not a git repository` / 远端没有 `refs/heads/baseline/main`（脚本直跑正常）；
  `delivery_ci` 不受影响（它用绝对路径调 `gh`）。这条尚未修复，详见
  [REPAIR_NOTES](../../REPAIR_NOTES.md)。
- **工具注册要求宿主与 peer 同线。** 用不匹配的宿主运行时启动时，插件按设计只加载 Skill/guard/kernel，
  所以「装进某个 profile」不等于「工具一定可用」，必须用匹配的宿主验证。
- **guard 不是可信边界。** 它拦的是注册工具调用；模型步骤只能被观察、不能被拒绝（v0.3 §4.3 的 P7 部分可用）。
  记录的可信性来自宿主验证路径自身的执行与冻结标准校验。
- **安装器不碰运行中的应用。** 对 `desktop` profile 默认只打印步骤；这是刻意的自我约束，不是缺陷。
- **运行时隔离尚未实现。** 宿主后端按原样在候选工作树上执行，观测不到打包部署与隔离；这一点写在记录里，
  不作为已观测。参见 [自动交付说明](../../docs/AUTO_DELIVERY.md)。

## 构建与测试

```bash
node plugins/dsh-delivery-assured/test/smoke.mjs                 # 60 项
node plugins/dsh-delivery-assured/test/skill-registry.test.mjs   # 14 项
node plugins/dsh-delivery-assured/test/compatibility.test.mjs    # 91 项 / 2 个运行时
node plugins/dsh-delivery-assured/test/trust-boundary.test.mjs   # 26 项 / v0.3 §4.3 七项探针
node plugins/dsh-delivery-assured/test/host-resolution.test.mjs  # 87 项 / 宿主线与 provider schema
node plugins/dsh-delivery-assured/test/bootstrap-lifecycle.test.mjs  # 56 项 / bootstrap 生命周期
node plugins/dsh-delivery-assured/test/automation.test.mjs       # 自动化接口
node tools/install-plugin.test.mjs                               # 39 项 / 一键安装
```

计数是本次实测；**历史通过数不证明当前版本**，改动后应重新跑一遍再看输出。

- **compatibility** 是唯一能挡住「插件装不上」的测试。另外两个在裸 Node 上就能跑完，
  用的还是自己写的工具构造器与 shell 替身——这正是它们曾经**全绿而插件实际不可加载**的原因。
  它会：用 DSH 自己的 `evaluatePluginCompatibility` 判定本插件清单；用**宿主的真实 `defineTool`**
  注册全部工具（与 `tools.register()` 同一条投影与断言路径）；按 0.2.x 的 seam 真跑一个工具，
  并断言 `sandboxPolicy` 被透传到 shell 请求。桌面版把包放在 `app.asar` 内，只有 Electron 打过补丁的
  文件系统能读，所以该目标用 `ELECTRON_RUN_AS_NODE=1` 重跑本文件；插件会先复制到临时目录，避免从环境
  解析到另一条版本线。**每个目标都断言「加载到的 defineTool 版本 == 该目标提供的版本」**，因此悄悄
  退回错副本会失败。
- **smoke**：像会话一样驱动插件，对着真实项目的临时副本跑：解析 pack、通过真实 shell 运行真实脚本、
  检查工具与 Skill 注册，并断言 guard 拒绝受保护写入、放行 driver 与只读工具、Kernel 段被注册且内容
  不含糊，以及**配置损坏时给出诊断而不是抛异常**。
- **trust-boundary**：在锁定宿主上回答 v0.3 §4.3 的七项控制，逐条给结论而不是给保证。
- **skill-registry**：驱动插件自身的 `apply`，再用 DSH 真实的 `SkillRegistry` 把 Skill 读回来
  （`get()` 会重新校验定义）。带负向对照：缺正文的定义必须在同一路径上被拒绝。该测试需要 DSH 侧包，
  因此按 `$DSH_HOME/profiles/node_modules` → 当前目录 → 插件目录依次解析；**全部失败时返回 2 而不是
  跳过**——跳过会让一个坏 Skill 静默出厂。

本仓库的 `node project/scripts/verify-build.mjs` 会把上面这些套件连同操作包的回归一起跑一遍。

## 许可证

[MIT](LICENSE) © 2026 wangxiaow
