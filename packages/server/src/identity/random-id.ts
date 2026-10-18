import { randomInt } from 'node:crypto'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const LENGTH = 20

/**
 * 20 random `a-z0-9` characters from a secure generator, for person and personal group IDs
 * (data-model.md#persons, D-016). Unlike `ID.unique()` it holds no timestamp, so the ID doesn't
 * show when the row was made. `randomInt` is unbiased, so every character is equally likely.
 */
export function randomId(): string {
  let id = ''
  for (let index = 0; index < LENGTH; index++) id += ALPHABET.charAt(randomInt(ALPHABET.length))
  return id
}
