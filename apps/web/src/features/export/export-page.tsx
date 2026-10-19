import { isLocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups } from '@ledgerly/core/generated/rows'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { SelectField, TextField } from '../../ui/field'
import { useCurrentUser } from '../auth/use-current-user'
import { useGroupName, useSortedByName } from '../groups/use-group-name'
import { useGroups } from '../groups/use-groups'
import { usePerson, useProfile } from '../profile/use-profile'
import { download, fileUrl, groupExport, myRecordsExport, profileExport } from './export-data'

// Long names make file names some systems refuse.
const NAME_LENGTH = 60

/**
 * A file name from the group's name: letters of any script, digits and dashes, up to 60
 * characters. Accents come off Latin letters only: elsewhere, as in Hindi or Thai, a mark is part
 * of the word.
 */
export function fileName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/(\p{Script=Latin})[\u0300-\u036f]+/gu, '$1')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-/, '')
  const kept = characters(slug).slice(0, NAME_LENGTH).join('').replace(/-$/, '')
  // Marks alone aren't a name.
  return /[\p{L}\p{N}]/u.test(kept) ? kept : 'group'
}

/**
 * `text` by what reads as one character, so a syllable or a letter with its marks isn't cut in
 * half; by code point where the browser has no `Intl.Segmenter` (Firefox before 125).
 */
function characters(text: string): string[] {
  if (typeof Intl.Segmenter !== 'function') return Array.from(text)
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)
  return Array.from(graphemes, ({ segment }) => segment)
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
      <MyDataExport groups={groups.data} groupsFailed={groups.isError} />
    </div>
  )
}

function GroupExport({ groups }: { groups: Groups[] }) {
  const sorted = useSortedByName(groups)
  const [groupId, setGroupId] = useState('')
  // `groups` isn't empty here.
  const group = (sorted.find((item) => item.$id === groupId) ?? sorted[0]) as Groups
  // The name the app shows: a pair is named by its other member (#145).
  const name = useGroupName(group)
  // Defaults, in the group's own time zone: the start of this year to today.
  const today = localToday(group.timezone, new Date())
  const [start, setStart] = useState<string>()
  const [end, setEnd] = useState<string>()
  const from = start ?? `${today.slice(0, 4)}-01-01`
  const to = end ?? today
  const [errors, setErrors] = useState<{ from?: string; to?: string }>({})
  const [failed, setFailed] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState('')
  const fromField = useRef<HTMLInputElement>(null)
  const toField = useRef<HTMLInputElement>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const found = {
      from: !isLocalDate(from)
        ? 'Enter a date'
        : isLocalDate(to) && from > to
          ? 'The start must be on or before the end'
          : undefined,
      to: !isLocalDate(to) ? 'Enter a date' : undefined,
    }
    setErrors(found)
    setFailed('')
    setDone('')
    if (found.from) fromField.current?.focus()
    else if (found.to) toField.current?.focus()
    if (found.from || found.to || !isLocalDate(from) || !isLocalDate(to)) return
    setBusy(true)
    try {
      const file = `${fileName(name)}-${from}-to-${to}.csv`
      download(file, await groupExport(group, from, to))
      setDone(`Downloaded ${file}.`)
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
        value={group.$id}
        onChange={(event) => setGroupId(event.target.value)}
      >
        {sorted.map((item) => (
          <GroupOption key={item.$id} group={item} />
        ))}
      </SelectField>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          id="exportStart"
          ref={fromField}
          type="date"
          label="From"
          value={from}
          onChange={(event) => setStart(event.target.value)}
          error={errors.from ? { type: 'validate', message: errors.from } : undefined}
        />
        <TextField
          id="exportEnd"
          ref={toField}
          type="date"
          label="To"
          value={to}
          onChange={(event) => setEnd(event.target.value)}
          error={errors.to ? { type: 'validate', message: errors.to } : undefined}
        />
      </div>
      <Button type="submit" className="self-start" aria-disabled={busy}>
        {busy ? 'Making the file…' : 'Download CSV'}
      </Button>
      <p role="status" className="text-sm break-words empty:hidden">
        {done}
      </p>
    </form>
  )
}

type MadeFile = { name: string; url: string }

function MyDataExport({
  groups,
  groupsFailed,
}: {
  groups: Groups[] | undefined
  groupsFailed: boolean
}) {
  const user = useCurrentUser().data
  const profile = useProfile(user?.$id ?? '')
  const person = usePerson(profile.data?.personId ?? '')
  const [failed, setFailed] = useState('')
  const [busy, setBusy] = useState(false)
  // Two files can't both download from one click in every browser, so they're offered as links.
  const [files, setFiles] = useState<MadeFile[]>([])
  // Made again, or left: the last files' URLs go.
  useEffect(
    () => () => {
      for (const file of files) URL.revokeObjectURL(file.url)
    },
    [files],
  )
  // Files finished after the page is left would never be let go of, so they aren't made.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const ready = Boolean(user && profile.data && person.data && groups)
  const unavailable =
    groupsFailed || profile.isError || person.isError
      ? 'We couldn’t load your details. Reload the page to try again.'
      : 'Loading your details…'

  const run = async () => {
    if (busy || !user || !profile.data || !person.data || !groups) return
    setFailed('')
    setFiles([])
    setBusy(true)
    try {
      const records = await myRecordsExport(profile.data.personId, groups)
      if (!mounted.current) return
      const details = profileExport({
        name: person.data.displayName,
        email: user.email || null,
        phone: user.phone || null,
        profile: profile.data,
        businessJson: profile.data.businessJson,
      })
      setFiles([
        { name: 'profile.csv', url: fileUrl(details) },
        { name: 'my-records.csv', url: fileUrl(records) },
      ])
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
        aria-describedby={ready ? undefined : 'my-data-unavailable'}
        onClick={() => void run()}
      >
        {busy ? 'Making the files…' : 'Make my files'}
      </Button>
      {!ready && (
        <p id="my-data-unavailable" className="text-sm text-muted-foreground">
          {unavailable}
        </p>
      )}
      {/* Mounted from the start, so it's read out when the files are ready. */}
      <div role="status" className="flex flex-col gap-2 text-sm empty:hidden">
        {files.length > 0 && (
          <>
            <p>Your files are ready. Download each one:</p>
            <ul className="flex flex-col gap-1">
              {files.map((file) => (
                <li key={file.name}>
                  <a href={file.url} download={file.name} className="underline underline-offset-4">
                    {file.name}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  )
}
