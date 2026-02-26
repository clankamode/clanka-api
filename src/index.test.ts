import { describe, it, expect } from "vitest";
import worker from "./index";

// Minimal KV mock
function createMockKV(store: Record<string, string> = {}): any {
  return {
    get: async (key: string) => store[key] ?? null,
    put: async (key: string, value: string) => {
      store[key] = value;
    },
  };
}

function createEnv(kvStore: Record<string, string> = {}) {
  return {
    CLANKA_STATE: createMockKV(kvStore),
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
  it("returns project list with expected fields", async () => {
    const res = await worker.fetch(req("/projects"), createEnv());
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.projects).toBeInstanceOf(Array);
    expect(body.projects.length).toBeGreaterThan(0);
    for (const p of body.projects) {
      expect(p).toHaveProperty("name");
      expect(p).toHaveProperty("description");
      expect(p).toHaveProperty("url");
      expect(p).toHaveProperty("status");
      expect(p).toHaveProperty("last_updated");
    }
  });

  it("includes clanka-api in the project list", async () => {
    const res = await worker.fetch(req("/projects"), createEnv());
    const body = await json(res);
    const names = body.projects.map((p: any) => p.name);
    expect(names).toContain("clanka-api");
  });

  it("returns CORS headers", async () => {
    const res = await worker.fetch(req("/projects"), createEnv());
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("rejects non-GET methods with 405", async () => {
    const res = await worker.fetch(req("/projects", "POST"), createEnv());
    expect(res.status).toBe(405);
  });
});

// /tools
describe("GET /tools", () => {
  it("returns tools array and total count", async () => {
    const res = await worker.fetch(req("/tools"), createEnv());
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.tools).toBeInstanceOf(Array);
    expect(body.total).toBe(body.tools.length);
  });

  it("includes all expected tools", async () => {
    const res = await worker.fetch(req("/tools"), createEnv());
    const body = await json(res);
    const names = body.tools.map((t: any) => t.name);
    const expected = [
      "ci-triage",
      "meta-runner",
      "repo-context",
      "local-env-doctor",
      "auto-remediator",
      "pr-signal-lens",
      "assistant-tool-registry",
    ];
    for (const tool of expected) {
      expect(names).toContain(tool);
    }
  });

  it("each tool has name, description, and status", async () => {
    const res = await worker.fetch(req("/tools"), createEnv());
    const body = await json(res);
    for (const t of body.tools) {
      expect(t).toHaveProperty("name");
      expect(t).toHaveProperty("description");
      expect(t).toHaveProperty("status");
    }
  });

  it("returns CORS headers", async () => {
    const res = await worker.fetch(req("/tools"), createEnv());
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("rejects non-GET methods with 405", async () => {
    const res = await worker.fetch(req("/tools", "POST"), createEnv());
    expect(res.status).toBe(405);
  });
});
