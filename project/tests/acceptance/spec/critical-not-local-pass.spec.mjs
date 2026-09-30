/**
 * A-CLI-CRITICAL-NOT-LOCAL-PASS — a local green run can never make a Critical rule
 * pass. Only evidence from the trusted CI verifier can.
 *
 * Frozen acceptance standard. Critical rule BR-EVIDENCE-NOT-LOCAL semantics:
 * subjects local_cli_run / trusted_ci_verifier; resources evidence_record /
 * baseline_ref / obligation_status; boundaries local_diagnostic / trusted_ci_result.
 */

export function declareCases({ driver }) {
  return [
    {
      id: 'A-CLI-CRITICAL-NOT-LOCAL-PASS',
      obligationIds: ['BR-EVIDENCE-NOT-LOCAL', 'J-CI-AUTHORITY', 'J-CI-AUTHORITY.local_only'],
      run: async () => {
        const failures = []

        // Case 1: no evidence at all, the tool runs locally and must not invent a pass.
        const bare = driver.makeWorkspace()
        try {
          const result = await driver.status(bare, ['--json'])
          if (!result.json) {
            failures.push(`--json produced no parseable report: ${result.json_error || result.stderr.slice(0, 200)}`)
          } else {
            const row = result.json.statuses.find((r) => r.id === 'BR-SPEC-CRITICAL')
            if (!row) failures.push('BR-SPEC-CRITICAL was not reported')
            else if (row.status === 'VERIFIED') {
              failures.push('a critical rule was VERIFIED without any CI record (status_marked_verified_from_local_pass)')
            }
            const critical = result.json.critical_without_current_pass || []
            if (!critical.some((c) => c.rule === 'BR-SPEC-CRITICAL')) {
              failures.push('a critical rule with no CI record was not reported as lacking a current pass')
            }
            if (result.json.report_kind !== 'local_diagnostic') {
              failures.push('the local run was not labelled local_diagnostic (local_diagnostic_labeled)')
            }
            if ((result.json.baseline || null) !== null) {
              failures.push('a baseline was reported although none can exist for this repository (baseline_advanced_locally)')
            }
            const refs = driver.gitRefs(bare.dir)
            if (refs.some((ref) => ref.startsWith('refs/heads/baseline/'))) {
              failures.push('a baseline reference was created locally')
            }
          }
        } finally {
          driver.cleanup(bare)
        }

        // Case 2: a record exists whose issuer is not the configured trusted verifier.
        const untrusted = {
          evidence_id: 'spec-untrusted-001',
          scope: { slice_id: 'S1', obligation_ids: ['BR-SPEC-CRITICAL'], required_case_ids: ['A-SPEC-CRITICAL-NOT-LOCAL'] },
          bindings: {
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
            ci_run_id: 'spec-run-untrusted',
            result: 'PASS',
            required_cases: 1,
            executed_cases: 1,
            skipped_required_cases: 0,
            case_results: [{ case_id: 'A-SPEC-CRITICAL-NOT-LOCAL', outcome: 'passed' }],
          },
          issuer: { identity: 'some-local-adapter' },
        }
        const withUntrusted = driver.makeWorkspace({ evidence: [untrusted] })
        try {
          const result = await driver.status(withUntrusted, ['--json'])
          if (!result.json) {
            failures.push('untrusted evidence case: no parseable report')
          } else {
            if (result.json.statuses.some((row) => row.status === 'VERIFIED')) {
              failures.push('evidence from a non-trusted issuer was treated as proof (untrusted_evidence_not_fresh)')
            }
            const row = result.json.statuses.find((r) => r.id === 'BR-SPEC-CRITICAL')
            if (row && row.status === 'VERIFIED') {
              failures.push('a critical rule passed on evidence from an untrusted issuer')
            }
          }
        } finally {
          driver.cleanup(withUntrusted)
        }

        // Case 3: an already-recorded local pass must not be silently reused as proof.
        const withStateOnly = driver.makeWorkspace({
          state: { current_slice: 'S1', last_ci_run: 'local-only', blockers: [] },
        })
        try {
          const result = await driver.status(withStateOnly, ['--json'])
          if (result.json?.statuses.some((row) => row.status === 'VERIFIED')) {
            failures.push('a STATE summary produced a VERIFIED status (state_done_treated_as_completion)')
          }
        } finally {
          driver.cleanup(withStateOnly)
        }

        return { ok: failures.length === 0, failures }
      },
    },
    {
      id: 'A-CLI-BLOCKED-WITHOUT-CI',
      obligationIds: ['J-CI-AUTHORITY', 'J-CI-AUTHORITY.blocked_without_ci', 'BR-EVIDENCE-NOT-LOCAL'],
      run: async () => {
        // Without a reachable remote or any trusted record, the tool must report a
        // blocking condition instead of quietly presenting local green as done.
        const failures = []
        const workspace = driver.makeWorkspace({
          contract: {
            deployment: {
              release_prerequisites: [],
            },
          },
        })
        try {
          const result = await driver.status(workspace, ['--json'])
          if (result.exit_code === 0) {
            failures.push('a repository with no CI record and no release prerequisites exited 0 (no blocking condition reported)')
          }
          if (result.exit_code === 2) {
            failures.push(`a readable repository produced a tool error instead of a blocked result: ${result.stderr.slice(0, 200)}`)
          }
          if (!result.json) {
            failures.push(`--json produced no parseable report: ${result.json_error || result.stderr.slice(0, 200)}`)
          } else {
            const verified = result.json.buckets?.verified || []
            if (verified.length > 0) {
              failures.push('obligations were reported verified although no trusted record exists (blocked_without_ci)')
            }
            if (!Array.isArray(result.json.blocking) || result.json.blocking.length === 0) {
              failures.push('no blocking obligation was reported although nothing is backed by CI evidence')
            }
            if (result.json.baseline !== null) {
              failures.push('a baseline was reported although none can exist without promotion')
            }
          }
        } finally {
          driver.cleanup(workspace)
        }
        return { ok: failures.length === 0, failures }
      },
    },
  ]
}
