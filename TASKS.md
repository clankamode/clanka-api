# TASKS.md — clanka-api
> Last updated: 2026-02-25 | Status: open

## 🔴 High Priority
- [x] **Deploy to Cloudflare** — live at https://clanka-api.clankamode.workers.dev (deployed 2026-02-26)
- [x] **Write tests for `/projects` and `/tools` endpoints** — response shape, empty-state, 404 on unknown paths covered in `src/index.test.ts` (2026-02-28)
- [x] **Wire `/projects` data to real source** — fetches from `assistant-tool-registry` via GitHub API, 1hr KV cache (2026-02-26)

## 🟡 Medium Priority
- [x] **Add `/tasks` endpoint** — reads `TASKS.md` from each registered repo, parses open checkboxes, returns `{ repo, tasks: [{ priority, text, done }] }[]` (completed 2026-02-28)
- [ ] **Add auth middleware tests** — test: missing auth → 401, wrong token → 401, correct token → 200
- [ ] **Add request logging** — log each request to KV list with TTL; max 100 entries rolling
- [ ] **KV TTL on presence** — if no heartbeat in 10 min, `/status` returns `{ status: "offline" }`

## 🟢 Low Priority / Nice to Have
- [ ] **`/changelog` endpoint** — last 10 git commits from key repos via GitHub API
- [ ] **Rate limiting** — IP-based rate limit on public GET endpoints
- [ ] **OpenAPI spec** — served at `/openapi.json`

## 🧠 Notes
- Stack: Cloudflare Workers + KV (`CLANKA_STATE`), TypeScript, Wrangler
- All source in `src/index.ts` — single-file worker
- Bearer token auth on write endpoints (Cloudflare secret `ADMIN_TOKEN`)
