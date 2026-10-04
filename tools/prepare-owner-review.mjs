#!/usr/bin/env node
// Local preparation only: never writes an authoritative Review or grants PASS.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decodeEvidence, draftOwnerApproval } from '../ci/tools/ci-mvp.mjs'
import { loadModel, classifyEvidence } from '../packages/delivery-assured/scripts/lib/model.mjs'
import { validateEvidenceRecord } from '../packages/delivery-assured/scripts/lib/evidence.mjs'

function main() {
  const args = process.argv.slice(2), opts = {}
  for (let i = 0; i < args.length; i++) {
    const name = args[i]
    if (name === '--help') { console.log('prepare-owner-review --project <restored candidate project> --evidence <raw downloaded evidence.json> [--out <new draft.md>]'); return }
    if (!['--project', '--evidence', '--out'].includes(name) || Object.hasOwn(opts, name) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`unknown, duplicate or missing option: ${name}`)
    opts[name] = args[++i]
  }
  if (!opts['--project'] || !opts['--evidence']) throw new Error('--project and --evidence are required')
  const model = loadModel(resolve(opts['--project']))
  const original = readFileSync(resolve(opts['--evidence'])), record = decodeEvidence(original).record
  const issues = validateEvidenceRecord(record)
  const current = { ...model, evidence: [record] }
  const proof = classifyEvidence(record, { model: current, codeRevision: record.bindings?.code_revision, parentBaseline: record.bindings?.parent_baseline, trustedIssuer: model.cfg.ci?.trusted_issuer })
  if (issues.length || !proof.fresh) throw new Error(`evidence is incomplete or differs from current standards: ${[...issues, ...proof.reasons].join('; ')}`)
  const draft = draftOwnerApproval(model, record, original)
  const markdown = [
    '# Owner Journey Review and release confirmation — PENDING',
    '',
    'This is an unsigned local draft, NOT CI evidence or a completed review.',
    `Candidate: ${record.bindings.code_revision}`,
    `Verification run: ${record.execution.ci_run_id}`,
    `Original evidence hash: ${draft.evidence_digest}`,
    `Artifact/image: ${record.environment.image_digest}`,
    `Observed installation: ${record.environment.deployment_id} (${record.environment.kind})`,
    '',
    'Review the exact retained artifact and source-run observations. The CI installation was temporary and has been cleaned up; do not claim it is a currently live staging instance. Any later local execution is a separate diagnostic installation, not that old deployment.',
    'Walk the declared core CLI Journeys, including JSON/table consistency, read-only repeatability, invalid-input stderr and exit codes. Confirm each release prerequisite independently. Environment-policy approval is NOT approval of these results.',
    '',
    ...(model.contract.deployment?.environment_limitations || []).map(s => `- Limitation: ${s}`),
    '',
    'Only the product owner may replace PENDING with PASS after the actual review. Do not change any bindings. Post the completed block as one same-repository GitHub issue comment authored by the product owner. The trusted promotion CI fetches the comment independently and uses its URL as the confirmation reference.',
    'Do not promote an intermediate Baseline after this source run: the eventual MVP_READY promotion still uses the original source parent. If candidate, standards, image or deployment change, discard this draft and review the new run.',
    '',
    '```delivery-approval', JSON.stringify(draft, null, 2), '```', '',
  ].join('\n')
  if (opts['--out']) { writeFileSync(resolve(opts['--out']), markdown, { encoding: 'utf8', flag: 'wx' }); console.log('PENDING owner draft written; no authoritative state or PASS was created.') }
  else process.stdout.write(markdown)
}
try { main() } catch (error) { console.error(`prepare-owner-review: ${error.message}`); process.exitCode = 2 }
