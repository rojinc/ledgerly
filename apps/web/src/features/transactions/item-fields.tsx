import { CATEGORIES } from '@ledgerly/core/constants/categories'
import { MAX_ITEMS_PER_TRANSACTION } from '@ledgerly/core/constants/limits'
import type { Members } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import type { TransactionInput } from '@ledgerly/core/schemas/ledger'
import { useRef } from 'react'
import { type UseFormReturn, useFieldArray } from 'react-hook-form'
import { Button } from '../../ui/button'
import { SelectField, TextField } from '../../ui/field'
import { type HouseExpenseValues, NEW_ITEM } from './house-expense'
import { GroupError } from './split-fields'

type Member = Pick<Members, 'personId' | 'displayName'>

/** A fresh item: its own lists, never shared with another item. */
const newItem = () => ({ ...NEW_ITEM, excluded: [], shares: {} })

/**
 * A receipt's items (#42): each with its name, amount, category and who it's for, split equally
 * or by shares between the people sharing the receipt. `total` is their sum in cents, or NaN
 * until every amount reads; `message(path)` is the error at a form path.
 */
export function ItemFields({
  form,
  members,
  currency,
  total,
  message,
}: {
  form: UseFormReturn<HouseExpenseValues, unknown, TransactionInput>
  /** Everyone sharing the receipt, in the order shown. */
  members: readonly Member[]
  currency: string
  total: number
  message: (path: string) => string | undefined
}) {
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'items' })
  const addButton = useRef<HTMLButtonElement>(null)
  const full = fields.length >= MAX_ITEMS_PER_TRANSACTION
  const totalError = message('itemsTotal')

  return (
    <section aria-labelledby="items-heading" className="flex flex-col gap-4">
      <h2 id="items-heading" className="text-sm font-medium">
        Items
      </h2>
      {fields.map((field, index) => (
        <Item
          key={field.id}
          form={form}
          index={index}
          members={members}
          currency={currency}
          message={message}
          onRemove={() => {
            remove(index)
            // Its button goes with it: Add item is always there to take focus.
            addButton.current?.focus()
          }}
        />
      ))}
      <div className="flex flex-col gap-2">
        <Button
          ref={addButton}
          type="button"
          variant="outline"
          className="self-start"
          aria-disabled={full}
          aria-describedby={full ? 'items-full' : undefined}
          onClick={() => {
            if (!full) append(newItem(), { focusName: `items.${fields.length}.name` })
          }}
        >
          Add item
        </Button>
        {full && (
          <p id="items-full" className="text-sm text-muted-foreground">
            A receipt can have at most {MAX_ITEMS_PER_TRANSACTION} items.
          </p>
        )}
      </div>
      <p className="text-sm">
        Total: {Number.isInteger(total) ? formatMoney(total, currency) : '–'}
      </p>
      <GroupError id="itemsTotal-error" message={totalError} />
    </section>
  )
}

/** One item, numbered from 1 in every label. */
function Item({
  form,
  index,
  members,
  currency,
  message,
  onRemove,
}: {
  form: UseFormReturn<HouseExpenseValues, unknown, TransactionInput>
  index: number
  members: readonly Member[]
  currency: string
  message: (path: string) => string | undefined
  onRemove: () => void
}) {
  const number = index + 1
  const path = `items.${index}` as const
  const error = (field: string) => {
    const found = message(`${path}.${field}`)
    return found ? { type: 'validate', message: found } : undefined
  }
  const item = form.watch(path)
  const excluded = new Set(item.excluded)
  const people = message(`${path}.people`)
  const peopleError = `item-${index}-people-error`

  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
      <legend className="px-1 text-sm font-medium">Item {number}</legend>
      <TextField
        id={`item-${index}-name`}
        label={`Item ${number} name`}
        error={error('name')}
        {...form.register(`${path}.name`)}
      />
      <TextField
        id={`item-${index}-amount`}
        inputMode="decimal"
        label={`Item ${number} amount (${currency})`}
        error={error('amount')}
        {...form.register(`${path}.amount`)}
      />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" {...form.register(`${path}.discount`)} />
        Item {number} is a discount
      </label>
      <SelectField
        id={`item-${index}-category`}
        label={`Item ${number} category`}
        {...form.register(`${path}.category`)}
      >
        <option value="">None</option>
        {CATEGORIES.map((category) => (
          <option key={category} value={category}>
            {category[0]?.toUpperCase()}
            {category.slice(1)}
          </option>
        ))}
      </SelectField>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">How to split item {number}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" value="equal" {...form.register(`${path}.mode`)} />
            Equally
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" value="weights" {...form.register(`${path}.mode`)} />
            By shares
          </label>
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2" aria-describedby={people ? peopleError : undefined}>
        <legend className="mb-1 text-sm font-medium">Who item {number} is for</legend>
        {members.length === 0 && (
          <p className="text-sm text-muted-foreground">Tick who’s sharing the receipt first.</p>
        )}
        {members.map((member) => {
          const ticked = !excluded.has(member.personId)
          return (
            <div key={member.personId} className="flex flex-col gap-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={ticked}
                  aria-invalid={Boolean(people)}
                  onChange={(event) => {
                    const others = item.excluded.filter((id) => id !== member.personId)
                    form.setValue(
                      `${path}.excluded`,
                      event.target.checked ? others : [...others, member.personId],
                      { shouldDirty: true },
                    )
                  }}
                />
                <span className="min-w-0 break-words">{member.displayName}</span>
              </label>
              {ticked && item.mode === 'weights' && (
                <div className="pl-6">
                  <TextField
                    id={`item-${index}-shares-${member.personId}`}
                    inputMode="numeric"
                    label={`${member.displayName}’s shares of item ${number}`}
                    error={error(`shares.${member.personId}`)}
                    // Person IDs have no dots (data-model.md), so they're safe in a path.
                    {...form.register(`${path}.shares.${member.personId}`)}
                  />
                </div>
              )}
            </div>
          )
        })}
        <GroupError id={peopleError} message={people} />
      </fieldset>
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={onRemove}>
        Remove item {number}
      </Button>
    </fieldset>
  )
}
