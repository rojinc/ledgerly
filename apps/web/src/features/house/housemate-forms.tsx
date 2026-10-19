import { compareDates, isLocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Members } from '@ledgerly/core/generated/rows'
import {
  type AddMemberBody,
  addMemberBodySchema,
  type UpdateMemberBody,
  updateMemberBodySchema,
} from '@ledgerly/core/schemas/groups'
import { useEffect, useId, useRef, useState } from 'react'
import { type FieldErrors, type FieldValues, type Resolver, useForm } from 'react-hook-form'
import type { z } from 'zod'
import { schemaResolver } from '../../lib/schema-resolver'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { SelectField, TextField } from '../../ui/field'
import { linkHint } from '../groups/link-hint'
import { formatDate } from '../statements/invoice-view'
import {
  type HousemateValues,
  type MemberEditValues,
  ROLE_LABEL,
  toAddHousemateBody,
  toMemberEditBody,
  toMoveBackInBody,
} from './house-values'
import { GroupsError, type useMemberWrites } from './use-house'

type Writes = ReturnType<typeof useMemberWrites>

const ROLES = Object.entries(ROLE_LABEL) as Array<[Members['role'], string]>

/** Today in the house's time zone, for a date field's default. */
function today(group: Groups): string {
  return localToday(group.timezone, new Date())
}

/** True when both are dates and `a` is after `b`; the schema reports a missing date. */
function isAfter(a: string, b: string | null): boolean {
  return isLocalDate(a) && isLocalDate(b) && compareDates(a, b) > 0
}

/**
 * The shared schema's check, in words for people, plus the date order against the stored row,
 * which the schema can't see. The body's fields have the form's names.
 */
function housemateResolver<TValues extends FieldValues, TBody>(
  schema: z.ZodType<TBody>,
  toBody: (values: TValues) => unknown,
  dateOrder: (values: TValues) => Partial<Record<keyof TValues, string>> = () => ({}),
): Resolver<TValues, unknown, TBody> {
  const resolve = schemaResolver<TValues, TBody>(schema, toBody)
  return async (values, context, options) => {
    const result = await resolve(values, context, options)
    const errors: Record<string, { type: string; message: string }> = {}
    for (const [field, error] of Object.entries(result.errors as FieldErrors)) {
      const message =
        field === 'email'
          ? 'Enter an email like sam@example.com'
          : field === 'joinedOn' || field === 'leftOn'
            ? 'Enter a date'
            : (error?.message as string)
      errors[field] = { type: 'validate', message }
    }
    for (const [field, message] of Object.entries(dateOrder(values))) {
      if (message && !errors[field]) errors[field] = { type: 'validate', message }
    }
    if (Object.keys(errors).length === 0) return result
    return { values: {}, errors: errors as FieldErrors<TValues> }
  }
}

/** Puts focus on the form's first field when it opens. */
function useFocusFirst() {
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('input, select')?.focus()
  }, [])
  return form
}

function newHousemate(group: Groups): HousemateValues {
  return { displayName: '', email: '', phone: '', role: 'member', joinedOn: today(group) }
}

/**
 * Add a housemate: admins pick the role, members add people with the default one
 * (permissions.md#roles). The new row is a placeholder whether or not they have an account
 * (D-016), so the page says the same either way.
 */
export function AddHousemate({
  group,
  isAdmin,
  writes,
}: {
  group: Groups
  isAdmin: boolean
  writes: Writes
}) {
  const headingId = useId()
  const [added, setAdded] = useState('')
  const form = useForm<HousemateValues, unknown, AddMemberBody>({
    resolver: housemateResolver<HousemateValues, AddMemberBody>(addMemberBodySchema, (values) =>
      toAddHousemateBody(values, isAdmin),
    ),
    defaultValues: newHousemate(group),
  })
  const { errors, isSubmitting } = form.formState
  const [email, phone] = form.watch(['email', 'phone'])
  const submit = form.handleSubmit(async (body) => {
    setAdded('')
    try {
      const member = await writes.add.mutateAsync(body)
      form.reset(newHousemate(group))
      setAdded(member.displayName)
    } catch (error) {
      form.setError('root', {
        message:
          error instanceof GroupsError && error.code === 'CONFLICT'
            ? 'They’re already in this house.'
            : (error as Error).message,
      })
    }
  })

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="font-medium">
        Add a housemate
      </h2>
      {/* Mounted from the start, so the announcement is read out when it changes. */}
      <p role="status" className="text-sm text-muted-foreground empty:hidden">
        {added && `Added ${added}.`}
      </p>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          // aria-disabled, not disabled, keeps focus on the button; this guard stops a second send.
          if (form.formState.isSubmitting) event.preventDefault()
          else void submit(event)
        }}
      >
        {errors.root && <Alert variant="destructive">{errors.root.message}</Alert>}
        <TextField
          id="add-displayName"
          label="Name"
          hint="What the house calls them."
          error={errors.displayName}
          {...form.register('displayName')}
        />
        <TextField
          id="add-email"
          type="email"
          label="Email (optional)"
          autoCapitalize="none"
          error={errors.email}
          {...form.register('email')}
        />
        <TextField
          id="add-phone"
          type="tel"
          label="Mobile number (optional)"
          error={errors.phone}
          {...form.register('phone')}
        />
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {linkHint(email, phone, { linked: 'this house', seen: 'the house' })}
        </p>
        {isAdmin && (
          <SelectField id="add-role" label="Role" error={errors.role} {...form.register('role')}>
            {ROLES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </SelectField>
        )}
        <TextField
          id="add-joinedOn"
          type="date"
          label="Moved in"
          error={errors.joinedOn}
          {...form.register('joinedOn')}
        />
        <Button type="submit" className="self-start" aria-disabled={isSubmitting}>
          {isSubmitting ? 'Adding…' : 'Add housemate'}
        </Button>
      </form>
    </section>
  )
}

type RowFormProps = { member: Members; writes: Writes; onClose: () => void }

function FormButtons({
  pending,
  label,
  onCancel,
}: {
  pending: boolean
  label: string
  onCancel: () => void
}) {
  return (
    <div className="flex flex-wrap gap-3">
      <Button type="submit" aria-disabled={pending}>
        {pending ? 'Saving…' : label}
      </Button>
      {/* aria-disabled, not disabled: a disabled button loses focus. A save that's sent still
          applies, so Cancel waits for it. */}
      <Button
        type="button"
        variant="outline"
        aria-disabled={pending}
        onClick={() => !pending && onCancel()}
      >
        Cancel
      </Button>
    </div>
  )
}

/**
 * An admin changes someone's name, move-in date or role, sending only what changed. Someone who
 * moved out stays a viewer (permissions.md#leaving-a-group), so their role isn't offered.
 */
export function EditMember({ member, writes, onClose }: RowFormProps) {
  const ref = useFocusFirst()
  const form = useForm<MemberEditValues, unknown, UpdateMemberBody>({
    resolver: housemateResolver<MemberEditValues, UpdateMemberBody>(
      updateMemberBodySchema,
      (values) => toMemberEditBody(values, member),
      (values) => ({
        joinedOn:
          member.leftOn && isAfter(values.joinedOn, member.leftOn)
            ? `Must be on or before they moved out (${formatDate(member.leftOn)})`
            : undefined,
      }),
    ),
    defaultValues: {
      displayName: member.displayName,
      role: member.role,
      joinedOn: member.joinedOn,
    },
  })
  const { errors, isSubmitting } = form.formState
  const id = member.$id
  const submit = form.handleSubmit(async (body) => {
    try {
      if (Object.keys(body).length > 0) {
        await writes.update.mutateAsync({ memberId: id, body })
      }
      onClose()
    } catch (error) {
      form.setError('root', { message: (error as Error).message })
    }
  })

  return (
    <form
      ref={ref}
      noValidate
      className="flex flex-col gap-4 pt-3"
      onSubmit={(event) => {
        // aria-disabled, not disabled, keeps focus on the button; this guard stops a second send.
        if (form.formState.isSubmitting) event.preventDefault()
        else void submit(event)
      }}
    >
      {errors.root && <Alert variant="destructive">{errors.root.message}</Alert>}
      <TextField
        id={`${id}-displayName`}
        label="Name"
        error={errors.displayName}
        {...form.register('displayName')}
      />
      {!member.leftOn && (
        <SelectField id={`${id}-role`} label="Role" error={errors.role} {...form.register('role')}>
          {ROLES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
      )}
      <TextField
        id={`${id}-joinedOn`}
        type="date"
        label="Moved in"
        error={errors.joinedOn}
        {...form.register('joinedOn')}
      />
      <FormButtons pending={isSubmitting} label="Save" onCancel={onClose} />
    </form>
  )
}

/**
 * `PATCH { leftOn }`: they become a viewer, and keep seeing the house so they can settle up
 * (permissions.md#leaving-a-group).
 */
export function MoveOut({ group, member, writes, onClose }: RowFormProps & { group: Groups }) {
  const ref = useFocusFirst()
  const form = useForm<{ leftOn: string }, unknown, UpdateMemberBody>({
    resolver: housemateResolver<{ leftOn: string }, UpdateMemberBody>(
      updateMemberBodySchema,
      (values) => ({ leftOn: values.leftOn }),
      (values) => ({
        leftOn: isAfter(member.joinedOn, values.leftOn)
          ? `Must be on or after they moved in (${formatDate(member.joinedOn)})`
          : undefined,
      }),
    ),
    defaultValues: { leftOn: today(group) },
  })
  const { errors, isSubmitting } = form.formState
  const id = member.$id
  const submit = form.handleSubmit(async (body) => {
    try {
      await writes.update.mutateAsync({ memberId: id, body })
      onClose()
    } catch (error) {
      form.setError('root', { message: (error as Error).message })
    }
  })

  return (
    <form
      ref={ref}
      noValidate
      className="flex flex-col gap-4 pt-3"
      onSubmit={(event) => {
        // aria-disabled, not disabled, keeps focus on the button; this guard stops a second send.
        if (form.formState.isSubmitting) event.preventDefault()
        else void submit(event)
      }}
    >
      {errors.root && <Alert variant="destructive">{errors.root.message}</Alert>}
      <TextField
        id={`${id}-leftOn`}
        type="date"
        label="Moved out"
        hint="They become a viewer. They can still see the house and settle up."
        error={errors.leftOn}
        {...form.register('leftOn')}
      />
      <FormButtons pending={isSubmitting} label="Mark as moved out" onCancel={onClose} />
    </form>
  )
}

/**
 * `PATCH { leftOn: null }` (admins): someone who moved out lives here again. Someone who left on
 * their own can't come back this way, and the function says so (permissions.md#leaving-a-group).
 */
export function MoveBackIn({ member, writes, onClose }: RowFormProps) {
  const ref = useFocusFirst()
  const form = useForm<{ role: Members['role'] }, unknown, UpdateMemberBody>({
    resolver: housemateResolver<{ role: Members['role'] }, UpdateMemberBody>(
      updateMemberBodySchema,
      (values) => toMoveBackInBody(values.role, member),
    ),
    // Moving out made them a viewer.
    defaultValues: { role: 'member' },
  })
  const { errors, isSubmitting } = form.formState
  const id = member.$id
  const submit = form.handleSubmit(async (body) => {
    try {
      await writes.update.mutateAsync({ memberId: id, body })
      onClose()
    } catch (error) {
      form.setError('root', { message: (error as Error).message })
    }
  })

  return (
    <form
      ref={ref}
      noValidate
      className="flex flex-col gap-4 pt-3"
      onSubmit={(event) => {
        // aria-disabled, not disabled, keeps focus on the button; this guard stops a second send.
        if (form.formState.isSubmitting) event.preventDefault()
        else void submit(event)
      }}
    >
      {errors.root && <Alert variant="destructive">{errors.root.message}</Alert>}
      <SelectField
        id={`${id}-backInRole`}
        label="Role"
        hint="Their move-out date is cleared, and they live here again. They count as living here since they moved in, including while they were away."
        error={errors.role}
        {...form.register('role')}
      >
        {ROLES.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </SelectField>
      <FormButtons pending={isSubmitting} label="Mark as moved back in" onCancel={onClose} />
    </form>
  )
}
