import { MAX_HOURS_CAP_MINUTES, MIN_HOURS_CAP_MINUTES } from '@ledgerly/core/constants/limits'
import { capPeriod } from '@ledgerly/core/dates/hours-cap'
import { isLocalDate, type LocalDate, weekdayOf } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Profiles } from '@ledgerly/core/generated/rows'
import type { HoursCap, UpdateProfileBody } from '@ledgerly/core/schemas/identity'
import { type FormEvent, useState } from 'react'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { TextField } from '../../ui/field'
import { hoursText, parseHours } from '../shifts/shift-values'
import { hoursCapOf } from './hours-cap-values'

type Period = 'none' | HoursCap['period']

const PERIODS = [
  ['none', 'None'],
  ['week', 'Per week'],
  ['fortnight', 'Per fortnight'],
] as const

type Props = {
  profile: Profiles
  onSave: (body: UpdateProfileBody) => Promise<unknown>
}

/**
 * The user's own work-hours limit (#53, F-82): none, per week (Monday to Sunday) or per
 * fortnight from a Monday they pick. Today, Home and the shift form then warn at or over it.
 */
export function HoursCapForm({ profile, onSave }: Props) {
  const stored = hoursCapOf(profile)
  // This week's Monday in the profile's time zone: a new fortnight's default first day.
  const monday = capPeriod({ period: 'week' }, localToday(profile.timezone, new Date())).start
  const [period, setPeriod] = useState<Period>(stored?.period ?? 'none')
  const [hours, setHours] = useState(stored ? hoursText(stored.minutes) : '')
  const [startsOn, setStartsOn] = useState<string>(stored?.startsOn ?? monday)
  const [errors, setErrors] = useState<{ hours?: string; startsOn?: string }>({})
  const [failed, setFailed] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  // Any change: the last save's message, and the last check's errors, no longer apply.
  const changed = (set: () => void) => {
    set()
    setSaved(false)
    setErrors({})
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    let hoursCap: HoursCap | null = null
    const found: typeof errors = {}
    if (period !== 'none') {
      const minutes = parseHours(hours)
      const max = MAX_HOURS_CAP_MINUTES[period]
      if (minutes === undefined) {
        found.hours = hours.trim() === '' ? 'Required' : 'Enter hours like 40, 37.5 or 37:30'
      } else if (minutes < MIN_HOURS_CAP_MINUTES || minutes > max) {
        found.hours = `Enter between ${MIN_HOURS_CAP_MINUTES / 60} and ${max / 60} hours`
      }
      if (period === 'fortnight') {
        if (!isLocalDate(startsOn)) found.startsOn = 'Enter a date'
        else if (weekdayOf(startsOn) !== 1) found.startsOn = 'Pick a Monday'
      }
      hoursCap =
        period === 'week'
          ? { minutes: minutes as number, period }
          : { minutes: minutes as number, period, startsOn: startsOn as LocalDate }
    }
    setErrors(found)
    setFailed('')
    if (found.hours || found.startsOn) return
    setSaving(true)
    try {
      await onSave({ hoursCap })
      setSaved(true)
    } catch (error) {
      setFailed((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-4"
      aria-labelledby="hours-cap-heading"
    >
      <h2 id="hours-cap-heading" className="text-lg font-semibold">
        Work-hours limit
      </h2>
      <p className="text-sm text-muted-foreground">
        Your shifts are added up against it on Today, Home and each shift. It only warns.
      </p>
      {failed && <Alert variant="destructive">{failed}</Alert>}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Limit</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {PERIODS.map(([value, label]) => (
            <label key={value} className="flex items-center gap-2">
              <input
                type="radio"
                name="hoursCapPeriod"
                value={value}
                checked={period === value}
                onChange={() => changed(() => setPeriod(value))}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      {period !== 'none' && (
        <TextField
          id="capHours"
          inputMode="decimal"
          label={period === 'week' ? 'Hours a week' : 'Hours a fortnight'}
          hint="Like 40, 37.5 or 37:30."
          value={hours}
          onChange={(event) => changed(() => setHours(event.target.value))}
          error={errors.hours ? { type: 'validate', message: errors.hours } : undefined}
        />
      )}
      {period === 'fortnight' && (
        <TextField
          id="capStartsOn"
          type="date"
          label="First Monday of a fortnight"
          value={startsOn}
          onChange={(event) => changed(() => setStartsOn(event.target.value))}
          error={errors.startsOn ? { type: 'validate', message: errors.startsOn } : undefined}
        />
      )}
      <Button type="submit" aria-disabled={saving}>
        {saving ? 'Saving…' : 'Save limit'}
      </Button>
      <p role="status" className="text-sm empty:sr-only">
        {saved ? 'Saved.' : ''}
      </p>
    </form>
  )
}
