import {
  type CreateGroupBody,
  type CreateGroupResult,
  createGroupBodySchema,
} from '@ledgerly/core/schemas/groups'
import { useQueryClient } from '@tanstack/react-query'
import { ID } from 'appwrite'
import { useState } from 'react'
import { type FieldErrors, get, type Resolver, useForm } from 'react-hook-form'
import { useNavigate } from 'react-router'
import { callFunction } from '../../lib/api'
import { queryKeys } from '../../lib/query-keys'
import { schemaResolver } from '../../lib/schema-resolver'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { TextField } from '../../ui/field'
import { useCurrentUser } from '../auth/use-current-user'
import { linkHint } from '../groups/link-hint'
import { useProfile } from '../profile/use-profile'
import { type PairValues, toPairBody } from './pair-values'

// The body's fields, as the form names them.
const ERROR_FIELD: Record<string, keyof PairValues> = {
  name: 'name',
  'counterpart.displayName': 'name',
  'counterpart.email': 'email',
  'counterpart.phone': 'phone',
  currency: 'currency',
}

/** Schema errors on the fields the form shows. */
function pairResolver(id: string): Resolver<PairValues, unknown, CreateGroupBody> {
  const resolve = schemaResolver<PairValues, CreateGroupBody>(createGroupBodySchema, (values) =>
    toPairBody(values, id),
  )
  return async (values, context, options) => {
    const result = await resolve(values, context, options)
    const found = result.errors as FieldErrors
    if (Object.keys(found).length === 0) return result
    const errors: Record<string, { type: string; message: string }> = {}
    for (const [path, field] of Object.entries(ERROR_FIELD)) {
      const message = get(found, path)?.message as string | undefined
      if (message && !errors[field]) {
        errors[field] =
          field === 'email'
            ? { type: 'validate', message: 'Enter an email like sam@example.com' }
            : field === 'currency'
              ? { type: 'validate', message: 'Enter a 3-letter code like AUD' }
              : { type: 'validate', message }
      }
    }
    if (Object.keys(errors).length === 0) {
      errors.root = { type: 'validate', message: 'Something in the form is not valid.' }
    }
    return { values: {}, errors: errors as FieldErrors<PairValues> }
  }
}

/** `/people/new`: lend & borrow with one person, registered or not (flow 9). */
export function NewPairPage() {
  const userId = useCurrentUser().data?.$id ?? ''
  const profile = useProfile(userId)
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">New lend & borrow</h1>
      {profile.data ? (
        <PairForm currency={profile.data.currency} />
      ) : profile.isError ? (
        <p role="alert" className="text-destructive">
          We couldn’t load your profile. Reload the page to try again.
        </p>
      ) : (
        <p role="status" className="text-muted-foreground">
          Loading…
        </p>
      )}
    </div>
  )
}

function PairForm({ currency }: { currency: string }) {
  const userId = useCurrentUser().data?.$id ?? ''
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  // One ID per visit, so retrying after an error can't create the group twice.
  const [id] = useState(() => ID.unique())
  const form = useForm<PairValues, unknown, CreateGroupBody>({
    resolver: pairResolver(id),
    defaultValues: { name: '', email: '', phone: '', currency },
  })
  const { errors, isSubmitting } = form.formState
  const [email, phone] = form.watch(['email', 'phone'])

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={form.handleSubmit(async (body) => {
        const result = await callFunction<CreateGroupResult>('groups', 'POST', '/groups', body)
        if (!result.ok) {
          // Either a clash, or an earlier try with this ID went through and its answer was lost.
          if (result.error.code === 'CONFLICT') {
            await queryClient.invalidateQueries({ queryKey: queryKeys.groups(userId) })
          }
          form.setError('root', {
            message:
              result.error.code === 'CONFLICT'
                ? 'This may already have been saved from your last try. Check People before adding it again.'
                : result.error.message,
          })
          return
        }
        const { group } = result.data
        queryClient.setQueryData(queryKeys.group(group.$id), group)
        await queryClient.invalidateQueries({ queryKey: queryKeys.groups(userId) })
        navigate(`/people/${group.$id}`)
      })}
    >
      {errors.root && <Alert variant="destructive">{errors.root.message}</Alert>}
      <TextField id="name" label="Name" error={errors.name} {...form.register('name')} />
      <TextField
        id="email"
        type="email"
        label="Email (optional)"
        error={errors.email}
        {...form.register('email')}
      />
      <TextField
        id="phone"
        type="tel"
        label="Mobile number (optional)"
        error={errors.phone}
        {...form.register('phone')}
      />
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {linkHint(email, phone, { linked: 'this', seen: 'what you’ve recorded together' })}
      </p>
      <TextField
        id="currency"
        label="Currency"
        hint="It can’t change once something is recorded."
        error={errors.currency}
        autoCapitalize="characters"
        maxLength={3}
        {...form.register('currency')}
      />
      <Button type="submit" className="self-start" disabled={isSubmitting}>
        {isSubmitting ? 'Saving…' : 'Create'}
      </Button>
    </form>
  )
}
