#!/usr/bin/env node
/**
 * Regression test for the YAML subset reader.
 *
 * The parser sits on the critical path of every script: a silent mis-parse would
 * corrupt every fact the operation pack reports. These cases are kept as
 * regression protection, not as a general YAML conformance suite.
 *
 * Run: node packages/delivery-assured/tests/yaml.test.mjs
 */

import { parseYaml } from '../scripts/lib/yaml.mjs'

let passed = 0
const failures = []

function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) passed += 1
  else failures.push(`${name}\n     expected ${e}\n     observed ${a}`)
}

function checkThrows(name, text) {
  try {
    parseYaml(text)
    failures.push(`${name}: expected a YamlError, but parsing succeeded`)
  } catch {
    passed += 1
  }
}

// --- the regression that motivated this file -------------------------------
// A sequence entry whose value is a nested mapping must keep reading the
// continuation keys at the value's indentation.
check(
  'sequence of mappings with continuation keys',
  parseYaml('a:\n  - id: X\n    title: hello\n    required: true\n'),
  { a: [{ id: 'X', title: 'hello', required: true }] },
)
check(
  'sequence of mappings with a nested sequence and a following sibling key',
  parseYaml('a:\n  - id: X\n    outcomes:\n      - id: X.y\n        required: true\n    next: 1\n  - id: Y\nb: 3\n'),
  { a: [{ id: 'X', outcomes: [{ id: 'X.y', required: true }], next: 1 }, { id: 'Y' }], b: 3 },
)

// --- scalars and plain values ---------------------------------------------
check('plain scalar value is not over-consumed', parseYaml('a: X\nb: 1\n'), { a: 'X', b: 1 })
check('quoted scalar keeps a hash that is not a comment', parseYaml('b: "q # not comment"\n'), { b: 'q # not comment' })
check('single-quoted scalar doubles an apostrophe', parseYaml("a: 'it''s'\n"), { a: "it's" })
check('booleans and null', parseYaml('t: yes\nf: off\nn: null\nu: ~\n'), { t: true, f: false, n: null, u: null })
check('numbers stay numbers', parseYaml('i: 42\nn: -7\nf: 3.5\ne: 1e3\n'), { i: 42, n: -7, f: 3.5, e: 1000 })
check('a version-like string stays a string', parseYaml('v: "0.5"\n'), { v: '0.5' })

// --- structures ------------------------------------------------------------
check('bare sequence', parseYaml('a:\n  - 1\n  - 2\nb: 3\n'), { a: [1, 2], b: 3 })
check('nested mappings', parseYaml('a:\n  b:\n    c: 1\n  d: 2\ne: 3\n'), { a: { b: { c: 1 }, d: 2 }, e: 3 })
check('flow sequence', parseYaml('a: [x, y]\n'), { a: ['x', 'y'] })
check('flow mapping', parseYaml('a: {x: 1, y: two}\n'), { a: { x: 1, y: 'two' } })
check('inline comment after a flow value', parseYaml('a: [x, y]  # note\n'), { a: ['x', 'y'] })
check('multi-line flow sequence', parseYaml('a: [\n  x,\n  y\n]\nb: 1\n'), { a: ['x', 'y'], b: 1 })
check('empty flow sequence and mapping', parseYaml('a: []\nb: {}\n'), { a: [], b: {} })
check('dash-only entry takes the nested block', parseYaml('a:\n  -\n    b: 1\n'), { a: [{ b: 1 }] })
check('literal block scalar', parseYaml('a: |\n  line1\n  line2\nb: 2\n'), { a: 'line1\nline2\n', b: 2 })
check('literal block scalar with strip chomping', parseYaml('a: |-\n  line1\n'), { a: 'line1' })
check('folded block scalar', parseYaml('a: >\n  one\n  two\n'), { a: 'one two\n' })

// --- comments, documents, keys --------------------------------------------
check('full-line comments and blank lines are ignored', parseYaml('# c\n\na: 1\n\n# d\nb: 2\n'), { a: 1, b: 2 })
check('document start marker is ignored', parseYaml('---\na: 1\n'), { a: 1 })
check('quoted key', parseYaml('"a b": 1\n'), { 'a b': 1 })
check('colon without following space stays in the value', parseYaml('a: x:y\n'), { a: 'x:y' })
check('empty document is null', parseYaml(''), null)
check('trailing colon with no value is null', parseYaml('a:\n'), { a: null })

// --- malformed input must fail loudly -------------------------------------
checkThrows('tab-free indentation error is reported', 'a:\n    b: 1\n  c: 2\n')
checkThrows('unterminated double quote', 'a: "oops\n')
checkThrows('entry without a colon', 'a:\n  - id: X\n    broken\n')

if (failures.length > 0) {
  process.stderr.write(`yaml.test: ${failures.length} failure(s), ${passed} passed\n`)
  for (const failure of failures) process.stderr.write(`  FAIL ${failure}\n`)
  process.exit(1)
}
process.stdout.write(`yaml.test ok: ${passed} cases passed\n`)
process.exit(0)
