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

## 安装

```powershell
# 1. 让 profile 能看到插件，然后链进去
cd "$env:USERPROFILE\.dsh\profiles\<profile>"
pnpm add "link:<repo>/plugins/dsh-delivery-assured"

# 2. 把 bundle 加进该 profile 的 package.json
#    "dsh": { "profile": { "bundles": [ ..., "dsh-delivery-assured" ] } }

# 3. 指向 pack 与项目（配在这里，或用环境变量）
#    cordis.patch.yml:
#      - id: delivery-assured
#        name: "dsh-delivery-assured"
#        config:
#          packRoot: <repo>/packages/delivery-assured
#          projectRoot: <repo>/project
```

> `desktop` profile 由 Electron 应用独占，`dsh --profile desktop` 拒绝从 CLI 启动。
> 想在终端验证激活，另建一个挂同一插件包的等价 profile 即可。

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

- DSH desktop `0.2.0-rc.2`，peer 依赖 `@deepseek-ai/dsh-tools` `0.1.5-rc.3`。
- 工具输出 schema 必须落在 DSH 的强制 JSON Schema 子集内，这里用注解式 `{ type: 'object' }`。
  **`{ type: 'json' }` 不在该子集里**，注册时会抛 `JsonSchemaError`，导致整个 profile 起不来。
- 运行期 Skill 的正文键名是 `content`。**键名写错不会报错**，而是注册一个加载不到内容的空 Skill，
  所以有专门的测试用真实注册表读回正文。
- 在 DSH profile 之外 `@deepseek-ai/dsh-tools` 合理地解析不到；此时插件走一个**有文档说明的
  直通 shim** 以保持可测试性。在 profile 内真实实现永远优先。

## 测试

```bash
node plugins/dsh-delivery-assured/test/smoke.mjs            # 50 项
node plugins/dsh-delivery-assured/test/skill-registry.test.mjs  # 13 项（需 DSH 侧包）
```

- **smoke**：像会话一样驱动插件，对着真实项目的临时副本跑：解析 pack、
  通过真实 shell 运行真实脚本、检查工具与 Skill 注册，
  并断言**配置损坏时给出诊断而不是抛异常**。
- **skill-registry**：驱动插件自身的 `apply`，再用 DSH 真实的 `SkillRegistry` 把 Skill 读回来
  （`get()` 会重新校验定义）。带负向对照：缺正文的定义必须在同一路径上被拒绝。
  该测试需要 DSH 侧包，因此按 `$DSH_HOME/profiles/node_modules` → 当前目录 → 插件目录依次解析；
  **全部失败时返回 2 而不是跳过**——跳过会让一个坏 Skill 静默出厂。

## 许可证

[MIT](LICENSE) © 2026 wangxiaow
