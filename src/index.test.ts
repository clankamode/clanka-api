import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "./index";

// Mock registry entries pre-loaded into KV so tests never hit the network
const MOCK_REGISTRY = [
  { repo: "clankamode/clanka-api", criticality: "critical", tier: "core", description: "Main API" },
  { repo: "clankamode/ci-triage", criticality: "high", tier: "ops", description: "CI triage tool" },
];

function createMockKV(store: Record<string, string> = {}): any {
  return {
    get: async (key: string) => store[key] ?? null,
    put: async (key: string, value: string, _opts?: any) => { store[key] = value; },
  };
}

function createEnv(extra: Record<string, string> = {}) {
  return {
    CLANKA_STATE: createMockKV({
      "registry:v1": JSON.stringify(MOCK_REGISTRY),
      ...extra,
    }),
    ADMIN_KEY: "test-secret",
  };
}

function req(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { ...headers, "Content-Type": "application/json" };
  }
  return new Request(`https://api.test${path}`, init);
}

async function json(res: Response) {
  return res.json();
}

afterEach(() => {
  vi.restoreAllMocks();
});

// /projects
describe("GET /projects", () => {
  it("returns 200", async () => {
    const res = await worker.fetch(req("/projects"), createEnv());
    expect(res.status).toBe(200);
  });

  it("has application/json Content-Type", async () => {
    const res = await worker.fetch(req("/projects"), createEnv());
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("response shape has projects, source, cached", async () => {
    const res = await worker.fetch(req("/projects"), createEnv());
    const body = await json(res);
    expect(body).toEqual(
      expect.objectContaining({
        projects: expect.any(Array),
        source: "registry",
        cached: expect.any(Boolean),
      }),
    );
    expect(body).toHaveProperty("projects");
    expect(body).toHaveProperty("source", "registry");
    expect(body).toHaveProperty("cached");
    expect(body.projects).toBeInstanceOf(Array);
  });

  it("each project has required fields", async () => {
    const res = await worker.fetch(req("/projects"), createEnv());
    const body = await json(res);
    expect(body.projects.length).toBeGreaterThan(0);
    for (const p of body.projects) {
      expect(p).toHaveProperty("name");
      expect(p).toHaveProperty("description");
      expect(p).toHaveProperty("url");
      expect(p).toHaveProperty("status");
      expect(p).toHaveProperty("last_updated");
    }
  });

  it("returns clanka-api (criticality=critical) from mock registry", async () => {
    const res = await worker.fetch(req("/projects"), createEnv());
    const body = await json(res);
    const names = body.projects.map((p: any) => p.name);
    expect(names).toContain("clanka-api");
  });

  it("returns CORS headers", async () => {
    const res = await worker.fetch(req("/projects"), createEnv());
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns empty projects array when registry cache is empty", async () => {
    const res = await worker.fetch(
      req("/projects"),
      createEnv({ "registry:v1": JSON.stringify([]) }),
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.projects).toEqual([]);
    expect(body.source).toBe("registry");
    expect(body.cached).toBe(true);
  });

  it("rejects non-GET with 405", async () => {
    const res = await worker.fetch(req("/projects", "POST"), createEnv());
    expect(res.status).toBe(405);
  });
});

// /tools
describe("GET /tools", () => {
  it("returns 200", async () => {
    const res = await worker.fetch(req("/tools"), createEnv());
    expect(res.status).toBe(200);
  });

  it("has application/json Content-Type", async () => {
    const res = await worker.fetch(req("/tools"), createEnv());
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("response shape has tools array, total, source", async () => {
    const res = await worker.fetch(req("/tools"), createEnv());
    const body = await json(res);
    expect(body).toEqual(
      expect.objectContaining({
        tools: expect.any(Array),
        total: expect.any(Number),
        source: "registry",
      }),
    );
    expect(body).toHaveProperty("tools");
    expect(body).toHaveProperty("total");
    expect(body).toHaveProperty("source", "registry");
    expect(body.tools).toBeInstanceOf(Array);
    expect(body.total).toBe(body.tools.length);
  });

  it("each tool has name, description, status", async () => {
    const res = await worker.fetch(req("/tools"), createEnv());
    const body = await json(res);
    for (const t of body.tools) {
      expect(t).toHaveProperty("name");
      expect(t).toHaveProperty("description");
      expect(t).toHaveProperty("status");
    }
  });

  it("returns tools from mock registry", async () => {
    const res = await worker.fetch(req("/tools"), createEnv());
    const body = await json(res);
    const names = body.tools.map((t: any) => t.name);
    expect(names).toContain("clanka-api");
    expect(names).toContain("ci-triage");
  });

  it("returns CORS headers", async () => {
    const res = await worker.fetch(req("/tools"), createEnv());
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns empty tools array when registry cache is empty", async () => {
    const res = await worker.fetch(
      req("/tools"),
      createEnv({ "registry:v1": JSON.stringify([]) }),
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.tools).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.source).toBe("registry");
  });

  it("rejects non-GET with 405", async () => {
    const res = await worker.fetch(req("/tools", "POST"), createEnv());
    expect(res.status).toBe(405);
  });
});

// /tasks
describe("GET /tasks", () => {
  it("returns 200 and parsed open tasks grouped by repo", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/repos/clankamode/clanka-api/contents/TASKS.md")) {
        const content = Buffer.from(
          [
            "## 🔴 Critical",
            "- [ ] **Fix auth edge case**",
            "## 🟢 Nice to have",
            "- [ ] **Polish docs**",
            "- [x] **Closed item**",
          ].join("\n"),
          "utf8",
        ).toString("base64");
        return new Response(JSON.stringify({ content }), { status: 200 });
      }
      if (url.includes("/repos/clankamode/ci-triage/contents/TASKS.md")) {
        const content = Buffer.from(
          [
            "## 🟡 Important",
            "- [ ] **Harden parser**",
          ].join("\n"),
          "utf8",
        ).toString("base64");
        return new Response(JSON.stringify({ content }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const res = await worker.fetch(req("/tasks"), createEnv());
    expect(res.status).toBe(200);
    const body = await json(res) as any[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);

    expect(body[0]).toEqual({
      repo: "clankamode/clanka-api",
      tasks: [
        { priority: "red", text: "Fix auth edge case", done: false },
        { priority: "green", text: "Polish docs", done: false },
      ],
    });
    expect(body[1]).toEqual({
      repo: "clankamode/ci-triage",
      tasks: [{ priority: "yellow", text: "Harden parser", done: false }],
    });
  });

  it("returns empty task list for repos without TASKS.md", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Not Found", { status: 404 }));
    const res = await worker.fetch(req("/tasks"), createEnv());
    expect(res.status).toBe(200);
    const body = await json(res) as any[];
    expect(body).toEqual([
      { repo: "clankamode/clanka-api", tasks: [] },
      { repo: "clankamode/ci-triage", tasks: [] },
    ]);
  });

  it("rejects non-GET with 405", async () => {
    const res = await worker.fetch(req("/tasks", "POST"), createEnv());
    expect(res.status).toBe(405);
  });
});

// Unknown paths
describe("Unknown paths", () => {
  it("returns 404 for unknown path", async () => {
    const res = await worker.fetch(req("/nonexistent"), createEnv());
    const body = await json(res);
    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "Not Found" });
  });

  it("returns application/json Content-Type on 404", async () => {
    const res = await worker.fetch(req("/unknown-path"), createEnv());
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });
});

describe("GET /openapi.json", () => {
  it("returns 200 and valid json", async () => {
    const res = await worker.fetch(req("/openapi.json"), createEnv());
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.openapi).toBe("3.0.3");
    expect(body.paths).toBeTruthy();
  });

  it("documents public GET endpoints", async () => {
    const res = await worker.fetch(req("/openapi.json"), createEnv());
    const body = await json(res);
    const paths = body.paths || {};
    expect(Object.keys(paths).sort()).toEqual(
      expect.arrayContaining([
        "/status",
        "/health",
        "/projects",
        "/tools",
        "/tasks",
        "/changelog",
      ]),
    );
  });
});

describe("Rate limiting", () => {
  it("returns 429 after 60 public GET requests in a minute", async () => {
    const env = createEnv({ "registry:v1": JSON.stringify(MOCK_REGISTRY) });
    const headers = { "X-Forwarded-For": "203.0.113.1" };

    for (let i = 0; i < 60; i += 1) {
      const res = await worker.fetch(req("/status", "GET", undefined, headers), env);
      expect(res.status).toBe(200);
    }

    const limited = await worker.fetch(req("/status", "GET", undefined, headers), env);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
  });

  it("allows requests after 60s window passes", async () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const env = createEnv({ "registry:v1": JSON.stringify(MOCK_REGISTRY) });
    const headers = { "X-Forwarded-For": "198.51.100.42" };

    for (let i = 0; i < 60; i += 1) {
      const res = await worker.fetch(req("/status", "GET", undefined, headers), env);
      expect(res.status).toBe(200);
    }

    const limited = await worker.fetch(req("/status", "GET", undefined, headers), env);
    expect(limited.status).toBe(429);

    nowSpy.mockReturnValue(now + 60_000);
    const reset = await worker.fetch(req("/status", "GET", undefined, headers), env);
    expect(reset.status).toBe(200);
  });
});

describe("POST /set-presence", () => {
  const authHeaders = { Authorization: "Bearer test-secret" };

  it("returns 401 when auth is missing", async () => {
    const res = await worker.fetch(req("/set-presence", "POST", {}), createEnv());
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is invalid", async () => {
    const res = await worker.fetch(
      req("/set-presence", "POST", {}, { Authorization: "Bearer wrong-token" }),
      createEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for null or empty required fields", async () => {
    const invalidBodies = [
      null,
      {},
      { presence: "", team: { alpha: "active" }, activity: { desc: "deploy", type: "sync" } },
      { presence: "active", team: {}, activity: { desc: "deploy", type: "sync" } },
      { presence: "active", team: { alpha: "active" }, activity: null },
      { presence: "active", team: { alpha: "active" }, activity: { desc: "", type: "sync" } },
    ];

    for (const body of invalidBodies) {
      const res = await worker.fetch(req("/set-presence", "POST", body, authHeaders), createEnv());
      const payload = await json(res);
      expect(res.status).toBe(400);
      expect(payload.error).toContain("required non-empty presence, team, and activity");
    }
  });

  it("returns 200 for valid payload and updates state", async () => {
    const now = 1_700_000_100_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const env = createEnv();
    const res = await worker.fetch(
      req(
        "/set-presence",
        "POST",
        {
          presence: "active",
          team: { alpha: "active" },
          activity: { desc: "deploying", type: "release" },
        },
        authHeaders,
      ),
      env,
    );
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ success: true });

    const nowRes = await worker.fetch(req("/now"), env);
    const nowBody = await json(nowRes);
    expect(nowBody.status).toBe("active");
    expect(nowBody.signal).toBe("⚡");
    expect(nowBody.last_seen).toBe(new Date(now).toISOString());
    expect(nowBody.team).toEqual({ alpha: "active" });
    expect(nowBody.history[0]).toEqual(
      expect.objectContaining({
        desc: "deploying",
        type: "release",
      }),
    );
  });
});

describe("POST /heartbeat", () => {
  const authHeaders = { Authorization: "Bearer test-secret" };

  it("returns 401 when auth is missing", async () => {
    const res = await worker.fetch(req("/heartbeat", "POST", {}), createEnv());
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is invalid", async () => {
    const res = await worker.fetch(
      req("/heartbeat", "POST", {}, { Authorization: "Bearer wrong-token" }),
      createEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when history is not an array", async () => {
    const res = await worker.fetch(
      req("/heartbeat", "POST", { history: { bad: true } }, authHeaders),
      createEnv(),
    );
    const body = await json(res);
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Invalid body: history must be an array" });
  });

  it("returns 200 and updates online status/history", async () => {
    const now = 1_700_000_200_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const env = createEnv();
    const res = await worker.fetch(
      req(
        "/heartbeat",
        "POST",
        {
          history: [{ timestamp: now - 1_000, desc: "prior", type: "heartbeat", hash: "h1" }],
          activity: { desc: "beat", type: "heartbeat" },
        },
        authHeaders,
      ),
      env,
    );
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ success: true, timestamp: now });

    const statusRes = await worker.fetch(req("/status"), env);
    const statusBody = await json(statusRes);
    expect(statusBody.status).toBe("operational");
    expect(statusBody.last_seen).toBe(new Date(now).toISOString());

    const historyRes = await worker.fetch(req("/history"), env);
    const historyBody = await json(historyRes);
    expect(historyBody.history[0]).toEqual(
      expect.objectContaining({
        desc: "beat",
        type: "heartbeat",
      }),
    );
  });
});

describe("POST /admin/activity", () => {
  const authHeaders = { Authorization: "Bearer test-secret" };

  it("returns 401 when auth is missing", async () => {
    const res = await worker.fetch(req("/admin/activity", "POST", { desc: "x", type: "event" }), createEnv());
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is invalid", async () => {
    const res = await worker.fetch(
      req("/admin/activity", "POST", { desc: "x", type: "event" }, { Authorization: "Bearer wrong-token" }),
      createEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for malformed payload", async () => {
    const res = await worker.fetch(req("/admin/activity", "POST", [], authHeaders), createEnv());
    const body = await json(res);
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Invalid body" });
  });

  it("returns 200 and writes entry to history", async () => {
    const env = createEnv();
    const res = await worker.fetch(
      req("/admin/activity", "POST", { desc: "manual update", type: "ops" }, authHeaders),
      env,
    );
    const payload = await json(res);
    expect(res.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.entry).toEqual(
      expect.objectContaining({
        desc: "manual update",
        type: "ops",
      }),
    );

    const historyRes = await worker.fetch(req("/history"), env);
    const historyBody = await json(historyRes);
    expect(historyBody.history[0]).toEqual(
      expect.objectContaining({
        desc: "manual update",
        type: "ops",
      }),
    );
  });
});

describe("Status regression around last_seen threshold", () => {
  const THRESHOLD_MS = 10 * 60 * 1000;

  it("returns offline when LAST_SEEN_KEY is missing", async () => {
    const now = 1_700_000_300_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const env = createEnv();

    const statusRes = await worker.fetch(req("/status"), env);
    const statusBody = await json(statusRes);
    expect(statusBody).toEqual({ status: "offline" });

    const uptimeRes = await worker.fetch(req("/status/uptime"), env);
    const uptimeBody = await json(uptimeRes);
    expect(uptimeBody).toEqual({ status: "offline", uptime_ms: 0 });
  });

  it("returns operational exactly at STATUS_OFFLINE_THRESHOLD_MS boundary", async () => {
    const now = 1_700_000_400_000;
    const lastSeen = now - THRESHOLD_MS;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const env = createEnv({
      last_seen: String(lastSeen),
      started: String(now - 12_345),
    });

    const statusRes = await worker.fetch(req("/status"), env);
    const statusBody = await json(statusRes);
    expect(statusBody.status).toBe("operational");
    expect(statusBody.last_seen).toBe(new Date(lastSeen).toISOString());
    expect(statusBody.signal).toBe("⚡");

    const uptimeRes = await worker.fetch(req("/status/uptime"), env);
    const uptimeBody = await json(uptimeRes);
    expect(uptimeBody).toEqual(
      expect.objectContaining({
        status: "operational",
        signal: "⚡",
        last_seen: new Date(lastSeen).toISOString(),
        uptime_ms: 12_345,
      }),
    );
  });

  it("returns offline when last_seen is older than threshold", async () => {
    const now = 1_700_000_500_000;
    const lastSeen = now - THRESHOLD_MS - 1;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const env = createEnv({
      last_seen: String(lastSeen),
      started: String(now - 8_000),
    });

    const statusRes = await worker.fetch(req("/status"), env);
    const statusBody = await json(statusRes);
    expect(statusBody).toEqual({ status: "offline" });

    const uptimeRes = await worker.fetch(req("/status/uptime"), env);
    const uptimeBody = await json(uptimeRes);
    expect(uptimeBody).toEqual({ status: "offline", uptime_ms: 8_000 });
  });
});

describe("Contracts: /now and /pulse", () => {
  it("GET /now returns exact shape with status, last_seen, signal", async () => {
    const now = 1_700_000_600_000;
    const lastSeen = now - 5_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const env = createEnv({
      presence: JSON.stringify({ state: "focus", message: "shipping tests", timestamp: lastSeen }),
      history: JSON.stringify([{ timestamp: lastSeen - 1_000, desc: "coverage added", type: "test", hash: "abc12345" }]),
      team: JSON.stringify({ alpha: "active", beta: { status: "active" }, gamma: "idle" }),
      started: String(now - 60_000),
      last_seen: String(lastSeen),
    });

    const res = await worker.fetch(req("/now"), env);
    expect(res.status).toBe(200);
    const body = await json(res);

    expect(Object.keys(body).sort()).toEqual([
      "agents_active",
      "current",
      "history",
      "last_seen",
      "signal",
      "stack",
      "status",
      "team",
      "timestamp",
      "uptime",
    ]);
    expect(body).toEqual({
      current: "shipping tests",
      status: "focus",
      signal: "⚡",
      stack: ["Cloudflare Workers", "TypeScript", "Lit"],
      timestamp: lastSeen,
      uptime: 60_000,
      agents_active: 2,
      last_seen: new Date(lastSeen).toISOString(),
      history: [{ timestamp: lastSeen - 1_000, desc: "coverage added", type: "test", hash: "abc12345" }],
      team: { alpha: "active", beta: { status: "active" }, gamma: "idle" },
    });
  });

  it("GET /pulse returns exact shape with status, last_seen, signal", async () => {
    const lastSeen = 1_700_000_700_000;
    const env = createEnv({
      presence: JSON.stringify({ state: "focus", message: "shipping tests", timestamp: lastSeen }),
      history: JSON.stringify([{ timestamp: lastSeen - 1_000, desc: "coverage added", type: "test", hash: "abc12345" }]),
      team: JSON.stringify({ alpha: "active", beta: { status: "active" }, gamma: "idle" }),
      last_seen: String(lastSeen),
    });

    const res = await worker.fetch(req("/pulse"), env);
    expect(res.status).toBe(200);
    const body = await json(res);

    expect(Object.keys(body).sort()).toEqual([
      "agents_active",
      "last_event_desc",
      "last_seen",
      "signal",
      "status",
      "ts",
    ]);
    expect(body).toEqual({
      ts: expect.any(String),
      status: "focus",
      signal: "⚡",
      last_seen: new Date(lastSeen).toISOString(),
      agents_active: 2,
      last_event_desc: "coverage added",
    });
  });
});
