// Open-tab access and tab actions (close safely, reopen, focus).
import type { OpenTabInfo } from "../../types";
import { on, requestRefresh } from "../app/bus";
import { isExcludedUrl, parseExcludedDomains } from "../domain/privacy";
import { state } from "../app/state";
import { getPlacements, getSettings } from "./storage";
import { isLocalFileUrl, isSortableUrl, normalizeUrl } from "../domain/urls";

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

/** Undo helper for closed tabs. Returns how many the browser refused (local files). */
export async function reopenTabs(urls: string[]): Promise<number> {
  let blocked = 0;
  for (const url of urls) {
    try {
      await chrome.tabs.create({ url, active: false });
    } catch {
      blocked++;
    }
  }
  return blocked;
}

/** Jump to the already-open tab for this URL, or open it fresh. Returns an error message, or null. */
export async function openOrFocusTab(url: string): Promise<string | null> {
  const tabs = await getOpenTabs();
  const existing = tabs.find((t) => normalizeUrl(t.url) === normalizeUrl(url));
  if (existing) {
    await chrome.tabs.update(existing.tabId, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return null;
  }
  try {
    await chrome.tabs.create({ url, active: true });
    return null;
  } catch (err) {
    return isLocalFileUrl(url)
      ? "The browser blocks extensions from opening local files — enable “Allow access to file URLs” on the extension's details page."
      : `Couldn't open tab: ${err instanceof Error ? err.message : err}`;
  }
}
