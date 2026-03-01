import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGithubEvents } from "./github-events";

function createMockKV(store: Record<string, string> = {}): KVNamespace {
  return {
    get: async (key: string) => store[key] ?? null,
    put: async (key: string, value: string, _opts?: any) => {
      store[key] = value;
    },
  } as KVNamespace;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadGithubEvents", () => {
  it("returns cached events without calling GitHub when cache JSON is valid", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not be called"));
    const cached = [
      {
        type: "PUSH",
        repo: "clanka-api",
        message: "from cache",
        timestamp: "2026-03-01T00:00:00.000Z",
      },
    ];

    const events = await loadGithubEvents(createMockKV({
      "github:events:v1": JSON.stringify(cached),
    }));

    expect(events).toEqual(cached);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls through malformed cache JSON and fetches from GitHub", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      {
        type: "PushEvent",
        repo: { name: "clankamode/clanka-api" },
        created_at: "2026-03-01T00:00:00.000Z",
        payload: { commits: [{ message: "fresh message" }] },
      },
    ]), { status: 200 }));

    const events = await loadGithubEvents(createMockKV({
      "github:events:v1": "{invalid-json",
    }));

    expect(events).toHaveLength(1);
    expect(events[0].message).toBe("fresh message");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns [] when GitHub response is non-ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Bad Gateway", { status: 502 }));

    const events = await loadGithubEvents(createMockKV());

    expect(events).toEqual([]);
  });

  it("normalizes repo names by removing clankamode/ prefix", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      {
        type: "PushEvent",
        repo: { name: "clankamode/clanka-api" },
        created_at: "2026-03-01T00:00:00.000Z",
        payload: {
          commits: [{ message: "feat: normalize repo" }],
        },
      },
    ]), { status: 200 }));

    const events = await loadGithubEvents(createMockKV());

    expect(events).toHaveLength(1);
    expect(events[0].repo).toBe("clanka-api");
  });

  it("truncates long messages to <=100 chars with ellipsis", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      {
        type: "PushEvent",
        repo: { name: "clankamode/clanka-api" },
        created_at: "2026-03-01T00:00:00.000Z",
        payload: {
          commits: [{ message: "x".repeat(140) }],
        },
      },
    ]), { status: 200 }));

    const events = await loadGithubEvents(createMockKV());

    expect(events).toHaveLength(1);
    expect(events[0].message.length).toBeLessThanOrEqual(100);
    expect(events[0].message.endsWith("...")).toBe(true);
  });

  it("formats PushEvent messages from the first commit line", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      {
        type: "PushEvent",
        repo: { name: "clankamode/clanka-api" },
        created_at: "2026-03-01T00:00:00.000Z",
        payload: {
          commits: [{ message: "feat: ship worker\nbody text ignored" }],
        },
      },
    ]), { status: 200 }));

    const events = await loadGithubEvents(createMockKV());

    expect(events[0]).toEqual({
      type: "PUSH",
      repo: "clanka-api",
      message: "feat: ship worker",
      timestamp: "2026-03-01T00:00:00.000Z",
    });
  });

  it("formats PullRequestEvent messages", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      {
        type: "PullRequestEvent",
        repo: { name: "clankamode/clanka-api" },
        created_at: "2026-03-01T00:00:00.000Z",
        payload: {
          action: "opened",
          pull_request: { number: 42, title: "Harden event parser" },
        },
      },
    ]), { status: 200 }));

    const events = await loadGithubEvents(createMockKV());

    expect(events[0]).toEqual(expect.objectContaining({
      type: "PR",
      message: "opened PR #42: Harden event parser",
    }));
  });

  it("formats IssuesEvent messages", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      {
        type: "IssuesEvent",
        repo: { name: "clankamode/clanka-api" },
        created_at: "2026-03-01T00:00:00.000Z",
        payload: {
          action: "closed",
          issue: { number: 7, title: "Fix cache fallback bug" },
        },
      },
    ]), { status: 200 }));

    const events = await loadGithubEvents(createMockKV());

    expect(events[0]).toEqual(expect.objectContaining({
      type: "ISSUE",
      message: "closed issue #7: Fix cache fallback bug",
    }));
  });

  it("formats CreateEvent messages", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      {
        type: "CreateEvent",
        repo: { name: "clankamode/clanka-api" },
        created_at: "2026-03-01T00:00:00.000Z",
        payload: {
          ref_type: "branch",
          ref: "feat/cache-hardening",
        },
      },
    ]), { status: 200 }));

    const events = await loadGithubEvents(createMockKV());

    expect(events[0]).toEqual(expect.objectContaining({
      type: "CREATE",
      message: "created branch feat/cache-hardening",
    }));
  });

  it("filters unsupported event types", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      {
        type: "WatchEvent",
        repo: { name: "clankamode/clanka-api" },
        created_at: "2026-03-01T00:00:00.000Z",
        payload: {},
      },
      {
        type: "PushEvent",
        repo: { name: "clankamode/clanka-api" },
        created_at: "2026-03-01T00:01:00.000Z",
        payload: { commits: [{ message: "supported" }] },
      },
    ]), { status: 200 }));

    const events = await loadGithubEvents(createMockKV());

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("PUSH");
  });

  it("limits output to the first 15 allowed events", async () => {
    const raw = Array.from({ length: 20 }, (_, i) => ({
      type: "PushEvent",
      repo: { name: "clankamode/clanka-api" },
      created_at: `2026-03-01T00:${String(i).padStart(2, "0")}:00.000Z`,
      payload: { commits: [{ message: `commit-${i}` }] },
    }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(raw), { status: 200 }));

    const events = await loadGithubEvents(createMockKV());

    expect(events).toHaveLength(15);
    expect(events[0].message).toBe("commit-0");
    expect(events[14].message).toBe("commit-14");
  });

  it("uses fallback push message when commit payload is missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      {
        type: "PushEvent",
        repo: { name: "clankamode/clanka-api" },
        created_at: "2026-03-01T00:00:00.000Z",
        payload: {},
      },
    ]), { status: 200 }));

    const events = await loadGithubEvents(createMockKV());

    expect(events).toHaveLength(1);
    expect(events[0].message).toBe("push");
  });

  it("keeps repo names from other owners unchanged", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      {
        type: "PushEvent",
        repo: { name: "otherorg/external-repo" },
        created_at: "2026-03-01T00:00:00.000Z",
        payload: { commits: [{ message: "external" }] },
      },
    ]), { status: 200 }));

    const events = await loadGithubEvents(createMockKV());

    expect(events).toHaveLength(1);
    expect(events[0].repo).toBe("otherorg/external-repo");
  });

  it("truncates long PR messages with ellipsis", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      {
        type: "PullRequestEvent",
        repo: { name: "clankamode/clanka-api" },
        created_at: "2026-03-01T00:00:00.000Z",
        payload: {
          action: "opened",
          pull_request: { number: 1, title: "t".repeat(300) },
        },
      },
    ]), { status: 200 }));

    const events = await loadGithubEvents(createMockKV());

    expect(events[0].message.length).toBeLessThanOrEqual(100);
    expect(events[0].message.endsWith("...")).toBe(true);
    expect(events[0].message.startsWith("opened PR #1: ")).toBe(true);
  });

  it("truncates long issue messages with ellipsis", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      {
        type: "IssuesEvent",
        repo: { name: "clankamode/clanka-api" },
        created_at: "2026-03-01T00:00:00.000Z",
        payload: {
          action: "opened",
          issue: { number: 12, title: "i".repeat(300) },
        },
      },
    ]), { status: 200 }));

    const events = await loadGithubEvents(createMockKV());

    expect(events[0].message.length).toBeLessThanOrEqual(100);
    expect(events[0].message.endsWith("...")).toBe(true);
    expect(events[0].message.startsWith("opened issue #12: ")).toBe(true);
  });

  it("truncates long create messages with ellipsis", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      {
        type: "CreateEvent",
        repo: { name: "clankamode/clanka-api" },
        created_at: "2026-03-01T00:00:00.000Z",
        payload: {
          ref_type: "branch",
          ref: "feature/".concat("x".repeat(200)),
        },
      },
    ]), { status: 200 }));

    const events = await loadGithubEvents(createMockKV());

    expect(events[0].message.length).toBeLessThanOrEqual(100);
    expect(events[0].message.endsWith("...")).toBe(true);
  });

  it("writes normalized events to KV with 900s TTL", async () => {
    const putSpy = vi.fn(async () => {});
    const kv = {
      get: async () => null,
      put: putSpy,
    } as unknown as KVNamespace;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      {
        type: "PushEvent",
        repo: { name: "clankamode/clanka-api" },
        created_at: "2026-03-01T00:00:00.000Z",
        payload: { commits: [{ message: "cache me" }] },
      },
    ]), { status: 200 }));

    const events = await loadGithubEvents(kv);

    expect(events).toHaveLength(1);
    expect(putSpy).toHaveBeenCalledWith(
      "github:events:v1",
      JSON.stringify(events),
      { expirationTtl: 900 },
    );
  });
});
