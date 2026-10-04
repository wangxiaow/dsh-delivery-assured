# MVP 最终评审与晋升（内部演示范围）

## 边界

- [Contract](../.agent/CONTRACT.yaml) 的 DEC-8 只批准本仓库用 `production_like_ci`，不把 CI 临时安装叫作 staging，不免除人工 Review、任何 Required/Spine 或原有发布前提。未配置的其他项目默认仍要求 staging。
- 安装探针的实例会被清理；保留的是同一候选的不可变产物与运行报告，不是在线环境。DEC-10 已另获 owner 明确批准：在全新本地目录实走同一不可变候选/镜像，结合原 CI 观测评审，回执区分原 source_deployment_id 和实际 replay_deployment_id、评审目录、fresh identity/workspace。不得声称在已消失的实例上做过操作。这只批准方法，不授予 Review PASS。未明确批准的其他项目不采用这条例外。
- 只有 owner 的实际确认才形成 Review PASS。Agent 不得因为能使用 owner OAuth 令牌而自行发布 PASS。当前共用凭据不能证明独立人机身份隔离。
- 原始机器 Evidence 不可回写 `execution.mvp_ready`、部署 ID 或执行结果。最终晋升 CI 验证两个独立来源（GitHub 精确 verify attempt、owner 评论），生成单独的全契约最终回执。

## 顺序（不要重跑安装来套用旧回执）

1. 获批环境标准以快进更新 `standards/acceptance`，记录 DEC-8 与实际 diff。修改标准不是 append-only 自动冻结，必须有明确 owner 确认。本次不改任何受保护验收断言。
2. 新候选预演已在真实 3 次历史上触发原规则的 Replan 硬门禁（原机验计数均为 8/8，不能凭新 checkout 继承旧终态）。owner 已批准 [正式 Replan 提案](../.agent/REPLAN.yaml) 与 [CI state-only 入口](../../.github/workflows/record-replan.yml)：先对精确 state SHA 执行 `record-replan`，确认其独立收据与追加账本。它仅消耗 1/2 Replan 配额，保留全部 11 个 Required 义务，不清零 3 次 attempt，不执行 Candidate、不形成 PASS。
3. 冻结新候选，在原父基线（当前 BL-001）上跑一次普通 `verify`，执行全部 8 个 Required case 和全部累积 Spine。标准比较变化使用显式 `comparisonApprovalRef=DEC-8-ENVIRONMENT`；原 3 次 attempt 永不清零。
4. 等 collector 将成功/失败精确归档到 `delivery-state/main`。**不要先晋升中间 Baseline**：最终 MVP 晋升仍使用这次 Evidence 的原始父基线。
5. 下载精确 run-attempt 的保留产物及原始 Evidence；在对应候选检出上恢复同一受保护标准与当前状态。用 [准备工具](../../tools/prepare-owner-review.mjs) 生成 PENDING 草稿：

   ```powershell
   node tools/prepare-owner-review.mjs --project <恢复后的候选/project> --evidence <下载的原始/evidence.json> --out <新文件/review-draft.md>
   ```

   工具按原始 Buffer 哈希，拒绝非法 UTF-8、缺失/过期证据及覆盖已有文件。它不会写权威 Review 或授予 PASS。

6. owner 实际评审 `J-DELIVERY-STATUS.ready` 与 `C-INPUT-DIAGNOSTICS`：
   - 同一保留 CLI 产物的人类表格与 JSON 列出一致的 Required 集合及阻塞依据；结果不把 STATE/DONE 或本地绿灯当完成。
   - 重复调用不写文件；错误输出走 stderr，状态事实走 stdout；非法命令/选项/缺 Contract 为退出码 2，欠账为 1，完整闭合才为 0。
   - 独立检查原 Contract 的每条发布前提，尤其 **main 必需 verify 检查**；禁强推/删除不能替代必需检查。
   - 对本次环境变更的精确比较重基单独确认：草稿中的 `comparison_rebase.status` 只有实际同意后才改为 `approved`。这只移动比较基准，不改历史、预算、必需 case 或旧失败。
7. 仅在实审后，把草稿中对应 PENDING 改为 PASS（比较重基使用 approved），**不得改 bindings**。以配置的 product owner 账号，在本仓库 issue 中发表唯一一个 `delivery-approval` JSON fenced block；取得精确评论 URL。需要组织仓库时在冻结配置的 `ci.product_owner` 明确配置账号；本个人仓库默认 repository owner。
8. 发起 `promote` 的 `MVP_READY`，填写原 verify run/attempt、原 expected_parent 和 `owner_approval_ref`。晋升不构建、不部署、不执行 Candidate，只独立认证来源、校验保留字节和当前标准、重新计算 Coverage/Review/预算，并原子推进 Baseline 与状态。

## 防止假闭环

[最终回执逻辑](../../ci/tools/ci-mvp.mjs) 拒绝错误账号/机器人/应用作者、跨仓库评论、重复 JSON block、错误候选/标准/镜像/部署/原始字节摘要、缺 Review/发布前提以及占位确认。Review 必须匹配所选最终机器记录；不能从另一条仍新鲜的部署借用。

[晋升入口](../../ci/tools/ci-promote.mjs) 保留历史的最新失败优先级；晋升前及发布前审核 GitHub 已完成记录，拒绝未收集的结果和在途验证。恢复状态必须逐字节匹配固定 state SHA，最后用显式 lease 原子推送。已解决的 recording diagnostic 原文保留，只有未解决/不合法的诊断阻塞。

最终回执保存在 `project/ci/recording/mvp-finalizations/<promotion-run-attempt>.json`；Review 投影、MVP 标记、标准比较审批与 Baseline 元数据一起持久提交。换会话恢复不依赖本地临时文件，也不增加一次 Candidate attempt。

## 当前未完成

环境审批已经取得；它不等于最终 Review。未得到本轮真实机器证据、owner 最终 Review、原有发布前提回执前，不能称为 MVP_READY。DSH 插件实际冷安装与真实隔离后端也不能由这次 CLI 内部演示晋升代替验证。
