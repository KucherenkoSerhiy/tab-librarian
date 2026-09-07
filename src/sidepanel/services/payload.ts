// What a provider call will carry, after the privacy rules are applied.
import type { Settings } from "../../types";
import type { OutgoingMap } from "../domain/privacy";
import { getManagedTree } from "./bookmarks";
import { on } from "../app/bus";
import { showView } from "../app/nav";
import { buildOutgoingMap, isExcludedUrl, isPrivateHost, outgoingKey, parseExcludedDomains, redactTitle } from "../domain/privacy";
import { state } from "../app/state";
import { getPlacements, getRemovals, getSettings, saveSettings, setSessionState } from "./storage";
import { getOpenTabs } from "./tabs";
import { normalizeUrl } from "../domain/urls";



export interface OutgoingItem {
  realUrl: string;
  sentUrl: string;
  /** title as it will be sent (redacted when the setting is on) */
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
    isExcludedUrl(url, excludedDomains) ||
    (settings.excludePrivateHosts && isPrivateHost(url)) ||
    state.sessionExcludedUrls.has(normalizeUrl(url));

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
  const sentTitle = (title: string) => (settings.stripQueryStrings ? redactTitle(title) : title);

  const payload = {
    openTabs: sentTabs.map((t) => ({
      title: sentTitle(t.title),
      url: sent(t.url),
      sorted: t.sorted,
      pinned: t.pinned || undefined,
    })),
    existingFolders: folders,
    existingBookmarks: bookmarks.map((b) => ({ ...b, title: sentTitle(b.title), url: sent(b.url) })),
    removedByUser: removedByUser.map((r) => ({ ...r, url: sent(r.url) })),
  };

  const tabItems = sentTabs.map((t) => ({ realUrl: t.url, sentUrl: sent(t.url), title: sentTitle(t.title) }));
  const bmItems = bookmarks.map((b) => ({ realUrl: b.url, sentUrl: sent(b.url), title: sentTitle(b.title), folder: b.folder }));
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

