/**
 * A-CLI-STALE-EVIDENCE — a record whose bindings no longer match the current
 * standards can never be reported as verified.
 *
 * Frozen acceptance standard.
 */

export function declareCases({ driver }) {
  return [
    {
      id: 'A-CLI-STALE-EVIDENCE',
      obligationIds: ['BR-STATUS-DERIVED'],
      run: async () => {
        const failures = []
        const staleRecord = {
          evidence_id: 'spec-stale-001',
          scope: {
            slice_id: 'S1',
            obligation_ids: ['BR-SPEC-CRITICAL'],
            required_case_ids: ['A-SPEC-CRITICAL-NOT-LOCAL'],
          },
          bindings: {
            // Deliberately not the digest of the current Contract: the standard moved on.
            contract_revision: 'deadbeefdeadbeef',
            contract_digest: '0'.repeat(64),
            acceptance_revision: 'deadbeefdeadbeef',
            acceptance_manifest_digest: '0'.repeat(64),
            verifier_config_revision: 'deadbeefdeadbeef',
            spine_manifest_digest: '0'.repeat(64),
            parent_baseline: null,
          },
          environment: {
            kind: 'production_like_ci',
            image_digest: 'sha256:spec',
            config_fingerprint: 'spec-config',
            deployed_code_revision: 'deadbeefdeadbeef',
          },
          execution: {
            ci_run_id: 'spec-run-1',
            result: 'PASS',
            required_cases: 1,
            executed_cases: 1,
            skipped_required_cases: 0,
            case_results: [{ case_id: 'A-SPEC-CRITICAL-NOT-LOCAL', outcome: 'passed' }],
          },
          issuer: { identity: 'spec-trusted-verifier' },
        }
        const workspace = driver.makeWorkspace({ evidence: [staleRecord] })
        try {
          const result = await driver.status(workspace, ['--json'])
          if (result.json_error) failures.push(`--json stdout was not parseable JSON: ${result.json_error}`)
          if (!result.json) return { ok: false, failures }

          const verifiedIds = result.json.buckets?.verified || []
          if (verifiedIds.includes('BR-SPEC-CRITICAL')) {
            failures.push('an obligation was reported VERIFIED although its only record has mismatched bindings')
          }
          if (result.json.statuses.some((row) => row.status === 'VERIFIED')) {
            failures.push('no obligation may be VERIFIED while every record is stale')
          }

          const row = result.json.statuses.find((r) => r.id === 'BR-SPEC-CRITICAL')
          if (!row) failures.push('BR-SPEC-CRITICAL was not reported at all')
          else if (row.status !== 'STALE_EVIDENCE') {
            failures.push(`expected BR-SPEC-CRITICAL to be STALE_EVIDENCE, observed ${row.status}`)
          }

          // The rule must still be listed as lacking a current pass, and the reason
          // must name the binding that changed rather than a generic message.
          const critical = result.json.critical_without_current_pass || []
          if (!critical.some((c) => c.rule === 'BR-SPEC-CRITICAL')) {
            failures.push('a critical rule covered only by stale evidence was not reported as lacking a current pass')
          }
          if (critical.some((c) => c.rule === 'BR-SPEC-CRITICAL' && c.pending === true)) {
            failures.push('stale evidence was reported as if no record existed, hiding the real reason (binding drift)')
          }

          if (result.exit_code !== 1) {
            failures.push(`a stale critical record is blocking, expected exit code 1, observed ${result.exit_code}`)
          }

          // A local DONE marker in STATE must not turn this into a verified status.
          const withState = driver.makeWorkspace({
            evidence: [staleRecord],
            state: { current_slice: 'S1', blockers: [], next_action: 'ship it' },
          })
          try {
            const second = await driver.status(withState, ['--json'])
            if (second.json?.statuses.some((r) => r.status === 'VERIFIED')) {
              failures.push('a STATE marker produced a VERIFIED status')
            }
          } finally {
            driver.cleanup(withState)
          }

          return { ok: failures.length === 0, failures }
        } finally {
          driver.cleanup(workspace)
        }
      },
    },
  ]
}
