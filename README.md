<div align="center">

# Delivery-Assured Progressive SE

**让遗漏能被发现，让未完成项不能消失，让旧能力每次被重验。**

一套围绕四个权威对象（Contract / Coverage / Evidence / Baseline）构建的交付约束，
以 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 为执行底座，
把方案封装成**可安装的 DSH 插件**与**可复用的操作包**。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](https://nodejs.org)
[![Runtime deps: 0](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](#仓库结构)
[![CI](https://github.com/wangxiaow/dsh-delivery-assured/actions/workflows/verify.yml/badge.svg)](https://github.com/wangxiaow/dsh-delivery-assured/actions/workflows/verify.yml)
[![Implementation](https://img.shields.io/badge/implementation-v0.5-blueviolet.svg)](README.md)

开发状态：本轮修复和本地回归记录见[修复报告](REPAIR_NOTES.md)；**运行时隔离仍未实现，已按 owner 决定从晋升硬门禁降级为写入 Baseline 元数据的告警**（真实隔离后端仍是欠账），部署门现在有了真实生产者（`ci-deploy-probe.mjs` 把打包产物装进干净目录并实际运行，再报告观测到的 revision 与 digest），未计数历史恢复仍欠工程实现；已增加精确 collector 手工重跑、单漏项定时补录请求及 counted-failure 留痕 resolution，但真实平台调度与审批尚未核验。尚未取得真实 CI Evidence、受保护 Baseline 晋升或真实部署证据；本地测试通过非完成，不宣称 MVP_READY。当前已有 origin/main 与 origin/standards/acceptance 本地跟踪引用，远端权限、保护和 CI 是否生效未核实；不是“无远端仓库”。

</div>

---

## 这个项目解决什么

用编码 Agent 从零做项目时，自由开发流程通常围绕「当前任务、当前报错、当前上下文」前进，
而交付要求同时维护「整个产品还欠什么、什么算做对、旧能力是否还在、目标环境能否运行」。
这几件事没有稳定的外部依据时，**局部进展会被误认成整体进展**。

典型后果：需求只在聊天里出现过；隐式义务没有问出来；任务清单只覆盖页面和接口；
实现者顺手修改验收；修复当前错误破坏旧流程；沿用旧版本 PASS；
最后才发现登录回调、迁移、配置或完整用户旅程跑不通。

本项目把方案落成可执行的东西：交付模板、三类项目清单、诊断脚本、
三个 CI 工作流、一套权限声明，以及一个把它接进 DSH 会话的插件。

## 核心设计：权威边界

> **本地的一切输出都不是完成凭证。**

这是整套东西最重要的一条，也是它区别于「又一个 agent 框架」的地方：

| 层 | 承担者 | 负责什么 |
|---|---|---|
| Agent 执行底座 | DeepSeek Harness | 运行模型与会话，提供文件/命令工具，加载 Skill |
| 项目交付规则 | 本仓库 | 模板、五个脚本、验收分层、覆盖计算、预算规则 |
| **权威交付状态** | **外部 CI 与仓库权限** | 验证固定 Candidate、保存 Evidence、保护标准、晋升 Baseline |

具体约束：

- `verify.mjs` 本地只产出诊断。退出码 0 只代表「这次指定的检查在这台机器上通过」。
- [verify 工作流](.github/workflows/verify.yml)保留观测产物；独立 CI 消费者确认精确来源。当前运行时隔离尚未实现或实证，这些观测不能冒充权威 Evidence。
- 只有 `promote.yml` 的 Promotion job 持有推进 `refs/heads/baseline/*` 的凭据。
- 插件暴露的五个工具**全部只读**，不写 Evidence、不晋升、不宣告 `MVP_READY`。
- `.agent/STATE.yaml` 的 `DONE` 不是完成证据；Coverage 只从 Contract 与 CI 记录重算。

## 功能特性

- **分阶段结构检查** — `check-gaps` 有 `contract` / `acceptance` / `slice` / `mvp` 四个阶段，
  避免「还没写测试就不能检查 Contract」这类循环依赖。
- **可重算的 Coverage** — 从 Contract、冻结的验收清单与 CI 记录重新计算
  `义务 → Slice → 验收 → 证据`。不读任务清单，不读 `STATE` 里的 DONE。
- **spec / driver 分层** — 行为断言与语义接口在受保护的 `spec/`，
  连接真实系统的适配器在可修改的 `driver/`。CI 扫描 driver 是否含断言语法。
- **Critical Rule 强制派生负向验收** — 每条 Critical 规则声明主体、资源、操作、边界、
  允许结果与拒绝后的数据不变条件；脚本据这些字段检查必需的正负向 case 映射。
- **预算与收敛判断** — 同根因上限、无进展窗口、振荡检测、Replan 记录。
  换会话、改 Slice 名或 Replan 都不清零累计预算。
- **候选优先状态机** — `PLANNED → … → BASELINE_PROMOTION → VERIFIED_DONE`，
  只有远端受保护引用已晋升且证据绑定匹配，才派生完成状态。
- **零运行时依赖** — 脚本、CI 工具、CLI 与插件全部只用 Node 内置模块。
  自带的 YAML 子集解析器有回归测试，并在构建门里强制执行。

## 仓库结构

```text
.
├── .github/
│   ├── workflows/                  # verify.yml / promote.yml（GitHub 实际执行的位置）
│   └── CODEOWNERS                  # 受保护路径的责任边界
├── ci/
│   ├── tools/                      # ci-spec-diff / ci-standards-diff / ci-promote / verify-artifact
│   └── protection/                 # 分支保护声明与生效步骤
├── packages/delivery-assured/      # 操作包：可复制到任意项目的交付物
│   ├── templates/                  #   INTENT.md / ELICITATION.md / CONTRACT.yaml / AGENTS.md
│   │   └── checklists/             #   web_saas.yaml / cli.yaml / api.yaml
│   ├── scripts/                    #   五个脚本 + lib/ 共享事实计算
│   └── tests/                      #   YAML 解析器与模板完整性 unit 测试
├── plugins/dsh-delivery-assured/   # DSH 插件：五个只读工具 + 一个运行期 Skill
├── integrations/deepseek-harness/  # DSH 接入记录：锁定版本、实测坑、完成标准对照
├── project/                        # 首个真实项目（本操作包自身）
│   ├── docs/                       #   INTENT.md / ELICITATION.md
│   ├── .agent/                     #   CONTRACT.yaml / STATE.yaml / slices/ / project.yaml
│   ├── tests/acceptance/           #   spec/（受保护）+ driver/（可修改）
│   ├── tests/spine/                #   回归 Spine 累积清单
│   ├── scripts/                    #   六个门的实现
│   └── src/                        #   delivery CLI
└── tools/                          # 本地演练与自检
```

## 快速开始

需要 **Node ≥ 20**。无运行时依赖，无需 `npm install`。

```bash
git clone https://github.com/wangxiaow/dsh-delivery-assured.git
cd dsh-delivery-assured/project

# 1. 结构检查（分阶段）
node ../packages/delivery-assured/scripts/check-gaps.mjs --phase contract
node ../packages/delivery-assured/scripts/check-gaps.mjs --phase acceptance
node ../packages/delivery-assured/scripts/check-gaps.mjs --phase slice --slice S1

# 2. 覆盖视图（mvp = 整个 Contract 是否闭合）
node ../packages/delivery-assured/scripts/coverage.mjs --view mvp

# 3. 换会话后的第一件事：恢复可信起点
node ../packages/delivery-assured/scripts/resume.mjs --offline

# 4. 本地验证（诊断，不是证据）
node ../packages/delivery-assured/scripts/verify.mjs --local --slice S1

# 5. 产品视角：我到底还欠什么
node src/cli.mjs status
```

所有脚本同时支持人读摘要与 `--json`，退出码统一为
`0` 通过 / `1` 发现阻塞 / `2` 输入或工具错误。

### 安装 DSH 插件

```bash
cd "$DSH_HOME/profiles/<profile>"
pnpm add "link:<repo>/plugins/dsh-delivery-assured"
# 并把 "dsh-delivery-assured" 加进该 profile package.json 的 dsh.profile.bundles
```

配置项（也可用环境变量）：`packRoot`（`DSH_DELIVERY_PACK`）、
`projectRoot`（`DSH_DELIVERY_PROJECT`）、`nodeBin`（`DSH_DELIVERY_NODE`）。

**兼容性**：插件面向 **DSH desktop `0.2.0-rc.2`**，peer 依赖
`@deepseek-ai/dsh-tools` `^0.2.0-rc.2`。预发布版本之间不互相满足，所以只写版本线、
不写具体预发布标签是行不通的（`^0.2.0` 匹配不到 `0.2.0-rc.2`）。
DSH 在加载前会用自己的 `evaluatePluginCompatibility` 判定清单，不匹配就拒绝加载整个 bundle。

改完插件后 `node plugins/dsh-delivery-assured/test/compatibility.test.mjs` 会用**宿主真实的
`defineTool`** 与 0.2.x 的 shell seam 复验一次；它已被接入构建门，改名或降级接口都会让构建失败。

## 本地复核方法与开发状态

下面列出复核命令，不宣称最新测试数已经验证。宿主相关测试需要声明的 DSH 环境；本轮不访问用户 profile、不联网。模板测试仅为 unit，不修改或替代受保护验收 spec。

从仓库根目录运行 unit 与本地自检：

```bash
node packages/delivery-assured/tests/yaml.test.mjs
node --test packages/delivery-assured/tests/templates.test.mjs
node plugins/dsh-delivery-assured/test/smoke.mjs
node plugins/dsh-delivery-assured/test/skill-registry.test.mjs
node plugins/dsh-delivery-assured/test/compatibility.test.mjs
node tools/ci-preflight.test.mjs
node tools/markdown-structure.test.mjs
node tools/build-gate-absent-plugin.test.mjs
node tools/local-promotion-drill.mjs
cd project && node ../packages/delivery-assured/scripts/verify.mjs --local --slice S1
```

| 范围 | 当前声明边界 |
|---|---|
| unit、插件自检、preflight、本地六个门 | 本地诊断；结果与计数须以本次实际输出为准，历史通过数不证明当前版本 |
| 晋升链路本地演练 | 测试夹具/模拟链路，不是真实 CI Evidence、远端保护或 Baseline 晋升 |
| DSH profile 加载与组合 | 接入文档保留历史记录；当前宿主与重启效果待复核 |
| 真实 CI、Baseline、部署及最终 Review | 尚未取得当前版本的真实证据，交付未完成 |

业务脚本及 CLI 必须从 project/ 运行（如上面的 `cd project`），或显式指定实际项目路径；根目录是操作包仓库，不是业务输入根。模板仍为 draft/unknown，需完成产品澄清与确认，字段齐全不等于 Gate 通过。

### 为什么需要一个「运行时契约」测试

另外两个插件测试在裸 Node 上就能跑完：它们用自己写的工具构造器，再加一个自己写的 shell 替身。
结果是**在插件实际无法被 DSH 加载时，它们仍然全绿**——peer 版本线写错、输出 schema 少一个
必需字段、shell 接口从 `run()` 改成 `execute().result()`，这三点一个都没被它们发现。

`test/compatibility.test.mjs` 补上这一层，而且是唯一能挡住「装不上」的测试：

- 用 DSH 自己的 `evaluatePluginCompatibility` 判定清单，而不是自己复述一遍版本规则；
- 用宿主**真实的 `defineTool`** 注册五个工具，走 `tools.register()` 同一条投影与断言路径；
- 按 0.2.x 的 seam 真跑一个工具，并断言 `sandboxPolicy` 被透传，否则子进程不受会话沙箱约束。

桌面版把包放在 `app.asar` 内，只有 Electron 打过补丁的文件系统能读，所以该目标用
`ELECTRON_RUN_AS_NODE=1` 重跑本文件。插件先复制到临时目录，避免从环境解析到另一条版本线；
每个目标都断言**加载到的 `defineTool` 版本 == 该目标提供的版本**，所以悄悄退回错副本会失败。


### CI preflight 是什么

本地 origin/main 与 origin/standards/acceptance 跟踪引用已经存在，但不证明远端权限、分支保护或真实 CI 可用。`tools/ci-preflight.test.mjs` 在真实 CI 接通前检查静态缺陷，它检查：

- workflow 确实位于 `.github/workflows/`（放在包内部 GitHub 永远不会执行）
- 每个 `node <path>` 在磁盘上真实存在
- 每个 `uses:` 动作格式正确且锁定主版本
- 每个 job 有 runner 与 steps，每个 step 声明了 `run` 或 `uses`
- `cp -r` 的源存在（`set -e` 下源不存在会直接失败）
- 文件是合法 UTF-8、没有替换字符、**没有命令被吞进注释里**
- 部署门有真实的生产者，而不是把注入值回显一遍

它**不能**检查 GitHub 是否接受这份 YAML、runner 镜像里是否有对应工具、
secrets 是否存在。那些只有真实推送才能验证。

## 接进你自己的项目

1. 复制 `packages/delivery-assured/` 到你的工具位置，或在 DSH profile 里 `link:` 它。
2. 用模板写出 `docs/INTENT.md`、`docs/ELICITATION.md`、`.agent/CONTRACT.yaml`。
3. 写 `.agent/project.yaml`：路径、尝试预算、baseline 引用、trusted issuer。
4. 写 `ci/verifier.yaml`：六个门的命令，以及**在 Contract 中有理由的**排除项。
5. 跑 `check-gaps --phase contract`，直到无阻塞。
6. 开一个**不读实现代码**的会话写验收，放进 `tests/acceptance/spec/`，driver 放 `driver/`。
7. 按 `.agent/slices/` 一次推进一个 Slice：`verify.yml` 产出证据，`promote.yml` 晋升。

把 `.github/workflows/`、`.github/CODEOWNERS`、`ci/protection/` 一并复制过去，
再按 [`ci/protection/README.md`](ci/protection/README.md) 应用分支保护。
改完 workflow 后跑 `node tools/ci-preflight.test.mjs` 确认路径仍然有效。

## 关键约定速查

| 约定 | 含义 |
|---|---|
| `J-*` / `C-*` / `BR-*` | Journey / Capability / Business Rule 的稳定 ID |
| `A-*` / `R-*` | 受保护验收 case / 人工 Review |
| `BL-nnn` | Baseline ID，只由 Promotion job 推进 |
| 尝试预算 | `same_root_cause_limit: 3`、`total_attempt_limit: 8`、`no_progress_window: 3`、`replan_limit: 2` |
| 退出码 | `0` 通过、`1` 阻塞/失败、`2` 输入或工具错误 |
| 三处常规人工触点 | Unknowns Gate（规划前）、验收摘要确认（实现前）、最终 Journey Review（`MVP_READY` 前）；另加任何真实 WHAT 变更需再次确认 |

## 贡献

见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。简言之：这个仓库按它自己的规则开发——
改动必须能通过它自己的门，且不得删除 Required 义务、降低断言或缩小验证集合。

## 许可证

[MIT](LICENSE) © 2026 wangxiaow
