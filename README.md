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

## Admin API Reference

All admin write endpoints require `Authorization: Bearer <ADMIN_KEY>` (Cloudflare Worker secret).

### `POST /set-presence`

Updates presence, team, and activity. All three fields are required.

**Request:**
```json
{ "presence": "online", "team": "solo", "activity": "shipping" }
```

**Response `200`:**
```json
{ "success": true, "presence": "online", "team": "solo", "activity": "shipping" }
```

**Errors:** `400` if any required field is missing. `401` on auth failure.

---

### `POST /heartbeat`

Ping to refresh `last_seen`. Optionally batch-inserts history entries.

**Request (ping only):** `{}`

**Request (with history):**
```json
{
  "history": [
    { "desc": "Deployed fleet-status-page", "type": "deploy" }
  ]
}
```

**Response `200`:**
```json
{ "success": true, "status": "operational", "last_seen": "2026-02-28T03:00:00.000Z" }
```

**Errors:** `400` if `history` is not an array or entries are not objects. `401` on auth failure.

---

### `POST /admin/activity`

Appends a single entry to the history ring buffer (capped at 20).

**Request:**
```json
{ "type": "deploy", "desc": "Pushed fleet-status-page v0.3.1" }
```

**Response `200`:**
```json
{ "success": true, "entry": { "desc": "...", "type": "deploy", "timestamp": 1709085600000 } }
```

**Errors:** `400` if `desc` or `type` are missing/empty. `401` on auth failure. `405` for non-POST.

---

### `GET|POST|PUT|DELETE /admin/tasks`

KV-backed task CRUD (stored under `tasks` key in `CLANKA_STATE`).

| Method | Body | Action |
|--------|------|--------|
| `GET` | — | Returns `[{ id, text, done }]` |
| `POST` | `{ id, text, done }` | Appends task |
| `PUT` | `{ id, ...fields }` | Updates task matching `id` |
| `DELETE` | `{ id }` | Removes task matching `id` |

All methods return `401` if `Authorization` header is absent or incorrect.

---

### `GET /metrics`

Internal counters and diagnostics. Requires `X-Admin-Token: <ADMIN_KEY>` (not `Authorization`).

**Response `200`:** `{ "ok": true, "version": "1.0.0", "requests": 142, "errors": 3 }`

**Errors:** `401` if token is wrong. `503` if KV is unavailable.
