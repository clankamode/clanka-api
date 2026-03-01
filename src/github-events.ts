// GitHub events fetcher

export type GithubEvent = {
  type: string;
  repo: string;
  message: string;
  timestamp: string;
};

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

const GITHUB_EVENTS_CACHE_KEY = "github:events:v1";
const GITHUB_EVENTS_TTL_SEC = 900;
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

  await kv.put(GITHUB_EVENTS_CACHE_KEY, JSON.stringify(events), { expirationTtl: GITHUB_EVENTS_TTL_SEC });
  return events;
}
