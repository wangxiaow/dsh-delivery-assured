# 权限与分支保护：生效步骤与未生效时的处理

本目录提供的是**声明与模板**，不是已经生效的保护。v0.5 §12 要求权限效果真实成立，
所以这里的每一条都写明「怎么算生效」和「没生效时怎么办」。

## 必须成立的四件事

| 对象 | 权威来源 | 最小限制 | 怎么算生效 |
|---|---|---|---|
| Contract、清单处置、确认记录 | 受保护标准版本 + owner 确认记录 | Agent 工作区修改只是提案 | `main` 的 PR 要求 CODEOWNERS 审批，且 `/agent/CONTRACT.yaml` 在 CODEOWNERS 覆盖范围内 |
| Acceptance spec、manifest、Spine | 受保护标准版本 | 实现 PR 不得直接改动；纯新增走标准更新通路 | `refs/heads/standards/acceptance` 存在且 `verify / structural checks` 必需 |
| verifier、workflow、保护配置 | 受保护的可信版本 | Candidate 不能替换验证命令或晋升逻辑 | 验证 job 从 canonical revision 取 `ci/`，不取 Candidate 的 |
| Evidence | CI job 与受控产物 | Agent 不得写入权威结果 | `DSH_CI_ISSUER` 只在验证 job 内注入；本地无此变量则无法写证据 |
| Baseline | 受保护远端引用 | 仅 Promotion job 身份可推进 | `refs/heads/baseline/*` 的 push 限制只放行 Promotion 身份 |
| 部署状态 | 环境报告与 CI 部署记录 | 记录真实运行版本 | 部署门读取 `DSH_DEPLOYED_CODE_REVISION` 并与候选比对 |

## 应用步骤（GitHub）

`branch-protection.json` 是声明式描述，字段名与平台一一对应但不保证完全一致，
所以**用 API 应用并逐项核对**，不要把它当成可直接上传的配置。

```powershell
# 1. 前提：仓库管理员权限，以及一个用于 Promotion 的机器身份（GitHub App 或 deploy key）
$env:GH_TOKEN = "<admin-token>"
$repo = "wangxiaow/dsh-delivery-assured"

# 2. 主分支：必需检查 + CODEOWNERS 审批 + 禁止强推与删除
gh api -X PUT "repos/$repo/branches/main/protection" `
  -F "required_status_checks[strict]=true" `
  -F "required_status_checks[contexts][]=verify / verify candidate" `
  -F "required_status_checks[contexts][]=verify / structural checks" `
  -F "required_pull_request_reviews[require_code_owner_reviews]=true" `
  -F "required_pull_request_reviews[required_approving_review_count]=0" `
  -F "enforce_admins=true" `
  -F "allow_force_pushes=false" `
  -F "allow_deletions=false" `
  -F "restrictions=null"

# 3. Baseline 引用：只有 Promotion 身份可推
gh api -X PUT "repos/$repo/branches/baseline%2Fmain/protection" `
  -F "enforce_admins=true" `
  -F "allow_force_pushes=false" `
  -F "allow_deletions=false" `
  -F "restrictions[users][]=<promotion-bot>" `
  -F "restrictions[apps][]=<promotion-app>"

# 4. 让标准更新通路有能力推进 standards/acceptance，其他身份不行
#    （在 ruleset 的 bypass 列表里只放标准更新机器身份）

# 5. 建标准引用（首次；之后只由 standards-update 通路推进）
git push origin main:refs/heads/standards/acceptance
```

`CODEOWNERS` 与两个 workflow 已经就位（`.github/CODEOWNERS`、`.github/workflows/`），
不需要额外复制。改完 workflow 后跑 `node tools/ci-preflight.test.mjs` 检查路径是否仍然有效。

CLI 的 `gh` 参数名在不同版本间有过变化。执行后必须**逐项验证**，不要以命令退出码为准。

## 怎么验证保护真的生效（必做）

保护生效与否不靠推断，靠一次真实的拒绝：

1. 用一个**不具备** bypass 权限的身份，尝试直接推送 `refs/heads/baseline/main`。
   期望：被拒绝。若成功，说明保护未生效。
2. 提交一个修改 `/tests/acceptance/spec/` 的 PR。
   期望：`verify / structural checks` 失败，且需要 CODEOWNERS 审批。
3. 提交一个删除某个必需 case 的 PR。
   期望：`ci-standards-diff` 拒绝，退出码 1。
4. 用缺 `DSH_CI_ISSUER` 的环境运行 `verify --write-evidence`。
   期望：退出码 2，不产出任何 evidence。

四项里任何一项不符合期望，都按「保护未生效」处理并记录为阻塞。

## 未生效时的处理（当前状态）

本仓库目前**没有远端仓库、没有 CI 权限、没有分支保护**。按 v0.5 §17.1 的要求：

- 配置、脚本、模板全部写好并就地可查；
- 本地完成了可验证的部分：五个脚本、8 条验收用例、6 个门在本地全绿；
- 受保护引用、Evidence 产物、Baseline 晋升、真实 staging 全部列为**阻塞**，
  并且在 `.agent/STATE.yaml` 的 `blockers` 里如实登记；
- 不把任何写好的 YAML 说成保护已开启。

想在本机先把晋升链路走通，用 `ci/protection/apply-protection.ps1` 建立本地 bare 仓库
模拟受保护引用。**注意**：本地 bare 仓库能证明晋升逻辑正确，但**不构成平台级保护**，
报告时必须写清这一区别。
