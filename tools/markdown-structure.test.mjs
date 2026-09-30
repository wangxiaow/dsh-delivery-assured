#!/usr/bin/env node
/**
 * Structural sanity check for the Markdown surfaces people actually read.
 *
 * GitHub renders a malformed table or an unclosed fence as visible garbage, and a
 * broken relative link as a 404. This check catches those mechanically instead of
 * relying on someone opening every file.
 *
 * It checks only what it can decide: fence balance, table column consistency,
 * relative-link existence, heading jumps, and the anchor targets used by badges.
 *
 * Run: node tools/markdown-structure.test.mjs
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

let passed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) passed += 1
  else failures.push(`${label}${detail ? `: ${detail}` : ''}`)
}

const FILES = ['README.md', 'CONTRIBUTING.md', 'LICENSE', 'plugins/dsh-delivery-assured/README.md', 'integrations/deepseek-harness/README.md']

/** GitHub's heading-to-anchor rules, close enough for the anchors used here. */
function slugify(text) {
  return String(text)
    .replace(/\r/g, '') // a CRLF checkout must not change the anchor
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

for (const relPath of FILES) {
  const full = join(repoRoot, relPath)
  if (!existsSync(full)) {
    failures.push(`${relPath} does not exist`)
    continue
  }
  const text = readFileSync(full, 'utf8')
  const lines = text.split('\n')

  // 1. Balanced code fences.
  const fences = lines.filter((l) => /^\s*```/.test(l)).length
  check(`${relPath}: code fences are balanced`, fences % 2 === 0, `${fences} fence lines`)

  // 2. Table column consistency: every row in a block must match its header.
  let tableHeader = null
  let tableRow = 0
  for (const [index, line] of lines.entries()) {
    const isRow = /^\s*\|/.test(line) && /\|\s*$/.test(line)
    if (!isRow) {
      tableHeader = null
      continue
    }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').length
    if (tableHeader === null) {
      tableHeader = cells
      tableRow = 0
      continue
    }
    tableRow += 1
    // The separator row uses dashes; it has the same width as the header.
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue
    check(
      `${relPath}:${index + 1}: table row matches its header`,
      cells === tableHeader,
      `header ${tableHeader} cells, row ${cells} cells`,
    )
  }

  // 3. Relative links resolve on disk.
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1]
    if (/^https?:|^mailto:|^#/.test(target)) continue
    const [pathPart] = target.split('#')
    if (pathPart === '') continue
    const resolved = resolve(dirname(full), pathPart)
    check(`${relPath}: link target exists -> ${pathPart}`, existsSync(resolved), `missing ${resolved}`)
  }

  // 4. Anchors used by same-file links exist as headings.
  const headings = new Set()
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) headings.add(slugify(m[2]))
  }
  for (const match of text.matchAll(/\]\(#([^)]+)\)/g)) {
    check(`${relPath}: anchor #${match[1]} has a heading`, headings.has(match[1]), `known: ${[...headings].join(', ')}`)
  }

  // 5. No heading level jumps (h1 -> h3 without h2).
  let previous = 0
  inFence = false
  for (const [index, line] of lines.entries()) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s/.exec(line)
    if (!m) continue
    const level = m[1].length
    if (previous > 0 && level > previous + 1) {
      failures.push(`${relPath}:${index + 1}: heading jumps from h${previous} to h${level}`)
    }
    previous = level
  }
}

// Badge images must point at a real host, never a local path.
for (const relPath of FILES.filter((f) => f.endsWith('.md'))) {
  const text = readFileSync(join(repoRoot, relPath), 'utf8')
  for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    check(`${relPath}: badge target is remote -> ${match[1].slice(0, 60)}`, /^https?:\/\//.test(match[1]), match[1])
  }
}

check('LICENSE is the MIT text', /MIT License/.test(readFileSync(join(repoRoot, 'LICENSE'), 'utf8')))
check('LICENSE names the copyright holder', /Copyright \(c\) \d{4} wangxiaow/.test(readFileSync(join(repoRoot, 'LICENSE'), 'utf8')))
check('LICENSE is a plain file, not a directory', statSync(join(repoRoot, 'LICENSE')).isFile())

if (failures.length > 0) {
  process.stderr.write(`markdown-structure.test: ${failures.length} failure(s), ${passed} passed\n`)
  for (const failure of failures) process.stderr.write(`  FAIL ${failure}\n`)
  process.exit(1)
}
process.stdout.write(`markdown-structure.test ok: ${passed} checks passed\n`)
process.exit(0)
