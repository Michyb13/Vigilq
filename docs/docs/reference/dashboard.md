---
sidebar_position: 3
title: Dashboard
---

# Dashboard

Served by the engine's own process, at `http://localhost:4000/dashboard/` — no separate service, no separate port. It's a read-only client of the same REST API the SDKs use; nothing about the queue changes because the dashboard exists.

## Access

Enter your queue API key once — it's verified against the real API, then kept in the browser's `localStorage`. There's no server-side session, since the dashboard has no backend of its own.

## Pages

- **Overview** — job counts by status, pending count per pool. Auto-refreshes every 5 seconds.
- **Jobs** — full list, filterable by status.
- **Job detail** — payload, attempt history, and (for dead-lettered jobs) the AI triage result if one exists. Linked from the Jobs and Dead Letter pages.
- **Dead Letter** — every job that exhausted its retries, with its AI classification and suggested fix shown inline once triage has run.
