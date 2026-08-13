import {
  CACHE_KEYS_TO_INVALIDATE,
  REGISTRY_CACHE_KEY,
  REGISTRY_STALE_CACHE_KEY,
  REGISTRY_STALE_TTL_SEC,
  REGISTRY_TTL_SEC,
  REGISTRY_URL,
  TOOLS_REGISTRY_TTL_SEC,
  fleetCiCacheKey,
  fleetCiTrendCacheKey,
} from "./config";
import type { Env, FleetCriticality, FleetTier, Project, RegistryEntry } from "./types";
import { decodeBase64, safeParseJSON } from "./util";

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

export async function loadRegistryEntries(env: Env): Promise<RegistryEntry[]> {
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

export async function loadToolsRegistryEntries(env: Env): Promise<{ entries: RegistryEntry[]; cached: boolean }> {
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

export function searchRegistryTools(entries: RegistryEntry[], query: string): RegistryEntry[] {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return [];

  const normalizedQuery = terms.join(" ");
  return entries
    .map((entry) => {
      const repo = entry.repo.toLowerCase();
      const description = entry.description.toLowerCase();
      const haystack = `${repo} ${description} ${entry.tier} ${entry.criticality}`;
      const matches = terms.every((term) => haystack.includes(term));
      if (!matches) return null;

      let score = 0;
      if (repo === normalizedQuery) score += 100;
      if (repo.includes(normalizedQuery)) score += 20;
      if (description.includes(normalizedQuery)) score += 10;
      if (terms.every((term) => repo.includes(term))) score += 5;

      return { entry, score };
    })
    .filter((item): item is { entry: RegistryEntry; score: number } => Boolean(item))
    .sort((a, b) => b.score - a.score || a.entry.repo.localeCompare(b.entry.repo))
    .map((item) => item.entry);
}

export async function collectCacheKeysToInvalidate(env: Env): Promise<string[]> {
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

export function registryEntriesToProjects(entries: RegistryEntry[]): Project[] {
  const today = new Date().toISOString().slice(0, 10);
  return entries
    .filter((e) => e.tier === "core" || e.criticality === "critical")
    .map((e) => ({
      name: e.repo.replace("clankamode/", ""),
      description: e.description ?? `${e.tier} — ${e.criticality} criticality`,
      url: `https://github.com/${e.repo}`,
      // Registry membership ≠ runtime liveness; do not advertise "active".
      status: "registered",
      last_updated: today,
    }));
}
