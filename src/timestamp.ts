import type { ConversationTimestamp } from "./chatgpt-client.js";

const formatters = new Map<string, Intl.DateTimeFormat>();
const canonicalTimeZones = new Map<string, string>();

export function canonicalTimeZone(timeZone: string): string {
  const cached = canonicalTimeZones.get(timeZone);
  if (cached) return cached;
  const canonical = new Intl.DateTimeFormat("en-US", { timeZone })
    .resolvedOptions()
    .timeZone;
  canonicalTimeZones.set(timeZone, canonical);
  return canonical;
}

function timestampMilliseconds(
  timestamp: ConversationTimestamp | undefined,
): number | null {
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (timestamp == null || !Number.isFinite(timestamp)) return null;
  // ChatGPT sometimes returns seconds, sometimes milliseconds.
  return timestamp > 1e12 ? timestamp : timestamp * 1000;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-CA-u-ca-iso8601", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
    timeZoneName: "longOffset",
  });
  formatters.set(timeZone, formatter);
  return formatter;
}

function part(
  parts: ReadonlyMap<Intl.DateTimeFormatPartTypes, string>,
  type: Intl.DateTimeFormatPartTypes,
): string {
  const value = parts.get(type);
  if (value === undefined) {
    throw new Error(`Intl formatter omitted ${type}`);
  }
  return value;
}

export function formatTimestamp(
  timestamp: ConversationTimestamp | undefined,
  requestedTimeZone: string,
): string | null {
  const milliseconds = timestampMilliseconds(timestamp);
  if (milliseconds === null) return null;

  try {
    const date = new Date(milliseconds);
    const timeZone = canonicalTimeZone(requestedTimeZone);
    if (timeZone === "UTC") return date.toISOString();

    const parts = new Map(
      formatterFor(timeZone)
        .formatToParts(date)
        .filter(({ type }) => type !== "literal")
        .map(({ type, value }) => [type, value]),
    );
    const zoneName = part(parts, "timeZoneName");
    const offset =
      zoneName === "GMT" || zoneName === "UTC"
        ? "+00:00"
        : zoneName.replace(/^GMT/, "");
    if (!/^[+-]\d{2}:\d{2}$/.test(offset)) {
      throw new Error(`Unsupported UTC offset: ${zoneName}`);
    }

    return (
      `${part(parts, "year").padStart(4, "0")}-` +
      `${part(parts, "month")}-${part(parts, "day")}T` +
      `${part(parts, "hour")}:${part(parts, "minute")}:` +
      `${part(parts, "second")}.${part(parts, "fractionalSecond")}` +
      offset
    );
  } catch {
    return null;
  }
}
