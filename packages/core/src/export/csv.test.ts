import { describe, expect, it } from 'vitest'
import { MAX_AMOUNT_CENTS } from '../constants/limits'
import { groupCsv, myRecordsCsv, profileCsv, toCsv } from './csv'

const BOM = '﻿'

/** The lines of a CSV, after checking its byte order mark and CRLF ends. */
function lines(csv: string): string[] {
  expect(csv.startsWith(BOM)).toBe(true)
  expect(csv.endsWith('\r\n')).toBe(true)
  return csv.slice(1, -2).split('\r\n')
}

describe('toCsv', () => {
  it('writes a byte order mark, CRLF line ends and plain fields as they are', () => {
    expect(toCsv(['a', 'b'], [['1', 'x y']])).toBe(`${BOM}a,b\r\n1,x y\r\n`)
  })

  it('quotes fields with a comma, quote, CR or LF, doubling quotes', () => {
    expect(lines(toCsv(['v'], [['a,b'], ['say "hi"'], ['line\nbreak'], ['cr\rhere']]))).toEqual([
      'v',
      '"a,b"',
      '"say ""hi"""',
      '"line\nbreak"',
      '"cr\rhere"',
    ])
  })

  it('stops a text cell from starting a formula, but never an amount', () => {
    const rows = [['=SUM(A1)'], ['+1'], ['-2'], ['@x'], ['\tTab'], ['\rCR'], ['ok=1']]
    expect(lines(toCsv(['v'], rows))).toEqual([
      'v',
      "'=SUM(A1)",
      "'+1",
      "'-2",
      "'@x",
      "'\tTab",
      `"'\rCR"`,
      'ok=1',
    ])
    expect(lines(toCsv(['v'], [[{ money: '-12.30' }]]))).toEqual(['v', '-12.30'])
    // Spaces before, a leading line feed, and full-width forms.
    expect(
      lines(
        toCsv(
          ['v'],
          [
            [' =1'],
            ['\u00a0+1'],
            ['\u3000@x'],
            ['\nx'],
            ['＝1'],
            ['＋1'],
            ['－1'],
            ['＠x'],
            ['a =1'],
          ],
        ),
      ),
    ).toEqual([
      'v',
      "' =1",
      "'\u00a0+1",
      "'\u3000@x",
      `"'\nx"`,
      "'＝1",
      "'＋1",
      "'－1",
      "'＠x",
      'a =1',
    ])
  })
})

const transaction = {
  $id: 't1',
  date: '2026-10-05',
  status: 'posted' as const,
  kind: 'expense' as const,
  description: 'Groceries, Coles',
  category: 'groceries',
  totalCents: 4505,
}

describe('groupCsv', () => {
  const names = new Map([
    ['p1', 'Sam'],
    ['p2', '=Alex'],
  ])

  it('writes a row per share, with exact money and net = given − received', () => {
    const csv = groupCsv(
      'AUD',
      [transaction],
      [
        { transactionId: 't1', personId: 'p1', givenCents: 4505, receivedCents: 2253 },
        { transactionId: 't1', personId: 'p2', givenCents: 0, receivedCents: 2252 },
      ],
      names,
    )
    expect(lines(csv)).toEqual([
      'date,status,kind,description,category,currency,total,person,given,received,net',
      '2026-10-05,posted,expense,"Groceries, Coles",groceries,AUD,45.05,Sam,45.05,22.53,22.52',
      '2026-10-05,posted,expense,"Groceries, Coles",groceries,AUD,45.05,\'=Alex,0.00,22.52,-22.52',
    ])
  })

  it('writes a transaction with no shares once, with empty person columns', () => {
    const voided = {
      ...transaction,
      $id: 't2',
      status: 'void' as const,
      category: null,
      totalCents: 1234,
    }
    expect(lines(groupCsv('JPY', [voided], [], names))[1]).toBe(
      '2026-10-05,void,expense,"Groceries, Coles",,JPY,1234,,,,',
    )
  })

  it('leaves a person with no name in the group empty', () => {
    const csv = groupCsv(
      'AUD',
      [transaction],
      [{ transactionId: 't1', personId: 'p9', givenCents: 4505, receivedCents: 4505 }],
      names,
    )
    expect(lines(csv)[1]).toBe(
      '2026-10-05,posted,expense,"Groceries, Coles",groceries,AUD,45.05,,45.05,45.05,0.00',
    )
  })

  it('writes a net past the amount cap, as an adjustment can give one', () => {
    const adjustment = { ...transaction, kind: 'adjustment' as const, totalCents: 0 }
    const csv = groupCsv(
      'AUD',
      [adjustment],
      [
        {
          transactionId: 't1',
          personId: 'p1',
          givenCents: MAX_AMOUNT_CENTS,
          receivedCents: -MAX_AMOUNT_CENTS,
        },
      ],
      names,
    )
    expect(lines(csv)[1]?.split(',').at(-1)).toBe('200000000.00')
  })
})

describe('myRecordsCsv', () => {
  it('writes the user’s shares across groups, each in its group’s currency', () => {
    const csv = myRecordsCsv([
      {
        group: { name: 'Flat', type: 'house', currency: 'AUD' },
        transaction: { ...transaction, category: null },
        share: { givenCents: 0, receivedCents: 5 },
      },
      {
        group: { name: 'Tokyo trip', type: 'pair', currency: 'JPY' },
        transaction: { ...transaction, kind: 'payment', totalCents: 3000 },
        share: { givenCents: 3000, receivedCents: 0 },
      },
    ])
    expect(lines(csv)).toEqual([
      'group,groupType,date,kind,description,category,currency,total,given,received,net',
      'Flat,house,2026-10-05,expense,"Groceries, Coles",,AUD,45.05,0.00,0.05,-0.05',
      'Tokyo trip,pair,2026-10-05,payment,"Groceries, Coles",groceries,JPY,3000,3000,0,3000',
    ])
  })
})

describe('profileCsv', () => {
  const profile = {
    timezone: 'Australia/Sydney',
    region: 'AU-NSW',
    currency: 'AUD',
    invoicePrefix: 'INV-',
    lastInvoiceNumber: 0,
    summaryFrequency: 'weekly' as const,
    hoursCapMinutes: null,
    hoursCapPeriod: null,
    hoursCapStartsOn: null,
    emailOptOuts: null,
  }

  it('writes the user’s own details, business details included, leaving out empty ones', () => {
    const csv = profileCsv({
      name: 'Sam Lee',
      email: 'sam@example.com',
      phone: null,
      profile: {
        ...profile,
        hoursCapMinutes: 2400,
        hoursCapPeriod: 'week',
        emailOptOuts: ['billDue', 'statementReady'],
      },
      business: {
        businessName: 'Sam Lee Cleaning',
        abn: '51824753556',
        bank: { accountName: 'Sam Lee', bsb: '062000', accountNumber: '12345678' },
      },
    })
    expect(lines(csv)).toEqual([
      'field,value',
      'name,Sam Lee',
      'email,sam@example.com',
      'timezone,Australia/Sydney',
      'region,AU-NSW',
      'currency,AUD',
      'invoicePrefix,INV-',
      'lastInvoiceNumber,0',
      'summaryFrequency,weekly',
      'hoursCapMinutes,2400',
      'hoursCapPeriod,week',
      'emailOptOuts,billDue statementReady',
      'business.businessName,Sam Lee Cleaning',
      'business.abn,51824753556',
      'business.bank.accountName,Sam Lee',
      'business.bank.bsb,062000',
      'business.bank.accountNumber,12345678',
    ])
  })

  it('writes no business rows without business details, and guards typed text', () => {
    const csv = profileCsv({
      name: '+Sam',
      email: null,
      phone: '+61412345678',
      // `[]` is every email on, as null is: no row.
      profile: { ...profile, invoicePrefix: '', emailOptOuts: [] },
      business: null,
    })
    expect(lines(csv)).toEqual([
      'field,value',
      "name,'+Sam",
      "phone,'+61412345678",
      'timezone,Australia/Sydney',
      'region,AU-NSW',
      'currency,AUD',
      'lastInvoiceNumber,0',
      'summaryFrequency,weekly',
    ])
  })
})
