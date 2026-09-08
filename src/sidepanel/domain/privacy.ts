// What leaves the browser, and how it comes back.
//
// Every provider call carries tab/bookmark titles and URLs. These helpers let
// the user (1) keep whole domains out of that payload, (2) strip query strings
// and fragments before sending, and (3) map the shortened URLs the model
// echoes back to the real ones so proposals still resolve to actual tabs.
import type { Proposal } from "../../types";

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ID = /^[0-9a-f]{12,}$/i; // hashes, chat/session ids (9f8e7d6c5b4a3210); needs a digit
const HEX_GROUPS = /^[0-9a-f]{4,}(?:-[0-9a-f]{4,})+$/i; // billing accounts, license keys (01A2B3-C4D5E6-F78901)
const DIGIT_RUN = /\d{6,}/; // numeric ids anywhere in the segment: 524289, runs/12345678901, quiet-lake-12345678
const JWT = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
const OPAQUE = /^[A-Za-z0-9_-]{24,}$/; // base64url-ish; must also mix digits and both cases

/**
 * A path segment that reads as an identifier rather than a word. Identifiers
 * carry no signal for filing (the title does) and often name an account, a
 * document, a session or a person, so they are masked when redaction is on.
 */
export function looksLikeToken(segment: string): boolean {
  if (UUID.test(segment) || JWT.test(segment) || DIGIT_RUN.test(segment)) return true;
  if ((HEX_ID.test(segment) || HEX_GROUPS.test(segment)) && /\d/.test(segment)) return true;
  return OPAQUE.test(segment) && /\d/.test(segment) && /[a-z]/.test(segment) && /[A-Z]/.test(segment);
}

/**
 * Hosts where the subdomain is the customer's name (employer, client, team).
 * `acme.atlassian.net` says who you work for; `~.atlassian.net` still says
 * "a Jira/Confluence page", which is all the model needs.
 */
const TENANT_HOSTS = [
  "atlassian.net",
  "slack.com",
  "zendesk.com",
  "okta.com",
  "sharepoint.com",
  "onmicrosoft.com",
  "service-now.com",
  "freshdesk.com",
  "monday.com",
  "bamboohr.com",
  "workable.com",
  "notion.site",
  "myshopify.com",
  "salesforce.com",
  "force.com",
  "auth0.com",
  "zoom.us",
];

export function tenantHostOf(hostname: string): string | undefined {
  const h = hostname.toLowerCase();
  return TENANT_HOSTS.find((t) => h.endsWith(`.${t}`));
}

/**
 * The URL as it may leave the browser. Credentials (user:pass@) always go.
 * With `strip`, the query string, the fragment and token-like path segments go
 * too — the model classifies on the title and the readable part of the path.
 * Local files keep only their file name (a path such as C:/Users/<you>/…
 * names you and your disk layout); tenant subdomains become `~`.
 */
export function redactUrlForSending(url: string, strip: boolean): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    if (!strip) return u.toString();
    if (u.protocol === "file:") return `file:///~/${u.pathname.split("/").pop() ?? ""}`;
    u.search = "";
    u.hash = "";
    u.pathname = u.pathname
      .split("/")
      .map((seg) => (looksLikeToken(safeDecode(seg)) ? "~" : seg))
      .join("/");
    const tenant = tenantHostOf(u.hostname);
    return tenant ? u.toString().replace(`//${u.host}`, `//~.${tenant}`) : u.toString();
  } catch {
    return url;
  }
}

function safeDecode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const LONG_NUMBER = /\d(?:[ -]?\d){8,}/g; // 9+ digits, optionally grouped: cards, accounts, phones

/** Titles carry names, emails and account numbers surprisingly often. */
export function redactTitle(title: string): string {
  return title.replace(EMAIL, "[email]").replace(LONG_NUMBER, "[number]");
}

function isPrivateIp(host: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
}

/** localhost, private IP ranges, .local/.internal/.lan/.corp and bare intranet names. */
export function isPrivateHost(url: string): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return false; // governed by the local-files setting
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || isPrivateIp(host)) return true;
  if (/\.(local|internal|lan|home|corp|intranet)$/.test(host)) return true;
  return !host.includes("."); // bare names only resolve on a LAN
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
    const base = redactUrlForSending(real, strip);
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
