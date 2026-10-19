import { describe, expect, it } from 'vitest'
import { addDays, parseLocalDate } from '../dates/local-date'
import { publicHolidayChecker } from './public-holidays'

const d = parseLocalDate

describe('publicHolidayChecker', () => {
  it('counts public holidays and substitute days, not bank holidays or observances', () => {
    const nsw = publicHolidayChecker('AU-NSW')
    expect(nsw(d('2026-10-05'))).toBe(true) // Labour Day
    expect(nsw(d('2026-12-28'))).toBe(true) // Boxing Day (substitute day)
    expect(nsw(d('2026-10-06'))).toBe(false)
    expect(nsw(d('2026-08-03'))).toBe(false) // Bank Holiday
    expect(nsw(d('2026-05-10'))).toBe(false) // Mother's Day
    expect(nsw(d('2027-01-01'))).toBe(true) // another year
  })

  it('counts every day of a holiday lasting several days', () => {
    const korea = publicHolidayChecker('KR')
    // 설날 (Seollal) lasts 17–19 February 2026.
    expect([16, 17, 18, 19, 20].map((day) => korea(d(`2026-02-${day}`)))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ])
  })

  it('doesn’t count a holiday’s trailing half day', () => {
    // Ramazan Bayramı 2026 runs from the evening of 19 March to noon on 23 March.
    const turkey = publicHolidayChecker('TR')
    expect([20, 21, 22, 23].map((day) => turkey(d(`2026-03-${day}`)))).toEqual([
      true,
      true,
      true,
      false,
    ])
  })

  it('doesn’t count a holiday that starts after midnight', () => {
    // QLD's Christmas Eve holiday starts at 18:00; Christmas Day is whole.
    const qld = publicHolidayChecker('AU-QLD')
    expect(qld(d('2026-12-24'))).toBe(false)
    expect(qld(d('2026-12-25'))).toBe(true)
  })

  it('uses the state’s own holidays', () => {
    // Labour Day is the first Monday in October in NSW, but March in Victoria.
    expect(publicHolidayChecker('AU-VIC')(d('2026-10-05'))).toBe(false)
  })

  it('works with a country alone', () => {
    expect(publicHolidayChecker('NZ')(d('2026-12-25'))).toBe(true)
  })

  it('throws for a region it doesn’t know', () => {
    expect(() => publicHolidayChecker('XX')).toThrow(RangeError)
    expect(() => publicHolidayChecker('AU-ZZZ')).toThrow(RangeError)
    expect(() => publicHolidayChecker('SG-01')).toThrow(RangeError) // Singapore has no states
    expect(() => publicHolidayChecker('constructor')).toThrow(RangeError)
    expect(() => publicHolidayChecker('AU-toString')).toThrow(RangeError)
  })
})

/**
 * Every whole-day public holiday counted for each Australian state and territory, 2026–2030 (#286):
 * 2026 and 2027 as each government's list declares them, later years as each Act's rules give
 * them (a day declared later becomes a correction). Checked on 2026-10-19 through web searches of
 * the sources named, which this sandbox can't open. They pin date-holidays 3.37.0 plus the
 * corrections in public-holidays.ts, so an upgrade that moves a date fails here before any schedule
 * uses it (scheduling.md#public-holidays). A date marked unverified is pinned as the library gives
 * it, since no official source settles it yet.
 */
const AU_HOLIDAYS: Record<string, string[]> = {
  // 2026–2027: nsw.gov.au/about-nsw/public-holidays. The Mondays after Anzac Day are a
  // two-year declaration (Public Holidays Order 2011 cl 6, 2026), and 25 April stays a holiday.
  // 2028–2030: Public Holidays Act 2010 (NSW) s 4. The August Bank Holiday isn't a public holiday.
  'AU-NSW': [
    '2026-01-01', // New Year's Day
    '2026-01-26', // Australia Day
    '2026-04-03', // Good Friday
    '2026-04-04', // Easter Saturday
    '2026-04-05', // Easter Sunday
    '2026-04-06', // Easter Monday
    '2026-04-25', // Anzac Day
    '2026-04-27', // Anzac Day (substitute day)
    '2026-06-08', // King's Birthday
    '2026-10-05', // Labour Day
    '2026-12-25', // Christmas Day
    '2026-12-26', // Boxing Day
    '2026-12-28', // Boxing Day (substitute day)
    '2027-01-01', // New Year's Day
    '2027-01-26', // Australia Day
    '2027-03-26', // Good Friday
    '2027-03-27', // Easter Saturday
    '2027-03-28', // Easter Sunday
    '2027-03-29', // Easter Monday
    '2027-04-25', // Anzac Day
    '2027-04-26', // Anzac Day (substitute day)
    '2027-06-14', // King's Birthday
    '2027-10-04', // Labour Day
    '2027-12-25', // Christmas Day
    '2027-12-26', // Boxing Day
    '2027-12-27', // Christmas Day (substitute day)
    '2027-12-28', // Boxing Day (substitute day)
    '2028-01-01', // New Year's Day
    '2028-01-03', // New Year's Day
    '2028-01-26', // Australia Day
    '2028-04-14', // Good Friday
    '2028-04-15', // Easter Saturday
    '2028-04-16', // Easter Sunday
    '2028-04-17', // Easter Monday
    '2028-04-25', // Anzac Day
    '2028-06-12', // King's Birthday
    '2028-10-02', // Labour Day
    '2028-12-25', // Christmas Day
    '2028-12-26', // Boxing Day
    '2029-01-01', // New Year's Day
    '2029-01-26', // Australia Day
    '2029-03-30', // Good Friday
    '2029-03-31', // Easter Saturday
    '2029-04-01', // Easter Sunday
    '2029-04-02', // Easter Monday
    '2029-04-25', // Anzac Day
    '2029-06-11', // King's Birthday
    '2029-10-01', // Labour Day
    '2029-12-25', // Christmas Day
    '2029-12-26', // Boxing Day
    '2030-01-01', // New Year's Day
    '2030-01-28', // Australia Day
    '2030-04-19', // Good Friday
    '2030-04-20', // Easter Saturday
    '2030-04-21', // Easter Sunday
    '2030-04-22', // Easter Monday
    '2030-04-25', // Anzac Day
    '2030-06-10', // King's Birthday
    '2030-10-07', // Labour Day
    '2030-12-25', // Christmas Day
    '2030-12-26', // Boxing Day
  ],
  // 2026–2028: business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-<year>.
  // 2029–2030: Public Holidays Act 1993 (Vic) s 6. Melbourne Cup counts for the whole state: a
  // council outside Melbourne can swap it for a local day (s 8A), which isn't modelled.
  'AU-VIC': [
    '2026-01-01', // New Year's Day
    '2026-01-26', // Australia Day
    '2026-03-09', // Labour Day
    '2026-04-03', // Good Friday
    '2026-04-04', // Easter Saturday
    '2026-04-05', // Easter Sunday
    '2026-04-06', // Easter Monday
    '2026-04-25', // Anzac Day
    '2026-06-08', // King's Birthday
    '2026-09-25', // AFL Grand Final Friday
    '2026-11-03', // Melbourne Cup
    '2026-12-25', // Christmas Day
    '2026-12-26', // Boxing Day
    '2026-12-28', // Boxing Day (substitute day)
    '2027-01-01', // New Year's Day
    '2027-01-26', // Australia Day
    '2027-03-08', // Labour Day
    '2027-03-26', // Good Friday
    '2027-03-27', // Easter Saturday
    '2027-03-28', // Easter Sunday
    '2027-03-29', // Easter Monday
    '2027-04-25', // Anzac Day
    '2027-06-14', // King's Birthday
    '2027-09-24', // AFL Grand Final Friday (unverified: AFL Grand Final Friday follows the AFL's fixture (s 6(ia)), not yet set)
    '2027-11-02', // Melbourne Cup
    '2027-12-25', // Christmas Day
    '2027-12-26', // Boxing Day
    '2027-12-27', // Christmas Day (substitute day)
    '2027-12-28', // Boxing Day (substitute day)
    '2028-01-01', // New Year's Day
    '2028-01-03', // New Year's Day
    '2028-01-26', // Australia Day
    '2028-03-13', // Labour Day
    '2028-04-14', // Good Friday
    '2028-04-15', // Easter Saturday
    '2028-04-16', // Easter Sunday
    '2028-04-17', // Easter Monday
    '2028-04-25', // Anzac Day
    '2028-06-12', // King's Birthday
    '2028-09-29', // AFL Grand Final Friday (unverified: AFL Grand Final Friday follows the AFL's fixture (s 6(ia)), not yet set)
    '2028-11-07', // Melbourne Cup
    '2028-12-25', // Christmas Day
    '2028-12-26', // Boxing Day
    '2029-01-01', // New Year's Day
    '2029-01-26', // Australia Day
    '2029-03-12', // Labour Day
    '2029-03-30', // Good Friday
    '2029-03-31', // Easter Saturday
    '2029-04-01', // Easter Sunday
    '2029-04-02', // Easter Monday
    '2029-04-25', // Anzac Day
    '2029-06-11', // King's Birthday
    '2029-09-28', // AFL Grand Final Friday (unverified: AFL Grand Final Friday follows the AFL's fixture (s 6(ia)), not yet set)
    '2029-11-06', // Melbourne Cup
    '2029-12-25', // Christmas Day
    '2029-12-26', // Boxing Day
    '2030-01-01', // New Year's Day
    '2030-01-28', // Australia Day
    '2030-03-11', // Labour Day
    '2030-04-19', // Good Friday
    '2030-04-20', // Easter Saturday
    '2030-04-21', // Easter Sunday
    '2030-04-22', // Easter Monday
    '2030-04-25', // Anzac Day
    '2030-06-10', // King's Birthday
    '2030-09-27', // AFL Grand Final Friday (unverified: AFL Grand Final Friday follows the AFL's fixture (s 6(ia)), not yet set)
    '2030-11-05', // Melbourne Cup
    '2030-12-25', // Christmas Day
    '2030-12-26', // Boxing Day
  ],
  // 2026–2029: qld.gov.au/recreation/travel/holidays/public. 2030: Holidays Act 1983 (Qld) s 2
  // and schedule. Anzac Day on a Sunday moves to the Monday (2027).
  'AU-QLD': [
    '2026-01-01', // New Year's Day
    '2026-01-26', // Australia Day
    '2026-04-03', // Good Friday
    '2026-04-04', // Easter Saturday
    '2026-04-05', // Easter Sunday
    '2026-04-06', // Easter Monday
    '2026-04-25', // Anzac Day
    '2026-05-04', // Labour Day
    '2026-10-05', // King's Birthday
    '2026-12-25', // Christmas Day
    '2026-12-26', // Boxing Day
    '2026-12-28', // Boxing Day (substitute day)
    '2027-01-01', // New Year's Day
    '2027-01-26', // Australia Day
    '2027-03-26', // Good Friday
    '2027-03-27', // Easter Saturday
    '2027-03-28', // Easter Sunday
    '2027-03-29', // Easter Monday
    '2027-04-26', // Anzac Day
    '2027-05-03', // Labour Day
    '2027-10-04', // King's Birthday
    '2027-12-25', // Christmas Day
    '2027-12-26', // Boxing Day
    '2027-12-27', // Christmas Day (substitute day)
    '2027-12-28', // Boxing Day (substitute day)
    '2028-01-01', // New Year's Day
    '2028-01-03', // New Year's Day
    '2028-01-26', // Australia Day
    '2028-04-14', // Good Friday
    '2028-04-15', // Easter Saturday
    '2028-04-16', // Easter Sunday
    '2028-04-17', // Easter Monday
    '2028-04-25', // Anzac Day
    '2028-05-01', // Labour Day
    '2028-10-02', // King's Birthday
    '2028-12-25', // Christmas Day
    '2028-12-26', // Boxing Day
    '2029-01-01', // New Year's Day
    '2029-01-26', // Australia Day
    '2029-03-30', // Good Friday
    '2029-03-31', // Easter Saturday
    '2029-04-01', // Easter Sunday
    '2029-04-02', // Easter Monday
    '2029-04-25', // Anzac Day
    '2029-05-07', // Labour Day
    '2029-10-01', // King's Birthday
    '2029-12-25', // Christmas Day
    '2029-12-26', // Boxing Day
    '2030-01-01', // New Year's Day
    '2030-01-28', // Australia Day
    '2030-04-19', // Good Friday
    '2030-04-20', // Easter Saturday
    '2030-04-21', // Easter Sunday
    '2030-04-22', // Easter Monday
    '2030-04-25', // Anzac Day
    '2030-05-06', // Labour Day
    '2030-10-07', // King's Birthday
    '2030-12-25', // Christmas Day
    '2030-12-26', // Boxing Day
  ],
  // 2026–2028: safework.sa.gov.au/resources/public-holidays. 2029–2030: Public Holidays Act 2023
  // (SA) s 3, which replaced the Holidays Act 1910. Saturday 25 Dec 2027 is a correction (ADDED).
  'AU-SA': [
    '2026-01-01', // New Year's Day
    '2026-01-26', // Australia Day
    '2026-03-09', // Adelaide Cup Day
    '2026-04-03', // Good Friday
    '2026-04-04', // Easter Saturday
    '2026-04-05', // Easter Sunday
    '2026-04-06', // Easter Monday
    '2026-04-25', // Anzac Day
    '2026-06-08', // King's Birthday
    '2026-10-05', // Labour Day
    '2026-12-25', // Christmas Day
    '2026-12-26', // Proclamation Day
    '2026-12-28', // Proclamation Day
    '2027-01-01', // New Year's Day
    '2027-01-26', // Australia Day
    '2027-03-08', // Adelaide Cup Day
    '2027-03-26', // Good Friday
    '2027-03-27', // Easter Saturday
    '2027-03-28', // Easter Sunday
    '2027-03-29', // Easter Monday
    '2027-04-25', // Anzac Day
    '2027-06-14', // King's Birthday
    '2027-10-04', // Labour Day
    '2027-12-25', // Christmas Day
    '2027-12-26', // Proclamation Day
    '2027-12-27', // Christmas Day
    '2027-12-28', // Proclamation Day
    '2028-01-01', // New Year's Day
    '2028-01-03', // New Year's Day
    '2028-01-26', // Australia Day
    '2028-03-13', // Adelaide Cup Day
    '2028-04-14', // Good Friday
    '2028-04-15', // Easter Saturday
    '2028-04-16', // Easter Sunday
    '2028-04-17', // Easter Monday
    '2028-04-25', // Anzac Day
    '2028-06-12', // King's Birthday
    '2028-10-02', // Labour Day
    '2028-12-25', // Christmas Day
    '2028-12-26', // Proclamation Day
    '2029-01-01', // New Year's Day
    '2029-01-26', // Australia Day
    '2029-03-12', // Adelaide Cup Day
    '2029-03-30', // Good Friday
    '2029-03-31', // Easter Saturday
    '2029-04-01', // Easter Sunday
    '2029-04-02', // Easter Monday
    '2029-04-25', // Anzac Day
    '2029-06-11', // King's Birthday
    '2029-10-01', // Labour Day
    '2029-12-25', // Christmas Day
    '2029-12-26', // Proclamation Day
    '2030-01-01', // New Year's Day
    '2030-01-28', // Australia Day
    '2030-03-11', // Adelaide Cup Day
    '2030-04-19', // Good Friday
    '2030-04-20', // Easter Saturday
    '2030-04-21', // Easter Sunday
    '2030-04-22', // Easter Monday
    '2030-04-25', // Anzac Day
    '2030-06-10', // King's Birthday
    '2030-10-07', // Labour Day
    '2030-12-25', // Christmas Day
    '2030-12-26', // Proclamation Day
  ],
  // 2026–2027: wa.gov.au/service/employment/workplace-arrangements/public-holidays-western-australia.
  // 2028–2030: Public and Bank Holidays Act 1972 (WA) s 5 and Second Schedule. They may change:
  // the Public and Bank Holidays Amendment Bill 2025, not passed yet, would move Labour Day, WA
  // Day and the King's Birthday, and add Easter Saturday and a Show Day, from 2028.
  'AU-WA': [
    '2026-01-01', // New Year's Day
    '2026-01-26', // Australia Day
    '2026-03-02', // Labour Day
    '2026-04-03', // Good Friday
    '2026-04-05', // Easter Sunday
    '2026-04-06', // Easter Monday
    '2026-04-25', // Anzac Day
    '2026-04-27', // Anzac Day (substitute day)
    '2026-06-01', // Western Australia Day
    '2026-09-28', // King's Birthday
    '2026-12-25', // Christmas Day
    '2026-12-26', // Boxing Day
    '2026-12-28', // Boxing Day (substitute day)
    '2027-01-01', // New Year's Day
    '2027-01-26', // Australia Day
    '2027-03-01', // Labour Day
    '2027-03-26', // Good Friday
    '2027-03-28', // Easter Sunday
    '2027-03-29', // Easter Monday
    '2027-04-25', // Anzac Day
    '2027-04-26', // Anzac Day (substitute day)
    '2027-06-07', // Western Australia Day
    '2027-09-27', // King's Birthday
    '2027-12-25', // Christmas Day
    '2027-12-26', // Boxing Day
    '2027-12-27', // Christmas Day (substitute day)
    '2027-12-28', // Boxing Day (substitute day)
    '2028-01-01', // New Year's Day
    '2028-01-03', // New Year's Day
    '2028-01-26', // Australia Day
    '2028-03-06', // Labour Day
    '2028-04-14', // Good Friday
    '2028-04-16', // Easter Sunday
    '2028-04-17', // Easter Monday
    '2028-04-25', // Anzac Day
    '2028-06-05', // Western Australia Day
    '2028-09-25', // King's Birthday (unverified: King's Birthday is proclaimed each year, and 2028 isn't yet)
    '2028-12-25', // Christmas Day
    '2028-12-26', // Boxing Day
    '2029-01-01', // New Year's Day
    '2029-01-26', // Australia Day
    '2029-03-05', // Labour Day
    '2029-03-30', // Good Friday
    '2029-04-01', // Easter Sunday
    '2029-04-02', // Easter Monday
    '2029-04-25', // Anzac Day
    '2029-06-04', // Western Australia Day
    '2029-09-24', // King's Birthday (unverified: King's Birthday is proclaimed each year, and 2029 isn't yet)
    '2029-12-25', // Christmas Day
    '2029-12-26', // Boxing Day
    '2030-01-01', // New Year's Day
    '2030-01-28', // Australia Day
    '2030-03-04', // Labour Day
    '2030-04-19', // Good Friday
    '2030-04-21', // Easter Sunday
    '2030-04-22', // Easter Monday
    '2030-04-25', // Anzac Day
    '2030-06-03', // Western Australia Day
    '2030-09-30', // King's Birthday (unverified: King's Birthday is proclaimed each year, and 2030 isn't yet)
    '2030-12-25', // Christmas Day
    '2030-12-26', // Boxing Day
  ],
  // 2026–2028: worksafe.tas.gov.au/topics/laws-and-compliance/public-holidays. 2029–2030:
  // Statutory Holidays Act 2000 (Tas) s 4. Easter Tuesday is for the public service only.
  // Unverified: Easter Sunday from 2027. legislation.tas.gov.au lists a Statutory Holidays
  // Amendment Act 2026 (bill 14 of 2026, reported to add it), but its text and start date
  // couldn't be read, and WorkSafe's 2027 table doesn't show it. So it isn't added yet (#296).
  'AU-TAS': [
    '2026-01-01', // New Year's Day
    '2026-01-26', // Australia Day
    '2026-03-09', // Eight Hours Day
    '2026-04-03', // Good Friday
    '2026-04-06', // Easter Monday
    '2026-04-25', // Anzac Day
    '2026-06-08', // King's Birthday
    '2026-12-25', // Christmas Day
    '2026-12-28', // Boxing Day
    '2027-01-01', // New Year's Day
    '2027-01-26', // Australia Day
    '2027-03-08', // Eight Hours Day
    '2027-03-26', // Good Friday
    '2027-03-29', // Easter Monday
    '2027-04-25', // Anzac Day
    '2027-06-14', // King's Birthday
    '2027-12-25', // Christmas Day (unverified: WorkSafe's 2027 table shows only Mon 27 Dec, its rule text both days; #296)
    '2027-12-27', // Christmas Day (substitute day)
    '2027-12-28', // Boxing Day
    '2028-01-03', // New Year's Day
    '2028-01-26', // Australia Day
    '2028-03-13', // Eight Hours Day
    '2028-04-14', // Good Friday
    '2028-04-17', // Easter Monday
    '2028-04-25', // Anzac Day
    '2028-06-12', // King's Birthday
    '2028-12-25', // Christmas Day
    '2028-12-26', // Boxing Day
    '2029-01-01', // New Year's Day
    '2029-01-26', // Australia Day
    '2029-03-12', // Eight Hours Day
    '2029-03-30', // Good Friday
    '2029-04-02', // Easter Monday
    '2029-04-25', // Anzac Day
    '2029-06-11', // King's Birthday
    '2029-12-25', // Christmas Day
    '2029-12-26', // Boxing Day
    '2030-01-01', // New Year's Day
    '2030-01-28', // Australia Day
    '2030-03-11', // Eight Hours Day
    '2030-04-19', // Good Friday
    '2030-04-22', // Easter Monday
    '2030-04-25', // Anzac Day
    '2030-06-10', // King's Birthday
    '2030-12-25', // Christmas Day
    '2030-12-26', // Boxing Day
  ],
  // 2026–2029: act.gov.au, ACT Public Holidays <year>; the weekend Anzac Days by NI2026-154 and
  // NI2026-387. 2030: Holidays Act 1958 (ACT) s 3.
  'AU-ACT': [
    '2026-01-01', // New Year's Day
    '2026-01-26', // Australia Day
    '2026-03-09', // Canberra Day
    '2026-04-03', // Good Friday
    '2026-04-04', // Easter Saturday
    '2026-04-05', // Easter Sunday
    '2026-04-06', // Easter Monday
    '2026-04-25', // Anzac Day
    '2026-04-27', // Anzac Day (substitute day)
    '2026-06-01', // Reconciliation Day
    '2026-06-08', // King's Birthday
    '2026-10-05', // Labour Day
    '2026-12-25', // Christmas Day
    '2026-12-26', // Boxing Day
    '2026-12-28', // Boxing Day (substitute day)
    '2027-01-01', // New Year's Day
    '2027-01-26', // Australia Day
    '2027-03-08', // Canberra Day
    '2027-03-26', // Good Friday
    '2027-03-27', // Easter Saturday
    '2027-03-28', // Easter Sunday
    '2027-03-29', // Easter Monday
    '2027-04-25', // Anzac Day
    '2027-04-26', // Anzac Day (substitute day)
    '2027-05-31', // Reconciliation Day
    '2027-06-14', // King's Birthday
    '2027-10-04', // Labour Day
    '2027-12-25', // Christmas Day
    '2027-12-26', // Boxing Day
    '2027-12-27', // Christmas Day (substitute day)
    '2027-12-28', // Boxing Day (substitute day)
    '2028-01-01', // New Year's Day
    '2028-01-03', // New Year's Day
    '2028-01-26', // Australia Day
    '2028-03-13', // Canberra Day
    '2028-04-14', // Good Friday
    '2028-04-15', // Easter Saturday
    '2028-04-16', // Easter Sunday
    '2028-04-17', // Easter Monday
    '2028-04-25', // Anzac Day
    '2028-05-29', // Reconciliation Day
    '2028-06-12', // King's Birthday
    '2028-10-02', // Labour Day
    '2028-12-25', // Christmas Day
    '2028-12-26', // Boxing Day
    '2029-01-01', // New Year's Day
    '2029-01-26', // Australia Day
    '2029-03-12', // Canberra Day
    '2029-03-30', // Good Friday
    '2029-03-31', // Easter Saturday
    '2029-04-01', // Easter Sunday
    '2029-04-02', // Easter Monday
    '2029-04-25', // Anzac Day
    '2029-05-28', // Reconciliation Day
    '2029-06-11', // King's Birthday
    '2029-10-01', // Labour Day
    '2029-12-25', // Christmas Day
    '2029-12-26', // Boxing Day
    '2030-01-01', // New Year's Day
    '2030-01-28', // Australia Day
    '2030-03-11', // Canberra Day
    '2030-04-19', // Good Friday
    '2030-04-20', // Easter Saturday
    '2030-04-21', // Easter Sunday
    '2030-04-22', // Easter Monday
    '2030-04-25', // Anzac Day
    '2030-05-27', // Reconciliation Day
    '2030-06-10', // King's Birthday
    '2030-10-07', // Labour Day
    '2030-12-25', // Christmas Day
    '2030-12-26', // Boxing Day
  ],
  // 2026–2028: nt.gov.au/nt-public-holidays. 2029–2030: Public Holidays Act 1981 (NT) sch 2.
  // Saturday 25 Dec 2027 is a correction (ADDED).
  'AU-NT': [
    '2026-01-01', // New Year's Day
    '2026-01-26', // Australia Day
    '2026-04-03', // Good Friday
    '2026-04-04', // Easter Saturday
    '2026-04-05', // Easter Sunday
    '2026-04-06', // Easter Monday
    '2026-04-25', // Anzac Day
    '2026-05-04', // May Day
    '2026-06-08', // King's Birthday
    '2026-08-03', // Picnic Day
    '2026-12-25', // Christmas Day
    '2026-12-26', // Boxing Day
    '2026-12-28', // Boxing Day (substitute day)
    '2027-01-01', // New Year's Day
    '2027-01-26', // Australia Day
    '2027-03-26', // Good Friday
    '2027-03-27', // Easter Saturday
    '2027-03-28', // Easter Sunday
    '2027-03-29', // Easter Monday
    '2027-04-26', // Anzac Day
    '2027-05-03', // May Day
    '2027-06-14', // King's Birthday
    '2027-08-02', // Picnic Day
    '2027-12-25', // Christmas Day
    '2027-12-26', // Boxing Day
    '2027-12-27', // Christmas Day
    '2027-12-28', // Boxing Day (substitute day)
    '2028-01-01', // New Year's Day
    '2028-01-03', // New Year's Day
    '2028-01-26', // Australia Day
    '2028-04-14', // Good Friday
    '2028-04-15', // Easter Saturday
    '2028-04-16', // Easter Sunday
    '2028-04-17', // Easter Monday
    '2028-04-25', // Anzac Day
    '2028-05-01', // May Day
    '2028-06-12', // King's Birthday
    '2028-08-07', // Picnic Day
    '2028-12-25', // Christmas Day
    '2028-12-26', // Boxing Day
    '2029-01-01', // New Year's Day
    '2029-01-26', // Australia Day
    '2029-03-30', // Good Friday
    '2029-03-31', // Easter Saturday
    '2029-04-01', // Easter Sunday
    '2029-04-02', // Easter Monday
    '2029-04-25', // Anzac Day
    '2029-05-07', // May Day
    '2029-06-11', // King's Birthday
    '2029-08-06', // Picnic Day
    '2029-12-25', // Christmas Day
    '2029-12-26', // Boxing Day
    '2030-01-01', // New Year's Day
    '2030-01-28', // Australia Day
    '2030-04-19', // Good Friday
    '2030-04-20', // Easter Saturday
    '2030-04-21', // Easter Sunday
    '2030-04-22', // Easter Monday
    '2030-04-25', // Anzac Day
    '2030-05-06', // May Day
    '2030-06-10', // King's Birthday
    '2030-08-05', // Picnic Day
    '2030-12-25', // Christmas Day
    '2030-12-26', // Boxing Day
  ],
}

/** Every day from 2026 to 2030 that `region` counts as a holiday. */
function counted(region: string): string[] {
  const isHoliday = publicHolidayChecker(region)
  const days: string[] = []
  for (let date = d('2026-01-01'); date <= '2030-12-31'; date = addDays(date, 1)) {
    if (isHoliday(date)) days.push(date)
  }
  return days
}

describe('Australian public holidays, 2026–2030', () => {
  it.each(Object.entries(AU_HOLIDAYS))('pins %s', (region, days) => {
    expect(counted(region)).toEqual(days)
  })

  it('keeps NSW’s weekend Anzac Days and adds the Monday after, in 2026 and 2027 only', () => {
    // #57's finding is right: Public Holidays Order 2011 cl 6 declares both Mondays, and the
    // ministerial release of 15 Feb 2026 says the extra day doesn't replace Anzac Day.
    const nsw = publicHolidayChecker('AU-NSW')
    expect(
      ['2026-04-25', '2026-04-27', '2027-04-25', '2027-04-26'].map((day) => nsw(d(day))),
    ).toEqual([true, true, true, true])
  })
})
