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
[![Local checks](https://img.shields.io/badge/local%20checks-passing-success.svg)](#已验证的结果)

</div>

---

## 这个项目解决什么

用编码 Agent 从零做项目时，自由开发流程通常围绕「当前任务、当前报错、当前上下文」前进，
而交付要求同时维护「整个产品还欠什么、什么算做对、旧能力是否还在、目标环境能否运行」。
这几件事没有稳定的外部依据时，**局部进展会被误认成整体进展**。

典型后果：需求只在聊天里出现过；隐式义务没有问出来；任务清单只覆盖页面和接口；
实现者顺手修改验收；修复当前错误破坏旧流程；沿用旧版本 PASS；
最后才发现登录回调、迁移、配置或完整用户旅程跑不通。

本项目把方案落成可执行的东西：三份模板、三类项目清单、五个脚本、
两个 CI 工作流、一套权限声明，以及一个把它接进 DSH 会话的插件。

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
- 只有 `.github/workflows/verify.yml` 的验证 job 产出 `evidence.json`。
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
│   └── tests/                      #   YAML 子集解析器回归测试
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
node ../packages/delivery-assured/scripts/resume.mjs

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

## 已验证的结果

复现全部检查：

```bash
node packages/delivery-assured/tests/yaml.test.mjs
node plugins/dsh-delivery-assured/test/skill-registry.test.mjs
node plugins/dsh-delivery-assured/test/smoke.mjs
node tools/ci-preflight.test.mjs
node tools/markdown-structure.test.mjs
node tools/build-gate-absent-plugin.test.mjs
node tools/local-promotion-drill.mjs
cd project && node ../packages/delivery-assured/scripts/verify.mjs --local --slice S1
```

| 检查 | 结果 |
|---|---|
| YAML 子集解析器回归测试 | 28 项通过 |
| 插件自测（真实脚本 + 真实 shell） | 50 项通过 |
| 插件 Skill 经真实 DSH 注册表读回 | 13 项通过（含「缺正文被拒」负向对照） |
| CI preflight（workflow 每个路径、编码与步骤） | 81 项通过 |
| Markdown 结构（表格、链接、锚点、围栏） | 81 项通过 |
| 构建门在缺插件的裸包副本中仍通过 | 4 项通过（负向对照） |
| `check-gaps` 三个阶段 | contract / acceptance / slice 均无阻塞 |
| 验收 harness | 8/8 必需用例通过 |
| 本地六个门 | 4 通过、1 有理由地不适用、1 声明为 CI-only |
| 晋升链路本地演练 | 30 项通过（含真实 evidence 绑定、部署门观测值与条件检查） |
| 插件在新宿主 profile 中组合 | 通过（`--dump-config` 输出包含该插件） |

### CI preflight 是什么

workflow 在配好远端之前无法运行，所以里面的坏路径只有等第一次 `git push`
之后才暴露——偏偏那是最不该出错的地方。`tools/ci-preflight.test.mjs` 把这一类缺陷变成
构建期失败，它检查：

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
