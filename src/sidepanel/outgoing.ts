// What a provider call will carry, after the privacy rules, and the
// "Before sending" preview that shows it.
import type { Settings } from "../types";
import type { OutgoingMap } from "./privacy";
import { getManagedTree } from "./bookmarks";
import { on } from "./bus";
import { $, domainOf, makeIcon, showToast } from "./dom";
import { showView } from "./nav";
import { buildOutgoingMap, isExcludedUrl, outgoingKey, parseExcludedDomains } from "./privacy";
import { state } from "./state";
import { getPlacements, getRemovals, getSettings, saveSettings, setSessionState } from "./storage";
import { getOpenTabs } from "./tabs";
import { normalizeUrl } from "./urls";

export interface OutgoingItem {
  realUrl: string;
  sentUrl: string;
  title: string;
  folder?: string;
}

/** Everything a provider call will carry, after the privacy rules are applied. */
export interface Outgoing {
  text: string;
  tabs: OutgoingItem[];
  bookmarks: OutgoingItem[];
  folderCount: number;
  excludedCount: number;
  map: OutgoingMap;
  key: string;
}

export async function buildOutgoing(): Promise<Outgoing> {
  const [settings, tree, placements, removals, tabs] = await Promise.all([
    getSettings(),
    getManagedTree(),
    getPlacements(),
    getRemovals(),
    getOpenTabs(),
  ]);
  const excludedDomains = parseExcludedDomains(settings.excludedDomains);
  const skip = (url: string) =>
    isExcludedUrl(url, excludedDomains) || state.sessionExcludedUrls.has(normalizeUrl(url));

  const folders: string[] = [];
  const bookmarks: {
    url: string;
    title: string;
    folder: string;
    source: string;
    addedDaysAgo?: number;
  }[] = [];
  let excludedCount = 0;
  const walk = (node: chrome.bookmarks.BookmarkTreeNode, path: string[]) => {
    for (const child of node.children ?? []) {
      if (child.url) {
        if (skip(child.url)) {
          excludedCount++;
          continue;
        }
        const key = normalizeUrl(child.url);
        bookmarks.push({
          url: child.url,
          title: child.title,
          folder: path.join("/") || "(root)",
          source: placements[key]?.source ?? "manual",
          addedDaysAgo: child.dateAdded
            ? Math.round((Date.now() - child.dateAdded) / 86_400_000)
            : undefined,
        });
      } else {
        folders.push([...path, child.title].join("/"));
        walk(child, [...path, child.title]);
      }
    }
  };
  walk(tree, []);

  const sentTabs = tabs.filter((t) => {
    if (skip(t.url)) {
      excludedCount++;
      return false;
    }
    return true;
  });
  const removedByUser = Object.entries(removals)
    .filter(([url]) => !skip(url))
    .map(([url, r]) => ({ url, removedFromFolder: r.folderPath }));

  const map = buildOutgoingMap(
    [...sentTabs.map((t) => t.url), ...bookmarks.map((b) => b.url), ...removedByUser.map((r) => r.url)],
    settings.stripQueryStrings
  );
  const sent = (url: string) => map.sentFor.get(url) ?? url;

  const payload = {
    openTabs: sentTabs.map((t) => ({
      title: t.title,
      url: sent(t.url),
      sorted: t.sorted,
      pinned: t.pinned || undefined,
    })),
    existingFolders: folders,
    existingBookmarks: bookmarks.map((b) => ({ ...b, url: sent(b.url) })),
    removedByUser: removedByUser.map((r) => ({ ...r, url: sent(r.url) })),
  };

  const tabItems = sentTabs.map((t) => ({ realUrl: t.url, sentUrl: sent(t.url), title: t.title }));
  const bmItems = bookmarks.map((b) => ({ realUrl: b.url, sentUrl: sent(b.url), title: b.title, folder: b.folder }));
  return {
    text: `<CURRENT STATE>\n${JSON.stringify(payload, null, 1)}\n</CURRENT STATE>`,
    tabs: tabItems,
    bookmarks: bmItems,
    folderCount: folders.length,
    excludedCount,
    map,
    key: outgoingKey([...tabItems, ...bmItems].map((i) => i.sentUrl)),
  };
}

// ---------- privacy preview ("before sending") ----------

let outgoingResolve: ((send: boolean) => void) | null = null;

/**
 * Show the exact payload and wait for Send/Cancel. Skipped when previews are
 * off or the same set was already approved in this session.
 */
export async function confirmOutgoing(outgoing: Outgoing, purpose: string): Promise<boolean> {
  const settings = await getSettings();
  if (!settings.previewOutgoing || outgoing.key === state.approvedOutgoingKey) return true;
  renderOutgoing(outgoing, purpose, settings);
  showView("outgoing");
  const send = await new Promise<boolean>((resolve) => (outgoingResolve = resolve));
  outgoingResolve = null;
  if (send) {
    state.approvedOutgoingKey = outgoing.key;
    await setSessionState("approvedOutgoingKey", state.approvedOutgoingKey);
  }
  showView("home");
  return send;
}

export function renderOutgoing(outgoing: Outgoing, purpose: string, settings: Settings): void {
  let providerHost = "api.anthropic.com";
  if (settings.provider !== "anthropic") {
    try {
      providerHost = new URL(settings.baseUrl).host;
    } catch {
      providerHost = settings.baseUrl;
    }
  }
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  $("outgoingSummary").textContent =
    `${purpose} will send ${plural(outgoing.tabs.length, "open tab")}, ${plural(outgoing.bookmarks.length, "bookmark")} ` +
    `and ${plural(outgoing.folderCount, "folder name")} to ${providerHost}` +
    (outgoing.excludedCount ? ` \u00b7 ${outgoing.excludedCount} kept back by your privacy rules` : "") +
    ".";
  ($("outgoingAskAgain") as HTMLInputElement).checked = settings.previewOutgoing;
  $("outgoingLibraryTitle").textContent = `Library: ${plural(outgoing.bookmarks.length, "bookmark")} (titles + URLs)`;
  ($("outgoingLibrary") as HTMLDetailsElement).open =
    outgoing.bookmarks.length > 0 && outgoing.bookmarks.length <= 12;

  const rerender = async () => {
    const fresh = await buildOutgoing();
    renderOutgoing(fresh, purpose, await getSettings());
  };
  const makeRow = (item: OutgoingItem) => {
    const row = document.createElement("div");
    row.className = "tab-row";
    row.appendChild(makeIcon(item.realUrl));
    const text = document.createElement("div");
    text.className = "tab-text";
    const title = document.createElement("div");
    title.className = "tab-title";
    title.textContent = item.title + (item.folder ? `  \u00b7  ${item.folder}` : "");
    const url = document.createElement("div");
    url.className = "sent-url";
    url.textContent = item.sentUrl;
    url.title = item.sentUrl === item.realUrl ? item.realUrl : `Sent as shown. Real URL: ${item.realUrl}`;
    text.append(title, url);
    row.appendChild(text);

    const lock = document.createElement("button");
    lock.className = "add-btn";
    lock.textContent = "🔒";
    lock.title = `Never send ${domainOf(item.realUrl)} (adds it to Options \u2192 Privacy)`;
    lock.addEventListener("click", async () => {
      const cur = await getSettings();
      const d = domainOf(item.realUrl);
      const list = parseExcludedDomains(cur.excludedDomains);
      if (!list.includes(d)) await saveSettings({ ...cur, excludedDomains: [...list, d].join("\n") });
      showToast(`${d} will never be sent`);
      await rerender();
    });
    row.appendChild(lock);

    const skipBtn = document.createElement("button");
    skipBtn.className = "remove-btn";
    skipBtn.textContent = "\u2715";
    skipBtn.title = "Don't send this one (for this conversation)";
    skipBtn.addEventListener("click", async () => {
      state.sessionExcludedUrls.add(normalizeUrl(item.realUrl));
      await setSessionState("sessionExcludedUrls", [...state.sessionExcludedUrls]);
      await rerender();
    });
    row.appendChild(skipBtn);
    return row;
  };

  const tabsEl = $("outgoingTabs");
  tabsEl.replaceChildren();
  if (!outgoing.tabs.length) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = "No open tabs will be sent.";
    tabsEl.appendChild(note);
  }
  for (const item of outgoing.tabs) tabsEl.appendChild(makeRow(item));
  const bmEl = $("outgoingBookmarks");
  bmEl.replaceChildren();
  for (const item of outgoing.bookmarks) bmEl.appendChild(makeRow(item));
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
