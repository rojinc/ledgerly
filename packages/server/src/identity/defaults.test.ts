import { publicHolidayChecker } from '@ledgerly/core/recurrence/public-holidays'
import { describe, expect, it } from 'vitest'
import { profileDefaults } from './defaults'

describe('profileDefaults', () => {
  it.each([
    ['Australia/Sydney', 'AU-NSW'],
    ['Australia/Broken_Hill', 'AU-NSW'],
    ['Australia/Lord_Howe', 'AU-NSW'],
    ['Australia/Canberra', 'AU-ACT'],
    ['Australia/Melbourne', 'AU-VIC'],
    ['Australia/Brisbane', 'AU-QLD'],
    ['Australia/Lindeman', 'AU-QLD'],
    ['Australia/Adelaide', 'AU-SA'],
    ['Australia/Perth', 'AU-WA'],
    ['Australia/Eucla', 'AU-WA'],
    ['Australia/Hobart', 'AU-TAS'],
    ['Australia/Darwin', 'AU-NT'],
  ])('maps %s to %s, in AUD, a region the holiday library knows', (timeZone, region) => {
    expect(profileDefaults(timeZone)).toEqual({ region, currency: 'AUD' })
    expect(() => publicHolidayChecker(region)).not.toThrow()
  })

  it.each(['Pacific/Auckland', 'UTC', 'toString', '__proto__'])(
    'gives AU-NSW and AUD for any other zone (%s)',
    (timeZone) => {
      expect(profileDefaults(timeZone)).toEqual({ region: 'AU-NSW', currency: 'AUD' })
    },
  )
})
