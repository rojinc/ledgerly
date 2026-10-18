# Local setup

> The code doesn't exist yet. The commands below start working as the M0 tasks land; each step names the task that enables it.

## Prerequisites

| Tool | Version | Install |
| --- | --- | --- |
| Node.js | 24 LTS (see `.nvmrc`) | `nvm install` or nodejs.org |
| npm | ships with Node | none |
| Git | any recent version | none |
| GitHub CLI | any recent version | `brew install gh` |
| Appwrite CLI | latest | `brew install appwrite` or `npm i -g appwrite-cli` |

## First time

```bash
git clone https://github.com/rojinc/ledgerly.git
cd ledgerly
npm ci                      # M0: monorepo tooling
cp .env.example .env.local  # then fill in the dev values below
```

`.env.local` for the web app (values from the owner, never committed):

```
VITE_APPWRITE_ENDPOINT=https://<region>.cloud.appwrite.io/v1
VITE_APPWRITE_PROJECT_ID=<dev project id>
```

## Everyday commands

```bash
npm run dev          # web app on http://localhost:5173 against the dev project (M0: web shell)
npm test             # unit tests (M0)
npm run lint         # Biome (M0)
npm run typecheck    # TypeScript (M0)
npm run build        # web build + function bundles (M0)
```

## Working on functions

- Functions are bundled with esbuild into `functions/<name>/dist/main.js` (`npm run build -w @ledgerly/fn-<name>`).
- Unit-test handlers with the fake database (`npm test -w @ledgerly/fn-ledger`). That is the main feedback loop.
- To try a function against the dev project, push only that function: `appwrite push function --config-file appwrite.config.json` and pick it. **Never push tables by hand.** Schema changes deploy through CI after merge ([Environments](environments-and-deploys.md#schema-changes)).
- `appwrite run function` can run a function locally in Docker, if you have Docker.

## Working as an agent

Use your **own git worktree** for every task, so parallel agents never share a working directory:

```bash
git fetch origin
git worktree add ../ledgerly-17 -b feat/17-ledger-function origin/main
cd ../ledgerly-17 && npm ci
```

Remove it after the PR merges: `git worktree remove ../ledgerly-17`.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `401` from Appwrite in the web app | Check `VITE_APPWRITE_PROJECT_ID`, and that `localhost` is a registered web platform in the dev project |
| Dates are off by one day | You used `new Date('YYYY-MM-DD')` somewhere. Use the core date helpers. |
| Lockfile conflict after rebase | `git checkout origin/main -- package-lock.json && npm install` |
