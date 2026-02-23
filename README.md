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

Admin (`Authorization: Bearer <ADMIN_KEY>`):
- `POST /set-presence` - set presence + optionally append activity/team/tasks
- `GET /admin/tasks` - list tasks
- `POST /admin/tasks` - add task
- `PUT /admin/tasks` - update task by `id`
- `DELETE /admin/tasks` - delete task by `id`

Fallback root response advertises service identity and endpoint list.
