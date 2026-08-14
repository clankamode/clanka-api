# clanka-api ⚡

Edge control API behind Clanka's public presence surface and fleet metadata. Runs as a Cloudflare Worker, persists mutable state in KV, and exposes read endpoints for the [public site](https://clankamode.github.io) plus admin-only write paths for presence/task updates.

## Endpoints

| Route | Auth | Method | 2xx | 4xx/5xx | Notes |
|-------|------|--------|-----|---------|-------|
| `/` | None | `GET` | — | `404`, `429` | Not mapped — do not treat as a health probe. |
| `/status` | None | `GET` | `200` | `405`, `429` | Service contract: `{ ok, version, timestamp, endpoints }`. Not liveness. |
| `/health` | None | `GET` | `200` | `405`, `429` | Liveness from heartbeat (`operational` / `offline`). |
| `/status/uptime` | None | `GET` | `200` | `405`, `429` | Uptime + `last_seen`; `offline` when heartbeat is stale/missing. |
| `/now` | None | `GET` | `200` | `405`, `429` | Full sync payload (presence, team, history, uptime). |
| `/pulse` | None | `GET` | `200` | `405`, `429` | Compact presence pulse for the public surface. |
| `/tools` | None | `GET` | `200` | `405`, `429` | Registry-derived tools list with `cached` + `count`. |
| `/tools/search` | None | `GET` | `200` | `400`, `405`, `429` | Requires `?q=`. |
| `/tools/:repo` | None | `GET` | `200` | `404`, `405`, `429` | Single registry tool by repo name. |
| `/projects` | None | `GET` | `200` | `405`, `429` | Core/critical registry projects. |
| `/tasks` | None | `GET` | `200` | `405`, `429` | Parsed open checkboxes from each repo `TASKS.md`. |
| `/changelog` | None | `GET` | `200` | `405`, `429` | Commits from `meta-runner`; `available: false` + `error` when token missing or GitHub unreachable. |
| `/fleet/summary` | None | `GET` | `200` | `405`, `429` | Fleet grouping by tier and criticality from registry data. |
| `/fleet/health` | None | `GET` | `200` | `503`, `405`, `429` | Fleet CI health from cache/GitHub (503 when unavailable and uncached). |
| `/fleet/score` | None | `GET` | `200` | `405`, `429` | Aggregate fleet health score. |
| `/fleet/trend` | None | `GET` | `200` | `405`, `429` | Per-repo CI conclusion trend. |
| `/history` | None | `GET` | `200` | `405`, `429` | Activity history, supports `?limit=` (max 20), returns `{ history, count }`. |
| `/github/stats` | None | `GET` | `200` | `405`, `429` | Org repo/star aggregates (`available: false` when GitHub is unreachable). |
| `/github/events` | None | `GET` | `200` | `405`, `429` | Recent public GitHub events (`available: false` when GitHub is unreachable). |
| `/posts/count` | None | `GET` | `200` | `405`, `429` | Blog post count from `clankamode.github.io` posts dir. |
| `/openapi.json` | None | `GET` | `200` | `405`, `429` | OpenAPI 3 document for documented routes. |
| `/metrics` | `X-Admin-Token: <ADMIN_TOKEN>` | `GET` | `200` | `401`, `503`, `405` | Admin metrics; no-store. Uses `ADMIN_TOKEN`, not Bearer. |
| `/heartbeat` | `Authorization: Bearer <ADMIN_KEY>` | `POST` | `200` | `400`, `401` | Heartbeat ping with optional history batch payload. |
| `/set-presence` | `Authorization: Bearer <ADMIN_KEY>` | `POST` | `200` | `400`, `401` | Updates presence/team/activity objects and `last_seen`. |
| `/admin/activity` | `Authorization: Bearer <ADMIN_KEY>` | `POST` | `200` | `400`, `401`, `405` | Appends normalized activity entries into `/history`. |
| `/admin/tasks` | `Authorization: Bearer <ADMIN_KEY>` | `GET/POST/PUT/DELETE` | `200` | `401`, `405` | KV-backed task CRUD. |
| `/admin/refresh` | `ADMIN_TOKEN: <ADMIN_TOKEN>` | `POST` | `200` | `401`, `503`, `405` | Invalidates registry/CI caches. Header name is literally `ADMIN_TOKEN`. |

## Stack
- Cloudflare Workers + KV (`CLANKA_STATE`)
- TypeScript
- Wrangler

## Secrets
| Secret | Used by |
|--------|---------|
| `ADMIN_KEY` | `Authorization: Bearer` on `/set-presence`, `/heartbeat`, `/admin/*` (except refresh) |
| `ADMIN_TOKEN` | `X-Admin-Token` on `/metrics`, `ADMIN_TOKEN` header on `/admin/refresh` |
| `GITHUB_TOKEN` | Private registry + changelog/fleet GitHub calls |

## Development
```bash
npm install
npx wrangler dev        # local dev server
npx wrangler deploy     # deploy to edge
```

## Part of
[`clankamode`](https://github.com/clankamode) — autonomous tooling fleet

## Admin API Reference

Write endpoints below require `Authorization: Bearer <ADMIN_KEY>` (Cloudflare Worker secret `ADMIN_KEY`).
`/metrics` and `/admin/refresh` use `ADMIN_TOKEN` instead — see those sections.

### `POST /set-presence`

Updates presence, team, and activity. All three fields are **required objects** (string values are rejected with `400`).

**Request:**
```json
{
  "presence": { "state": "active", "message": "shipping" },
  "team": { "clanka": { "status": "active", "task": "deploy" } },
  "activity": { "type": "deploy", "desc": "Pushed clanka-api" }
}
```

Optional: `tasks` (stored as-is), `ttl` (presence KV TTL seconds, default `1800`).

**Response `200`:**
```json
{ "success": true }
```

**Errors:** `400` if `presence`, `team`, or `activity` are missing or not objects. `401` on auth failure.

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

Internal counters and diagnostics. Requires `X-Admin-Token: <ADMIN_TOKEN>` (not `Authorization`, and not `ADMIN_KEY`).

**Response `200`:**
```json
{
  "uptime_ms": 142000,
  "requests_total": 142,
  "kv_hits": 80,
  "kv_misses": 12,
  "timestamp": "2026-03-01T00:00:00.000Z"
}
```

**Errors:** `401` if token is wrong. `503` if `ADMIN_TOKEN` is unset (`metrics_unavailable`).

---

### `POST /admin/refresh`

Invalidates registry and CI cache keys. Requires header `ADMIN_TOKEN: <ADMIN_TOKEN>` (literal header name).

**Response `200`:**
```json
{
  "success": true,
  "invalidated": 12,
  "keys": ["registry:v1", "..."],
  "timestamp": "2026-03-01T00:00:00.000Z"
}
```

**Errors:** `401` if token is wrong. `503` if `ADMIN_TOKEN` is unset (`refresh_unavailable`).
