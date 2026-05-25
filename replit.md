# Telegram Community Bot

A Telegram bot with referrals, rewards, tasks, leaderboard, and admin controls. Built to scale — ready for future crypto/token withdrawals.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server + Telegram bot (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secret: `TELEGRAM_BOT_TOKEN` — from @BotFather on Telegram
- Optional env: `ADMIN_TELEGRAM_IDS` — comma-separated Telegram IDs with admin access

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Telegram: Telegraf 4
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — API contract (source of truth)
- `lib/db/src/schema/` — DB tables: users, referrals, tasks, userTasks
- `artifacts/api-server/src/lib/bot.ts` — Telegram bot (Telegraf)
- `artifacts/api-server/src/routes/` — API routes: users, tasks, leaderboard, admin
- `lib/api-zod/src/generated/` — generated Zod validators (server-side)
- `lib/api-client-react/src/generated/` — generated React Query hooks (client-side)

## Architecture decisions

- Bot runs as long-polling inside the same Express process — no separate service needed
- Referral reward is hardcoded at 50 pts per invite; easily made configurable via DB setting later
- `onConflictDoNothing()` on user insert makes `/start` idempotent (safe to call multiple times)
- Admin access is controlled via `ADMIN_TELEGRAM_IDS` env var (comma-separated Telegram user IDs)
- All task completions are deduplicated with a unique constraint on `(telegram_id, task_id)`

## Product

Users interact via the Telegram bot:
- `/start [referralCode]` — register, optionally credit a referrer
- **My Balance** — view points and referral count
- **My Referral Link** — get unique invite link (earns 50 pts per signup)
- **Tasks** — complete missions for bonus points (`/complete_<id>`)
- **Leaderboard** — top 10 referrers
- **Help** — command guide

Admins (set via `ADMIN_TELEGRAM_IDS`) can use bot commands:
- `/admin_stats` — community totals
- `/admin_balance <id> <amount>` — adjust balance
- `/admin_bonus <id> <amount>` — grant bonus (notifies user)
- `/admin_ban` / `/admin_unban` — user moderation
- `/admin_addtask <reward> <title> | <desc>` — create a task
- `/admin_tasks` — list all tasks

## User preferences

- Future-ready for crypto/TON token withdrawals
- Admin panel via bot commands (no separate web UI needed initially)
- Scalable community features

## Gotchas

- Always run `pnpm --filter @workspace/api-spec run codegen` after changing `openapi.yaml`
- Always run `pnpm --filter @workspace/db run push` after changing DB schema files
- The bot uses long-polling — only one instance should run at a time
- To set admin access: add `ADMIN_TELEGRAM_IDS=123456789,987654321` as an env var

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
