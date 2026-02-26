# TASKS.md — clanka-api
> Last updated: 2026-02-25 | Status: open

## 🔴 High Priority
- [ ] **Deploy to Cloudflare** — verify worker is live at production URL. Run `npx wrangler deploy`, set KV namespace `CLANKA_STATE` if not done
- [ ] **Write tests for `/projects` and `/tools` endpoints** — added in ce0c893 but may lack test coverage. Add: response shape, empty-state, 404 on unknown paths
- [ ] **Wire `/projects` data to real source** — likely hardcoded. Fetch from `assistant-tool-registry` registry.json via GitHub raw URL or KV cache

## 🟡 Medium Priority
- [ ] **Add `/tasks` endpoint** — reads `TASKS.md` from each registered repo, parses open checkboxes, returns `{ repo, tasks: [{ priority, text, done }] }[]`
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
