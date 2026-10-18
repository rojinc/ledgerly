# Decision log

The important architecture decisions, why we made them, and what we gave up. **Don't reopen a decision in code.** If you think one is wrong, open an issue labelled `decision` and propose a new entry that supersedes it.

Format: ID, date, status (`accepted`, `superseded by D-xxx`), decision, why, trade-off.

---

### D-001: One ledger for every module
*2026-10-18 · accepted*

**Decision:** Employer, house, personal and lend/borrow are all *groups* with *transactions* whose *shares* record what each person gave and received.
**Why:** One set of tables, one set of money rules and one set of tests. Reports across modules come for free, and nothing gets entered twice.
**Trade-off:** Some UI words ("given/received") need translating into module language ("worked", "paid", "lent").

### D-002: Appwrite Cloud as the whole backend
*2026-10-18 · accepted*

**Decision:** Auth, database, storage, realtime and functions all come from Appwrite Cloud. No separate API server.
**Why:** The founder chose Appwrite, and one platform is less to run. TablesDB transactions cover our atomicity needs.
**Trade-off:** We live within Appwrite's limits (transaction size, 30 s sync timeout, query features). Every money write is behind one function API, so the ledger could move to Postgres later without changing clients.

### D-003: Clients never write to the database
*2026-10-18 · accepted*

**Decision:** Tables grant clients read only. Every write goes through a function. The one exception: clients upload receipt files to Storage directly.
**Why:** Money writes need validation, several rows written atomically, and an audit trail. With a single rule there are no special cases for agents to remember.
**Trade-off:** Writes are slower than direct SDK writes (function round trip). Optimistic UI hides it.

### D-004: One Appwrite Team per group; authority lives in `members`
*2026-10-18 · accepted*

**Decision:** Team ID = group ID. Rows carry `read("team:<groupId>")`. Roles and permissions are checked in functions against `members.role`. Appwrite team roles are not used.
**Why:** Joining or leaving changes one membership instead of rewriting row permissions. And there is one source of truth for authority.
**Trade-off:** Placeholders (no account) appear in `members` but not in the team; functions keep the two in step.

### D-005: Integer cents and local-date strings
*2026-10-18 · accepted*

**Decision:** Money is stored as integer cents. Calendar dates are `YYYY-MM-DD` strings in the group's timezone. Instants are UTC `datetime`.
**Why:** Floats lose cents, and UTC timestamps move a Thursday shift to Wednesday for Australian users.
**Trade-off:** All date maths must go through the helpers in `packages/core`.

### D-006: Plain ID columns, no relationship columns
*2026-10-18 · accepted*

**Decision:** References are `varchar(36)` columns, not Appwrite relationship columns.
**Why:** Explicit, predictable queries; bulk operations don't support tables with relationship columns; easier to move later.
**Trade-off:** We load related rows ourselves.

### D-007: Shares are rebuilt, not patched, and may copy transaction fields
*2026-10-18 · accepted*

**Decision:** Every write deletes and recreates a transaction's shares (and items). Shares copy `groupId`, `date`, `kind` and `category`.
**Why:** Rebuilding means copied fields can't drift, and one index can answer "my spending by category this month".
**Trade-off:** A few more operations per write.

### D-008: Deterministic IDs for generated rows, client IDs for user rows
*2026-10-18 · accepted*

**Decision:** Schedule occurrences use `<scheduleId>_<YYYYMMDD>`. User-created rows use an ID made by the client.
**Why:** Retries and repeated cron runs can't create duplicates, and we need no extra "dedupe key" column.
**Trade-off:** Schedule IDs must be 20-character `ID.unique()` values.

### D-009: Placeholders are persons; linking needs a verified identity
*2026-10-18 · accepted*

**Decision:** Anyone can be added by email or phone as a placeholder person. Records link to a user only through an identity they verified in Appwrite Auth.
**Why:** It works with people who never sign up, without letting anyone take over someone else's history.
**Trade-off:** Merges are multi-step and must be resumable.

### D-010: Closed periods never change
*2026-10-18 · accepted*

**Decision:** Final statements lock their transactions. Corrections are `adjustment` transactions on the next statement. Only the latest statement can be voided.
**Why:** Invoices that were sent must stay true, and openings always chain correctly.
**Trade-off:** Fixing an old mistake shows up as a new line, not an edit.

### D-011: Resend for all outgoing email
*2026-10-18 · accepted*

**Decision:** Functions send every email through Resend. Appwrite Auth uses Resend as its custom SMTP.
**Why:** Appwrite Messaging only reaches project users, and we must email non-users (employers). One email path is simpler.
**Trade-off:** One more vendor.

### D-012: npm workspaces monorepo with no barrel files
*2026-10-18 · accepted*

**Decision:** One repo with `apps/`, `packages/`, `functions/`. Packages expose subpath exports (`@ledgerly/core/money`) instead of `index.ts` barrels.
**Why:** Shared types, one CI, atomic contract changes. Without barrels, parallel agents don't conflict on the same index file.
**Trade-off:** Import paths are a little longer.

### D-013: Docs live in the repo; GitBook mirrors `docs/`
*2026-10-18 · accepted*

**Decision:** `docs/` is the single source of truth. GitBook shows it through Git Sync.
**Why:** Docs change in the same PR as code, so they can't drift. Agents can read them locally.
**Trade-off:** Edits made in the GitBook editor must go back through Git Sync, never be kept only in GitBook.

### D-014: We record money; we don't move it
*2026-10-18 · accepted*

**Decision:** No payments, wallets or bank connections. Settlements are recorded after they happen outside the app.
**Why:** Moving money brings licensing, compliance and fraud work that this product doesn't need.
**Trade-off:** Users pay each other outside the app (we show bank details and PayID).

### D-015: The lead agent runs the project day to day
*2026-10-18 · accepted*

**Decision:** The owner handed day-to-day decisions to the lead agent: priorities, task specs, contract approvals, design decisions, reviews and merging every PR. The owner keeps accounts, billing, secrets, console access and approval of production releases. The lead is the Claude Code session that started the work in October 2026; if it ends, a new lead takes over by adding a decision that supersedes this one.
**Why:** The owner asked to step back, and work shouldn't stall waiting for a person.
**Trade-off:** No human looks at a PR before it merges. To make up for it, every PR is reviewed by a different agent, CI must be green, `security` PRs get a security pass, and design decisions are written down here so the owner can check them at any time.

### D-016: Being added to a group doesn't make you a member; you join
*2026-10-18 · accepted*

**Decision:** A member added by someone else always starts as `placeholder`, even when the person already has an account. They join (become `active` and enter the group's team) only by their own action: claim through a verified identity, accepting an invite, or joining from the app. Claim joins the groups they were added to before they had an account (`persons.claimedAt`). Person IDs are random, with no timestamp. When an email and a phone point at different persons, the email decides.
**Why:** Making registered people `active` at once showed the adder whether an email or phone has an account, and put people into groups of strangers without asking.
This refines [D-004](#d-004-one-appwrite-team-per-group-authority-lives-in-members): `placeholder` members now include registered people who haven't joined.
**Trade-off:** A registered person added to a group sees only its name and type, as pending, until they join. The list-and-join routes are needed by M2 pair groups (#34), so they ship there. In M1 this rarely matters, because employers are usually placeholders.
