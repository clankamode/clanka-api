export interface Env {
  CLANKA_STATE: KVNamespace;
  ADMIN_KEY: string;
  ADMIN_TOKEN?: string;
  GITHUB_TOKEN?: string;
}

export type FleetTier = "ops" | "infra" | "core" | "quality" | "policy" | "template";
export type FleetCriticality = "critical" | "high" | "medium";
export type FleetHealthStatus = "GREEN" | "YELLOW" | "RED" | "UNKNOWN";
export type FleetRepo = { repo: string; criticality: FleetCriticality; tier: FleetTier };
export type FleetRepoHealth = {
  repo: string;
  criticality: FleetCriticality;
  lastRun: string | null;
  conclusion: string;
};
export type FleetHealthPayload = {
  status: FleetHealthStatus;
  repos: FleetRepoHealth[];
  checkedAt: string;
};
export type FleetTrendDirection = "up" | "down" | "flat" | "unknown";
export type FleetRepoTrend = {
  repo: string;
  criticality: FleetCriticality;
  last5: string[];
  direction: FleetTrendDirection;
};
export type FleetTrendPayload = {
  generatedAt: string;
  totalRepos: number;
  repos: FleetRepoTrend[];
};
export type FleetScorePayload = {
  score: number;
  status: FleetHealthStatus;
  totalRepos: number;
  healthyRepos: number;
  degradedRepos: number;
  unknownRepos: number;
  timestamp: string;
};
export type HistoryEntry = { timestamp: number; desc: string; type: string; hash: string };

export type Project = { name: string; description: string; url: string; status: string; last_updated: string };
export type RequestLogEntry = {
  timestamp: number;
  method: string;
  path: string;
  status: number;
  ip: string;
  ua?: string;
};
export type ChangelogEntry = {
  sha: string;
  message: string;
  author: string;
  date: string;
};

export type RegistryEntry = {
  repo: string;
  criticality: FleetCriticality;
  tier: FleetTier;
  description: string;
};

export type TaskPriority = "red" | "yellow" | "green";
export type RepoTask = { priority: TaskPriority; text: string; done: boolean };
export type RepoTasksPayload = { repo: string; tasks: RepoTask[] };
export type RateLimitState = {
  count: number;
  resetAt: number;
};
export type MetricsState = {
  requests_total: number;
  kv_hits: number;
  kv_misses: number;
};
export type WorkerExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export type GithubWorkflowRun = {
  conclusion: string | null;
  status: string | null;
  name: string | null;
  updatedAt: string | null;
};

export type GithubStatsPayload = {
  repoCount: number;
  totalStars: number;
  lastPushedAt: string | null;
  lastPushedRepo: string | null;
  cachedAt: string;
  /** False when the payload is a failure placeholder, not a real empty org. */
  available?: boolean;
  error?: string;
};

export type GithubEvent = {
  type: string;
  repo: string;
  message: string;
  timestamp: string;
};

export type PostsCountPayload = {
  count: number;
  lastPost: string;
  lastPostDate: string;
  lastPostSlug: string;
  /** False when the payload is a failure placeholder, not a real empty posts dir. */
  available?: boolean;
  error?: string;
};
