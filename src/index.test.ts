import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "./index";

// Mock registry entries pre-loaded into KV so tests never hit the network
const MOCK_REGISTRY = [
  { repo: "clankamode/clanka-api", criticality: "critical", tier: "core", description: "Main API" },
  { repo: "clankamode/ci-triage", criticality: "high", tier: "ops", description: "CI triage tool" },
];

const VALID_SET_PRESENCE_PAYLOAD = {
  presence: { state: "active", message: "monitoring workspace" },
  team: { clanka: { status: "active", task: "ship tests" } },
  activity: { type: "SYNC", desc: "presence updated" },
};

function createMockKV(store: Record<string, string> = {}): any {
  return {
    get: async (key: string) => store[key] ?? null,
    put: async (key: string, value: string, _opts?: any) => { store[key] = value; },
  };
}

function createEnv(
  extraKv: Record<string, string> = {},
  extraEnv: Partial<{ ADMIN_KEY: string; GITHUB_TOKEN: string }> = {},
) {
  return {
    CLANKA_STATE: createMockKV({
      "registry:v1": JSON.stringify(MOCK_REGISTRY),
      ...extraKv,
    }),
    ADMIN_KEY: "test-secret",
    ...extraEnv,
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
    const byRepo = Object.fromEntries(body.map((entry) => [entry.repo, entry.tasks]));
    expect(byRepo["clankamode/clanka-api"]).toEqual([
      { priority: "red", text: "Fix auth edge case", done: false },
      { priority: "green", text: "Polish docs", done: false },
    ]);
    expect(byRepo["clankamode/ci-triage"]).toEqual([
      { priority: "yellow", text: "Harden parser", done: false },
    ]);
  });

  it("returns empty task list for repos without TASKS.md", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Not Found", { status: 404 }));
    const res = await worker.fetch(req("/tasks"), createEnv());
    expect(res.status).toBe(200);
    const body = await json(res) as any[];
    const byRepo = Object.fromEntries(body.map((entry) => [entry.repo, entry.tasks]));
    expect(byRepo["clankamode/clanka-api"]).toEqual([]);
    expect(byRepo["clankamode/ci-triage"]).toEqual([]);
  });

  it("rejects non-GET with 405", async () => {
    const res = await worker.fetch(req("/tasks", "POST"), createEnv());
    expect(res.status).toBe(405);
  });
});

describe("Registry alignment and fallback", () => {
  it("hydrates /tools from live registry.json when primary cache is invalid", async () => {
    const liveRegistry = {
      tools: [
        { repo: "clankamode/zeta-tool", criticality: "medium", tier: "ops", description: "Zeta tool" },
        { repo: "clankamode/alpha-tool", criticality: "critical", tier: "core", description: "Alpha tool" },
      ],
    };
    const content = Buffer.from(JSON.stringify(liveRegistry), "utf8").toString("base64");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ content }), { status: 200 }));

    const kvStore: Record<string, string> = { "registry:v1": "{invalid-json" };
    const env = {
      CLANKA_STATE: createMockKV(kvStore),
      ADMIN_KEY: "test-secret",
      GITHUB_TOKEN: "gh-token",
    };
    const res = await worker.fetch(req("/tools"), env as any);
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.tools.map((tool: any) => tool.name)).toEqual(["alpha-tool", "zeta-tool"]);
    expect(kvStore["registry:v1"]).toBeTruthy();
    expect(kvStore["registry:v1:stale"]).toBeTruthy();
  });

  it("falls back to stale KV registry cache when GitHub API fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Bad Gateway", { status: 502 }));

    const staleRegistry = [
      { repo: "clankamode/stale-tool", criticality: "high", tier: "infra", description: "Stale tool" },
    ];
    const res = await worker.fetch(
      req("/tools"),
      createEnv({
        "registry:v1": "{invalid-json",
        "registry:v1:stale": JSON.stringify(staleRegistry),
      }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.tools[0]).toEqual(expect.objectContaining({
      name: "stale-tool",
      tier: "infra",
      criticality: "high",
      description: "Stale tool",
    }));
  });

  it("filters malformed registry entries before serving /tools", async () => {
    const res = await worker.fetch(
      req("/tools"),
      createEnv({
        "registry:v1": JSON.stringify([
          { repo: "clankamode/good-tool", criticality: "critical", tier: "core", description: "Good" },
          { repo: "clankamode/bad-criticality", criticality: "low", tier: "core", description: "Bad" },
          { repo: "clankamode/bad-tier", criticality: "high", tier: "misc", description: "Bad" },
          { repo: "", criticality: "high", tier: "ops", description: "Bad" },
        ]),
      }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.tools[0].name).toBe("good-tool");
  });
});

describe("GET /fleet/summary", () => {
  it("returns grouped metadata with deterministic ordering", async () => {
    const res = await worker.fetch(
      req("/fleet/summary"),
      createEnv({
        "registry:v1": JSON.stringify([
          { repo: "clankamode/zeta", criticality: "medium", tier: "ops", description: "z" },
          { repo: "clankamode/alpha", criticality: "critical", tier: "core", description: "a" },
          { repo: "clankamode/beta", criticality: "critical", tier: "core", description: "b" },
        ]),
      }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.totalRepos).toBe(3);
    expect(body.repos.map((repo: any) => repo.repo)).toEqual([
      "clankamode/alpha",
      "clankamode/beta",
      "clankamode/zeta",
    ]);
    expect(body.tiers.core).toEqual(["clankamode/alpha", "clankamode/beta"]);
    expect(body.byCriticality.critical).toEqual(["clankamode/alpha", "clankamode/beta"]);
  });

  it("rejects non-GET with 405", async () => {
    const res = await worker.fetch(req("/fleet/summary", "POST"), createEnv());
    expect(res.status).toBe(405);
  });
});

describe("GET /fleet/health", () => {
  it("returns GREEN when latest conclusion is success", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/repos/clankamode/clanka-api/actions/runs")) {
        return new Response(JSON.stringify({
          workflow_runs: [
            {
              conclusion: "success",
              status: "completed",
              updated_at: "2026-03-01T00:00:00.000Z",
            },
          ],
        }), { status: 200 });
      }
      if (url.includes("/repos/clankamode/ci-triage/actions/runs")) {
        return new Response(JSON.stringify({
          workflow_runs: [
            {
              conclusion: "success",
              status: "completed",
              updated_at: "2026-03-01T00:02:00.000Z",
            },
          ],
        }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const res = await worker.fetch(req("/fleet/health"), createEnv({}, { GITHUB_TOKEN: "gh-token" }));
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.status).toBe("GREEN");
    expect(body.repos).toEqual(expect.arrayContaining([
      expect.objectContaining({
        repo: "clankamode/clanka-api",
        conclusion: "success",
      }),
      expect.objectContaining({
        repo: "clankamode/ci-triage",
        conclusion: "success",
      }),
    ]));
  });

  it("returns RED when latest conclusion is failure", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/repos/clankamode/clanka-api/actions/runs")) {
        return new Response(JSON.stringify({
          workflow_runs: [
            {
              conclusion: "failure",
              status: "completed",
              updated_at: "2026-03-01T00:00:00.000Z",
            },
          ],
        }), { status: 200 });
      }
      if (url.includes("/repos/clankamode/ci-triage/actions/runs")) {
        return new Response(JSON.stringify({
          workflow_runs: [
            {
              conclusion: "success",
              status: "completed",
              updated_at: "2026-03-01T00:02:00.000Z",
            },
          ],
        }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const res = await worker.fetch(req("/fleet/health"), createEnv({}, { GITHUB_TOKEN: "gh-token" }));
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.status).toBe("RED");
    expect(body.repos).toEqual(expect.arrayContaining([
      expect.objectContaining({
        repo: "clankamode/clanka-api",
        conclusion: "failure",
      }),
    ]));
  });

  it("returns YELLOW when latest conclusion is null", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      workflow_runs: [
        {
          conclusion: null,
          status: "in_progress",
          updated_at: "2026-03-01T00:00:00.000Z",
        },
      ],
    }), { status: 200 }));

    const res = await worker.fetch(req("/fleet/health"), createEnv({}, { GITHUB_TOKEN: "gh-token" }));
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.status).toBe("YELLOW");
    expect(body.repos).toEqual(expect.arrayContaining([
      expect.objectContaining({
        conclusion: "null",
      }),
    ]));
  });

  it("returns UNKNOWN when GITHUB_TOKEN is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not be called"));

    const res = await worker.fetch(req("/fleet/health"), createEnv());
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.status).toBe("UNKNOWN");
    expect(body.repos).toEqual(expect.arrayContaining([
      expect.objectContaining({
        repo: "clankamode/clanka-api",
        conclusion: "unknown",
      }),
      expect.objectContaining({
        repo: "clankamode/ci-triage",
        conclusion: "unknown",
      }),
    ]));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses token authorization header for GitHub Actions requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      workflow_runs: [
        {
          conclusion: "success",
          status: "completed",
          updated_at: "2026-03-01T00:00:00.000Z",
        },
      ],
    }), { status: 200 }));

    const res = await worker.fetch(req("/fleet/health"), createEnv({}, { GITHUB_TOKEN: "gh-token" }));
    expect(res.status).toBe(200);

    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init as RequestInit)?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("token gh-token");
  });

  it("caches per-repo CI runs with 10-minute TTL and reuses repo cache", async () => {
    const kvStore: Record<string, string> = {
      "registry:v1": JSON.stringify(MOCK_REGISTRY),
    };
    const putCalls: Array<{ key: string; opts?: any }> = [];
    const env = {
      CLANKA_STATE: {
        get: async (key: string) => kvStore[key] ?? null,
        put: async (key: string, value: string, opts?: any) => {
          kvStore[key] = value;
          putCalls.push({ key, opts });
        },
      },
      ADMIN_KEY: "test-secret",
      GITHUB_TOKEN: "gh-token",
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      workflow_runs: [
        {
          conclusion: "success",
          status: "completed",
          updated_at: "2026-03-01T00:00:00.000Z",
          name: "CI",
        },
      ],
    }), { status: 200 }));

    const first = await worker.fetch(req("/fleet/health"), env as any);
    expect(first.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const ciWrites = putCalls.filter((call) => call.key.startsWith("ci:"));
    expect(ciWrites).toHaveLength(2);
    expect(ciWrites.map((call) => call.key).sort()).toEqual([
      "ci:clankamode/ci-triage:v1",
      "ci:clankamode/clanka-api:v1",
    ]);
    for (const call of ciWrites) {
      expect(call.opts?.expirationTtl).toBe(600);
    }

    const freshFleet = JSON.parse(kvStore["fleet:health:v1"]);
    kvStore["fleet:health:v1"] = JSON.stringify({
      ...freshFleet,
      checkedAt: "2000-01-01T00:00:00.000Z",
    });

    fetchSpy.mockClear();
    const second = await worker.fetch(req("/fleet/health"), env as any);
    expect(second.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns stale from KV when GitHub fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("GitHub unavailable"));
    const stalePayload = {
      status: "YELLOW",
      repos: [
        {
          repo: "clankamode/clanka-api",
          criticality: "critical",
          lastRun: "2026-03-01T00:00:00.000Z",
          conclusion: "failure",
        },
      ],
      checkedAt: "2026-03-01T00:05:00.000Z",
    };

    const res = await worker.fetch(
      req("/fleet/health"),
      createEnv(
        {
          "fleet:health:v1": JSON.stringify(stalePayload),
        },
        { GITHUB_TOKEN: "gh-token" },
      ),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body).toEqual(stalePayload);
  });

  it("returns 503 when both GitHub and KV fail", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("GitHub unavailable"));

    const res = await worker.fetch(req("/fleet/health"), createEnv({}, { GITHUB_TOKEN: "gh-token" }));
    const body = await json(res);

    expect(res.status).toBe(503);
    expect(body).toEqual({ error: "Service Unavailable" });
  });

  it("returns fresh cache without calling GitHub", async () => {
    const now = new Date().toISOString();
    const cachedPayload = {
      status: "GREEN",
      repos: [
        {
          repo: "clankamode/clanka-api",
          criticality: "critical",
          lastRun: "2026-03-01T00:00:00.000Z",
          conclusion: "success",
        },
      ],
      checkedAt: now,
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not be called"));

    const res = await worker.fetch(
      req("/fleet/health"),
      createEnv({
        "fleet:health:v1": JSON.stringify(cachedPayload),
      }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body).toEqual(cachedPayload);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects non-GET with 405", async () => {
    const res = await worker.fetch(req("/fleet/health", "POST"), createEnv());
    expect(res.status).toBe(405);
  });
});

describe("GET /history", () => {
  it("returns capped history (max 20 entries) preserving order", async () => {
    const history = Array.from({ length: 30 }, (_, index) => ({
      timestamp: 2_000_000 - index,
      desc: `event-${index}`,
      type: "SYNC",
      hash: `h${index}`,
    }));

    const res = await worker.fetch(
      req("/history"),
      createEnv({ history: JSON.stringify(history) }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.history).toHaveLength(20);
    expect(body.history[0]).toEqual(expect.objectContaining({ desc: "event-0" }));
    expect(body.history[19]).toEqual(expect.objectContaining({ desc: "event-19" }));
  });

  it("normalizes malformed history entries to safe defaults", async () => {
    const res = await worker.fetch(
      req("/history"),
      createEnv({
        history: JSON.stringify([
          null,
          { message: "from-message" },
          { type: "SYNC", desc: "explicit", hash: "abc12345", timestamp: 12345 },
        ]),
      }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.history[0]).toEqual(expect.objectContaining({
      desc: "activity",
      type: "event",
      hash: expect.any(String),
    }));
    expect(body.history[1]).toEqual(expect.objectContaining({
      desc: "from-message",
      type: "event",
    }));
    expect(body.history[2]).toEqual(expect.objectContaining({
      desc: "explicit",
      type: "SYNC",
      hash: "abc12345",
      timestamp: 12345,
    }));
  });

  it("returns empty history when no history exists", async () => {
    const res = await worker.fetch(req("/history"), createEnv());
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body).toEqual({ history: [] });
  });

  it("rejects non-GET with 405", async () => {
    const res = await worker.fetch(req("/history", "POST"), createEnv());
    expect(res.status).toBe(405);
  });
});

describe("GET /now and GET /pulse contracts", () => {
  it("returns consistent /now payload with status, signal, and last_seen", async () => {
    const now = 1_750_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const res = await worker.fetch(
      req("/now"),
      createEnv({
        started: String(now - 60_000),
        last_seen: String(now - 5_000),
        presence: JSON.stringify({
          state: "active",
          message: "monitoring workspace",
          timestamp: now - 5_000,
        }),
        team: JSON.stringify({
          clanka: { status: "active" },
          helper: { status: "idle" },
        }),
        history: JSON.stringify([
          { timestamp: now - 4_000, type: "SYNC", desc: "sync done", hash: "abc12345" },
        ]),
      }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      status: "active",
      signal: "⚡",
      last_seen: new Date(now - 5_000).toISOString(),
      timestamp: now - 5_000,
      agents_active: 1,
    }));
    expect(Array.isArray(body.history)).toBe(true);
    expect(body.team).toEqual(expect.objectContaining({ clanka: { status: "active" } }));
  });

  it("returns offline status in /now when heartbeat is stale", async () => {
    const now = 1_750_000_000_000;
    const thresholdMs = 10 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const res = await worker.fetch(
      req("/now"),
      createEnv({
        last_seen: String(now - thresholdMs - 1),
        presence: JSON.stringify({
          state: "active",
          timestamp: now - thresholdMs - 1,
        }),
      }),
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.status).toBe("offline");
    expect(body.signal).toBe("⚡");
  });

  it("rejects non-GET /now with 405", async () => {
    const res = await worker.fetch(req("/now", "POST"), createEnv());
    expect(res.status).toBe(405);
  });

  it("returns deterministic /pulse payload shape", async () => {
    const res = await worker.fetch(
      req("/pulse"),
      createEnv({
        presence: JSON.stringify({ state: "active" }),
        team: JSON.stringify({ clanka: { status: "active" }, helper: { status: "idle" } }),
        history: JSON.stringify([{ type: "SYNC", desc: "deployed", timestamp: 12345, hash: "aaa" }]),
      }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      ts: expect.any(String),
      status: "active",
      agents_active: 1,
      last_event_desc: "deployed",
    }));
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

describe("Status regression coverage", () => {
  const thresholdMs = 10 * 60 * 1000;

  it("GET /status returns offline when LAST_SEEN_KEY is missing", async () => {
    const res = await worker.fetch(req("/status"), createEnv());
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "offline" });
  });

  it("GET /status returns operational at the offline threshold boundary", async () => {
    const now = 1_750_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const res = await worker.fetch(
      req("/status"),
      createEnv({ last_seen: String(now - thresholdMs) }),
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({ status: "operational" }));
    expect(body.last_seen).toBe(new Date(now - thresholdMs).toISOString());
  });

  it("GET /status returns offline when LAST_SEEN_KEY is beyond threshold", async () => {
    const now = 1_750_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const res = await worker.fetch(
      req("/status"),
      createEnv({ last_seen: String(now - thresholdMs - 1) }),
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "offline" });
  });

  it("GET /status/uptime returns operational with uptime_ms when heartbeat is fresh", async () => {
    const now = 1_750_000_000_000;
    const lastSeen = now - 1234;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const res = await worker.fetch(
      req("/status/uptime"),
      createEnv({ last_seen: String(lastSeen) }),
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      status: "operational",
      uptime_ms: 1234,
      last_seen: new Date(lastSeen).toISOString(),
    }));
  });

  it("GET /status/uptime returns offline when heartbeat is stale", async () => {
    const now = 1_750_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const res = await worker.fetch(
      req("/status/uptime"),
      createEnv({ last_seen: String(now - thresholdMs - 1) }),
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "offline", uptime_ms: 0, last_seen: null });
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

describe("Auth middleware", () => {
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

  it("returns 200 when token is valid", async () => {
    const res = await worker.fetch(
      req("/set-presence", "POST", VALID_SET_PRESENCE_PAYLOAD, { Authorization: "Bearer test-secret" }),
      createEnv(),
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /set-presence", () => {
  const authHeaders = { Authorization: "Bearer test-secret" };
  const validationError = { error: "Invalid body: presence, team, and activity are required" };

  it("returns 400 for empty payload", async () => {
    const res = await worker.fetch(req("/set-presence", "POST", {}, authHeaders), createEnv());
    const body = await json(res);
    expect(res.status).toBe(400);
    expect(body).toEqual(validationError);
  });

  it("returns 400 for null payload", async () => {
    const res = await worker.fetch(req("/set-presence", "POST", null, authHeaders), createEnv());
    const body = await json(res);
    expect(res.status).toBe(400);
    expect(body).toEqual(validationError);
  });

  for (const missingField of ["presence", "team", "activity"] as const) {
    it(`returns 400 when ${missingField} is missing`, async () => {
      const payload = { ...VALID_SET_PRESENCE_PAYLOAD };
      delete payload[missingField];
      const res = await worker.fetch(req("/set-presence", "POST", payload, authHeaders), createEnv());
      const body = await json(res);
      expect(res.status).toBe(400);
      expect(body).toEqual(validationError);
    });
  }

  it("returns 200 for valid payload", async () => {
    const res = await worker.fetch(req("/set-presence", "POST", VALID_SET_PRESENCE_PAYLOAD, authHeaders), createEnv());
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true });
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

  it("returns 400 for non-array history payload", async () => {
    const res = await worker.fetch(
      req("/heartbeat", "POST", { history: { desc: "bad" } }, authHeaders),
      createEnv(),
    );
    const body = await json(res);
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Invalid body: history must be an array" });
  });

  it("returns 200 for a valid heartbeat payload", async () => {
    const res = await worker.fetch(
      req("/heartbeat", "POST", { history: [{ type: "heartbeat", desc: "ping" }] }, authHeaders),
      createEnv(),
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({ success: true, status: "operational" }));
  });
});

describe("POST /admin/activity", () => {
  const authHeaders = { Authorization: "Bearer test-secret" };

  it("returns 401 when auth is missing", async () => {
    const res = await worker.fetch(req("/admin/activity", "POST", { desc: "ok", type: "SYNC" }), createEnv());
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is invalid", async () => {
    const res = await worker.fetch(
      req("/admin/activity", "POST", { desc: "ok", type: "SYNC" }, { Authorization: "Bearer wrong-token" }),
      createEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for malformed payload", async () => {
    const res = await worker.fetch(req("/admin/activity", "POST", { desc: "missing type" }, authHeaders), createEnv());
    const body = await json(res);
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Invalid body" });
  });

  it("returns 200 for a valid payload", async () => {
    const res = await worker.fetch(
      req("/admin/activity", "POST", { desc: "deployed", type: "SYNC" }, authHeaders),
      createEnv(),
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body).toEqual(
      expect.objectContaining({
        success: true,
        entry: expect.objectContaining({ desc: "deployed", type: "SYNC" }),
      }),
    );
  });
});
