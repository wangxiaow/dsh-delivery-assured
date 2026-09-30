# 产品意图

- 项目：delivery-assured（交付保真操作包的首个真实项目）
- 目标用户：使用编码 Agent 交付 MVP 的独立开发者
- 要解决的问题：Agent 会持续报告“做完了”，但需求、失败路径、权限边界和部署要求经常从未被提出；局部进展被误认成整体进展
- 成功结果：开发者随时能在一个命令里看到“我还欠什么”——哪些 Required 义务没有被任何 Slice 认领、哪些没有验收、哪些证据已经过期、哪些人工确认还欠着——并且清楚哪些结论只有外部 CI 才能给出
- MVP 发布目标：内部演示（自用工具），外部 CI 证据必须真实可查
- 目标环境与平台：Windows + Node ≥ 20 的命令行工具；CI 在 ubuntu-latest 上以 production-like 容器运行
- 必须保留的限制：不引入运行时依赖；不重写 DSH 的 Agent Loop；不建设领域服务、数据库账本或通用 Adapter；权威判定留在外部 CI
- 明确不做：不自动晋升 Baseline、不写入权威 Evidence、不代替人工 Journey Review、不做 Web 界面、不做收费或多租户

## 核心用户旅程

| ID | 谁 | 从哪里开始 | 关键动作 | 最终可观察结果 |
|---|---|---|---|---|
| J-DELIVERY-STATUS | 独立开发者 | 交付仓库根目录，SCM 工作区干净 | 运行 `delivery status`（可加 `--json`） | 看到每条 Required 义务的当前状态与计算依据；退出码反映是否存在阻塞，且不把本地结果说成完成 |
| J-CI-AUTHORITY | 独立开发者 | 已推送候选并触发 CI | 触发受保护的验证 job 与 Promotion job | 只有受保护 CI 才能产出证据并推进 `refs/heads/baseline/*`；本地运行的结论被标注为诊断 |

## 正式澄清

| 日期/记录 ID | 原问题 | 你的决定 | 影响的旅程/范围 |
|---|---|---|---|
| DEC-1 | 首个真实项目的产品意图是什么？ | 本操作包仓库即首个真实项目，产品问题为“我到底还欠什么”；工具与五个脚本共用同一套事实计算 | J-DELIVERY-STATUS、全部能力 |
| DEC-2 | 本地运行能否宣告完成？ | 不能。本地输出一律为 `local_diagnostic`；证据只由受保护 CI 验证 job 产出 | J-CI-AUTHORITY、BR-EVIDENCE-NOT-LOCAL |
| DEC-3 | 工具是否写入 Baseline 或 STATE？ | 不写。工具只读；晋升凭据只在 Promotion job | C-INPUT-DIAGNOSTICS、CI 权限边界 |
| DEC-4 | 本次发布目标？ | 内部演示；真实上线前提另立 Contract | deployment.release_prerequisites |
| DEC-5 | CLI-INTERRUPT / CLI-PERMISSION / CLI-DESTRUCTIVE 是否适用？ | 不适用：只读单用户工具，无破坏性操作、无多主体权限边界 | 清单排除项 |
| DEC-6 | 本 Slice 是否需要 staging？ | 不需要；Bootstrap 与 MVP 阶段需要。远端权限尚未取得，列为实施阻塞 | deployment、U-STAGING |
