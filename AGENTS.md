# AGENTS.md — clanka-api ⚡

Edge API for Clanka's public presence surface. Cloudflare Worker + KV.

## Stack
- TypeScript
- Cloudflare Workers (wrangler)
- KV namespace: `CLANKA_STATE`
- Secrets: `ADMIN_KEY`, `ADMIN_TOKEN`, `GITHUB_TOKEN`

## Dev Workflow
```bash
npm install
npx wrangler dev          # local dev server
npx wrangler deploy       # deploy to prod
```

## Key Patterns
- Handlers live in `src/router.ts`; `src/index.ts` re-exports `fetch`
- Public endpoints: no auth. Admin write endpoints: `Authorization: Bearer <ADMIN_KEY>`. `/metrics` and `/admin/refresh` use `ADMIN_TOKEN`.
- KV cache pattern: check KV first (key + TTL), fetch on miss, write back
- `GITHUB_TOKEN` used for private GitHub API calls (registry fetch)
- Registry fetched from `clankamode/assistant-tool-registry` via GitHub API, cached 1hr in KV

## Conventions
- CORS headers applied to every response via `corsHeaders` object
- Add new endpoints in the main `fetch()` handler, matching on `url.pathname`
- Never hardcode registry data — always derive from live registry fetch

## Branch Discipline
- Never commit to `main` directly
- Branch: `feat/<slug>` or `fix/<slug>`
- PR → merge → deploy separately

## What Agents Should Do
- Read `TASKS.md` for open work
- Test endpoints locally with `wrangler dev` before deploying
- After any change, verify affected endpoints respond correctly
- Update `TASKS.md` when done

## What Agents Should NOT Do
- Push to main
- Deploy to prod without verifying locally first
- Hardcode data that belongs in the registry
- Expose secrets in responses or logs
