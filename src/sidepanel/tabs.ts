// Open-tab access and tab actions (close safely, reopen, focus).
import type { OpenTabInfo } from "../types";
import { on, requestRefresh } from "./bus";
import { $, showToast } from "./dom";
import { isExcludedUrl, parseExcludedDomains } from "./privacy";
import { state } from "./state";
import { getPlacements, getSettings } from "./storage";
import { isLocalFileUrl, isSortableUrl, normalizeUrl } from "./urls";

// ---------- data helpers ----------

export async function getOpenTabs(): Promise<OpenTabInfo[]> {
  const settings = await getSettings();
  const tabs = await chrome.tabs.query(settings.includeAllWindows ? {} : { currentWindow: true });
  const placements = await getPlacements();
  const excludedDomains = parseExcludedDomains(settings.excludedDomains);
  return tabs
    .map((t) => ({
      tab: t,
      // tabs not yet loaded since browser restart have url === "" and the real
      // address in pendingUrl — without this they'd be invisible to the panel
      url: t.url || t.pendingUrl || "",
    }))
    .filter(
      ({ tab, url }) =>
        isSortableUrl(url) &&
        tab.id !== undefined &&
        (settings.includeLocalFiles || !isLocalFileUrl(url))
    )
    .map(({ tab, url }) => {
      state.lastKnownTabs.set(tab.id!, { url, title: tab.title || url });
      return {
        tabId: tab.id!,
        windowId: tab.windowId,
        title: tab.title || url,
        url,
        pinned: tab.pinned,
        sorted: normalizeUrl(url) in placements,
        excluded: isExcludedUrl(url, excludedDomains) || undefined,
      };
    });
}


export async function closeTabsSafely(tabIds: number[]): Promise<void> {
  if (!tabIds.length) return;
  const closing = new Set(tabIds);
  const allTabs = await chrome.tabs.query({});
  const byWindow = new Map<number, { total: number; toClose: number }>();
  for (const tab of allTabs) {
    if (tab.id === undefined) continue;
    const stat = byWindow.get(tab.windowId) ?? { total: 0, toClose: 0 };
    stat.total++;
    if (closing.has(tab.id)) stat.toClose++;
    byWindow.set(tab.windowId, stat);
  }
  for (const [windowId, stat] of byWindow) {
    if (stat.total > 0 && stat.toClose >= stat.total) {
      await chrome.tabs.create({ windowId, active: true }).catch(() => {});
    }
  }
  await chrome.tabs.remove(tabIds);
}

/** Undo helper for closed tabs; local files can be blocked by the browser. */
export async function reopenTabs(urls: string[]): Promise<void> {
  let blocked = 0;
  for (const url of urls) {
    try {
      await chrome.tabs.create({ url, active: false });
    } catch {
      blocked++;
    }
  }
  if (blocked) {
    showToast(`${blocked} local file tab(s) couldn't reopen — needs “Allow access to file URLs”`);
  }
}

/** Jump to the already-open tab for this URL, or open it fresh. */
export async function openOrFocusTab(url: string): Promise<void> {
  const tabs = await getOpenTabs();
  const existing = tabs.find((t) => normalizeUrl(t.url) === normalizeUrl(url));
  if (existing) {
    await chrome.tabs.update(existing.tabId, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  try {
    await chrome.tabs.create({ url, active: true });
  } catch (err) {
    showToast(
      isLocalFileUrl(url)
        ? "The browser blocks extensions from opening local files — enable “Allow access to file URLs” on the extension's details page."
        : `Couldn't open tab: ${err instanceof Error ? err.message : err}`
    );
  }
}

/**
 * Toggle a type-ahead folder picker right after `anchor`; only one open at a
 * time. Empty query shows the indented tree; typing filters by full path
 * (Enter picks the highlighted match, arrows navigate, Escape closes).
 */

export function wireTabActions(): void {
  $("closeSortedBtn").addEventListener("click", async () => {
    const sorted = (await getOpenTabs()).filter((t) => t.sorted);
    if (!sorted.length) return;
    const urls = sorted.map((t) => t.url);
    state.suppressCloseTrackingUntil = Date.now() + 3000; // bulk close = "keep the bookmarks"
    await closeTabsSafely(sorted.map((t) => t.tabId));
    showToast(`Closed ${sorted.length} sorted tab${sorted.length === 1 ? "" : "s"}`, () =>
      reopenTabs(urls)
    );
    await requestRefresh();
  });
}
