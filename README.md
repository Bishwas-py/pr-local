# pr-local

Run an unmerged PR on your own machine in minutes, before it merges.

```
npm install -g pr-local
cd your-repo
pr-local --pr 12
```

No config for most repos: it detects how yours starts, checks the PR out,
boots the smallest stack that makes the change visible, seeds the data it
needs, opens the screen it changed, and fixes a broken boot on its own.
Locally. Nothing touches a shared environment.

## Zero config

Most repos need no setup. From inside one, `pr-local --pr 12` detects the app,
reads how it starts (`package.json` dev script, `go run .`, Django), its port,
its routes, and its `.env`, and just runs it.

You only write a `pr-local.yaml` when detection can't see your stack: several
repos that boot together, or a database and a queue. It is then an override,
not an entry fee. See [The config](#the-config).

## Flags

Everyday use needs none. For the rare case:

| Flag | For |
| -- | -- |
| `--addpr 12 13` | several PRs merged together |
| `--pr-list` | list open PRs to pick from |
| `--no-seed` | boot and fix, but create no data |
| `--no-fix` | diagnose loudly, change nothing |
| `--services a,b` | boot exactly these |
| `--open <path>` | open this instead of the inferred screen |
| `--config <file>` | use this config |
| `--model <name>` | agent model (default `claude-opus-5`) |
| `--attempts <n>` | fix attempts per failing step (default 3) |

## The config

Optional. Write one only when detection can't infer your stack (multiple repos,
a database). It is data, not a DSL: you see your services, not a language to
learn. Paths are relative to the file. Present, it fully replaces detection.

```yaml
default_branch: main
ticket: abc-{id}          # so `pr-local ABC-123` finds the branch for that ticket

repos:
  api: .                  # name: path to that repo on this machine
  web: ../web

services:
  db:                     # already running: just a probe, no repo
    ready: tcp://localhost:5432

  api:
    repo: api
    needs: [db]
    env_files: [.env]     # your dotenv, injected into the process
    port: 8080            # each PR gets its own offset; ${port} fills in below
    env: { PORT: "${port}" }
    setup: ./migrate.sh   # one-shot before start (optional)
    start: go run .
    ready: http://localhost:${port}/health
    seed: "psql $DATABASE_URL; ./seed.sql fills the tables the UI reads."

  web:
    repo: web
    needs: [api]
    env_files: [.env, .env.local]
    port: 5173
    env: { API_URL: "http://localhost:${api.port}" }
    link: [node_modules]  # symlinked in, so install is skipped
    start: npm run dev -- --port ${port}
    ready: http://localhost:${port}/
    url: http://localhost:${port}   # makes this the screen it opens
    routes: src/routes    # so the screen matches the diff
```

| Key | Meaning |
| -- | -- |
| `repo` | which repo the service runs from; omit for something already running |
| `needs` | services that must be up first |
| `env_files` | dotenv files read from your checkout and injected |
| `port` + `${port}` / `${name.port}` | base port; each PR gets a stable offset |
| `setup` / `start` / `ready` | one-shot, long-running, and the readiness probe |
| `url` / `routes` | where a human opens it, and how the screen is picked from the diff |
| `seed` | a hint for the data the change needs to be visible |
| `ask: [FOO_KEY]` | a required secret; asked once, stored, never asked again |

## What each run does

Given a PR, branch, or ticket, it resolves the work by **branch name** across
every repo (a PR number is one repo's; the branch is the same everywhere),
boots only the services the diff touches, and opens the screen it changed.
An agent then seeds the data the change needs and checks the screen actually
works against the running stack. If boot breaks, it fixes and retries.

Every change it makes is a git commit on a throwaway branch, prefixed so you
can tell them apart:

- `fix:` the PR is genuinely broken, belongs in the author's next commit
- `local:` this machine's problem, never leaves your machine

`git log <pr-head>..HEAD` in the worktree is the full record, and the run
prints a summary. Your own checkout, its branch, and its uncommitted work are
never touched: everything runs in scratch worktrees under `~/.cache/pr-local`.

## Secrets

A required var with no default is asked for once, kept in
`~/.config/pr-local/secrets.json` (mode 0600, outside every repo), and never
asked again. Values are never logged, and the agent never receives one.

## The AI

The agent seeds data, fixes boots, and looks into errors. It runs only when it
can reach a model: set `ANTHROPIC_API_KEY`, or be logged into Claude Code. With
neither, pr-local still boots your stack and just reports errors instead of
fixing them. To turn it off for good, add `agent: off` to the config.

## Requirements

Node 22.18+, git, and `gh` (for PR numbers; branches and tickets work without
it).

## Development

```
npm test
npm run build
```

MIT.
