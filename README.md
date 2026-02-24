# clanka-api

`clanka-api` is the edge control API behind Clanka's public presence surface and fleet metadata. It runs as a Cloudflare Worker, persists mutable state in `CLANKA_STATE` KV, and exposes read endpoints for the site plus admin-only write paths for task/presence updates.

## Stack
- Cloudflare Workers (`wrangler`)
- TypeScript
- Cloudflare KV (`CLANKA_STATE`)

## Run And Deploy
Install dependencies:
```bash
npm install
```

Run locally:
```bash
npx wrangler dev
```

Deploy:
```bash
npx wrangler deploy
```

Required bindings/secrets:
- KV binding: `CLANKA_STATE`
- secret: `ADMIN_KEY`

Set secret:
```bash
npx wrangler secret put ADMIN_KEY
```

## Endpoints
Public:
- `GET /status` - health/status payload
- `GET /now` - live presence payload used by the site
- `GET /fleet/summary` - 16-repo fleet map grouped by tier and criticality
- `GET /status/uptime` - gateway up/down, last seen, current activity, 24h uptime %
- `GET /status/history` - last 20 heartbeat timestamps (ISO + epoch)

Admin (`Authorization: Bearer <ADMIN_KEY>`):
- `POST /set-presence` - set presence + optionally append activity/team/tasks
- `GET /admin/tasks` - list tasks
- `POST /admin/tasks` - add task
- `PUT /admin/tasks` - update task by `id`
- `DELETE /admin/tasks` - delete task by `id`
- `POST /heartbeat` - record a heartbeat; updates `heartbeat_history` KV (max 500) and `state` KV

### `GET /status/uptime` response shape
```json
{
  "gateway_up": true,
  "last_seen": "2026-02-24T12:00:00.000Z",
  "current_activity": "working on clanka-api",
  "uptime_pct_24h": 98.61
}
```
- `gateway_up`: `true` if the most recent heartbeat was within the last 5 minutes
- `uptime_pct_24h`: percentage of 5-minute windows in the last 24 h (288 total) that contain at least one heartbeat

### `GET /status/history` response shape
```json
{
  "entries": [
    { "timestamp": 1708776000000, "iso": "2026-02-24T12:00:00.000Z" }
  ]
}
```
Returns the most recent 20 heartbeat entries, newest first.

Fallback root response advertises service identity and endpoint list.
