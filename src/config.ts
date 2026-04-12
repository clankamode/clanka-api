export const HISTORY_LIMIT = 20;
export const REGISTRY_URL = "https://api.github.com/repos/clankamode/assistant-tool-registry/contents/registry.json";
export const REGISTRY_CACHE_KEY = "registry:v1";
export const REGISTRY_STALE_CACHE_KEY = `${REGISTRY_CACHE_KEY}:stale`;
export const REGISTRY_TTL_SEC = 3600; // 1 hour
export const REGISTRY_STALE_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
export const TOOLS_REGISTRY_TTL_SEC = 5 * 60; // 5 minutes

export const REQUEST_LOG_KEY = "request_log";
export const REQUEST_LOG_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
export const REQUEST_LOG_LIMIT = 100;

export const LAST_SEEN_KEY = "last_seen";
export const STATUS_OFFLINE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export const GITHUB_STATS_CACHE_KEY = "github:stats:v1";
export const GITHUB_STATS_TTL_SEC = 3600; // 1 hour

export const CHANGELOG_CACHE_KEY = "changelog:meta-runner:v1";
export const CHANGELOG_TTL_SEC = 10 * 60; // 10 minutes
export const CHANGELOG_URL = "https://api.github.com/repos/clankamode/meta-runner/commits?per_page=10";

export const FLEET_HEALTH_CACHE_KEY = "fleet:health:v1";
export const FLEET_HEALTH_TTL_SEC = 5 * 60; // 5 minutes
export const FLEET_HEALTH_TTL_MS = FLEET_HEALTH_TTL_SEC * 1000;
export const FLEET_CI_TTL_SEC = 10 * 60; // 10 minutes

export const GITHUB_EVENTS_CACHE_KEY = "github:events:v1";
export const GITHUB_EVENTS_TTL_SEC = 900;

export const BLOG_POSTS_LIST_URL =
  "https://api.github.com/repos/clankamode/clankamode.github.io/contents/posts";
export const BLOG_POSTS_CACHE_KEY = "blog:posts:count:v1";
export const BLOG_POSTS_TTL_SEC = 3600; // 1 hour

export function fleetCiCacheKey(repo: string): string {
  return `ci:${repo}:v1`;
}

export function fleetCiTrendCacheKey(repo: string): string {
  return `ci:trend:${repo}:v1`;
}

export const RATE_LIMIT_KEY_PREFIX = "rate_limit:ip:";
export const RATE_LIMIT_WINDOW_SEC = 60;
export const RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_SEC * 1000;
export const RATE_LIMIT_MAX_REQUESTS = 10;
export const METRICS_KEY = "metrics:v1";
export const API_VERSION = "1.0.0";
export const STATUS_ENDPOINTS = [
  "/",
  "/fleet/summary",
  "/fleet/health",
  "/fleet/score",
  "/history",
  "/now",
  "/status",
  "/tools/search",
  "/metrics",
];
export const startTime = Date.now();

export const CACHE_KEYS_TO_INVALIDATE = [
  REGISTRY_CACHE_KEY,
  REGISTRY_STALE_CACHE_KEY,
  FLEET_HEALTH_CACHE_KEY,
  GITHUB_STATS_CACHE_KEY,
  CHANGELOG_CACHE_KEY,
  GITHUB_EVENTS_CACHE_KEY,
  BLOG_POSTS_CACHE_KEY,
];

export const OPENAPI_SPEC = {
  openapi: "3.0.3",
  info: {
    title: "clanka-api",
    version: API_VERSION,
    description: "Edge API for Clanka public endpoints",
  },
  paths: {
    "/status": {
      get: {
        summary: "Get service status",
        responses: {
          "200": {
            description: "Current status payload",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string" },
                    timestamp: { type: "string" },
                    signal: { type: "string" },
                    last_seen: { type: "string" },
                  },
                  additionalProperties: true,
                },
              },
            },
          },
          "429": {
            description: "Too Many Requests",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: { type: "string" },
                  },
                  required: ["error"],
                },
              },
            },
          },
        },
      },
    },
    "/health": {
      get: {
        summary: "Health check",
        responses: {
          "200": {
            description: "Health payload",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string" },
                    timestamp: { type: "string" },
                    signal: { type: "string" },
                    last_seen: { type: "string" },
                  },
                  additionalProperties: true,
                },
              },
            },
          },
          "429": {
            description: "Too Many Requests",
          },
        },
      },
    },
    "/projects": {
      get: {
        summary: "Get active projects from registry",
        responses: {
          "200": {
            description: "Projects payload",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    projects: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          description: { type: "string" },
                          url: { type: "string" },
                          status: { type: "string" },
                          last_updated: { type: "string" },
                        },
                        required: ["name", "description", "url", "status", "last_updated"],
                      },
                    },
                    source: { type: "string" },
                    cached: { type: "boolean" },
                  },
                  required: ["projects", "source", "cached"],
                },
              },
            },
          },
          "429": {
            description: "Too Many Requests",
          },
        },
      },
    },
    "/tools": {
      get: {
        summary: "Get registered tools",
        responses: {
          "200": {
            description: "Tools payload",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tools: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          repo: { type: "string" },
                          description: { type: "string" },
                          tier: { type: "string" },
                          criticality: { type: "string" },
                        },
                        required: ["repo", "description", "tier", "criticality"],
                      },
                    },
                    count: { type: "number" },
                    cached: { type: "boolean" },
                    timestamp: { type: "string" },
                  },
                  required: ["tools", "count", "cached", "timestamp"],
                },
              },
            },
          },
          "429": {
            description: "Too Many Requests",
          },
        },
      },
    },
    "/tools/{repo}": {
      get: {
        summary: "Get a registered tool by repo",
        parameters: [
          {
            name: "repo",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Tool payload",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tool: {
                      type: "object",
                      properties: {
                        repo: { type: "string" },
                        description: { type: "string" },
                        tier: { type: "string" },
                        criticality: { type: "string" },
                      },
                      required: ["repo", "description", "tier", "criticality"],
                    },
                    cached: { type: "boolean" },
                    timestamp: { type: "string" },
                  },
                  required: ["tool", "cached", "timestamp"],
                },
              },
            },
          },
          "404": {
            description: "Tool not found",
          },
          "429": {
            description: "Too Many Requests",
          },
        },
      },
    },
    "/tasks": {
      get: {
        summary: "Get parsed open tasks per repo",
        responses: {
          "200": {
            description: "Task payload",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      repo: { type: "string" },
                      tasks: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            priority: { type: "string" },
                            text: { type: "string" },
                            done: { type: "boolean" },
                          },
                          required: ["priority", "text", "done"],
                        },
                      },
                    },
                    required: ["repo", "tasks"],
                  },
                },
              },
            },
          },
          "429": {
            description: "Too Many Requests",
          },
        },
      },
    },
    "/fleet/health": {
      get: {
        summary: "Get workflow health across registered fleet repos",
        responses: {
          "200": {
            description: "Fleet health payload",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", enum: ["GREEN", "YELLOW", "RED", "UNKNOWN"] },
                    repos: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          repo: { type: "string" },
                          criticality: { type: "string" },
                          lastRun: { type: "string", nullable: true },
                          conclusion: { type: "string" },
                        },
                        required: ["repo", "criticality", "lastRun", "conclusion"],
                      },
                    },
                    checkedAt: { type: "string" },
                  },
                  required: ["status", "repos", "checkedAt"],
                },
              },
            },
          },
          "503": {
            description: "GitHub unavailable and no cache available",
          },
          "429": {
            description: "Too Many Requests",
          },
        },
      },
    },
    "/fleet/trend": {
      get: {
        summary: "Get CI trend data across registered fleet repos",
        responses: {
          "200": {
            description: "Fleet trend payload",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    generatedAt: { type: "string" },
                    totalRepos: { type: "number" },
                    repos: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          repo: { type: "string" },
                          criticality: { type: "string" },
                          last5: {
                            type: "array",
                            items: { type: "string" },
                          },
                          direction: { type: "string", enum: ["up", "down", "flat", "unknown"] },
                        },
                        required: ["repo", "criticality", "last5", "direction"],
                      },
                    },
                  },
                  required: ["generatedAt", "totalRepos", "repos"],
                },
              },
            },
          },
          "429": {
            description: "Too Many Requests",
          },
        },
      },
    },
    "/changelog": {
      get: {
        summary: "Get recent commit changelog",
        responses: {
          "200": {
            description: "Changelog payload",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    commits: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          sha: { type: "string" },
                          message: { type: "string" },
                          author: { type: "string" },
                          date: { type: "string" },
                        },
                        required: ["sha", "message", "author", "date"],
                      },
                    },
                    timestamp: { type: "string" },
                    error: { type: "string" },
                  },
                  required: ["commits", "timestamp"],
                },
              },
            },
          },
          "429": {
            description: "Too Many Requests",
          },
        },
      },
    },
    "/openapi.json": {
      get: {
        summary: "Get OpenAPI 3 specification",
        responses: {
          "200": {
            description: "OpenAPI document",
          },
        },
      },
    },
  },
};
