# Carnival Mailing

![CI](https://github.com/leocastillocastro/carnival-mailing/actions/workflows/ci.yml/badge.svg)

Self-hosted email marketing platform built for **Carnival**, a butcher shop in Barcelona with a WooCommerce online store.

It replaces a SaaS tool like Mailchimp: it syncs customers and orders from WooCommerce, lets the owner build segments ("bought product X", "no order in 60 days", "abandoned cart"), sends campaigns through **Amazon SES**, and tracks opens, clicks, bounces and unsubscribes — GDPR-compliant.

> This is a sanitized public copy of the production system. Real domains, business contact details and internal notes were removed; no credentials or customer data are included.

## Architecture

```mermaid
flowchart LR
    WC[WooCommerce store] -- webhooks + backfill --> API[apps/api]
    API --> PG[(PostgreSQL)]
    ADMIN[apps/admin] --> PG
    ADMIN -- enqueue campaign --> Q[(Redis / BullMQ)]
    Q --> W[apps/worker]
    W -- SendEmail --> SES[Amazon SES]
    SES --> R[Recipients]
    SES -- bounces / complaints --> SNS[Amazon SNS]
    SNS -- signed webhook --> API
    R -- opens / clicks / unsubscribe --> API
```

| Part | What it does |
|---|---|
| `apps/api` | Public API (Fastify): WooCommerce webhooks, SES/SNS bounce webhook, open/click tracking, one-click unsubscribe |
| `apps/worker` | Queue consumer: sends each email through SES with rate limiting, retries and suppression checks |
| `apps/admin` | Server-rendered admin UI (LAN-only): lists, templates (visual editor), segments, campaigns |
| `packages/db` | PostgreSQL schema and migrations (Drizzle ORM) |
| `packages/woocommerce` | WooCommerce REST client, webhook signature verification, data mappers |
| `packages/mailer` | SES client, SNS signature verification, SSRF guard |
| `packages/queue` | BullMQ queue and rate limiter |
| `packages/segments` | JSON rule tree compiled to safe, parameterized SQL |
| `packages/templates` | Handlebars personalization, link tracking, open pixel |
| `packages/campaigns` | Resolves a campaign's audience and enqueues the sends |
| `infra/` | Docker Compose (PostgreSQL 16, Redis 7) and Caddy with automatic TLS |

## Tech stack

Node.js · TypeScript · pnpm monorepo · Fastify · PostgreSQL · Drizzle ORM · Redis · BullMQ · Amazon SES · Amazon SNS · Handlebars · Docker · Caddy · Vitest

## Data engineering highlights

- **Ingestion:** customers and orders arrive in near real time through WooCommerce webhooks (HMAC-verified), plus a backfill script for historical data.
- **Event-driven processing:** campaign sends go through a Redis/BullMQ queue; bounce and complaint events arrive from Amazon SES via SNS.
- **Idempotency:** each send is claimed with an atomic `UPDATE`, and queue jobs use deterministic IDs, so a crash or retry never sends the same email twice.
- **Safe dynamic queries:** segments are stored as JSON rule trees and compiled to SQL through an allowlist of columns and bound parameters — user input is never interpolated into SQL.

## Security and compliance

- SNS messages are verified with AWS's RSA signature algorithm, and the topic ARN is checked.
- RFC 8058 one-click unsubscribe (required by Gmail and Yahoo since 2024), with global suppression list.
- Rate-limited admin login, constant-time password check (no timing attacks), hashed session tokens.
- Click tracking only redirects for real send tokens (no open redirect).
- AWS credentials are never stored in the repo; they come from the standard SDK credential chain.

## Getting started

Requirements: Node.js 22+, pnpm (`corepack enable`), Docker, a POSIX shell with `openssl`.

There is no root `.env`. Each package runs from its own directory (`pnpm --filter`), so each one reads the `.env` next to its own `package.json`. Every package that needs one ships a `.env.example`.

**1. Install dependencies**

```bash
pnpm install
```

**2. Start Postgres and Redis.** Their passwords live in `infra/.env`, and `docker compose` refuses to start without it. Both ports are bound to `127.0.0.1` only.

```bash
printf 'POSTGRES_PASSWORD=%s\nREDIS_PASSWORD=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > infra/.env
docker compose -f infra/docker-compose.yml up -d postgres redis
```

> If you ran an older version of this compose file, the existing `postgres_data` volume keeps its old password. Run `docker compose -f infra/docker-compose.yml down -v` first. This deletes local data.

**3. Create each package's `.env`** from its example, filling in the passwords from step 2 and a random SNS webhook token:

```bash
set -a; . infra/.env; set +a
for dir in apps/api apps/worker apps/admin packages/db packages/segments packages/campaigns; do
  sed -e "s|carnival:CHANGE_ME@|carnival:${POSTGRES_PASSWORD}@|" \
      -e "s|redis://:CHANGE_ME@|redis://:${REDIS_PASSWORD}@|" \
      "$dir/.env.example" > "$dir/.env"
done
sed -i.bak "s|^SES_WEBHOOK_TOKEN=.*|SES_WEBHOOK_TOKEN=$(openssl rand -hex 32)|" apps/api/.env && rm apps/api/.env.bak
```

The remaining values are local-development placeholders. Real WooCommerce keys are only needed for `backfill`. Actually sending email needs AWS credentials from the standard SDK chain (never from `.env`).

**4. Migrate the database and create an admin user**

```bash
pnpm --filter @carnival/db migrate
pnpm --filter @carnival/admin createUser -- you@example.com
```

`createUser` prompts for the password twice without echoing it, so it never lands in shell history or the process list.

**5. Run the apps**, each in its own terminal:

```bash
pnpm --filter @carnival/api dev      # http://localhost:3000
pnpm --filter @carnival/worker dev
pnpm --filter @carnival/admin dev    # http://localhost:3001
```

The admin listens on `127.0.0.1` by default. To reach it from other machines on the LAN, set `HOST=0.0.0.0` in `apps/admin/.env`, and only do that behind a firewall that keeps port 3001 off the internet. The admin serves plain HTTP.

Run the checks:

```bash
pnpm typecheck
pnpm test        # integration tests need the containers from step 2 and the .env files from step 3
```

The suite has 47 test files, combining unit tests and integration tests against real PostgreSQL and Redis.

## How it was built

Solo project: I designed and built it end to end for my own business — from the requirements and architecture (after comparing Listmonk, Mautic and SendPortal) to the security audits behind the hardening above. I used **AI-assisted development (Claude Code)** as my coding tool.

## Author

**Leonardo Castillo** — Barcelona · [github.com/leocastillocastro](https://github.com/leocastillocastro)

All rights reserved. The code is shared for portfolio purposes.
