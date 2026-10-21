# Dev checks

The checks on `ledgerly-dev` that only the lead can run, from [#299](https://github.com/rojinc/ledgerly/issues/299) section 5, in one sitting ([#569](https://github.com/rojinc/ledgerly/issues/569)). Every merge to `main` deploys, so any time after a green Deploy run will do. Follow it top to bottom. The parts that need a link from an email wait for Resend ([#3](https://github.com/rojinc/ledgerly/issues/3)) and are in [After #3](#7-after-3).

**Who runs what:**
- **The owner** makes and deletes the one-off API key, runs [first-deploy 3c](first-deploy.md#3c-the-session-check-279) in their browser, and reads the console settings in 2c if the lead can't. Accounts, secrets and the console are the owner's ([D-015](../architecture/decisions.md#d-015-the-lead-agent-runs-the-project-day-to-day)).
- **The lead** runs everything else, with the key the owner hands over.
- **No other agent** runs any of it (AGENTS.md).

**What writes:**
- **Two test users,** A (with a password) and C (without), at Resend test addresses. Their first sign-in makes their own rows ([bootstrap](../architecture/identity-and-invites.md#first-login-bootstrap)).
- **As A, in the app:** a house and a pair, each with one placeholder; one transaction in each of A's three groups; one bill; one invite; and A's email change. A's `persons` row counts one wrong address.
- **As C:** a first password.
- **[First-deploy 3b](first-deploy.md#3b-the-backfills-305-and-342)'s two backfills,** with the owner's second key, if they haven't run.
- **The owner's one-off keys,** deleted at the end.

[Clean up](#6-clean-up) hands A and C to the `account` job, which deletes them with every row they made, as an account deletion does ([#386](https://github.com/rojinc/ledgerly/issues/386)).

| # | Check | Issue | Who | Step | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | The JWT carries `sessionId` | #279 | owner | [first-deploy 3c](first-deploy.md#3c-the-session-check-279) | to run |
| 2 | A first password fires its event | #289 | lead | [4a](#4a-a-first-password-fires-its-event-289); the reset half [after #3](#7-after-3) | to run |
| 3 | The auth settings and web platforms | #316 | lead or owner | [2c](#2c-the-auth-settings-and-web-platforms-316), [4b](#4b-a-recovery-request-from-the-app-316) | to run |
| 4 | No placeholder has two identities | #304 | lead | [2a](#2a-no-placeholder-has-two-identities-304) | to run |
| 5 | The bundle sizes | #270 | lead, owner | [2b](#2b-the-statements-deployments-size-270) | web half ✅ done |
| 6 | Each deploy notice names only what changed | #313 | — | [1](#1-already-done) | ✅ done |
| 7 | An invite by hand, from a house and a pair | #371, #412, #417 | lead, owner | [after #3](#7-after-3) | waits for #3 |
| 8 | A wrong address counts once | #274 | lead | [4c](#4c-a-wrong-address-counts-once-274) | to run |
| 9 | The `orphanedAt` and receipt-files backfills | #342, #305 | lead | [first-deploy 3b](first-deploy.md#3b-the-backfills-305-and-342) | to run |
| 10 | The hourly intervals | — | lead | [5a](#5a-the-hourly-runs) | mostly done |
| 11 | An email change on Profile | #403 item 5, #416 | lead | [4e](#4e-an-email-change-on-profile-416), last for A; the link [after #3](#7-after-3) | to run |
| 12 | History across groups | #424 | lead | [4d](#4d-history-across-groups-424) | search on dev ✅ done |
| 13 | A blocked send logs once | #469, #475 | lead | [5b](#5b-a-blocked-send-logs-once-469) | to run |

## Before you start

- **Tools,** as for [first-deploy](first-deploy.md#before-you-start): `appwrite-cli@28.7.0`, `jq`, Node from `.nvmrc`, and a checkout of `main` after `npm ci`. Run every command from the checkout's root.
- **A one-off key** (owner: Appwrite → Overview → Integrations → API keys), deleted in [6](#6-clean-up). Its scopes are only those these steps need: `tables.read`, `rows.read`, `users.read`, `users.write`, `execution.read` and `functions.read`. First-deploy 3b's backfills use their own second key, as that step says. If a command fails with `missing scopes (["…"])`, the server is naming the scope it accepts there: add that one.
- **Point the CLI at dev** with [first-deploy's snippet](first-deploy.md#before-you-start): the key is read with `read -rs`, and never `--project-id`.
- **Note the start time:** `export SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)`. Steps 4 and 5 read the runs since then.
- **Test data:** every address these steps make or type is `delivered+$RUN-<label>@resend.dev`, with `$RUN` from [3a](#3a-make-a-and-c). That's the only shape the `account` job deletes (`E2E_ADDRESS` in `functions/account/src/routes/hourly-job.ts`), and Resend never delivers it to a person. Never type a real address or a phone number, and never read or change a real user's rows: the only step that reads others' rows is 2a, which prints IDs.
- **Print IDs, counts and flags, never addresses or names.** The commands below pipe through `jq` for that.

## 1. Already done

No Appwrite access is needed for these.

- **6, #313:** ✅ each notice names only what changed. The lead read the "Choose what to deploy" notices of Deploy runs 174, 181, 195, 196, 214 and 220 (16:2x on #569).
- **5, #270's web half:** ✅ the main chunk is 314.38 kB gzip at Deploy run 174 and 316.71 kB at run 220, against 311.73 kB on `f83f46f`. That's the +15 kB gzip from `rrule` the lead accepted ([#270](https://github.com/rojinc/ledgerly/issues/270#issuecomment-6294377539)).
- **12, #424's search on dev:** ✅ the description search's `contains` with no index works on dev (the lead, [20 October 09:55](https://github.com/rojinc/ledgerly/issues/96#issuecomment-6288311576)). [4d](#4d-history-across-groups-424) checks the rest in the app.
- **10, the intervals:** first-deploy 4a passed at 03:47 on 21 October, and nightly read 1 found a longest gap of 60 minutes. Only identity's second run was never posted: [5a](#5a-the-hourly-runs) covers it.

## 2. With the key, before any test user

### 2a. No placeholder has two identities (#304)

A placeholder made from keys nobody knows stores one identity (#304's H1). The lead checked dev before that build. This checks again now that it's deployed. A placeholder is a person with no `userId`, `mergedInto` or `deletedAt` (`isPlaceholder()` in `packages/server/src/identity/resolve-person.ts`). The `identities` table is read for `personId` only, never `key`, which holds the address or phone.

```bash
rows() {  # every row of a table, by $id cursor; extra --queries pick the columns
  local table=$1 after="" out; shift
  while :; do
    out=$(appwrite tablesdb list-rows --database-id main --table-id "$table" --json \
      --queries '{"method":"limit","values":[100]}' \
      ${after:+--queries "{\"method\":\"cursorAfter\",\"values\":[\"$after\"]}"} "$@")
    jq -c '(.rows // [])[]' <<<"$out"
    [ "$(jq '(.rows // []) | length' <<<"$out")" -lt 100 ] && break
    after=$(jq -r '.rows[-1]["$id"]' <<<"$out")
  done
}
twice=$(rows identities --queries '{"method":"select","values":["$id","personId"]}' \
  | jq -rs 'group_by(.personId) | map(select(length > 1) | .[0].personId) | .[]')
echo "persons with two or more identities: $(grep -c . <<<"$twice")"
for p in $twice; do
  appwrite tablesdb get-row --database-id main --table-id persons --row-id "$p" --json \
    | jq -r 'select((.userId // "") == "" and (.mergedInto // "") == "" and (.deletedAt // "") == "") | "placeholder \(.["$id"])"'
done
```

- **Pass:** no `placeholder` line. People with an account can hold more than one identity, so the first count needn't be 0.
- **If it fails:** post the person IDs on #299, and file an issue for the lead. Nothing is changed here: which key to keep is the lead's call ([#252](https://github.com/rojinc/ledgerly/pull/252)).

### 2b. The statements deployment's size (#270)

`statements` carries the CJK and emoji fonts, about 15.4 MB packed, which AI E measured at 51% of Appwrite's self-hosted default of 30 MB. Cloud's plan sets its own limit and doesn't publish it ([#270](https://github.com/rojinc/ledgerly/issues/270#issuecomment-6268376673)).

```bash
dep=$(appwrite functions get --function-id statements --json | jq -r '.deploymentId')
appwrite functions get-deployment --function-id statements --deployment-id "$dep" --json \
  | jq '{id: .["$id"], status} + with_entries(select(.key | test("size"; "i")))'
```

- **Pass:**
  - the active deployment is `ready`, with its size fields printed;
  - the owner reads the plan's deployment size limit (the console's manual-deployment dialog, or the plan's page);
  - the size is under it, as every Deploy since run 174 shows.
- **If the limit is under 19.3 MB:** the font choice goes back to the lead, as AI E's measurements said. Post the size and the limit on #299.
- **If `deploymentId` is empty:** the console's Functions → statements → Deployments shows the active one and its size.

### 2c. The auth settings and web platforms (#316)

No deploy pushes these. The lead reads them with the Appwrite MCP, or the owner in the console (Auth → Security, Auth → Settings, and Overview → Platforms).

| Setting | Expected ([environments](environments-and-deploys.md#environments)) |
| --- | --- |
| Session invalidation | on, since 2026-10-19 |
| Password history, personal data check, password dictionary | no doc sets them: post each value, for the lead to call |
| Auth methods | email + password and email OTP on. Magic URL, anonymous and team invites off |
| Email verification | on, with Resend as custom SMTP |
| Membership privacy | members see only each other's user ID |
| Web platforms | the app's domain, `ledgerly.appwrite.network`; `localhost` is a known gap, waiting for the owner on #78 |

- **Pass:** each row as expected, and the three values posted.
- **If it fails:** the owner changes the setting in the console, since no deploy does, and the lead posts what changed on #299.

### 2d. The owner's steps

- **9 (#342, #305):** run [first-deploy 3b](first-deploy.md#3b-the-backfills-305-and-342) as written, if it hasn't run. Its first command says whether #305's has.
- **1 (#279):** the owner runs [first-deploy 3c](first-deploy.md#3c-the-session-check-279) as written, in their own browser.

## 3. The test users

### 3a. Make A and C

```bash
export RUN=$(node -e "console.log('e2e' + Date.now().toString(36) + require('node:crypto').randomBytes(3).toString('hex'))")
export A_ID=$(node -e "console.log(require('node:crypto').randomUUID())")
export C_ID=$(node -e "console.log(require('node:crypto').randomUUID())")
read -rs A_PASSWORD   # A's password, typed here and in the app, never on the command line's history
appwrite users create --user-id "$A_ID" --email "delivered+$RUN-a@resend.dev" --password "$A_PASSWORD" --name "A $RUN" --json | jq -r '"made \(.["$id"])"'
appwrite users create --user-id "$C_ID" --email "delivered+$RUN-c@resend.dev" --name "C $RUN" --json | jq -r '"made \(.["$id"])"'
for id in "$A_ID" "$C_ID"; do
  appwrite users update-email-verification --user-id "$id" --email-verification=true --json | jq -r '"\(.["$id"]) verified \(.emailVerification)"'
done
echo "run $RUN"
```

Both are marked verified, as the e2e flows' users are, because no one can open a test inbox (`apps/web/e2e/dev-project.ts`). C has no password, like an account made with an email code.

### 3b. A's groups, as A

In a private window, sign in to the app as A (`delivered+$RUN-a@resend.dev` and A's password). Then, in the app:
1. **A house,** "House $RUN", with one housemate added by name, "P $RUN", and email `delivered+$RUN-p@resend.dev`.
2. **A pair** (New lend & borrow) with "Q $RUN", at `delivered+$RUN-q@resend.dev`.
3. **One transaction in each of A's three groups:** an expense in the house, a loan in the pair and an expense in the personal group, with the words alpha, bravo and charlie in their descriptions.
4. **A bill in A's personal group, due tomorrow,** for [5b](#5b-a-blocked-send-logs-once-469).

## 4. The checks

### 4a. A first password fires its event (#289)

Setting a first password fires `users.<id>.update.password`, and identity's event run logs `password_notice` with the user's ID ([password notice](../architecture/identity-and-invites.md#password-notice)).

1. **Sign in as C** in another private window. C has no password, so use a token, as the e2e flows do (`logInWithToken()` in `apps/web/e2e/users.ts`). The token expires after 15 minutes:

   ```bash
   appwrite users create-token --user-id "$C_ID" --json | jq -r .secret
   ```

   On the app's `/login` page, in the developer console:

   ```js
   (async () => {
     const userId = '<C_ID>'
     const secret = '<the secret>'
     const res = await fetch('https://syd.cloud.appwrite.io/v1/account/sessions/token', {
       method: 'POST',
       credentials: 'include',
       headers: { 'content-type': 'application/json', 'x-appwrite-project': 'ledgerly-dev' },
       body: JSON.stringify({ userId, secret }),
     })
     if (!res.ok) return console.error('Signing in with the token failed:', res.status)
     // Kept as the SDK keeps it when the browser won't take Appwrite's cookie.
     const fallback = res.headers.get('X-Fallback-Cookies')
     if (fallback) localStorage.setItem('cookieFallback', fallback)
     location.assign('/')
   })()
   ```

2. **As C, set a password on Profile.**
3. **Read identity's event runs** since `$SINCE`. 4e reads the same runs.

   ```bash
   notices() {
     appwrite functions list-executions --function-id identity --json \
       --queries '{"method":"equal","attribute":"trigger","values":["event"]}' \
       --queries "{\"method\":\"greaterThan\",\"attribute\":\"\$createdAt\",\"values\":[\"$SINCE\"]}" \
       --queries '{"method":"orderDesc","attribute":"$createdAt"}' \
       --queries '{"method":"limit","values":[10]}' \
       | jq -r '(.executions // [])[] | "== \(.["$id"]) \(.["$createdAt"]) \(.status) \(.responseStatusCode)", (((.errors // "") + "\n" + (.logs // "")) | split("\n")[] | fromjson? | select(.event == "password_notice" or .event == "change_notice") | "\(.event) user \(.userId // "-") \(.outcome // "-") \(.cause // "-")")'
   }
   notices
   ```

- **Pass:** a run with `password_notice user <C_ID>`, and an outcome of `sent`, or `failed` with a blocked send's cause (`EmailError validation_error 403`) while #3 is open. The ID in the line comes from the event's name, so it shows the event carried it.
- **If it fails:**
  - **No event run after 2 minutes:** the event didn't fire, or identity isn't subscribed. Check identity's events in the console against [function settings](environments-and-deploys.md#function-settings).
  - **A run with `FORBIDDEN`:** the event's name didn't match. Post the run's ID and code on #299 (AI A wrote the route).

### 4b. A recovery request from the app (#316)

#316's way to show the app's domain is a registered platform: Appwrite refuses a recovery whose link points at an unregistered host. **Signed out**, on the app's **Forgot your password?** page, ask for a link for `delivered+$RUN-a@resend.dev`.

- **Pass:** "If that address has an account, we've sent a link. It works for 1 hour." Nobody can open the email: that's fine, since the request is all this checks.
- **If it fails:** the generic error. Look in the browser's network panel for Appwrite's `type`: a URL or host error means the domain isn't a web platform, which is the owner's to add (2c).
- **`localhost`:** the same request from `npm run dev`. It's expected to fail until #78.

### 4c. A wrong address counts once (#274)

Every invite to a placeholder counts one address check on the sender's `persons` row before the address is looked at. A right address that's sent takes its count back in the transaction that commits the invite, even if the email then fails ([invites](../architecture/identity-and-invites.md#invites), step 2). No email is needed.

```bash
misses() {
  appwrite tablesdb list-rows --database-id main --table-id persons --json \
    --queries "{\"method\":\"equal\",\"attribute\":\"userId\",\"values\":[\"$A_ID\"]}" \
    --queries '{"method":"select","values":["$id","addressMisses","addressMissesFrom"]}' \
    | jq -r '(.rows // [])[] | "A \(.["$id"]) misses \(.addressMisses // 0) since \(.addressMissesFrom)"'
}
misses
```

1. **As A,** in the house's members list, use **Invite by email** for P, with `delivered+$RUN-wrong@resend.dev`. The app answers "This email address isn't one this person was added with." Run `misses`.
2. **Then the right address,** `delivered+$RUN-p@resend.dev`. While #3 is open the email fails after the invite is saved, and the app shows an error. Run `misses` again.

- **Pass:** `misses 1` after step 1, and still `misses 1` after step 2.
- **If it fails:**
  - **2 after step 1:** one wrong address counted twice.
  - **2 after step 2:** the right address didn't take its count back.

  Post the numbers on #299.

### 4d. History across groups (#424)

As A, open History.
- **Pass:**
  - it opens on **All groups**, with the three transactions from 3b, each showing its group's name;
  - searching "bravo" leaves only the pair's row;
  - picking the house, then P in the person filter, leaves only the house's rows with P. Under All groups the person filter doesn't apply, by design.
- **If it fails:** post what was missing or extra on #299.

### 4e. An email change on Profile (#416)

Do this last for A, since A's address is unverified afterwards and A's invites stop. As A, on Profile, change the email to `delivered+$RUN-a2@resend.dev`, with A's password. Then:

```bash
appwrite users get --user-id "$A_ID" --json | jq -r '"A emailVerification \(.emailVerification)"'
notices
```

- **Pass:** these three ([change notice](../architecture/identity-and-invites.md#email-and-phone-change-notice), "Dev checks"):
  - `emailVerification false`;
  - a run with `change_notice user <A_ID>`, so the event fired with the user's ID;
  - its outcome is `sent`, or `failed` with a blocked send's cause while #3 is open. It must not be `mismatch`.
- **If it fails:** post the run's ID and its line on #299.

## 5. After an hour or two

### 5a. The hourly runs

`identity`, `account`, `scheduler` and `statements` each run every 60 minutes. Run [first-deploy 4a](first-deploy.md#4a-the-hourly-runs)'s command with `export DEPLOYED_AT=$SINCE`.

- **Pass:** each function has two runs about 60 minutes apart, `completed` with `200`, identity's included.

### 5b. A blocked send logs once (#469)

While sends are blocked (#3), each step stops at its first blocked email, logs one line, and changes nothing ([conventions](conventions.md#functions)). A's bill from 3b is due tomorrow, so the scheduler's reminder step tries it from 07:00 in the group's time zone. 4e gave identity its change notice.

1. **Run [first-deploy 4b](first-deploy.md#4b-a-blocked-send-logs-once-469)'s command** with `export DEPLOYED_AT=$SINCE`.
2. **A's bill is still unreminded:**

   ```bash
   person=$(appwrite tablesdb list-rows --database-id main --table-id persons --json \
     --queries "{\"method\":\"equal\",\"attribute\":\"userId\",\"values\":[\"$A_ID\"]}" | jq -r '.rows[0]["$id"]')
   group=$(appwrite tablesdb list-rows --database-id main --table-id groups --json \
     --queries "{\"method\":\"equal\",\"attribute\":\"ownerPersonId\",\"values\":[\"$person\"]}" \
     --queries '{"method":"equal","attribute":"type","values":["personal"]}' | jq -r '.rows[0]["$id"]')
   appwrite tablesdb list-rows --database-id main --table-id transactions --json \
     --queries "{\"method\":\"equal\",\"attribute\":\"groupId\",\"values\":[\"$group\"]}" \
     --queries '{"method":"select","values":["$id","kind","remindedAt"]}' \
     | jq -r '(.rows // [])[] | "\(.["$id"]) \(.kind) remindedAt \(.remindedAt)"'
   ```

- **Pass:**
  - at most one `reminder_failed` line per scheduler run, with a blocked send's cause, while the reminder is due;
  - one `change_notice` under identity;
  - the bill's `remindedAt` is still `null`.

  If 1b of first-deploy now shows sends work, the bill's reminder goes instead, and `remindedAt` is set: that's a pass too.
- **`statements`:** these steps set up no ready email or auto-send, so its line isn't tested here. First-deploy 4b's earlier pass stands.
- **If it fails:** two or more lines with the same event and a blocked cause in one run mean the step didn't stop. Post the function, event and count on #299 (AI A wrote #475).

## 6. Clean up

- **Hand A and C to the `account` job:** label `e2e` and block, as the e2e flows' teardown does (`handOverRunUsers()`). The job deletes each within about two hours, with every row they made, A's house and pair included.

  ```bash
  [[ "$RUN" =~ ^e2e[a-z0-9]{10,}$ ]] || echo "Not a run ID: stop"
  for id in "$A_ID" "$C_ID"; do
    appwrite users update-labels --user-id "$id" --labels e2e --json >/dev/null
    appwrite users update-status --user-id "$id" --status=false --json | jq -r '"\(.["$id"]) handed over: blocked \(.status == false)"'
  done
  ```

  After A's email change, A's address is `delivered+$RUN-a2@resend.dev`, which still has the job's shape. P's and Q's member rows go with A's groups, and scheduler step 5c clears the two placeholders 30 days later.
- **The owner deletes the one-off key,** and the backfills' key if 2d made one.
- **The lead posts the results on #299,** one line per check, with counts, IDs and pass or fail only. For example, `dev check 8 (#274): pass · misses 1, then 1`. Then tick #299 section 5.

## 7. After #3

Once Resend delivers from our domain ([first-deploy 1b](first-deploy.md#1b-what-resend-answers) gives `HTTP 200`), these need a link from an email. Emails to `delivered+…@resend.dev` are accepted but reach no inbox. So the owner opens each one in Resend's dashboard (Emails), if it shows the body, or the step uses an address the owner can read, with that account deleted in the app (Profile → Delete account) afterwards.

- **2, the reset half (#289):** request a reset for a test user, open the link, and set a new password. `notices` then shows a run with `password_notice user <id>`, from `users.<id>.recovery.<tokenId>.update`.
- **7, an invite by hand (#371, #412, #417):**
  1. A sends **Invite by email** from a house's members list, and from a pair's Settings.
  2. The invitee signs up from each link, verifies, and lands in the group.
  3. Each group then shows them as joined.
- **11, the new address's link (#416):** after 4e, the new address gets its verification link, and each old verified address gets the change notice.

## Not in this runbook

The change notice's other dev checks ([change notice](../architecture/identity-and-invites.md#email-and-phone-change-notice), "Dev checks") can't be reached from the app today:
- **A phone change:** phones are cut from v1 (#175).
- **An account with no password changing its email:** Profile asks it to set a password first (F-01).
- **A user ID with a `.`:** the app makes IDs with `ID.unique()`.
