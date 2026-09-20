# API guide

Full reference: [`api/openapi.json`](../api/openapi.json). Import [`api/relay.postman_collection.json`](../api/relay.postman_collection.json) for a ready-made walkthrough.

**Auth.** `POST /api/auth/login` returns a `relay_session` cookie and a `csrfToken`. Send the token as `x-csrf-token` on every non-GET request. Admins see everything; consultants only migrations assigned to them (others return 404).

```bash
B=http://127.0.0.1:3001
# sign in (password from .data/credentials-*.json)
curl -sc jar -H 'Content-Type: application/json' \
  -d '{"email":"admin@relay.example","password":"…"}' $B/api/auth/login          # → {user, csrfToken}
T=<csrfToken>

# configure AI once (key is write-only)
curl -sb jar -H "x-csrf-token: $T" -H 'Content-Type: application/json' -X PUT $B/api/settings/ai \
  -d '{"apiKey":"sk-or-v1-…","model":"nvidia/nemotron-3-super-120b-a12b:free","shareSamples":false,"minConfidence":0.85}'

# preview files, then Generate
curl -sb jar -H "x-csrf-token: $T" -F files=@samples/04-helix/hr-core.xlsx -F files=@samples/04-helix/legacy-crm.xlsx $B/api/sources/preview
curl -sb jar -H "x-csrf-token: $T" -F name='Helix' -F assignedTo=<consultant-id> \
  -F files=@samples/04-helix/hr-core.xlsx -F files=@samples/04-helix/legacy-crm.xlsx $B/api/runs      # → 202 {id,…}

# poll: status, mappings, cases, escalation
curl -sb jar $B/api/runs/<id>
```

## Custom target

`configuration` (form field, JSON) selects the schema and destination. Omit it for the Employee preset + built-in mock API.

```json
{
  "schema": { "type": "object", "additionalProperties": false, "required": ["sku","price"],
    "properties": { "sku": {"type":"string","x-aliases":["item code"]},
                    "price": {"type":"number","minimum":0,"x-aliases":["unit cost"]} } },
  "identityField": "sku",
  "destination": { "kind": "http", "url": "https://your-mock.example/items" }
}
```

Supported schema subset: flat properties of `string|number|integer|boolean`; `required`; `format: email|date`; `enum`; `pattern`; `minLength/maxLength`; `minimum/maximum`. Extensions: `x-aliases` (confirmed column synonyms), `x-value-aliases` (source value → enum value), `x-unique`. Anything else is rejected with a clear message at creation time.

Each record is delivered as `POST <url>` with a JSON object body and `Idempotency-Key: <runId>:<recordId>` (plus the stored `Authorization` header if you supplied one).

## Review, recovery

| Endpoint | Who | Notes |
| --- | --- | --- |
| `POST /api/runs/{id}/resolve` | admin or assigned consultant | `{caseId, expectedRevision, decision:{action, value?, reason}}`; stale revision → 409 |
| `POST /api/runs/{id}/retry` | admin | Only outstanding records; same idempotency keys |
| `POST /api/runs/{id}/resume` | admin | After a server restart interrupted work |
| `POST /api/runs/{id}/rollback` | admin | Built-in mock API only; refuses records changed by a later run |
| `POST /api/mock/fail-next` | admin | Make the next N writes to the built-in mock fail (demo) |
| `GET /api/mock/records` | admin | What the built-in mock API holds |
