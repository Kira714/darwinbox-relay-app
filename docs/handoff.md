# Handoff — current state

**Product.** Relay: React + Express + SQLite migration agent. Flow: upload Excel/CSV → schema-driven mapping (aliases, then OpenRouter LLM proposals gated by deterministic policy) → cleanup/reconcile → escalate to a named consultant or deliver to an HTTP target (built-in mock API or any URL) with idempotent retry and rollback (built-in only).

**Run it:** `npm ci && npm run build && npm run users:seed && npm start`; credentials in `.data/credentials-*.json`; add the OpenRouter key in the UI (*AI & alerts*).

**Verify:** `npm run check` (typecheck, 61 tests, build) and `npm run test:browser` (Chromium end-to-end, stubbed model).

## Read first
`README.md` → `docs/autonomy.md` (policy — do not weaken) → `docs/architecture.md` → `docs/api.md`. The assignment brief (kept out of the repository) is authoritative.

## Decisions worth knowing
- **Target definitions are forgiving on input, strict inside.** `schemaInput.ts` accepts names / typed field maps / field objects / sample records / JSON Schema / YAML and always produces the strict schema; the UI validates live via `POST /api/configuration/validate`. Do not loosen the strict schema itself.
- **Mapping fit is a majority rule** (`FIT_THRESHOLD` in `mapping.ts`): one dirty cell must not turn a correct AI mapping into a mapping question.
- **One schema-driven pipeline.** There is no hardcoded employee path; the Employee schema is a preset whose aliases live in `x-aliases`. Pre-schema runs are upgraded on load (`store.ts`).
- **OpenRouter only.** Chosen so free open-weight models can be used with the user's own key. The earlier local MiniLM encoder was removed (extra dependency, model download, and a second mapping path). No key ⇒ aliases only, unknown columns escalate.
- **The model never gets raw values** unless explicitly enabled; it only proposes and its output is re-validated (`mapping.ts`).
- **An ambiguous date contributes no value until decided** (`engine.ts`), otherwise it would also raise a false "sources disagree" case against an unambiguous value in another file.
- **Escalation is persisted a moment after status flips to `review`** (`escalate()` runs after `reconcile`), so tests use `waitFor(...escalation)`.
- **Rollback is built-in-target only.** External URLs have no undo contract; don't add DELETE-by-id without an explicit, safe contract.
- Secrets (AI key, webhook, per-run `Authorization`) live in `settings`, AES-256-GCM, master key from `RELAY_SECRET_KEY` or `.data/secret.key`. They are write-only over the API.

## Evidence
61 tests pass; type check and build pass; Chromium E2E passes. A live run with a real OpenRouter key and `samples/04-helix` mapped 9 of 12 unfamiliar columns automatically (the rest escalated), then completed after consultant decisions with 10 records in the mock API. The number of mapping escalations varies by model and run.

## Not done
Durable jobs, sandboxed parsing, user administration/SSO, labelled threshold evaluation, reusable approved rules, real vendor connector, hosted deployment, CI-run browser test (the workflow runs typecheck/tests/build only).
