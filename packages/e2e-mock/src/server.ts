// A mock of the Appwrite API the e2e flows use, so they run on every pull request with no network
// and no secrets (docs/engineering/testing.md#on-the-mock, #554). The repo's FakeDb and FakeTeams
// back everything, and the six functions run their real route handlers through createHandler,
// with in-memory Users, sessions, Storage and email in place of Appwrite's. It listens on the
// loopback only, makes no outbound request, and logs methods, paths (no query strings) and IDs
// only: never bodies, names or addresses.
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import http from 'node:http'
import type { Duplex } from 'node:stream'
import { accountRoutes } from '@ledgerly/fn-account/src/main'
import { groupsRoutes } from '@ledgerly/fn-groups/src/main'
import { identityRoutes } from '@ledgerly/fn-identity/src/main'
import { ledgerRoutes } from '@ledgerly/fn-ledger/src/main'
import { schedulerRoutes } from '@ledgerly/fn-scheduler/src/main'
import { statementsRoutes } from '@ledgerly/fn-statements/src/main'
import { FakeDb } from '@ledgerly/server/appwrite/fake'
import { FakeTeams } from '@ledgerly/server/appwrite/fake-teams'
import { createHandler, type Route } from '@ledgerly/server/http/create-handler'
import { AppwriteException } from 'node-appwrite'
import tables from '../../../appwrite/tables.json'

const PORT = Number(process.env.MOCK_PORT ?? 8790)
const APP_URL = process.env.MOCK_APP_URL ?? 'http://localhost:5173'
const LOG_FILE = process.env.MOCK_LOG ?? ''
const CHUNK_SIZE = 5 * 1024 * 1024

function log(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`
  console.log(stamped)
  if (LOG_FILE) appendFileSync(LOG_FILE, `${stamped}\n`)
}

const newId = () => randomBytes(10).toString('hex')
const nowIso = () => new Date().toISOString()

// ---------------------------------------------------------------- state

const db = new FakeDb()
const teams = new FakeTeams()

// As Appwrite stores a row: a column left out of a create or upsert gets its default, else null.
// FakeDb leaves it out, so `equal('verified', false)` or `profile.invoicePrefix` would miss.
type Column = { key: string; default?: unknown }
const COLUMNS = new Map(
  (tables as Array<{ $id: string; columns: Column[] }>).map((table) => [table.$id, table.columns]),
)
const stageOperations = db.createOperations.bind(db)
db.createOperations = (params) =>
  stageOperations({
    ...params,
    operations: (
      params.operations as
        | Array<{ action: string; tableId: string; data?: Record<string, unknown> }>
        | undefined
    )?.map((operation) => {
      if (operation.action !== 'create' && operation.action !== 'upsert') return operation
      const data = { ...(operation.data ?? {}) }
      for (const column of COLUMNS.get(operation.tableId) ?? []) {
        if (!(column.key in data)) data[column.key] = column.default ?? null
      }
      return { ...operation, data }
    }),
  })

type User = {
  $id: string
  $createdAt: string
  $updatedAt: string
  name: string
  password: string | null
  registration: string
  status: boolean
  labels: string[]
  passwordUpdate: string
  email: string
  phone: string
  emailVerification: boolean
  phoneVerification: boolean
  mfa: boolean
  prefs: Record<string, unknown>
  targets: unknown[]
  accessedAt: string
}
type Session = {
  $id: string
  $createdAt: string
  $updatedAt: string
  userId: string
  expire: string
  provider: string
  secret: string
}
type Token = { $id: string; $createdAt: string; userId: string; secret: string; expire: string }
type StoredFile = {
  $id: string
  bucketId: string
  $createdAt: string
  $updatedAt: string
  $permissions: string[]
  name: string
  signature: string
  mimeType: string
  sizeOriginal: number
  chunksTotal: number
  chunksUploaded: number
  encryption: boolean
  compression: string
  data: Buffer
  chunks: Map<number, Buffer>
}
type Execution = {
  $id: string
  $createdAt: string
  $updatedAt: string
  $permissions: string[]
  functionId: string
  deploymentId: string
  trigger: string
  status: 'waiting' | 'processing' | 'completed' | 'failed' | 'scheduled'
  requestMethod: string
  requestPath: string
  requestHeaders: { name: string; value: string }[]
  responseStatusCode: number
  responseBody: string
  responseHeaders: { name: string; value: string }[]
  logs: string
  errors: string
  duration: number
  scheduledAt: string | null
  userId: string
}

const users = new Map<string, User>()
const sessions = new Map<string, Session>() // by session ID
const sessionsBySecret = new Map<string, string>() // secret -> session ID
const tokens = new Map<string, Token>() // by secret
const files = new Map<string, StoredFile>() // `${bucketId}/${fileId}`
const executions = new Map<string, Execution>()
const jwts = new Map<string, { userId: string; sessionId: string }>()
let emailsSent = 0

const BUCKETS: Record<string, { create: string[]; extensions: string[]; maxSize: number }> = {
  receipts: {
    create: ['users/verified'],
    extensions: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'pdf'],
    maxSize: 10 * 1024 * 1024,
  },
  statements: { create: [], extensions: ['pdf'], maxSize: 10 * 1024 * 1024 },
}

// ---------------------------------------------------------------- errors

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
  ) {
    super(message)
  }
}
const unauthorized = () =>
  new HttpError(
    401,
    'general_unauthorized_scope',
    'User (role: guests) missing scopes (["account"])',
  )
const notFound = (type: string, what: string) =>
  new HttpError(404, type, `${what} with the requested ID could not be found.`)

// ---------------------------------------------------------------- users and roles

function publicUser(user: User) {
  const { password: _password, ...rest } = user
  return { ...rest, hashOptions: {}, hash: user.password ? 'argon2' : '' }
}

function createUserRecord(input: {
  userId?: string
  email?: string
  password?: string
  name?: string
  phone?: string
}): User {
  const id = !input.userId || input.userId === 'unique()' ? newId() : input.userId
  if (users.has(id))
    throw new HttpError(409, 'user_already_exists', 'A user with the same id already exists.')
  const email = (input.email ?? '').toLowerCase()
  if (email && [...users.values()].some((user) => user.email === email)) {
    throw new HttpError(409, 'user_already_exists', 'A user with the same email already exists.')
  }
  if (input.password !== undefined && input.password !== '' && input.password.length < 8) {
    throw new HttpError(
      400,
      'general_argument_invalid',
      'Invalid `password` param: Password must be at least 8 characters',
    )
  }
  const now = nowIso()
  const user: User = {
    $id: id,
    $createdAt: now,
    $updatedAt: now,
    name: input.name ?? '',
    password: input.password ? input.password : null,
    registration: now,
    status: true,
    labels: [],
    passwordUpdate: input.password ? now : '',
    email,
    phone: input.phone ?? '',
    emailVerification: false,
    phoneVerification: false,
    mfa: false,
    prefs: {},
    targets: [],
    accessedAt: now,
  }
  users.set(id, user)
  return user
}

function deleteUserSessions(userId: string): void {
  for (const session of [...sessions.values()]) {
    if (session.userId === userId) {
      sessions.delete(session.$id)
      sessionsBySecret.delete(session.secret)
    }
  }
}

function removeUser(userId: string): void {
  deleteUserSessions(userId)
  users.delete(userId)
  for (const teamId of teams.teamIds()) {
    for (const membership of teams.members(teamId) ?? []) {
      if (membership.userId === userId) {
        void teams.deleteMembership({ teamId, membershipId: membership.$id })
      }
    }
  }
}

function rolesOf(user: User | undefined): Set<string> {
  if (!user) return new Set(['any', 'guests'])
  const verified = user.emailVerification ? 'verified' : 'unverified'
  const roles = new Set([
    'any',
    'users',
    `users/${verified}`,
    `user:${user.$id}`,
    `user:${user.$id}/${verified}`,
  ])
  for (const teamId of teams.teamIds()) {
    const membership = teams.members(teamId)?.find((found) => found.userId === user.$id)
    if (!membership) continue
    roles.add(`team:${teamId}`)
    roles.add(`member:${membership.$id}`)
    for (const role of membership.roles) roles.add(`team:${teamId}/${role}`)
  }
  for (const label of user.labels) roles.add(`label:${label}`)
  return roles
}

const PERMISSION = /^(read|create|update|delete|write)\("([^"]+)"\)$/

function allowed(
  permissions: readonly string[] | undefined,
  action: string,
  roles: Set<string>,
): boolean {
  for (const permission of permissions ?? []) {
    const match = PERMISSION.exec(permission)
    if (!match) continue
    const [, granted, role] = match as unknown as [string, string, string]
    const covers = granted === action || (granted === 'write' && action !== 'read')
    if (covers && roles.has(role)) return true
  }
  return false
}

// ---------------------------------------------------------------- sessions

type Auth = { user: User; session: Session } | undefined

function sessionFromSecret(secret: string | undefined): Auth {
  if (!secret) return undefined
  const sessionId = sessionsBySecret.get(secret)
  const session = sessionId ? sessions.get(sessionId) : undefined
  const user = session ? users.get(session.userId) : undefined
  if (!session || !user?.status) return undefined
  return { user, session }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0) out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim())
  }
  return out
}

function authOf(req: http.IncomingMessage): Auth {
  const candidates: string[] = []
  for (const [name, value] of Object.entries(parseCookies(req.headers.cookie))) {
    if (name.startsWith('a_session_') && !name.endsWith('_legacy')) candidates.push(value)
  }
  const fallback = req.headers['x-fallback-cookies']
  if (typeof fallback === 'string' && fallback) {
    try {
      for (const [name, value] of Object.entries(JSON.parse(fallback) as Record<string, string>)) {
        if (name.startsWith('a_session_') && typeof value === 'string') candidates.push(value)
      }
    } catch {
      // Not JSON: no session from it.
    }
  }
  for (const secret of candidates) {
    const auth = sessionFromSecret(secret)
    if (auth) return auth
  }
  const jwt = req.headers['x-appwrite-jwt']
  if (typeof jwt === 'string') {
    const claim = jwts.get(jwt)
    const session = claim ? sessions.get(claim.sessionId) : undefined
    const user = session ? users.get(session.userId) : undefined
    if (session && user?.status) return { user, session }
  }
  return undefined
}

function requireAuth(req: http.IncomingMessage): { user: User; session: Session } {
  const auth = authOf(req)
  if (!auth) throw unauthorized()
  return auth
}

function startSession(user: User, provider: string, project: string, res: http.ServerResponse) {
  if (!user.status) throw new HttpError(401, 'user_blocked', 'The current user has been blocked.')
  const now = new Date()
  const session: Session = {
    $id: newId(),
    $createdAt: now.toISOString(),
    $updatedAt: now.toISOString(),
    userId: user.$id,
    expire: new Date(now.getTime() + 365 * 86_400_000).toISOString(),
    provider,
    secret: randomBytes(32).toString('hex'),
  }
  sessions.set(session.$id, session)
  sessionsBySecret.set(session.secret, session.$id)
  user.accessedAt = session.$createdAt
  const name = `a_session_${project.toLowerCase()}`
  res.setHeader('Set-Cookie', [
    `${name}=${session.secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
  ])
  res.setHeader('X-Fallback-Cookies', JSON.stringify({ [name]: session.secret }))
  return publicSession(session, session.$id)
}

function publicSession(session: Session, currentId?: string) {
  const { secret: _secret, ...rest } = session
  return {
    ...rest,
    providerUid: '',
    providerAccessToken: '',
    providerAccessTokenExpiry: '',
    providerRefreshToken: '',
    ip: '127.0.0.1',
    osCode: '',
    osName: '',
    osVersion: '',
    clientType: 'browser',
    clientCode: '',
    clientName: '',
    clientVersion: '',
    clientEngine: '',
    clientEngineVersion: '',
    deviceName: 'desktop',
    deviceBrand: '',
    deviceModel: '',
    countryCode: '--',
    countryName: 'Unknown',
    current: session.$id === currentId,
    factors: ['password'],
    secret: '',
    mfaUpdatedAt: '',
  }
}

function endSession(session: Session, project: string, res: http.ServerResponse): void {
  sessions.delete(session.$id)
  sessionsBySecret.delete(session.secret)
  const name = `a_session_${project.toLowerCase()}`
  res.setHeader('Set-Cookie', [`${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`])
  res.setHeader('X-Fallback-Cookies', '{}')
}

function makeToken(userId: string, withSecret: boolean) {
  const now = new Date()
  const token: Token = {
    $id: newId(),
    $createdAt: now.toISOString(),
    userId,
    secret: randomBytes(16).toString('hex'),
    expire: new Date(now.getTime() + 15 * 60_000).toISOString(),
  }
  tokens.set(token.secret, token)
  return { ...token, secret: withSecret ? token.secret : '', phrase: '' }
}

function useToken(userId: string, secret: string): void {
  const token = tokens.get(secret)
  if (!token || token.userId !== userId || Date.parse(token.expire) < Date.now()) {
    throw new HttpError(401, 'user_invalid_token', 'Invalid token passed in the request.')
  }
  tokens.delete(secret)
}

// ---------------------------------------------------------------- queries (browser reads, Users)

type Query = { method: string; attribute?: string; values?: unknown[] }

function compare(a: unknown, b: unknown): number {
  if (a == null || b == null) return a == null ? (b == null ? 0 : -1) : 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

function matchesQuery(row: Record<string, unknown>, query: Query): boolean {
  const value = query.attribute === undefined ? undefined : row[query.attribute]
  const values = query.values ?? []
  switch (query.method) {
    case 'equal':
      return values.some((candidate) =>
        Array.isArray(value) ? value.includes(candidate) : candidate === value,
      )
    case 'notEqual':
      return values.every((candidate) => candidate !== value)
    case 'lessThan':
      return value != null && compare(value, values[0]) < 0
    case 'lessThanEqual':
      return value != null && compare(value, values[0]) <= 0
    case 'greaterThan':
      return value != null && compare(value, values[0]) > 0
    case 'greaterThanEqual':
      return value != null && compare(value, values[0]) >= 0
    case 'between':
      return value != null && compare(value, values[0]) >= 0 && compare(value, values[1]) <= 0
    case 'isNull':
      return value == null
    case 'isNotNull':
      return value != null
    case 'contains':
      if (Array.isArray(value)) return values.some((candidate) => value.includes(candidate))
      return (
        typeof value === 'string' && values.some((candidate) => value.includes(String(candidate)))
      )
    case 'startsWith':
      return (
        typeof value === 'string' && values.some((candidate) => value.startsWith(String(candidate)))
      )
    case 'endsWith':
      return (
        typeof value === 'string' && values.some((candidate) => value.endsWith(String(candidate)))
      )
    case 'search':
      return (
        typeof value === 'string' &&
        values.some((candidate) => value.toLowerCase().includes(String(candidate).toLowerCase()))
      )
    case 'or':
      return (values as Query[]).some((sub) => matchesQuery(row, sub))
    case 'and':
      return (values as Query[]).every((sub) => matchesQuery(row, sub))
    default:
      throw new HttpError(
        400,
        'general_query_invalid',
        `Mock does not support query ${query.method}`,
      )
  }
}

/** Filters, orders and pages `rows` as Appwrite would for these queries. */
function applyQueries<R extends Record<string, unknown> & { $id: string }>(
  rows: R[],
  rawQueries: string[],
): { total: number; page: R[]; select?: string[] } {
  const queries = rawQueries.map((query) => JSON.parse(query) as Query)
  let limit = 25
  let offset = 0
  let cursorAfter: string | undefined
  let cursorBefore: string | undefined
  let select: string[] | undefined
  const orders: Array<{ attribute: string; direction: 1 | -1 }> = []
  let filtered = rows
  for (const query of queries) {
    const values = query.values ?? []
    switch (query.method) {
      case 'limit':
        limit = Number(values[0])
        break
      case 'offset':
        offset = Number(values[0])
        break
      case 'cursorAfter':
        cursorAfter = String(values[0])
        break
      case 'cursorBefore':
        cursorBefore = String(values[0])
        break
      case 'select':
        select = values as string[]
        break
      case 'orderAsc':
      case 'orderDesc':
        orders.push({
          attribute: query.attribute ?? '',
          direction: query.method === 'orderAsc' ? 1 : -1,
        })
        break
      case 'orderRandom':
        break
      default:
        filtered = filtered.filter((row) => matchesQuery(row, query))
    }
  }
  if (orders.length > 0) {
    filtered = [...filtered].sort((a, b) => {
      for (const { attribute, direction } of orders) {
        const order = compare(a[attribute], b[attribute])
        if (order !== 0) return order * direction
      }
      return 0
    })
  }
  const total = filtered.length
  if (cursorAfter !== undefined) {
    const index = filtered.findIndex((row) => row.$id === cursorAfter)
    if (index === -1) throw new HttpError(400, 'general_cursor_not_found', 'Cursor not found')
    filtered = filtered.slice(index + 1)
  }
  if (cursorBefore !== undefined) {
    const index = filtered.findIndex((row) => row.$id === cursorBefore)
    if (index === -1) throw new HttpError(400, 'general_cursor_not_found', 'Cursor not found')
    filtered = filtered.slice(Math.max(0, index - limit), index)
  }
  return { total, page: filtered.slice(offset, offset + limit), select }
}

function pick(row: Record<string, unknown>, select: string[] | undefined) {
  if (!select || select.includes('*')) return row
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => key.startsWith('$') || select.includes(key)),
  )
}

// ---------------------------------------------------------------- storage

const RASTER_PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

function sniffMime(data: Buffer, fallback: string): string {
  if (data.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf'
  if (data[0] === 0x89 && data.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp'
  if (data.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = data.subarray(8, 12).toString('latin1')
    if (/^hei|^heix|^hevc|^mif1/.test(brand)) return 'image/heic'
  }
  return fallback || 'application/octet-stream'
}

function publicFile(file: StoredFile) {
  const { data: _data, chunks: _chunks, ...rest } = file
  return rest
}

function getStored(bucketId: string, fileId: string): StoredFile | undefined {
  return files.get(`${bucketId}/${fileId}`)
}

function storageNotFound(): AppwriteException {
  return new AppwriteException(
    'The requested file could not be found.',
    404,
    'storage_file_not_found',
  )
}

function putServerFile(
  bucketId: string,
  fileId: string,
  name: string,
  data: Buffer,
  permissions: string[],
) {
  const now = nowIso()
  const file: StoredFile = {
    $id: fileId,
    bucketId,
    $createdAt: now,
    $updatedAt: now,
    $permissions: [...permissions],
    name,
    signature: randomBytes(16).toString('hex'),
    mimeType: sniffMime(data, ''),
    sizeOriginal: data.length,
    chunksTotal: 1,
    chunksUploaded: 1,
    encryption: true,
    compression: 'none',
    data,
    chunks: new Map(),
  }
  files.set(`${bucketId}/${fileId}`, file)
  return file
}

// The functions' Storage, against the same store, as the server key sees it.
const ledgerFiles = {
  async getFile(fileId: string) {
    const file = getStored('receipts', fileId)
    return file && receiptView(file)
  },
  async updateFile(fileId: string, permissions: string[]) {
    const file = getStored('receipts', fileId)
    if (!file) return undefined
    file.$permissions = [...permissions]
    file.$updatedAt = nowIso()
    return receiptView(file)
  },
}
function receiptView(file: StoredFile) {
  return {
    mimeType: file.mimeType,
    permissions: [...file.$permissions],
    complete: file.chunksUploaded === file.chunksTotal,
  }
}

const statementFiles = {
  async upload(fileId: string, name: string, content: Uint8Array, permissions: string[]) {
    if (getStored('statements', fileId)) return
    putServerFile('statements', fileId, name, Buffer.from(content), permissions)
  },
  async download(fileId: string) {
    const file = getStored('statements', fileId)
    if (!file) throw storageNotFound()
    return new Uint8Array(file.data)
  },
}

const accountFiles = {
  async getFile({ bucketId, fileId }: { bucketId: string; fileId: string }) {
    const file = getStored(bucketId, fileId)
    if (!file) throw storageNotFound()
    return publicFile(file)
  },
  async deleteFile({ bucketId, fileId }: { bucketId: string; fileId: string }) {
    if (!files.delete(`${bucketId}/${fileId}`)) throw storageNotFound()
    return {}
  },
}

const receiptsBucket = {
  async listFiles({ from, to, after }: { from: string; to: string; after?: string }) {
    let list = [...files.values()]
      .filter(
        (file) => file.bucketId === 'receipts' && file.$createdAt > from && file.$createdAt <= to,
      )
      .sort((a, b) => compare(a.$createdAt, b.$createdAt) || compare(a.$id, b.$id))
    if (after !== undefined) {
      const index = list.findIndex((file) => file.$id === after)
      if (index === -1)
        throw new AppwriteException('Cursor not found', 400, 'general_cursor_not_found')
      list = list.slice(index + 1)
    }
    return list.slice(0, 100).map(({ $id, $createdAt }) => ({ $id, $createdAt }))
  },
  async deleteFile(fileId: string) {
    return files.delete(`receipts/${fileId}`)
  },
}

// ---------------------------------------------------------------- the functions' Users and email

function userOr404(userId: string): User {
  const user = users.get(userId)
  if (!user)
    throw new AppwriteException(
      'User with the requested ID could not be found.',
      404,
      'user_not_found',
    )
  return user
}

const usersApi = {
  async get({ userId }: { userId: string }) {
    return publicUser(userOr404(userId))
  },
  async listSessions({ userId }: { userId: string }) {
    userOr404(userId)
    const list = [...sessions.values()].filter((session) => session.userId === userId)
    return { total: list.length, sessions: list.map((session) => publicSession(session)) }
  },
  async updateLabels({ userId, labels }: { userId: string; labels: string[] }) {
    const user = userOr404(userId)
    user.labels = [...new Set(labels)]
    user.$updatedAt = nowIso()
    return publicUser(user)
  },
  async updateStatus({ userId, status }: { userId: string; status: boolean }) {
    const user = userOr404(userId)
    user.status = status
    user.$updatedAt = nowIso()
    if (!status) deleteUserSessions(userId)
    return publicUser(user)
  },
  async deleteSessions({ userId }: { userId: string }) {
    userOr404(userId)
    deleteUserSessions(userId)
    return {}
  },
  async delete({ userId }: { userId: string }) {
    userOr404(userId)
    removeUser(userId)
    return {}
  },
  async list({ queries }: { queries: string[]; total?: boolean }) {
    const all = [...users.values()].map(publicUser) as unknown as Array<
      Record<string, unknown> & { $id: string }
    >
    const { total, page } = applyQueries(all, queries)
    return { total, users: page as never[] }
  },
}

async function fakeSendEmail(email: { idempotencyKey?: string; attachments?: unknown[] }) {
  emailsSent += 1
  const id = `mock-email-${emailsSent}`
  // Never the address, subject or body.
  log(`EMAIL ${id} attachments=${email.attachments?.length ?? 0}`)
  return { id }
}

// ---------------------------------------------------------------- functions

const budget = (ms: number) => {
  const stopAt = performance.now() + ms
  return () => performance.now() >= stopAt
}

async function verifyCaller(jwt: string): Promise<string> {
  const claim = jwts.get(jwt)
  const session = claim ? sessions.get(claim.sessionId) : undefined
  const user = session ? users.get(session.userId) : undefined
  if (!claim || !session || !user?.status) {
    throw new AppwriteException('Failed to verify JWT. Invalid token.', 401, 'user_jwt_invalid')
  }
  return claim.userId
}

const sharedDb = () => db

const ROUTES: Record<string, Route[]> = {
  ledger: ledgerRoutes(() => ({ teams, files: ledgerFiles }) as never),
  groups: groupsRoutes((ctx) => ({ db: ctx.db, teams, now: new Date() }) as never),
  identity: identityRoutes(
    (ctx) =>
      ({
        db: ctx.db,
        teams,
        users: usersApi,
        now: new Date(),
        sendEmail: fakeSendEmail,
        appUrl: APP_URL,
        supportEmail: '',
      }) as never,
  ),
  account: accountRoutes(
    (ctx, budgetMs) =>
      ({
        db: ctx.db,
        teams,
        users: usersApi,
        files: accountFiles,
        now: new Date(),
        outOfTime: budget(budgetMs),
      }) as never,
  ),
  scheduler: schedulerRoutes(
    (ctx) =>
      ({
        db: ctx.db,
        teams,
        users: usersApi,
        sendEmail: fakeSendEmail,
        files: receiptsBucket,
        now: new Date(),
        appUrl: APP_URL,
        outOfTime: budget(12 * 60_000),
        wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 50))),
      }) as never,
  ),
  statements: statementsRoutes(
    (ctx) =>
      ({
        db: ctx.db,
        teams,
        files: statementFiles,
        sendEmail: fakeSendEmail,
        now: new Date(),
        appUrl: APP_URL,
      }) as never,
  ),
}

const HANDLERS = Object.fromEntries(
  Object.entries(ROUTES).map(([name, routes]) => [
    name,
    createHandler(routes, sharedDb as never, verifyCaller),
  ]),
)

function makeJwt(userId: string, sessionId: string): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const jwt = `${part({ typ: 'JWT', alg: 'HS256' })}.${part({ userId, sessionId, exp: Math.floor(Date.now() / 1000) + 900 })}.${randomBytes(16).toString('base64url')}`
  jwts.set(jwt, { userId, sessionId })
  return jwt
}

async function runFunction(
  functionId: string,
  input: {
    method: string
    path: string
    bodyText: string
    headers: Record<string, string>
    auth: Auth
    trigger?: string
  },
): Promise<{ status: number; body: unknown }> {
  const handler = HANDLERS[functionId]
  if (!handler)
    throw new HttpError(
      404,
      'function_not_found',
      'Function with the requested ID could not be found.',
    )
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.headers)) {
    if (!name.toLowerCase().startsWith('x-appwrite-')) headers[name.toLowerCase()] = value
  }
  headers['content-type'] ??= 'application/json'
  headers['x-appwrite-trigger'] = input.trigger ?? 'http'
  headers['x-appwrite-key'] = 'mock-execution-key'
  let jwt: string | undefined
  if (input.auth) {
    jwt = makeJwt(input.auth.user.$id, input.auth.session.$id)
    headers['x-appwrite-user-id'] = input.auth.user.$id
    headers['x-appwrite-user-jwt'] = jwt
  }
  let result: { status: number; body: unknown } = { status: 500, body: null }
  const path = input.path.split('?')[0] || '/'
  try {
    await handler({
      req: { method: input.method, path, headers, bodyText: input.bodyText },
      res: {
        json: (body: unknown, status = 200) => {
          result = { status, body }
          return result
        },
      },
      log: (line: string) => log(`FN ${functionId} ${line}`),
      error: (line: string) => log(`FN-ERROR ${functionId} ${line}`),
    })
  } finally {
    if (jwt) jwts.delete(jwt)
  }
  return result
}

function publicExecution(execution: Execution) {
  const { userId: _userId, ...rest } = execution
  return rest
}

// ---------------------------------------------------------------- HTTP plumbing

type Ctx = {
  req: http.IncomingMessage
  res: http.ServerResponse
  url: URL
  params: Record<string, string>
  project: string
  raw: Buffer
  json: Record<string, unknown>
  queries: string[]
}
type Handler = (ctx: Ctx) => Promise<unknown> | unknown

const routes: Array<{ method: string; parts: string[]; handler: Handler }> = []
function on(method: string, path: string, handler: Handler) {
  routes.push({ method, parts: path.split('/').filter(Boolean), handler })
}

function matchRoute(method: string, pathname: string) {
  const parts = pathname.split('/').filter(Boolean)
  for (const route of routes) {
    if (route.method !== method || route.parts.length !== parts.length) continue
    const params: Record<string, string> = {}
    const ok = route.parts.every((segment, index) => {
      const part = decodeURIComponent(parts[index] ?? '')
      if (segment.startsWith(':')) {
        params[segment.slice(1)] = part
        return true
      }
      return segment === part
    })
    if (ok) return { route, params }
  }
  return undefined
}

function queriesOf(url: URL, json: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const [key, value] of url.searchParams) if (/^queries\[\d*\]$/.test(key)) out.push(value)
  if (Array.isArray(json.queries)) out.push(...(json.queries as string[]))
  return out
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status === 200 ? 204 : status)
    res.end()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

class Raw {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}
class Bytes {
  constructor(
    readonly data: Buffer,
    readonly mimeType: string,
    readonly disposition: string,
  ) {}
}

function setCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    String(req.headers['access-control-request-headers'] ?? 'content-type, x-appwrite-project'),
  )
  res.setHeader(
    'Access-Control-Expose-Headers',
    'X-Fallback-Cookies, X-Appwrite-Warning, Content-Disposition, Content-Type',
  )
  res.setHeader('Access-Control-Max-Age', '86400')
}

function requireKey(ctx: Ctx): void {
  if (!ctx.req.headers['x-appwrite-key'])
    throw new HttpError(401, 'general_unauthorized_scope', 'Missing API key')
}

// ---------------------------------------------------------------- routes: misc

on('GET', '/v1/health', () => ({ status: 'pass' }))
on('GET', '/v1/ping', () => new Raw(200, 'Pong!'))

// ---------------------------------------------------------------- routes: Users API (API key)

on('POST', '/v1/users', (ctx) => {
  requireKey(ctx)
  const body = ctx.json as {
    userId?: string
    email?: string
    password?: string
    name?: string
    phone?: string
  }
  return new Raw(201, publicUser(createUserRecord(body)))
})
on('GET', '/v1/users', (ctx) => {
  requireKey(ctx)
  return usersApi.list({ queries: ctx.queries })
})
on('GET', '/v1/users/:id', (ctx) => {
  requireKey(ctx)
  return usersApi.get({ userId: ctx.params.id ?? '' })
})
on('PATCH', '/v1/users/:id/verification', (ctx) => {
  requireKey(ctx)
  const user = userOr404(ctx.params.id ?? '')
  user.emailVerification = Boolean(ctx.json.emailVerification)
  user.$updatedAt = nowIso()
  return publicUser(user)
})
on('POST', '/v1/users/:id/tokens', (ctx) => {
  requireKey(ctx)
  const user = userOr404(ctx.params.id ?? '')
  return new Raw(201, makeToken(user.$id, true))
})
on('PUT', '/v1/users/:id/labels', (ctx) => {
  requireKey(ctx)
  return usersApi.updateLabels({
    userId: ctx.params.id ?? '',
    labels: (ctx.json.labels as string[]) ?? [],
  })
})
on('PATCH', '/v1/users/:id/status', (ctx) => {
  requireKey(ctx)
  return usersApi.updateStatus({ userId: ctx.params.id ?? '', status: Boolean(ctx.json.status) })
})
on('DELETE', '/v1/users/:id', async (ctx) => {
  requireKey(ctx)
  await usersApi.delete({ userId: ctx.params.id ?? '' })
  return new Raw(204, undefined)
})
on('GET', '/v1/users/:id/sessions', (ctx) => {
  requireKey(ctx)
  return usersApi.listSessions({ userId: ctx.params.id ?? '' })
})
on('DELETE', '/v1/users/:id/sessions', async (ctx) => {
  requireKey(ctx)
  await usersApi.deleteSessions({ userId: ctx.params.id ?? '' })
  return new Raw(204, undefined)
})

// ---------------------------------------------------------------- routes: Account (browser)

on('GET', '/v1/account', (ctx) => publicUser(requireAuth(ctx.req).user))
on('POST', '/v1/account', (ctx) => {
  const body = ctx.json as { userId?: string; email?: string; password?: string; name?: string }
  if (!body.email || !body.password) {
    throw new HttpError(400, 'general_argument_invalid', 'Email and password are required.')
  }
  return new Raw(201, publicUser(createUserRecord(body)))
})
on('POST', '/v1/account/sessions/email', (ctx) => {
  const email = String(ctx.json.email ?? '').toLowerCase()
  const user = [...users.values()].find((found) => found.email === email)
  if (!user?.password || user.password !== ctx.json.password) {
    throw new HttpError(
      401,
      'user_invalid_credentials',
      'Invalid credentials. Please check the email and password.',
    )
  }
  return new Raw(201, startSession(user, 'email', ctx.project, ctx.res))
})
for (const path of [
  '/v1/account/sessions/token',
  '/v1/account/sessions/magic-url',
  '/v1/account/sessions/phone',
]) {
  const handler: Handler = (ctx) => {
    const userId = String(ctx.json.userId ?? '')
    useToken(userId, String(ctx.json.secret ?? ''))
    const user = userOr404(userId)
    return new Raw(201, startSession(user, 'token', ctx.project, ctx.res))
  }
  on('POST', path, handler)
  on('PUT', path, handler)
}
on('POST', '/v1/account/tokens/email', (ctx) => {
  const email = String(ctx.json.email ?? '').toLowerCase()
  let user = [...users.values()].find((found) => found.email === email)
  if (!user) user = createUserRecord({ userId: String(ctx.json.userId ?? 'unique()'), email })
  const token = makeToken(user.$id, false)
  log(`TOKEN email-code token=${token.$id} user=${user.$id} (secret not logged)`)
  return new Raw(201, token)
})
on('GET', '/v1/account/sessions', (ctx) => {
  const { user, session } = requireAuth(ctx.req)
  const list = [...sessions.values()].filter((found) => found.userId === user.$id)
  return { total: list.length, sessions: list.map((found) => publicSession(found, session.$id)) }
})
on('GET', '/v1/account/sessions/:id', (ctx) => {
  const { user, session } = requireAuth(ctx.req)
  const id = ctx.params.id === 'current' ? session.$id : ctx.params.id
  const found = id ? sessions.get(id) : undefined
  if (!found || found.userId !== user.$id) throw notFound('user_session_not_found', 'Session')
  return publicSession(found, session.$id)
})
on('DELETE', '/v1/account/sessions/:id', (ctx) => {
  const { user, session } = requireAuth(ctx.req)
  const id = ctx.params.id === 'current' ? session.$id : ctx.params.id
  const found = id ? sessions.get(id) : undefined
  if (!found || found.userId !== user.$id) throw notFound('user_session_not_found', 'Session')
  if (found.$id === session.$id) endSession(found, ctx.project, ctx.res)
  else {
    sessions.delete(found.$id)
    sessionsBySecret.delete(found.secret)
  }
  return new Raw(204, undefined)
})
on('DELETE', '/v1/account/sessions', (ctx) => {
  const { user, session } = requireAuth(ctx.req)
  deleteUserSessions(user.$id)
  endSession(session, ctx.project, ctx.res)
  return new Raw(204, undefined)
})
for (const path of ['/v1/account/verification', '/v1/account/verifications/email']) {
  on('POST', path, (ctx) => {
    const { user } = requireAuth(ctx.req)
    const token = makeToken(user.$id, false)
    log(`TOKEN verification token=${token.$id} user=${user.$id}`)
    return new Raw(201, token)
  })
  on('PUT', path, (ctx) => {
    const userId = String(ctx.json.userId ?? '')
    useToken(userId, String(ctx.json.secret ?? ''))
    const user = userOr404(userId)
    user.emailVerification = true
    return { $id: newId(), $createdAt: nowIso(), userId, secret: '', expire: nowIso(), phrase: '' }
  })
}
on('POST', '/v1/account/jwts', (ctx) => {
  const { user, session } = requireAuth(ctx.req)
  return new Raw(201, { jwt: makeJwt(user.$id, session.$id) })
})
on('PATCH', '/v1/account/name', (ctx) => {
  const { user } = requireAuth(ctx.req)
  user.name = String(ctx.json.name ?? '')
  user.$updatedAt = nowIso()
  return publicUser(user)
})
on('PATCH', '/v1/account/password', (ctx) => {
  const { user } = requireAuth(ctx.req)
  if (user.password && user.password !== ctx.json.oldPassword) {
    throw new HttpError(401, 'user_invalid_credentials', 'Invalid credentials.')
  }
  user.password = String(ctx.json.password ?? '')
  user.passwordUpdate = user.$updatedAt = nowIso()
  return publicUser(user)
})
on('PATCH', '/v1/account/email', (ctx) => {
  const { user } = requireAuth(ctx.req)
  if (user.password && user.password !== ctx.json.password) {
    throw new HttpError(401, 'user_invalid_credentials', 'Invalid credentials.')
  }
  user.email = String(ctx.json.email ?? '').toLowerCase()
  user.emailVerification = false
  user.$updatedAt = nowIso()
  return publicUser(user)
})
on('GET', '/v1/account/prefs', (ctx) => requireAuth(ctx.req).user.prefs)
on('PATCH', '/v1/account/prefs', (ctx) => {
  const { user } = requireAuth(ctx.req)
  user.prefs = (ctx.json.prefs as Record<string, unknown>) ?? {}
  return publicUser(user)
})
on(
  'POST',
  '/v1/account/recovery',
  () =>
    new Raw(201, {
      $id: newId(),
      $createdAt: nowIso(),
      userId: '',
      secret: '',
      expire: nowIso(),
      phrase: '',
    }),
)

// ---------------------------------------------------------------- routes: Teams (browser)

function teamModel(teamId: string) {
  const members = teams.members(teamId) ?? []
  return {
    $id: teamId,
    $createdAt: nowIso(),
    $updatedAt: nowIso(),
    name: teamId,
    total: members.length,
    prefs: {},
  }
}
on('GET', '/v1/teams', (ctx) => {
  const { user } = requireAuth(ctx.req)
  const mine = teams
    .teamIds()
    .filter((teamId) => teams.members(teamId)?.some((membership) => membership.userId === user.$id))
    .map(teamModel)
  const { total, page } = applyQueries(mine, ctx.queries)
  return { total, teams: page }
})
on('GET', '/v1/teams/:id', (ctx) => {
  const { user } = requireAuth(ctx.req)
  const teamId = ctx.params.id ?? ''
  if (!teams.members(teamId)?.some((membership) => membership.userId === user.$id)) {
    throw notFound('team_not_found', 'Team')
  }
  return teamModel(teamId)
})
on('GET', '/v1/teams/:id/memberships', (ctx) => {
  const { user } = requireAuth(ctx.req)
  const teamId = ctx.params.id ?? ''
  const members = teams.members(teamId)
  if (!members?.some((membership) => membership.userId === user.$id))
    throw notFound('team_not_found', 'Team')
  const all = members.map((membership) => ({
    ...membership,
    $createdAt: nowIso(),
    $updatedAt: nowIso(),
    userName: '',
    userEmail: '',
    teamId,
    teamName: teamId,
    invited: nowIso(),
    joined: nowIso(),
    confirm: true,
    mfa: false,
  }))
  const { total, page } = applyQueries(all, ctx.queries)
  return { total, memberships: page }
})

// ---------------------------------------------------------------- routes: TablesDB (browser reads)

on('GET', '/v1/tablesdb/:db/tables/:table/rows', (ctx) => {
  const auth = authOf(ctx.req)
  const roles = rolesOf(auth?.user)
  if (ctx.params.db !== 'main') throw notFound('database_not_found', 'Database')
  const rows = db
    .rows(ctx.params.table ?? '')
    .filter((row) => allowed(row.$permissions as string[], 'read', roles))
  const { total, page, select } = applyQueries(rows, ctx.queries)
  return { total, rows: page.map((row) => pick(row, select)) }
})
on('GET', '/v1/tablesdb/:db/tables/:table/rows/:row', (ctx) => {
  const auth = authOf(ctx.req)
  const roles = rolesOf(auth?.user)
  if (ctx.params.db !== 'main') throw notFound('database_not_found', 'Database')
  const row = db.rows(ctx.params.table ?? '').find((found) => found.$id === ctx.params.row)
  if (!row || !allowed(row.$permissions as string[], 'read', roles))
    throw notFound('row_not_found', 'Row')
  const select = ctx.queries
    .map((query) => JSON.parse(query) as Query)
    .find((query) => query.method === 'select')?.values as string[] | undefined
  return pick(row, select)
})
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  on(method, '/v1/tablesdb/:db/tables/:table/rows', () => {
    throw new HttpError(
      401,
      'user_unauthorized',
      'The current user is not authorized to perform the requested action.',
    )
  })
  on(method, '/v1/tablesdb/:db/tables/:table/rows/:row', () => {
    throw new HttpError(
      401,
      'user_unauthorized',
      'The current user is not authorized to perform the requested action.',
    )
  })
}

// ---------------------------------------------------------------- routes: Functions

on('POST', '/v1/functions/:fn/executions', async (ctx) => {
  const auth = authOf(ctx.req)
  if (!auth)
    throw new HttpError(
      401,
      'user_unauthorized',
      'The current user is not authorized to perform the requested action.',
    )
  const functionId = ctx.params.fn ?? ''
  if (!HANDLERS[functionId]) throw notFound('function_not_found', 'Function')
  const body = ctx.json as {
    body?: string
    async?: boolean | string
    path?: string
    method?: string
    headers?: Record<string, string>
  }
  const isAsync = body.async === true || body.async === 'true'
  const now = nowIso()
  const execution: Execution = {
    $id: newId(),
    $createdAt: now,
    $updatedAt: now,
    $permissions: [`read("user:${auth.user.$id}")`],
    functionId,
    deploymentId: 'mock',
    trigger: 'http',
    status: isAsync ? 'waiting' : 'processing',
    requestMethod: (body.method ?? 'POST').toUpperCase(),
    requestPath: body.path ?? '/',
    requestHeaders: [],
    responseStatusCode: 0,
    responseBody: '',
    responseHeaders: [],
    logs: '',
    errors: '',
    duration: 0,
    scheduledAt: null,
    userId: auth.user.$id,
  }
  executions.set(execution.$id, execution)
  const run = async () => {
    const started = performance.now()
    execution.status = 'processing'
    try {
      const result = await runFunction(functionId, {
        method: execution.requestMethod,
        path: execution.requestPath,
        bodyText: body.body ?? '',
        headers: body.headers ?? {},
        auth,
      })
      execution.responseStatusCode = result.status
      // As Appwrite: an async execution keeps no response body.
      execution.responseBody = isAsync ? '' : JSON.stringify(result.body)
      execution.responseHeaders = [{ name: 'content-type', value: 'application/json' }]
      execution.status = result.status >= 400 ? 'failed' : 'completed'
    } catch (error) {
      execution.status = 'failed'
      execution.responseStatusCode = 500
      execution.errors = error instanceof Error ? error.name : 'Error'
      log(`EXEC-CRASH ${functionId} ${execution.$id} ${execution.errors}`)
    }
    execution.duration = (performance.now() - started) / 1000
    execution.$updatedAt = nowIso()
  }
  if (isAsync) {
    setTimeout(() => void run(), 0)
    return new Raw(202, publicExecution(execution))
  }
  await run()
  return new Raw(201, publicExecution(execution))
})
on('GET', '/v1/functions/:fn/executions/:id', (ctx) => {
  const { user } = requireAuth(ctx.req)
  const execution = executions.get(ctx.params.id ?? '')
  if (!execution || execution.functionId !== ctx.params.fn || execution.userId !== user.$id) {
    throw notFound('execution_not_found', 'Execution')
  }
  return publicExecution(execution)
})
on('GET', '/v1/functions/:fn/executions', (ctx) => {
  const { user } = requireAuth(ctx.req)
  const list = [...executions.values()].filter(
    (execution) => execution.functionId === ctx.params.fn && execution.userId === user.$id,
  )
  return { total: list.length, executions: list.map(publicExecution) }
})

// ---------------------------------------------------------------- routes: Storage (browser)

function bucketOr404(bucketId: string) {
  const bucket = BUCKETS[bucketId]
  if (!bucket) throw notFound('storage_bucket_not_found', 'Bucket')
  return bucket
}

on('POST', '/v1/storage/buckets/:bucket/files', async (ctx) => {
  const bucketId = ctx.params.bucket ?? ''
  const bucket = bucketOr404(bucketId)
  const auth = authOf(ctx.req)
  const roles = rolesOf(auth?.user)
  if (!bucket.create.some((role) => roles.has(role))) {
    throw new HttpError(
      401,
      'user_unauthorized',
      'The current user is not authorized to perform the requested action.',
    )
  }
  const form = await new Response(new Uint8Array(ctx.raw), {
    headers: { 'content-type': String(ctx.req.headers['content-type'] ?? '') },
  }).formData()
  const upload = form.get('file')
  if (!(upload instanceof Blob)) throw new HttpError(400, 'storage_file_empty', 'No file sent')
  const chunk = Buffer.from(await upload.arrayBuffer())
  const name = (upload as File).name ?? 'file'
  const extension = name.includes('.') ? (name.split('.').pop()?.toLowerCase() ?? '') : ''
  if (!bucket.extensions.includes(extension)) {
    throw new HttpError(
      400,
      'storage_file_type_unsupported',
      'The given file extension is not supported.',
    )
  }
  const permissions = form.getAll('permissions[]').map(String)
  for (const permission of permissions) {
    const role = PERMISSION.exec(permission)?.[2]
    if (!role || !roles.has(role)) {
      throw new HttpError(
        401,
        'user_unauthorized',
        `Permissions must be one of: (${[...roles].join(', ')})`,
      )
    }
  }
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(ctx.req.headers['content-range'] ?? ''))
  const total = range ? Number(range[3]) : chunk.length
  if (total > bucket.maxSize)
    throw new HttpError(400, 'storage_invalid_file_size', 'File size not allowed')
  const chunksTotal = Math.max(1, Math.ceil(total / CHUNK_SIZE))
  const uploadId =
    String(ctx.req.headers['x-appwrite-id'] ?? '') || String(form.get('fileId') ?? '')
  const fileId = !uploadId || uploadId === 'unique()' ? newId() : uploadId
  const key = `${bucketId}/${fileId}`
  let file = files.get(key)
  if (file && file.chunksUploaded === file.chunksTotal) {
    throw new HttpError(
      409,
      'storage_file_already_exists',
      'A storage file with the requested ID already exists.',
    )
  }
  if (!file) {
    const now = nowIso()
    file = {
      $id: fileId,
      bucketId,
      $createdAt: now,
      $updatedAt: now,
      $permissions:
        permissions.length > 0
          ? permissions
          : ['read', 'update', 'delete'].map((action) => `${action}("user:${auth?.user.$id}")`),
      name,
      signature: '',
      mimeType: '',
      sizeOriginal: total,
      chunksTotal,
      chunksUploaded: 0,
      encryption: true,
      compression: 'none',
      data: Buffer.alloc(0),
      chunks: new Map(),
    }
    files.set(key, file)
  }
  file.chunks.set(range ? Number(range[1]) : 0, chunk)
  file.chunksUploaded = file.chunks.size
  if (file.chunksUploaded === file.chunksTotal) {
    file.data = Buffer.concat(
      [...file.chunks.entries()].sort(([a], [b]) => a - b).map(([, part]) => part),
    )
    file.chunks = new Map()
    file.mimeType = sniffMime(file.data, upload.type)
    file.signature = randomBytes(16).toString('hex')
  }
  file.$updatedAt = nowIso()
  return new Raw(201, publicFile(file))
})

function readableFile(ctx: Ctx): StoredFile {
  bucketOr404(ctx.params.bucket ?? '')
  const file = getStored(ctx.params.bucket ?? '', ctx.params.file ?? '')
  const roles = rolesOf(authOf(ctx.req)?.user)
  if (!file || !allowed(file.$permissions, 'read', roles)) {
    throw new HttpError(404, 'storage_file_not_found', 'The requested file could not be found.')
  }
  return file
}

on('GET', '/v1/storage/buckets/:bucket/files', (ctx) => {
  bucketOr404(ctx.params.bucket ?? '')
  const roles = rolesOf(authOf(ctx.req)?.user)
  const list = [...files.values()]
    .filter(
      (file) => file.bucketId === ctx.params.bucket && allowed(file.$permissions, 'read', roles),
    )
    .map(publicFile)
  const { total, page } = applyQueries(list as never[], ctx.queries)
  return { total, files: page }
})
on('GET', '/v1/storage/buckets/:bucket/files/:file', (ctx) => publicFile(readableFile(ctx)))
on('GET', '/v1/storage/buckets/:bucket/files/:file/download', (ctx) => {
  const file = readableFile(ctx)
  return new Bytes(
    file.data,
    file.mimeType,
    `attachment; filename="${encodeURIComponent(file.name)}"`,
  )
})
on('GET', '/v1/storage/buckets/:bucket/files/:file/view', (ctx) => {
  const file = readableFile(ctx)
  return new Bytes(file.data, file.mimeType, `inline; filename="${encodeURIComponent(file.name)}"`)
})
on('GET', '/v1/storage/buckets/:bucket/files/:file/preview', (ctx) => {
  const file = readableFile(ctx)
  // No image processing: a raster file comes back as it is, anything else as a 1 px PNG.
  return ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimeType)
    ? new Bytes(file.data, file.mimeType, 'inline')
    : new Bytes(RASTER_PNG_1PX, 'image/png', 'inline')
})
on('DELETE', '/v1/storage/buckets/:bucket/files/:file', (ctx) => {
  bucketOr404(ctx.params.bucket ?? '')
  const file = getStored(ctx.params.bucket ?? '', ctx.params.file ?? '')
  const roles = rolesOf(authOf(ctx.req)?.user)
  if (!file || !allowed(file.$permissions, 'read', roles)) {
    throw new HttpError(404, 'storage_file_not_found', 'The requested file could not be found.')
  }
  if (!allowed(file.$permissions, 'delete', roles)) {
    throw new HttpError(
      401,
      'user_unauthorized',
      'The current user is not authorized to perform the requested action.',
    )
  }
  files.delete(`${file.bucketId}/${file.$id}`)
  return new Raw(204, undefined)
})

// ---------------------------------------------------------------- mock-only admin routes

// Runs a function's cron route (POST / with x-appwrite-trigger: schedule), as Appwrite's schedule would.
on('POST', '/mock/cron/:fn', async (ctx) => {
  const result = await runFunction(ctx.params.fn ?? '', {
    method: 'POST',
    path: '/',
    bodyText: '',
    headers: {},
    auth: undefined,
    trigger: 'schedule',
  })
  return result
})
// A route the mock lacks answers 404 and is counted here: global teardown fails the run on any,
// so a function that starts calling a new Appwrite API shows up rather than passing quietly.
let unhandled = 0
on('GET', '/mock/stats', () => ({
  unhandled,
  users: users.size,
  sessions: sessions.size,
  files: files.size,
  executions: executions.size,
  emailsSent,
  teams: teams.teamIds().length,
}))

// ---------------------------------------------------------------- server

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
  const started = performance.now()
  const url = new URL(req.url ?? '/', 'http://localhost')
  const method = (req.method ?? 'GET').toUpperCase()
  setCors(req, res)
  if (method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  let status = 200
  try {
    const raw = await readBody(req)
    const match = matchRoute(method, url.pathname)
    if (!match) {
      status = 404
      unhandled += 1
      log(`UNHANDLED ${method} ${url.pathname}`)
      send(res, 404, {
        message: `Mock has no route ${method} ${url.pathname}`,
        code: 404,
        type: 'general_route_not_found',
        version: '1.8.0',
      })
      return
    }
    let json: Record<string, unknown> = {}
    const contentType = String(req.headers['content-type'] ?? '')
    if (raw.length > 0 && contentType.includes('application/json')) {
      json = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    }
    const project =
      String(req.headers['x-appwrite-project'] ?? url.searchParams.get('project') ?? 'mock') ||
      'mock'
    const ctx: Ctx = {
      req,
      res,
      url,
      params: match.params,
      project,
      raw,
      json,
      queries: queriesOf(url, json),
    }
    const result = await match.route.handler(ctx)
    if (result instanceof Bytes) {
      res.writeHead(200, {
        'content-type': result.mimeType,
        'content-length': String(result.data.length),
        'content-disposition': result.disposition,
      })
      res.end(result.data)
    } else if (result instanceof Raw) {
      status = result.status
      if (typeof result.body === 'string') {
        res.writeHead(status, { 'content-type': 'text/plain' })
        res.end(result.body)
      } else send(res, status, result.body)
    } else send(res, 200, result)
  } catch (error) {
    if (error instanceof HttpError || error instanceof AppwriteException) {
      status = error instanceof HttpError ? error.status : error.code
      send(res, status, {
        message: error.message,
        code: status,
        type: error.type,
        version: '1.8.0',
      })
    } else {
      status = 500
      log(`CRASH ${method} ${url.pathname} ${error instanceof Error ? error.name : 'unknown'}`)
      send(res, 500, {
        message: 'Mock server error',
        code: 500,
        type: 'general_server_error',
        version: '1.8.0',
      })
    }
  } finally {
    const ms = Math.round(performance.now() - started)
    if (status >= 400 || process.env.MOCK_VERBOSE)
      log(`${method} ${url.pathname} ${status} ${ms}ms`)
  }
}

// Realtime: the websocket handshake (RFC 6455, 4.2.2), then silence. The app's pages refetch on
// their own; no event is ever pushed, so no frame is ever written, and frames read are dropped.
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const handleUpgrade = (req: http.IncomingMessage, socket: Duplex) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const key = req.headers['sec-websocket-key']
  if (url.pathname !== '/v1/realtime' || typeof key !== 'string') {
    socket.destroy()
    return
  }
  const accept = createHash('sha1')
    .update(key + WEBSOCKET_GUID)
    .digest('base64')
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  socket.on('data', () => undefined)
  socket.on('error', () => undefined)
}

// Both loopbacks, so `localhost` works whichever one a client resolves it to; nothing else.
for (const host of ['127.0.0.1', '::1']) {
  const server = http.createServer((req, res) => void handleRequest(req, res))
  server.on('upgrade', handleUpgrade)
  server.on('error', (error) => {
    if (host === '::1') log(`MOCK no IPv6 loopback (${(error as NodeJS.ErrnoException).code})`)
    else {
      log(`MOCK cannot listen on ${host}:${PORT}: ${(error as NodeJS.ErrnoException).code}`)
      process.exit(1)
    }
  })
  server.listen(PORT, host, () => log(`MOCK listening on http://localhost:${PORT}/v1 (${host})`))
}
