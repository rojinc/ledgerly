import { describe, expect, it } from 'vitest'
import { linkHint } from './link-hint'

const PLACE = { linked: 'this house', seen: 'the house' }

describe('linkHint', () => {
  it.each([
    [
      'nothing',
      '',
      ' ',
      'Without an email or mobile number, they can’t be linked to this house if they sign up later.',
    ],
    ['an email', 'sam@example.com', '', 'Once they join with this email, they’ll see the house.'],
    ['a number', '', '+61 400 000 000', 'Once they join with this number, they’ll see the house.'],
    [
      'both, where the email comes first',
      'sam@example.com',
      '+61 400 000 000',
      'Once they join, they’ll see the house. The email comes first: the number only finds someone it already belongs to, and isn’t saved.',
    ],
  ])('says what happens with %s', (_case, email, phone, hint) => {
    expect(linkHint(email, phone, PLACE)).toBe(hint)
  })
})
