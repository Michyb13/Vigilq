# VigilQ

A self-hosted distributed job queue: automatic retries with exponential backoff, worker pools for different hardware tiers, an optional autoscaler, and AI-powered triage on jobs that end up dead-lettered (Claude, GPT, or Gemini — your choice).

Pull the image, point it at a database (bundled or your own), and start enqueueing jobs from TypeScript, C#, or Python.

## Features

- **Reliable job processing** — `SELECT ... FOR UPDATE SKIP LOCKED` claiming, exponential backoff with jitter, dead-letter after exhausted retries, idempotency via dedupe keys.
- **Crash recovery** — a lease-based sweeper reclaims jobs whose worker went silent, no manual intervention needed.
- **Adaptive backoff** — retry timing scales with each job type's real historical success rate, not just a flat curve.
- **Worker pools** — route jobs to different hardware tiers (e.g. a GPU pool vs. a standard pool) when the same job type needs to run on more than one.
- **Autoscaling** — optional service that adjusts replica count per pool based on queue depth, within bounds you set.
- **AI-powered dead-letter triage** — Claude, GPT, or Gemini (pick one, bring your own key) reads a dead-lettered job's full attempt history and suggests a root cause and fix.
- **Dashboard** — served by the engine itself, same port as the API. Job states, pool depths, attempt history, AI triage results.
- **Automatic schema setup** — migrations run on every boot, whether you're using the bundled Postgres or your own instance. No manual `psql` step, ever.
- **Client SDKs** — TypeScript, C#, and Python, same three calls in each: `enqueue`, `registerWorker`, `startWorkers`.

## Quick start

```bash
mkdir my-project && cd my-project
curl -O https://raw.githubusercontent.com/Michyb13/Vigilq/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/Michyb13/Vigilq/main/.env.example
cp .env.example .env
docker compose --profile bundled-db up -d --build
docker compose logs engine | grep "API key"   # first boot only
```

Then open `http://localhost:4000/dashboard/` and paste in that key.

Full walkthrough, SDK usage, worker pools, and the complete environment variable reference: [`docs/`](docs/docs/intro.md).

## Project layout

| Path | What it is |
|---|---|
| `engine/` | The queue itself — Postgres + Fastify. Claiming, retries, backoff, dead-letter, the sweeper, AI triage. |
| `dashboard/` | Next.js monitoring UI, served by the engine on the same port. |
| `autoscaler/` | Optional service that scales worker pool replica counts based on queue depth. |
| `sdks/typescript`, `sdks/csharp`, `sdks/python` | Client SDKs. |
| `docs/` | Full documentation site (Docusaurus). |
| `docker-compose.yml` | The whole stack — bundled or external Postgres, your choice. |

## Two ways to run Postgres

```bash
# Bundled Postgres — simplest for trying it out
DATABASE_URL=postgres://postgres:postgres@db:5432/vigilq   # in .env
docker compose --profile bundled-db up -d

# Your own existing Postgres instance
DATABASE_URL=postgres://user:pass@your-host:5432/your-db   # in .env
docker compose up -d
```

The engine doesn't know or care which mode it's in — schema migrations and everything else run identically either way.

## License

MIT — see [`LICENSE`](LICENSE).
