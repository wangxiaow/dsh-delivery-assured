<div align="center">

# dsh-delivery-assured

**把 Delivery-Assured 的五个只读查询接进 DSH 会话。**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。
会话在开始、恢复或卡住时，用一条工具调用问出「我到底还欠什么」——
而不是靠回忆或让模型自己维护第二份状态。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-desktop%200.2.0--rc.2-blue.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Runtime deps: 0](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](#要求与兼容性)
[![Tests](https://img.shields.io/badge/tests-63%20checks-success.svg)](#测试)

</div>

---

## 它注册什么

| 工具 | 回答的问题 |
|---|---|
| `delivery_gaps` | 某一阶段的结构缺口：未处置的清单项、未映射的义务、未解决的 unknown、缺负向验收的 Critical 规则、Contract 里残留的占位符 |
| `delivery_coverage` | 重算出的 `义务 → Slice → 验收 → 证据` 映射，`mvp` 或 `slice` 两种视图 |
| `delivery_resume` | 可信起点、还欠什么、最后一次失败、剩余预算、下一项验证 |
| `delivery_attempts` | 尝试预算、同一标准与用例集上的进展、振荡判定、是否需要 Replan |
| `delivery_verify_local` | 5+1 门，作为本地诊断 |
| `delivery-assured`（Skill） | 工作流程：义务发现、三处人工触点、Slice 纪律、三问分流、停止规则 |

## 它刻意不做什么

这里**没有任何**工具会写 Evidence、推进 `refs/heads/baseline/*`、
记录已批准的标准，或宣告 `MVP_READY`。这不是遗漏：

- 只有受保护的 CI 验证 job 产出 `evidence.json`。
- 只有 CI Promotion job 持有推进受保护 baseline 引用的凭据。
- 会话结束、workflow 完成、模型回复 "DONE"，都不构成晋升。
- `delivery_verify_local` 固定带 `--local`，会话内无法触达证据模式。

插件自己的测试会断言**没有任何已注册工具名暗示写路径**。

## 它另外做的两件"转向"控制

除了只读工具与 Skill，插件还装两道**约束层**（v0.3 §9.2 A、§4.3 第 6 项；v0.5 §12）：

| 控制 | 机制 | 边界 |
|---|---|---|
| 受保护路径 guard | `ctx.tools.guard()`：对 `write`/`edit`/`str_replace_editor` 的目标路径与 shell 命令做**同步判定**，命中受保护标准（`.agent/CONTRACT.yaml`、`.agent/project.yaml`、`tests/acceptance/spec/**`、`ci/verifier.yaml`、`.agent/evidence/**`、`ci/evidence/**`、`ci/baseline/**`、`ci/recording/**`，以及仓库的 `.github/workflows/**`、`ci/tools/**`、`packages/delivery-assured/**`）或权威 ref（`refs/heads/baseline`、`refs/heads/delivery-state`、`refs/heads/standards`）就**拒绝**；拒绝是单调的，后续监听器无法翻回允许 | 只拒绝、不授予；`tests/acceptance/driver/**` 刻意不保护（它是 Candidate 的适配面）。它拦的是注册工具调用，不是任意代码执行——真正的信任仍在 CI |
| Global Kernel | `ctx.systemPrompt.variable('delivery_kernel')` + 一个引用它的 prompt 段：每次请求都带上项目、候选、可信起点、还欠什么、Critical、预算、下一步，以及"本地不是凭证 + 不要写受保护路径"的铁律 | 内容由操作包自己的 `resume.mjs --offline` 渲染（同一套事实，不另建账本）；provider 是同步的，所以文本有缓存，未就绪时明确写"尚未就绪"而不是编一个摘要 |

`v0.3 §4.3` 的七项控制由 `test/trust-boundary.test.mjs` 在**锁定宿主**上实测，并逐条给出结论（含"模型步骤只能观察、不能被拒绝"这一限制），而不是假设插件层可作可信边界。

## 安装

> **安全策略（因为犯过一次错）**：安装器**不会**修改正在运行的 `desktop` profile——那个 manifest 归应用的插件管理器所有，它会在运行时重写，而一行它加载不了的插件配置会直接打挂当前会话。对 `desktop` 默认只打印步骤并**一行不写**；只有应用**完全关闭**时显式加 `--enable-desktop` 才写入。`--profile-dir` 指向的临时 profile（试装）不受此限制。

```powershell
# 先看计划（不写任何文件）
node <repo>/plugins/dsh-delivery-assured/install.mjs --project <你的业务仓库> --dry-run
# 关闭 DeepSeek Harness 之后：
node <repo>/plugins/dsh-delivery-assured/install.mjs --project <你的业务仓库> --enable-desktop
# 撤销：node <repo>/plugins/dsh-delivery-assured/install.mjs --uninstall
```

它会：把 `link:` 依赖写进 profile、在 profile 自己的 `cordis.patch.yml` 写入插件行与 `packRoot`/`projectRoot` 配置（`dsh.profile.bundles` **不动**，那个字段归应用的插件管理器）、保留 `package.json.delivery-backup`，然后跑一遍插件 smoke 与 v0.3 §4.3 探针，并对你指定的项目跑一次 `resume` 打印摘要。
装完必须**重启应用**才生效；不要在应用运行时改这些文件。

手工步骤（与上面等价，供核对或受限环境使用）：

```powershell
# 1. 让 profile 能看到插件，然后链进去
cd "$env:USERPROFILE\.dsh\profiles\<profile>"
pnpm add "link:<repo>/plugins/dsh-delivery-assured"

# 2. 把 bundle 加进该 profile 的 package.json
#    "dsh": { "profile": { "bundles": [ ..., "dsh-delivery-assured" ] } }

# 3. 指向 pack 与项目：写进该 profile 自己的 cordis.patch.yml（按 id 覆盖，不要重复 insert）
#    DSH 的组合顺序是「各 bundle 的 patch → profile 的 cordis.patch.yml → $DSH_HOME/cordis.patch.yml」
#    cordis.patch.yml:
#      - id: delivery-assured
#        config:
#          packRoot: <repo>/packages/delivery-assured
#          projectRoot: <repo>/project
```

## 配置

| 键 | 环境变量回退 | 含义 |
|---|---|---|
| `packRoot` | `DSH_DELIVERY_PACK` | 含 `scripts/resume.mjs` 的目录 |
| `projectRoot` | `DSH_DELIVERY_PROJECT` | 要检查的交付仓库 |
| `nodeBin` | `DSH_DELIVERY_NODE` | 运行脚本所用的 Node 可执行文件 |
| `workspace` | — | 项目发现用的回退目录 |

优先级是单向的：插件配置 > 环境变量 > 从 workspace 向上发现。
**已配置的相对路径不会被继承来的环境变量悄悄替换**——这正是会话报告错仓库的常见原因。

## 要求与兼容性

- **DSH desktop `0.2.0-rc.2`**，peer 依赖 `@deepseek-ai/dsh-tools` `^0.2.0-rc.2`。
  版本必须与宿主**同一条线**：预发布版本之间不互相满足，所以 `^0.1.5-rc.3` 在 `0.2.0-rc.2`
  上会被判定为不兼容，而 `^0.2.0` 也匹配不到 `0.2.0-rc.2`。
- 插件**只从宿主自己的运行时**加载 `defineTool`：先是显式的 `DSH_DELIVERY_DSH_TOOLS_DIR`，
  然后是宿主本地载荷（`process.resourcesPath` 下的 `app.asar/dsh/node_modules`），最后才是
  `$DSH_HOME` 的 profile 目录。**解析不到或版本线不一致时，插件不注册任何工具**：
  - 直通实现会把作者格式的 spec 原样交给 provider（`input_schema: tool.parameters`），
    provider 直接拒绝整个请求（`Invalid schema for function ... got 'type: null'`）；
  - 另一条版本线（例如 profile 调色板里的 `0.1.5-rc.3`）编译出的定义同理不可用；
  - 预发布线互不满足，所以必须与 `peerDependencies` 声明的那条线完全一致；
  - 注册前还会逐个自检 `schemaIsProviderSafe()`（object 根、无 `type: null`）。
  拒绝时技能、guard、内核照常加载，并打印修复指引——**宁可少五个工具，也不打挂会话**。
  回归测试：`test/host-resolution.test.mjs`。
- 命令接口是 0.2.x 的 `resolve(request) → execute(spec) → handle.result()`：
  `execute` 返回进程句柄，输出在 `result()` 上。插件同时把会话的 `sandboxPolicy` 与 `signal`
  透传给 shell，否则子进程不受会话沙箱模式约束。
- 工具输出 schema 必须落在 DSH 的强制 JSON Schema 子集内：
  `{ type: 'object', additionalProperties: true }`。
  **`additionalProperties` 必须显式声明**，且 `{ type: 'json' }` 不在该子集里——
  两者都会抛 `JsonSchemaError`，导致整个 profile 起不来。
- 运行期 Skill 的正文键名是 `content`。**键名写错不会报错**，而是注册一个加载不到内容的空 Skill，
  所以有专门的测试用真实注册表读回正文。

## 测试

```bash
node plugins/dsh-delivery-assured/test/smoke.mjs                 # 69 项
node plugins/dsh-delivery-assured/test/skill-registry.test.mjs   # 13 项
node plugins/dsh-delivery-assured/test/compatibility.test.mjs    # 67 项 / 2 个运行时
node plugins/dsh-delivery-assured/test/trust-boundary.test.mjs   # 26 项 / v0.3 §4.3 七项探针
node plugins/dsh-delivery-assured/test/host-resolution.test.mjs  # 27 项 / 宿主线与 provider schema
node tools/install-plugin.test.mjs                               # 26 项 / 一键安装
```

- **compatibility** 是唯一能挡住「插件装不上」的测试。另外两个在裸 Node 上就能跑完，
  用的还是自己写的工具构造器与 shell 替身——这正是它们曾经**全绿而插件实际不可加载**的原因。
  它会：
  1. 用 DSH 自己的 `evaluatePluginCompatibility` 判定本插件清单；
  2. 用**宿主的真实 `defineTool`** 注册五个工具（与 `tools.register()` 同一条投影与断言路径）；
  3. 按 0.2.x 的 seam（`resolve → execute → result`）真跑一个工具，并断言
     `sandboxPolicy` 被透传到 shell 请求。
  桌面版把包放在 `app.asar` 内，只有 Electron 打过补丁的文件系统能读，所以该目标用
  `ELECTRON_RUN_AS_NODE=1` 重跑本文件；插件会先复制到临时目录，避免从环境解析到另一条版本线。
  **每个目标都断言「加载到的 defineTool 版本 == 该目标提供的版本」**，因此悄悄退回错副本会失败。
- **smoke**：像会话一样驱动插件，对着真实项目的临时副本跑：解析 pack、
  通过真实 shell 运行真实脚本、检查工具与 Skill 注册，并断言 guard 拒绝受保护写入、
  放行 driver 与只读工具、Kernel 段被注册且内容不含糊，以及**配置损坏时给出诊断而不是抛异常**。
- **trust-boundary**：在锁定宿主上回答 v0.3 §4.3 的七项控制（见下），逐条给结论而不是给保证。
- **skill-registry**：驱动插件自身的 `apply`，再用 DSH 真实的 `SkillRegistry` 把 Skill 读回来
  （`get()` 会重新校验定义）。带负向对照：缺正文的定义必须在同一路径上被拒绝。
  该测试需要 DSH 侧包，因此按 `$DSH_HOME/profiles/node_modules` → 当前目录 → 插件目录依次解析；
  **全部失败时返回 2 而不是跳过**——跳过会让一个坏 Skill 静默出厂。

## 许可证

[MIT](LICENSE) © 2026 wangxiaow
