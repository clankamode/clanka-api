export function decodeBase64(value: string): string {
  const normalized = value.replace(/\n/g, "");
  if (typeof atob === "function") {
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(normalized, "base64").toString("utf8");
}

export function safeParseJSON<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
