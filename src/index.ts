import { loadGithubEvents } from "./github-events";

export interface Env {
  CLANKA_STATE: KVNamespace;
  ADMIN_KEY: string;
  ADMIN_TOKEN?: string;
  GITHUB_TOKEN?: string;
}

type FleetTier = "ops" | "infra" | "core" | "quality" | "policy" | "template";
type FleetCriticality = "critical" | "high" | "medium";
type FleetHealthStatus = "GREEN" | "YELLOW" | "RED" | "UNKNOWN";
type FleetRepo = { repo: string; criticality: FleetCriticality; tier: FleetTier };
type FleetRepoHealth = {
  repo: string;
  criticality: FleetCriticality;
  lastRun: string | null;
  conclusion: string;
};
type FleetHealthPayload = {
  status: FleetHealthStatus;
  repos: FleetRepoHealth[];
  checkedAt: string;
};
type FleetTrendDirection = "up" | "down" | "flat" | "unknown";
type FleetRepoTrend = {
  repo: string;
  criticality: FleetCriticality;
  last5: string[];
  direction: FleetTrendDirection;
};
type FleetTrendPayload = {
  generatedAt: string;
  totalRepos: number;
  repos: FleetRepoTrend[];
};
type HistoryEntry = { timestamp: number; desc: string; type: string; hash: string };

type Project = { name: string; description: string; url: string; status: string; last_updated: string };
type RequestLogEntry = { timestamp: number; method: string; pathname: string; query: string; ip: string; ua?: string };
type ChangelogEntry = {
  sha: string;
  message: string;
  author: string;
  date: string;
};

const HISTORY_LIMIT = 20;
const REGISTRY_URL = "https://api.github.com/repos/clankamode/assistant-tool-registry/contents/registry.json";
const REGISTRY_CACHE_KEY = "registry:v1";
const REGISTRY_STALE_CACHE_KEY = `${REGISTRY_CACHE_KEY}:stale`;
const REGISTRY_TTL_SEC = 3600; // 1 hour
const REGISTRY_STALE_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
const TOOLS_REGISTRY_TTL_SEC = 5 * 60; // 5 minutes

const REQUEST_LOG_KEY = "request_log";
const REQUEST_LOG_TTL_SEC = 24 * 60 * 60; // 24h
const REQUEST_LOG_LIMIT = 100;

const LAST_SEEN_KEY = "last_seen";
const STATUS_OFFLINE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

const GITHUB_STATS_CACHE_KEY = "github:stats:v1";
const GITHUB_STATS_TTL_SEC = 3600; // 1 hour

const CHANGELOG_CACHE_KEY = "changelog:meta-runner:v1";
const CHANGELOG_TTL_SEC = 10 * 60; // 10 minutes
const CHANGELOG_URL = "https://api.github.com/repos/clankamode/meta-runner/commits?per_page=10";

const FLEET_HEALTH_CACHE_KEY = "fleet:health:v1";
const FLEET_HEALTH_TTL_SEC = 5 * 60; // 5 minutes
const FLEET_HEALTH_TTL_MS = FLEET_HEALTH_TTL_SEC * 1000;
const FLEET_CI_TTL_SEC = 10 * 60; // 10 minutes
const GITHUB_EVENTS_CACHE_KEY = "github:events:v1";
const CACHE_KEYS_TO_INVALIDATE = [
  REGISTRY_CACHE_KEY,
  REGISTRY_STALE_CACHE_KEY,
  FLEET_HEALTH_CACHE_KEY,
  GITHUB_STATS_CACHE_KEY,
  CHANGELOG_CACHE_KEY,
  GITHUB_EVENTS_CACHE_KEY,
];

const RATE_LIMIT_KEY_PREFIX = "rate_limit:ip:";
const RATE_LIMIT_WINDOW_SEC = 60;
const RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_SEC * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const METRICS_KEY = "metrics:v1";
const API_VERSION = "1.0.0";
const STATUS_ENDPOINTS = [
  "/",
  "/fleet/summary",
  "/fleet/health",
  "/fleet/score",
  "/history",
  "/now",
  "/status",
  "/tools/search",
  "/metrics",
];
const startTime = Date.now();

const OPENAPI_SPEC = {
  openapi: "3.0.3",
  info: {
    title: "clanka-api",
    version: API_VERSION,
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
                          repo: { type: "string" },
                          description: { type: "string" },
                          tier: { type: "string" },
                          criticality: { type: "string" },
                        },
                        required: ["repo", "description", "tier", "criticality"],
                      },
                    },
                    count: { type: "number" },
                    cached: { type: "boolean" },
                    timestamp: { type: "string" },
                  },
                  required: ["tools", "count", "cached", "timestamp"],
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
    "/tools/{repo}": {
      get: {
        summary: "Get a registered tool by repo",
        parameters: [
          {
            name: "repo",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Tool payload",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tool: {
                      type: "object",
                      properties: {
                        repo: { type: "string" },
                        description: { type: "string" },
                        tier: { type: "string" },
                        criticality: { type: "string" },
                      },
                      required: ["repo", "description", "tier", "criticality"],
                    },
                    cached: { type: "boolean" },
                    timestamp: { type: "string" },
                  },
                  required: ["tool", "cached", "timestamp"],
                },
              },
            },
          },
          "404": {
            description: "Tool not found",
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
    "/fleet/health": {
      get: {
        summary: "Get workflow health across registered fleet repos",
        responses: {
          "200": {
            description: "Fleet health payload",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", enum: ["GREEN", "YELLOW", "RED", "UNKNOWN"] },
                    repos: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          repo: { type: "string" },
                          criticality: { type: "string" },
                          lastRun: { type: "string", nullable: true },
                          conclusion: { type: "string" },
                        },
                        required: ["repo", "criticality", "lastRun", "conclusion"],
                      },
                    },
                    checkedAt: { type: "string" },
                  },
                  required: ["status", "repos", "checkedAt"],
                },
              },
            },
          },
          "503": {
            description: "GitHub unavailable and no cache available",
          },
          "429": {
            description: "Too Many Requests",
          },
        },
      },
    },
    "/fleet/trend": {
      get: {
        summary: "Get CI trend data across registered fleet repos",
        responses: {
          "200": {
            description: "Fleet trend payload",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    generatedAt: { type: "string" },
                    totalRepos: { type: "number" },
                    repos: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          repo: { type: "string" },
                          criticality: { type: "string" },
                          last5: {
                            type: "array",
                            items: { type: "string" },
                          },
                          direction: { type: "string", enum: ["up", "down", "flat", "unknown"] },
                        },
                        required: ["repo", "criticality", "last5", "direction"],
                      },
                    },
                  },
                  required: ["generatedAt", "totalRepos", "repos"],
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
                        },
                        required: ["sha", "message", "author", "date"],
                      },
                    },
                    timestamp: { type: "string" },
                    error: { type: "string" },
                  },
                  required: ["commits", "timestamp"],
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
  description: string;
};

type TaskPriority = "red" | "yellow" | "green";
type RepoTask = { priority: TaskPriority; text: string; done: boolean };
type RepoTasksPayload = { repo: string; tasks: RepoTask[] };
type RateLimitState = {
  count: number;
  resetAt: number;
};
type MetricsState = {
  requests_total: number;
  kv_hits: number;
  kv_misses: number;
};
type WorkerExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

const inMemoryMetrics: MetricsState = {
  requests_total: 0,
  kv_hits: 0,
  kv_misses: 0,
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
  return pathname !== "/set-presence" && pathname !== "/metrics" && !pathname.startsWith("/admin");
}

function isTestEnvironment(): boolean {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const env = proc?.env;
  if (!env) return false;
  return env.VITEST === "true" || env.NODE_ENV === "test";
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

function toCounter(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function parseMetricsState(raw: string | null): MetricsState {
  if (!raw) {
    return { requests_total: 0, kv_hits: 0, kv_misses: 0 };
  }

  const parsed = safeParseJSON<unknown>(raw, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { requests_total: 0, kv_hits: 0, kv_misses: 0 };
  }

  const item = parsed as Record<string, unknown>;
  return {
    requests_total: toCounter(item.requests_total),
    kv_hits: toCounter(item.kv_hits),
    kv_misses: toCounter(item.kv_misses),
  };
}

function mergeMetricsState(a: MetricsState, b: MetricsState): MetricsState {
  return {
    requests_total: Math.max(a.requests_total, b.requests_total),
    kv_hits: Math.max(a.kv_hits, b.kv_hits),
    kv_misses: Math.max(a.kv_misses, b.kv_misses),
  };
}

async function incrementMetrics(env: Env): Promise<void> {
  inMemoryMetrics.requests_total += 1;
  if (!env.CLANKA_STATE || typeof env.CLANKA_STATE.get !== "function" || typeof env.CLANKA_STATE.put !== "function") {
    inMemoryMetrics.kv_misses += 1;
    return;
  }

  try {
    const raw = await env.CLANKA_STATE.get(METRICS_KEY);
    const persisted = parseMetricsState(raw);
    const hasPersistedMetrics = typeof raw === "string" && raw.length > 0;
    const next = mergeMetricsState(inMemoryMetrics, {
      requests_total: persisted.requests_total + 1,
      kv_hits: persisted.kv_hits + (hasPersistedMetrics ? 1 : 0),
      kv_misses: persisted.kv_misses + (hasPersistedMetrics ? 0 : 1),
    });

    inMemoryMetrics.requests_total = next.requests_total;
    inMemoryMetrics.kv_hits = next.kv_hits;
    inMemoryMetrics.kv_misses = next.kv_misses;
    await env.CLANKA_STATE.put(METRICS_KEY, JSON.stringify(next));
  } catch {
    inMemoryMetrics.kv_misses += 1;
  }
}

async function loadMetrics(env: Env): Promise<MetricsState> {
  if (!env.CLANKA_STATE || typeof env.CLANKA_STATE.get !== "function") {
    return { ...inMemoryMetrics };
  }

  try {
    const raw = await env.CLANKA_STATE.get(METRICS_KEY);
    if (!raw) {
      return { ...inMemoryMetrics };
    }
    return mergeMetricsState(inMemoryMetrics, parseMetricsState(raw));
  } catch {
    return { ...inMemoryMetrics };
  }
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

function normalizeChangelogEntry(entry: unknown): ChangelogEntry | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const item = entry as {
    sha?: unknown;
    message?: unknown;
    author?: unknown;
    date?: unknown;
    commit?: {
      message?: unknown;
      author?: { name?: unknown; date?: unknown };
      committer?: { date?: unknown };
    };
  };

  const directSha = typeof item.sha === "string" ? item.sha.trim() : "";
  const directMessage = typeof item.message === "string" ? item.message : "";
  const directAuthor = typeof item.author === "string" ? item.author : "";
  const directDate = typeof item.date === "string" ? item.date : "";
  if (directSha && directMessage && directAuthor && directDate) {
    return {
      sha: directSha,
      message: directMessage,
      author: directAuthor,
      date: directDate,
    };
  }

  const commit = item.commit && typeof item.commit === "object" && !Array.isArray(item.commit)
    ? item.commit
    : undefined;
  const message = typeof commit?.message === "string" ? commit.message : "";
  const author = item.author && typeof item.author === "object" && !Array.isArray(item.author)
    && typeof (item.author as { login?: unknown }).login === "string"
    ? (item.author as { login: string }).login
    : typeof commit?.author?.name === "string"
      ? commit.author.name
      : "unknown";
  const date = typeof commit?.author?.date === "string"
    ? commit.author.date
    : typeof commit?.committer?.date === "string"
      ? commit.committer.date
      : new Date().toISOString();
  if (!directSha) return null;
  return {
    sha: directSha,
    message,
    author,
    date,
  };
}

function parseChangelogEntries(raw: string | null): ChangelogEntry[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed
      .slice(0, 10)
      .map((entry) => normalizeChangelogEntry(entry))
      .filter((entry): entry is ChangelogEntry => Boolean(entry));
  } catch {
    return null;
  }
}

async function loadChangelog(env: Env): Promise<ChangelogEntry[]> {
  const cached = parseChangelogEntries(await env.CLANKA_STATE.get(CHANGELOG_CACHE_KEY));
  if (cached !== null) return cached;

  const headers: Record<string, string> = {
    "User-Agent": "clanka-api/1.0",
    "Accept": "application/vnd.github.v3+json",
  };
  if (env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;

  const res = await fetch(CHANGELOG_URL, { headers });
  if (!res.ok) return [];

  const body = await res.json() as unknown;
  if (!Array.isArray(body)) return [];

  const payload = body
    .slice(0, 10)
    .map((entry) => normalizeChangelogEntry(entry))
    .filter((entry): entry is ChangelogEntry => Boolean(entry));

  await env.CLANKA_STATE.put(CHANGELOG_CACHE_KEY, JSON.stringify(payload), {
    expirationTtl: CHANGELOG_TTL_SEC,
  });
  return payload;
}

function isFleetTier(value: unknown): value is FleetTier {
  return value === "ops"
    || value === "infra"
    || value === "core"
    || value === "quality"
    || value === "policy"
    || value === "template";
}

function isFleetCriticality(value: unknown): value is FleetCriticality {
  return value === "critical" || value === "high" || value === "medium";
}

function isFleetHealthStatus(value: unknown): value is FleetHealthStatus {
  return value === "GREEN" || value === "YELLOW" || value === "RED" || value === "UNKNOWN";
}

function normalizeRegistryEntry(entry: unknown): RegistryEntry | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const item = entry as {
    repo?: unknown;
    criticality?: unknown;
    tier?: unknown;
    description?: unknown;
  };
  const repo = typeof item.repo === "string" ? item.repo.trim() : "";
  if (!repo || !repo.includes("/")) return null;
  if (!isFleetCriticality(item.criticality) || !isFleetTier(item.tier)) return null;

  const description = typeof item.description === "string" && item.description.trim().length > 0
    ? item.description.trim()
    : `${item.tier} tool - ${item.criticality} criticality`;

  return {
    repo,
    criticality: item.criticality,
    tier: item.tier,
    description,
  };
}

function extractRegistryEntries(payload: unknown): RegistryEntry[] {
  let source: unknown[] = [];
  if (Array.isArray(payload)) {
    source = payload;
  } else if (payload && typeof payload === "object") {
    const shape = payload as { tools?: unknown; registry?: unknown; entries?: unknown };
    if (Array.isArray(shape.tools)) source = shape.tools;
    else if (Array.isArray(shape.registry)) source = shape.registry;
    else if (Array.isArray(shape.entries)) source = shape.entries;
  }

  const seen = new Set<string>();
  const normalized: RegistryEntry[] = [];
  for (const item of source) {
    const entry = normalizeRegistryEntry(item);
    if (!entry) continue;
    const dedupeKey = entry.repo.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push(entry);
  }

  normalized.sort((a, b) => a.repo.localeCompare(b.repo));
  return normalized;
}

function parseRegistryEntries(raw: string | null): RegistryEntry[] | null {
  if (raw === null) return null;
  try {
    return extractRegistryEntries(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

async function loadRegistryEntries(env: Env): Promise<RegistryEntry[]> {
  const cachedEntries = parseRegistryEntries(await env.CLANKA_STATE.get(REGISTRY_CACHE_KEY));
  if (cachedEntries !== null) return cachedEntries;

  const staleEntries = parseRegistryEntries(await env.CLANKA_STATE.get(REGISTRY_STALE_CACHE_KEY));

  try {
    const headers: Record<string, string> = {
      "User-Agent": "clanka-api/1.0",
      "Accept": "application/vnd.github.v3+json",
    };
    if (env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;

    const res = await fetch(REGISTRY_URL, { headers });
    if (!res.ok) return staleEntries ?? [];
    const meta = await res.json() as { content?: string };
    if (typeof meta.content !== "string" || meta.content.length === 0) return staleEntries ?? [];
    const json = decodeBase64(meta.content);
    const entries = extractRegistryEntries(JSON.parse(json) as unknown);
    await Promise.all([
      env.CLANKA_STATE.put(REGISTRY_CACHE_KEY, JSON.stringify(entries), {
        expirationTtl: REGISTRY_TTL_SEC,
      }),
      env.CLANKA_STATE.put(REGISTRY_STALE_CACHE_KEY, JSON.stringify(entries), {
        expirationTtl: REGISTRY_STALE_TTL_SEC,
      }),
    ]);
    return entries;
  } catch {
    return staleEntries ?? [];
  }
}

async function loadToolsRegistryEntries(env: Env): Promise<{ entries: RegistryEntry[]; cached: boolean }> {
  const cachedEntries = parseRegistryEntries(await env.CLANKA_STATE.get(REGISTRY_CACHE_KEY));
  if (cachedEntries !== null) {
    return { entries: cachedEntries, cached: true };
  }

  try {
    const headers: Record<string, string> = {
      "User-Agent": "clanka-api/1.0",
      "Accept": "application/vnd.github.v3+json",
    };
    if (env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;

    const res = await fetch(REGISTRY_URL, { headers });
    if (!res.ok) return { entries: [], cached: false };
    const meta = await res.json() as { content?: string };
    if (typeof meta.content !== "string" || meta.content.length === 0) {
      return { entries: [], cached: false };
    }

    const decoded = decodeBase64(meta.content);
    const entries = extractRegistryEntries(JSON.parse(decoded) as unknown);
    await env.CLANKA_STATE.put(REGISTRY_CACHE_KEY, JSON.stringify(entries), {
      expirationTtl: TOOLS_REGISTRY_TTL_SEC,
    });
    return { entries, cached: false };
  } catch {
    return { entries: [], cached: false };
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

function fleetStatusSeverity(status: FleetHealthStatus): number {
  if (status === "RED") return 3;
  if (status === "YELLOW") return 2;
  if (status === "GREEN") return 1;
  return 0; // UNKNOWN
}

function parseFleetHealthPayload(raw: string | null): FleetHealthPayload | null {
  if (!raw) return null;
  const parsed = safeParseJSON<unknown>(raw, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const payload = parsed as {
    status?: unknown;
    repos?: unknown;
    checkedAt?: unknown;
  };
  if (!isFleetHealthStatus(payload.status)) return null;
  if (typeof payload.checkedAt !== "string" || payload.checkedAt.length === 0) return null;
  if (!Array.isArray(payload.repos)) return null;

  const repos: FleetRepoHealth[] = [];
  for (const entry of payload.repos) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const item = entry as {
      repo?: unknown;
      criticality?: unknown;
      lastRun?: unknown;
      conclusion?: unknown;
    };
    const repo = typeof item.repo === "string" ? item.repo.trim() : "";
    const conclusion = typeof item.conclusion === "string" ? item.conclusion.trim() : "";
    const lastRun = typeof item.lastRun === "string" ? item.lastRun : item.lastRun === null ? null : undefined;
    if (!repo || !isFleetCriticality(item.criticality) || !conclusion || lastRun === undefined) return null;
    repos.push({
      repo,
      criticality: item.criticality,
      lastRun,
      conclusion,
    });
  }

  return {
    status: payload.status,
    repos,
    checkedAt: payload.checkedAt,
  };
}

function isFleetHealthFresh(payload: FleetHealthPayload): boolean {
  const checkedAtMs = Date.parse(payload.checkedAt);
  if (!Number.isFinite(checkedAtMs)) return false;
  return Date.now() - checkedAtMs < FLEET_HEALTH_TTL_MS;
}

function deriveRepoHealthStatus(repo: FleetRepoHealth): FleetHealthStatus {
  const conclusion = repo.conclusion.toLowerCase();
  if (conclusion === "success") return "GREEN";
  if (
    conclusion === "failure"
    || conclusion === "cancelled"
    || conclusion === "timed_out"
    || conclusion === "action_required"
    || conclusion === "startup_failure"
    || conclusion === "stale"
  ) return "RED";
  if (conclusion === "unknown") return "UNKNOWN";
  return "YELLOW";
}

function deriveFleetHealthStatus(repos: FleetRepoHealth[]): FleetHealthStatus {
  if (repos.length === 0) return "UNKNOWN";
  let result: FleetHealthStatus = "UNKNOWN";
  for (const repo of repos) {
    const status = deriveRepoHealthStatus(repo);
    if (fleetStatusSeverity(status) > fleetStatusSeverity(result)) {
      result = status;
    }
    if (result === "RED") break;
  }
  return result;
}

type GithubWorkflowRun = {
  conclusion: string | null;
  status: string | null;
  name: string | null;
  updatedAt: string | null;
};

function fleetCiCacheKey(repo: string): string {
  return `ci:${repo}:v1`;
}

function fleetCiTrendCacheKey(repo: string): string {
  return `ci:trend:${repo}:v1`;
}

function parseWorkflowRun(run: unknown): GithubWorkflowRun | null {
  if (!run || typeof run !== "object" || Array.isArray(run)) return null;

  const item = run as {
    conclusion?: unknown;
    status?: unknown;
    name?: unknown;
    updated_at?: unknown;
    updatedAt?: unknown;
  };
  const conclusion = item.conclusion === null
    ? null
    : typeof item.conclusion === "string"
      ? item.conclusion.trim().toLowerCase()
      : null;
  const status = typeof item.status === "string" ? item.status.trim().toLowerCase() : null;
  const name = typeof item.name === "string" ? item.name.trim() : null;
  const updatedAtRaw = typeof item.updated_at === "string"
    ? item.updated_at
    : typeof item.updatedAt === "string"
      ? item.updatedAt
      : null;
  const updatedAt = updatedAtRaw && updatedAtRaw.length > 0 ? updatedAtRaw : null;
  return {
    conclusion,
    status,
    name,
    updatedAt,
  };
}

function parseWorkflowRunCache(raw: string | null): GithubWorkflowRun | null {
  if (!raw) return null;
  return parseWorkflowRun(safeParseJSON<unknown>(raw, null));
}

function parseConclusionsCache(raw: string | null): string[] | null {
  if (raw === null) return null;
  const parsed = safeParseJSON<unknown>(raw, null);
  if (!Array.isArray(parsed)) return null;
  const conclusions = parsed
    .slice(0, 5)
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  return conclusions;
}

function workflowRunToConclusion(run: GithubWorkflowRun): string {
  if (run.conclusion === null) return "null";
  if (typeof run.conclusion === "string" && run.conclusion.length > 0) {
    return run.conclusion;
  }
  return "unknown";
}

function trendScore(conclusion: string): number {
  const normalized = conclusion.trim().toLowerCase();
  if (normalized === "success") return 2;
  if (normalized === "neutral" || normalized === "skipped") return 1;
  if (
    normalized === "failure"
    || normalized === "cancelled"
    || normalized === "timed_out"
    || normalized === "action_required"
    || normalized === "startup_failure"
    || normalized === "stale"
  ) {
    return 0;
  }
  return 1;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function deriveTrendDirection(conclusions: string[]): FleetTrendDirection {
  if (conclusions.length === 0) return "unknown";
  if (conclusions.length === 1) return "flat";

  const scores = conclusions.map((conclusion) => trendScore(conclusion));
  const newest = scores[0];
  const oldest = scores[scores.length - 1];
  if (newest > oldest) return "up";
  if (newest < oldest) return "down";

  const split = Math.ceil(scores.length / 2);
  const recentAverage = average(scores.slice(0, split));
  const olderAverage = average(scores.slice(split));
  if (recentAverage > olderAverage) return "up";
  if (recentAverage < olderAverage) return "down";
  return "flat";
}

async function loadRecentWorkflowConclusions(env: Env, repo: string): Promise<string[]> {
  const cacheKey = fleetCiTrendCacheKey(repo);
  const cached = parseConclusionsCache(await env.CLANKA_STATE.get(cacheKey));
  if (cached !== null) return cached;
  if (!env.GITHUB_TOKEN) return [];

  const headers: Record<string, string> = {
    "User-Agent": "clanka-api/1.0",
    "Accept": "application/vnd.github.v3+json",
    "Authorization": `token ${env.GITHUB_TOKEN}`,
  };
  try {
    const runListUrl = `https://api.github.com/repos/${repo}/actions/runs?per_page=5`;
    const res = await fetch(runListUrl, { headers });
    if (!res.ok) return [];

    const body = await res.json() as { workflow_runs?: unknown };
    if (!Array.isArray(body.workflow_runs) || body.workflow_runs.length === 0) {
      await env.CLANKA_STATE.put(cacheKey, JSON.stringify([]), {
        expirationTtl: FLEET_CI_TTL_SEC,
      });
      return [];
    }

    const conclusions = body.workflow_runs
      .slice(0, 5)
      .map((run) => parseWorkflowRun(run))
      .filter((run): run is GithubWorkflowRun => Boolean(run))
      .map((run) => workflowRunToConclusion(run));

    await env.CLANKA_STATE.put(cacheKey, JSON.stringify(conclusions), {
      expirationTtl: FLEET_CI_TTL_SEC,
    });
    return conclusions;
  } catch {
    return [];
  }
}

async function loadLatestWorkflowRun(env: Env, repo: string): Promise<GithubWorkflowRun | null> {
  const cacheKey = fleetCiCacheKey(repo);
  const cached = parseWorkflowRunCache(await env.CLANKA_STATE.get(cacheKey));
  if (cached) return cached;
  if (!env.GITHUB_TOKEN) return null;

  const headers: Record<string, string> = {
    "User-Agent": "clanka-api/1.0",
    "Accept": "application/vnd.github.v3+json",
    "Authorization": `token ${env.GITHUB_TOKEN}`,
  };

  const runListUrl = `https://api.github.com/repos/${repo}/actions/runs?per_page=1`;
  const res = await fetch(runListUrl, { headers });
  if (!res.ok) {
    throw new Error(`Failed to load workflow runs for ${repo}`);
  }

  const body = await res.json() as { workflow_runs?: unknown };
  if (!Array.isArray(body.workflow_runs) || body.workflow_runs.length === 0) {
    const noRun: GithubWorkflowRun = {
      conclusion: null,
      status: null,
      name: null,
      updatedAt: null,
    };
    await env.CLANKA_STATE.put(cacheKey, JSON.stringify(noRun), {
      expirationTtl: FLEET_CI_TTL_SEC,
    });
    return noRun;
  }
  const latestRun = parseWorkflowRun(body.workflow_runs[0]);
  if (!latestRun) {
    return null;
  }
  await env.CLANKA_STATE.put(cacheKey, JSON.stringify(latestRun), {
    expirationTtl: FLEET_CI_TTL_SEC,
  });
  return latestRun;
}

function toFleetRepoHealth(
  entry: RegistryEntry,
  run: GithubWorkflowRun | null,
  hasGithubToken: boolean,
): FleetRepoHealth {
  const conclusion = !hasGithubToken
    ? "unknown"
    : run?.conclusion === null
      ? "null"
      : run?.conclusion || "unknown";
  const lastRun = run?.updatedAt || null;
  return {
    repo: entry.repo,
    criticality: entry.criticality,
    lastRun,
    conclusion,
  };
}

async function loadFleetHealthFromGithub(env: Env): Promise<FleetHealthPayload> {
  const registryEntries = await loadRegistryEntries(env);
  const hasGithubToken = typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.trim().length > 0;
  const repos = await Promise.all(
    registryEntries.map(async (entry) => {
      const latestRun = await loadLatestWorkflowRun(env, entry.repo);
      return toFleetRepoHealth(entry, latestRun, hasGithubToken);
    }),
  );
  repos.sort((a, b) => a.repo.localeCompare(b.repo));

  const payload: FleetHealthPayload = {
    status: deriveFleetHealthStatus(repos),
    repos,
    checkedAt: new Date().toISOString(),
  };
  await env.CLANKA_STATE.put(FLEET_HEALTH_CACHE_KEY, JSON.stringify(payload), {
    expirationTtl: FLEET_HEALTH_TTL_SEC,
  });
  return payload;
}

async function loadFleetTrendFromGithub(env: Env): Promise<FleetTrendPayload> {
  const registryEntries = await loadRegistryEntries(env);
  const repos = await Promise.all(
    registryEntries.map(async (entry) => {
      const last5 = await loadRecentWorkflowConclusions(env, entry.repo);
      return {
        repo: entry.repo,
        criticality: entry.criticality,
        last5,
        direction: deriveTrendDirection(last5),
      } satisfies FleetRepoTrend;
    }),
  );
  repos.sort((a, b) => a.repo.localeCompare(b.repo));

  return {
    generatedAt: new Date().toISOString(),
    totalRepos: repos.length,
    repos,
  };
}

async function collectCacheKeysToInvalidate(env: Env): Promise<string[]> {
  const keys = new Set<string>(CACHE_KEYS_TO_INVALIDATE);
  const [primaryRaw, staleRaw] = await Promise.all([
    env.CLANKA_STATE.get(REGISTRY_CACHE_KEY),
    env.CLANKA_STATE.get(REGISTRY_STALE_CACHE_KEY),
  ]);
  const entries = [
    ...(parseRegistryEntries(primaryRaw) ?? []),
    ...(parseRegistryEntries(staleRaw) ?? []),
  ];
  for (const entry of entries) {
    keys.add(fleetCiCacheKey(entry.repo));
    keys.add(fleetCiTrendCacheKey(entry.repo));
  }
  return Array.from(keys).sort((a, b) => a.localeCompare(b));
}

async function invalidateCacheKey(env: Env, key: string): Promise<void> {
  const kv = env.CLANKA_STATE as KVNamespace & { delete?: (key: string) => Promise<void> };
  if (typeof kv.delete === "function") {
    await kv.delete(key);
    return;
  }
  await kv.put(key, "", { expirationTtl: 1 });
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
  async fetch(request: Request, env: Env, ctx?: WorkerExecutionContext): Promise<Response> {
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

    try {
      await logRequest(env, request);
    } catch {
      // ignore logging errors
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method === "GET" && isPublicGetEndpoint(url.pathname) && !isTestEnvironment()) {
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

      return new Response(JSON.stringify({ history, count: history.length }), {
        headers: corsHeaders,
      });
    }

    if (url.pathname === "/status") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      return new Response(JSON.stringify({
        ok: true,
        version: API_VERSION,
        timestamp: new Date().toISOString(),
        endpoints: STATUS_ENDPOINTS,
      }), { headers: noCacheHeaders });
    }

    if (url.pathname === "/metrics") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const expectedToken = typeof env.ADMIN_TOKEN === "string" ? env.ADMIN_TOKEN.trim() : "";
      if (!expectedToken) {
        return new Response(JSON.stringify({ error: "metrics_unavailable" }), {
          status: 503,
          headers: noCacheHeaders,
        });
      }

      const providedToken = request.headers.get("X-Admin-Token");
      if (providedToken !== expectedToken) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: noCacheHeaders,
        });
      }

      const metrics = await loadMetrics(env);
      return new Response(JSON.stringify({
        uptime_ms: Math.max(0, Date.now() - startTime),
        requests_total: metrics.requests_total,
        kv_hits: metrics.kv_hits,
        kv_misses: metrics.kv_misses,
        timestamp: new Date().toISOString(),
      }), { headers: noCacheHeaders });
    }

    if (url.pathname === "/admin/refresh") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: noCacheHeaders,
        });
      }

      const expectedToken = typeof env.ADMIN_TOKEN === "string" ? env.ADMIN_TOKEN.trim() : "";
      if (!expectedToken) {
        return new Response(JSON.stringify({ error: "refresh_unavailable" }), {
          status: 503,
          headers: noCacheHeaders,
        });
      }

      const providedToken = request.headers.get("ADMIN_TOKEN");
      if (providedToken !== expectedToken) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: noCacheHeaders,
        });
      }

      const keys = await collectCacheKeysToInvalidate(env);
      await Promise.all(keys.map(async (key) => invalidateCacheKey(env, key)));
      return new Response(JSON.stringify({
        success: true,
        invalidated: keys.length,
        keys,
        timestamp: new Date().toISOString(),
      }), { headers: noCacheHeaders });
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

    if (url.pathname === "/fleet/health") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const cachedPayload = parseFleetHealthPayload(await env.CLANKA_STATE.get(FLEET_HEALTH_CACHE_KEY));
      if (cachedPayload && isFleetHealthFresh(cachedPayload)) {
        return new Response(JSON.stringify(cachedPayload), { headers: corsHeaders });
      }

      try {
        const payload = await loadFleetHealthFromGithub(env);
        return new Response(JSON.stringify(payload), { headers: corsHeaders });
      } catch {
        if (cachedPayload) {
          return new Response(JSON.stringify(cachedPayload), { headers: corsHeaders });
        }
        return new Response(JSON.stringify({ error: "Service Unavailable" }), {
          status: 503,
          headers: corsHeaders,
        });
      }
    }

    if (url.pathname === "/fleet/score") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const payload = await loadFleetScorePayload(env);
      return new Response(JSON.stringify(payload), { headers: corsHeaders });
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

    if (url.pathname === "/tools/search") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const query = url.searchParams.get("q")?.trim() || "";
      if (!query) {
        return new Response(JSON.stringify({ error: "Missing query parameter: q" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const { entries, cached } = await loadToolsRegistryEntries(env);
      const tools = searchRegistryTools(entries, query);
      return new Response(JSON.stringify({
        query,
        count: tools.length,
        tools,
        cached,
        timestamp: new Date().toISOString(),
      }), { headers: corsHeaders });
    }

    if (url.pathname === "/tools") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const { entries, cached } = await loadToolsRegistryEntries(env);

      return new Response(
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
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      let rawRepo = "";
      try {
        rawRepo = decodeURIComponent(url.pathname.slice("/tools/".length)).trim();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid repo path" }), {
          status: 400,
          headers: corsHeaders,
        });
      }
      const { entries, cached } = await loadToolsRegistryEntries(env);
      const match = entries.find((entry) => entry.repo.toLowerCase() === rawRepo.toLowerCase());
      if (!match) {
        return new Response(JSON.stringify({ error: "Tool Not Found" }), {
          status: 404,
          headers: corsHeaders,
        });
      }

      return new Response(JSON.stringify({
        tool: match,
        cached,
        timestamp: new Date().toISOString(),
      }), { headers: corsHeaders });
    }

    if (url.pathname === "/fleet/trend") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

      const payload = await loadFleetTrendFromGithub(env);
      return new Response(JSON.stringify(payload), { headers: corsHeaders });
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
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
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
      let started = Number(startedRaw);
      if (!Number.isFinite(started)) {
        started = now;
        await env.CLANKA_STATE.put("started", String(started));
      }
      const agentsActive = countActiveAgents(team);
      const lastSeenFromPresence = typeof presence?.timestamp === "number" ? presence.timestamp : NaN;
      const lastSeenFromHeartbeat = typeof lastSeenRaw === "string" ? Number(lastSeenRaw) : NaN;
      const lastSeenMs = Number.isFinite(lastSeenFromHeartbeat)
        ? lastSeenFromHeartbeat
        : Number.isFinite(lastSeenFromPresence)
          ? lastSeenFromPresence
          : now;
      const isOffline = now - lastSeenMs > STATUS_OFFLINE_THRESHOLD_MS;

      return new Response(JSON.stringify({
        current: presence?.message || "monitoring workspace and building public signals",
        status: isOffline ? "offline" : (presence?.state || "active"),
        signal: "⚡",
        stack: ["Cloudflare Workers", "TypeScript", "Lit"],
        timestamp: lastSeenMs,
        uptime: Math.max(0, now - started),
        agents_active: agentsActive,
        last_seen: new Date(lastSeenMs).toISOString(),
        history,
        team,
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

      const token = typeof env.GITHUB_TOKEN === "string" ? env.GITHUB_TOKEN.trim() : "";
      if (!token) {
        return new Response(JSON.stringify({
          commits: [],
          error: "no token",
          timestamp: new Date().toISOString(),
        }), { headers: corsHeaders });
      }

      const commits = await loadChangelog(env);
      return new Response(JSON.stringify({
        commits,
        timestamp: new Date().toISOString(),
      }), { headers: corsHeaders });
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
