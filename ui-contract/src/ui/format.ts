const clockFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const minuteFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const dayFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const fullFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

export function parseTime(value: string | number | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/** Clock time for scanning a stream: 09:24:18. */
export function formatClock(value: string | number | Date | null | undefined): string {
  const time = parseTime(value);
  return time === null ? '—' : clockFormat.format(time);
}

/** Short absolute stamp for tooltips and inspectors: 10-22 09:24. */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const time = parseTime(value);
  return time === null ? '—' : dayFormat.format(time).replaceAll('/', '-');
}

export function formatFull(value: string | number | Date | null | undefined): string {
  const time = parseTime(value);
  return time === null ? '—' : fullFormat.format(time).replaceAll('/', '-');
}

/**
 * The product's most-read string: how long ago did this happen.
 * Falls back to a clock, a day, or a date as the distance grows.
 */
export function formatRelative(value: string | number | Date | null | undefined, at = Date.now()): string {
  const time = parseTime(value);
  if (time === null) return '—';
  const delta = at - time;
  if (delta < 0) return '刚刚';
  if (delta < 5_000) return '刚刚';
  if (delta < 60_000) return `${Math.floor(delta / 1000)} 秒前`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;

  const then = new Date(time);
  const now = new Date(at);
  const sameDay = then.getFullYear() === now.getFullYear() && then.getMonth() === now.getMonth() && then.getDate() === now.getDate();
  if (sameDay) return `今天 ${minuteFormat.format(time)}`;
  const yesterday = new Date(at);
  yesterday.setDate(now.getDate() - 1);
  if (then.getFullYear() === yesterday.getFullYear() && then.getMonth() === yesterday.getMonth() && then.getDate() === yesterday.getDate()) {
    return `昨天 ${minuteFormat.format(time)}`;
  }
  if (then.getFullYear() === now.getFullYear()) return dayFormat.format(time).replaceAll('/', '-');
  return fullFormat.format(time).replaceAll('/', '-');
}

/** Durations read as units a person waits in: 820 毫秒 / 1.2 秒 / 3 分 12 秒. */
export function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) return '—';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} 毫秒`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} 秒`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1000);
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

/** Instrument readings keep one decimal below 10 and none above: 0.97 ms / 12.4 ms. */
export function formatReading(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未提供';
  const text = value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : String(Math.round(value));
  return `${text} ${unit}`;
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return String(value);
  }
}

export function shortId(value: string, keep = 8): string {
  return value.length <= keep * 2 + 1 ? value : `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

export function plural(count: number, singular: string, pluralForm = singular): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
