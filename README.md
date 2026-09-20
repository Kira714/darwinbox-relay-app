# Relay — AI-assisted data migration agent

Upload several Excel/CSV exports of the same entity, say what the target should look like and where it goes, and click **Generate**. The agent maps the columns (with an LLM you provide a key for), cleans and reconciles the data, and pushes every record to your API on its own. When it is genuinely unsure, or something fails, it **stops, tells a named person exactly what is wrong, and waits** — nothing is sent until they decide.

Built for the Darwinbox *Forward Deployed Engineer* take-home: *Build an AI Agent for Client Data Migration & Integration*.

- **Multi-file ingestion** — several `.xlsx`/`.csv` files (every sheet), different column names and date formats, reconciled into one dataset by an identity field.
- **AI column mapping** — free open-weight models through [OpenRouter](https://openrouter.ai) (bring your own key, entered once, stored encrypted). The model only *proposes*; deterministic code decides what is accepted.
- **Any target** — pick the Employee preset or paste your own JSON Schema; choose the built-in mock API or any HTTP endpoint that accepts a JSON `POST`.
- **Escalation, not guessing** — ambiguous dates, conflicting values, low-confidence mappings, invalid or missing data, identity collisions and delivery failures go to the assigned consultant with a reason (and optionally a Slack-compatible webhook).
- **Safe delivery** — idempotent per-record writes, retry of only what failed, a circuit breaker for a broken target, and compare-before-restore rollback on the built-in target.
- **Everything is audited** — who decided what, why, and what changed, with row-level lineage back to the source files.

## Quick start

Requires **Node.js ≥ 22.13** (uses the built-in `node:sqlite`).

```bash
npm ci
npm run build
npm run users:seed     # creates one admin + one consultant; passwords go to .data/credentials-*.json
npm start              # http://127.0.0.1:3001
```

| Account | Role |
| --- | --- |
| `admin@relay.example` | Administrator — creates migrations, configures AI, retries and rolls back |
| `ic@relay.example` | Implementation consultant — reviews only the migrations escalated to them |

Passwords are random: `cat .data/credentials-*.json`. Use a normal window for the admin and a private window for the consultant.

### Use it

1. **AI & alerts** (admin, sidebar) → paste your OpenRouter key → **Test connection** → **Save**. Get a free key at <https://openrouter.ai/keys>. The key is encrypted at rest and never shown again.
2. **New migration** → drop the files in `samples/04-helix/` → keep the *Employee directory* schema → **Relay mock API** → pick who gets escalations → **Generate**.
3. Watch the agent work. It maps, cleans, and escalates what it cannot safely decide.
4. Sign in as the consultant → open the migration → resolve each case (a reason is required). The last resolution starts delivery automatically.
5. **Mock target** (admin) shows exactly what the API received.

The script for a demo video, including failure/retry/rollback, is in [docs/demo.md](docs/demo.md).

## Sample scenarios

| Folder | Files | What it shows |
| --- | --- | --- |
| [`04-helix`](samples/04-helix) | 2 × Excel | **AI mapping** of unfamiliar headers (`Emp Code`, `Nombre completo`, `E-mail (work)`, `Org Unit`…), decoy columns, then three human decisions |
| [`01-meridian`](samples/01-meridian) | 2 × CSV | Fully autonomous: cleanup + duplicate reconciliation, no escalation |
| [`02-northstar`](samples/02-northstar) | 2 × CSV | Ambiguous date, conflicting department, missing email |
| [`03-cedar`](samples/03-cedar) | 2 × CSV | Identity collision, impossible date, and a rejected record |

All data is synthetic. Details and expected outcomes: [samples/README.md](samples/README.md).

## How the agent decides

The line between "do it" and "ask" is deliberate and written down in [docs/autonomy.md](docs/autonomy.md). In short:

| The agent acts alone when… | It escalates when… |
| --- | --- |
| a header matches a declared alias | a column could map to two fields, or the model is below your confidence bar |
| the AI is confident **and** values fit the field's type **and** nothing collides | the model is unreachable (it never guesses) |
| whitespace, casing, enum spellings, or a date with one valid reading need fixing | a date has two valid readings (`04/05/2024`) |
| rows agree on the identity field and don't conflict | two sources disagree, or two people share an identity |
| the target accepts the write | a value is missing/invalid after one bounded repair, or the target keeps failing |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3001` / `127.0.0.1` | Listen address |
| `DB_PATH` | `.data/relay-operations.sqlite` | SQLite file (users, runs, audit, mock target, encrypted settings) |
| `RELAY_SECRET_KEY` | generated at `.data/secret.key` | Master key for encrypting stored secrets |
| `OPENROUTER_API_KEY` | — | Optional fallback if no key was saved in the UI |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Point at another OpenAI-compatible gateway |
| `COOKIE_SECURE` | `false` | Set `true` behind HTTPS |

## Privacy

By default only **column names and value shapes** (`AA-999`, "looks like an email", "3 distinct values") are sent to the model — never employee values. The consultant can opt in to sample values in Settings. Free OpenRouter models are run by third-party providers that may log prompts, which is why the default is shape-only.

## Tech stack

React 19 + Vite + TypeScript UI · Express 5 API · SQLite (`node:sqlite`) · ExcelJS / csv-parse ingestion · Ajv (JSON Schema validation) · Zod · OpenRouter chat API (OpenAI-compatible). Details: [docs/architecture.md](docs/architecture.md).

## Development

| Command | What it does |
| --- | --- |
| `npm run dev` | API on :3001 + Vite dev server with hot reload on :5173 |
| `npm run check` | typecheck + unit/integration tests + production build |
| `npm test` | 44 tests: engine, AI client against a fake OpenRouter, HTTP API, auth, rollback safety |
| `npm run test:browser` | Real Chromium end-to-end (stubbed model, disposable DB); screenshots in `test-results/e2e/` |
| `npm run mock:start` | Standalone mock API on :4001 to use as a *custom endpoint* (`POST /employees`, `GET /records`, `POST /fail-next`) |
| `npm run samples` | Regenerate the Excel demo files |

API reference: [docs/api.md](docs/api.md) · [`api/openapi.json`](api/openapi.json) · [Postman collection](api/relay.postman_collection.json).
Scope and known gaps: [docs/known-limitations.md](docs/known-limitations.md). This is a single-workspace prototype against a mock target — not a hosted production service or a live Darwinbox integration.
