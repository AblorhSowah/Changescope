/**
 * Formatting of timestamps handed in by the injected clock. Nothing here reads the time:
 * `Intl.DateTimeFormat` only converts a given millisecond value to local calendar fields.
 */

let localFormat: Intl.DateTimeFormat | undefined;

function pad(n: number, width = 2): string {
  return String(Math.trunc(Math.abs(n))).padStart(width, '0');
}

/** "YYYY-MM-DD HH:mm" in the local time zone; '' when `ms` is not a usable timestamp. */
export function formatLocalMinute(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  try {
    localFormat ??= new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts: Record<string, string> = {};
    for (const p of localFormat.formatToParts(ms)) parts[p.type] = p.value;
    const { year, month, day, hour, minute } = parts;
    if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined) return '';
    return `${year}-${month}-${day} ${hour}:${minute}`;
  } catch {
    return '';
  }
}

/** "YYYY-MM-DDTHH:mm:ss.sssZ" (UTC), computed arithmetically; '' when `ms` is not a usable timestamp. */
export function toIsoUtc(ms: number): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return '';
  const whole = Math.floor(ms);
  const days = Math.floor(whole / 86_400_000);
  const rest = whole - days * 86_400_000;
  // civil-from-days (proleptic Gregorian), day 0 = 1970-01-01
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  const h = Math.floor(rest / 3_600_000);
  const m = Math.floor((rest % 3_600_000) / 60_000);
  const s = Math.floor((rest % 60_000) / 1000);
  const milli = rest % 1000;
  const y = year >= 0 && year <= 9999 ? pad(year, 4) : `${year < 0 ? '-' : '+'}${pad(year, 6)}`;
  return `${y}-${pad(month)}-${pad(day)}T${pad(h)}:${pad(m)}:${pad(s)}.${pad(milli, 3)}Z`;
}

/** "45 s", "12 min", "1 h 5 min", "2 d 3 h"; negative and non-finite values count as 0. */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}
