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
const STATUS_ENDPOINTS = ["/", "/fleet/summary", "/fleet/health", "/history", "/now", "/status", "/metrics"];

function createMockKV(store: Record<string, string> = {}): any {
  return {
    get: async (key: string) => store[key] ?? null,
    put: async (key: string, value: string, _opts?: any) => { store[key] = value; },
  };
}

function createEnv(
  extraKv: Record<string, string> = {},
  extraEnv: Partial<{ ADMIN_KEY: string; ADMIN_TOKEN: string; GITHUB_TOKEN: string }> = {},
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

  it("response shape has tools array, count, cached, timestamp", async () => {
    const res = await worker.fetch(req("/tools"), createEnv());
    const body = await json(res);
    expect(body).toEqual(
      expect.objectContaining({
        tools: expect.any(Array),
        count: expect.any(Number),
        cached: expect.any(Boolean),
        timestamp: expect.any(String),
      }),
    );
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it("count matches tools length", async () => {
    const res = await worker.fetch(req("/tools"), createEnv());
    const body = await json(res);
    expect(body.count).toBe(body.tools.length);
  });

  it("each tool has repo, description, tier, criticality", async () => {
    const res = await worker.fetch(req("/tools"), createEnv());
    const body = await json(res);
    for (const t of body.tools) {
      expect(t).toHaveProperty("repo");
      expect(t).toHaveProperty("description");
      expect(t).toHaveProperty("tier");
      expect(t).toHaveProperty("criticality");
    }
  });

  it("returns tools from mock registry", async () => {
    const res = await worker.fetch(req("/tools"), createEnv());
    const body = await json(res);
    const repos = body.tools.map((t: any) => t.repo);
    expect(repos).toContain("clankamode/clanka-api");
    expect(repos).toContain("clankamode/ci-triage");
  });

  it("sets cached=true when served from KV", async () => {
    const res = await worker.fetch(req("/tools"), createEnv());
    const body = await json(res);
    expect(body.cached).toBe(true);
  });

  it("supports registry payloads stored under an entries array shape", async () => {
    const res = await worker.fetch(
      req("/tools"),
      createEnv({
        "registry:v1": JSON.stringify({
          entries: [
            { repo: "clankamode/entries-tool", criticality: "medium", tier: "ops", description: "Entries tool" },
          ],
        }),
      }),
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.cached).toBe(true);
    expect(body.count).toBe(1);
    expect(body.tools[0].repo).toBe("clankamode/entries-tool");
  });

  it("deduplicates registry entries by repo name", async () => {
    const res = await worker.fetch(
      req("/tools"),
      createEnv({
        "registry:v1": JSON.stringify([
          { repo: "clankamode/dup-tool", criticality: "high", tier: "ops", description: "A" },
          { repo: "clankamode/dup-tool", criticality: "high", tier: "ops", description: "B" },
        ]),
      }),
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.tools[0].repo).toBe("clankamode/dup-tool");
  });

  it("returns CORS headers", async () => {
    const res = await worker.fetch(req("/tools"), createEnv());
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns cached=false on KV miss and fetches from GitHub", async () => {
    const liveRegistry = {
      tools: [
        { repo: "clankamode/live-tool", criticality: "high", tier: "ops", description: "Live tool" },
      ],
    };
    const content = Buffer.from(JSON.stringify(liveRegistry), "utf8").toString("base64");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ content }), { status: 200 }));

    const env = {
      CLANKA_STATE: createMockKV({}),
      ADMIN_KEY: "test-secret",
      GITHUB_TOKEN: "gh-token",
    };
    const res = await worker.fetch(req("/tools"), env as any);
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.cached).toBe(false);
    expect(body.count).toBe(1);
    expect(body.tools[0].repo).toBe("clankamode/live-tool");
  });

  it("writes fetched registry to KV with 5-minute TTL", async () => {
    const putCalls: Array<{ key: string; opts?: any }> = [];
    const kvStore: Record<string, string> = {};
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
    const content = Buffer.from(JSON.stringify({
      tools: [
        { repo: "clankamode/live-tool", criticality: "high", tier: "ops", description: "Live tool" },
      ],
    }), "utf8").toString("base64");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ content }), { status: 200 }));

    const res = await worker.fetch(req("/tools"), env as any);
    expect(res.status).toBe(200);
    expect(putCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "registry:v1",
        opts: expect.objectContaining({ expirationTtl: 300 }),
      }),
    ]));
  });

  it("returns empty tools array when GitHub fails on KV miss", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Bad Gateway", { status: 502 }));
    const env = {
      CLANKA_STATE: createMockKV({}),
      ADMIN_KEY: "test-secret",
      GITHUB_TOKEN: "gh-token",
    };
    const res = await worker.fetch(
      req("/tools"),
      env as any,
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.tools).toEqual([]);
    expect(body.count).toBe(0);
    expect(body.cached).toBe(false);
  });

  it("rejects non-GET with 405", async () => {
    const res = await worker.fetch(req("/tools", "POST"), createEnv());
    expect(res.status).toBe(405);
  });
});

describe("Malformed cache fallbacks", () => {
  it("returns an empty tools payload when registry:v1 cache JSON is malformed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Bad Gateway", { status: 502 }));

    const res = await worker.fetch(
      req("/tools"),
      createEnv({ "registry:v1": "{invalid-json" }, { GITHUB_TOKEN: "gh-token" }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      tools: [],
      count: 0,
    }));
  });

  it("returns safe defaults when github:stats cache JSON is malformed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Bad Gateway", { status: 502 }));

    const res = await worker.fetch(
      req("/github/stats"),
      createEnv({ "github:stats:v1": "{invalid-json" }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      repoCount: 0,
      totalStars: 0,
      lastPushedAt: null,
      lastPushedRepo: null,
      cachedAt: expect.any(String),
    }));
    expect(Number.isNaN(Date.parse(body.cachedAt))).toBe(false);
  });

  it("returns { events: [] } when github:events:v1 cache JSON is malformed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Bad Gateway", { status: 502 }));

    const res = await worker.fetch(
      req("/github/events"),
      createEnv({ "github:events:v1": "{invalid-json" }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body).toEqual({ events: [] });
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
    expect(body.tools.map((tool: any) => tool.repo)).toEqual(["clankamode/alpha-tool", "clankamode/zeta-tool"]);
    expect(body.cached).toBe(false);
    expect(kvStore["registry:v1"]).toBeTruthy();
  });

  it("returns empty payload when GitHub API fails and primary cache is invalid", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Bad Gateway", { status: 502 }));

    const res = await worker.fetch(
      req("/tools"),
      createEnv({
        "registry:v1": "{invalid-json",
      }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.count).toBe(0);
    expect(body.tools).toEqual([]);
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
    expect(body.count).toBe(1);
    expect(body.tools[0].repo).toBe("clankamode/good-tool");
  });
});

describe("GET /changelog", () => {
  it("returns commits and timestamp with expected shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      {
        sha: "abc123",
        commit: {
          message: "feat: add pipeline",
          author: { name: "clanka", date: "2026-03-01T00:00:00.000Z" },
          committer: { date: "2026-03-01T00:00:00.000Z" },
        },
        author: { login: "clanka" },
      },
    ]), { status: 200 }));

    const res = await worker.fetch(req("/changelog"), createEnv({}, { GITHUB_TOKEN: "gh-token" }));
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      commits: expect.any(Array),
      timestamp: expect.any(String),
    }));
    expect(body.commits[0]).toEqual(expect.objectContaining({
      sha: "abc123",
      message: "feat: add pipeline",
      author: "clanka",
      date: "2026-03-01T00:00:00.000Z",
    }));
    expect(body.commits[0]).not.toHaveProperty("url");
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it("uses GITHUB_TOKEN authorization header", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    const res = await worker.fetch(req("/changelog"), createEnv({}, { GITHUB_TOKEN: "gh-token" }));
    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init as RequestInit)?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer gh-token");
  });

  it("serves from KV cache when changelog cache key is populated", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not be called"));
    const cachedCommits = [
      {
        sha: "cached123",
        message: "cached commit",
        author: "cache-bot",
        date: "2026-03-01T00:00:00.000Z",
      },
    ];
    const res = await worker.fetch(
      req("/changelog"),
      createEnv({
        "changelog:meta-runner:v1": JSON.stringify(cachedCommits),
      }, { GITHUB_TOKEN: "gh-token" }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.commits).toEqual(cachedCommits);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("writes changelog to KV with 10-minute TTL after GitHub fetch", async () => {
    const putCalls: Array<{ key: string; opts?: any }> = [];
    const kvStore: Record<string, string> = {};
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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      {
        sha: "abc123",
        commit: {
          message: "feat: add pipeline",
          author: { name: "clanka", date: "2026-03-01T00:00:00.000Z" },
        },
        author: { login: "clanka" },
      },
    ]), { status: 200 }));

    const res = await worker.fetch(req("/changelog"), env as any);
    expect(res.status).toBe(200);
    expect(putCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "changelog:meta-runner:v1",
        opts: expect.objectContaining({ expirationTtl: 600 }),
      }),
    ]));
  });

  it("returns empty array and no token error when GITHUB_TOKEN is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not be called"));
    const res = await worker.fetch(req("/changelog"), createEnv());
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      commits: [],
      error: "no token",
      timestamp: expect.any(String),
    }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns empty commits when GitHub request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Bad Gateway", { status: 502 }));
    const res = await worker.fetch(req("/changelog"), createEnv({}, { GITHUB_TOKEN: "gh-token" }));
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.commits).toEqual([]);
    expect(body).not.toHaveProperty("error");
    expect(body).toHaveProperty("timestamp");
  });

  it("limits changelog response to 10 commits", async () => {
    const commits = Array.from({ length: 12 }, (_, index) => ({
      sha: `sha-${index}`,
      commit: {
        message: `commit-${index}`,
        author: { name: "clanka", date: "2026-03-01T00:00:00.000Z" },
      },
      author: { login: "clanka" },
    }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(commits), { status: 200 }));

    const res = await worker.fetch(req("/changelog"), createEnv({}, { GITHUB_TOKEN: "gh-token" }));
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.commits).toHaveLength(10);
  });

  it("fetches from GitHub when changelog cache is invalid JSON", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    const res = await worker.fetch(
      req("/changelog"),
      createEnv({
        "changelog:meta-runner:v1": "{invalid-json",
      }, { GITHUB_TOKEN: "gh-token" }),
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects non-GET with 405", async () => {
    const res = await worker.fetch(req("/changelog", "POST"), createEnv({}, { GITHUB_TOKEN: "gh-token" }));
    expect(res.status).toBe(405);
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

  it("falls back to an empty repos list when registry cache JSON is malformed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Bad Gateway", { status: 502 }));

    const res = await worker.fetch(
      req("/fleet/summary"),
      createEnv({ "registry:v1": "{invalid-json" }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      generatedAt: expect.any(String),
      totalRepos: 0,
      repos: [],
      source: "registry",
    }));
    expect(body.tiers).toEqual({
      ops: [],
      infra: [],
      core: [],
      quality: [],
      policy: [],
      template: [],
    });
    expect(body.byCriticality).toEqual({
      critical: [],
      high: [],
      medium: [],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns a valid empty shape when registry cache is an empty array", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not be called"));

    const res = await worker.fetch(
      req("/fleet/summary"),
      createEnv({ "registry:v1": JSON.stringify([]) }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.totalRepos).toBe(0);
    expect(body.repos).toEqual([]);
    expect(body.tiers).toEqual({
      ops: [],
      infra: [],
      core: [],
      quality: [],
      policy: [],
      template: [],
    });
    expect(body.byCriticality).toEqual({
      critical: [],
      high: [],
      medium: [],
    });
    expect(body.source).toBe("registry");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns source=registry and ISO generatedAt timestamp", async () => {
    const res = await worker.fetch(req("/fleet/summary"), createEnv());
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.source).toBe("registry");
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
  });

  it("always includes all tier and criticality buckets", async () => {
    const res = await worker.fetch(
      req("/fleet/summary"),
      createEnv({
        "registry:v1": JSON.stringify([
          { repo: "clankamode/only-core", criticality: "critical", tier: "core", description: "only" },
        ]),
      }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.tiers).toEqual({
      ops: [],
      infra: [],
      core: ["clankamode/only-core"],
      quality: [],
      policy: [],
      template: [],
    });
    expect(body.byCriticality).toEqual({
      critical: ["clankamode/only-core"],
      high: [],
      medium: [],
    });
  });

  it("filters malformed entries and deduplicates by repo", async () => {
    const res = await worker.fetch(
      req("/fleet/summary"),
      createEnv({
        "registry:v1": JSON.stringify([
          { repo: "clankamode/good", criticality: "high", tier: "ops", description: "ok" },
          { repo: "clankamode/good", criticality: "high", tier: "ops", description: "dup" },
          { repo: "clankamode/bad-criticality", criticality: "low", tier: "ops", description: "bad" },
          { repo: "", criticality: "high", tier: "ops", description: "bad" },
        ]),
      }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.totalRepos).toBe(1);
    expect(body.repos).toEqual([
      {
        repo: "clankamode/good",
        criticality: "high",
        tier: "ops",
      },
    ]);
  });

  it("supports registry payloads wrapped in an entries array", async () => {
    const res = await worker.fetch(
      req("/fleet/summary"),
      createEnv({
        "registry:v1": JSON.stringify({
          entries: [
            { repo: "clankamode/entries-only", criticality: "medium", tier: "infra", description: "wrapped" },
          ],
        }),
      }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.totalRepos).toBe(1);
    expect(body.repos[0]).toEqual({
      repo: "clankamode/entries-only",
      criticality: "medium",
      tier: "infra",
    });
  });

  it("returns CORS headers", async () => {
    const res = await worker.fetch(req("/fleet/summary"), createEnv());
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
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
  it("uses the default limit and returns at most 20 entries", async () => {
    const history = Array.from({ length: 30 }, (_, index) => ({
      timestamp: 2_000_000 + index,
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
    expect(body.count).toBe(20);
    expect(body.history[0]).toEqual(expect.objectContaining({ desc: "event-29" }));
    expect(body.history[19]).toEqual(expect.objectContaining({ desc: "event-10" }));
  });

  it("applies explicit ?limit=5 and clamps output to 5 entries", async () => {
    const history = Array.from({ length: 12 }, (_, index) => ({
      timestamp: 1_000_000 + index,
      desc: `event-${index}`,
      type: "SYNC",
      hash: `h${index}`,
    }));

    const res = await worker.fetch(
      req("/history?limit=5"),
      createEnv({ history: JSON.stringify(history) }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.history).toHaveLength(5);
    expect(body.count).toBe(5);
    expect(body.history[0]).toEqual(expect.objectContaining({ desc: "event-11" }));
    expect(body.history[4]).toEqual(expect.objectContaining({ desc: "event-7" }));
  });

  it("keeps count in sync with returned history length", async () => {
    const history = Array.from({ length: 8 }, (_, index) => ({
      timestamp: 900_000 + index,
      desc: `event-${index}`,
      type: "SYNC",
      hash: `h${index}`,
    }));

    const res = await worker.fetch(
      req("/history?limit=3"),
      createEnv({ history: JSON.stringify(history) }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.history).toHaveLength(3);
    expect(body.count).toBe(body.history.length);
  });

  it("clamps ?limit above max to 20", async () => {
    const history = Array.from({ length: 30 }, (_, index) => ({
      timestamp: 1_000_000 + index,
      desc: `event-${index}`,
      type: "SYNC",
      hash: `h${index}`,
    }));

    const res = await worker.fetch(
      req("/history?limit=100"),
      createEnv({ history: JSON.stringify(history) }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.history).toHaveLength(20);
    expect(body.count).toBe(20);
  });

  it("uses default limit when ?limit is not a number", async () => {
    const history = Array.from({ length: 25 }, (_, index) => ({
      timestamp: 1_000_000 + index,
      desc: `event-${index}`,
      type: "SYNC",
      hash: `h${index}`,
    }));

    const res = await worker.fetch(
      req("/history?limit=abc"),
      createEnv({ history: JSON.stringify(history) }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.history).toHaveLength(20);
    expect(body.count).toBe(20);
  });

  it("uses default limit when ?limit is zero", async () => {
    const history = Array.from({ length: 22 }, (_, index) => ({
      timestamp: 1_000_000 + index,
      desc: `event-${index}`,
      type: "SYNC",
      hash: `h${index}`,
    }));

    const res = await worker.fetch(
      req("/history?limit=0"),
      createEnv({ history: JSON.stringify(history) }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.history).toHaveLength(20);
    expect(body.count).toBe(20);
  });

  it("uses default limit when ?limit is negative", async () => {
    const history = Array.from({ length: 22 }, (_, index) => ({
      timestamp: 1_000_000 + index,
      desc: `event-${index}`,
      type: "SYNC",
      hash: `h${index}`,
    }));

    const res = await worker.fetch(
      req("/history?limit=-5"),
      createEnv({ history: JSON.stringify(history) }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.history).toHaveLength(20);
    expect(body.count).toBe(20);
  });

  it("floors decimal limit values", async () => {
    const history = Array.from({ length: 9 }, (_, index) => ({
      timestamp: 1_000_000 + index,
      desc: `event-${index}`,
      type: "SYNC",
      hash: `h${index}`,
    }));

    const res = await worker.fetch(
      req("/history?limit=3.9"),
      createEnv({ history: JSON.stringify(history) }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.history).toHaveLength(3);
    expect(body.count).toBe(3);
  });

  it("returns reverse-chronological order (newest first)", async () => {
    const res = await worker.fetch(
      req("/history"),
      createEnv({
        history: JSON.stringify([
          { timestamp: 1000, desc: "oldest", type: "SYNC", hash: "h1" },
          { timestamp: 3000, desc: "newest", type: "SYNC", hash: "h3" },
          { timestamp: 2000, desc: "middle", type: "SYNC", hash: "h2" },
        ]),
      }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.history.map((entry: any) => entry.desc)).toEqual(["newest", "middle", "oldest"]);
  });

  it("returns empty history when cached history JSON is invalid", async () => {
    const res = await worker.fetch(
      req("/history"),
      createEnv({ history: "{invalid-json" }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body).toEqual({ history: [], count: 0 });
  });

  it("returns empty history when cached history is not an array", async () => {
    const res = await worker.fetch(
      req("/history"),
      createEnv({ history: JSON.stringify({ desc: "not-an-array" }) }),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body).toEqual({ history: [], count: 0 });
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
    expect(body.count).toBe(3);
  });

  it("returns { history: [], count: 0 } for explicitly empty history", async () => {
    const res = await worker.fetch(
      req("/history"),
      createEnv({ history: JSON.stringify([]) }),
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body).toEqual({ history: [], count: 0 });
  });

  it("returns empty history gracefully on KV miss", async () => {
    const res = await worker.fetch(req("/history"), createEnv());
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body).toEqual({ history: [], count: 0 });
  });

  it("returns CORS headers", async () => {
    const res = await worker.fetch(req("/history"), createEnv());
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
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

describe("GET /status", () => {
  it("returns the public status contract shape", async () => {
    const res = await worker.fetch(req("/status"), createEnv());
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      version: "1.0.0",
      timestamp: expect.any(String),
      endpoints: STATUS_ENDPOINTS,
    });
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it("disables caching for status", async () => {
    const res = await worker.fetch(req("/status"), createEnv());
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns CORS headers", async () => {
    const res = await worker.fetch(req("/status"), createEnv());
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("rejects non-GET with 405", async () => {
    const res = await worker.fetch(req("/status", "POST"), createEnv());
    const body = await json(res);
    expect(res.status).toBe(405);
    expect(body).toEqual({ error: "Method Not Allowed" });
  });

  it("includes /metrics and /status in endpoint list", async () => {
    const res = await worker.fetch(req("/status"), createEnv());
    const body = await json(res);
    expect(body.endpoints).toContain("/status");
    expect(body.endpoints).toContain("/metrics");
  });
});

describe("GET /status/uptime regression coverage", () => {
  const thresholdMs = 10 * 60 * 1000;

  it("returns operational with uptime_ms when heartbeat is fresh", async () => {
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

  it("returns offline when heartbeat is stale", async () => {
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

describe("GET /metrics", () => {
  it("returns 401 when token is missing", async () => {
    const res = await worker.fetch(
      req("/metrics"),
      createEnv({}, { ADMIN_TOKEN: "metrics-secret" }),
    );
    const body = await json(res);
    expect(res.status).toBe(401);
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("returns 401 when token is wrong", async () => {
    const res = await worker.fetch(
      req("/metrics", "GET", undefined, { "X-Admin-Token": "wrong-token" }),
      createEnv({}, { ADMIN_TOKEN: "metrics-secret" }),
    );
    const body = await json(res);
    expect(res.status).toBe(401);
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("returns 200 with metrics shape when token is correct", async () => {
    const res = await worker.fetch(
      req("/metrics", "GET", undefined, { "X-Admin-Token": "metrics-secret" }),
      createEnv({}, { ADMIN_TOKEN: "metrics-secret" }),
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      uptime_ms: expect.any(Number),
      requests_total: expect.any(Number),
      kv_hits: expect.any(Number),
      kv_misses: expect.any(Number),
      timestamp: expect.any(String),
    }));
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it("returns 503 when ADMIN_TOKEN is missing", async () => {
    const res = await worker.fetch(req("/metrics"), createEnv());
    const body = await json(res);
    expect(res.status).toBe(503);
    expect(body).toEqual({ error: "metrics_unavailable" });
  });

  it("disables caching for authorized metrics responses", async () => {
    const res = await worker.fetch(
      req("/metrics", "GET", undefined, { "X-Admin-Token": "metrics-secret" }),
      createEnv({}, { ADMIN_TOKEN: "metrics-secret" }),
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("disables caching for unauthorized metrics responses", async () => {
    const res = await worker.fetch(
      req("/metrics"),
      createEnv({}, { ADMIN_TOKEN: "metrics-secret" }),
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects non-GET with 405", async () => {
    const res = await worker.fetch(
      req("/metrics", "POST"),
      createEnv({}, { ADMIN_TOKEN: "metrics-secret" }),
    );
    const body = await json(res);
    expect(res.status).toBe(405);
    expect(body).toEqual({ error: "Method Not Allowed" });
  });

  it("returns non-negative numeric counters", async () => {
    const res = await worker.fetch(
      req("/metrics", "GET", undefined, { "X-Admin-Token": "metrics-secret" }),
      createEnv({}, { ADMIN_TOKEN: "metrics-secret" }),
    );
    const body = await json(res);
    expect(body.requests_total).toBeGreaterThanOrEqual(0);
    expect(body.kv_hits).toBeGreaterThanOrEqual(0);
    expect(body.kv_misses).toBeGreaterThanOrEqual(0);
  });

  it("falls back to in-memory counters when KV is unavailable", async () => {
    const env = {
      CLANKA_STATE: {
        get: async () => { throw new Error("kv unavailable"); },
        put: async () => { throw new Error("kv unavailable"); },
      },
      ADMIN_KEY: "test-secret",
      ADMIN_TOKEN: "metrics-secret",
    };
    const res = await worker.fetch(
      req("/metrics", "GET", undefined, { "X-Admin-Token": "metrics-secret" }),
      env as any,
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      uptime_ms: expect.any(Number),
      requests_total: expect.any(Number),
      kv_hits: expect.any(Number),
      kv_misses: expect.any(Number),
      timestamp: expect.any(String),
    }));
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
