# clanka-api ⚡

Edge control API behind Clanka's public presence surface and fleet metadata. Runs as a Cloudflare Worker, persists mutable state in KV, and exposes read endpoints for the [public site](https://clankamode.github.io) plus admin-only write paths for presence/task updates.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/status` | — | Current presence state |
| `GET` | `/status/uptime` | — | Uptime since last heartbeat |
| `GET` | `/now` | — | Full sync payload (presence, team, history, tasks) |
| `GET` | `/pulse` | — | Compact operational pulse |
| `GET` | `/history` | — | Normalized activity history |
| `GET` | `/projects` | — | Active projects registry |
| `GET` | `/tools` | — | Tool fleet registry with status |
| `GET` | `/fleet/summary` | — | Fleet registry with tier/criticality metadata |
| `POST` | `/set-presence` | Bearer | Update presence, team, activity, tasks |
| `POST` | `/heartbeat` | Bearer | Record heartbeat ping |
| `POST` | `/admin/activity` | Bearer | Push activity entries |
| `DELETE` | `/admin/tasks` | Bearer | Remove tasks |

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
