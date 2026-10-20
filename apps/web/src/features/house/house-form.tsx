import {
  type CreateGroupBody,
  createGroupBodySchema,
  type UpdateGroupBody,
  updateGroupBodySchema,
} from '@ledgerly/core/schemas/groups'
import type { ComponentProps } from 'react'
import { useForm } from 'react-hook-form'
import { schemaResolver } from '../../lib/schema-resolver'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { SelectField, TextField } from '../../ui/field'
import { PlaceFields } from '../profile/place-fields'
import {
  type HouseValues,
  toHouseFields,
  toHouseSettingsBody,
  toNewHouseBody,
} from './house-values'

type Props = {
  defaultValues: HouseValues
} & (
  | { mode: 'create'; id: string; onSave: (body: CreateGroupBody) => Promise<unknown> }
  | {
      mode: 'settings'
      /** The house as it's stored now, for what this form didn't change. */
      stored: HouseValues
      /** Resolves to the values of the house as stored. */
      onSave: (body: UpdateGroupBody) => Promise<HouseValues>
    }
)

function Checkbox({
  id,
  label,
  ...props
}: ComponentProps<'input'> & { id: string; label: string }) {
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" className="mt-0.5 size-5 shrink-0 accent-primary" {...props} />
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
    </div>
  )
}

/** A new house, or a house's settings (admins). */
export function HouseForm(props: Props) {
  const form = useForm<HouseValues, unknown, CreateGroupBody | UpdateGroupBody>({
    resolver:
      props.mode === 'create'
        ? schemaResolver<HouseValues, CreateGroupBody | UpdateGroupBody>(
            createGroupBodySchema,
            (values) => toNewHouseBody(values, props.id),
          )
        : schemaResolver<HouseValues, CreateGroupBody | UpdateGroupBody>(
            updateGroupBodySchema,
            toHouseFields,
          ),
    defaultValues: props.defaultValues,
  })
  const { errors, isDirty, isSubmitting, isSubmitSuccessful } = form.formState
  const submit = form.handleSubmit(async (body) => {
    try {
      if (props.mode === 'create') {
        await props.onSave(body as CreateGroupBody)
        return
      }
      const changes = toHouseSettingsBody(
        form.getValues(),
        form.formState.dirtyFields,
        props.stored,
      )
      // Show what was stored (the trimmed name), not what was typed.
      form.reset(Object.keys(changes).length > 0 ? await props.onSave(changes) : props.stored)
    } catch (error) {
      form.setError('root', { message: (error as Error).message })
    }
  })

  return (
    <form
      noValidate
      onSubmit={(event) => {
        // aria-disabled, not disabled, keeps focus on the button; this guard stops a second send.
        if (form.formState.isSubmitting) event.preventDefault()
        else void submit(event)
      }}
      className="flex flex-col gap-4"
    >
      {errors.root && <Alert variant="destructive">{errors.root.message}</Alert>}
      <TextField id="name" label="House name" error={errors.name} {...form.register('name')} />
      <SelectField
        id="defaultBillSplit"
        label="Split bills"
        hint="What a new bill starts with. Each bill can still be split another way."
        {...form.register('defaultBillSplit')}
      >
        <option value="days">By days each person lived here</option>
        <option value="equal">Equally</option>
      </SelectField>
      <Checkbox
        id="monthlyDivide"
        label="Close each month with a divide"
        {...form.register('monthlyDivide')}
      />
      <Checkbox
        id="autoFinalize"
        label="Finalize the divide automatically when the month ends"
        {...form.register('autoFinalize')}
      />
      <PlaceFields
        register={form.register}
        errors={errors}
        zone={props.defaultValues.timezone}
        group={props.mode === 'create' ? 'new' : 'saved'}
      />
      <Button type="submit" className="self-start" aria-disabled={isSubmitting}>
        {isSubmitting ? 'Saving…' : props.mode === 'create' ? 'Create house' : 'Save'}
      </Button>
      {props.mode === 'settings' && isSubmitSuccessful && !isDirty && !errors.root && (
        <Alert>Saved.</Alert>
      )}
    </form>
  )
}
