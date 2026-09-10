# deploy-dev

Run an unmerged PR on your own machine, in minutes, before the merge.

```
deploy-dev --pr 12 --fillindata --autosolve
deploy-dev --addpr 12 13
deploy-dev CLA-601
```

Checks the PR out, brings up the smallest running stack that makes it visible,
puts the data in front of it that this change needs, and opens the screen the
diff changed. Locally. Nothing touches a shared environment.

## The problem

You open a PR. To actually see the change you wait for CI, a merge, and a
deploy. On the project this came from that is about forty minutes, and it
happens after the merge, so the first human reaction ("this is really hard to
read") arrives when the ticket is already closed.

## The five minute promise

Under five minutes from one command to a browser tab showing the change. The
second run of the day is a branch switch, not a rebuild. Every design decision
here loses to that budget: when something is slow it is cut, not made
configurable.

Measured on the stack it was built against (a Go API, a SvelteKit portal, a
local Postgres):

| Run | Time to a browser tab |
| -- | -- |
| First run of the day, worktrees exist | 31s |
| With a migration ledger to repair (`--autosolve`) | about 3 min |
| With `--fillindata` | stack in 34s, seed data 5 to 8 min later, browser opens first |

Node 22.18 or newer, git, and `gh` (for PR numbers). No build step: the tool
runs its TypeScript directly.

## What each flag means

**`--pr 12`**, or a bare `12`. A PR number is one way of naming a branch. The
number is looked up in every repo of the stack and resolved to its branch
name; that branch is then checked out in every repo that has it, the rest stay
on the default branch. Sibling PRs for one feature usually have different
numbers per repo and the same branch name, and this is what makes that work.
If a number names two different branches across repos, the tool says so and
asks for the branch instead.

**`CLA-601`**, a ticket id. Only when the config says what a ticket looks like
(`ticket: cla-{id}`); it becomes a branch search (`*cla-601*`) in every repo.

**`--addpr 12 13`**. Several PRs merged together locally. The first is the
base, the rest are merged in; conflicts go to autosolve when it is on.

**`--fillindata`**. Seed only what this PR needs to be visible. An agent reads
the diff, decides what state a human must see (a page that surfaces failures
needs failed rows, not healthy ones), writes an idempotent seed script into
the worktree, runs it against the running stack, and commits it as `local:`.
A change with no visible surface gets nothing, and the tool says so.

**`--autosolve`**. When bring-up breaks, an agent fixes it and the step is
retried, instead of dropping you at an error. Off unless asked for; it edits
files. Details below.

**`--pr-list`**. Open PRs in every repo of the stack, `number  title`, one
block per repo, so you can pick what to run.

Also: `--open /path` when the inferred screen is wrong, `--services a,b` when
the inferred set is wrong, `--no-open`, `--model`, `--attempts`.

## Boot only what the PR needs

The tool reads the diff of every repo against the default branch and decides
from the config's dependency graph:

1. a service is changed when its repo has changes (and, if it lists `paths`,
   one of them matches);
2. every service with a `url` that depends on a changed service is added, so
   a backend-only change still gets its screen;
3. everything those `needs`, transitively.

An empty diff boots everything with a `url`. Getting this wrong is slow, not
broken, so it prefers one service too many. It then opens the screen the diff
changed: for file-based routers (`routes: src/routes`) the directory of the
changed page, minus `(groups)`, becomes the path. Parameterised routes fall
back to the service `url`.

## Generic core, one config file

The tool contains no project name, service name or repo path. Everything
project-shaped is data in a `deploy-dev.yaml` in **your** repo (found upward
from the current directory, or `--config`). Paths are relative to the file.

```yaml
default_branch: main
ticket: cla-{id}

repos:
  api: .
  web: ../operator-frontend

services:
  db:
    ready: tcp://localhost:5432
    start: brew services start postgresql@17

  api:
    repo: api
    needs: [db]
    env_files: [.env]
    env: { PORT: "8090", ENABLE_AUTH: "false" }
    ask: [PRIVATE_GOOGLE_API_KEY]
    agent_env: [DATABASE_URL]
    setup: ./db/apply_migrations.sh
    start: go run .
    ready: http://localhost:8090/api/health
    seed: >-
      Postgres, reachable with psql "$DATABASE_URL". db/seed.sql refills the
      operator tables. The portal reads magic_links, submissions, submission_outbox.

  worker:
    repo: api
    paths: ["cmd/worker/**"]
    needs: [db]
    ask: [HATCHET_CLIENT_TOKEN]
    start: go run ./cmd/worker

  web:
    repo: web
    needs: [api]
    env_files: [.env, .env.local]
    link: [node_modules]
    start: npm run dev
    ready: http://localhost:5173/admin/api/health
    url: http://localhost:5173/admin
    routes: src/routes
```

| Key | Meaning |
| -- | -- |
| `repo` | which repo the service runs from; omit for something external like a database |
| `paths` | globs within the repo; the service counts as changed only when a diff file matches |
| `needs` | services that must be up first |
| `env_files` | dotenv files read from your normal checkout and injected into the process |
| `env` | literal, non-secret values |
| `ask` | secrets to ask for once, if not already in the environment or an env file |
| `agent_env` | vars the autosolve and seed agents may see, never anything in `ask` |
| `link` | paths symlinked from your checkout into the scratch worktree (node_modules) |
| `setup` | one-shot command before start (migrations) |
| `start` | the long-running command; omitted for something already running |
| `ready` | `http://` or `tcp://` probe; a service already answering is used as is |
| `url` | where a human opens it; makes the service a screen |
| `routes` | directory of file-based routes, for inferring the screen from the diff |
| `seed` | free-text hint for `--fillindata` |

Services run from scratch git worktrees under `~/.cache/deploy-dev/worktrees/`,
on a branch named `deploy-dev/<branch>`, so your own checkout, its branch and
its uncommitted work are never touched. Env files are not copied into the
worktree; their values are injected into the service process instead.

## Secrets: ask once, never again

Whenever a required var is missing it is asked for at most once and then kept
in `~/.config/deploy-dev/secrets.json`, mode 0600, outside every repo. Two
paths lead there:

- **declared up front** in `ask:`, so a run asks in one round before booting
  instead of interrupting the boot four times;
- **discovered from a failure**: when a service dies saying `FOO_API_KEY must
  be set`, that is answered by a prompt, never by an agent.

The declared form is preferred because it turns four interruptions into one;
the discovered form is the safety net for the var nobody declared. Values go
to processes through the environment, never argv. They are never logged,
never echoed, never put in an error message.

The agents never receive a secret value. Their shell environment has every
secret-looking name and every credentialed URL stripped; env files and the
store are refused at the tool level; every prompt and every line of output is
passed through a redactor that knows the values. `test/agent.test.ts` pins
that an unset name reaches the model and its value does not. The one exception
is explicit: `agent_env` lists what the agent may see (typically a local
database URL so it can repair or seed the database), and it may not overlap
with `ask`.

## Autosolve, and what it owes you

Built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk),
model `claude-opus-5` by default. The danger is that you run `--pr 12` to
review PR 12, autosolve quietly patches four files to make it boot, and your
opinion is now about code that is not in the PR.

So git is the record. The PR is checked out onto a scratch branch and every
fix is one commit, prefixed so the two kinds sort themselves:

- `fix:` the PR is genuinely broken; belongs in the author's next commit
- `local:` this machine's problem; must never leave the machine

A fix that changes no file (a migration ledger repaired) is an empty commit
with the same subject rules. `git log <pr-head>..HEAD` in the worktree is the
complete record and survives the session. The summary is printed at the end of
every run:

```
autosolve made 2 changes
  local  atlas ledger had the pre-rename version applied, set it to 20260828130000   api:
  local  seed processing-log filings that disagree, so CLA-611's loud lines show    api: scripts/seed-processing-log.sql
0 belong in the PR. 2 never leave this machine.
```

It is bounded: `--attempts` retries per failing step (default 3), and an
attempt that leaves the worktree head unchanged ends the run at once, printing
what the agent said it tried. A failure that only names an unset variable
never reaches the agent at all.

## Two decisions made before the first commit

**Infer from the diff, not declare in the ticket.** Declaring is reliable but
costs work per PR and covers only PRs that exist. Inferring costs nothing per
PR and is wrong sometimes, so the wrong direction is chosen to be cheap: one
service too many, a screen one click away. `--services` and `--open` are the
escape hatch when a human sees it went wrong, and the PR body is not parsed.

**TypeScript on Node.** The Agent SDK is first-class there, `npx deploy-dev`
is how an open-source dev tool is handed to someone, and Node 22.18+ runs the
sources without a build step. Tests use `node:test`. The single runtime
dependency beyond the SDK is `yaml`, because the config is the one file a
user authors and it should read like their stack, not like JSON.

## What already exists, and what did not

Checked before designing: Tilt, Skaffold, Garden, Okteto, devcontainers,
`gh pr checkout`, docker compose profiles, `act`.

| Tool | Solves | Does not |
| -- | -- | -- |
| Tilt, Skaffold, Garden | multi-service dev loops, rebuild on change, mostly on Kubernetes | pick a subset from a diff, seed data, check out a PR, repair a boot |
| Okteto | a personal dev environment per branch, remotely | run on your machine in seconds; the environment is the product |
| devcontainers | a reproducible toolchain in a container | say which services to run, or that a PR needs failed rows |
| `gh pr checkout` | the checkout, in one repo | the sibling PR in the other repo with the same branch name |
| compose profiles | a named subset of services | choosing the subset; someone still decides |
| `act` | running GitHub Actions locally | anything about the running app |

The boring 80% is git worktrees, `sh -c start`, and a readiness probe, and the
tool does exactly that with the standard library rather than wrapping any of
the above, because none of them was on the path of the five-minute budget for
a stack that runs as plain processes against a local database. What was
genuinely missing, and is what this tool is: choosing the minimum stack from
the diff, seeding data scoped to the diff, and a self-healing loop whose every
change is a commit you can read and drop.

## Ceilings, on purpose

- Services are plain processes; a service that needs Docker gets
  `start: docker compose up -d x` in its config, nothing more.
- One config, one stack; no plugin system, no remote execution, no web UI.
- The route inference knows file-based routers only; anything else opens `url`.
- The agent tool guard is a filter on tool inputs, not a sandbox.

## Development

```
npm test
```

MIT. Chosen because a tool that lives in other people's repos should carry
the fewest possible conditions.
