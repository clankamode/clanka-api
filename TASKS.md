# TASKS.md — clanka-api
> Last updated: 2026-03-01 | Status: open

## 🔴 High Priority
- [x] **Deploy to Cloudflare** — live at https://clanka-api.clankamode.workers.dev (deployed 2026-02-26)
- [x] **Write tests for `/projects` and `/tools` endpoints** — response shape, empty-state, 404 on unknown paths covered in `src/index.test.ts` (2026-02-28)
- [x] **Wire `/projects` data to real source** — fetches from `assistant-tool-registry` via GitHub API, 1hr KV cache (2026-02-26)

## 🟡 Medium Priority
- [x] **Add `/tasks` endpoint** — reads `TASKS.md` from each registered repo, parses open checkboxes, returns `{ repo, tasks: [{ priority, text, done }] }[]` (completed 2026-02-28)
- [x] **Add auth middleware tests** — test: missing auth → 401, wrong token → 401, correct token → 200
- [x] **Add request logging** — log each request to KV list with TTL; max 100 entries rolling
- [x] **KV TTL on presence** — if no heartbeat in 10 min, `/status` returns `{ status: "offline" }`

## 🟢 Low Priority / Nice to Have
- [x] **`/changelog` endpoint** — last 10 git commits from key repos via GitHub API
- [x] **Rate limiting** — IP-based rate limit on public GET endpoints (2026-02-28)
- [x] **OpenAPI spec** — served at `/openapi.json` (2026-02-28)

## 🔴 High Priority
- [x] Add POST endpoint coverage for `/set-presence` in `src/index.test.ts` with strict payload validation (required `presence`, `team`, `activity` fields; reject empty/null payloads with 400 and clear error message). (completed 2026-02-28)
- [x] Add POST endpoint coverage for `/heartbeat` and `/admin/activity` in `src/index.test.ts`, including valid 200 responses, 401 for missing/invalid `Authorization`, and malformed payload guardrails (e.g., non-array history entries). (completed 2026-02-28)
- [x] Add regression tests for `/status` and `/status/uptime` to verify online/offline behavior around `LAST_SEEN_KEY` and `STATUS_OFFLINE_THRESHOLD_MS`. (completed 2026-02-28)

## 🟡 Medium Priority
- [x] Add contract tests for `/now` and `/pulse` in `src/index.test.ts` to assert exact response shape, required fields, and deterministic presence of `status`, `last_seen`, and `signal`. (completed 2026-03-01)
- [x] Add fleet metadata tests for `/fleet/summary` to verify tier/criticality grouping, total repo count, and deterministic ordering. (completed 2026-03-01)
- [x] Add `/fleet/health` endpoint with 5-minute KV cache and graceful GitHub failure fallback (stale cache or 503), plus endpoint tests for success/stale/503 paths. (completed 2026-03-01)
- [x] Upgrade `/fleet/health` CI checks to poll GitHub Actions runs with per-repo KV cache (`ci:<repo>:v1`, 10m TTL), token-less fallback to `UNKNOWN`, and expanded endpoint tests. (completed 2026-03-01)
- [x] Add `GET /status` contract payload and admin-gated `GET /metrics` endpoint (`X-Admin-Token`) with KV-backed counters + fallback behavior, plus vitest coverage. (completed 2026-03-01)
- [x] Add `/tools` + `/changelog` endpoint contract updates: `/tools` returns registry entries with `count/cached/timestamp` (5m KV cache), and `/changelog` now reads `clankamode/meta-runner` commits with `GITHUB_TOKEN` + 10m KV cache and no-token fallback; test suite now at 96 passing tests. (completed 2026-03-01)
- [x] Add endpoint coverage for `/history` query behavior in `src/index.test.ts` (default limit, explicit `limit` clamping/parsing, reverse-chronological ordering, empty+KV miss behavior). (completed 2026-03-01)
- [x] Add `/fleet/summary` regression coverage for malformed/empty `registry:v1` cache values to guarantee safe `200` responses and valid empty shape. (completed 2026-03-01)
- [x] Add docs in `README.md` for admin APIs (`/set-presence`, `/heartbeat`, `/admin/activity`, `/admin/tasks`) with request/response examples and required `Bearer` token flow. (completed 2026-02-28)

## 🟢 Low Priority / Nice to Have
- [x] Add a `README` endpoint matrix table for public/admin routes with auth, method, status code classes, and operational notes. (completed 2026-03-01)
- [x] Add `src/index.test.ts` coverage for malformed/empty GitHub registry cache values in `src/index.ts` fallback paths (`registry:v1`, `GITHUB_STATS_CACHE_KEY`, `github:events:v1`) to avoid 500s and return safe defaults. (completed 2026-03-01)
- [x] Add utility parsing tests for `src/github-events.ts` to lock `repo` normalization and event message truncation (Push/PR/Issue/Create). (completed 2026-03-01)

## 🧠 Notes
- Stack: Cloudflare Workers + KV (`CLANKA_STATE`), TypeScript, Wrangler
- All source in `src/index.ts` — single-file worker
- Bearer token auth on write endpoints (Cloudflare secret `ADMIN_TOKEN`)
