import test from 'node:test'
import assert from 'node:assert/strict'
import { assessAutomatedReviews, automatedReviewDefinitions, checkCompletionPolicy, resolveCompletionPolicy } from '../scripts/lib/completion.mjs'

const revision = 'a'.repeat(40)
const acceptanceCase = (id, obligation = 'C-TEST') => ({ id, required: true, method: 'automated', obligation_ids: [obligation] })
function model(overrides = {}) {
  return {
    contract: {
      completion_policy: { mode: 'independent_auto', authorization_ref: 'user:automatic-delivery' },
      acceptance: { manual_reviews: [], automated_reviews: [{ id: 'R-CORE-JOURNEYS', obligation_ids: ['C-TEST'], case_ids: ['A-TEST'] }] },
      ...overrides.contract,
    },
    obligations: new Map([['C-TEST', { id: 'C-TEST', required: true }]]),
    acceptance: { cases: [acceptanceCase('A-TEST')] },
    ...overrides,
  }
}
function record(overrides = {}) {
  return {
    evidence_id: 'ci:verify:1-1',
    scope: { slice_id: 'S1', required_case_ids: ['A-TEST'] },
    execution: { result: 'PASS', case_results: [{ case_id: 'A-TEST', outcome: 'passed' }] },
    ...overrides,
  }
}

test('an undeclared policy resolves to human review, never to automatic delivery', () => {
  const resolved = resolveCompletionPolicy({})
  assert.equal(resolved.mode, 'human_review')
  assert.equal(resolved.declared, false)
  const issues = []
  checkCompletionPolicy({ ...model(), contract: { ...model().contract, completion_policy: undefined } }, issues, { phase: 'contract' })
  assert.ok(issues.some((issue) => issue.code === 'COMPLETION_POLICY_MISSING' && issue.level === 'fail'))
  const unknown = []
  checkCompletionPolicy({ ...model(), contract: { ...model().contract, completion_policy: { mode: 'auto_trust_me' } } }, unknown, { phase: 'contract' })
  assert.ok(unknown.some((issue) => issue.code === 'COMPLETION_POLICY_UNKNOWN'))
})

test('independent_auto needs an authorization, an automated mapping and no leftover manual review', () => {
  const issues = []
  checkCompletionPolicy(model(), issues, { phase: 'contract' })
  assert.deepEqual(issues, [])
  const incomplete = []
  checkCompletionPolicy({ ...model(), contract: { ...model().contract, completion_policy: { mode: 'independent_auto' }, acceptance: { manual_reviews: [], automated_reviews: [] } } }, incomplete, { phase: 'contract' })
  const codes = incomplete.map((issue) => issue.code)
  assert.ok(codes.includes('COMPLETION_POLICY_NO_AUTHORIZATION'))
  assert.ok(codes.includes('AUTO_REVIEWS_MISSING'))
  const conflict = []
  checkCompletionPolicy({ ...model(), contract: { ...model().contract, acceptance: { manual_reviews: [{ id: 'R-OLD', reviewer: 'product_owner', obligation_ids: ['C-TEST'] }], automated_reviews: model().contract.acceptance.automated_reviews } } }, conflict, { phase: 'contract' })
  assert.ok(conflict.some((issue) => issue.code === 'COMPLETION_POLICY_CONFLICT'))
})

test('human_review still needs a real reviewer role, and its definitions stay ordinary reviews', () => {
  const human = { ...model(), contract: { ...model().contract, completion_policy: { mode: 'human_review' }, acceptance: { manual_reviews: [{ id: 'R-CORE-JOURNEYS', reviewer: 'product_owner', obligation_ids: ['C-TEST'] }], automated_reviews: [] } } }
  const issues = []
  checkCompletionPolicy(human, issues, { phase: 'contract' })
  assert.deepEqual(issues, [])
  assert.deepEqual(automatedReviewDefinitions(human.contract), [])
  const missing = []
  checkCompletionPolicy({ ...human, contract: { ...human.contract, acceptance: { manual_reviews: [], automated_reviews: [] } } }, missing, { phase: 'contract' })
  assert.ok(missing.some((issue) => issue.code === 'HUMAN_REVIEWS_MISSING'))
})

test('automated reviews are proven by execution, not by a declared result', () => {
  const ok = assessAutomatedReviews(model(), record())
  assert.deepEqual(ok.blocking, [])
  assert.equal(ok.reviews[0].result, 'PASS')
  assert.equal(ok.reviews[0].execution_ref, null)

  const cases = {
    'not executed': record({ execution: { result: 'FAIL', case_results: [{ case_id: 'A-TEST', outcome: 'failed' }] } }),
    'skipped': record({ execution: { result: 'FAIL', case_results: [{ case_id: 'A-TEST', outcome: 'skipped' }] } }),
    'duplicated': record({ execution: { result: 'PASS', case_results: [{ case_id: 'A-TEST', outcome: 'passed' }, { case_id: 'A-TEST', outcome: 'passed' }] } }),
    'not in the frozen set': record({ scope: { slice_id: 'S1', required_case_ids: [] } }),
  }
  for (const [label, variant] of Object.entries(cases)) {
    const assessed = assessAutomatedReviews(model(), variant)
    assert.ok(assessed.blocking.length > 0, label)
    assert.equal(assessed.reviews[0].result, 'UNVERIFIED', label)
  }
  const unmapped = assessAutomatedReviews({ ...model(), contract: { ...model().contract, acceptance: { manual_reviews: [], automated_reviews: [{ id: 'R-X', obligation_ids: ['C-OTHER'], case_ids: ['A-TEST'] }] } } }, record())
  assert.ok(unmapped.blocking.some((message) => /C-OTHER is not a Contract obligation/.test(message)))
})
