/**
 * A-CLI-INPUT-REJECTED — illegal input and a missing Contract are rejected on stderr.
 *
 * Frozen acceptance standard.
 */

export function declareCases({ driver }) {
  return [
    {
      id: 'A-CLI-INPUT-REJECTED',
      obligationIds: ['J-DELIVERY-STATUS', 'J-DELIVERY-STATUS.rejected', 'C-INPUT-DIAGNOSTICS'],
      run: async () => {
        const failures = []
        const cases = [
          {
            label: 'unknown option',
            args: ['status', '--not-an-option'],
            expectStderr: /unknown option/i,
          },
          {
            label: 'unknown command',
            args: ['summarize'],
            expectStderr: /unknown command/i,
          },
          {
            label: 'option without a value',
            args: ['status', '--project'],
            expectStderr: /--project requires/i,
          },
        ]
        for (const scenario of cases) {
          const result = driver.runDeliveryRaw(scenario.args)
          if (result.exit_code !== 2) {
            failures.push(`${scenario.label}: expected exit code 2, observed ${result.exit_code}`)
          }
          if (!scenario.expectStderr.test(result.stderr)) {
            failures.push(`${scenario.label}: stderr did not explain the problem, got ${JSON.stringify(result.stderr.slice(0, 200))}`)
          }
          if (result.stdout.trim() !== '' && scenario.args[0] === 'status') {
            failures.push(`${scenario.label}: a rejected run must not print a status report on stdout`)
          }
        }

        // A repository without a Contract is a configuration error, not an empty success.
        const bare = driver.makeWorkspace({ omitContract: true })
        try {
          const result = await driver.status(bare, ['--json'])
          if (result.exit_code !== 2) {
            failures.push(`missing Contract: expected exit code 2, observed ${result.exit_code}`)
          }
          if (!/CONTRACT/i.test(result.stderr)) {
            failures.push(`missing Contract: stderr did not name the missing file, got ${JSON.stringify(result.stderr.slice(0, 200))}`)
          }
          if (result.stdout.includes('report_kind')) {
            failures.push('missing Contract: a status report was printed even though the Contract is absent')
          }
        } finally {
          driver.cleanup(bare)
        }

        // Help is a legitimate empty request: it succeeds and explains usage.
        const help = driver.runDeliveryRaw(['--help'])
        if (help.exit_code !== 0) failures.push(`--help: expected exit code 0, observed ${help.exit_code}`)
        if (!/Usage/i.test(help.stdout)) failures.push('--help: stdout did not print usage')

        return { ok: failures.length === 0, failures }
      },
    },
    {
      id: 'A-BOOTSTRAP-CLEAN-BOOT',
      obligationIds: ['C-BOOTSTRAP', 'C-INPUT-DIAGNOSTICS'],
      run: async () => {
        // A declared clean target must be able to start the tool and report its
        // own version, and must fail loudly when required configuration is absent.
        const failures = []
        const clean = driver.makeWorkspace()
        try {
          const help = driver.runDeliveryRaw(['--help'], { cwd: clean.dir })
          if (help.exit_code !== 0) {
            failures.push(`in a clean target --help exited ${help.exit_code}`)
          }
          if (!/Usage/i.test(help.stdout)) failures.push('in a clean target --help printed no usage')

          const report = await driver.status(clean, ['--json'], { cwd: clean.dir })
          if (report.exit_code === 2) {
            failures.push(`a clean valid repository produced a tool error: ${report.stderr.slice(0, 200)}`)
          }
          if (!report.json) {
            failures.push(`a clean repository produced no parseable report: ${report.json_error || report.stderr.slice(0, 200)}`)
          }
        } finally {
          driver.cleanup(clean)
        }

        // The repository under test must itself be startable, with no leftover state.
        const own = driver.runDeliveryRaw(['status', '--project', driver.PROJECT_ROOT, '--json'], { cwd: driver.PROJECT_ROOT })
        if (own.exit_code === 2) {
          failures.push(`this repository produced a tool error: ${own.stderr.slice(0, 200)}`)
        }
        if (!own.stdout.trim().startsWith('{')) {
          failures.push('this repository produced no JSON report on stdout')
        }

        return { ok: failures.length === 0, failures }
      },
    },
  ]
}
