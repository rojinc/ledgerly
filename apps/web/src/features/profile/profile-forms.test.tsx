import type { Profiles } from '@ledgerly/core/generated/rows'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BusinessForm } from './business-form'
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
