# Delivery Assurance

在明确需求和授权范围内自动交付可运行软件，完成与否由独立执行的证据决定。

## Language

**Contract**：当前仍需满足的用户结果、业务规则、范围和发布条件。不是任务清单。

**Coverage**：Contract 的义务与实现切片、验收及当前证据之间的可重算关系。

**Evidence**：在精确候选、标准和环境上实际执行验证所产生的记录。不是实现者的完成声明。

**Baseline**：经过有效验收并正式晋升的可信起点；历史 Baseline 不自动证明当前候选通过。

**Candidate**：尚未晋升的待验收系统版本。

**Iteration**：由一次明确用户需求开启、以实际交付或明确阻塞结束的工作范围；新的迭代保留既有义务和失败历史。

**Attempt**：针对可证伪假设形成 Candidate 并运行约定验证集合的一轮。成功也留在历史，但不等于一次失败。

**Replan**：因事实证伪而改变实现方案、保留产品义务及累计预算的决定。仅改名或换说法不是 Replan。

**Independent Auto Acceptance**：独立于实现者完成声明、实际执行既定标准并核验可运行结果的默认完成方式。不等于人工签收或无测试的自动放行。

**Verification Backend**：实际执行冻结验收的那条通路。默认是 **Host-Executed Verification**（DSH/宿主自己逐门运行并保留记录与日志）；`trusted_ci`（受保护 CI 工作流、authority refs、push token、Baseline 晋升）是可选的高保障后端，不再是普通项目的默认完成前提。两者都不降低 acceptance：Required 不得跳过，记录必须由该后端的实际执行产生。

**Frozen Standard**：冻结时刻受保护标准文件（Contract、项目配置、验收 manifest 与 spec、verifier 配置、Slice）的逐字节摘要，加上这些字节所属的提交 revision。Host-Executed Verification 用它代替受保护 `standards/acceptance` ref：冻结后任何改动都会让验证以 `STANDARD_DRIFT` 拒绝。

**Delivered**：由证据算出的终态，不是声明。它成立的条件是：本项目的验证后端在**当前精确候选**上实际执行了冻结 Required 集合与累积 Spine 且全部通过，**该后端真的有能力观测到 Contract 要求的每一类事实**，没有 Critical 欠账，预算未耗尽，且决定该判定的核心逻辑（Frozen TCB）在本轮未被改动。Baseline 晋升不是它的前提。

**Required Observable**：Contract 要求"必须被实际观测到"的事实（build、clean boot、持久化迁移、Slice 验收、累积 Spine、打包部署…）。对 Required Observable 而言 `not_observed`/`unsupported`/`warning` 永远不是通过；只有"观测到且通过"才算。

**Backend Capability**：某个验证后端真的能观测到的事实集合。`Delivered` 要求 Required Observable 是该集合的子集，否则 `BACKEND_CAPABILITY_INSUFFICIENT`。未被要求的事实观测不到不阻塞。

**Frozen TCB**：决定"是否 Delivered"的有限文件集合（Contract 解析、Required 推导、证据校验、Delivered 判定、冻结校验、Spine 完整性、backend 能力、verifier 启动器）。冻结时记摘要，验证时重算；普通 Candidate 不得在本轮修改它，verifier 升级属于 control-plane 流程。

**Human Review**：由用户主动选择、需要真实人类评审记录的完成模式。自动验收不能冒充这种记录。
