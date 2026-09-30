/**
 * A-CLI-DOES-NOT-WRITE — reporting is read-only, and a local run never claims
 * completion.
 *
 * Frozen acceptance standard.
 */

export function declareCases({ driver }) {
  return [
    {
      id: 'A-CLI-DOES-NOT-WRITE',
      obligationIds: ['J-DELIVERY-STATUS', 'C-INPUT-DIAGNOSTICS'],
      run: async () => {
        const failures = []
        const workspace = driver.makeWorkspace()
        try {
          const before = driver.snapshotTree(workspace.dir)
          const jsonRun = await driver.status(workspace, ['--json'])
          const humanRun = await driver.status(workspace)
          const after = driver.snapshotTree(workspace.dir)

          if (JSON.stringify(before) !== JSON.stringify(after)) {
            const beforePaths = new Set(before.map((f) => f.path))
            const afterPaths = new Set(after.map((f) => f.path))
            const added = [...afterPaths].filter((p) => !beforePaths.has(p))
            const removed = [...beforePaths].filter((p) => !afterPaths.has(p))
            const modified = after
              .filter((f) => {
                const previous = before.find((b) => b.path === f.path)
                return previous && (previous.size !== f.size || previous.mtime_ms !== f.mtime_ms)
              })
              .map((f) => f.path)
            failures.push(
              `reporting changed the repository: added=[${added.join(',')}] removed=[${removed.join(',')}] modified=[${modified.join(',')}]`,
            )
          }

          for (const run of [jsonRun, humanRun]) {
            if (run.exit_code === 2) failures.push(`a readable repository produced a tool error: ${run.stderr.slice(0, 200)}`)
            const stdout = run.stdout
            if (!/local_diagnostic|local diagnostic/i.test(stdout)) {
              failures.push('the output did not mark the result as a local diagnostic')
            }
            if (/refs\/heads\/baseline\/\S+\s*(updated|advanced|promoted|created)/i.test(stdout)) {
              failures.push('the output claimed a baseline reference was advanced')
            }
            if (/(^|\s)(MVP_READY|BASELINE_PROMOTED|VERIFIED_DONE)(\s|$)/.test(stdout) && !/never|not|no /i.test(stdout)) {
              failures.push('the output claimed a completion state that only CI may derive')
            }
            if (/issuer"\s*:\s*"local/i.test(stdout)) {
              failures.push('a local run presented itself as an evidence issuer')
            }
          }

          const refs = driver.gitRefs(workspace.dir)
          if (refs.some((ref) => ref.startsWith('refs/heads/baseline/'))) {
            failures.push('a baseline reference exists after a local read-only run')
          }

          // stdout is the report, stderr is for problems: they must not be mixed.
          if (jsonRun.stdout.trim() !== '' && !jsonRun.stdout.trim().startsWith('{')) {
            failures.push('--json printed something other than the JSON document on stdout')
          }

          return { ok: failures.length === 0, failures }
        } finally {
          driver.cleanup(workspace)
        }
      },
    },
    {
      id: 'A-CLI-STATE-DONE-NOT-COMPLETION',
      obligationIds: ['BR-STATUS-DERIVED', 'J-DELIVERY-STATUS'],
      run: async () => {
        // A STATE summary that claims completion must not become a completion fact.
        const failures = []
        const workspace = driver.makeWorkspace({
          state: {
            current_slice: 'S1',
            blockers: [],
            next_action: 'nothing left',
            how_decisions: ['shipped'],
          },
        })
        try {
          const withState = await driver.status(workspace, ['--json'])
          if (!withState.json) {
            failures.push(`--json produced no parseable report: ${withState.json_error || withState.stderr.slice(0, 200)}`)
            return { ok: false, failures }
          }
          const stateDoneIgnored = withState.json.statuses.every((row) => row.status !== 'VERIFIED')
          if (!stateDoneIgnored) {
            failures.push('a STATE summary produced a VERIFIED status (state_done_treated_as_completion)')
          }
          if (withState.json.statuses.length === 0) {
            failures.push('no obligation was reported at all')
          }
          // The same repository without the STATE file must report the same statuses.
          const reference = driver.makeWorkspace()
          try {
            const withoutState = await driver.status(reference, ['--json'])
            const before = JSON.stringify(withoutState.json?.statuses)
            const after = JSON.stringify(withState.json.statuses)
            if (!before || !after) failures.push('one of the two runs produced no statuses')
            else if (!statusesEquivalent(withoutState.json.statuses, withState.json.statuses)) {
              const onlyWithState = withState.json.statuses.filter(
                (row) => !withoutState.json.statuses.some((r) => r.id === row.id),
              )
              const differing = withState.json.statuses.filter((row) => {
                const other = withoutState.json.statuses.find((r) => r.id === row.id)
                return other && other.status !== row.status
              })
              if (onlyWithState.length > 0 || differing.length > 0) {
                failures.push(
                  `adding STATE.yaml changed the reported statuses (extra=[${onlyWithState.map((r) => r.id).join(',')}] changed=[${differing.map((r) => `${r.id}:${r.status}`).join(',')}])`,
                )
              }
            }
          } finally {
            driver.cleanup(reference)
          }
          return { ok: failures.length === 0, failures }
        } finally {
          driver.cleanup(workspace)
        }
      },
    },
  ]
}

function statusesEquivalent(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  return a.every((row) => {
    const other = b.find((r) => r.id === row.id)
    return other && other.status === row.status
  })
}
