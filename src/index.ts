import { loadGithubEvents } from "./github-events";

export interface Env {
  CLANKA_STATE: KVNamespace;
  ADMIN_KEY: string;
  GITHUB_TOKEN?: string;
}

type FleetTier = "ops" | "infra" | "core" | "quality" | "policy" | "template";
type FleetCriticality = "critical" | "high" | "medium";
type FleetRepo = { repo: string; criticality: FleetCriticality; tier: FleetTier };
type HistoryEntry = { timestamp: number; desc: string; type: string; hash: string };

type ToolStatus = "active" | "development" | "planned";
type Tool = { name: string; description: string; status: ToolStatus; tier?: string; criticality?: string };
type Project = { name: string; description: string; url: string; status: string; last_updated: string };
type RequestLogEntry = { timestamp: number; method: string; pathname: string; query: string; ip: string; ua?: string };
type ChangelogEntry = {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
};

const HISTORY_LIMIT = 20;
const REGISTRY_URL = "https://api.github.com/repos/clankamode/assistant-tool-registry/contents/registry.json";
const REGISTRY_CACHE_KEY = "registry:v1";
const REGISTRY_TTL_SEC = 3600; // 1 hour

const REQUEST_LOG_KEY = "request_log";
const REQUEST_LOG_TTL_SEC = 24 * 60 * 60; // 24h
const REQUEST_LOG_LIMIT = 100;

const LAST_SEEN_KEY = "last_seen";
const STATUS_OFFLINE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

const GITHUB_STATS_CACHE_KEY = "github:stats:v1";
const GITHUB_STATS_TTL_SEC = 3600; // 1 hour

const CHANGELOG_CACHE_KEY = "changelog:v1";
const CHANGELOG_TTL_SEC = 5 * 60; // 5 minutes
const CHANGELOG_URL = "https://api.github.com/repos/clankamode/clanka/commits?per_page=10";

const RATE_LIMIT_KEY_PREFIX = "rate_limit:ip:";
const RATE_LIMIT_WINDOW_SEC = 60;
const RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_SEC * 1000;
const RATE_LIMIT_MAX_REQUESTS = 60;

const OPENAPI_SPEC = {
  openapi: "3.0.3",
  info: {
    title: "clanka-api",
    version: "1.0.0",
    description: "Edge API for Clanka public endpoints",
  },
  paths: {
    "/status": {
      get: {
        summary: "Get service status",
        responses: {
          "200": {
            description: "Current status payload",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string" },
                    timestamp: { type: "string" },
                    signal: { type: "string" },
                    last_seen: { type: "string" },
                  },
                  additionalProperties: true,
                },
              },
            },
          },
          "429": {
            description: "Too Many Requests",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: { type: "string" },
                  },
                  required: ["error"],
                },
              },
            },
          },
        },
      },
    },
    "/health": {
      get: {
        summary: "Health check",
        responses: {
          "200": {
            description: "Health payload",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string" },
                    timestamp: { type: "string" },
                    signal: { type: "string" },
                    last_seen: { type: "string" },
                  },
                  additionalProperties: true,
                },
              },
            },
          },
          "429": {
            description: "Too Many Requests",
          },
        },
      },
    },
    "/projects": {
      get: {
        summary: "Get active projects from registry",
        responses: {
          "200": {
            description: "Projects payload",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    projects: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          description: { type: "string" },
                          url: { type: "string" },
                          status: { type: "string" },
                          last_updated: { type: "string" },
                        },
                        required: ["name", "description", "url", "status", "last_updated"],
                      },
                    },
                    source: { type: "string" },
                    cached: { type: "boolean" },
                  },
                  required: ["projects", "source", "cached"],
                },
              },
            },
          },
          "429": {
            description: "Too Many Requests",
          },
        },
      },
    },
    "/tools": {
      get: {
        summary: "Get registered tools",
        responses: {
          "200": {
            description: "Tools payload",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tools: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          description: { type: "string" },
                          status: { type: "string" },
                          tier: { type: "string" },
                          criticality: { type: "string" },
                        },
                        required: ["name", "description", "status"],
                      },
                    },
                    total: { type: "number" },
                    source: { type: "string" },
                  },
                  required: ["tools", "total", "source"],
                },
              },
            },
          },
          "429": {
            description: "Too Many Requests",
          },
        },
      },
    },
    "/tasks": {
      get: {
        summary: "Get parsed open tasks per repo",
        responses: {
          "200": {
            description: "Task payload",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      repo: { type: "string" },
                      tasks: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            priority: { type: "string" },
                            text: { type: "string" },
                            done: { type: "boolean" },
                          },
                          required: ["priority", "text", "done"],
                        },
                      },
                    },
                    required: ["repo", "tasks"],
                  },
                },
              },
            },
          },
          "429": {
            description: "Too Many Requests",
          },
        },
      },
    },
    "/changelog": {
      get: {
        summary: "Get recent commit changelog",
        responses: {
          "200": {
            description: "Changelog payload",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    commits: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          sha: { type: "string" },
                          message: { type: "string" },
                          author: { type: "string" },
                          date: { type: "string" },
                          url: { type: "string" },
                        },
                        required: ["sha", "message", "author", "date", "url"],
                      },
                    },
                  },
                  required: ["commits"],
                },
              },
            },
          },
          "429": {
            description: "Too Many Requests",
          },
        },
      },
    },
    "/openapi.json": {
      get: {
        summary: "Get OpenAPI 3 specification",
        responses: {
          "200": {
            description: "OpenAPI document",
          },
        },
      },
    },
  },
};

type RegistryEntry = {
  repo: string;
  criticality: FleetCriticality;
  tier: FleetTier;
  description?: string;
};

type TaskPriority = "red" | "yellow" | "green";
type RepoTask = { priority: TaskPriority; text: string; done: boolean };
type RepoTasksPayload = { repo: string; tasks: RepoTask[] };
type RateLimitState = {
  count: number;
  resetAt: number;
};

function decodeBase64(value: string): string {
  const normalized = value.replace(/\n/g, "");
  if (typeof atob === "function") {
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(normalized, "base64").toString("utf8");
}

function getClientIp(request: Request): string {
  const connectingIp = request.headers.get("CF-Connecting-IP");
  if (connectingIp) return connectingIp;
  const forwarded = request.headers.get("X-Forwarded-For");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || forwarded;
  }
  return request.headers.get("X-Real-IP") || "unknown";
}

function isPublicGetEndpoint(pathname: string): boolean {
  return pathname !== "/set-presence" && !pathname.startsWith("/admin");
}

async function checkRateLimit(env: Env, request: Request): Promise<{ allowed: boolean; retryAfter: number }> {
  const key = `${RATE_LIMIT_KEY_PREFIX}${getClientIp(request)}`;
  const now = Date.now();
  const raw = await env.CLANKA_STATE.get(key);
  const state = safeParseJSON<RateLimitState | null>(raw, null) ?? { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  const hasWindow = Number.isFinite(state.resetAt) && state.resetAt > now;
  const validState = Number.isFinite(state.count) && state.count >= 0;
  const current: RateLimitState = validState && hasWindow
    ? state
    : { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    await env.CLANKA_STATE.put(key, JSON.stringify(current), { expirationTtl: RATE_LIMIT_WINDOW_SEC });
    return { allowed: false, retryAfter };
  }

  const next = { ...current, count: current.count + 1 };
  await env.CLANKA_STATE.put(key, JSON.stringify(next), { expirationTtl: RATE_LIMIT_WINDOW_SEC });
  return { allowed: true, retryAfter: Math.max(1, Math.ceil((next.resetAt - now) / 1000)) };
}

function getStatusPayload(lastSeenRaw: string | null) {
  const lastSeen = typeof lastSeenRaw === "string" ? Number(lastSeenRaw) : NaN;
  const now = Date.now();
  if (!Number.isFinite(lastSeen) || now - lastSeen > STATUS_OFFLINE_THRESHOLD_MS) {
    return { status: "offline" };
  }

  return {
    status: "operational",
    timestamp: new Date().toISOString(),
    signal: "⚡",
    last_seen: new Date(lastSeen).toISOString(),
  };
}

function getStatusUptimePayload(lastSeenRaw: string | null) {
  const lastSeen = typeof lastSeenRaw === "string" ? Number(lastSeenRaw) : NaN;
  const now = Date.now();
  if (!Number.isFinite(lastSeen) || now - lastSeen > STATUS_OFFLINE_THRESHOLD_MS) {
    return {
      status: "offline",
      uptime_ms: 0,
      last_seen: null,
    };
  }

  return {
    status: "operational",
    uptime_ms: Math.max(0, now - lastSeen),
    last_seen: new Date(lastSeen).toISOString(),
  };
}

async function logRequest(env: Env, request: Request): Promise<void> {
  const url = new URL(request.url);
  const rawLog = await env.CLANKA_STATE.get(REQUEST_LOG_KEY);
  let requestLog = safeParseJSON<unknown[]>(rawLog, []);
  if (!Array.isArray(requestLog)) {
    requestLog = [];
  }

  const nextLog: RequestLogEntry[] = [...requestLog, {
    timestamp: Date.now(),
    method: request.method,
    pathname: url.pathname,
    query: url.search,
    ip: getClientIp(request),
    ua: request.headers.get("User-Agent") || undefined,
  }];
  const trimmedLog = nextLog.length > REQUEST_LOG_LIMIT ? nextLog.slice(-REQUEST_LOG_LIMIT) : nextLog;

  await env.CLANKA_STATE.put(REQUEST_LOG_KEY, JSON.stringify(trimmedLog), {
    expirationTtl: REQUEST_LOG_TTL_SEC,
  });
}

function isAuthorized(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization");
  const expected = `Bearer ${env.ADMIN_KEY}`;
  return auth === expected;
}

async function loadChangelog(env: Env): Promise<ChangelogEntry[]> {
  const cached = await env.CLANKA_STATE.get(CHANGELOG_CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached) as ChangelogEntry[];
    } catch {
      // fall through to fetch
    }
  }

  const headers: Record<string, string> = {
    "User-Agent": "clanka-api/1.0",
    "Accept": "application/vnd.github.v3+json",
  };

  const res = await fetch(CHANGELOG_URL, { headers });
  if (!res.ok) return [];

  const body = await res.json() as unknown;
  if (!Array.isArray(body)) return [];

  const payload = body
    .slice(0, 10)
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const commitInfo = (item as { commit?: { message?: string; author?: { name?: string; date?: string }; committer?: { date?: string } }; author?: { login?: string }; sha?: string; html_url?: string });
      const commit = commitInfo.commit || {};
      const commitAuthor = commitInfo.author;
      const htmlUrl = typeof commitInfo.html_url === "string" ? commitInfo.html_url : "";
      const sha = typeof commitInfo.sha === "string" ? commitInfo.sha : "";
      const message = typeof commit.message === "string" ? commit.message : "";
      const author = typeof commitAuthor?.login === "string"
        ? commitAuthor.login
        : typeof commit.author?.name === "string"
          ? commit.author.name
          : "unknown";
      const date = typeof commit.author?.date === "string"
        ? commit.author.date
        : typeof commit.committer?.date === "string"
          ? commit.committer.date
          : new Date().toISOString();

      if (!sha) return null;
      return {
        sha,
        message,
        author,
        date,
        url: htmlUrl || `https://github.com/clankamode/clanka/commit/${sha}`,
      };
    })
    .filter((entry): entry is ChangelogEntry => Boolean(entry));

  await env.CLANKA_STATE.put(CHANGELOG_CACHE_KEY, JSON.stringify(payload), {
    expirationTtl: CHANGELOG_TTL_SEC,
  });
  return payload;
}

async function loadRegistryEntries(env: Env): Promise<RegistryEntry[]> {
  // Try KV cache first
  const cached = await env.CLANKA_STATE.get(REGISTRY_CACHE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { tools?: RegistryEntry[] } | RegistryEntry[];
      return Array.isArray(parsed) ? parsed : (parsed.tools ?? []);
    } catch { /* fall through to fetch */ }
  }

  // Fetch from GitHub API (handles private repos via token)
  try {
    const headers: Record<string, string> = {
      "User-Agent": "clanka-api/1.0",
      "Accept": "application/vnd.github.v3+json",
    };
    if (env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;

    const res = await fetch(REGISTRY_URL, { headers });
    if (!res.ok) return [];
    const meta = await res.json() as { content?: string };
    if (!meta.content) return [];
    const json = decodeBase64(meta.content);
    const data = JSON.parse(json) as { tools?: RegistryEntry[] } | RegistryEntry[];
    const entries = Array.isArray(data) ? data : (data.tools ?? []);
    // Cache it
    await env.CLANKA_STATE.put(REGISTRY_CACHE_KEY, JSON.stringify(entries), { expirationTtl: REGISTRY_TTL_SEC });
    return entries;
  } catch {
    return [];
  }
}

function parseOpenTasksMarkdown(markdown: string): RepoTask[] {
  const lines = markdown.split(/\r?\n/);
  const tasks: RepoTask[] = [];
  let currentPriority: TaskPriority | null = null;

  for (const line of lines) {
    if (line.includes("🔴")) {
      currentPriority = "red";
      continue;
    }
    if (line.includes("🟡")) {
      currentPriority = "yellow";
      continue;
    }
    if (line.includes("🟢")) {
      currentPriority = "green";
      continue;
    }

    const match = line.match(/^\s*-\s\[\s\]\s\*\*(.+?)\*\*\s*$/);
    if (match && currentPriority) {
      tasks.push({
        priority: currentPriority,
        text: match[1].trim(),
        done: false,
      });
    }
  }

  return tasks;
}

async function loadRepoTasks(env: Env, repo: string): Promise<RepoTask[]> {
  const repoName = repo.startsWith("clankamode/") ? repo.slice("clankamode/".length) : repo;
  const url = `https://api.github.com/repos/clankamode/${repoName}/contents/TASKS.md`;
  const headers: Record<string, string> = {
    "User-Agent": "clanka-api/1.0",
    "Accept": "application/vnd.github.v3+json",
  };
  if (env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return [];
    const body = await res.json() as { content?: string };
    if (!body.content) return [];
    const markdown = decodeBase64(body.content);
    return parseOpenTasksMarkdown(markdown);
  } catch {
    return [];
  }
}

function registryEntriesToTools(entries: RegistryEntry[]): Tool[] {
  return entries.map((e) => ({
    name: e.repo.replace("clankamode/", ""),
    description: e.description ?? `${e.tier} tool — ${e.criticality} criticality`,
    status: "active" as ToolStatus,
    tier: e.tier,
    criticality: e.criticality,
  }));
}

function registryEntriesToProjects(entries: RegistryEntry[]): Project[] {
  const today = new Date().toISOString().slice(0, 10);
  return entries
    .filter((e) => e.tier === "core" || e.criticality === "critical")
    .map((e) => ({
      name: e.repo.replace("clankamode/", ""),
      description: e.description ?? `${e.tier} — ${e.criticality} criticality`,
      url: `https://github.com/${e.repo}`,
      status: "active",
      last_updated: today,
    }));
}

type GithubStatsPayload = {
  repoCount: number;
  totalStars: number;
  lastPushedAt: string | null;
  lastPushedRepo: string | null;
  cachedAt: string;
};

async function loadGithubStats(env: Env): Promise<GithubStatsPayload> {
  const cached = await env.CLANKA_STATE.get(GITHUB_STATS_CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached) as GithubStatsPayload;
    } catch { /* fall through */ }
  }

  const ghHeaders = {
    "User-Agent": "clanka-api/1.0",
    "Accept": "application/vnd.github.v3+json",
  };

  const [userRes, reposRes] = await Promise.all([
    fetch("https://api.github.com/users/clankamode", { headers: ghHeaders }),
    fetch("https://api.github.com/users/clankamode/repos?per_page=100&type=owner", { headers: ghHeaders }),
  ]);

  type GhRepo = { stargazers_count: number; pushed_at: string; name: string };
  const repos: GhRepo[] = reposRes.ok ? (await reposRes.json() as GhRepo[]) : [];

  let repoCount = 0;
  if (userRes.ok) {
    const user = await userRes.json() as { public_repos?: number };
    repoCount = user.public_repos ?? repos.length;
  } else {
    repoCount = repos.length;
  }

  const totalStars = repos.reduce((sum, r) => sum + (r.stargazers_count ?? 0), 0);

  let lastPushedAt: string | null = null;
  let lastPushedRepo: string | null = null;
  for (const r of repos) {
    if (!lastPushedAt || r.pushed_at > lastPushedAt) {
      lastPushedAt = r.pushed_at;
      lastPushedRepo = r.name;
    }
  }

  const payload: GithubStatsPayload = {
    repoCount,
    totalStars,
    lastPushedAt,
    lastPushedRepo,
    cachedAt: new Date().toISOString(),
  };

  await env.CLANKA_STATE.put(GITHUB_STATS_CACHE_KEY, JSON.stringify(payload), { expirationTtl: GITHUB_STATS_TTL_SEC });
  return payload;
}

// Fleet registry is now derived from the live registry — kept for any legacy references
const FLEET_REGISTRY: FleetRepo[] = [];

function safeParseJSON<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function makeHistoryHash(timestamp: number): string {
  return Math.floor(timestamp).toString(16).slice(-8);
}

function toHistoryEntry(value: unknown, fallbackTimestamp: number): HistoryEntry {
  if (!value || typeof value !== "object") {
    const ts = fallbackTimestamp;
    return { timestamp: ts, desc: "activity", type: "event", hash: makeHistoryHash(ts) };
  }

  const item = value as Record<string, unknown>;
  const tsRaw = item.timestamp;
  const timestamp = typeof tsRaw === "number" && Number.isFinite(tsRaw) ? tsRaw : fallbackTimestamp;
  const desc = typeof item.desc === "string"
    ? item.desc
    : typeof item.message === "string"
      ? item.message
      : "activity";
  const type = typeof item.type === "string" ? item.type : "event";
  const hash = typeof item.hash === "string" && item.hash.length > 0 ? item.hash : makeHistoryHash(timestamp);

  return { timestamp, desc, type, hash };
}

function normalizeHistory(history: unknown): HistoryEntry[] {
  if (!Array.isArray(history)) return [];
  return history
    .slice(0, HISTORY_LIMIT)
    .map((entry, index) => toHistoryEntry(entry, Date.now() - index));
}

function countActiveAgents(team: unknown): number {
  if (!team || typeof team !== "object") return 0;

  if (Array.isArray(team)) {
    return team.reduce((count, member) => {
      if (member && typeof member === "object" && (member as { status?: unknown }).status === "active") {
        return count + 1;
      }
      return count;
    }, 0);
  }

  return Object.values(team as Record<string, unknown>).reduce((count, member) => {
    if (member === "active") return count + 1;
    if (member && typeof member === "object" && (member as { status?: unknown }).status === "active") {
      return count + 1;
    }
    return count;
  }, 0);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Helper for CORS headers
    const corsHeaders = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    try {
      await logRequest(env, request);
    } catch {
      // ignore logging errors
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method === "GET" && isPublicGetEndpoint(url.pathname)) {
      const rateLimit = await checkRateLimit(env, request);
      if (!rateLimit.allowed) {
        return new Response(JSON.stringify({ error: "Too Many Requests" }), {
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
        return new Response(`Unauthorized`, { status: 401 });
      }

      const validationError = JSON.stringify({
        error: "Invalid body: presence, team, and activity are required",
      });

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response(validationError, { status: 400, headers: corsHeaders });
      }

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return new Response(validationError, { status: 400, headers: corsHeaders });
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
        return new Response(validationError, { status: 400, headers: corsHeaders });
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
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    if (url.pathname === "/heartbeat" && request.method === "POST") {
      if (!isAuthorized(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      let body: unknown = {};
      try {
        body = await request.json();
      } catch {
        // allow empty body and treat as heartbeat-only ping
      }

      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return new Response(JSON.stringify({ error: "Invalid body" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const payload = body as { history?: unknown };
      if (payload.history !== undefined && !Array.isArray(payload.history)) {
        return new Response(JSON.stringify({ error: "Invalid body: history must be an array" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const heartbeatHistory = payload.history ?? [];
      if (Array.isArray(heartbeatHistory) && heartbeatHistory.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
        return new Response(JSON.stringify({ error: "Invalid body: history entries must be objects" }), {
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

      return new Response(JSON.stringify({
        success: true,
        status: "operational",
        last_seen: new Date(now).toISOString(),
      }), { headers: corsHeaders });
    }

    if (url.pathname === "/history") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const historyRaw = await env.CLANKA_STATE.get("history") || "[]";
      const history = normalizeHistory(safeParseJSON<unknown[]>(historyRaw, []));

      return new Response(JSON.stringify({ history: history.slice(0, HISTORY_LIMIT) }), {
        headers: corsHeaders,
      });
    }

    if (url.pathname === "/status") {
      const lastSeenRaw = await env.CLANKA_STATE.get(LAST_SEEN_KEY);
      return new Response(JSON.stringify(getStatusPayload(lastSeenRaw)), { headers: corsHeaders });
    }

    if (url.pathname === "/status/uptime") {
      const lastSeenRaw = await env.CLANKA_STATE.get(LAST_SEEN_KEY);
      return new Response(JSON.stringify(getStatusUptimePayload(lastSeenRaw)), { headers: corsHeaders });
    }

    if (url.pathname === "/health") {
      const lastSeenRaw = await env.CLANKA_STATE.get(LAST_SEEN_KEY);
      return new Response(JSON.stringify(getStatusPayload(lastSeenRaw)), { headers: corsHeaders });
    }

    if (url.pathname === "/openapi.json") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      return new Response(JSON.stringify(OPENAPI_SPEC), {
        headers: { ...corsHeaders },
      });
    }

    if (url.pathname === "/fleet/summary") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const registryEntries = await loadRegistryEntries(env);
      const fleetItems: FleetRepo[] = registryEntries.map((e) => ({
        repo: e.repo,
        criticality: e.criticality,
        tier: e.tier,
      }));

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

      return new Response(
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

    if (url.pathname === "/pulse") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const [presenceRaw, historyRaw, teamRaw] = await Promise.all([
        env.CLANKA_STATE.get("presence"),
        env.CLANKA_STATE.get("history"),
        env.CLANKA_STATE.get("team"),
      ]);
      const presence = safeParseJSON<{ state?: string; timestamp?: number } | null>(presenceRaw, null);
      const history = normalizeHistory(safeParseJSON<unknown[]>(historyRaw || "[]", []));
      const team = safeParseJSON<unknown>(teamRaw || "{}", {});
      const agentsActive = countActiveAgents(team);

      return new Response(
        JSON.stringify({
          ts: new Date().toISOString(),
          status: presence?.state || "active",
          agents_active: agentsActive,
          last_event_desc: history[0]?.desc || null,
        }),
        { headers: corsHeaders },
      );
    }

    // Tasks CRUD (admin only)
    if (url.pathname === "/admin/tasks") {
      if (!isAuthorized(request, env)) {
        return new Response('Unauthorized', { status: 401 });
      }

      if (request.method === 'GET') {
        const tasksRaw = await env.CLANKA_STATE.get("tasks") || "[]";
        return new Response(tasksRaw, { headers: corsHeaders });
      }

      if (request.method === 'POST') {
        const body = await request.json();
        const tasksRaw = await env.CLANKA_STATE.get("tasks") || "[]";
        const tasks = JSON.parse(tasksRaw);
        tasks.push(body);
        await env.CLANKA_STATE.put("tasks", JSON.stringify(tasks));
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      if (request.method === 'PUT') {
        const body = await request.json();
        const tasksRaw = await env.CLANKA_STATE.get("tasks") || "[]";
        let tasks = JSON.parse(tasksRaw);
        tasks = tasks.map((t: any) => t.id === body.id ? { ...t, ...body } : t);
        await env.CLANKA_STATE.put("tasks", JSON.stringify(tasks));
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      if (request.method === 'DELETE') {
        const body = await request.json() as any;
        const id = body.id;
        const tasksRaw = await env.CLANKA_STATE.get("tasks") || "[]";
        let tasks = JSON.parse(tasksRaw);
        tasks = tasks.filter((t: any) => t.id !== id);
        await env.CLANKA_STATE.put("tasks", JSON.stringify(tasks));
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }
    }

    if (url.pathname === "/admin/activity") {
      if (!isAuthorized(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const body = await request.json() as { desc?: unknown; type?: unknown };
      const desc = typeof body.desc === "string" ? body.desc.trim() : "";
      const type = typeof body.type === "string" ? body.type.trim() : "";
      if (!desc || !type) {
        return new Response(JSON.stringify({ error: "Invalid body" }), {
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

      return new Response(JSON.stringify({ success: true, entry }), { headers: corsHeaders });
    }

    if (url.pathname === "/projects") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const entries = await loadRegistryEntries(env);
      const projects = entries.length > 0
        ? registryEntriesToProjects(entries)
        : [];

      return new Response(
        JSON.stringify({ projects, source: "registry", cached: true }),
        { headers: corsHeaders },
      );
    }

    if (url.pathname === "/tools") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const entries = await loadRegistryEntries(env);
      const tools = entries.length > 0
        ? registryEntriesToTools(entries)
        : [];

      return new Response(
        JSON.stringify({
          tools,
          total: tools.length,
          source: "registry",
        }),
        { headers: corsHeaders },
      );
    }

    if (url.pathname === "/tasks") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
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

      return new Response(JSON.stringify(payload), { headers: corsHeaders });
    }

    if (url.pathname === "/now") {
      const [presenceRaw, historyRaw, teamRaw, startedRaw] = await Promise.all([
        env.CLANKA_STATE.get("presence"),
        env.CLANKA_STATE.get("history"),
        env.CLANKA_STATE.get("team"),
        env.CLANKA_STATE.get("started"),
      ]);
      const now = Date.now();
      const presence = safeParseJSON<{ state?: string; message?: string; timestamp?: number } | null>(presenceRaw, null);
      const history = normalizeHistory(safeParseJSON<unknown[]>(historyRaw || "[]", []));
      const team = safeParseJSON<unknown>(teamRaw || "{}", {});
      let started = Number(startedRaw);
      if (!Number.isFinite(started)) {
        started = now;
        await env.CLANKA_STATE.put("started", String(started));
      }
      const agentsActive = countActiveAgents(team);
      const lastSeenMs = typeof presence?.timestamp === "number" ? presence.timestamp : now;

      return new Response(JSON.stringify({
        current: presence?.message || "monitoring workspace and building public signals",
        status: presence?.state || "active",
        stack: ["Cloudflare Workers", "TypeScript", "Lit"],
        timestamp: lastSeenMs,
        uptime: Math.max(0, now - started),
        agents_active: agentsActive,
        last_seen: new Date(lastSeenMs).toISOString(),
        history,
        team
      }), { headers: corsHeaders });
    }

    if (url.pathname === "/github/stats") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const stats = await loadGithubStats(env);
      return new Response(JSON.stringify(stats), { headers: corsHeaders });
    }

    if (url.pathname === "/github/events") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers: corsHeaders });
      }
      const events = await loadGithubEvents(env.CLANKA_STATE);
      return new Response(JSON.stringify({ events }), { headers: corsHeaders });
    }

    if (url.pathname === "/changelog") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const commits = await loadChangelog(env);
      return new Response(JSON.stringify({ commits }), { headers: corsHeaders });
    }

    if (url.pathname === "/posts/count") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      return new Response(
        JSON.stringify({ count: 11, lastPost: "011", lastPostDate: "2026-02-26", lastPostSlug: "claude-cli-unlock" }),
        { headers: corsHeaders },
      );
    }

    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: corsHeaders,
    });
  },
};
