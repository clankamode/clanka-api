import {
  FLEET_CI_TTL_SEC,
  FLEET_HEALTH_CACHE_KEY,
  FLEET_HEALTH_TTL_MS,
  FLEET_HEALTH_TTL_SEC,
  fleetCiCacheKey,
  fleetCiTrendCacheKey,
} from "./config";
import { loadRegistryEntries } from "./registry";
import type {
  Env,
  FleetCriticality,
  FleetHealthPayload,
  FleetHealthStatus,
  FleetRepo,
  FleetRepoHealth,
  FleetScorePayload,
  FleetTrendDirection,
  FleetTrendPayload,
  GithubWorkflowRun,
  RegistryEntry,
} from "./types";
import { safeParseJSON } from "./util";

// Fleet registry is now derived from the live registry — kept for any legacy references
export const FLEET_REGISTRY: FleetRepo[] = [];

function fleetStatusSeverity(status: FleetHealthStatus): number {
  if (status === "RED") return 3;
  if (status === "YELLOW") return 2;
  if (status === "GREEN") return 1;
  return 0; // UNKNOWN
}

export function parseFleetHealthPayload(raw: string | null): FleetHealthPayload | null {
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

function isFleetCriticality(value: unknown): value is FleetCriticality {
  return value === "critical" || value === "high" || value === "medium";
}

function isFleetHealthStatus(value: unknown): value is FleetHealthStatus {
  return value === "GREEN" || value === "YELLOW" || value === "RED" || value === "UNKNOWN";
}

export function isFleetHealthFresh(payload: FleetHealthPayload): boolean {
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

export async function loadFleetHealthFromGithub(env: Env): Promise<FleetHealthPayload> {
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

export async function loadFleetTrendFromGithub(env: Env): Promise<FleetTrendPayload> {
  const registryEntries = await loadRegistryEntries(env);
  const repos = await Promise.all(
    registryEntries.map(async (entry) => {
      const last5 = await loadRecentWorkflowConclusions(env, entry.repo);
      return {
        repo: entry.repo,
        criticality: entry.criticality,
        last5,
        direction: deriveTrendDirection(last5),
      };
    }),
  );
  repos.sort((a, b) => a.repo.localeCompare(b.repo));

  return {
    generatedAt: new Date().toISOString(),
    totalRepos: repos.length,
    repos,
  };
}

function fleetScoreValue(status: FleetHealthStatus): number {
  if (status === "GREEN") return 100;
  if (status === "YELLOW") return 60;
  if (status === "RED") return 20;
  return 40;
}

export async function loadFleetScorePayload(env: Env): Promise<FleetScorePayload> {
  let health = parseFleetHealthPayload(await env.CLANKA_STATE.get(FLEET_HEALTH_CACHE_KEY));

  if (!health || !isFleetHealthFresh(health)) {
    try {
      health = await loadFleetHealthFromGithub(env);
    } catch {
      if (!health) {
        health = {
          status: "UNKNOWN",
          repos: [],
          checkedAt: new Date().toISOString(),
        };
      }
    }
  }

  const statuses = health.repos.map((repo) => deriveRepoHealthStatus(repo));
  const healthyRepos = statuses.filter((status) => status === "GREEN").length;
  const unknownRepos = statuses.filter((status) => status === "UNKNOWN").length;
  const degradedRepos = statuses.length - healthyRepos - unknownRepos;
  const score = statuses.length === 0
    ? 0
    : Math.round(statuses.reduce((sum, status) => sum + fleetScoreValue(status), 0) / statuses.length);

  return {
    score,
    status: health.status,
    totalRepos: health.repos.length,
    healthyRepos,
    degradedRepos,
    unknownRepos,
    timestamp: new Date().toISOString(),
  };
}
