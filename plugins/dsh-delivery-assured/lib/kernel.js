/**
 * Always-on Global Kernel for a delivery session (v0.3 §9.2 A).
 *
 * The model should not have to be told, again, what the product is, what is still
 * owed, what is trusted and what is protected. This module renders one compact block
 * from the operation pack's own `resume` output — the same recomputation a human
 * gets, never a second source of truth — and publishes it as a system-prompt
 * variable so every request carries it.
 *
 * It is a *steering* aid, not authority: the text says so, and nothing here writes
 * state. The prompt variable provider is synchronous, so the text is cached and
 * refreshed in the background; an assembly that happens before the first refresh
 * sees an explicit "not ready" line instead of a stale or invented one.
 */

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { runScript } from './bridge.js'
import { BOOTSTRAP_PHASE, bootstrapNextActions } from './bootstrap.js'

export const KERNEL_VARIABLE = 'delivery_kernel'
export const KERNEL_SECTION = 'delivery-assured:kernel'
export const KERNEL_ORDER = 450

const NOT_READY =
  '[delivery-assured] 监督摘要尚未就绪（正在用操作包重算）。先运行 delivery_resume 获得完整恢复摘要。' +
  '本地输出不是完成凭证。'

function list(ids, cap = 3) {
  if (!Array.isArray(ids) || ids.length === 0) return '-'
  const shown = ids.slice(0, cap).join(', ')
  return ids.length > cap ? `${shown} …(+${ids.length - cap})` : shown
}

/**
 * Pure renderer: one resume payload to one compact kernel block. Kept separate so a
 * test can feed a fixture and assert exactly what the model would see.
 */
export function renderKernel(data = {}) {
  if (!data || typeof data !== 'object' || !data.project) {
    return '[delivery-assured] 未找到可检查的交付项目：设置 projectRoot/DSH_DELIVERY_PROJECT 指向含 .agent/CONTRACT.yaml 的仓库。本地输出不是完成凭证。'
  }
  const owed = data.owed || {}
  const budget = data.budget || {}
  const blockers = Array.isArray(data.blockers) ? data.blockers : []
  const next = Array.isArray(data.next_actions) ? data.next_actions : []
  const dirty = Array.isArray(data.dirty) ? data.dirty.length : 0
  const evidence = data.evidence || {}
  const durable = data.durable_state || {}
  // Which history these numbers describe must be visible in the kernel itself: a
  // working-tree fallback presented as the platform's state is exactly the failure a
  // session cannot detect on its own.
  const authority = data.state_authoritative === true
    ? `权威状态: ${durable.sha ? String(durable.sha).slice(0, 12) : '(unknown)'} via ${durable.transport || '(unknown)'}，只读，未写入本项目`
    : data.state_authority === 'worktree-no-durable-state-ref'
      ? '权威状态: 平台没有 refs/heads/delivery-state/main（不是读取失败）；本项目默认由宿主执行验证，验证状态就在工作树'
      : durable.requested
        ? `权威状态: 读取失败或降级 — ${data.state_degraded_reason || durable.reason || '原因未报告'}；下列数字来自工作树，不是恢复结果`
        : '权威状态: 未读取（工作树来源）；下列数字只描述工作树'
  const verification = data.verification || {}
  const delivery = data.delivery || {}
  const backendLabel = verification.backend === 'trusted_ci'
    ? '受保护 CI（高保障后端）'
    : `宿主独立执行（默认后端${verification.declared ? '' : '，未声明'}）`
  const lines = [
    '[delivery-assured 监督摘要｜本地诊断，不是完成凭证]',
    `项目: ${data.project}${data.current_slice ? ` | 当前 Slice: ${data.current_slice}` : ''}`,
    `候选: ${data.candidate ? String(data.candidate).slice(0, 12) : '(无 git revision)'}${dirty ? ` (+${dirty} 未提交，属未验证 Candidate)` : ''}`,
    `验证后端: ${backendLabel} | accepted issuer ${(verification.accepted_issuers || []).join(', ') || '(none)'}`,
    `交付判定: ${data.delivered === true ? 'Delivered（冻结 Required 集合在本候选上实际执行通过）' : '未交付'}` +
      (delivery.verification?.evidence_id ? ` | ${delivery.verification.evidence_id}（${delivery.verification.executed_cases ?? '?'}/${delivery.verification.required_cases ?? '?'} cases）` : ''),
    `可信起点: Baseline ${data.local_baseline?.baseline_id || '无'}（${data.baseline_ref || 'n/a'}，可选高保障，不是完成前提）| 本地证据记录 ${evidence.total ?? 0} 条，匹配 ${evidence.issuer_match ?? 0} 条，本地无法确认来源`,
    authority,
    `还欠: 阻塞 ${blockers.length} 项 → 未映射 ${(owed.unmapped || []).length} / 待实现 ${(owed.pending_implementation || []).length} / 标准缺口 ${(owed.standard_gap || []).length} / 当前失败 ${(owed.current_failure || []).length} / 陈旧证据 ${(owed.stale_evidence || []).length} / 待人工 Review ${(owed.review_pending || []).length}`,
    `Critical 无当前通过: ${(budget.critical_open || []).length}`,
    `预算: attempts ${budget.counted ?? 0}/${budget.limits?.total_attempt_limit ?? '?'}，replans ${budget.replans ?? 0}/${budget.limits?.replan_limit ?? '?'}；账本 ${budget.history_known === false ? '缺失（不得假设还有额度）' : '已知'}`,
  ]
  if (blockers.length > 0) lines.push(`首要阻塞: ${list(blockers, 2)}`)
  if (next.length > 0) lines.push(`下一步: ${next[0]}`)
  lines.push(
    '铁律: 你不能自己宣布完成；完成必须由 DSH/宿主实际执行冻结验收（delivery_verify_independent）并 PASS，' +
      'Required case 不得跳过，失败就自己修再重跑。' +
      '.agent/CONTRACT.yaml、tests/acceptance/spec/**、ci/verifier.yaml、.agent/standards/**、ci/evidence/** 是受保护标准，guard 会拒绝写入；' +
      'GitHub 受信 CI、受保护引用与 Baseline 是高保障可选后端，不是普通项目的默认完成前提。',
  )
  return lines.join('\n')
}

/**
 * The kernel a brand-new project gets instead of "no deliverable project found".
 *
 * A greenfield project has no Contract, so there is no recovery summary to render — but
 * there is a lifecycle, a next artifact and a first action. Saying that is what makes the
 * session record the requirement early and bootstrap in the order the guard enforces,
 * instead of reverse-engineering the pack to discover the order.
 */
export function renderBootstrapKernel(bootstrap, project = '(unknown)') {
  if (!bootstrap || bootstrap.phase !== BOOTSTRAP_PHASE.BOOTSTRAPPING) return null
  const steps = (bootstrap.steps || []).map((step, index) => {
    const mark = step.status === 'done' ? '✓' : step.status === 'current' ? '→' : '·'
    return `${mark} ${index + 1}. ${step.targets[0]}`
  })
  const lines = [
    '[delivery-assured 监督摘要｜新项目 bootstrap，本地诊断，不是完成凭证]',
    `项目: ${project}`,
    `阶段: bootstrap ${bootstrap.step_index}/${bootstrap.step_count} — ${bootstrap.step}（下一步创建 ${bootstrap.next_artifact}）`,
    `顺序: ${steps.join('  ')}`,
    `下一动作: 先用 delivery_iteration action=open 记录用户需求原文（首个需求不需要已有 iteration），再按顺序创建 ${bootstrap.next_artifact}`,
  ]
  for (const action of bootstrapNextActions(bootstrap)) lines.push(`之后: ${action}`)
  lines.push(
    '铁律: 未完成前一步，后一步的受保护标准仍会被 guard 拒绝；Contract 冻结后 bootstrap 窗口永久关闭，' +
      '.agent/CONTRACT.yaml、tests/acceptance/spec/**、ci/verifier.yaml 与 Evidence/Baseline 全部只读、不写 Evidence、不晋升 Baseline。',
  )
  return lines.join('\n')
}

/**
 * A cheap fingerprint of the delivery state a session can see without running a script:
 * the lifecycle step and the iteration journal. When it moves, the rendered summary is
 * known to be out of date and is recomputed in the background.
 *
 * The durable ref itself cannot be fingerprinted without the network, so what the session
 * itself changes (the journal, a bootstrap artifact, a dispatched run) invalidates the
 * cache explicitly, and the TTL bounds anything nobody in this session caused.
 */
function stateSignature(ctxInfo) {
  if (!ctxInfo) return 'absent'
  const bootstrap = ctxInfo.bootstrap
  const root = ctxInfo.project?.root
  let journal = 'no-journal'
  try {
    const stats = statSync(join(root, '.agent', 'ITERATIONS.jsonl'))
    journal = `${stats.mtimeMs}:${stats.size}`
  } catch {
    /* no journal yet */
  }
  return [bootstrap?.phase ?? 'none', bootstrap?.step ?? '-', journal].join('|')
}

/**
 * @param options.resolveContext `(cwd) => ctxInfo` from the bridge (pack/node/project)
 * @param options.logger         optional host logger
 * @param options.ttlMs          how long a rendered kernel is reused before it is recomputed
 *                               even though nothing this session can see has changed
 * @param options.stateSource    `durable-ref` (default) reads the authoritative state ref;
 *                               `worktree` renders the working tree only (`--offline`), for
 *                               a machine that cannot reach the remote or a gate that must
 *                               not need the network. Reading the two sources is not the
 *                               same input, so the choice is explicit and never silent.
 * @param options.stateTransport `auto` (default; `gh` first), `gh` or `git`: the channel
 *                               the durable ref is read over. The kernel and
 *                               `delivery_resume` must use the same one, or their budgets
 *                               would describe different histories again.
 */
export function createKernel({ resolveContext, logger = null, ttlMs = 300000, stateSource = 'durable-ref', stateTransport = 'auto', stateRepo = null } = {}) {
  let cached = null
  let renderedAt = 0
  let renderedSignature = 'absent'
  let inflight = null
  let dirty = true
  let lastShell = null
  let lastCwd = null

  /** Recompute now, or hand back the in-flight computation. */
  async function refresh(shell, cwd) {
    if (typeof resolveContext !== 'function') return cached
    if (shell) lastShell = shell
    if (cwd) lastCwd = cwd
    if (inflight) return inflight
    const task = (async () => {
      try {
        const ctxInfo = resolveContext(lastCwd)
        const signature = stateSignature(ctxInfo)
        if (!ctxInfo || ctxInfo.problems.length > 0) {
          cached = renderKernel({})
        } else if (ctxInfo.bootstrap && ctxInfo.bootstrap.phase === BOOTSTRAP_PHASE.BOOTSTRAPPING) {
          // A new project: the useful summary is the lifecycle and the next artifact, not
          // "no deliverable project found" — which is what a missing Contract used to
          // render, and what made a session reverse-engineer the order from the sources.
          cached = renderBootstrapKernel(ctxInfo.bootstrap, ctxInfo.project.root)
        } else {
          // The same source the session's resume tool reads. The kernel used to render from
          // `--offline`, i.e. from the working tree, so it reported a different budget than
          // `delivery_resume` for the very same history (and called a delivered project
          // blocked). One source, one transport, one budget calculation, both from the
          // operation pack.
          const args =
            stateSource === 'worktree'
              ? ['--offline']
              : ['--durable-state', '--state-transport', stateTransport, ...(stateRepo ? ['--state-repo', stateRepo] : [])]
          const result = await runScript(ctxInfo, shell || lastShell, 'resume.mjs', args)
          cached = renderKernel(result.json || {})
        }
        renderedAt = Date.now()
        renderedSignature = signature
        dirty = false
        return cached
      } catch (error) {
        logger?.warn?.(`delivery-assured: kernel refresh failed: ${error?.message || error}`)
        return cached
      }
    })()
    // The assignment has to happen before anything can clear it: a body with no `await`
    // (the bootstrap render) completes synchronously, so clearing `inflight` from inside it
    // would leave a settled promise in the slot and every later refresh would short-circuit
    // to the summary rendered at boot — precisely the staleness this refresh exists to fix.
    inflight = task
    const release = () => {
      if (inflight === task) inflight = null
    }
    task.then(release, release)
    return task
  }

  /** Is the rendered text still describing the project as it is now? */
  function stale() {
    if (!cached) return true
    if (dirty) return true
    if (Date.now() - renderedAt > ttlMs) return true
    if (typeof resolveContext !== 'function' || !lastCwd) return false
    return stateSignature(resolveContext(lastCwd)) !== renderedSignature
  }

  /** Mark the rendered summary out of date (a write, a dispatch, a lifecycle change). */
  function invalidate() {
    dirty = true
  }

  /**
   * The prompt variable provider must stay synchronous, so it answers from the cache and
   * schedules the refresh instead of blocking the request. The cost of that choice is one
   * request of lag, never a stale answer that claims to be current.
   */
  function text() {
    if (stale() && lastShell && typeof resolveContext === 'function') {
      Promise.resolve()
        .then(() => refresh(lastShell, lastCwd))
        .catch(() => {})
    }
    return cached || NOT_READY
  }

  return { text, refresh, invalidate, stale, variable: KERNEL_VARIABLE, section: KERNEL_SECTION, order: KERNEL_ORDER }
}
