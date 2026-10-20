import type { Profiles } from '@ledgerly/core/generated/rows'
import { updateProfileBodySchema } from '@ledgerly/core/schemas/identity'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BusinessForm } from './business-form'
import { EmailSettingsForm } from './email-settings-form'
import { HoursCapForm } from './hours-cap-form'
import { ProfileForm } from './profile-form'

const profile = {
  $id: 'u1',
  personId: 'p1',
  timezone: 'Australia/Sydney',
  region: 'AU-NSW',
  currency: 'AUD',
  businessJson: null,
  invoicePrefix: 'INV-',
  lastInvoiceNumber: 0,
  summaryFrequency: 'none',
  nextSummaryAt: null,
} as Profiles

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

afterEach(cleanup)

describe('ProfileForm', () => {
  it('sends the profile fields, with region and currency upper-cased', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<ProfileForm profile={profile} displayName="Sam Lee" onSave={onSave} />)
    type('Name', '  Sam Q. Lee ')
    type('Time zone', 'Australia/Melbourne')
    type('Public holiday region', 'au-vic')
    type('Currency', 'nzd')
    type('Summary email', 'fortnightly')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith({
      displayName: 'Sam Q. Lee',
      timezone: 'Australia/Melbourne',
      region: 'AU-VIC',
      currency: 'NZD',
      summaryFrequency: 'fortnightly',
    })
    expect(await screen.findByText('Saved.')).toBeTruthy()
    // The fields now show what was stored.
    expect((screen.getByLabelText('Public holiday region') as HTMLInputElement).value).toBe(
      'AU-VIC',
    )
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Sam Q. Lee')
  })

  it('shows inline errors from the shared schema and sends nothing', async () => {
    const onSave = vi.fn()
    render(<ProfileForm profile={profile} displayName="Sam Lee" onSave={onSave} />)
    type('Name', '   ')
    type('Public holiday region', 'New South Wales')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Required')).toBeTruthy()
    expect(screen.getByText('Expected e.g. AU-NSW')).toBeTruthy()
    const name = screen.getByLabelText('Name')
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(name.getAttribute('aria-describedby')).toBe('displayName-error')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('hides "Saved." once the form is edited again', async () => {
    render(<ProfileForm profile={profile} displayName="Sam Lee" onSave={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved.')).toBeTruthy()
    type('Name', 'Sam')
    await waitFor(() => expect(screen.queryByText('Saved.')).toBeNull())
  })

  it('still works where Intl.supportedValuesOf is missing', () => {
    const original = Intl.supportedValuesOf
    Object.defineProperty(Intl, 'supportedValuesOf', { value: undefined, configurable: true })
    try {
      render(<ProfileForm profile={profile} displayName="Sam Lee" onSave={vi.fn()} />)
      expect((screen.getByLabelText('Time zone') as HTMLSelectElement).value).toBe(
        'Australia/Sydney',
      )
    } finally {
      Object.defineProperty(Intl, 'supportedValuesOf', { value: original, configurable: true })
    }
  })

  it('shows the function error', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Please log in again.'))
    render(<ProfileForm profile={profile} displayName="Sam Lee" onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Please log in again.')
  })
})

describe('BusinessForm', () => {
  it('sends digits only and leaves empty fields out', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<BusinessForm profile={profile} onSave={onSave} />)
    type('Business name', 'Sam Lee Cleaning')
    type('ABN', '51 824 753 556')
    type('Account name', 'S Lee')
    type('BSB', '062-000')
    type('Account number', '1234 5678')
    type('Invoice number prefix', 'SL-')
    fireEvent.click(screen.getByRole('button', { name: 'Save invoice details' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith({
      business: {
        businessName: 'Sam Lee Cleaning',
        abn: '51824753556',
        bank: { accountName: 'S Lee', bsb: '062000', accountNumber: '12345678' },
      },
      invoicePrefix: 'SL-',
    })
    await waitFor(() =>
      expect((screen.getByLabelText('ABN') as HTMLInputElement).value).toBe('51824753556'),
    )
    expect((screen.getByLabelText('BSB') as HTMLInputElement).value).toBe('062000')
  })

  it('starts from the saved details, and clearing a field removes it', async () => {
    const saved = {
      ...profile,
      businessJson: JSON.stringify({ payId: 'sam@example.com', abn: '51824753556' }),
    }
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<BusinessForm profile={saved} onSave={onSave} />)
    expect((screen.getByLabelText('PayID') as HTMLInputElement).value).toBe('sam@example.com')
    type('PayID', '')
    fireEvent.click(screen.getByRole('button', { name: 'Save invoice details' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith({ business: { abn: '51824753556' }, invoicePrefix: 'INV-' })
  })

  it('asks for the whole bank account once any part is filled in', async () => {
    const onSave = vi.fn()
    render(<BusinessForm profile={profile} onSave={onSave} />)
    type('BSB', '06200')
    fireEvent.click(screen.getByRole('button', { name: 'Save invoice details' }))
    expect(await screen.findByText('Expected 6 digits')).toBeTruthy()
    expect(screen.getByText('Required').id).toBe('accountName-error')
    expect(screen.getByText('Expected 1–12 digits').id).toBe('accountNumber-error')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('ignores saved details that are not valid JSON', () => {
    render(<BusinessForm profile={{ ...profile, businessJson: '{oops' }} onSave={vi.fn()} />)
    expect((screen.getByLabelText('ABN') as HTMLInputElement).value).toBe('')
  })
})

describe('HoursCapForm (#53)', () => {
  // Sunday 25 October in UTC, already Monday the 26th in Sydney.
  const NOW = new Date('2026-10-25T13:30:00.000Z')
  const noCap = { ...profile, hoursCapMinutes: null, hoursCapPeriod: null, hoursCapStartsOn: null }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  // Every body the form sends is one PATCH /profile accepts, as sent.
  let sent: unknown[] = []
  afterEach(() => {
    vi.useRealTimers()
    for (const body of sent) expect(updateProfileBodySchema.parse(body)).toEqual(body)
    sent = []
  })

  function renderForm(stored: Partial<Profiles> = {}) {
    const onSave = vi.fn(async (body: unknown) => {
      sent.push(body)
    })
    render(<HoursCapForm profile={{ ...noCap, ...stored } as Profiles} onSave={onSave} />)
    return onSave
  }

  const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save limit' }))

  it('starts at None, with no hours field', () => {
    renderForm()
    expect((screen.getByLabelText('None') as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByLabelText(/^Hours a/)).toBeNull()
  })

  it.each([
    ['40', 2400],
    ['37.5', 2250],
    ['37:30', 2250],
    ['1', 60],
    ['168', 10080],
  ])('sends a week of %s hours as %i minutes', async (hours, minutes) => {
    const onSave = renderForm()
    fireEvent.click(screen.getByLabelText('Per week'))
    type('Hours a week', hours)
    save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith({ hoursCap: { minutes, period: 'week' } })
    expect(await screen.findByText('Saved.')).toBeTruthy()
  })

  it('sends a fortnight from this week’s Monday in the profile’s zone by default', async () => {
    const onSave = renderForm()
    fireEvent.click(screen.getByLabelText('Per fortnight'))
    expect((screen.getByLabelText('First Monday of a fortnight') as HTMLInputElement).value).toBe(
      '2026-10-26',
    )
    type('Hours a fortnight', '336')
    save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith({
      hoursCap: { minutes: 20160, period: 'fortnight', startsOn: '2026-10-26' },
    })
  })

  it('starts from the stored limit, and None sends null', async () => {
    const onSave = renderForm({
      hoursCapMinutes: 4500,
      hoursCapPeriod: 'fortnight',
      hoursCapStartsOn: '2026-10-19',
    })
    expect((screen.getByLabelText('Per fortnight') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Hours a fortnight') as HTMLInputElement).value).toBe('75')
    expect((screen.getByLabelText('First Monday of a fortnight') as HTMLInputElement).value).toBe(
      '2026-10-19',
    )
    fireEvent.click(screen.getByLabelText('None'))
    save()
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ hoursCap: null }))
  })

  it.each([
    ['week', '', 'Required'],
    ['week', 'forty', 'Enter hours like 40, 37.5 or 37:30'],
    ['week', '0.5', 'Enter between 1 and 168 hours'],
    ['week', '168:01', 'Enter between 1 and 168 hours'],
    ['fortnight', '336:01', 'Enter between 1 and 336 hours'],
  ])('refuses a %s of "%s" in words, and sends nothing', async (period, hours, message) => {
    const onSave = renderForm()
    fireEvent.click(screen.getByLabelText(period === 'week' ? 'Per week' : 'Per fortnight'))
    const label = period === 'week' ? 'Hours a week' : 'Hours a fortnight'
    type(label, hours)
    save()
    expect(screen.getByText(message)).toBeTruthy()
    expect(screen.getByLabelText(label).getAttribute('aria-invalid')).toBe('true')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('clears an error once something changes', () => {
    renderForm()
    fireEvent.click(screen.getByLabelText('Per week'))
    type('Hours a week', '200')
    save()
    expect(screen.getByText('Enter between 1 and 168 hours')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Per fortnight'))
    expect(screen.queryByText('Enter between 1 and 168 hours')).toBeNull()
    expect(screen.getByLabelText('Hours a fortnight').getAttribute('aria-invalid')).toBe('false')
  })

  it.each([
    ['2026-10-27', 'Pick a Monday'],
    ['', 'Enter a date'],
  ])('refuses a fortnight starting on "%s"', (startsOn, message) => {
    const onSave = renderForm()
    fireEvent.click(screen.getByLabelText('Per fortnight'))
    type('Hours a fortnight', '76')
    type('First Monday of a fortnight', startsOn)
    save()
    expect(screen.getByText(message)).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('shows the function’s error, and Saved. goes once something changes', async () => {
    const onSave = renderForm()
    onSave.mockRejectedValueOnce(new Error('Something went wrong'))
    fireEvent.click(screen.getByLabelText('Per week'))
    type('Hours a week', '40')
    save()
    expect(await screen.findByText('Something went wrong')).toBeTruthy()
    save()
    expect(await screen.findByText('Saved.')).toBeTruthy()
    type('Hours a week', '41')
    expect(screen.queryByText('Saved.')).toBeNull()
  })
})

describe('EmailSettingsForm (#431)', () => {
  it('ticks every email when none is turned off, and saves the ones unticked', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<EmailSettingsForm profile={{ ...profile, emailOptOuts: null }} onSave={onSave} />)
    for (const name of [
      'Bill due soon',
      'Shift to confirm',
      'A transaction you’re in was changed',
      'Statement ready',
    ]) {
      expect(
        (screen.getByRole('checkbox', { name: new RegExp(name) }) as HTMLInputElement).checked,
      ).toBe(true)
    }
    fireEvent.click(screen.getByRole('checkbox', { name: /Statement ready/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Bill due soon/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save email settings' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    // In the contract's order, whatever order they were unticked in.
    const body = { emailOptOuts: ['billDue', 'statementReady'] }
    expect(onSave).toHaveBeenCalledWith(body)
    expect(updateProfileBodySchema.safeParse(body).success).toBe(true)
    expect((await screen.findByRole('status')).textContent).toBe('Saved.')
  })

  it('starts from the saved settings, and ticking one again turns it back on', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <EmailSettingsForm
        profile={{ ...profile, emailOptOuts: ['shiftToConfirm'] }}
        onSave={onSave}
      />,
    )
    const shift = screen.getByRole('checkbox', { name: /Shift to confirm/ }) as HTMLInputElement
    expect(shift.checked).toBe(false)
    expect(shift.getAttribute('aria-describedby')).toBe('shiftToConfirm-hint')
    fireEvent.click(shift)
    fireEvent.click(screen.getByRole('button', { name: 'Save email settings' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ emailOptOuts: [] }))
  })

  it('turns off the change email too, saved in the contract’s order (#433)', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<EmailSettingsForm profile={{ ...profile, emailOptOuts: null }} onSave={onSave} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /Statement ready/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /A transaction you’re in was changed/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save email settings' }))
    const body = { emailOptOuts: ['transactionChanged', 'statementReady'] }
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(body))
    expect(updateProfileBodySchema.safeParse(body).success).toBe(true)
  })

  it('says drafts still appear under Statements, and shows the function error', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Please log in again.'))
    render(<EmailSettingsForm profile={profile} onSave={onSave} />)
    expect(screen.getByText(/Drafts still appear under Statements/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save email settings' }))
    expect(await screen.findByText('Please log in again.')).toBeTruthy()
    expect(screen.queryByText('Saved.')).toBeNull()
  })
})
