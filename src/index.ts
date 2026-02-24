export interface Env {
  CLANKA_STATE: KVNamespace;
  ADMIN_KEY: string;
}

interface HeartbeatEntry {
  timestamp: number;
}

interface PresenceRecord {
  state: string;
  message: string;
  timestamp: number;
}

type FleetTier = "ops" | "infra" | "core" | "quality" | "policy" | "template";
type FleetCriticality = "critical" | "high" | "medium";

const FLEET_REGISTRY: Array<{ repo: string; criticality: FleetCriticality; tier: FleetTier }> = [
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

      const { state, message, ttl, activity, team, tasks } = await request.json() as any;

      if (tasks) {
        await env.CLANKA_STATE.put("tasks", JSON.stringify(tasks));
      }

      if (team) {
        const currentTeamRaw = await env.CLANKA_STATE.get("team") || "{}";
        const currentTeam = JSON.parse(currentTeamRaw);
        const updatedTeam = { ...currentTeam, ...team };
        await env.CLANKA_STATE.put("team", JSON.stringify(updatedTeam));
      }

      if (activity) {
        const historyRaw = await env.CLANKA_STATE.get("history") || "[]";
        const history = JSON.parse(historyRaw);
        history.unshift({ ...activity, timestamp: Date.now() });
        await env.CLANKA_STATE.put("history", JSON.stringify(history.slice(0, 10)));
      }

      if (state) {
        await env.CLANKA_STATE.put("presence", JSON.stringify({ state, message, timestamp: Date.now() }), {
          expirationTtl: ttl || 1800 
        });
      }
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
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
          tiers,
          byCriticality,
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

    
if (url.pathname === "/now") {
      const presenceRaw = await env.CLANKA_STATE.get("presence");
      const historyRaw = await env.CLANKA_STATE.get("history") || "[]";
      const teamRaw = await env.CLANKA_STATE.get("team") || "{}";
      const presence = presenceRaw ? JSON.parse(presenceRaw) : null;

      return new Response(JSON.stringify({
        current: presence?.message || "monitoring workspace and building public signals",
        status: presence?.state || "active",
        stack: ["Cloudflare Workers", "TypeScript", "Lit"],
        timestamp: presence?.timestamp || Date.now(),
        history: JSON.parse(historyRaw),
        team: JSON.parse(teamRaw)
      }), { headers: corsHeaders });
    }

    // POST /heartbeat — admin-only, records a heartbeat timestamp
    if (url.pathname === "/heartbeat" && request.method === "POST") {
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${env.ADMIN_KEY}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const now = Date.now();

      const historyRaw = await env.CLANKA_STATE.get("heartbeat_history") || "[]";
      const history = JSON.parse(historyRaw) as HeartbeatEntry[];
      history.push({ timestamp: now });
      const trimmed = history.slice(-500);
      await env.CLANKA_STATE.put("heartbeat_history", JSON.stringify(trimmed));

      await env.CLANKA_STATE.put("state", JSON.stringify({ message: "heartbeat", timestamp: now }));

      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // GET /status/history — last 20 heartbeat entries
    if (url.pathname === "/status/history" && request.method === "GET") {
      const historyRaw = await env.CLANKA_STATE.get("heartbeat_history") || "[]";
      const history = JSON.parse(historyRaw) as HeartbeatEntry[];
      const last20 = history.slice(-20).reverse();
      const entries = last20.map((e) => ({
        timestamp: e.timestamp,
        iso: new Date(e.timestamp).toISOString(),
      }));
      return new Response(JSON.stringify({ entries }), { headers: corsHeaders });
    }

    // GET /status/uptime — gateway status, last seen, activity, 24h uptime %
    if (url.pathname === "/status/uptime" && request.method === "GET") {
      const FIVE_MIN_MS = 5 * 60 * 1000;
      const BUCKET_MS = FIVE_MIN_MS;
      const WINDOW_COUNT = 288; // 24h / 5min

      const [historyRaw, presenceRaw] = await Promise.all([
        env.CLANKA_STATE.get("heartbeat_history"),
        env.CLANKA_STATE.get("presence"),
      ]);

      const history = JSON.parse(historyRaw ?? "[]") as HeartbeatEntry[];
      const presence = presenceRaw ? (JSON.parse(presenceRaw) as PresenceRecord) : null;

      const now = Date.now();
      const cutoff24h = now - 24 * 60 * 60 * 1000;

      const latest = history.length > 0 ? history[history.length - 1] : null;
      const gateway_up = latest !== null && now - latest.timestamp < FIVE_MIN_MS;
      const last_seen = latest ? new Date(latest.timestamp).toISOString() : "";

      const current_activity = presence?.message ?? "";

      const coveredBuckets = new Set<number>();
      for (const entry of history) {
        if (entry.timestamp >= cutoff24h) {
          coveredBuckets.add(Math.floor(entry.timestamp / BUCKET_MS));
        }
      }
      const uptime_pct_24h = Math.round((coveredBuckets.size / WINDOW_COUNT) * 100 * 100) / 100;

      return new Response(
        JSON.stringify({ gateway_up, last_seen, current_activity, uptime_pct_24h }),
        { headers: corsHeaders },
      );
    }

    return new Response(JSON.stringify({
      identity: "CLANKA_API",
      active: true,
      endpoints: ["/status", "/now", "/admin/tasks", "/fleet/summary", "/status/uptime", "/status/history", "/heartbeat"]
    }), { headers: corsHeaders });
  },
};
