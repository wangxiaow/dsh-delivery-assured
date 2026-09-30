# 义务发现与决定

- Intent：`docs/INTENT.md`（本仓库即首个真实项目）
- 项目类型/清单版本：`cli.yaml@1`
- 当前状态：confirmed

## Journey 步骤表

| 字段 | 内容 |
|---|---|
| Journey / Step | J-DELIVERY-STATUS / STEP-1 集合工作区：开发者从仓库根目录启动工具，指向一个交付仓库 |
| 前置条件 | Node 可用；仓库内有 `.agent/CONTRACT.yaml` 与 `.agent/project.yaml`；无需网络 |
| 成功结果 | `delivery status` 输出每条 Required 义务的当前状态，含计算依据；`--json` 输出同一组事实 |
| 失败 / 非法输入 | 缺少 Contract、非法 JSON、非法命令、非法选项 → 退出码 2 且 stderr 说明缺什么；发现阻塞缺口 → 退出码 1；无阻塞 → 0 |
| 身份 / 权限 | 单用户本地 CLI，无身份系统；不读取任何凭据；不写权威状态 |
| 并发 / 重试 | 只读命令，可重复执行；不产生外部副作用，不需要幂等保护 |
| 界面 / 输出状态 | stdout 为人类摘要，stderr 为错误；退出码与真实结果一致；空结果明确显示为“无”而不是成功 |
| 配置 / 部署 / 定位 | 通过 `--project` 或当前目录定位仓库；无配置缺失时按默认路径解析 |
| Unknown / 假设 | 见 Unknowns 表 |
| 来源 / 决定 | `docs/INTENT.md`、`cli.yaml`、`U-CLI-SCOPE` 决定 |

## 清单处置与缺口表（`cli.yaml` 全量处置）

| 清单 ID | 处置 | 原因/边界 | Contract 义务/结果 | Unknown | 确认记录 |
|---|---|---|---|---|---|
| CLI-INPUT | required | 选项解析与非法输入必须明确失败 | J-DELIVERY-STATUS / J-DELIVERY-STATUS.rejected, C-INPUT-DIAGNOSTICS, BR-INPUT-STDERR | - | DEC-1 |
| CLI-OUTPUT | required | stdout/stderr/退出码契约是脚本可判定的前提 | J-DELIVERY-STATUS.ready, C-INPUT-DIAGNOSTICS | - | DEC-1 |
| CLI-EMPTY | required | 空集合必须是明确合法结果，不能误报成功 | J-DELIVERY-STATUS.ready（空结果语义） | - | DEC-1 |
| CLI-RETRY | required | 只读命令天然幂等，需在验收中断言 | J-DELIVERY-STATUS.ready | - | DEC-1 |
| CLI-INTERRUPT | not_applicable | 命令不写任何文件（权威状态写入留给 CI）；中断不会留下部分结果 | - | - | DEC-5 |
| CLI-PERMISSION | not_applicable | 单用户本地只读工具，无多主体与资源边界；不读取凭据 | - | - | DEC-5 |
| CLI-CONFIG | required | 通过 `--project` 定位仓库，缺 Contract 时明确报告缺失 | J-DELIVERY-STATUS.rejected, C-INPUT-DIAGNOSTICS | - | DEC-1 |
| CLI-DESTRUCTIVE | not_applicable | 本 Slice 无删除/覆盖/迁移操作；写入能力明确排除在范围外 | - | - | DEC-5 |
| CLI-ENV | required | 声明 Node 版本与无网络依赖，可在干净环境重复执行 | C-INPUT-DIAGNOSTICS | - | DEC-1 |
| CLI-OBSERVABILITY | required | 退出码与真实结果一致，失败可定位到具体义务 | C-INPUT-DIAGNOSTICS, BR-EVIDENCE-NOT-LOCAL | - | DEC-1 |

## Unknowns 表

| ID | 问题 | Journey/Rule | 不回答的影响 | 建议选项 | 你的决定 | 状态/边界/复查时点 |
|---|---|---|---|---|---|---|
| U-CLI-SCOPE | 首个真实项目是否就是本操作包自身的状态报告需求？ | J-DELIVERY-STATUS | 无法确定首个 Slice 的业务意图，只能做脚手架 | 以“我到底还欠什么”为产品意图，工具与脚本共用同一套事实 | 采用：本仓库即首个真实项目，产品问题为“用编码 Agent 交付时我到底还欠什么” | resolved（DEC-1） |
| U-CI-AUTHORITY | 本地运行是否可以宣告完成？ | BR-EVIDENCE-NOT-LOCAL | 会把本地绿灯当成完成，破坏方案核心 | 只有受保护 CI 的验证 job 产出证据，Promotion job 独占晋升 | 采用：本地一律诊断为 `local_diagnostic`，权威判定留在外部 CI | resolved（DEC-2） |
| U-DELIVERY-BOUNDARY | 自动写入 Baseline 或 STATE 是否属于本工具范围？ | C-INPUT-DIAGNOSTICS | 会把可信边界下沉到本地工具 | 工具只读，晋升与证据写入留在 CI | 采用：工具不写任何权威状态；写入能力明确排除 | resolved（DEC-3） |
| U-RELEASE | 本次发布目标是内部演示、邀请测试用户还是面向真实用户上线？ | deployment | 决定发布前提与是否强制真实 staging | 自用工具，先达“内部演示 + 真实 CI 证据” | 采用：release_goal = internal_demo；真实上线前提另立 Contract | resolved（DEC-4） |
| U-STAGING | 本仓库是否需要真实 staging 环境？ | deployment | 无 staging 时 MVP_READY 不可达 | 本 Slice 不需要 staging；Bootstrap 阶段再评估 | 采用：Bootstrap 与 MVP 阶段需要 staging 通道，本 Slice 不适用；真实远端权限未取得，列为阻塞 | deferred_with_approval（DEC-6，复查时点：Bootstrap 结束前） |

## Gate 结论

- 未处理 unknown：无
- 排除及延期的确认引用：DEC-5（CLI-INTERRUPT / CLI-PERMISSION / CLI-DESTRUCTIVE）、DEC-6（U-STAGING 有界延期）
- 阻塞性产品问题：无。远端仓库与 CI 权限尚未提供，属实施阻塞而非产品未知项。
- 下一步：起草 Contract 并跑 `check-gaps --phase contract`
