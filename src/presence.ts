import { HISTORY_LIMIT, STATUS_OFFLINE_THRESHOLD_MS } from "./config";
import type { HistoryEntry } from "./types";

export function getStatusPayload(lastSeenRaw: string | null) {
  const lastSeen = typeof lastSeenRaw === "string" ? Number(lastSeenRaw) : NaN;
  const now = Date.now();
  if (!Number.isFinite(lastSeen) || now - lastSeen > STATUS_OFFLINE_THRESHOLD_MS) {
    return { status: "offline" };
  }

  return {
    status: "operational",
    timestamp: new Date().toISOString(),
    signal: "⚡",
    last_seen: new Date(lastSeen).toISOString(),
  };
}

export function getStatusUptimePayload(lastSeenRaw: string | null) {
  const lastSeen = typeof lastSeenRaw === "string" ? Number(lastSeenRaw) : NaN;
  const now = Date.now();
  if (!Number.isFinite(lastSeen) || now - lastSeen > STATUS_OFFLINE_THRESHOLD_MS) {
    return {
      status: "offline",
      uptime_ms: 0,
      last_seen: null,
    };
  }

  return {
    status: "operational",
    uptime_ms: Math.max(0, now - lastSeen),
    last_seen: new Date(lastSeen).toISOString(),
  };
}

export function makeHistoryHash(timestamp: number): string {
  return Math.floor(timestamp).toString(16).slice(-8);
}

export function toHistoryEntry(value: unknown, fallbackTimestamp: number): HistoryEntry {
  if (!value || typeof value !== "object") {
    const ts = fallbackTimestamp;
    return { timestamp: ts, desc: "activity", type: "event", hash: makeHistoryHash(ts) };
  }

  const item = value as Record<string, unknown>;
  const tsRaw = item.timestamp;
  const timestamp = typeof tsRaw === "number" && Number.isFinite(tsRaw) ? tsRaw : fallbackTimestamp;
  const desc = typeof item.desc === "string"
    ? item.desc
    : typeof item.message === "string"
      ? item.message
      : "activity";
  const type = typeof item.type === "string" ? item.type : "event";
  const hash = typeof item.hash === "string" && item.hash.length > 0 ? item.hash : makeHistoryHash(timestamp);

  return { timestamp, desc, type, hash };
}

export function normalizeHistory(history: unknown): HistoryEntry[] {
  if (!Array.isArray(history)) return [];
  return history
    .slice(0, HISTORY_LIMIT)
    .map((entry, index) => toHistoryEntry(entry, Date.now() - index));
}

export function countActiveAgents(team: unknown): number {
  if (!team || typeof team !== "object") return 0;

  if (Array.isArray(team)) {
    return team.reduce((count, member) => {
      if (member && typeof member === "object" && (member as { status?: unknown }).status === "active") {
        return count + 1;
      }
      return count;
    }, 0);
  }

  return Object.values(team as Record<string, unknown>).reduce((count, member) => {
    if (member === "active") return count + 1;
    if (member && typeof member === "object" && (member as { status?: unknown }).status === "active") {
      return count + 1;
    }
    return count;
  }, 0);
}
