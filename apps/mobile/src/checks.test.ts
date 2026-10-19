/// <reference types="node" />
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { runChecks } from './checks'

const FILE = new URL('./checks.expected.json', import.meta.url)

// UPDATE_CHECKS=1 writes the file the phone compares against; otherwise Node must still match it.
it('core gives the stored expected values under Node', () => {
  const results = runChecks()
  if (process.env.UPDATE_CHECKS === '1') {
    writeFileSync(FILE, `${JSON.stringify(results, null, 2)}\n`)
  }
  expect(results).toEqual(JSON.parse(readFileSync(FILE, 'utf8')))
  for (const result of Object.values(results)) expect(result).toHaveProperty('value')
})
