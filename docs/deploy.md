# Deploying on Render (free)

Relay is one long-running Node process with a SQLite file, so it needs a real server, not serverless functions. Render's free web service fits.

## Settings

| Field | Value |
| --- | --- |
| Language | Node (version comes from `.node-version`: 22.16.0) |
| Branch | `main` |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `npm start` |
| Instance type | Free |
| Health check path (Advanced) | `/api/health` |

`render.yaml` in the repo describes the same thing for **New → Blueprint**.

## Environment variables

| Key | Value |
| --- | --- |
| `ADMIN_PASSWORD` | at least 12 characters — password for `admin@relay.example` |
| `IC_PASSWORD` | at least 12 characters — password for `ic@relay.example` |
| `OPENROUTER_API_KEY` | your OpenRouter key (the AI is on from first boot; the Settings screen shows it as "from environment") |
| `RELAY_SECRET_KEY` | any long random string (use Render's *Generate* button); encrypts secrets saved in the app |

Render sets `RENDER=true` and `PORT` itself. That makes the app listen on all interfaces, mark cookies `Secure`, and trust Render's proxy — nothing else to configure. Optional: `ADMIN_EMAIL`, `IC_EMAIL`, `ADMIN_NAME`, `IC_NAME`.

## What to expect on the free plan

- **It sleeps after 15 minutes without traffic** and takes about a minute to wake. Open the URL a couple of minutes before a demo.
- **The disk is wiped on every restart, redeploy and wake-up.** Migrations, audit history and mock-target data disappear; accounts and the AI key come back from the environment variables. This is fine for a demo; for real use, a paid instance with a persistent disk (mounted at `.data`) removes the limitation with no code change.
- Long migrations are interrupted if the instance sleeps mid-run; there is no such risk while someone is using it.
- Free instances have 0.1 CPU and 512 MB, so sign-in (password hashing) and Excel parsing are noticeably slower than locally.
