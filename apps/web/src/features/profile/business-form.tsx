import type { Profiles } from '@ledgerly/core/generated/rows'
import {
  type BusinessDetails,
  type UpdateProfileBody,
  updateProfileBodySchema,
} from '@ledgerly/core/schemas/identity'
import { useForm } from 'react-hook-form'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Field, TextField } from './field'
import { schemaResolver } from './schema-resolver'

const TEXT_KEYS = [
  'businessName',
  'abn',
  'address',
  'email',
  'phone',
  'payId',
  'invoiceNotes',
] as const

type TextKey = (typeof TEXT_KEYS)[number]

export type BusinessValues = {
  business: Record<TextKey, string> & {
    bank: { accountName: string; bsb: string; accountNumber: string }
  }
  invoicePrefix: string
}

/** Empty fields are left out, so clearing a field removes it from invoices. */
export function toBusinessBody({ business, invoicePrefix }: BusinessValues): UpdateProfileBody {
  const details: Record<string, unknown> = {}
  for (const key of TEXT_KEYS) {
    if (business[key].trim()) details[key] = business[key]
  }
  const { accountName, bsb, accountNumber } = business.bank
  if (accountName.trim() || bsb.trim() || accountNumber.trim()) {
    details.bank = { accountName, bsb, accountNumber }
  }
  return { business: details as BusinessDetails, invoicePrefix }
}

function parseBusiness(json: string | null): BusinessDetails {
  try {
    return json ? (JSON.parse(json) as BusinessDetails) : {}
  } catch {
    return {}
  }
}

function toValues(profile: Profiles): BusinessValues {
  const saved = parseBusiness(profile.businessJson)
  const business = Object.fromEntries(TEXT_KEYS.map((key) => [key, saved[key] ?? '']))
  return {
    business: {
      ...(business as Record<TextKey, string>),
      bank: {
        accountName: saved.bank?.accountName ?? '',
        bsb: saved.bank?.bsb ?? '',
        accountNumber: saved.bank?.accountNumber ?? '',
      },
    },
    invoicePrefix: profile.invoicePrefix,
  }
}

type Props = {
  profile: Profiles
  onSave: (body: UpdateProfileBody) => Promise<unknown>
}

export function BusinessForm({ profile, onSave }: Props) {
  const form = useForm<BusinessValues, unknown, UpdateProfileBody>({
    resolver: schemaResolver(updateProfileBodySchema, toBusinessBody),
    defaultValues: toValues(profile),
  })
  const { errors, isDirty, isSubmitting, isSubmitSuccessful } = form.formState
  const business = errors.business

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(async (body) => {
        try {
          await onSave(body)
          form.reset(form.getValues())
        } catch (error) {
          form.setError('root', { message: (error as Error).message })
        }
      })}
      className="flex flex-col gap-4"
      aria-labelledby="business-heading"
    >
      <div>
        <h2 id="business-heading" className="text-lg font-semibold">
          Invoice details
        </h2>
        <p className="text-sm text-muted-foreground">Printed on the invoices you send.</p>
      </div>
      {errors.root && <Alert variant="destructive">{errors.root.message}</Alert>}
      <TextField
        id="businessName"
        label="Business name"
        autoComplete="organization"
        error={business?.businessName}
        {...form.register('business.businessName')}
      />
      <TextField
        id="abn"
        label="ABN"
        inputMode="numeric"
        hint="11 digits. Spaces are fine."
        error={business?.abn}
        {...form.register('business.abn')}
      />
      <Field id="address" label="Address" error={business?.address}>
        {(aria) => (
          <textarea
            rows={3}
            autoComplete="street-address"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
            {...form.register('business.address')}
            {...aria}
          />
        )}
      </Field>
      <TextField
        id="businessEmail"
        label="Email on invoices"
        type="email"
        autoComplete="email"
        error={business?.email}
        {...form.register('business.email')}
      />
      <TextField
        id="businessPhone"
        label="Phone on invoices"
        type="tel"
        autoComplete="tel"
        error={business?.phone}
        {...form.register('business.phone')}
      />
      <fieldset className="flex flex-col gap-4 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium">Bank account</legend>
        <TextField
          id="accountName"
          label="Account name"
          error={business?.bank?.accountName}
          {...form.register('business.bank.accountName')}
        />
        <TextField
          id="bsb"
          label="BSB"
          inputMode="numeric"
          hint="6 digits."
          error={business?.bank?.bsb}
          {...form.register('business.bank.bsb')}
        />
        <TextField
          id="accountNumber"
          label="Account number"
          inputMode="numeric"
          error={business?.bank?.accountNumber}
          {...form.register('business.bank.accountNumber')}
        />
      </fieldset>
      <TextField
        id="payId"
        label="PayID"
        error={business?.payId}
        {...form.register('business.payId')}
      />
      <TextField
        id="invoicePrefix"
        label="Invoice number prefix"
        hint="For example INV- gives INV-0001."
        maxLength={16}
        error={errors.invoicePrefix}
        {...form.register('invoicePrefix')}
      />
      <Field
        id="invoiceNotes"
        label="Notes at the bottom of invoices"
        error={business?.invoiceNotes}
      >
        {(aria) => (
          <textarea
            rows={3}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
            {...form.register('business.invoiceNotes')}
            {...aria}
          />
        )}
      </Field>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Saving…' : 'Save invoice details'}
      </Button>
      {isSubmitSuccessful && !isDirty && !errors.root && <Alert>Saved.</Alert>}
    </form>
  )
}
