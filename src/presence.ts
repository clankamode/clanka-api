import { HISTORY_LIMIT, STATUS_OFFLINE_THRESHOLD_MS } from "./config";
import type { HistoryEntry } from "./types";

/** Parse a positive epoch-ms timestamp; reject missing/zero/invalid values. */
export function parsePositiveEpochMs(raw: string | null | undefined): number | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * Resolve last-seen from heartbeat KV and optional presence.timestamp.
 * Returns null when we have no trustworthy signal (do not invent "now").
 */
export function resolveLastSeenMs(
  lastSeenRaw: string | null,
  presenceTimestamp?: number | null,
): number | null {
  const fromHeartbeat = parsePositiveEpochMs(lastSeenRaw);
  if (fromHeartbeat !== null) return fromHeartbeat;
  if (typeof presenceTimestamp === "number" && Number.isFinite(presenceTimestamp) && presenceTimestamp > 0) {
    return presenceTimestamp;
  }
  return null;
}

export function isOfflineFromLastSeen(lastSeenMs: number | null, now = Date.now()): boolean {
  if (lastSeenMs === null) return true;
  return now - lastSeenMs > STATUS_OFFLINE_THRESHOLD_MS;
}

/** Treat missing/zero started as "start now" so uptime is not epoch-sized. */
export function resolveStartedMs(startedRaw: string | null, now = Date.now()): number {
  const started = parsePositiveEpochMs(startedRaw);
  return started ?? now;
}

export function getStatusPayload(lastSeenRaw: string | null) {
  const lastSeen = parsePositiveEpochMs(lastSeenRaw);
  const now = Date.now();
  if (lastSeen === null || now - lastSeen > STATUS_OFFLINE_THRESHOLD_MS) {
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
  const lastSeen = parsePositiveEpochMs(lastSeenRaw);
  const now = Date.now();
  if (lastSeen === null || now - lastSeen > STATUS_OFFLINE_THRESHOLD_MS) {
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
