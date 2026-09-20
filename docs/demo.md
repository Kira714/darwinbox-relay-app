# Demo script (≈5 minutes)

Two browser windows: admin (normal) and consultant (private). Have `samples/04-helix/*.xlsx` ready.

1. **Set the AI once** (admin → *AI & alerts*). Paste the OpenRouter key → *Test connection* (real request; shows the model that answered) → *Save*. Point out: shape-only privacy default, confidence bar, key never shown again.
2. **New migration.** Drop both Excel files: *"two systems, different header names — `Emp Code` vs `Personnel No.`, `Nombre completo`, a decoy `Favourite Colour`."* Keep the Employee schema, *Relay mock API*, escalate to Samira → **Generate**.
3. **Watch the agent.** It maps with the AI, cleans, reconciles 13 rows into 10 records, and stops: the banner says *Escalated to Samira Patel* and lists exactly what is wrong. Open **Field mappings**: alias vs AI mappings with confidence, ignored columns and why. *"It asks about everything it cannot prove, and nothing else."*
4. **Consultant window.** Inbox → open. Work the queue: an AI mapping it was unsure about (the suggestion is pre-selected), an ambiguous date (`04/05/2024` — two valid readings), a department conflict between files, a missing email. Every decision needs a reason. *"The last decision starts delivery automatically."*
5. **Verify.** Admin → *Mock target*: 10 records, exactly as delivered. Open **Audit trail**: each decision has actor, reason, before/after.
6. **Failure & recovery.** Admin → *Mock target* → *Fail the next write*. Upload `samples/01-meridian/*` (clean data, no escalation needed) → 7 delivered, 1 failed → escalation banner with the HTTP error → *Retry outstanding* → done, no duplicates (same idempotency key). Then *Roll back* to show compare-before-restore.
7. **Your own target.** In step 2 open **Build fields**, delete the rows, type `sku, name, price, stock` into *quick add*, flip **Required** on `name` and `price`. Or open **Paste or upload** and paste just `employee_id, full_name, email`. The panel says what it understood and what it inferred. Use `samples/07-catalogue` to run it.
8. **Bring your own mock API.** `npm run mock:start`, choose *My mock API URL* = `http://127.0.0.1:4001/employees`, generate; `GET :4001/records` shows what it received.
9. **The dial.** In Settings drop the confidence bar to 70% and re-run: fewer questions. Raise it to 95%: more. *"This is where I drew the line, and it is a setting."*

**Say explicitly:** the model proposes and code decides · confidence is self-reported so it is never trusted alone · a model outage degrades to asking, never guessing · free models vary run to run · target is a mock; a real connector needs a verified idempotency/undo contract.
