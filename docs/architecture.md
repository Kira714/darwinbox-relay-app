# Architecture

One Node process serves a React SPA and a JSON API, backed by one SQLite file.

```
Browser (React)  ──HTTP/JSON──▶  Express API ──▶ SQLite (users, sessions, runs, audit, settings, mock target)
                                    │
                                    ├─ ingest.ts      Excel/CSV → sources (rows keep file + line)
                                    ├─ mapping.ts     aliases → AI proposals → policy → mappings / review cases
                                    │     └─ ai.ts    OpenRouter client (retry, fallback model, strict parsing)
                                    ├─ engine.ts      normalize, reconcile, validate, review cases, decisions, audit
                                    ├─ delivery.ts    validate-all-first, POST per record, breaker, retry, rollback
                                    ├─ escalation.ts  who/why summary, audit event, optional webhook
                                    └─ target.ts      built-in mock API (idempotent, versioned, rollback)
```

## Pipeline (one migration)

1. **Create** (`POST /api/runs`, admin): files + `configuration` (`schema`, `identityField`, `destination`) + escalation contact. Saved immutably on the run.
2. **Map** (`mapSources`): per source, columns are matched to schema aliases; unresolved ones go to the AI (headers + value profile). Proposals pass the policy in `mapping.ts`; the rest become `pending` mappings.
3. **Reconcile** (`reconcile`): cells are normalized, rows grouped by identity, conflicts/ambiguities/invalid values/identity collisions become **cases**. Decisions are replayed on every run of `reconcile`, so it is pure and idempotent.
4. **Escalate or deliver**: any case → status `review` + `escalate()`. Otherwise `deliver()`.
5. **Deliver**: validate *every* record first; then `POST` each with `Idempotency-Key: <runId>:<recordId>`. Three consecutive failures trip the breaker. Failures → status `partial` + escalation.
6. **Human decisions** (`POST …/resolve`): validated by the same schema, require a reason and the current `revision`, actor comes from the session. Resolving the last case schedules delivery.

## Module map

| Path | Responsibility |
| --- | --- |
| `server/configuration.ts` | JSON-Schema subset, presets-independent validation, normalization, typed payloads |
| `server/presets.ts` | Employee schema preset (aliases and value aliases live in the schema as `x-*` keys) |
| `server/ingest.ts` | Excel (all sheets) / CSV parsing with bounds, formula refusal, line provenance |
| `server/profile.ts` | Local column profiling (kind, shapes, cardinality) — what the AI sees |
| `server/ai.ts` | OpenRouter client, prompt, tolerant/strict output parsing, model list, connection test |
| `server/mapping.ts` | Alias → AI → acceptance policy; required-field coverage guard |
| `server/engine.ts` | Reconcile, cases, `resolveCase`, audit helper, escalation description |
| `server/delivery.ts` | Delivery loop, circuit breaker, rollback (reference target) |
| `server/escalation.ts` | Escalation record + webhook |
| `server/settings.ts` | Encrypted (AES-256-GCM) secrets and workspace settings |
| `server/auth.ts` | scrypt passwords, opaque sessions, CSRF, roles, login throttling |
| `server/target.ts` | Built-in mock API: receipts, versions, compare-before-restore |
| `server/store.ts` | SQLite persistence, run snapshots, insert-only audit, legacy-run upgrade |
| `server/app.ts` | Routes and orchestration |
| `src/` | React UI: `views/NewMigration`, `RunView`, `Review`, `Records`, `Settings`, `TargetMonitor` |

## Data model (SQLite)

`users`, `sessions`, `login_limits` · `settings` (secrets encrypted) · `runs` (full JSON snapshot incl. mappings, records, cases, decisions, events) · `audit` (insert-only mirror of events) · `target_records`, `target_receipts` (the built-in mock API).

## Target contract

Each record is one JSON object, typed per the schema (numbers/booleans converted, empty optionals omitted), sent as `POST <url>` with `Content-Type: application/json`, `Idempotency-Key`, and optionally the stored `Authorization` header. Any 2xx is success; anything else is a per-record failure. The built-in target additionally requires an internal service credential (never sent to external URLs), rejects payloads that differ from the approved record, and supports rollback.

## Security notes

Server-enforced roles and run assignment; CSRF token on every mutation and a same-origin check; secrets write-only and encrypted; uploaded content and model output are untrusted (model output is constrained to schema fields and re-validated; formulas in Excel are refused; CSV export neutralizes formula injection).
