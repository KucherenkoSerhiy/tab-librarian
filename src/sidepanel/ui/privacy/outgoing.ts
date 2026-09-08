// The "Before sending" step: what leaves (grouped by site), what is kept back
// and why, and the exact text that will be sent. Waits for Send / Cancel.
import type { Settings } from "../../../types";
import { showView } from "../../app/nav";
import { state } from "../../app/state";
import { parseExcludedDomains } from "../../domain/privacy";
import { domainOf, normalizeUrl } from "../../domain/urls";
import type { KeptBackItem, Outgoing, OutgoingItem, OutgoingScope } from "../../services/payload";
import { buildOutgoing } from "../../services/payload";
import { getSettings, saveSettings, setSessionState } from "../../services/storage";
import { $, makeIcon, showToast } from "../dom";

let outgoingResolve: ((send: boolean) => void) | null = null;
/** the set currently on screen; skips, exclusions and the library toggle rebuild it */
let current: Outgoing | null = null;
/** the scope the caller asked for, so unticking the library returns to it */
let requestedScope: OutgoingScope = "tabs";

/**
 * Show the payload and wait for Send/Cancel. Resolves with the set to send
 * (it may differ from the input: skips, exclusions, the library toggle), or
 * null on Cancel. Skipped when previews are off or the same set was already
 * approved in this session.
 */
export async function confirmOutgoing(outgoing: Outgoing, purpose: string): Promise<Outgoing | null> {
  const settings = await getSettings();
  if (!settings.previewOutgoing || outgoing.key === state.approvedOutgoingKey) return outgoing;
  requestedScope = outgoing.scope;
  renderOutgoing(outgoing, purpose, settings);
  showView("outgoing");
  const send = await new Promise<boolean>((resolve) => (outgoingResolve = resolve));
  outgoingResolve = null;
  const result = current ?? outgoing;
  current = null;
  if (send) {
    state.approvedOutgoingKey = result.key;
    await setSessionState("approvedOutgoingKey", state.approvedOutgoingKey);
  }
  showView("home");
  return send ? result : null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const REASON: Record<KeptBackItem["reason"], string> = {
  excluded: "excluded domain",
  private: "private network",
  skipped: "skipped for this conversation",
};

export function renderOutgoing(outgoing: Outgoing, purpose: string, settings: Settings): void {
  current = outgoing;
  let providerHost = "api.anthropic.com";
  if (settings.provider !== "anthropic") {
    try {
      providerHost = new URL(settings.baseUrl).host;
    } catch {
      providerHost = settings.baseUrl;
    }
  }
  const includeLibrary = outgoing.scope === "library";
  const parts = [plural(outgoing.tabs.length, "open tab")];
  if (includeLibrary) parts.push(plural(outgoing.bookmarks.length, "library bookmark"));
  parts.push(plural(outgoing.folderCount, "folder name"));
  $("outgoingSummary").textContent =
    `${purpose} will send ${parts.slice(0, -1).join(", ")} and ${parts.at(-1)} to ${providerHost}.` +
    (!includeLibrary && outgoing.libraryCount
      ? ` Your ${plural(outgoing.libraryCount, "library bookmark")} stay in the browser.`
      : "");
  ($("outgoingAskAgain") as HTMLInputElement).checked = settings.previewOutgoing;

  // the library goes only when the task needs it; the user can add or drop it here
  const libRow = $("outgoingLibraryRow");
  libRow.hidden = !outgoing.libraryCount;
  ($("outgoingIncludeLibrary") as HTMLInputElement).checked = includeLibrary;
  $("outgoingIncludeLibraryText").textContent =
    `Also send my ${plural(outgoingLibraryTotal(outgoing), "library bookmark")} — needed only to reorganize or clean up existing folders`;

  const rerender = async (scope: OutgoingScope = outgoing.scope) =>
    renderOutgoing(await buildOutgoing(scope), purpose, await getSettings());
  ($("outgoingIncludeLibrary") as HTMLInputElement).onchange = (e) =>
    void rerender((e.target as HTMLInputElement).checked ? "library" : requestedScope === "library" ? "tabs" : requestedScope);
  const skipUrls = async (urls: string[]) => {
    for (const u of urls) state.sessionExcludedUrls.add(normalizeUrl(u));
    await setSessionState("sessionExcludedUrls", [...state.sessionExcludedUrls]);
    await rerender();
  };
  const unskipUrls = async (urls: string[]) => {
    for (const u of urls) state.sessionExcludedUrls.delete(normalizeUrl(u));
    await setSessionState("sessionExcludedUrls", [...state.sessionExcludedUrls]);
    await rerender();
  };
  const excludeDomain = async (domain: string) => {
    const cur = await getSettings();
    const list = parseExcludedDomains(cur.excludedDomains);
    if (!list.includes(domain)) await saveSettings({ ...cur, excludedDomains: [...list, domain].join("\n") });
    showToast(`${domain} will never be sent`);
    await rerender();
  };
  // buttons inside a <summary> must not toggle the group
  const action = (cls: string, label: string, title: string, onClick: () => void) => {
    const b = document.createElement("button");
    b.className = cls;
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  };

  // ---- kept back: the proof that a rule applied, with the reason
  renderKeptBack(outgoing.keptBack, unskipUrls);

  // ---- sending: one group per site, expandable to every title + URL as sent
  const groups = new Map<string, OutgoingItem[]>();
  for (const item of [...outgoing.tabs, ...outgoing.bookmarks]) {
    const d = domainOf(item.realUrl);
    groups.set(d, [...(groups.get(d) ?? []), item]);
  }
  const groupsEl = $("outgoingGroups");
  groupsEl.replaceChildren();
  if (!groups.size) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = "Nothing to send.";
    groupsEl.appendChild(note);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  for (const [domain, items] of sorted) {
    const details = document.createElement("details");
    details.className = "og-group";
    const summary = document.createElement("summary");
    summary.appendChild(makeIcon(items[0]!.realUrl, 24));
    const name = document.createElement("span");
    name.className = "og-name";
    name.textContent = domain;
    const tabs = items.filter((i) => !i.folder).length;
    const bms = items.length - tabs;
    const count = document.createElement("span");
    count.className = "og-count";
    count.textContent = [tabs && plural(tabs, "tab"), bms && plural(bms, "bookmark")].filter(Boolean).join(" · ");
    summary.append(name, count);
    if (domain !== "local file") {
      summary.appendChild(action("add-btn", "🔒", `Never send ${domain} (adds it to Options → Privacy)`, () => void excludeDomain(domain)));
    }
    summary.appendChild(
      action("remove-btn", "✕", `Skip ${domain} for this conversation`, () => void skipUrls(items.map((i) => i.realUrl)))
    );
    details.appendChild(summary);
    for (const item of items) {
      const entry = document.createElement("div");
      entry.className = "og-entry";
      const text = document.createElement("div");
      text.className = "og-text";
      const title = document.createElement("div");
      title.className = "og-title";
      title.textContent = item.title + (item.folder ? `  ·  ${item.folder}` : "");
      const url = document.createElement("div");
      url.className = "sent-url";
      url.textContent = item.sentUrl;
      text.append(title, url);
      entry.appendChild(text);
      entry.appendChild(action("remove-btn", "✕", "Skip this one for this conversation", () => void skipUrls([item.realUrl])));
      details.appendChild(entry);
    }
    groupsEl.appendChild(details);
  }

  // ---- the literal text
  $("outgoingRaw").textContent = outgoing.text;
}

/** bookmarks the library toggle would add: what passes the rules, whether or not it is in this set */
function outgoingLibraryTotal(outgoing: Outgoing): number {
  return outgoing.scope === "library" ? outgoing.bookmarks.length : outgoing.libraryCount;
}

function renderKeptBack(items: KeptBackItem[], unskip: (urls: string[]) => Promise<void>): void {
  const section = $("outgoingKeptBack");
  const list = $("outgoingKeptList");
  list.replaceChildren();
  section.hidden = !items.length;
  if (!items.length) return;
  $("outgoingKeptTitle").textContent = `Kept back — ${plural(items.length, "item")} that will not be sent`;
  const byKey = new Map<string, KeptBackItem[]>();
  for (const it of items) {
    const key = `${domainOf(it.realUrl)}|${it.reason}`;
    byKey.set(key, [...(byKey.get(key) ?? []), it]);
  }
  for (const [, group] of byKey) {
    const first = group[0]!;
    const row = document.createElement("div");
    row.className = "kb-row";
    row.appendChild(makeIcon(first.realUrl, 24));
    const text = document.createElement("div");
    text.className = "og-text";
    const name = document.createElement("div");
    name.className = "og-title";
    name.textContent = `${domainOf(first.realUrl)} · ${plural(group.length, "item")}`;
    const reason = document.createElement("div");
    reason.className = "kb-reason";
    reason.textContent = REASON[first.reason];
    text.append(name, reason);
    row.appendChild(text);
    if (first.reason === "skipped") {
      const undo = document.createElement("button");
      undo.className = "add-btn";
      undo.textContent = "↺";
      undo.title = "Send after all";
      undo.addEventListener("click", () => void unskip(group.map((g) => g.realUrl)));
      row.appendChild(undo);
    }
    list.appendChild(row);
  }
}

export function wireOutgoing(): void {
  const decide = (send: boolean) => outgoingResolve?.(send);
  $("outgoingSendBtn").addEventListener("click", () => decide(true));
  $("outgoingCancelBtn").addEventListener("click", () => decide(false));
  $("outgoingBackBtn").addEventListener("click", () => decide(false));
  $("outgoingAskAgain").addEventListener("change", async (e) => {
    const on = (e.target as HTMLInputElement).checked;
    await saveSettings({ ...(await getSettings()), previewOutgoing: on });
  });
}
