import type { Env, RepoTask, TaskPriority } from "./types";
import { decodeBase64 } from "./util";

export function parseOpenTasksMarkdown(markdown: string): RepoTask[] {
  const lines = markdown.split(/\r?\n/);
  const tasks: RepoTask[] = [];
  let currentPriority: TaskPriority | null = null;

  for (const line of lines) {
    if (line.includes("🔴")) {
      currentPriority = "red";
      continue;
    }
    if (line.includes("🟡")) {
      currentPriority = "yellow";
      continue;
    }
    if (line.includes("🟢")) {
      currentPriority = "green";
      continue;
    }

    const match = line.match(/^\s*-\s\[\s\]\s\*\*(.+?)\*\*\s*$/);
    if (match && currentPriority) {
      tasks.push({
        priority: currentPriority,
        text: match[1].trim(),
        done: false,
      });
    }
  }

  return tasks;
}

export async function loadRepoTasks(env: Env, repo: string): Promise<RepoTask[]> {
  const repoName = repo.startsWith("clankamode/") ? repo.slice("clankamode/".length) : repo;
  const url = `https://api.github.com/repos/clankamode/${repoName}/contents/TASKS.md`;
  const headers: Record<string, string> = {
    "User-Agent": "clanka-api/1.0",
    "Accept": "application/vnd.github.v3+json",
  };
  if (env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return [];
    const body = await res.json() as { content?: string };
    if (!body.content) return [];
    const markdown = decodeBase64(body.content);
    return parseOpenTasksMarkdown(markdown);
  } catch {
    return [];
  }
}
