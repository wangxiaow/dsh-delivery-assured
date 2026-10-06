# 有限的 Frozen TCB（Trusted Computing Base）

这份说明只讲一件事：**普通 Candidate 不能在交付过程中修改"判断它自己是否 Delivered"的逻辑，
再用修改后的逻辑证明自己成功**。它记录已实现的部分、明确不做的部分，以及修改 TCB 时必须走的流程。

它刻意不是"验证器的验证器的验证器"：TCB 是一份**有限、具名**的文件清单加一个摘要，每次验证只检查一次。

## TCB 是什么

`packages/delivery-assured/scripts/lib/tcb.mjs` 的 `TCB_FILES` 就是全部内容。它覆盖从 Contract 到
`Delivered` 这条路径上真正会改变结论的模块：

```text
packages/delivery-assured/scripts/verify.mjs                验证入口与门执行
packages/delivery-assured/scripts/resume.mjs                会话侧恢复与同一判定重算
packages/delivery-assured/scripts/lib/common.mjs            标准绑定、摘要、路径与 Git 读取
packages/delivery-assured/scripts/lib/yaml.mjs              Contract/verifier/manifest 的解析
packages/delivery-assured/scripts/lib/evidence.mjs          记录校验（后端各自的规则）
packages/delivery-assured/scripts/lib/model.mjs             Contract/manifest/Slice 解析、证据新鲜度
packages/delivery-assured/scripts/lib/selection.mjs         Required 集合推导
packages/delivery-assured/scripts/lib/completion.mjs        Delivered 判定
packages/delivery-assured/scripts/lib/coverage-core.mjs     义务到证据的覆盖计算
packages/delivery-assured/scripts/lib/capability.mjs        backend capability completeness
packages/delivery-assured/scripts/lib/convergence.mjs       预算、无进展窗口、Replan 判定
packages/delivery-assured/scripts/lib/mvp.mjs               MVP_READY 判定
packages/delivery-assured/scripts/lib/standard-freeze.mjs   冻结/漂移检查
packages/delivery-assured/scripts/lib/verification.mjs      后端策略与 issuer 断言
packages/delivery-assured/scripts/lib/env.mjs               子进程环境构造（allowlist）
packages/delivery-assured/scripts/lib/state-view.mjs        状态来源与预算唯一入口
packages/delivery-assured/scripts/lib/durable-state.mjs     权威状态读取（越界即拒绝）
packages/delivery-assured/scripts/lib/gh-api.mjs            权威状态传输
packages/delivery-assured/scripts/lib/worktree-git.mjs      本地 Git 事实读取
packages/delivery-assured/scripts/lib/tcb.mjs               这份清单与它的检查器本身
plugins/dsh-delivery-assured/lib/host.js                    默认完成路径的启动器/授权边界
plugins/dsh-delivery-assured/lib/tool-surface.js            Agent-facing 参数面（audit 对象）
```

不在 TCB 里的东西是刻意的：验收 spec、driver、产品源码、workflow、文档、测试，
以及插件里的 guard/kernel/bridge——它们**引导**会话而不决定判定（guard 自己也写明"是转向，不是边界"）。
改这些不会改变"谁有资格判定"，只改变"判定什么"。

## 冻结时记录什么

`verify.mjs --freeze-standard` 在 `.agent/standards/FREEZE.json` 里除标准文件摘要外还记录：

```json
{
  "tcb_version": 2,
  "tcb_files": { "packages/delivery-assured/scripts/lib/completion.mjs": "<sha256>", "...": "<sha256>" },
  "tcb_digest": "<sha256 of the sorted path:digest list>",
  "previous_tcb_digest": null
}
```

`tcb_version` 是"TCB 集合本身"的版本：集合变化（增删成员，或某个成员的含义变了）必须同时升版本，
否则新加入的文件会被判成漂移。本轮的集合扩展把版本升到 **2**，所以用 v1 冻结的旧记录会以
`TCB_VERSION_MISMATCH` 被拒绝，需要一次控制平面重冻结（见下）。

## 验证时检查什么

`verifyFreeze()` 在任何门执行之前重新计算 TCB 并比对：

| 情况 | 结果 |
|---|---|
| TCB 成员字节变了 | `TCB_DRIFT` → `NOT_DELIVERED`，一门都不执行 |
| TCB 成员被删除 / 新成员未记录 | `TCB_DRIFT` |
| 冻结记录里的 `tcb_digest` 与它自己的 `tcb_files` 不一致 | `TCB_RECORD_TAMPERED` |
| `tcb_version` 与当前实现不同 | `TCB_VERSION_MISMATCH` |
| 冻结记录没有 TCB 字段（本次改动之前冻结的标准） | `TCB_NOT_RECORDED`，需要按下面的流程重新冻结 |
| TCB 未变 | 继续验证 |

会话侧的 `resume` 也会重算同一次检查，所以**未提交**地改动 TCB 之后，恢复摘要不会继续报 Delivered。

## 为什么"改 verifier + 改 digest 文件"不管用（以及它挡不住什么）

当 TCB 就位于候选自己的仓库里（本仓库这种"自托管"形态：验证器与产品一起发布），除了摘要比对，
还会做一次 **frozen revision 上的 Git blob 比对**：

```text
git rev-parse <frozen_revision>:<tcb path>   ==  git hash-object <worktree tcb path>
```

Candidate 可以改 TCB 文件，也可以把 `FREEZE.json` 里的 `tcb_digest`/`tcb_files` 改成与新文件一致，
但只要 `frozen_revision` 没变，`<frozen_revision>` 上的字节就不会变，比较仍然不等 → `TCB_DRIFT`。
Git blob id 不受换行过滤器影响，所以"改了但看起来没改"也不成立。

**这两条挡不住什么**（同样写在这里，免得被当成保护）：

1. **同时改写 `frozen_revision`。** 锚点本身就是冻结记录里的一个字段，而冻结记录是 Candidate 能写的文件。
   "改 verifier → 提交 → 把 `tcb_files`/`tcb_digest`/`frozen_revision` 一起指向那个提交"会得到一个
   自洽的记录，纯本地读取无法区分。真正的锚点在外部（CI 从 canonical 取包、受保护引用禁止改写历史）。
2. **改写 `tcb.mjs` 自己。** 一个被改成"永远返回 ok"的检查器必然报告自己 ok。`tcb.mjs` 是 TCB 成员，
   所以对它的**其他**改动都会被判成漂移，但"关掉检查"这一种按构造无法被自己发现。

这两条都是 control-plane 层面的伪造，不是普通交付轮次能顺手做到的事；普通交付路径下，
[宿主后端](AUTO_DELIVERY.md) 会先遭遇 #1 的自查，而 CI 后端根本不使用候选的包。
[frozen-tcb 回归](packages/delivery-assured/tests/frozen-tcb.test.mjs) 把两条都写成显式的固定用例。

当 TCB 在候选仓库**之外**（普通项目：操作包装在别处）时，Git 比对不做，报告写明
`external: true`、`git_checked: false`：那份操作包本来就不属于候选的 revision，Candidate 无法改它，
摘要防的是"冻结与验证之间操作包被就地升级"。

## 本轮明确不做的事

- **不做验证器递归**：没有"验证 Verifier 的 Verifier"，也没有自动升级链。
- **不做远程 attestation**：TCB 摘要不是远程证明，只是一个有限清单的本地比对。
- **不做完整 sandbox**：TCB 不隔离进程，只冻结"谁判定"。
- **不新增状态层**：`tcb_*` 直接落在已有的冻结记录里，不引入第二套 manifest。

## 已知残余（必须如实报告）

比对锚点是冻结记录里的 `frozen_revision`，而冻结记录是 Candidate 能写的文件；另外检查器无法发现
"自己已被改成永远通过"。这一层的封堵不在普通交付路径里：

1. 受保护 CI 后端从 `canonical` 取 `packages/` 与 `plugins/`（`ci/tools/ci-stage.mjs`），候选改动
   这些目录会被直接拒绝，所以这条伪造在 CI 后端不成立；
2. `main` 与 `standards/acceptance` 已有分支保护与必需检查，历史不可改写；
3. 宿主后端下这一层只能靠"改控制平面必须走独立流程"这条纪律，下面把它写清楚。

## 修改 TCB 的流程（control plane，不是普通交付）

修改 `TCB_FILES` 里的任何文件——升级 verifier 逻辑、修 Delivered 判定、改后端能力模型——**不是**
一次普通 Candidate 迭代，必须按独立维护流程完成：

1. **独立改动与评审**：在单独的改动里修改 verifier，与产品需求分开；由当前已信任版本的测试
   （`project/scripts/verify-build.mjs` 全部套件，含 `frozen-tcb.test.mjs` 与 `agent-surface.test.mjs`）
   与 owner review 共同确认。
2. **由已信任版本验证**：改动本身必须通过**当前**（旧）TCB 的检查，而不是通过它自己新写的检查。
   也就是说，新 verifier 必须在旧版本下被验证为"没有削弱任何判定"。
3. **合并到受保护主线**：经受保护分支与必需检查（CI 的 `structural checks` / `verify candidate`）合并。
4. **成为下一轮 TCB**：合并后，新项目重新 `--freeze-standard` 得到新的 `tcb_version`/`tcb_digest`；
   已有项目需要一次显式的标准重冻结。CLI 上有 `--allow-tcb-change`，它**不出现在任何 Agent-facing
   tool schema 里**——这是让控制平面动作显式、可审计，而不是安全边界（会话有 shell，可以执行任意命令）。
   真正的边界是第 1–3 步加上 CI 从 canonical 取包与受保护引用。
5. **不追溯旧记录**：已经写入的 Evidence 与 Baseline 不重写；摘要变化只会让它们按绑定过期，
   需要新的真实执行。

在宿主后端下，`createFreeze` 对"TCB 变了但没带控制平面授权"的重冻结直接拒绝：
`TCB_CHANGE_REQUIRES_CONTROL_PLANE`。带授权的重冻结会把 `from_tcb_digest`/`to_tcb_digest` 记入
`history`，因此"verifier 换过版本"在冻结记录里一直可见。
