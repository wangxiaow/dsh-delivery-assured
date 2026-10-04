# 项目工作规则

## 最小 Global Kernel

- 工作目录是本文件所在的 project/；工具包位于 ../packages/delivery-assured/。
- 产品目标与范围以 [.agent/CONTRACT.yaml](.agent/CONTRACT.yaml) 为声明来源：自用交付状态 CLI；Required 结果须从该文件重算。文件中的 approved 是声明，不替代外部确认记录。
- Critical Rules：BR-EVIDENCE-NOT-LOCAL（本地不产出权威 Evidence/晋升）、BR-STATUS-DERIVED（从 Contract、冻结验收与 CI 派生）；主体、资源、操作以 [.agent/CONTRACT.yaml](.agent/CONTRACT.yaml) 为准。
- 当前 Slice 声明是 S1，以 [.agent/slices/S1.yaml](.agent/slices/S1.yaml) 的义务、验收、预算及代码约定为来源；[.agent/STATE.yaml](.agent/STATE.yaml) 仅为可编辑线索，其中开发状态可能过期。
- Baseline：真实 CI 已建立 Baseline 链与部署证据，但当前起点须从受保护 baseline/main 与 delivery-state/main 重算。未读取权威元数据时，没有可信 Baseline revision 可填；不要从本段或 S1 的 Baseline #0 声明推导新候选已经验证。配置目标以 [.agent/project.yaml](.agent/project.yaml) 为来源。
- 来源 revision：上述指针读取当前工作区声明；精确 revision、候选差异与证据新鲜度由 resume 重算，工作区内容不冒充受保护标准。
- 本地 origin/main、origin/standards/acceptance 跟踪引用不是外部认证证明。远端已配置四个引用禁止强推/删除并约束管理员；远端权限、main 必需 verify 检查和部署证据仍要独立核查，未核实者不能从工作区文件推定。

## 执行规则

1. 加载 delivery-assured Skill 后从 project/ 运行 `node ../packages/delivery-assured/scripts/resume.mjs --offline` 做离线恢复；需读远端时另行取得明确许可。网络未核实期间只做本地诊断。
2. 数据读取与事务、身份与授权、错误模型、目录模块、命名状态、共享抽象的约定先读 [.agent/slices/S1.yaml](.agent/slices/S1.yaml)：CLI 只读，不读凭据，不相信 STATE 的 DONE；InputError 退出码 2，阻塞退出码 1；命令分发与实现分层，事实计算复用工具包 scripts/lib。
3. 产品事实缺失记 unknown 并暂停受影响规划。Journey 结果、Critical 主体/资源/操作或范围变化须走明确确认，不由实现反推验收。
4. 不删除 Required、降低断言、加入 skip/only 或缩小必需集合。实现仅改允许的 driver；driver 不承载 expect/assert，不伪造观察值或吞异常转成功。
5. 本地测试通过非完成；仅可信 CI 验证 job 产出 Evidence，仅 Promotion job 晋升 Baseline。STATE 的 DONE、会话结束或模型结论均不替代证据。
6. 尝试与 Replan 预算以 [.agent/project.yaml](.agent/project.yaml) 和 [.agent/slices/S1.yaml](.agent/slices/S1.yaml) 为声明来源，由 attempts 重算；换会话或改 Slice 名不清零。
7. 恢复前核查迁移及外部副作用。MVP_READY 另需全 Contract Coverage、当前完整机器验收与 Spine、获批环境中同候选/镜像的运行记录、最终人工 Journey Review 和全部原有发布前提。DEC-8 只批准本仓库 production_like_ci 环境例外，未批准 Review PASS；按 [最终评审说明](docs/MVP_FINALIZATION.md) 操作，缺失就如实报告。
