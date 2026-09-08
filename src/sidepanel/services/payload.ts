// What a provider call will carry, after the privacy rules are applied.
//
// Data minimization: sorting needs the open tabs and the *shape* of the
// library (folder paths, sizes, notes) — not every bookmark. The library
// itself goes only when the task needs it (cleanup, recall) or the user ticks
// "also send library bookmarks" in the Before-sending step.
import type { OutgoingMap } from "../domain/privacy";
import { state } from "../app/state";
import {
  buildOutgoingMap,
  isExcludedUrl,
  isPrivateHost,
  outgoingKey,
  parseExcludedDomains,
  redactTitle,
} from "../domain/privacy";
import { normalizeUrl } from "../domain/urls";
import { getManagedTree } from "./bookmarks";
import { getFolderNotes, getPlacements, getRemovals, getSettings } from "./storage";
import { getOpenTabs } from "./tabs";

/**
 * unsorted — open tabs not yet in the library + folder summaries
 * tabs     — every open tab + folder summaries
 * library  — every open tab + every library bookmark (cleanup, recall)
 */
export type OutgoingScope = "unsorted" | "tabs" | "library";

export interface OutgoingItem {
  realUrl: string;
  sentUrl: string;
  /** title as it will be sent (redacted when the setting is on) */
  title: string;
  folder?: string;
}

/** An item a privacy rule kept out of the payload, and which rule. */
export interface KeptBackItem {
  realUrl: string;
  title: string;
  reason: "excluded" | "private" | "skipped";
}

/** Everything a provider call will carry, after the privacy rules are applied. */
export interface Outgoing {
  scope: OutgoingScope;
  /** the literal CURRENT STATE block appended to the user message */
  text: string;
  tabs: OutgoingItem[];
  /** empty unless scope is "library" */
  bookmarks: OutgoingItem[];
  folderCount: number;
  /** bookmarks that would go under scope "library" (after the privacy rules) */
  libraryCount: number;
  keptBack: KeptBackItem[];
  map: OutgoingMap;
  key: string;
}

interface FolderSummary {
  path: string;
  bookmarks: number;
  note?: string;
}

export async function buildOutgoing(scope: OutgoingScope): Promise<Outgoing> {
  const [settings, tree, placements, removals, notes, tabs] = await Promise.all([
    getSettings(),
    getManagedTree(),
    getPlacements(),
    getRemovals(),
    getFolderNotes(),
    getOpenTabs(),
  ]);
  const excludedDomains = parseExcludedDomains(settings.excludedDomains);
  const keptBack: KeptBackItem[] = [];
  const includeLibrary = scope === "library";
  const ruleFor = (url: string): KeptBackItem["reason"] | null =>
    isExcludedUrl(url, excludedDomains)
      ? "excluded"
      : settings.excludePrivateHosts && isPrivateHost(url)
        ? "private"
        : state.sessionExcludedUrls.has(normalizeUrl(url))
          ? "skipped"
          : null;
  /** true when a rule keeps the item out; recorded only for items that were candidates to go */
  const skip = (url: string, title: string, candidate: boolean): boolean => {
    const reason = ruleFor(url);
    if (reason && candidate) keptBack.push({ realUrl: url, title, reason });
    return reason !== null;
  };

  const folders: FolderSummary[] = [];
  const bookmarks: { url: string; title: string; folder: string; source: string; addedDaysAgo?: number }[] = [];
  const walk = (node: chrome.bookmarks.BookmarkTreeNode, path: string[]): number => {
    let count = 0;
    for (const child of node.children ?? []) {
      if (child.url) {
        count++;
        if (skip(child.url, child.title, includeLibrary)) continue;
        const key = normalizeUrl(child.url);
        bookmarks.push({
          url: child.url,
          title: child.title,
          folder: path.join("/") || "(root)",
          source: placements[key]?.source ?? "manual",
          addedDaysAgo: child.dateAdded ? Math.round((Date.now() - child.dateAdded) / 86_400_000) : undefined,
        });
      } else {
        const entry: FolderSummary = { path: [...path, child.title].join("/"), bookmarks: 0 };
        if (notes[child.id]) entry.note = notes[child.id];
        folders.push(entry);
        entry.bookmarks = walk(child, [...path, child.title]);
      }
    }
    return count;
  };
  walk(tree, []);

  const candidateTabs = scope === "unsorted" ? tabs.filter((t) => !t.sorted) : tabs;
  const sentTabs = candidateTabs.filter((t) => !skip(t.url, t.title, true));
  const sentBookmarks = includeLibrary ? bookmarks : [];
  // "removed by user" only matters for URLs the model is about to place again
  const sentKeys = new Set([...sentTabs, ...sentBookmarks].map((i) => normalizeUrl(i.url)));
  const removedByUser = Object.entries(removals)
    .filter(([url]) => sentKeys.has(normalizeUrl(url)))
    .map(([url, r]) => ({ url, removedFromFolder: r.folderPath }));

  const map = buildOutgoingMap(
    [...sentTabs.map((t) => t.url), ...sentBookmarks.map((b) => b.url), ...removedByUser.map((r) => r.url)],
    settings.stripQueryStrings
  );
  const sent = (url: string) => map.sentFor.get(url) ?? url;
  const sentTitle = (title: string) => (settings.stripQueryStrings ? redactTitle(title) : title);

  const payload: Record<string, unknown> = {
    openTabs: sentTabs.map((t) => ({
      title: sentTitle(t.title),
      url: sent(t.url),
      sorted: t.sorted,
      pinned: t.pinned || undefined,
    })),
    existingFolders: folders,
  };
  if (includeLibrary) {
    payload.existingBookmarks = bookmarks.map((b) => ({ ...b, title: sentTitle(b.title), url: sent(b.url) }));
  }
  payload.removedByUser = removedByUser.map((r) => ({ ...r, url: sent(r.url) }));

  const tabItems = sentTabs.map((t) => ({ realUrl: t.url, sentUrl: sent(t.url), title: sentTitle(t.title) }));
  const bmItems = sentBookmarks.map((b) => ({
    realUrl: b.url,
    sentUrl: sent(b.url),
    title: sentTitle(b.title),
    folder: b.folder,
  }));
  return {
    scope,
    text: `<CURRENT STATE>\n${JSON.stringify(payload, null, 2)}\n</CURRENT STATE>`,
    tabs: tabItems,
    bookmarks: bmItems,
    folderCount: folders.length,
    libraryCount: bookmarks.length,
    keptBack,
    map,
    key: outgoingKey([...tabItems, ...bmItems].map((i) => i.sentUrl)),
  };
}
