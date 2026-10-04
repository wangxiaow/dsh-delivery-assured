# v0.5 修复与本地验证记录

## 本轮范围

修复操作包的误 PASS、范围重算、账本恢复及 CI 数据通路。没有降低 Required、改变受保护 spec 断言或修改产品 Contract；没有提交、推送、运行真实远端 CI 或晋升真实 Baseline。v0.3 的独立 Runtime、数据库及 Context Compiler 不在本轮范围。

## 已修复

- [证据校验](packages/delivery-assured/scripts/lib/evidence.mjs)：完整 revision/digest、Nullable lock/migration、六门、冻结 Required 集合及逐例结果；缺例、重复、过滤、超时和 not_run 不再构成 PASS。同时间的失败/ERROR 不被旧 PASS 遮盖。
- [Coverage](packages/delivery-assured/scripts/lib/coverage-core.mjs)与[范围选择](packages/delivery-assured/scripts/lib/selection.mjs)：当前 Slice 加累计 Spine 和适用 Critical；部分 Journey 不被未来 Required 子结果误阻塞，整体 Contract 仍保留全部欠账。人工 Review 必须绑定当前候选、标准、镜像及部署。
- [预算计算](packages/delivery-assured/scripts/lib/convergence.mjs)：稳定 Slice key、重命名 lineage、同标准/同集合比较、真实 Spine caseIds、最后额度内 PASS；有批准记录的比较重基不清零历史。缺账本时 history_known=false、remaining=null，不假设还有八次。
- [CI 持久记录](ci/tools/ci-record.mjs)：独立 completed main dispatch 精确 run-attempt 来源确认；PASS、FAIL、not_run 留存，幂等重试和显式 state SHA lease；损坏或缺失产物留下阻塞诊断。
- [晋升](ci/tools/ci-promote.mjs)：独立 API 来源复查、角色与隔离前提、Scope 阻塞、已记录尝试去重、Baseline/state 原子 lease、Spine 单调增长及发布后证据 digest 桥接。
- [产物校验](ci/tools/verify-artifact.mjs)：保留可运行导入路径；不再把打包伪装成已部署。MVP 前提由[共享计算](packages/delivery-assured/scripts/lib/mvp.mjs)复核，不以单个布尔字段宣布就绪。
- 补充 Intent、Elicitation 模板与[项目 Kernel](project/AGENTS.md)，移除过期全绿、无远端和不存在的保护脚本说明。

## 已实际运行的本地验证

Windows，Node 26.7.0；CI 声明 Node 24 尚未在真实平台核验。各 suite 的计数独立，不冒充互不重叠的交付验收数。

| 测试 | 结果 |
|---|---|
| Evidence 回归 | 70 checks 通过 |
| Verify/accounting 回归 | 24 checks 通过 |
| 收敛与预算回归 | 24 tests 通过 |
| 信任回执反例 | 22 checks 通过 |
| CI 持久记录、手工重试与 resolution 留痕/完整恢复/租约演练 | 93 checks 通过，仅合成 source API 与本地 bare 仓库 |
| bootstrap seed 关系校验 | 62 合成离线 checks；不能以 seed 自称隔离可信 |
| scoped state 完整字节绑定 | 离线反例通过；相同 ledger 下缺 receipt/诊断仍被拒绝 |
| 限制型 Docker 请求及注入/路径/退出码反例 | 离线测试通过；未执行 Docker、不是隔离实证 |
| 临时本地 bare 晋升与打包启动演练 | 32 checks 通过，仅 fixture |
| trusted-CI 离线校验 | 28 checks 通过 |
| CI preflight | 146 checks 通过 |
| reconciliation planner/dispatcher | 7 tests 通过 |
| 最老优先、单请求与定时工作流权限接线 | 11 离线 checks 通过 |
| 原字节绑定的 counted-failure resolution | 35 tests 通过 |
| completed 历史漏项、多次重跑与未知预算合并 | 20 离线 checks 通过 |
| Markdown 结构 | 76 checks 通过 |
| 新模板 | 8 tests 通过 |
| 带空格/中文/# 安装目录下的三类清单定位 | 离线先复现失败，再修复通过；显式项目 override 实际存在 |

安装路径修复：[common helper](packages/delivery-assured/scripts/lib/common.mjs)用标准 `fileURLToPath` 替代手工取 URL pathname，避免 `%20`、中文编码和 `%23` 被当成实际目录；项目 checklist override 修正为相对 project 的 `../packages/...`，不再靠 fallback 掩盖写错路径。[路径回归](tools/checklist-path.test.mjs)在完全独立的带空格/中文/# 临时安装目录加载 cli、api、web_saas 三类清单，已接入 build。

首次初始化恢复修复：空 seed 现在检查未被模型识别的原始历史文件；existing-ledger 验证完整关系图并逐一独立确认来源后保留 receipt/诊断/resolution 原字节，不再只拷贝账本而遗失来源。旧 bootstrap 标记按 digest 归档；当前初始化另记 owner。新增本地 bare-fixture 演练保留原失败账本和 resolution，缺 read token、非 CI、空 seed 抹历史及再次初始化均拒绝，donor state/Baseline 不动。这些 owner/source 都是合成 fixture，不构成真实审批；未证明 INFRA_ABORTED 或权威隔离 Evidence 的历史迁移尚不支持。

最终命令，在仓库根目录运行：

```powershell
node packages/delivery-assured/scripts/verify.mjs --project project --local --slice S1 --json
```

退出 0，8/8 Required 用例实际执行并通过，无跳过或 not_run。build、clean_boot、slice_acceptance、regression_spine 四个门通过；只读 CLI 的 persistence/migration 不适用；deployment 为 CI-only，本地未运行。不是“六门全绿”。本地没有产生 Evidence。

[完整 state 绑定](ci/tools/ci-state-snapshot.mjs)已接入 precheck 和 resolution：绑定精确 SHA 下的 attempts、Spine、recording、retained Evidence 及 Baseline 元数据全部文件集及原始字节，拒绝缺失、额外 resolution、链接和字节变化。不能用“ledger 一样”替代恢复完整 control-state。最新 SHA 配旧的工作树同样被拒绝；恢复全部 state 后幂等重试通过。

当前 Spine 为空，只证明首次完整 Required 集合通过，不能证明保留了尚未存在的父 Baseline Spine。未提供受保护验收 revision 的本地诊断保留警告；额外 git diff 核对显示 Contract 和受保护 spec 未修改。git diff --check 通过。

## 本轮：闭环解阻（v0.5 §10–§13，owner 决定）

上一轮审计确认了一个结构性死锁：`model.mjs` 要求证据自报 `runtime_isolation_verified === true` 才算新鲜，而采集器固定写 `false`（隔离未实现），于是**真实 CI 记录永远不 fresh，而手写的假记录反而 fresh**；同时晋升被一个无人能生产的隔离证明硬门禁封死。本轮按 owner 决定处理：

- [证据判定](packages/delivery-assured/scripts/lib/model.mjs)：`classifyEvidence` 不再读取记录自报的 trust 布尔；新增由**调用方**决定、默认 false 的 `attested` 字段，记录自报值只作为 `claims` 报告。真实采集记录（transport=true / isolation=false）恢复为 fresh，手写记录也 fresh 但永不获得 attested；本地视图的措辞改为如实描述（[Coverage 原因文案](packages/delivery-assured/scripts/lib/coverage-core.mjs)、[resume 输出](packages/delivery-assured/scripts/resume.mjs) 不再写 "trusted"）。
- [晋升隔离门禁](ci/tools/ci-trust.mjs)：拆出 `isolationWarnings`，隔离问题降级为告警；transport、仓库、run 身份与 revision 来源仍为阻塞项（它们有生产者）。[ci-promote.mjs](ci/tools/ci-promote.mjs) 不再因隔离抛错，改为把告警写入 notes 与 Baseline 元数据 `runtime_isolation`；[promote.yml](.github/workflows/promote.yml) 删除无条件 `exit 1`，保留"校验先于凭据"的顺序。
- [部署门生产者](ci/tools/ci-deploy-probe.mjs)：把 `ARTIFACT.json` 记录的打包产物复制到干净临时目录，在里面实际运行 `<install>/project/src/cli.mjs`，再输出 `DSH_DEPLOYMENT_ID`/`DSH_DEPLOYED_CODE_REVISION`/`DSH_DEPLOYED_IMAGE_DIGEST`（revision 与 digest 来自被打包的字节，不是 `DSH_CANDIDATE` 的回显）。[verify.yml](.github/workflows/verify.yml) 在打包之后、验证之前运行它；报告写入 `.agent/artifact/deploy-probe.json`，不污染被校验的产物目录。它明确声明自己**不是** staging 部署、也不是容器/命名空间隔离；MVP_READY 仍要求 staging。
- [preflight 假绿修复](tools/ci-preflight.test.mjs)：原检查只要 workflow "提到 verify-artifact.mjs" 就通过，现在要求存在真正产出部署身份的脚本，且它必须安装并运行产物而不是回显候选。
- 新增[部署生产者回归](tools/deploy-probe.test.mjs)（14 项：打包 revision/digest 来源、实战运行、缺产物为输入错误、入口不可运行必须失败且不输出身份），并接入 build gate。
- 删除 `project/.agent/artifact/delivery-assured/` 的陈旧产物（旧布局，digest 与当前源码不符，会让 `verify-artifact --check` 假失败）。

仍然成立：本地的一切输出都不是凭证。本轮只把"真证据被拒、假证据被收"的判定反转与"没有任何东西能产出部署身份"这两处结构性阻塞拿掉，没有降低 `validateEvidenceRecord` 的任何断言。

## 本轮：DSH 监督层（v0.3 §9.2 A / §4.3，v0.5 §12）

v0.5 弱化了 DSH 环境，v0.3 补的就是这一层：让会话自己带着"还欠什么、什么是可信、什么不能碰"工作，而不是靠 Agent 自觉。

- [受保护路径 guard](plugins/dsh-delivery-assured/lib/guard.js)：用锁定宿主提供的 `ctx.tools.guard()` 注册同步判定（宿主 0.2.0-rc.2 实测存在，且拒绝是**单调**的——后续监听器不能把拒绝翻回允许）。命中 `.agent/CONTRACT.yaml`、`.agent/project.yaml`、`tests/acceptance/spec/**`、`ci/verifier.yaml`、`.agent/evidence/**`、`ci/evidence|baseline|recording/**` 以及仓库级 `.github/workflows/**`、`ci/tools/**`、`packages/delivery-assured/**`，或 `refs/heads/baseline|delivery-state|standards` 就拒绝；`tests/acceptance/driver/**` 刻意不保护（Candidate 的适配面）。操作包自身仓库可用 `protectRepoMaterial: false` 关闭仓库级那一层，否则改进操作包会被当成 Candidate 越权。
- [Global Kernel](plugins/dsh-delivery-assured/lib/kernel.js)：`ctx.systemPrompt.variable('delivery_kernel')` + 引用它的 prompt 段，每次请求带上项目/候选/可信起点/还欠/预算/下一步与铁律。内容由操作包自己的 `resume.mjs --offline` 渲染（同一套事实），provider 同步所以带缓存，未就绪时明确写"尚未就绪"。
- [一键安装](plugins/dsh-delivery-assured/install.mjs)：链包 + 加 bundle + 写 `cordis.patch.yml` 配置 + 跑自检 + 备份/回滚，幂等且可 `--uninstall`；[19 项回归](tools/install-plugin.test.mjs)覆盖 dry-run 不落盘、错误项目根被拒、重复安装不重复且不覆盖备份、卸载还原原字节。
- [v0.3 §4.3 七项探针](plugins/dsh-delivery-assured/test/trust-boundary.test.mjs)：在 desktop `0.2.0-rc.2` 与 profile `0.1.5-rc.3` 两个宿主上实测 26 项并逐条给结论——**P6 可用**（工具调用可被拒绝且不可翻转）、**P7 部分可用**（`tools/pre-execute → execute → post-execute → result` 四段流水线存在；`step/start`、`step/end` 只能观察，**没有可以拒绝模型步骤的 pre-step gate**）、P1/P4 由 CI 强制、P2 由反例套件证明、P5 仍只有离线演练。结论：插件层能"转向"，不能作为可信边界——与 v0.5 §16.5 的分工一致。
- [跨项目验证反馈表](packages/delivery-assured/templates/VALIDATION_FEEDBACK.md)：供在下一个真实项目里回填（元信息、必跑命令与原始输出、§19 遗漏表、五个计数、guard/内核记录、阻塞与绕行），并写明"每项优化必须能指到文档某一行"。

build gate 新增两项：host trust boundary（需要 DSH 运行时）与一键安装。

### 事故复盘：插件把模型请求打挂（两次），以及第一次"修复"为什么无效

现象：装进 `desktop` profile 后，会话在下一个模型请求失败：
`Invalid schema for function 'delivery_attempts': schema must be a JSON Schema of 'type: "object"', got 'type: null'`。

两个已确认的事实：
- provider 收到的是 `tool.parameters` **原样**（`dsh-llm-deepseek`：`input_schema: tool.parameters`）；
- 插件在解析不到宿主 `defineTool` 时退化为**直通实现**（把作者格式的 spec 原样返回），而当时的判定是"直通 = 可以注册"。

因此最可能的致因是**直通路径**：未编译的 spec 没有 object 根 → provider 拒绝整个请求；五个工具的 schema 一起坏，provider 只报字母序第一个（`delivery_attempts`）。
第一次"修复"只改了**解析顺序**（宿主本地 `app.asar` 优先），我在没有真实宿主验证的情况下把它当成结论，并且在应用运行时反复改它的 profile——第二次报错说明它没有解决问题。这是我的判断错误加操作错误，两条都记在这里以免重犯。

本轮改为四道防线，全部默认"不注册"（宁少五个工具，也不发坏 schema）：
1. **直通即拒绝**：`toolRegistrationVerdict` 中 `passThrough → refuse`，任何环境都不注册；
2. **peer 线一致才注册**：解析到的 helper 版本必须等于插件声明的 `^0.2.0-rc.2` 基线（预发布线互不满足），否则拒绝；
3. **注册前 schema 自检**：`schemaIsProviderSafe()` 要求 object 根且不含 `type: null`，不通过就不注册；
4. **拒绝只降级、不抛错**：技能、guard、内核照常加载，并打印可执行的修复指引。

安装器不再触碰运行中的 profile：[install.mjs](plugins/dsh-delivery-assured/install.mjs) 对 `desktop` profile 默认**拒绝执行**（打印步骤、一行不写），只有应用完全关闭且显式 `--enable-desktop` 才写；`--dry-run` 可先看计划；也不再自动改 `dsh.profile.bundles`（该字段归应用的插件管理器，它会在运行时重写）。

回归：[smoke](plugins/dsh-delivery-assured/test/smoke.mjs) 断言"无宿主 helper 时必须注册 0 个工具并给出日志"；[host-resolution](plugins/dsh-delivery-assured/test/host-resolution.test.mjs) 33 项覆盖桌面宿主（5 工具、schema 无 null、版本一致）与三种拒绝（直通、外来线、版本不匹配），以及 CLI 线（0.1.5）同样拒绝；[install 回归](tools/install-plugin.test.mjs) 39 项覆盖"运行中的 desktop profile 被拒绝且不落盘"。

**仍未验证**：以上只能证明"插件不会再发出坏 schema"，不能证明在真实宿主里工具**一定能注册成功**——那需要一次干净启动（关闭应用 → 安装 → 启动）才能确认，不能再靠热改 profile 去试。

## 真实 CI 闭环（首次，2026-10-04）

修复推上远端后跑通真实链路（`main` = `standards/acceptance` = `b4e127e`）：

| 步骤 | run | 结果 |
|---|---|---|
| `promote.yml` → `bootstrap-state`（owner `wangxiaow`，seed `owner-approved-empty`） | `37178817434` | 成功，创建 `refs/heads/delivery-state/main` |
| `verify.yml`（candidate `b4e127e`、parent none、Slice S1） | `37178837431` | **成功 43s**：六个门 passed/not_applicable，8/8 Required 用例真实执行，产出 Evidence |
| collector（`workflow_run` 自动触发） | `37178879661` | 成功，把精确 attempt 写入 durable state |
| `promote.yml` → `promote-baseline`（`expected_parent=none`） | `37178891695` | 成功，晋升 **BL-000**，`refs/heads/baseline/main` = `b4e127e` |

durable state（`refs/heads/delivery-state/main` = `f019d86b`）现含：`ci/baseline/BL-000.json`、`ci/evidence/*`（2 条）、`ci/recording/bootstrap.json` 与 `receipts/37178837431-1.json`、`.agent/attempts.jsonl`、`tests/spine/manifest.yaml`（累积 8 个 case id）。

BL-000 记录：`machine_verified_outcomes` 8 项、`remaining_outcomes` 3 项、`manual_reviews_pending` 1 项；`runtime_isolation.verified: false` 并带"仅告警、不阻塞晋升"的说明（owner 决定的可见落点）。

**新会话恢复实证**：把该状态覆盖到 `b4e127e` 的干净 clone 上运行 `resume --offline` → `baseline: BL-000 @ b4e127ec`、`verified 8`、`budget attempts 1/8`、上一条尝试带真实 CI run 与 hypothesis。跨会话不再失忆，本地读数同时如实标注"来源未经本地确认"。

### 首次真实晋升暴露的缺陷：Baseline 元数据没有记录晋升它的 run

读 durable state 时发现 `BL-000.json` 的 `promotion_run_id` 与 spine 的 `updated_by` 都是 `local-dry-run`：`promote.yml` 的晋升步骤 env 里没有 `DSH_CI_RUN_ID`，`ci-promote.mjs` 因此回落到该默认值。证据本身（`evidence_refs`、`receipts/*`）是正确的，缺的是**权威记录对自己的来源指认**——只有读状态引用才会发现，工作流跑绿并不会报。

修复：晋升步骤补 `DSH_CI_RUN_ID: ${{ github.run_id }}-${{ github.run_attempt }}`，并在 [ci-record 回归](tools/ci-record.test.mjs) 增加断言（100 项）。已写入的 BL-000 记录不重写——不篡改权威记录，缺口如实记在此处；BL-001 起携带真实 run。

### 已修：晋升过一次之后第二个 Baseline 晋升不了

第二轮/第三轮真实证据都在，但 `promote-baseline`（`expected_parent=BL-000`）被拒：

```text
PROMOTION BLOCKED convergence budget or ledger is blocked: []
the protected baseline ref was not moved.
```

机制（读 durable state + 代码确认）：`attemptFromCI` 把 `standard_digest = standardDigest(bindings, environment)` 记进预算账本，而该摘要**包含 `spine_manifest_digest`**。BL-000 晋升时把 8 个 case 累积进 Spine，标准摘要随之从 `3e37a0c6…` 变成 `1e62a651…`（acceptance/contract/verifier 摘要都没变，case 集也没变）。于是 `sameStandard(最新 pass, 首轮 pinned)` 恒为 false → `fixedByKey` 既不 advance 也不 rebase → `terminal_passed=false` → 同根因达 3 → `requires_replan=true` → 阻塞。**Spine 累积是系统自身推进的结果，却被当成"标准变了"，导致 Baseline #0 之后无法再晋升任何候选。**

修复（owner 决定：Spine 累积自动重基）：
1. 比较身份拆成组件：[comparisonDigest](packages/delivery-assured/scripts/lib/convergence.mjs) 只含 contract/acceptance/verifier/依赖/migration/slice 摘要，**不含 Spine**；账本条目另记 `comparison_digest` 与 `spine_digest`，`standard_digest` 保留用于兼容与审计。
2. 旧条目**不改写**：缺少 `comparison_digest` 时从它引用的不可变 Evidence 现场派生比较身份（`identityOf`）；两侧处于不同身份空间时退回完整摘要比较，避免"比较身份 vs 完整摘要"永远不等的假阻塞。
3. Spine **只能增长**：某次尝试丢掉了此前累积的 case 记 `Spine shrank …` 并置 `history_known=false`、阻塞——削弱不会被放过；增长则记入 `spine_accumulations` 供审计。
4. 诊断补齐：`ci-promote` 阻塞时分别输出 `invalid_entries`/`budget_blocked`/`requires_replan`/`terminal_passed`/`critical_open`/counted/limit，不再只打印一个空数组。

**差点踩到的兼容陷阱**：拆分时我把 `standardDigest` 的键顺序改了（spine 与 slice 互换），摘要随之变化——用真实账本复算时立刻报出两条 `CI summary mismatch: standard_digest`。历史账本里每个条目的摘要都是按原顺序算的，所以键顺序现在是显式常量 `STANDARD_KEYS` 并附注释。这个只有拿真实状态复算才会发现，单元测试全绿也照样漏。

验证：convergence 套件 27/27（含新增"Spine 累积不破坏比较窗口""比较身份变化不被静默折叠""Spine 只能增长"）；**用 `delivery-state/main` 的真实账本复算** → `terminal_passed: true`、`blocked: false`、`invalid_entries: []`、`spine_accumulations` 报出 8 项。

修复后在真实 CI 重跑同一条证据的晋升（run `37181131525`）→ **BL-001 晋升成功**：`refs/heads/baseline/main` = `038cb0ae`（第三轮候选），`parent_baseline: BL-000`（首次真实父基线链），`promotion_run_id: 37181131525-1`（归属修复生效），evidence `ci:verify:37180552926-1`，机验 8 项 / 剩余 3 项，Spine 8 个 case 且 `updated_by` 指向该晋升 run。至此链路为 **verify → collector → promote（带父基线与 Spine 单调累积）**，每条权威记录都指认自己的 run。


## 尚欠工程与外部实证

1. **可运行、可独立实证的隔离后端仍未实现。** 已增加[限制型请求模块](ci/tools/ci-isolation.mjs)：固定 digest、non-root、无网络、只读输入、独立输出、资源限制、cap-drop、无主机环境继承及 shell；注入执行器的零退出始终不授予 runtime trust 或 Promotion。这个模块没有真实 executor，没有锁定/独立证明实际 mount 和 namespace；现有 verifier 的项目内写入也尚未适配只读输入，不能把请求参数或合成测试当作端到端可用后端。 本机 Get-Command docker 未发现 Docker CLI，未连接 daemon 或拉取镜像，不能以本机现有环境实证容器隔离。 候选和 verifier 目前不能凭复制 canonical 文件获得进程/文件系统隔离保证。collector 忽略候选自行提交的 trust 字段，仅将 transport 标为已确认，runtime_isolation_verified 固定 false；这些观察不能关闭 Coverage。**本轮已按 owner 决定把隔离从晋升硬门禁降级为告警：** `promotion.yml` 不再无条件阻塞，告警写入 Baseline 元数据 `runtime_isolation`，transport/仓库/run 身份/revision 来源仍阻塞。真实隔离后端依旧是欠账，不能用自报布尔值替代。
2. **未计数诊断恢复与真实 reconciliation 实证尚欠。** [定时工作流](.github/workflows/reconcile.yml)已实现 main-only 自动核对并请求一条最老的精确漏项，独立 concurrency、actions-write-only dispatcher，不持有 state/baseline 写凭据。HTTP 204 不清除缺口，必须下一轮独立 receipt 核对；7 项计划/传输反例及 11 项接线检查通过，未执行真实调度。 已增加 main-only `record-attempt` 手工重跑 collector 入口，独立确认精确来源与产物，不授予 Baseline 能力；已有 receipt 不覆盖。`resolve-diagnostic` 接入独立 owner 审批环境、明确 state SHA lease 和不可改写的原字节 digest；仅处理已完整保留、已计数的 FAILED 记录，原失败、原诊断和 Evidence 保留，新增 resolution 不转换为 PASS。[35 项纯校验](tools/ci-resolution.test.mjs)和[本地持久留痕演练](tools/ci-record.test.mjs)通过，实际环境审批尚未核验。 concurrency 不是持久队列，pending job 可能被替换；[历史核对](ci/tools/ci-history.mjs)已接入 precheck：独立只读 API 分页检查每个精确 completed attempt，包括同 run 的早期重跑；漏 receipt、分页不完整、限额耗尽及冲突均阻止新候选执行。20 项离线检查已通过；发现历史缺口后预算同步置 history_known=false、remaining=null、terminal_passed=false，不能只显示阻塞却继续展示“还有八次”或终态 PASS。自动补录需要实际平台权限及调度实证，平台已删除的历史也不能据此当成不存在；未解决诊断继续阻塞。不能声称预算记录已获平台端无遗漏保证。
3. **真实平台保护未核验。** origin 已配置，本地跟踪引用存在；不是“没有远端”。CODEOWNERS、标准更新身份、state/PROMOTION 身份、环境审批和非授权推送拒绝都尚待实际验证。
4. **账本初始化欠确认。** 当前日志缺失、余量未知；不得造一个零次历史。首次 bootstrap 要 owner 确认 seed，已有 state 禁止重置。
5. **真实 staging、发布前提和最终 owner Journey Review 缺失。** 未确认部署同候选/镜像，未取得版本绑定的人工回执，不宣称 MVP_READY。MVP 计算/晋升接口的真实正向通路尚未完成实证。

最后一次[离线恢复工具](packages/delivery-assured/scripts/resume.mjs)退出 1 是预期阻塞：0 条可信 Evidence、无真实 Baseline、11 项 Required 尚无当前交付证明，另有缺账本与四条当前 Critical 证明缺口。代码存在和本地测试通过不把这些项转成已交付。

[保护与操作前提](ci/protection/README.md)说明角色边界和初始化条件；[可编辑状态摘要](project/.agent/STATE.yaml)不是第二份权威账本。当前会话默认工作目录不等于目标仓库，所有诊断均显式指向本仓库的 project。
