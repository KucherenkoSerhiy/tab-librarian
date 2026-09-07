// What leaves the browser, and how it comes back.
//
// Every provider call carries tab/bookmark titles and URLs. These helpers let
// the user (1) keep whole domains out of that payload, (2) strip query strings
// and fragments before sending, and (3) map the shortened URLs the model
// echoes back to the real ones so proposals still resolve to actual tabs.
import type { Proposal } from "../types";

/** "bank.example.com, mail.google.com" / one per line → lowercase host list. */
export function parseExcludedDomains(text: string): string[] {
  return text
    .split(/[\n,;\s]+/)
    .map((s) =>
      s
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/[/?#].*$/, "")
    )
    .filter(Boolean);
}

/** True when the URL's host is one of the domains or a subdomain of one. */
export function isExcludedUrl(url: string, domains: string[]): boolean {
  if (!domains.length) return false;
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return domains.includes("file");
    host = u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Drop ?query and #fragment — the parts that tend to carry tokens, ids and search terms. */
export function sanitizeUrlForSending(url: string, strip: boolean): string {
  if (!strip) return url;
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

export interface OutgoingMap {
  /** real URL → URL as sent */
  sentFor: Map<string, string>;
  /** URL as sent → real URL */
  realFor: Map<string, string>;
}

/**
 * Deterministic: the same set of real URLs always yields the same sent URLs
 * (so the model sees stable identifiers across turns). Two real URLs that
 * collapse to one sanitized form get a `#2`, `#3`… suffix — meaningless to
 * the model, but unique, and it maps straight back.
 */
export function buildOutgoingMap(realUrls: Iterable<string>, strip: boolean): OutgoingMap {
  const sentFor = new Map<string, string>();
  const realFor = new Map<string, string>();
  for (const real of [...new Set(realUrls)].sort()) {
    const base = sanitizeUrlForSending(real, strip);
    let sent = base;
    for (let n = 2; realFor.has(sent); n++) sent = `${base}#${n}`;
    sentFor.set(real, sent);
    realFor.set(sent, real);
  }
  return { sentFor, realFor };
}

export function realUrlOf(sent: string, map: OutgoingMap): string {
  return map.realFor.get(sent) ?? map.realFor.get(sent.replace(/\/$/, "")) ?? sent;
}

/** Rewrite every URL the model returned to the real URL it stood for. */
export function mapProposalBack(proposal: Proposal, map: OutgoingMap): Proposal {
  return {
    folders: proposal.folders.map((f) => ({
      ...f,
      tabs: f.tabs.map((t) => ({ ...t, url: realUrlOf(t.url, map) })),
    })),
    questions: proposal.questions.map((q) => ({ ...q, url: realUrlOf(q.url, map) })),
    removals: proposal.removals.map((r) => ({ ...r, url: realUrlOf(r.url, map) })),
  };
}

/** Stable fingerprint of an outgoing set, so an approved payload isn't re-asked. */
export function outgoingKey(sentUrls: Iterable<string>): string {
  const list = [...sentUrls].sort();
  const s = list.join("\n");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${(h >>> 0).toString(16)}:${list.length}`;
}
