export interface Env {
  CLANKA_STATE: KVNamespace;
  ADMIN_KEY: string;
}

type FleetTier = "ops" | "infra" | "core" | "quality" | "policy" | "template";
type FleetCriticality = "critical" | "high" | "medium";
type FleetRepo = { repo: string; criticality: FleetCriticality; tier: FleetTier };
type HistoryEntry = { timestamp: number; desc: string; type: string; hash: string };

type ToolStatus = "active" | "development" | "planned";
type Tool = { name: string; description: string; status: ToolStatus };
type Project = { name: string; description: string; url: string; status: string; last_updated: string };

const HISTORY_LIMIT = 20;

const PROJECTS_REGISTRY: Project[] = [
  {
    name: "clanka-api",
    description: "Edge control API behind Clanka's public presence surface and fleet metadata",
    url: "https://github.com/clankamode/clanka-api",
    status: "active",
    last_updated: "2026-02-25",
  },
  {
    name: "clanka-core",
    description: "Core orchestration engine for Clanka autonomous tooling fleet",
    url: "https://github.com/clankamode/clanka-core",
    status: "active",
    last_updated: "2026-02-25",
  },
  {
    name: "fleet-status-page",
    description: "Public status page for fleet health and operational metrics",
    url: "https://github.com/clankamode/fleet-status-page",
    status: "active",
    last_updated: "2026-02-25",
  },
  {
    name: "clanka",
    description: "Public site and presence surface for Clanka",
    url: "https://github.com/clankamode/clanka",
    status: "active",
    last_updated: "2026-02-25",
  },
];

const TOOLS_REGISTRY: Tool[] = [
  { name: "ci-triage", description: "Automated CI failure triage and root-cause analysis", status: "active" },
  { name: "meta-runner", description: "Cross-repo task orchestration and execution", status: "active" },
  { name: "repo-context", description: "Repository context extraction and summarization", status: "active" },
  { name: "local-env-doctor", description: "Local environment health checks and remediation", status: "active" },
  { name: "auto-remediator", description: "Automated issue detection and remediation", status: "active" },
  { name: "pr-signal-lens", description: "Pull request signal analysis and insights", status: "active" },
  { name: "assistant-tool-registry", description: "Central registry for assistant-callable tools", status: "active" },
];

const FLEET_REGISTRY: FleetRepo[] = [
  { repo: "clankamode/pr-signal-lens", criticality: "medium", tier: "ops" },
  { repo: "clankamode/ci-failure-triager", criticality: "high", tier: "ops" },
  { repo: "clankamode/ops-control-plane", criticality: "high", tier: "ops" },
  { repo: "clankamode/meta-runner", criticality: "critical", tier: "ops" },
  { repo: "clankamode/auto-remediator", criticality: "critical", tier: "ops" },
  { repo: "clankamode/fleet-admin", criticality: "critical", tier: "infra" },
  { repo: "clankamode/fleet-status-page", criticality: "high", tier: "infra" },
  { repo: "clankamode/assistant-tool-registry", criticality: "high", tier: "infra" },
  { repo: "clankamode/tool-fleet-policy", criticality: "high", tier: "policy" },
  { repo: "clankamode/tool-starter", criticality: "medium", tier: "template" },
  { repo: "clankamode/clanka-api", criticality: "high", tier: "core" },
  { repo: "clankamode/clanka-tools", criticality: "high", tier: "core" },
  { repo: "clankamode/clanka-core", criticality: "critical", tier: "core" },
  { repo: "clankamode/clanka", criticality: "critical", tier: "core" },
  { repo: "clankamode/playwright-contract-guard", criticality: "medium", tier: "quality" },
  { repo: "clankamode/local-env-doctor", criticality: "high", tier: "quality" },
];

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

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Private endpoint to set state
    if (url.pathname === "/set-presence" && request.method === "POST") {
      const auth = request.headers.get("Authorization");
      const expected = `Bearer ${env.ADMIN_KEY}`;
      if (auth !== expected) {
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

      if (state) {
        await env.CLANKA_STATE.put("presence", JSON.stringify({ state, message, timestamp: Date.now() }), {
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
      return new Response(JSON.stringify({ 
        status: "operational", 
        timestamp: new Date().toISOString(),
        signal: "⚡" 
      }), { headers: corsHeaders });
    }

    if (url.pathname === "/fleet/summary") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }

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

      for (const item of FLEET_REGISTRY) {
        tiers[item.tier].push(item.repo);
        byCriticality[item.criticality].push(item.repo);
      }

      return new Response(
        JSON.stringify({
          generatedAt: new Date().toISOString(),
          totalRepos: FLEET_REGISTRY.length,
          repos: FLEET_REGISTRY,
          tiers,
          byCriticality,
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
      const auth = request.headers.get("Authorization");
      const expected = `Bearer ${env.ADMIN_KEY}`;
      if (auth !== expected) {
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
      const auth = request.headers.get("Authorization");
      const expected = `Bearer ${env.ADMIN_KEY}`;
      if (auth !== expected) {
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

      return new Response(
        JSON.stringify({ projects: PROJECTS_REGISTRY }),
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

      return new Response(
        JSON.stringify({
          tools: TOOLS_REGISTRY,
          total: TOOLS_REGISTRY.length,
        }),
        { headers: corsHeaders },
      );
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

    return new Response(JSON.stringify({
      identity: "CLANKA_API",
      active: true,
      endpoints: ["/status", "/now", "/history", "/pulse", "/projects", "/tools", "/admin/tasks", "/admin/activity", "/fleet/summary"]
    }), { headers: corsHeaders });
  },
};
