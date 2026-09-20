# Agent autonomy policy

The model proposes semantics; deterministic code enforces authority. Model confidence is self-reported, not a calibrated probability, so it is never the only check.

| Situation | Agent action | Reason |
| --- | --- | --- |
| Header matches an alias declared in the target schema | Map automatically | Explicit semantic equivalence |
| Unfamiliar header, model confidence ≥ threshold (default 85%), target field exists, no other column in the file already maps there, populated values satisfy the field's type/format | Map automatically, with the model's reason and confidence in the audit | Several independent checks agree |
| Model says "no target" with confidence ≥ threshold | Ignore the column, visibly | Extra columns must not flood the queue; the decision is audited and reversible by reopening the mapping |
| …unless a required field has no source column and the model had considered this column | Ask consultant | A missing required field is worse than an ignored column |
| Low confidence, unknown field, competing columns, or values that do not fit the field | Ask consultant, showing the model's suggestion | Meaning or precedence is not established |
| AI not configured, or the provider fails/times out/returns junk | Fall back to aliases only; escalate every other column and say why | Never guess; never claim inference that did not happen |
| Leading/trailing/repeated whitespace, email casing, explicit enum aliases, boolean spellings | Normalize and audit | Semantics preserved |
| ISO date, or numeric date where only one interpretation is calendar-valid | Normalize and audit | Unique interpretation |
| Date where day/month and month/day are both valid and different | Ask consultant (the ambiguous cell contributes no value until decided) | Locale cannot be inferred safely |
| Same identity value in several rows, compatible values | Consolidate, preserve all lineage | Proven same identity |
| Same identity, complementary fields | Combine non-conflicting values | Nothing is overwritten |
| Same identity, differing non-empty field | Ask consultant per conflict | Source precedence unknown |
| Same unique value (e.g. email), different identities | Ask consultant: correct or reject | Never merge identity by name or email alone |
| Missing required field / invalid value after one bounded repair | Ask consultant | Do not fabricate data; no unbounded repair loops |
| Any schema problem in any record | Validate the whole batch first; deliver nothing | No half-delivered batches for a fixable reason |
| Target transient failure | Record the failure, escalate, retry only failed records with the same idempotency key | Recovery without duplication |
| Three consecutive target failures | Stop and escalate | Do not hammer a broken endpoint |
| Rollback after another run changed the target | Refuse conflicting restoration | Preserve later work |

## What the model sees

Column names, the target field list (names, types, descriptions, allowed values) and, per column, a **local profile**: value kind, character shapes such as `AA-999`, and cardinality. Raw employee values are sent only if an administrator opts in. Column names and profiles are treated as untrusted text (the prompt says so, and the answer is constrained to schema fields and re-validated), so uploaded data cannot instruct the agent or grant it capabilities. No code execution, no fuzzy person matching, no outbound messages other than the configured escalation webhook.

## Authenticated human decisions

Admins create and assign migrations and control recovery. Only admins or the assigned consultant can read a migration. Every decision requires the current revision and a reason; reviewer identity comes from the session. A rejection preserves all linked source rows while preventing delivery. Consultants cannot retry, resume or roll back. The migration service performs delivery after the final decision using its own target-write credential. Role checks never relax the normalization, identity or ambiguity boundaries above.
