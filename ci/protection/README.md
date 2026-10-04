# 权限、来源与初始化前提

本目录是保护声明与配置模板，不是平台保护已生效的证明。本地已配置 origin，并存在 main、standards/acceptance 跟踪引用；远端权限、规则及环境审批均未实际核验。

## 角色必须分离

- 标准更新身份只推进 standards/acceptance；实现会话保持 Required、spec 断言及范围不变。首次标准引用由 owner 建立，普通更新通路缺引用即停止。
- 验证身份没有 Baseline 写凭据；候选进程须与 verifier、harness、结果文件、受保护标准和凭据隔离。复制 canonical 文件只证明来源选择，不证明运行时隔离。
- 独立 state-recording 身份通过 STATE_PUSH_TOKEN 追加 delivery-state/main；只持久化归属明确的运行、账本及诊断，绝不推进 Baseline。
- Promotion 身份独占 BASELINE_PUSH_TOKEN，通过独立只读 API token 重查来源，以两个显式 SHA lease 原子更新 Baseline 与 state。它读取候选数据，不执行候选模块。

[保护声明](branch-protection.json)要求 main 至少一次 CODEOWNERS 审批、两个 Required checks、Baseline 和 state 的独立写入限制。规则尚待逐项验证，不能以 JSON、YAML 或模拟推送代替平台拒绝测试。

## 恢复失败和预算

[verify 工作流](../../.github/workflows/verify.yml)固定候选、标准和 verifier revision，传递冻结 Required 集合、run token、稳定 Slice key 与可证伪假设。

[promote 工作流](../../.github/workflows/promote.yml)的独立 record-attempt job 消费 completed main dispatch 的精确 run-attempt。[记录工具](../tools/ci-record.mjs)再次查询 GitHub 来源，幂等追加 PASS/FAIL/not_run 的预算历史；缺失、损坏或归属不明的产物留下持久阻塞诊断。候选提交的 trust 字段不会被采用：当前只确认 transport，runtime_isolation_verified 固定为 false，因此观察记录不是可关闭 Coverage 的权威 PASS。

首次账本须经 delivery-state-bootstrap 环境审批，从 main CI 入口显式指定 owner 与 seed。owner-approved-empty 只适用于 owner 已确认确无历史的首次建立，任何原始 recording/Evidence/Baseline 文件也会阻塞空 seed，即使模型没识别出其中的记录；存在 state 时禁止重置。existing-ledger 通过[seed 关系校验](../tools/ci-bootstrap-seed.mjs)绑定 attempt→Evidence→receipt，保留诊断及合法 resolution 的原始字节，并用 actions:read token 逐一独立确认精确来源后才原子写入新 state。旧初始化标记按原字节 digest 归档，新标记另记本次 owner。不存在的 source、孤儿/重复关系、未证明的 INFRA_ABORTED 或自称 runtime isolation 均拒绝；此流程不是权威隔离 Evidence 的迁移协议。缺账本或无法确认来源就停止，不按零次处理。

GitHub concurrency 不是持久队列，pending collector 可能被替换。[历史核对](../tools/ci-history.mjs)在 precheck 用独立只读 token 分页核对 main dispatch 的每个精确 attempt，包括同一 run 较早的重跑；已完成而无 durable receipt 就阻塞新候选执行。API 拒绝、分页不完整、审计额度耗尽或 receipt 冲突也按历史未知处理，不假装核对完成。

这只是漏项探测，不自动生成历史。运维仍须 reconciliation；可从 promote 的 main dispatch 选择 `record-attempt` 并提供精确 verify run ID/attempt 重跑 state-only collector。这个入口重新通过 API 确认来源、下载精确产物，不获得 Baseline 权限；重复 receipt 幂等、不同字节冲突不覆盖原记录。[定时 reconciliation](../../.github/workflows/reconcile.yml)已接入独立 main-only planner：每四小时或手动读取 protected receipt 快照，[核对并请求](../tools/ci-reconcile-run.mjs)最老的一条精确漏项，由既有 protected collector 补录。每轮最多一个请求、独立 concurrency 组、不持有 STATE/BASELINE 凭据；HTTP 204 只表示已排队，历史仍保持 missing，下一次独立核对 receipt 才能消除缺口。过期、损坏或未计数的记录仍进入阻塞诊断；这个机制不把不能恢复的历史伪装为不存在。平台已删除的运行不在可查询历史中，不能用这次核对替代首次历史确认和保留策略。

`resolve-diagnostic` 入口必须由 `delivery-state-resolution` 环境批准，提供与 GitHub actor 相同的 owner、非占位确认引用、精确 run-attempt 及已审阅的 state SHA。[留痕校验](../tools/ci-resolution.mjs)只允许处理已经完整留存且已计数的 FAILED attempt，重新绑定原始诊断字节 digest、source receipt、标准/集合和逐例计数。原诊断、失败 attempt 和 Evidence 都不删除或改写，只另存 resolution；不会产出 PASS 或关闭 Coverage。缺产物而未计数、PASS、歧义记录及错误来源仍阻塞。precheck 每次重验 resolution，不凭一个 resolved 标签放行。环境审批及权限仍需真实平台实证。

## 晋升仍受阻塞

运行时隔离后端尚未实现或取得独立证明，所以 Promotion 在获取 Baseline 凭据前强制退出。删除这道前提检查或设置一个环境变量都不是隔离实证。

产物保留导入相对路径；打包本身不会填写部署身份和运行版本。真实运行环境必须观测同一候选及镜像。MVP_READY 另需完整 Contract、全部机器验收及 Spine、同版本 staging、版本绑定的 owner Journey Review 和逐项发布前提回执。

## 仅本地诊断

以下测试只创建临时本地 bare fixture，不接触真实远端，也不产生平台 Evidence 或真实晋升：

```powershell
node tools/trusted-ci.test.mjs
node tools/ci-trust.test.mjs
node tools/ci-record.test.mjs
node tools/local-promotion-drill.mjs
node tools/ci-preflight.test.mjs
```

[可编辑恢复摘要](../../project/.agent/STATE.yaml)仅记录 HOW 和外部阻塞。真实起点、剩余预算与欠账仍由 resume 从受保护状态及当前标准重算。
