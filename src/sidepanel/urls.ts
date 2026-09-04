/** Canonical form used as the key for placements and duplicate detection. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    let s = u.toString();
    if (u.pathname === "/" && !u.search && s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return raw;
  }
}

/** Only http(s) pages are sortable — skips chrome://, about:, extension pages, etc. */
export function isSortableUrl(url: string | undefined): url is string {
  return !!url && (url.startsWith("http://") || url.startsWith("https://"));
}
