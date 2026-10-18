import { nextSummaryAt } from '@ledgerly/core/dates/summary-period'
import type { Profiles } from '@ledgerly/core/generated/rows'
import { describe, expect, it } from 'vitest'
import { failure, fakes, NOW, ok } from './harness'

// NOW is Monday 19 October, 07:00 in Sydney, so the next weekly summary is a week later.
const NEXT_WEEKLY_SYDNEY = '2026-10-25T20:00:00.000Z'
// A stored send time, unlike any the route would work out.
const AT_LAST_SET = '2026-10-19T20:00:00.000Z'

function withProfile(profile: object = {}) {
  return fakes({
    persons: [{ $id: 'pSam', userId: 'u1', displayName: 'Sam Lee', claimedAt: NOW.toISOString() }],
    profiles: [
      {
        $id: 'u1',
        personId: 'pSam',
        timezone: 'Australia/Sydney',
        region: 'AU-NSW',
        currency: 'AUD',
        businessJson: null,
        invoicePrefix: 'INV-',
        lastInvoiceNumber: 7,
        summaryFrequency: 'none',
        nextSummaryAt: null,
        ...profile,
      },
    ],
  })
}

function patch(services: ReturnType<typeof fakes>, body: unknown) {
  return ok<Profiles>(services, 'PATCH', '/profile', body)
}

describe('PATCH /profile', () => {
  it('changes only the fields given, and returns the profile', async () => {
    const services = withProfile()
    const profile = await patch(services, { region: 'AU-VIC', invoicePrefix: ' ACME- ' })
    expect(profile).toMatchObject({
      $id: 'u1',
      timezone: 'Australia/Sydney',
      region: 'AU-VIC',
      currency: 'AUD',
      invoicePrefix: 'ACME-',
      lastInvoiceNumber: 7,
      summaryFrequency: 'none',
      nextSummaryAt: null,
    })
  })

  it("puts displayName on the person, the registered person's own name", async () => {
    const services = withProfile()
    await patch(services, { displayName: '  Samantha Lee ' })
    expect(services.db.rows('persons')[0]?.displayName).toBe('Samantha Lee')
    expect(services.db.rows('profiles')[0]).not.toHaveProperty('displayName')
  })

  it('stores business details as JSON, and replaces them as a whole', async () => {
    const services = withProfile()
    const first = await patch(services, {
      business: { businessName: 'Sam Cleaning', abn: '51 824 753 556', invoiceNotes: 'Thanks' },
    })
    expect(JSON.parse(first.businessJson ?? '')).toEqual({
      businessName: 'Sam Cleaning',
      abn: '51824753556',
      invoiceNotes: 'Thanks',
    })
    // A field the form leaves out is removed; top-level fields left out stay as they were.
    const second = await patch(services, { business: { businessName: 'Sam Cleaning Co' } })
    expect(JSON.parse(second.businessJson ?? '')).toEqual({ businessName: 'Sam Cleaning Co' })
    expect(second.region).toBe('AU-NSW')
  })

  it('sets nextSummaryAt when summaryFrequency changes, and clears it for none', async () => {
    const services = withProfile()
    const weekly = await patch(services, { summaryFrequency: 'weekly' })
    expect(weekly.nextSummaryAt).toBe(NEXT_WEEKLY_SYDNEY)
    expect(weekly.nextSummaryAt).toBe(nextSummaryAt('weekly', 'Australia/Sydney', NOW))
    const none = await patch(services, { summaryFrequency: 'none' })
    expect(none.nextSummaryAt).toBeNull()
  })

  it('keeps nextSummaryAt when the frequency and timezone are sent unchanged', async () => {
    const services = withProfile({ summaryFrequency: 'fortnightly', nextSummaryAt: AT_LAST_SET })
    const profile = await patch(services, {
      summaryFrequency: 'fortnightly',
      timezone: 'Australia/Sydney',
    })
    expect(profile.nextSummaryAt).toBe(AT_LAST_SET)
  })

  it('moves nextSummaryAt when the timezone changes', async () => {
    const services = withProfile({ summaryFrequency: 'weekly', nextSummaryAt: AT_LAST_SET })
    const profile = await patch(services, { timezone: 'Australia/Perth' })
    expect(profile.nextSummaryAt).toBe(nextSummaryAt('weekly', 'Australia/Perth', NOW))
    expect(profile.nextSummaryAt).toBe('2026-10-18T23:00:00.000Z') // 07:00 today in Perth
  })

  it('writes nothing for an empty body', async () => {
    const services = withProfile()
    const before = services.db.rows('profiles')
    expect(await patch(services, {})).toMatchObject({ $id: 'u1' })
    expect(services.db.rows('profiles')).toEqual(before)
  })

  it.each([
    ['an unknown field', { nickname: 'Sammy' }],
    ['a field only other functions write', { lastInvoiceNumber: 0 }],
    ['nextSummaryAt itself', { nextSummaryAt: null }],
    ['an unknown business field', { business: { website: 'example.com' } }],
    ['a bad region', { region: 'NSW' }],
  ])('is VALIDATION_FAILED with %s, and writes nothing', async (_, body) => {
    const services = withProfile()
    const before = services.db.rows('profiles')
    expect(await failure(services, 'PATCH', '/profile', body)).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
    expect(services.db.rows('profiles')).toEqual(before)
  })

  it('is NOT_FOUND before bootstrap, and UNAUTHENTICATED without a JWT', async () => {
    expect(await failure(fakes(), 'PATCH', '/profile', { region: 'AU-VIC' })).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Set up your account first.',
    })
    expect(await failure(withProfile(), 'PATCH', '/profile', {}, null)).toMatchObject({
      code: 'UNAUTHENTICATED',
    })
  })
})
