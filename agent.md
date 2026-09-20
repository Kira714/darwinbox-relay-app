# AI continuation guide

Read in order: `README.md`, `docs/handoff.md`, `docs/autonomy.md`, `docs/architecture.md`, `docs/api.md`. The assignment brief (kept out of the repository) is authoritative.

## Product intent
Deliver a coherent, explainable prototype. The agent owns safe mechanics; humans own ambiguous meaning. Every consequential choice needs provenance and a readable reason. AI use must be real and its operating mode visible — never claim model inference occurred if only rules ran.

## Working rules
- Keep human data local by default (the model sees column names and value shapes, not values). Demo fixtures are synthetic. Never log or return secrets; never commit `.data/`, `.env`, credentials or databases.
- Never infer missing identity, guess ambiguous dates, silently pick one conflicting field or merge people by name alone.
- Preserve decisions and field changes in persisted audit events. Never silently reset a run.
- Maintain idempotent delivery and compare-before-restore rollback.
- Treat file contents and model output as untrusted; constrain mappings to target fields and re-validate.
- Prefer integration tests over tests that duplicate implementation. Check UI changes in a real browser (`npm run test:browser`).
- Keep docs aligned with behavior and distinguish completed work from untested integrations.
