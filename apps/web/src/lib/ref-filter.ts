/**
 * Whether a branch or tag name matches the filter typed on the Branches tab: a case-insensitive part of the
 * name. A blank filter matches every name.
 */
export function refMatches(entry: { name: string }, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === '' || entry.name.toLowerCase().includes(needle);
}
