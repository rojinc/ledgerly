import { isLocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups } from '@ledgerly/core/generated/rows'
import { type FormEvent, useState } from 'react'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { SelectField, TextField } from '../../ui/field'
import { useCurrentUser } from '../auth/use-current-user'
import { useGroupName, useSortedByName } from '../groups/use-group-name'
import { useGroups } from '../groups/use-groups'
import { usePerson, useProfile } from '../profile/use-profile'
import { download, groupExport, myRecordsExport, profileExport } from './export-data'

/** A file name made of the group's name, kept to letters, digits and dashes. */
function fileName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'group'
  )
}

function GroupOption({ group }: { group: Groups }) {
  const name = useGroupName(group)
  return (
    <option value={group.$id}>
      {name}
      {group.archivedAt ? ' (archived)' : ''}
    </option>
  )
}

/** `/export`: a group's records for a date range (F-72), and the user's own data (F-06). */
export function ExportPage() {
  const groups = useGroups()
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Export</h1>
        <p className="text-sm text-muted-foreground">
          Files are made in your browser from what you can already see. Amounts are exact, and dates
          are as recorded.
        </p>
      </div>
      {groups.data ? (
        groups.data.length > 0 && <GroupExport groups={groups.data} />
      ) : groups.isError ? (
        <p role="alert" className="text-destructive">
          We couldn’t load your groups. Reload the page to try again.
        </p>
      ) : (
        <p role="status" className="text-muted-foreground">
          Loading…
        </p>
      )}
      <MyDataExport groups={groups.data} />
    </div>
  )
}

function GroupExport({ groups }: { groups: Groups[] }) {
  const sorted = useSortedByName(groups)
  const [groupId, setGroupId] = useState('')
  const group = sorted.find((item) => item.$id === groupId) ?? sorted[0]
  // Defaults, in the group's own time zone: the start of this year to today.
  const today = group ? localToday(group.timezone, new Date()) : ''
  const [start, setStart] = useState<string>()
  const [end, setEnd] = useState<string>()
  const from = start ?? `${today.slice(0, 4)}-01-01`
  const to = end ?? today
  const [error, setError] = useState('')
  const [failed, setFailed] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || !group) return
    const found =
      !isLocalDate(from) || !isLocalDate(to)
        ? 'Enter both dates'
        : from > to
          ? 'The start must be on or before the end'
          : ''
    setError(found)
    setFailed('')
    setDone('')
    if (found || !isLocalDate(from) || !isLocalDate(to)) return
    setBusy(true)
    try {
      const name = `${fileName(group.name)}-${from}-to-${to}.csv`
      download(name, await groupExport(group, from, to))
      setDone(`Downloaded ${name}.`)
    } catch {
      setFailed('We couldn’t make the file. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      aria-labelledby="group-export-heading"
      className="flex flex-col gap-4"
    >
      <h2 id="group-export-heading" className="text-lg font-semibold">
        A group’s records
      </h2>
      <p className="text-sm text-muted-foreground">
        Every transaction in the dates you pick, with each person’s part.
      </p>
      {failed && <Alert variant="destructive">{failed}</Alert>}
      <SelectField
        id="exportGroup"
        label="Group"
        value={group?.$id ?? ''}
        onChange={(event) => setGroupId(event.target.value)}
      >
        {sorted.map((item) => (
          <GroupOption key={item.$id} group={item} />
        ))}
      </SelectField>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          id="exportStart"
          type="date"
          label="From"
          value={from}
          onChange={(event) => setStart(event.target.value)}
          error={error ? { type: 'validate', message: error } : undefined}
        />
        <TextField
          id="exportEnd"
          type="date"
          label="To"
          value={to}
          onChange={(event) => setEnd(event.target.value)}
        />
      </div>
      <Button type="submit" className="self-start" aria-disabled={busy}>
        {busy ? 'Making the file…' : 'Download CSV'}
      </Button>
      <p role="status" className="text-sm empty:hidden">
        {done}
      </p>
    </form>
  )
}

function MyDataExport({ groups }: { groups: Groups[] | undefined }) {
  const user = useCurrentUser().data
  const profile = useProfile(user?.$id ?? '').data
  const person = usePerson(profile?.personId ?? '').data
  const [failed, setFailed] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState('')
  const ready = Boolean(user && profile && person && groups)

  const run = async () => {
    if (busy || !user || !profile || !person || !groups) return
    setFailed('')
    setDone('')
    setBusy(true)
    try {
      const records = await myRecordsExport(profile.personId, groups)
      download(
        'profile.csv',
        profileExport({
          name: person.displayName,
          email: user.email || null,
          phone: user.phone || null,
          profile,
          businessJson: profile.businessJson,
        }),
      )
      download('my-records.csv', records)
      setDone('Downloaded profile.csv and my-records.csv.')
    } catch {
      setFailed('We couldn’t make the files. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="my-data-heading" className="flex flex-col gap-4">
      <h2 id="my-data-heading" className="text-lg font-semibold">
        Your data
      </h2>
      <p className="text-sm text-muted-foreground">
        Two files: your profile and business details, and every share of yours across your groups.
      </p>
      {failed && <Alert variant="destructive">{failed}</Alert>}
      <Button
        className="self-start"
        variant="outline"
        aria-disabled={busy || !ready}
        onClick={() => void run()}
      >
        {busy ? 'Making the files…' : 'Download my data'}
      </Button>
      <p role="status" className="text-sm empty:hidden">
        {done}
      </p>
    </section>
  )
}
