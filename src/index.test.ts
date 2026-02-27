import { describe, it, expect } from "vitest";
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

function req(path: string, method = "GET") {
  return new Request(`https://api.test${path}`, { method });
}

async function json(res: Response) {
  return res.json();
}

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

  it("rejects non-GET with 405", async () => {
    const res = await worker.fetch(req("/tools", "POST"), createEnv());
    expect(res.status).toBe(405);
  });
});

// Unknown paths
describe("Unknown paths", () => {
  it("returns 404 for unknown path", async () => {
    const res = await worker.fetch(req("/nonexistent"), createEnv());
    expect(res.status).toBe(404);
  });

  it("returns application/json Content-Type on 404", async () => {
    const res = await worker.fetch(req("/unknown-path"), createEnv());
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });
});
