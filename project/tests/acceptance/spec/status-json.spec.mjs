/**
 * A-CLI-STATUS-JSON — every required obligation is reported with its status and basis.
 *
 * Frozen acceptance standard. Behaviour only: this file never imports, reads or
 * reasons about the implementation.
 */

export function declareCases({ driver }) {
  return [
    {
      id: 'A-CLI-STATUS-JSON',
      obligationIds: ['J-DELIVERY-STATUS', 'C-STATUS-COMPUTATION'],
      run: async () => {
        const failures = []
        const workspace = driver.makeWorkspace()
        try {
          const result = await driver.status(workspace, ['--json'])

          if (result.spawn_error) failures.push(`the CLI could not be started: ${result.spawn_error}`)
          if (![0, 1].includes(result.exit_code)) {
            failures.push(`expected exit code 0 or 1 for a readable repository, observed ${result.exit_code}`)
          }
          if (result.json_error) failures.push(`--json stdout was not parseable JSON: ${result.json_error}`)
          if (!result.json) return { ok: false, failures }

          const reported = result.json.statuses || []
          const ids = reported.map((row) => row.id)
          for (const expected of ['J-SPEC', 'J-SPEC.done', 'J-SPEC.rejected', 'C-SPEC', 'BR-SPEC-CRITICAL']) {
            if (!ids.includes(expected)) failures.push(`required obligation ${expected} is missing from the report`)
          }
          for (const row of reported) {
            if (!row.status) failures.push(`obligation ${row.id} was reported without a status`)
            if (!row.reason) failures.push(`obligation ${row.id} was reported without a basis (reason)`)
          }
          if (result.json.report_kind !== 'local_diagnostic') {
            failures.push(`a local run must be labelled local_diagnostic, observed ${JSON.stringify(result.json.report_kind)}`)
          }
          if (result.json.required_obligations !== reported.length) {
            failures.push('required_obligations does not match the number of reported rows')
          }

          // The human output must carry the same facts as --json, not a different story.
          const human = await driver.status(workspace)
          const table = driver.parseStatusTable(human.stdout)
          if (table.length !== reported.length) {
            failures.push(`the human table lists ${table.length} rows but --json reported ${reported.length}`)
          }
          for (const row of table) {
            const jsonRow = reported.find((r) => r.id === row.id)
            if (!jsonRow) failures.push(`human table shows ${row.id} which --json did not report`)
            else if (jsonRow.status !== row.status) {
              failures.push(`${row.id} status differs between views: table ${row.status}, json ${jsonRow.status}`)
            }
          }

          // A read-only report is repeatable: the same repository yields the same facts.
          const again = await driver.status(workspace, ['--json'])
          if (JSON.stringify(again.json?.statuses) !== JSON.stringify(result.json.statuses)) {
            failures.push('two consecutive runs reported different statuses for the same repository')
          }

          return { ok: failures.length === 0, failures }
        } finally {
          driver.cleanup(workspace)
        }
      },
    },
  ]
}
