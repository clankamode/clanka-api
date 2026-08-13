import {
  BLOG_POSTS_CACHE_KEY,
  BLOG_POSTS_LIST_URL,
  BLOG_POSTS_TTL_SEC,
  CHANGELOG_CACHE_KEY,
  CHANGELOG_TTL_SEC,
  CHANGELOG_URL,
  GITHUB_EVENTS_CACHE_KEY,
  GITHUB_EVENTS_TTL_SEC,
  GITHUB_STATS_CACHE_KEY,
  GITHUB_STATS_TTL_SEC,
} from "./config";
import type { ChangelogEntry, Env, GithubEvent, GithubStatsPayload, PostsCountPayload } from "./types";

const POST_HTML_RE = /^(\d{4}-\d{2}-\d{2})-(.+)\.html$/;

function emptyPostsCount(error?: string): PostsCountPayload {
  const base: PostsCountPayload = {
    count: 0,
    lastPost: "000",
    lastPostDate: "",
    lastPostSlug: "",
  };
  if (!error) return base;
  return {
    ...base,
    available: false,
    error,
  };
}

function parsePostsCountCached(raw: string | null): PostsCountPayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    const o = p as Record<string, unknown>;
    if (typeof o.count !== "number" || !Number.isFinite(o.count) || o.count < 0) return null;
    if (typeof o.lastPost !== "string" || typeof o.lastPostDate !== "string" || typeof o.lastPostSlug !== "string") {
      return null;
    }
    return {
      count: Math.floor(o.count),
      lastPost: o.lastPost,
      lastPostDate: o.lastPostDate,
      lastPostSlug: o.lastPostSlug,
    };
  } catch {
    return null;
  }
}

function parsePostFilename(name: string): { date: string; slug: string } | null {
  const m = name.match(POST_HTML_RE);
  if (!m) return null;
  return { date: m[1], slug: m[2] };
}

export async function loadPostsCount(env: Env): Promise<PostsCountPayload> {
  const cached = parsePostsCountCached(await env.CLANKA_STATE.get(BLOG_POSTS_CACHE_KEY));
  if (cached !== null) return cached;

  const headers: Record<string, string> = {
    "User-Agent": "clanka-api/1.0",
    "Accept": "application/vnd.github.v3+json",
  };
  if (env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;

  try {
    const res = await fetch(BLOG_POSTS_LIST_URL, { headers });
    if (!res.ok) {
      return emptyPostsCount("github_unavailable");
    }

    const body = await res.json() as unknown;
    if (!Array.isArray(body)) {
      return emptyPostsCount("github_unavailable");
    }

    const names: string[] = [];
    for (const item of body) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const o = item as { type?: unknown; name?: unknown };
      if (o.type !== "file" || typeof o.name !== "string") continue;
      if (!POST_HTML_RE.test(o.name)) continue;
      names.push(o.name);
    }

    names.sort((a, b) => b.localeCompare(a));
    const count = names.length;
    const latest = count > 0 ? parsePostFilename(names[0]) : null;

    const payload: PostsCountPayload = {
      count,
      lastPost: count > 0 ? String(count).padStart(3, "0") : "000",
      lastPostDate: latest?.date ?? "",
      lastPostSlug: latest?.slug ?? "",
    };

    try {
      await env.CLANKA_STATE.put(BLOG_POSTS_CACHE_KEY, JSON.stringify(payload), {
        expirationTtl: BLOG_POSTS_TTL_SEC,
      });
    } catch {
      // ignore cache write failures
    }
    return {
      ...payload,
      available: true,
    };
  } catch {
    return emptyPostsCount("github_unavailable");
  }
}

function normalizeChangelogEntry(entry: unknown): ChangelogEntry | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const item = entry as {
    sha?: unknown;
    message?: unknown;
    author?: unknown;
    date?: unknown;
    commit?: {
      message?: unknown;
      author?: { name?: unknown; date?: unknown };
      committer?: { date?: unknown };
    };
  };

  const directSha = typeof item.sha === "string" ? item.sha.trim() : "";
  const directMessage = typeof item.message === "string" ? item.message : "";
  const directAuthor = typeof item.author === "string" ? item.author : "";
  const directDate = typeof item.date === "string" ? item.date : "";
  if (directSha && directMessage && directAuthor && directDate) {
    return {
      sha: directSha,
      message: directMessage,
      author: directAuthor,
      date: directDate,
    };
  }

  const commit = item.commit && typeof item.commit === "object" && !Array.isArray(item.commit)
    ? item.commit
    : undefined;
  const message = typeof commit?.message === "string" ? commit.message : "";
  const author = item.author && typeof item.author === "object" && !Array.isArray(item.author)
    && typeof (item.author as { login?: unknown }).login === "string"
    ? (item.author as { login: string }).login
    : typeof commit?.author?.name === "string"
      ? commit.author.name
      : "unknown";
  const date = typeof commit?.author?.date === "string"
    ? commit.author.date
    : typeof commit?.committer?.date === "string"
      ? commit.committer.date
      : new Date().toISOString();
  if (!directSha) return null;
  return {
    sha: directSha,
    message,
    author,
    date,
  };
}

function parseChangelogEntries(raw: string | null): ChangelogEntry[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed
      .slice(0, 10)
      .map((entry) => normalizeChangelogEntry(entry))
      .filter((entry): entry is ChangelogEntry => Boolean(entry));
  } catch {
    return null;
  }
}

export async function loadChangelog(env: Env): Promise<ChangelogEntry[]> {
  const cached = parseChangelogEntries(await env.CLANKA_STATE.get(CHANGELOG_CACHE_KEY));
  if (cached !== null) return cached;

  const headers: Record<string, string> = {
    "User-Agent": "clanka-api/1.0",
    "Accept": "application/vnd.github.v3+json",
  };
  if (env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;

  const res = await fetch(CHANGELOG_URL, { headers });
  if (!res.ok) return [];

  const body = await res.json() as unknown;
  if (!Array.isArray(body)) return [];

  const payload = body
    .slice(0, 10)
    .map((entry) => normalizeChangelogEntry(entry))
    .filter((entry): entry is ChangelogEntry => Boolean(entry));

  await env.CLANKA_STATE.put(CHANGELOG_CACHE_KEY, JSON.stringify(payload), {
    expirationTtl: CHANGELOG_TTL_SEC,
  });
  return payload;
}

export async function loadGithubStats(env: Env): Promise<GithubStatsPayload> {
  const cached = await env.CLANKA_STATE.get(GITHUB_STATS_CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached) as GithubStatsPayload;
    } catch { /* fall through */ }
  }

  const ghHeaders = {
    "User-Agent": "clanka-api/1.0",
    "Accept": "application/vnd.github.v3+json",
  };

  try {
    const [userRes, reposRes] = await Promise.all([
      fetch("https://api.github.com/users/clankamode", { headers: ghHeaders }),
      fetch("https://api.github.com/users/clankamode/repos?per_page=100&type=owner", { headers: ghHeaders }),
    ]);

    if (!userRes.ok && !reposRes.ok) {
      return {
        repoCount: 0,
        totalStars: 0,
        lastPushedAt: null,
        lastPushedRepo: null,
        cachedAt: new Date().toISOString(),
        available: false,
        error: "github_unavailable",
      };
    }

    type GhRepo = { stargazers_count: number; pushed_at: string; name: string };
    const repos: GhRepo[] = reposRes.ok ? (await reposRes.json() as GhRepo[]) : [];

    let repoCount = 0;
    if (userRes.ok) {
      const user = await userRes.json() as { public_repos?: number };
      repoCount = user.public_repos ?? repos.length;
    } else {
      repoCount = repos.length;
    }

    const totalStars = repos.reduce((sum, r) => sum + (r.stargazers_count ?? 0), 0);

    let lastPushedAt: string | null = null;
    let lastPushedRepo: string | null = null;
    for (const r of repos) {
      if (!lastPushedAt || r.pushed_at > lastPushedAt) {
        lastPushedAt = r.pushed_at;
        lastPushedRepo = r.name;
      }
    }

    const payload: GithubStatsPayload = {
      repoCount,
      totalStars,
      lastPushedAt,
      lastPushedRepo,
      cachedAt: new Date().toISOString(),
      available: true,
    };

    try {
      await env.CLANKA_STATE.put(GITHUB_STATS_CACHE_KEY, JSON.stringify(payload), { expirationTtl: GITHUB_STATS_TTL_SEC });
    } catch {
      // ignore cache write failures and still serve fresh data
    }
    return payload;
  } catch {
    return {
      repoCount: 0,
      totalStars: 0,
      lastPushedAt: null,
      lastPushedRepo: null,
      cachedAt: new Date().toISOString(),
      available: false,
      error: "github_unavailable",
    };
  }
}

type GhEvent = {
  type: string;
  repo: { name: string };
  created_at: string;
  payload: {
    commits?: { message: string }[];
    action?: string;
    pull_request?: { number: number; title: string };
    issue?: { number: number; title: string };
    ref_type?: string;
    ref?: string;
  };
};

const MESSAGE_MAX_LEN = 100;

function truncateMessage(message: string, maxLen = MESSAGE_MAX_LEN): string {
  if (message.length <= maxLen) return message;
  if (maxLen <= 3) return ".".repeat(maxLen);
  return `${message.slice(0, maxLen - 3)}...`;
}

export async function loadGithubEvents(kv: KVNamespace): Promise<GithubEvent[]> {
  const cached = await kv.get(GITHUB_EVENTS_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached) as GithubEvent[]; } catch { /* fall through */ }
  }

  try {
    const res = await fetch("https://api.github.com/users/clankamode/events?per_page=30", {
      headers: { "User-Agent": "clanka-api/1.0", "Accept": "application/vnd.github.v3+json" },
    });
    if (!res.ok) return [];

    const raw = (await res.json()) as GhEvent[];
    const allowed = new Set(["PushEvent", "CreateEvent", "PullRequestEvent", "IssuesEvent"]);
    const events: GithubEvent[] = [];

    for (const e of raw) {
      if (!allowed.has(e.type)) continue;
      const repo = e.repo.name.replace("clankamode/", "");
      let type = "EVENT";
      let message = "";

      if (e.type === "PushEvent") {
        type = "PUSH";
        const msg = e.payload.commits?.[0]?.message ?? "push";
        message = truncateMessage(msg.split("\n")[0]);
      } else if (e.type === "PullRequestEvent") {
        type = "PR";
        const pr = e.payload.pull_request;
        message = truncateMessage(`${e.payload.action} PR #${pr?.number}: ${pr?.title ?? ""}`);
      } else if (e.type === "IssuesEvent") {
        type = "ISSUE";
        const issue = e.payload.issue;
        message = truncateMessage(`${e.payload.action} issue #${issue?.number}: ${issue?.title ?? ""}`);
      } else if (e.type === "CreateEvent") {
        type = "CREATE";
        message = truncateMessage(`created ${e.payload.ref_type} ${e.payload.ref ?? ""}`.trim());
      }

      events.push({ type, repo, message, timestamp: e.created_at });
      if (events.length >= 15) break;
    }

    try {
      await kv.put(GITHUB_EVENTS_CACHE_KEY, JSON.stringify(events), { expirationTtl: GITHUB_EVENTS_TTL_SEC });
    } catch {
      // ignore cache write failures and still serve fresh data
    }
    return events;
  } catch {
    return [];
  }
}
