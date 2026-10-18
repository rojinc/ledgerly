import { describe, expect, it } from 'vitest'
import { randomId } from './random-id'

describe('randomId', () => {
  it('is 20 characters from a-z0-9, different every time', () => {
    const ids = Array.from({ length: 1000 }, randomId)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{20}$/)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('uses the whole alphabet', () => {
    const seen = new Set(Array.from({ length: 200 }, randomId).join(''))
    expect(seen.size).toBe(36)
  })
})
