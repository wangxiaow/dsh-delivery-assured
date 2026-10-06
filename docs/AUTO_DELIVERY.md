# 默认自动交付：规则、入口与限制

这份说明记录默认完成规则的实际行为：**普通项目的默认路径是 DSH/宿主自己实际执行冻结验收**，
不需要 GitHub Trusted CI、authority refs、push token 或 Baseline 晋升。受保护 CI 保留为
**可选的高保障后端**。它描述已经实现并被测试覆盖的部分，以及明确不覆盖的部分。

## 一条默认路径

```text
用户在 DSH 中提出需求
  → delivery_iteration(action=open) 记录需求原文（首个需求即可开，不需要已有 iteration）
  → 结构检查 / 覆盖 / 预算：还欠什么、什么过期、还剩多少
  → 冻结标准（delivery_verify_independent freeze_standard: true，实现前一次）
  → 实现 → 本地诊断（不是证据）
  → delivery_verify_independent：宿主实际执行 build / clean boot / 持久化迁移 / 冻结验收 / 累积 Spine
  → FAIL：按它点出的门与 Required case 自动修复后重跑（不问用户普通技术问题）
  → PASS：写入 Evidence、运行日志与 receipt，并记入 attempt 账本 → 交付判定为 Delivered
```

不需要用户运行脚本、编辑回执、发表审批评论、配置仓库或持有推送令牌。需要用户决定的只有实质
产品取舍、新增权限、费用和破坏性操作。

`action=open` 只依赖日志：第一条需求没有前驱，已交付（上一轮已 close）的项目同样直接开下一轮，
`iteration_of` 指向最近一条记录。它不要求先有 open 的 iteration id，空账本与坏行都如实报告而不抛错。

`action=request` 按每个 action 自己的输入 schema 构造参数（`verify` / `promote` /
`record-attempt` / `resolve-diagnostic`），不把别的 action 的字段以 `undefined` 形式一起发出去。
派发之后必须能**唯一**归因：派发前先读一次该 workflow 的 run 列表，派发后要求恰好出现一个新的
`workflow_dispatch` run 才报告 `requested`；0 个或 ≥2 个都判为 `ambiguous`（明确失败，列出看到的
run id），**不选最新 run**、不盲目重试。读不到派发前的 run 列表时干脆不派发，因为无法归因的
run 同样会消耗那个冻结候选。这条通路只在选择了可信 CI 后端时才需要。

## 完成规则

`completion_policy.mode` 是唯一来源：

| 模式 | 完成条件 | 谁批准 |
|---|---|---|
| `independent_auto`（默认） | 本项目的验证后端在精确候选上实际执行全部 Required 与累积 Spine 并通过；没有 Critical 欠账 | 不需要人工签收 |
| `human_review` | 上述机器条件 + 绑定同一候选/标准/部署的真实人工评审记录 | 用户本人，Agent 无法伪造 |
| 未声明 | 按 `human_review` 处理 | 用户本人 |

未声明按人工处理是刻意的：缺一个字段不能让项目自动变成“可交付”。
`independent_auto` 也不允许留下未迁移的人工评审定义——那会变成暗中的终态门槛。

## 验证后端

`.agent/project.yaml` 的 `verification.backend` 决定**谁实际执行**冻结验收。未声明即默认：

| 后端 | 谁执行 | 观测到什么 | 什么时候用 |
|---|---|---|---|
| `host_executed`（默认，未声明即此） | DSH/宿主自己跑 `verify.mjs --backend host --write-evidence` | build、clean boot、持久化迁移、冻结 Slice 验收、累积 Spine 真实执行；**看不到**打包部署与运行时隔离（如实写成 `not_applicable`/`not_observed`） | 普通项目 |
| `trusted_ci` | 受保护 GitHub 工作流 + 晋升 job | 上面全部 + 平台来源、受保护引用与部署身份 | Contract 明确要求平台来源时（本仓库自己就是） |
| `both` | 宿主执行，同时接受可信 CI 记录 | 取两者中更强的那条 | 正在接入 CI 的项目 |

`trusted_ci` 需要 authority refs、push token、受保护环境与 Baseline 晋升；这些机制**全部保留**，
但只是高保障选项，不是普通项目完成的前提。声明的后端不允许被更弱的后端替代：声明
`trusted_ci` 的项目调用宿主后端会被直接拒绝（退出码 2）。

### backend 必须真的能观测到 Contract 要求的事实

"这个后端看不到某件事"本身不是缺陷；**看不到却仍然给出 `Delivered = true`** 才是。判定由两个显式集合推导：

```text
required_observables              这个 Contract 要求被实际观测到的事实
backend_observable_capabilities   产出这条记录的后端真的有能力观测的事实
```

`Delivered` 要求 `required_observables ⊆ backend_observable_capabilities`，并且每个 Required observable
背后都有一条本轮有效记录。缺一则 `NOT_DELIVERED`，理由码是稳定的 `BACKEND_CAPABILITY_INSUFFICIENT`，
结果里至少带 `backend` 与 `missing_observables`。对 Required observable 而言，
`not_observed` / `unsupported` / `unknown` / `warning` **永远不算通过**。

| observable | 由谁观测 |
|---|---|
| `build`、`clean_boot`、`persistence_migration`、`slice_acceptance`、`regression_spine` | 两个后端都能（冻结 verifier 声明了对应门即成为 required） |
| `production_deployment` | 只有 `trusted_ci`（记录必须真的绑定 `deployment_id`/`deployed_code_revision`/`image_digest`） |
| `runtime_isolation`、`container_isolation`、`external_provider` | 目前**两个后端都不能**：Contract 一旦要求，任何后端都必须 BLOCKED |

required 集合来自 Contract 与冻结 verifier 声明的门，**不来自后端**：Contract 只要 build/boot/acceptance/regression
的项目，宿主后端照常可以 Delivered。`production_deployment` 也不会因为环境名字（`staging`、
`production_like_container`）而自动成为 required——那是**显式声明**的：

```yaml
deployment:
  required_observables: [production_deployment]     # 显式要求"部署被实际观测"
  release_prerequisites:                            # 声明了 trusted_ci 后端时，平台可观测前提也算
    - { id: verify-required-checks, verification: required_check_runs_on_candidate, expects: [...] }
```

为什么要显式：即便冻结 verifier 里有一个 `deployment` 门，那也只是"验证器跑什么"的陈述，不是"必须观测到部署"
的陈述；而只按环境名字推导会让[出厂 Contract 模板](packages/delivery-assured/templates/CONTRACT.yaml)
派生的每个项目都被迫改用 CI 后端，与模板自己写的"只有声明 `verification.backend: trusted_ci` 才要求平台观测"
直接冲突。反过来，一旦 Contract 显式要求，宿主后端会在**任何门执行之前**以退出码 2 拒绝整次运行
（不消耗 attempt、不留下记录），必须换 `trusted_ci`。未被要求（optional）的 observable 缺失不阻塞。

判定一处计算、多处使用：[backend-capability](packages/delivery-assured/tests/backend-capability.test.mjs)
套件覆盖 required/optional/`not_observed`/backend 能力不足四种情形。

## 自动验收为什么不是“自称完成”

- 验收 case 在受保护目录里，实现者不能改；宿主运行前先按冻结记录的逐字节摘要校验标准，
  任何改动都以 `STANDARD_DRIFT` 拒绝整次运行（CI 后端仍用受保护 `standards/acceptance` 逐文件比对）。
- 每个 case 必须在这次运行的 `case_results` 里有且仅有一次 `passed`；缺 case、skip、
  失败、绑定过期都会阻塞。Required 集合来自冻结 manifest、Slice 与累积 Spine，不来自测试运行器自报。
- 四个可执行门（build、clean boot、Slice 验收、Spine）必须真的在宿主上退出 0；只有**冻结 verifier
  配置**声明为 CI-only 的门才可以是 `not_applicable`，且必须写明原因。把验收门标成不适用的记录无法通过校验。
- host 记录必须携带本次执行的 run token、保留日志摘要、harness 结果文件摘要与逐门退出码，
  并与 receipt 互相指认；没有这些字段的手写文件不是证据。
- host 记录必须**明确声明它没有观测到**打包部署与运行时隔离；这些限制进入交付报告，而不是被折叠成 PASS。
  这些"限制"只有在 Contract **没有**要求该事实时才是限制；一旦 required，见上面的 backend capability 规则。
- **任何 Agent-facing 开关都不能关闭 Spine 累积**。`delivery_verify_independent` 只声明
  `slice`/`freeze_standard`/`allow_standard_change`/`standard_change_reason`/`parent_baseline`/`hypothesis`
  六个输入，没有"这次不算数"的开关；底层 CLI 的 `--no-spine-accumulate` 已删除，传入即 `unknown option`（退出码 2）。
  PASS 之后的累积是 `new_spine = old_spine ∪ verified_cases`：一个已累积的 case 没通过就阻塞整次运行，
  而"该进的 case 没进 Spine"是 **verifier error**（`SPINE_NOT_ACCUMULATED`），不是 warning。
- **验证子进程的环境是显式构造的，不继承宿主进程**。gate 只拿到最小平台基础环境
  （PATH/HOME/TEMP/SystemRoot/…）加上**冻结 verifier 配置里逐个声明的变量**；写成 `$NAME` 的值才转发
  验证进程自己的同名变量。`DSH_CI_ISSUER`、`DSH_IMAGE_DIGEST`、`DSH_STANDARD_REVISION` 等 authority
  变量因此不会从 CI job 意外流入宿主验证或测试 fixture，"哪些环境变量能进 gate"是冻结标准的一部分。
- **决定 Delivered 的逻辑是一个有限的 Frozen TCB**：冻结时记录 `tcb_version`/`tcb_files`/`tcb_digest`，
  验证时在任何门之前重算；漂移即 `TCB_DRIFT` → `NOT_DELIVERED`。TCB 在候选仓库内时另有一条
  **frozen revision 的 Git blob id** 比对，所以"改 verifier、只把摘要文件一起改掉"不成立。
  它挡不住的是**同时**改写 `frozen_revision`（等于冒充控制平面）：那不是普通交付行为的封堵点，
  在 CI 后端由 `ci-stage` 从 canonical 取包 + 受保护引用挡住；升级 verifier 属于 control-plane 流程，
  普通 Candidate 的 tool schema 上没有授权开关。这两条残余在 [Frozen TCB](TCB.md) 与
  [frozen-tcb 回归](packages/delivery-assured/tests/frozen-tcb.test.mjs) 里被显式固定，不当作已解决。
- 候选工作树必须与它绑定的提交 revision 一致，否则拒绝。**会话本来就会写的状态文件不算候选改动**：
  `.agent/ITERATIONS.jsonl`、`.agent/STATE.yaml`、attempt 账本、累积 Spine、`.agent/reviews.yaml`、
  `.agent/STANDARD_CHANGES.yaml`、`ci/mvp-ready.json`、Evidence 目录与冻结锚点；这份清单写进记录的
  `execution.host.state_excluded`，可逐项核对。真实源码或受保护标准的改动仍然被拒（受保护标准的改动先由
  冻结校验以 `STANDARD_DRIFT` 拒绝），`git status --porcelain` 按 `XY <path>` 解析，所以 ` M`
  （未暂存修改）、`??`（未跟踪）、重命名都不会被误读。
- 自动终态不修改输入对象：原始 Evidence 字节保持不变；失败记录原样保留，只追加新的 attempt 行。
- 自动模式不生成 owner 回执；人工模式的反伪造约束（同仓库精确评论、真实 User 作者、
  绑定候选/标准/镜像/部署）完全保留。

## 冻结标准与累积 Spine

- 实现前一次 `verify.mjs --freeze-standard` 记录每个受保护标准文件的 SHA-256 与它们所属的提交
  revision（保存在受保护的 `.agent/standards/FREEZE.json`，guard 拒绝会话写入）。
- 验证时逐文件比对：改动、删除、新增任何标准文件都拒绝整次运行；revision 交叉核对用 Git blob id
  （不受换行过滤器影响），因此未提交的改动不能被冻结成“原本如此”。
- 重新冻结需要显式 `--allow-standard-change`，并把上一个 standard id 记入历史——标准变化可见，不会被抹掉。
- 累积 Spine 不属于冻结标准：**宿主执行通过的那次运行会自己把验证过的 case 追加进去**（这正是 CI 后端
  晋升 job 的工作）。Spine 只能增长：丢掉一个已验证 case 会让整次运行失败，而不是静默降级。

## 预算规则的一处修正

成功执行仍写入历史并占用总预算，但不再计入同根因失败计数，也不再把无进展窗口推高。
此前三次成功验证会被记成同一个根因失败三次，导致后续正常迭代在晋升时被判为
“需要 Replan”，而事实上并没有反复失败。历史与总预算依然累计，成功不会清零任何东西。

## 会话如何看到权威状态（只读）

在**可信 CI 后端**上，Baseline 元数据、Evidence、尝试账本、累积 Spine 与标准比较审批只存在于
`refs/heads/delivery-state/main`；CI 的 verify/promote 会先把这份状态铺进暂存的工作区，
所以它们看到的是真实状态。会话没有对等的铺开步骤，因此仅读工作树的会话会把**已交付**的
项目报成阻塞。

在**默认（宿主执行）后端**上，这些对象本来就是工作树的 `.agent/` 与 `tests/spine/`，
会话直接读到的就是权威状态；平台没有 `delivery-state/main` 时，报告写成
`worktree-no-durable-state-ref` 并说明原因，而不是“读取失败”。

现在会话侧有了一条明确的只读通路：

- `delivery_resume` 默认读该 ref（`offline: true` 时跳过并说明），`delivery_coverage` 与
  `delivery_attempts` 同样读取；等价脚本参数是 `--durable-state`（`delivery status` 也支持）。
  该 ref 不存在时按上一条处理：如实说明，不阻塞。
- `delivery_iteration(action=status)` 与 Global Kernel 也读**同一个** ref：同一段历史必须得出同一个
  预算。此前 kernel 与 iteration 摘要按 `--offline` 渲染工作树，于是同一项目出现两个预算（7 次
  attempt/剩 1 次 vs 4 次/账本未知），并把已交付项目报成阻塞。
- 加载/预算只走[一处 state view](packages/delivery-assured/scripts/lib/state-view.mjs)：它命名一次来源
  （`durable-ref` 或 CI 的 `worktree`），`computeConvergence` 只被它调用，所以两个入口不可能各算一套。
- **取权威状态的通道是 GitHub API（`gh`）**：`--state-transport auto`（默认）先走 `gh`，读不到再退到
  `git ls-remote`/`fetch`；`gh` 是原生可执行文件，不依赖 MSYS2 子进程与 Schannel，因此在**受限会话 shell**
  里仍可用——同一个 shell 里 `git fetch` 会失败（`couldn't create signal pipe` / `SEC_E_NO_CREDENTIALS`）。
  报告里会写明实际用的通道，以及另一个通道为何没有被尝试。
- 插件配置 `stateSource: worktree` 可显式改为只读工作树（例如机器连不上远端，或门禁不得依赖网络）；
  这是显式选择，不会静默切换。CI 的 verify/promote 本来就是 `worktree`（它先把 state 铺进检出）。
- 它只取 [四个状态作用域](packages/delivery-assured/scripts/lib/durable-state.mjs)（`.agent/attempts.jsonl`、
  `.agent/reviews.yaml`、`.agent/STANDARD_CHANGES.yaml`、`ci/mvp-ready.json`、
  `tests/spine/manifest.yaml` 与 `ci/{baseline,evidence,recording}/`），**任何越界条目都会让整次读取被拒绝**；
  树被平台截断、内容不是合法 UTF-8、或内容字节数与树记录不符，同样拒绝整次读取。
- 它从不写入项目：内容落在私有临时目录，读完即删。状态分支缺某个作用域时，按 CI 的语义回落到
  候选自己的副本；Contract、源码等**永不**从状态覆盖层取。回落具体取了哪些文件会**逐个列出**。
- 读不到就如实报告 `unavailable — <原因>`，并且**绝不**降级成"什么都不欠"。
- **要求读权威状态却读不到时，命令失败（退出码 1）**：报告会标明 `state_authority:
  worktree-fallback`（或 `durable-ref-with-worktree-fill`），并写明下面的数字来自工作树、**不是恢复结果**。
  工作树事实不会被包装成等价恢复成功。
- **平台没有这个引用时不算读取失败**：普通项目（默认后端）的 Evidence、attempt 账本与 Spine
  就在工作树里，`state_authority` 记为 `worktree-no-durable-state-ref`，报告说明“平台没有该引用”，
  不会把它写成通道故障，也不会把它当作恢复成功。

这是只读诊断，不构成 Evidence，也不推进 Baseline。

## 限制（必须如实报告）

- 自动结论只覆盖机器可观察结果。交互易用性等主观判断不在其中；需要时由用户主动
  发起人工评审，而不是把它包装成自动通过。
- **宿主后端观测不到打包部署与运行时隔离**：它按原样在候选工作树上运行，没有安装产物、
  没有容器/命名空间隔离。这一点写在记录里（`environment.observed` / `not_observed`）并进入交付报告，
  不会被当成已观测。需要这类观测时选 `verification.backend: trusted_ci`。
- 候选运行时隔离在后端层面仍未实现：CI 后端在受保护 runner 上执行，隔离后端是欠账，
  只在 Baseline 元数据里作为告警记录。
- 本仓库没有独立 staging 通道，验证环境是 `production_like_ci`；这不等于真实 staging。
- `delivery_ci` 只请求并观测工作流。它不持有 Baseline 凭据，`requested` 或 `completed`
  都不等于晋升；派发结果不明确时不会重试，避免重复消耗同一冻结候选。

## 会话内可用的工具

| 工具 | 作用 | 边界 |
|---|---|---|
| `delivery_iteration` | 追加式迭代日志：记录需求、决策、观测到的证据引用、阻塞、结束 | `close` 必须由重算出的 Delivered 判定放行，否则拒绝且不写；不是完成凭证 |
| `delivery_verify_independent` | **默认完成路径**：宿主实际执行冻结验收并写入 Evidence、运行日志与 receipt | 不能选 Required 集合、不能跳过、不能关闭 Spine 累积、不能改 TCB、不能写 PASS；失败只报告门与 case |
| `delivery_ci` | 按白名单输入派发 `verify` / `promote`，读取精确运行与 job（可选高保障后端） | 无 Baseline 凭据；歧义派发不重试 |
| `delivery_gaps` / `delivery_coverage` / `delivery_resume` / `delivery_attempts` / `delivery_verify_local` | 结构检查、覆盖重算、恢复摘要、预算、本地六门诊断 | 只读；本地一律 `local_diagnostic` |
