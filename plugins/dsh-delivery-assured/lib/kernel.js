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

import { runScript } from './bridge.js'

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
  const lines = [
    '[delivery-assured 监督摘要｜本地诊断，不是完成凭证]',
    `项目: ${data.project}${data.current_slice ? ` | 当前 Slice: ${data.current_slice}` : ''}`,
    `候选: ${data.candidate ? String(data.candidate).slice(0, 12) : '(无 git revision)'}${dirty ? ` (+${dirty} 未提交，属未验证 Candidate)` : ''}`,
    `可信起点: Baseline ${data.local_baseline?.baseline_id || '无'}（${data.baseline_ref || 'n/a'}）| 本地证据记录 ${evidence.total ?? 0} 条，其中 ${evidence.issuer_match ?? 0} 条名字匹配配置的 issuer；本地无法确认来源，独立确认 ${evidence.independently_attested ?? 0} 条`,
    `还欠: 阻塞 ${blockers.length} 项 → 未映射 ${(owed.unmapped || []).length} / 待实现 ${(owed.pending_implementation || []).length} / 标准缺口 ${(owed.standard_gap || []).length} / 当前失败 ${(owed.current_failure || []).length} / 陈旧证据 ${(owed.stale_evidence || []).length} / 待人工 Review ${(owed.review_pending || []).length}`,
    `Critical 无当前通过: ${(budget.critical_open || []).length}`,
    `预算: attempts ${budget.counted ?? 0}/${budget.limits?.total_attempt_limit ?? '?'}，replans ${budget.replans ?? 0}/${budget.limits?.replan_limit ?? '?'}；账本 ${budget.history_known === false ? '缺失（不得假设还有额度）' : '已知'}`,
  ]
  if (blockers.length > 0) lines.push(`首要阻塞: ${list(blockers, 2)}`)
  if (next.length > 0) lines.push(`下一步: ${next[0]}`)
  lines.push(
    '铁律: 工具只读、不写 Evidence、不晋升 Baseline；.agent/CONTRACT.yaml、tests/acceptance/spec/**、ci/verifier.yaml、ci/evidence/** 是受保护标准，插件 guard 会拒绝写入；' +
      '会话结束、workflow 成功或模型回答 DONE 都不是完成——只有 CI 产出的 Evidence 与受保护 Baseline 才算。',
  )
  return lines.join('\n')
}

/**
 * @param options.resolveContext `(cwd) => ctxInfo` from the bridge (pack/node/project)
 * @param options.logger         optional host logger
 * @param options.ttlMs          how long a rendered kernel is reused
 */
export function createKernel({ resolveContext, logger = null, ttlMs = 60000 } = {}) {
  let cached = null
  let renderedAt = 0
  let inflight = null

  async function refresh(shell, cwd) {
    if (typeof resolveContext !== 'function') return cached
    if (inflight) return inflight
    if (cached && Date.now() - renderedAt < ttlMs) return cached
    inflight = (async () => {
      try {
        const ctxInfo = resolveContext(cwd)
        if (!ctxInfo || ctxInfo.problems.length > 0) {
          cached = renderKernel({})
          renderedAt = Date.now()
          return cached
        }
        const result = await runScript(ctxInfo, shell, 'resume.mjs', ['--offline'])
        cached = renderKernel(result.json || {})
        renderedAt = Date.now()
        return cached
      } catch (error) {
        logger?.warn?.(`delivery-assured: kernel refresh failed: ${error?.message || error}`)
        return cached
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  function text() {
    return cached || NOT_READY
  }

  return { text, refresh, variable: KERNEL_VARIABLE, section: KERNEL_SECTION, order: KERNEL_ORDER }
}
