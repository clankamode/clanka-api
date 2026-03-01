# clanka-api ⚡

Edge control API behind Clanka's public presence surface and fleet metadata. Runs as a Cloudflare Worker, persists mutable state in KV, and exposes read endpoints for the [public site](https://clankamode.github.io) plus admin-only write paths for presence/task updates.

## Endpoints

| Route | Auth | Method | 2xx | 4xx/5xx | Notes |
|-------|------|--------|-----|---------|-------|
| `/` | None | `GET` | — | `404`, `429` | Root path is currently not mapped to a handler in this worker. |
| `/now` | None | `GET` | `200` | `405`, `429` | Full sync payload (presence, team, history, uptime). |
| `/status` | None | `GET` | `200` | `405`, `429` | Public status contract (`ok`, `version`, endpoint list). |
| `/tools` | None | `GET` | `200` | `405`, `429` | Registry-derived tools list with `cached` + `count`. |
| `/changelog` | None | `GET` | `200` | `405`, `429` | Returns commits; may return empty commits with `error` when token is absent. |
| `/fleet/summary` | None | `GET` | `200` | `405`, `429` | Fleet grouping by tier and criticality from registry data. |
| `/fleet/health` | None | `GET` | `200` | `503`, `405`, `429` | Fleet CI health from cache/GitHub (503 when unavailable and uncached). |
| `/history` | None | `GET` | `200` | `405`, `429` | Activity history, supports `?limit=` (max 20), returns `{ history, count }`. |
| `/metrics` | `X-Admin-Token` | `GET` | `200` | `401`, `503`, `405` | Admin metrics endpoint; no-store response headers. |
| `/heartbeat` | `Authorization: Bearer <ADMIN_KEY>` | `POST` | `200` | `400`, `401` | Heartbeat ping with optional history batch payload. |
| `/set-presence` | `Authorization: Bearer <ADMIN_KEY>` | `POST` | `200` | `400`, `401` | Updates presence/team/activity and `last_seen`. |
| `/admin/activity` | `Authorization: Bearer <ADMIN_KEY>` | `POST` | `200` | `400`, `401`, `405` | Appends normalized activity entries into `/history`. |

## Stack
- Cloudflare Workers + KV (`CLANKA_STATE`)
- TypeScript
- Wrangler

## Development
```bash
npm install
npx wrangler dev        # local dev server
npx wrangler deploy     # deploy to edge
```

## Part of
[`clankamode`](https://github.com/clankamode) — autonomous tooling fleet
