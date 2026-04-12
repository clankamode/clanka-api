import {
  METRICS_KEY,
  RATE_LIMIT_KEY_PREFIX,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_WINDOW_SEC,
  REQUEST_LOG_KEY,
  REQUEST_LOG_LIMIT,
  REQUEST_LOG_TTL_SEC,
} from "./config";
import type { Env, MetricsState, RateLimitState, RequestLogEntry } from "./types";
import { safeParseJSON } from "./util";

const inMemoryMetrics: MetricsState = {
  requests_total: 0,
  kv_hits: 0,
  kv_misses: 0,
};

export function getClientIp(request: Request): string {
  const connectingIp = request.headers.get("CF-Connecting-IP");
  if (connectingIp) return connectingIp;
  const forwarded = request.headers.get("X-Forwarded-For");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || forwarded;
  }
  return request.headers.get("X-Real-IP") || "unknown";
}

export function isPublicGetEndpoint(pathname: string): boolean {
  return pathname !== "/set-presence" && pathname !== "/metrics" && !pathname.startsWith("/admin");
}

export function isTestEnvironment(): boolean {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const env = proc?.env;
  if (!env) return false;
  return env.VITEST === "true" || env.NODE_ENV === "test";
}

export async function checkRateLimit(env: Env, request: Request): Promise<{ allowed: boolean; retryAfter: number }> {
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

export async function incrementMetrics(env: Env): Promise<void> {
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

export async function loadMetrics(env: Env): Promise<MetricsState> {
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

export async function logRequest(env: Env, request: Request, response: Response): Promise<void> {
  const url = new URL(request.url);
  const rawLog = await env.CLANKA_STATE.get(REQUEST_LOG_KEY);
  let requestLog = safeParseJSON<unknown[]>(rawLog, []);
  if (!Array.isArray(requestLog)) {
    requestLog = [];
  }

  const nextLog: RequestLogEntry[] = [...requestLog, {
    timestamp: Date.now(),
    method: request.method,
    path: `${url.pathname}${url.search}`,
    status: response.status,
    ip: getClientIp(request),
    ua: request.headers.get("User-Agent") || undefined,
  }];
  const trimmedLog = nextLog.length > REQUEST_LOG_LIMIT ? nextLog.slice(-REQUEST_LOG_LIMIT) : nextLog;

  await env.CLANKA_STATE.put(REQUEST_LOG_KEY, JSON.stringify(trimmedLog), {
    expirationTtl: REQUEST_LOG_TTL_SEC,
  });
}

export function isAuthorized(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization");
  const expected = `Bearer ${env.ADMIN_KEY}`;
  return auth === expected;
}

export async function invalidateCacheKey(env: Env, key: string): Promise<void> {
  const kv = env.CLANKA_STATE as KVNamespace & { delete?: (key: string) => Promise<void> };
  if (typeof kv.delete === "function") {
    await kv.delete(key);
    return;
  }
  await kv.put(key, "", { expirationTtl: 1 });
}
