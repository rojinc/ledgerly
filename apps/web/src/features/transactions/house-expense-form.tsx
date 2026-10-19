import { CATEGORIES } from '@ledgerly/core/constants/categories'
import { MAX_PEOPLE_PER_TRANSACTION } from '@ledgerly/core/constants/limits'
import { isLocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Members, Transactions } from '@ledgerly/core/generated/rows'
import { type TransactionInput, transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import { ID } from 'appwrite'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { type FieldError, type FieldErrors, get, type Resolver, useForm } from 'react-hook-form'
import { useNavigate } from 'react-router'
import { schemaResolver } from '../../lib/schema-resolver'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { SelectField, TextField } from '../../ui/field'
import {
  defaultTicks,
  type HouseExpenseValues,
  previewShares,
  type SplitProblems,
  splitProblems,
  toHouseExpenseBody,
} from './house-expense'
import { amountError, amountExample } from './presets'
import {
  PaidAmountsField,
  PaidByField,
  PartField,
  SharePreview,
  SplitBetweenField,
  SplitModeField,
} from './split-fields'
import { LedgerError, useCreateTransaction } from './use-transactions'

type ToBody = (values: HouseExpenseValues) => ReturnType<typeof toHouseExpenseBody>
type Problems = (values: HouseExpenseValues, body: ReturnType<ToBody>) => SplitProblems
type Preview = (body: ReturnType<ToBody>) => ReturnType<typeof previewShares>

// The body's fields, as the form names them.
const ERROR_FIELD: Record<string, keyof HouseExpenseValues> = {
  totalCents: 'amount',
  date: 'date',
  description: 'description',
  category: 'category',
  note: 'note',
  payers: 'paidBy',
  split: 'splitBetween',
}

/** No problem with the payers' amounts or the split's parts. */
function noProblems(problems: SplitProblems): boolean {
  return (
    Object.keys(problems.paid).length === 0 &&
    Object.keys(problems.parts).length === 0 &&
    !problems.paidTotal &&
    !problems.partsTotal
  )
}

/** Everyone the expense names: whoever paid, and whoever it's split between. */
function peopleIn(body: ReturnType<ToBody>): number {
  const payers = (body.payers ?? []).map((payer) => payer.personId)
  const split = body.split
  const parts =
    split?.mode === 'exact'
      ? split.amounts.map((entry) => entry.personId)
      : split?.mode === 'percent'
        ? split.percents.map((entry) => entry.personId)
        : split?.mode === 'weights'
          ? split.weights.map((entry) => entry.personId)
          : split?.mode === 'equal'
            ? split.personIds
            : []
  return new Set([...payers, ...parts]).size
}

/** Schema errors on the fields the form shows, in plain words, then the ledger's own rules. */
function houseExpenseResolver(
  toBody: ToBody,
  problemsOf: Problems,
  preview: Preview,
  currency: string,
): Resolver<HouseExpenseValues, unknown, TransactionInput> {
  const resolve = schemaResolver<HouseExpenseValues, TransactionInput>(
    transactionInputSchema,
    toBody,
  )
  return async (values, context, options) => {
    const result = await resolve(values, context, options)
    const found = result.errors as FieldErrors
    // Per-person errors sit under `paid.<id>` and `parts.<id>`; the payers' total under
    // `paidTotal`, which the form shows under their amounts.
    const errors: Record<string, unknown> = {}
    const add = (field: keyof HouseExpenseValues | 'paidTotal', message: string) => {
      if (!errors[field]) errors[field] = { type: 'validate', message }
    }
    const body = toBody(values)
    const amount = amountError(
      values.amount,
      body.totalCents,
      Boolean(get(found, 'totalCents')),
      currency,
    )
    if (amount) add('amount', amount)
    const problems = problemsOf(values, body)
    const byPerson = (by: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(by).map(([id, message]) => [id, { type: 'validate', message }]),
      )
    if (Object.keys(problems.paid).length > 0) errors.paid = byPerson(problems.paid)
    if (problems.paidTotal) add('paidTotal', problems.paidTotal)
    if (Object.keys(problems.parts).length > 0) errors.parts = byPerson(problems.parts)
    if (values.splitBetween.length === 0) {
      add('splitBetween', 'Tick at least one person to split it between.')
    } else if (problems.partsTotal) {
      add('splitBetween', problems.partsTotal)
    } else if (peopleIn(body) > MAX_PEOPLE_PER_TRANSACTION) {
      add('splitBetween', `At most ${MAX_PEOPLE_PER_TRANSACTION} people can be in one expense.`)
    }
    for (const [path, field] of Object.entries(ERROR_FIELD)) {
      const message = get(found, path)?.message as string | undefined
      // Several payers: a schema error on them goes under their amounts.
      if (message) add(field === 'paidBy' && values.severalPaid ? 'paidTotal' : field, message)
    }
    if (Object.keys(errors).length > 0) {
      return { values: {}, errors: errors as FieldErrors<HouseExpenseValues> }
    }
    if (Object.keys(found).length > 0) {
      return {
        values: {},
        errors: { root: { type: 'validate', message: 'Something in the form is not valid.' } },
      }
    }
    // The ledger's rules, worked out here as the function will: its refusal, before sending.
    const shares = preview(body)
    if ('error' in shares) {
      return { values: {}, errors: { root: { type: 'validate', message: shares.error } } }
    }
    return result
  }
}

/** Changing a posted house expense with the form it was made with (#202), as #184 does. */
export type HouseExpenseEdit = {
  row: Transactions
  values: HouseExpenseValues
  /** The form's heading, which gets focus when it opens (`useSwap`). */
  heading: RefObject<HTMLHeadingElement | null>
  /** `ledger PATCH /transactions/{id}`, kept by the page: a refusal can outlast the form. */
  save: (body: TransactionInput) => Promise<unknown>
  /** Called after a save and on Cancel. */
  onDone: () => void
}

/**
 * A house expense: who paid, and how it's split between whom (#180, #181); a new one, or a
 * posted one being changed (#202).
 */
export function HouseExpenseForm({
  group,
  members,
  personId,
  edit,
}: {
  group: Groups
  members: Members[]
  personId: string
  edit?: HouseExpenseEdit
}) {
  const navigate = useNavigate()
  const create = useCreateTransaction()
  // One ID per visit, so a retry after an error can't add it twice. A change keeps the row's.
  const [id] = useState(() => edit?.row.$id ?? ID.unique())
  const [today] = useState(() => localToday(group.timezone, new Date()))
  const sorted = [...members].sort((a, b) => a.displayName.localeCompare(b.displayName))
  const toBody: ToBody = (values) =>
    toHouseExpenseBody(values, { id, groupId: group.$id }, group.currency)
  const preview: Preview = (body) => previewShares(body, group, members, personId)
  const problemsOf: Problems = (values, body) =>
    splitProblems(values, group.currency, body.totalCents ?? Number.NaN)
  const form = useForm<HouseExpenseValues, unknown, TransactionInput>({
    resolver: houseExpenseResolver(toBody, problemsOf, preview, group.currency),
    defaultValues: edit?.values ?? {
      amount: '',
      date: today,
      description: '',
      category: '',
      paidBy: personId,
      severalPaid: false,
      paid: {},
      splitMode: 'equal',
      splitBetween: defaultTicks(members, today),
      parts: {},
      note: '',
    },
  })
  const { errors, isSubmitting } = form.formState
  const values = form.watch()

  // The ticks follow the date until one is changed by hand (#180 decision 5). A change starts
  // from the stored people, as if ticked by hand, so a new date never changes who shares it
  // (#202 decision 2).
  const handTicked = useRef(edit !== undefined)
  const { date } = values
  useEffect(() => {
    if (handTicked.current) return
    form.setValue('splitBetween', defaultTicks(members, date), {
      // After a refused submit, an error on the ticks goes once the date ticks someone.
      shouldValidate: form.formState.isSubmitted,
    })
  }, [date, members, form])
  const split = form.register('splitBetween')
  // A refusal shown above the form goes once the form is changed: it may no longer hold. After
  // a refused Add, the totals are checked again as the amounts change, so a fixed sum's message
  // goes too. A new split mode starts with empty parts: 60.00 isn't a percentage.
  useEffect(() => {
    const watching = form.watch((_values, { name }) => {
      if (form.formState.errors.root) form.clearErrors('root')
      if (name === 'splitMode') {
        for (const id of Object.keys(form.getValues('parts'))) form.setValue(`parts.${id}`, '')
      }
      if (
        form.formState.isSubmitted &&
        name &&
        /^(amount|paid\.|parts|splitMode|severalPaid)/.test(name)
      ) {
        void form.trigger(['paidTotal' as never, 'splitBetween'])
      }
    })
    return () => watching.unsubscribe()
  }, [form])

  // Worked out only once the form's own checks would pass, so a rule isn't said twice.
  const body = toBody(values)
  const problems = problemsOf(values, body)
  const shares =
    Number.isInteger(body.totalCents) &&
    (body.totalCents ?? 0) > 0 &&
    values.splitBetween.length > 0 &&
    noProblems(problems) &&
    peopleIn(body) <= MAX_PEOPLE_PER_TRANSACTION &&
    isLocalDate(values.date)
      ? preview(body)
      : undefined
  const { splitMode } = values
  const ticked = new Set(values.splitBetween)
  const message = (path: string) => get(errors, path)?.message as string | undefined

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        // Add stays focusable while saving (aria-disabled), so a second submit is ignored here.
        if (isSubmitting) {
          event.preventDefault()
          return
        }
        void form.handleSubmit(
          async (input) => {
            try {
              if (edit) {
                // Saving it unchanged is fine: the function answers with the row as it is.
                await edit.save(input)
                edit.onDone()
                return
              }
              const view = await create.mutateAsync(input)
              navigate(`/transactions/${view.transaction.$id}`, { replace: true })
            } catch (error) {
              // The same ID again, with different content: an earlier try may have been saved
              // although its answer was lost. Say so, rather than inviting a duplicate. On a
              // change, CONFLICT is another write that got there first, and the function says so.
              const message =
                !edit && error instanceof LedgerError && error.code === 'CONFLICT'
                  ? 'This may already have been saved from your last try. Check the calendar before adding it again.'
                  : (error as Error).message
              form.setError('root', { message })
            }
          },
          (refused) => {
            // Only the payers' total is wrong: it has no field of its own to focus, so the first
            // amount gets it (the message is an alert).
            if (Object.keys(refused).length === 1 && refused['paidTotal' as never]) {
              const first = sorted[0]
              if (first) form.setFocus(`paid.${first.personId}`)
            }
          },
        )(event)
      }}
    >
      {edit && (
        <h2 id="edit-heading" ref={edit.heading} tabIndex={-1} className="font-medium outline-none">
          Change this expense
        </h2>
      )}
      {errors.root && <Alert variant="destructive">{errors.root.message}</Alert>}
      <TextField
        id="amount"
        inputMode="decimal"
        label={`Amount (${group.currency})`}
        hint={`For example ${amountExample(group.currency)}.`}
        error={errors.amount}
        {...form.register('amount')}
      />
      <TextField
        id="date"
        type="date"
        label="Date"
        error={errors.date}
        {...form.register('date')}
      />
      <TextField
        id="description"
        label="Description"
        hint="For example “Groceries”."
        error={errors.description}
        {...form.register('description')}
      />
      <SelectField
        id="category"
        label="Category"
        error={errors.category}
        {...form.register('category')}
      >
        <option value="">None</option>
        {CATEGORIES.map((category) => (
          <option key={category} value={category}>
            {category[0]?.toUpperCase()}
            {category.slice(1)}
          </option>
        ))}
      </SelectField>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" {...form.register('severalPaid')} />
        Several people paid
      </label>
      {values.severalPaid ? (
        <PaidAmountsField
          members={sorted}
          currency={group.currency}
          // Person IDs have no dots (data-model.md: 20 of a-z0-9), so they're safe in a path.
          field={(id) => form.register(`paid.${id}`)}
          errors={Object.fromEntries(
            sorted.flatMap((member) => {
              const error = message(`paid.${member.personId}`)
              return error ? [[member.personId, error]] : []
            }),
          )}
          total={message('paidTotal')}
        />
      ) : (
        <PaidByField members={sorted} field={form.register('paidBy')} error={errors.paidBy} />
      )}
      <SplitModeField field={form.register('splitMode')} />
      <SplitBetweenField
        members={sorted}
        date={values.date}
        legend={splitMode === 'equal' ? 'Split equally between' : 'Split between'}
        part={(member) =>
          splitMode !== 'equal' &&
          ticked.has(member.personId) && (
            <PartField
              member={member}
              mode={splitMode}
              currency={group.currency}
              field={form.register(`parts.${member.personId}`)}
              error={message(`parts.${member.personId}`)}
            />
          )
        }
        field={{
          ...split,
          onChange: (event) => {
            handTicked.current = true
            return split.onChange(event)
          },
        }}
        // Set whole by the resolver, never per checkbox.
        error={errors.splitBetween as FieldError | undefined}
      />
      <SharePreview
        // A refusal already shown above the form, after Add, isn't repeated here.
        preview={
          shares && 'error' in shares && shares.error === errors.root?.message ? undefined : shares
        }
        members={members}
        currency={group.currency}
      />
      <TextField id="note" label="Note (optional)" error={errors.note} {...form.register('note')} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" aria-disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : edit ? 'Save' : 'Add'}
        </Button>
        {edit && (
          // Not while saving: the save would still land, after the form had gone.
          <Button
            type="button"
            variant="outline"
            aria-disabled={isSubmitting}
            onClick={() => {
              if (!form.formState.isSubmitting) edit.onDone()
            }}
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}
