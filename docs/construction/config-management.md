# Configuration management plan

Syllabus Module 4: configuration management. Covers branching, commits, versioning, migrations, policy versions,
environment configuration and secrets.

## 1. Branching and integration

```
builder worktree branches  ->  integration branch  ->  main (pull request)
worktree-agent-<id>            claude/wonderful-galileo-2es87v
```

- Each builder works on its own worktree branch and edits only its assigned paths (one owner per path).
- The orchestrator merges builder branches into the integration branch one at a time and runs `pnpm verify` after each.
  `pnpm-lock.yaml` conflicts are resolved by regenerating with `pnpm install` (D-008).
- The integration branch reaches `main` through a pull request: CI green, team review and Codex PR review. Nothing
  is pushed directly to `main`.
- Wave completions are tagged `wave-0` ... `wave-4` on the integration branch.

## 2. Commits

Conventional commits: `feat(scope):`, `fix(scope):`, `chore:`, `docs:`, `test:`, `refactor:`. Scopes follow package
names (`api`, `web`, `worker`, `domain`, `contracts`, `db`, `tooling`). Small, focused commits; each builder commit
is attributed to the builder session in its trailer.

## 3. Versioning

- Packages are private and versioned `0.x`; the workspace is released as one unit.
- A release is a tag `vMAJOR.MINOR.PATCH` on `main`; container images are tagged with that version and the git SHA.
- Each release records its migration version (highest applied file in `db/migrations`) so a deployment can state
  exactly which schema it expects.

## 4. Database migrations

- Forward-only, numbered plain SQL files in `db/migrations` (`0001_init.sql`, `0002_*.sql`, ...). No ORM.
- The runner (`pnpm db:migrate`, in `packages/db`) records each applied file in `schema_migrations` with a checksum
  and applies each file in one transaction. A changed checksum on an already-applied file is an error: applied files
  are never edited, a new file is added instead.
- Schema changes use compatibility windows where possible (add, backfill, switch, remove in later migrations), because
  rolling back application code does not roll back the database (report section 6.13).
- `pnpm db:seed` is idempotent and loads demo data only; `pnpm db:reset` is for local and test databases.

## 5. Policy versions

Queue policy values (report Table 7: rotation A,A,W; early eligibility 10 min; late grace 15 min; aging trigger
45 min; called timeout 2 min; EWMA alpha 0.2; initial estimate 12 min; capacity 10 booked + 5 walk-in) are stored as
versioned policy rows. Each queue decision records the policy version used, so a decision can be replayed and
explained. A change to a policy value is a new version (a data change recorded in the audit log), not an edit of an
old one. Changing a Table 7 default in code requires a `DECISIONS.md` entry.

## 6. Environment configuration and secrets

- All configuration is environment variables. `.env.example` lists every key with a local default that uses fake
  adapters; `.env` is git-ignored. No secrets are committed anywhere.
- Login sessions are opaque random tokens stored hashed in the database, so the local identity provider needs no signing
  secret. `SESSION_SECRET` in `.env.example` is a marked dev-only placeholder reserved for the hosted identity adapter;
  nothing in the current code reads it. Any shared or hosted environment supplies real secrets (GEMINI_API_KEY, storage
  and identity credentials) through protected runtime configuration (Google Secret Manager for the hosted reference).
- Demo-only switches: `RUN_MIGRATIONS_ON_START`, `SEED_ON_START` and `ALLOW_DEMO_SEED` exist for the compose demo. The seed
  refuses `NODE_ENV=production` unless `ALLOW_DEMO_SEED=true`, so a hosted environment must never set it.
- Provider adapters are selected by configuration and the fake adapter is always the default:

| Port | Default | Later option | Key |
| --- | --- | --- | --- |
| `IdentityProvider` | `local` (email and password, argon2, httpOnly cookie) | `identity-platform` | `IDENTITY_PROVIDER` |
| `ObjectStorage` | `local-disk` | `gcs` | `OBJECT_STORAGE` |
| `OcrProvider` | `fake` (deterministic fixtures) | `google-vision` | `OCR_PROVIDER` |
| `LlmProvider` | `fake` (templated, cites verified version) | `gemini` | `LLM_PROVIDER`, `LLM_MODEL` |

- Adding a config key means updating `.env.example`, this table if it is a provider, and the runbook in the same commit.
- Ports and database names are fixed by project convention: web 5173, api 3000, databases `hqms` and `hqms_test`.
