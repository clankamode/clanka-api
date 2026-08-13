import {
  API_VERSION,
  FLEET_HEALTH_CACHE_KEY,
  HISTORY_LIMIT,
  LAST_SEEN_KEY,
  OPENAPI_SPEC,
  STATUS_ENDPOINTS,
  startTime,
} from "./config";
import {
  FLEET_REGISTRY,
  isFleetHealthFresh,
  loadFleetHealthFromGithub,
  loadFleetScorePayload,
  loadFleetTrendFromGithub,
  parseFleetHealthPayload,
} from "./fleet";
import { loadChangelog, loadGithubEvents, loadGithubStats, loadPostsCount } from "./github";
import {
  checkRateLimit,
  incrementMetrics,
  invalidateCacheKey,
  isAuthorized,
  isPublicGetEndpoint,
  isTestEnvironment,
  loadMetrics,
  logRequest,
} from "./middleware";
import {
  collectCacheKeysToInvalidate,
  loadRegistryEntries,
  loadToolsRegistryEntries,
  registryEntriesToProjects,
  searchRegistryTools,
} from "./registry";
import { loadRepoTasks } from "./tasks";
import type { Env, FleetRepo, RepoTasksPayload, WorkerExecutionContext } from "./types";
import { decodeBase64, safeParseJSON } from "./util";
import {
  countActiveAgents,
  getStatusPayload,
  getStatusUptimePayload,
  isOfflineFromLastSeen,
  normalizeHistory,
  parsePositiveEpochMs,
  resolveLastSeenMs,
  resolveStartedMs,
  toHistoryEntry,
} from "./presence";

export async function handleFetch(
  request: Request,
  env: Env,
  ctx?: WorkerExecutionContext,
): Promise<Response> {
    const url = new URL(request.url);

    // Helper for CORS headers
    const corsHeaders = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token, ADMIN_TOKEN",
    };
    const noCacheHeaders = {
      ...corsHeaders,
      "Cache-Control": "no-store",
    };

    const metricsUpdate = incrementMetrics(env);
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(metricsUpdate);
    } else {
      void metricsUpdate;
    }

    const respond = (body?: BodyInit | null, init?: ResponseInit): Response => {
      const response = new Response(body, init);
      const logging = logRequest(env, request, response).catch(() => {
        // ignore logging errors
      });
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(logging);
      } else {
        void logging;
      }
      return response;
    };

    if (request.method === "OPTIONS") {
      return respond(null, { headers: corsHeaders });
    }

    if (request.method === "GET" && isPublicGetEndpoint(url.pathname) && !isTestEnvironment()) {
      const rateLimit = await checkRateLimit(env, request);
      if (!rateLimit.allowed) {
        return respond(JSON.stringify({ error: "Too Many Requests" }), {
          status: 429,
          headers: {
            ...corsHeaders,
            "Retry-After": String(rateLimit.retryAfter),
          },
        });
      }
    }

    // Private endpoint to set state
    if (url.pathname === "/set-presence" && request.method === "POST") {
      if (!isAuthorized(request, env)) {
        // Log failed auth attempt for audit
        try {
          const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
          const key = `auth_fail:${Date.now()}:${Math.floor(Math.random()*100000)}`;
          const payload = JSON.stringify({ path: url.pathname, ip, timestamp: Date.now() });
          await env.CLANKA_STATE.put(key, payload, { expirationTtl: 60 * 60 * 24 * 30 });
        } catch (e) {
          // ignore logging errors
        }
        return respond(`Unauthorized`, { status: 401 });
      }

      const validationError = JSON.stringify({
        error: "Invalid body: presence, team, and activity are required",
      });

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return respond(validationError, { status: 400, headers: corsHeaders });
      }

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return respond(validationError, { status: 400, headers: corsHeaders });
      }

      const payload = body as {
        presence?: unknown;
        team?: unknown;
        activity?: unknown;
        tasks?: unknown;
        ttl?: unknown;
      };

      const hasPresence = payload.presence && typeof payload.presence === "object" && !Array.isArray(payload.presence);
      const hasTeam = payload.team && typeof payload.team === "object" && !Array.isArray(payload.team);
      const hasActivity = payload.activity && typeof payload.activity === "object" && !Array.isArray(payload.activity);

      if (!hasPresence || !hasTeam || !hasActivity) {
        return respond(validationError, { status: 400, headers: corsHeaders });
      }

      const presence = payload.presence as { state?: unknown; message?: unknown };
      const team = payload.team as Record<string, unknown>;
      const activity = payload.activity as Record<string, unknown>;
      const tasks = payload.tasks;
      const state = typeof presence.state === "string" && presence.state.trim() ? presence.state.trim() : "active";
      const message = typeof presence.message === "string" ? presence.message : undefined;
      const ttl = typeof payload.ttl === "number" && Number.isFinite(payload.ttl) && payload.ttl > 0
        ? payload.ttl
        : 1800;

      if (tasks !== undefined) {
        await env.CLANKA_STATE.put("tasks", JSON.stringify(tasks));
      }

      const currentTeamRaw = await env.CLANKA_STATE.get("team") || "{}";
      const currentTeam = safeParseJSON<Record<string, unknown>>(currentTeamRaw, {});
      const updatedTeam = { ...currentTeam, ...team };
      await env.CLANKA_STATE.put("team", JSON.stringify(updatedTeam));

      const historyRaw = await env.CLANKA_STATE.get("history") || "[]";
      const history = normalizeHistory(safeParseJSON<unknown[]>(historyRaw, []));
      const entry = toHistoryEntry(activity, Date.now());
      history.unshift(entry);
      await env.CLANKA_STATE.put("history", JSON.stringify(history.slice(0, HISTORY_LIMIT)));

      const now = Date.now();
      await env.CLANKA_STATE.put(LAST_SEEN_KEY, String(now));

      await env.CLANKA_STATE.put("presence", JSON.stringify({ state, message, timestamp: now }), {
        expirationTtl: ttl,
      });
      return respond(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    if (url.pathname === "/heartbeat" && request.method === "POST") {
      if (!isAuthorized(request, env)) {
        return respond("Unauthorized", { status: 401 });
      }

      let body: unknown = {};
      try {
        body = await request.json();
      } catch {
        // allow empty body and treat as heartbeat-only ping
      }

      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return respond(JSON.stringify({ error: "Invalid body" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const payload = body as { history?: unknown };
      if (payload.history !== undefined && !Array.isArray(payload.history)) {
        return respond(JSON.stringify({ error: "Invalid body: history must be an array" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const heartbeatHistory = payload.history ?? [];
      if (Array.isArray(heartbeatHistory) && heartbeatHistory.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
        return respond(JSON.stringify({ error: "Invalid body: history entries must be objects" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      if (Array.isArray(heartbeatHistory) && heartbeatHistory.length > 0) {
        const historyRaw = await env.CLANKA_STATE.get("history") || "[]";
        const history = normalizeHistory(safeParseJSON<unknown[]>(historyRaw, []));
        const now = Date.now();
        for (let i = heartbeatHistory.length - 1; i >= 0; i -= 1) {
          history.unshift(toHistoryEntry(heartbeatHistory[i], now - i));
        }
        await env.CLANKA_STATE.put("history", JSON.stringify(history.slice(0, HISTORY_LIMIT)));
      }

      const now = Date.now();
      await env.CLANKA_STATE.put(LAST_SEEN_KEY, String(now));
      const startedRaw = await env.CLANKA_STATE.get("started");
      if (!Number.isFinite(Number(startedRaw))) {
        await env.CLANKA_STATE.put("started", String(now));
      }

      return respond(JSON.stringify({
        success: true,
        status: "operational",
        last_seen: new Date(now).toISOString(),
      }), { headers: corsHeaders });
    }

    if (url.pathname === "/history") {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const rawLimit = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(HISTORY_LIMIT, Math.floor(rawLimit))
        : HISTORY_LIMIT;

      const historyRaw = await env.CLANKA_STATE.get("history");
      const historySource = safeParseJSON<unknown[]>(historyRaw, []);
      const history = (Array.isArray(historySource) ? historySource : [])
        .map((entry, index) => toHistoryEntry(entry, Date.now() - index))
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit);

      return respond(JSON.stringify({ history, count: history.length }), {
        headers: corsHeaders,
      });
    }

    if (url.pathname === "/status") {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      return respond(JSON.stringify({
        ok: true,
        version: API_VERSION,
        timestamp: new Date().toISOString(),
        endpoints: STATUS_ENDPOINTS,
      }), { headers: noCacheHeaders });
    }

    if (url.pathname === "/metrics") {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const expectedToken = typeof env.ADMIN_TOKEN === "string" ? env.ADMIN_TOKEN.trim() : "";
      if (!expectedToken) {
        return respond(JSON.stringify({ error: "metrics_unavailable" }), {
          status: 503,
          headers: noCacheHeaders,
        });
      }

      const providedToken = request.headers.get("X-Admin-Token");
      if (providedToken !== expectedToken) {
        return respond(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: noCacheHeaders,
        });
      }

      const metrics = await loadMetrics(env);
      return respond(JSON.stringify({
        uptime_ms: Math.max(0, Date.now() - startTime),
        requests_total: metrics.requests_total,
        kv_hits: metrics.kv_hits,
        kv_misses: metrics.kv_misses,
        timestamp: new Date().toISOString(),
      }), { headers: noCacheHeaders });
    }

    if (url.pathname === "/admin/refresh") {
      if (request.method !== "POST") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: noCacheHeaders,
        });
      }

      const expectedToken = typeof env.ADMIN_TOKEN === "string" ? env.ADMIN_TOKEN.trim() : "";
      if (!expectedToken) {
        return respond(JSON.stringify({ error: "refresh_unavailable" }), {
          status: 503,
          headers: noCacheHeaders,
        });
      }

      const providedToken = request.headers.get("ADMIN_TOKEN");
      if (providedToken !== expectedToken) {
        return respond(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: noCacheHeaders,
        });
      }

      const keys = await collectCacheKeysToInvalidate(env);
      await Promise.all(keys.map(async (key) => invalidateCacheKey(env, key)));
      return respond(JSON.stringify({
        success: true,
        invalidated: keys.length,
        keys,
        timestamp: new Date().toISOString(),
      }), { headers: noCacheHeaders });
    }

    if (url.pathname === "/status/uptime") {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const lastSeenRaw = await env.CLANKA_STATE.get(LAST_SEEN_KEY);
      return respond(JSON.stringify(getStatusUptimePayload(lastSeenRaw)), { headers: corsHeaders });
    }

    if (url.pathname === "/health") {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const lastSeenRaw = await env.CLANKA_STATE.get(LAST_SEEN_KEY);
      return respond(JSON.stringify(getStatusPayload(lastSeenRaw)), { headers: corsHeaders });
    }

    if (url.pathname === "/openapi.json") {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      return respond(JSON.stringify(OPENAPI_SPEC), {
        headers: { ...corsHeaders },
      });
    }

    if (url.pathname === "/fleet/summary") {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const registryEntries = await loadRegistryEntries(env);
      const fleetItems: FleetRepo[] = registryEntries
        .map((e) => ({
          repo: e.repo,
          criticality: e.criticality,
          tier: e.tier,
        }))
        .sort((a, b) => a.repo.localeCompare(b.repo));

      const tiers: Record<FleetTier, string[]> = {
        ops: [],
        infra: [],
        core: [],
        quality: [],
        policy: [],
        template: [],
      };
      const byCriticality: Record<FleetCriticality, string[]> = {
        critical: [],
        high: [],
        medium: [],
      };

      for (const item of fleetItems) {
        tiers[item.tier].push(item.repo);
        byCriticality[item.criticality].push(item.repo);
      }
      for (const tier of Object.keys(tiers) as FleetTier[]) {
        tiers[tier].sort((a, b) => a.localeCompare(b));
      }
      for (const criticality of Object.keys(byCriticality) as FleetCriticality[]) {
        byCriticality[criticality].sort((a, b) => a.localeCompare(b));
      }

      return respond(
        JSON.stringify({
          generatedAt: new Date().toISOString(),
          totalRepos: fleetItems.length,
          repos: fleetItems,
          tiers,
          byCriticality,
          source: "registry",
        }),
        { headers: corsHeaders },
      );
    }

    if (url.pathname === "/fleet/health") {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const cachedPayload = parseFleetHealthPayload(await env.CLANKA_STATE.get(FLEET_HEALTH_CACHE_KEY));
      if (cachedPayload && isFleetHealthFresh(cachedPayload)) {
        return respond(JSON.stringify(cachedPayload), { headers: corsHeaders });
      }

      try {
        const payload = await loadFleetHealthFromGithub(env);
        return respond(JSON.stringify(payload), { headers: corsHeaders });
      } catch {
        if (cachedPayload) {
          return respond(JSON.stringify(cachedPayload), { headers: corsHeaders });
        }
        return respond(JSON.stringify({ error: "Service Unavailable" }), {
          status: 503,
          headers: corsHeaders,
        });
      }
    }

    if (url.pathname === "/fleet/score") {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const payload = await loadFleetScorePayload(env);
      return respond(JSON.stringify(payload), { headers: corsHeaders });
    }

    if (url.pathname === "/pulse") {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const [presenceRaw, historyRaw, teamRaw, lastSeenRaw] = await Promise.all([
        env.CLANKA_STATE.get("presence"),
        env.CLANKA_STATE.get("history"),
        env.CLANKA_STATE.get("team"),
        env.CLANKA_STATE.get(LAST_SEEN_KEY),
      ]);
      const presence = safeParseJSON<{ state?: string; timestamp?: number } | null>(presenceRaw, null);
      const history = normalizeHistory(safeParseJSON<unknown[]>(historyRaw || "[]", []));
      const team = safeParseJSON<unknown>(teamRaw || "{}", {});
      const agentsActive = countActiveAgents(team);
      const lastSeenMs = resolveLastSeenMs(lastSeenRaw, presence?.timestamp);
      const offline = isOfflineFromLastSeen(lastSeenMs);
      const status = offline
        ? "offline"
        : (typeof presence?.state === "string" && presence.state.trim()
          ? presence.state.trim()
          : "unknown");

      return respond(
        JSON.stringify({
          ts: new Date().toISOString(),
          status,
          agents_active: agentsActive,
          last_event_desc: history[0]?.desc || null,
        }),
        { headers: corsHeaders },
      );
    }

    // Tasks CRUD (admin only)
    if (url.pathname === "/admin/tasks") {
      if (!isAuthorized(request, env)) {
        return respond('Unauthorized', { status: 401 });
      }

      if (request.method === 'GET') {
        const tasksRaw = await env.CLANKA_STATE.get("tasks") || "[]";
        const tasks = safeParseJSON<unknown[]>(tasksRaw, []);
        return respond(JSON.stringify(tasks), { headers: corsHeaders });
      }

      if (request.method === 'POST') {
        const body = await request.json();
        const tasksRaw = await env.CLANKA_STATE.get("tasks") || "[]";
        const tasks = safeParseJSON<unknown[]>(tasksRaw, []);
        tasks.push(body);
        await env.CLANKA_STATE.put("tasks", JSON.stringify(tasks));
        return respond(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      if (request.method === 'PUT') {
        const body = await request.json();
        const tasksRaw = await env.CLANKA_STATE.get("tasks") || "[]";
        const tasks = safeParseJSON<unknown[]>(tasksRaw, []);
        const nextTasks = tasks.map((task) => {
          if (!task || typeof task !== "object" || Array.isArray(task)) return task;
          const item = task as { id?: unknown };
          return item.id === (body as { id?: unknown }).id
            ? { ...task, ...body as Record<string, unknown> }
            : task;
        });
        await env.CLANKA_STATE.put("tasks", JSON.stringify(nextTasks));
        return respond(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      if (request.method === 'DELETE') {
        const body = await request.json() as { id?: unknown };
        const tasksRaw = await env.CLANKA_STATE.get("tasks") || "[]";
        const tasks = safeParseJSON<unknown[]>(tasksRaw, []);
        const nextTasks = tasks.filter((task) => {
          if (!task || typeof task !== "object" || Array.isArray(task)) return true;
          return (task as { id?: unknown }).id !== body.id;
        });
        await env.CLANKA_STATE.put("tasks", JSON.stringify(nextTasks));
        return respond(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      return respond(JSON.stringify({ error: "Method Not Allowed" }), {
        status: 405,
        headers: corsHeaders,
      });
    }

    if (url.pathname === "/admin/activity") {
      if (!isAuthorized(request, env)) {
        return respond("Unauthorized", { status: 401 });
      }

      if (request.method !== "POST") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const body = await request.json() as { desc?: unknown; type?: unknown };
      const desc = typeof body.desc === "string" ? body.desc.trim() : "";
      const type = typeof body.type === "string" ? body.type.trim() : "";
      if (!desc || !type) {
        return respond(JSON.stringify({ error: "Invalid body" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const historyRaw = await env.CLANKA_STATE.get("history") || "[]";
      const history = normalizeHistory(safeParseJSON<unknown[]>(historyRaw, []));
      const entry = toHistoryEntry({ desc, type }, Date.now());
      history.unshift(entry);
      const nextHistory = history.slice(0, HISTORY_LIMIT);
      await env.CLANKA_STATE.put("history", JSON.stringify(nextHistory));

      return respond(JSON.stringify({ success: true, entry }), { headers: corsHeaders });
    }

    if (url.pathname === "/projects") {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const entries = await loadRegistryEntries(env);
      const projects = entries.length > 0
        ? registryEntriesToProjects(entries)
        : [];

      return respond(
        JSON.stringify({ projects, source: "registry", cached: true }),
        { headers: corsHeaders },
      );
    }

    if (url.pathname === "/tools/search") {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const query = url.searchParams.get("q")?.trim() || "";
      if (!query) {
        return respond(JSON.stringify({ error: "Missing query parameter: q" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const { entries, cached } = await loadToolsRegistryEntries(env);
      const tools = searchRegistryTools(entries, query);
      return respond(JSON.stringify({
        query,
        count: tools.length,
        tools,
        cached,
        timestamp: new Date().toISOString(),
      }), { headers: corsHeaders });
    }

    if (url.pathname === "/tools") {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const { entries, cached } = await loadToolsRegistryEntries(env);

      return respond(
        JSON.stringify({
          tools: entries,
          count: entries.length,
          cached,
          timestamp: new Date().toISOString(),
        }),
        { headers: corsHeaders },
      );
    }

    if (url.pathname.startsWith("/tools/")) {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      let rawRepo = "";
      try {
        rawRepo = decodeURIComponent(url.pathname.slice("/tools/".length)).trim();
      } catch {
        return respond(JSON.stringify({ error: "Invalid repo path" }), {
          status: 400,
          headers: corsHeaders,
        });
      }
      const { entries, cached } = await loadToolsRegistryEntries(env);
      const match = entries.find((entry) => entry.repo.toLowerCase() === rawRepo.toLowerCase());
      if (!match) {
        return respond(JSON.stringify({ error: "Tool Not Found" }), {
          status: 404,
          headers: corsHeaders,
        });
      }

      return respond(JSON.stringify({
        tool: match,
        cached,
        timestamp: new Date().toISOString(),
      }), { headers: corsHeaders });
    }

    if (url.pathname === "/fleet/trend") {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const payload = await loadFleetTrendFromGithub(env);
      return respond(JSON.stringify(payload), { headers: corsHeaders });
    }

    if (url.pathname === "/tasks") {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const entries = await loadRegistryEntries(env);
      const repos = entries.map((entry) => entry.repo);
      const payload: RepoTasksPayload[] = await Promise.all(
        repos.map(async (repo) => ({
          repo,
          tasks: await loadRepoTasks(env, repo),
        })),
      );

      return respond(JSON.stringify(payload), { headers: corsHeaders });
    }

    if (url.pathname === "/now") {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const [presenceRaw, historyRaw, teamRaw, startedRaw, lastSeenRaw] = await Promise.all([
        env.CLANKA_STATE.get("presence"),
        env.CLANKA_STATE.get("history"),
        env.CLANKA_STATE.get("team"),
        env.CLANKA_STATE.get("started"),
        env.CLANKA_STATE.get(LAST_SEEN_KEY),
      ]);
      const now = Date.now();
      const presence = safeParseJSON<{ state?: string; message?: string; timestamp?: number } | null>(presenceRaw, null);
      const history = normalizeHistory(safeParseJSON<unknown[]>(historyRaw || "[]", []));
      const team = safeParseJSON<unknown>(teamRaw || "{}", {});
      const started = resolveStartedMs(startedRaw, now);
      if (parsePositiveEpochMs(startedRaw) === null) {
        await env.CLANKA_STATE.put("started", String(started));
      }
      const agentsActive = countActiveAgents(team);
      const lastSeenMs = resolveLastSeenMs(lastSeenRaw, presence?.timestamp);
      const offline = isOfflineFromLastSeen(lastSeenMs, now);
      const status = offline
        ? "offline"
        : (typeof presence?.state === "string" && presence.state.trim()
          ? presence.state.trim()
          : "unknown");
      const current = offline
        ? (typeof presence?.message === "string" && presence.message.trim()
          ? presence.message
          : "offline")
        : (typeof presence?.message === "string" && presence.message.trim()
          ? presence.message
          : "online");

      return respond(JSON.stringify({
        current,
        status,
        signal: "⚡",
        stack: ["Cloudflare Workers", "TypeScript", "Lit"],
        timestamp: lastSeenMs,
        uptime: Math.max(0, now - started),
        agents_active: agentsActive,
        last_seen: lastSeenMs === null ? null : new Date(lastSeenMs).toISOString(),
        history,
        team,
      }), { headers: corsHeaders });
    }

    if (url.pathname === "/github/stats") {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const stats = await loadGithubStats(env);
      return respond(JSON.stringify(stats), { headers: corsHeaders });
    }

    if (url.pathname === "/github/events") {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers: corsHeaders });
      }
      const events = await loadGithubEvents(env.CLANKA_STATE);
      return respond(JSON.stringify({ events }), { headers: corsHeaders });
    }

    if (url.pathname === "/changelog") {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const token = typeof env.GITHUB_TOKEN === "string" ? env.GITHUB_TOKEN.trim() : "";
      if (!token) {
        return respond(JSON.stringify({
          commits: [],
          error: "no token",
          timestamp: new Date().toISOString(),
        }), { headers: corsHeaders });
      }

      const commits = await loadChangelog(env);
      return respond(JSON.stringify({
        commits,
        timestamp: new Date().toISOString(),
      }), { headers: corsHeaders });
    }

    if (url.pathname === "/posts/count") {
      if (request.method !== "GET") {
        return respond(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const posts = await loadPostsCount(env);
      return respond(JSON.stringify(posts), { headers: corsHeaders });
    }

    return respond(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: corsHeaders,
    });
}
