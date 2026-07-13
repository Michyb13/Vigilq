---
sidebar_position: 1
title: Environment variables
---

# Environment variables

All set in `.env`, read by `docker-compose.yml`.

## Database

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | Points at either the bundled Postgres (`postgres://postgres:postgres@db:5432/vigilq`, only reachable with `--profile bundled-db`) or any existing Postgres instance you already run. The engine has no idea which. |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | Only if using bundled Postgres | `vigilq` / `postgres` / `postgres` | Ignored entirely if you're pointing `DATABASE_URL` at your own instance. |

## AI triage provider

Pick exactly one. Leaving a provider's key (and model, for OpenAI/Google) unset disables triage entirely — no error, it's just silently off.

| Variable | Notes |
|---|---|
| `AI_PROVIDER` | `anthropic` (default), `openai`, or `google` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Model defaults to `claude-sonnet-5` if unset |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | No default model — must be set explicitly |
| `GOOGLE_API_KEY` / `GOOGLE_MODEL` | No default model — must be set explicitly |

## API keys

There's no env var for the queue API key itself — it's auto-generated on first boot, not something you set.

- Printed once to the engine's logs on first boot, and saved to a file inside the engine's data volume.
- Idempotent across restarts — a `docker compose` restart never generates a second key.
- If lost, rotate rather than dig for it: run the engine's key-rotation command inside the container, which revokes the old key and mints a fresh one.

Whatever your app/worker uses to authenticate reads this key from wherever *you* choose to store it (your own `.env`, a secrets manager, etc.) as `QUEUE_API_KEY` — that variable name is a convention the SDKs' examples use, not something the engine itself reads.

## Sweeper

| Variable | Default | Notes |
|---|---|---|
| `SWEEP_CRON_SCHEDULE` | `*/10 * * * * *` | A `node-cron` expression (supports seconds — plain OS cron can't go below a minute). Reclaims jobs whose worker went silent. |

## Dashboard

No dedicated env vars — it's served by the engine's own process at `/dashboard`, same port as the API, and reads its API key from a login form (stored in the browser's `localStorage`, not an env var).
