const absolute = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** A git ISO date for display, e.g. "Jan 1, 2026, 3:00 AM" (in the viewer's time zone). */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : absolute.format(date);
}

/** Today minus `days`, as `YYYY-MM-DD` in the viewer's time zone (for "last N days"). */
export function daysAgo(days: number, now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
