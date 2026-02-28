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

type RegistryEntry = {
  repo: string;
  criticality: FleetCriticality;
  tier: FleetTier;
  description?: string;
};

type TaskPriority = "red" | "yellow" | "green";
type RepoTask = { priority: TaskPriority; text: string; done: boolean };
type RepoTasksPayload = { repo: string; tasks: RepoTask[] };

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

      const { state, message, ttl, activity, team, tasks } = await request.json() as {
        state?: string;
        message?: string;
        ttl?: number;
        activity?: unknown;
        team?: Record<string, unknown>;
        tasks?: unknown;
      };

      if (tasks) {
        await env.CLANKA_STATE.put("tasks", JSON.stringify(tasks));
      }

      if (team) {
        const currentTeamRaw = await env.CLANKA_STATE.get("team") || "{}";
        const currentTeam = safeParseJSON<Record<string, unknown>>(currentTeamRaw, {});
        const updatedTeam = { ...currentTeam, ...team };
        await env.CLANKA_STATE.put("team", JSON.stringify(updatedTeam));
      }

      if (activity) {
        const historyRaw = await env.CLANKA_STATE.get("history") || "[]";
        const history = normalizeHistory(safeParseJSON<unknown[]>(historyRaw, []));
        const entry = toHistoryEntry(activity, Date.now());
        history.unshift(entry);
        await env.CLANKA_STATE.put("history", JSON.stringify(history.slice(0, HISTORY_LIMIT)));
      }

      const now = Date.now();
      await env.CLANKA_STATE.put(LAST_SEEN_KEY, String(now));

      if (state) {
        await env.CLANKA_STATE.put("presence", JSON.stringify({ state, message, timestamp: now }), {
          expirationTtl: ttl || 1800 
        });
      }
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
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
      const lastSeen = typeof lastSeenRaw === "string" ? Number(lastSeenRaw) : NaN;
      const now = Date.now();
      if (!Number.isFinite(lastSeen) || now - lastSeen > STATUS_OFFLINE_THRESHOLD_MS) {
        return new Response(JSON.stringify({ status: "offline" }), { headers: corsHeaders });
      }

      return new Response(
        JSON.stringify({
          status: "operational",
          timestamp: new Date().toISOString(),
          signal: "⚡",
          last_seen: new Date(lastSeen).toISOString(),
        }),
        { headers: corsHeaders },
      );
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
