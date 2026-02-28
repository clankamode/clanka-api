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
      req("/set-presence", "POST", {}, { Authorization: "Bearer test-secret" }),
      createEnv(),
    );
    expect(res.status).toBe(200);
  });
});
