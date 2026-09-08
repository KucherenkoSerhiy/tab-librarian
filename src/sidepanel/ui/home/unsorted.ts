import { reopenTabsWithNotice } from "../tabActions";
// Home: stats line and the Unmanaged-tabs list (domain clusters, duplicates).
import type { OpenTabInfo } from "../../../types";
import { fileTabManually, getManagedTree, listFolders, unfileQuietly } from "../../services/bookmarks";
import { requestRefresh } from "../../app/bus";
import { $, domainOf, makeIcon, showToast } from "../dom";
import { lockMark, passesFilter, whyLine } from "../filter";
import { toggleFolderSelect } from "../picker";
import { state } from "../../app/state";
import { closeTabsSafely, getOpenTabs } from "../../services/tabs";
import { countBookmarks } from "./tree";
import { normalizeUrl } from "../../domain/urls";

// ---------- home: stats, unsorted, tree ----------

export async function renderStats(): Promise<void> {
  const [tabs, folders, tree] = await Promise.all([getOpenTabs(), listFolders(), getManagedTree()]);
  const unsorted = tabs.filter((t) => !t.sorted).length;
  const sorted = tabs.length - unsorted;
  const bookmarkTotal = countBookmarks(tree);
  $("unsortedPanelCount").textContent = String(unsorted);
  const foldersCount = $("foldersPanelCount");
  foldersCount.textContent = String(bookmarkTotal);
  foldersCount.title = `${bookmarkTotal} bookmarks in ${folders.length} folders`;

  const closeSorted = $("closeSortedBtn") as HTMLButtonElement;
  closeSorted.hidden = sorted === 0;
  closeSorted.textContent = `🧹 Close ${sorted} sorted tab${sorted === 1 ? "" : "s"}`;
}

/** One unsorted row can represent several duplicate tabs of the same URL. */
export interface UnsortedEntry extends OpenTabInfo {
  dupCount: number;
  tabIds: number[];
}

export function makeTabRow(tab: UnsortedEntry, folders: { id: string; path: string[] }[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "tab-row";
  row.draggable = true;
  row.addEventListener("dragstart", (e) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData(
      "application/json",
      JSON.stringify({ kind: "tab", title: tab.title, url: tab.url })
    );
    e.dataTransfer.setData("text/plain", tab.url);
  });

  row.appendChild(makeIcon(tab.url));

  const text = document.createElement("div");
  text.className = "tab-text";
  const title = document.createElement("div");
  title.className = "tab-title";
  title.textContent = (tab.pinned ? "📌 " : "") + tab.title;
  if (tab.dupCount > 1) {
    const dup = document.createElement("span");
    dup.className = "dup-badge";
    dup.textContent = `×${tab.dupCount}`;
    dup.title = `${tab.dupCount} duplicate tabs with this URL`;
    title.appendChild(dup);
  }
  if (tab.excluded) title.appendChild(lockMark());
  const domain = document.createElement("div");
  domain.className = "tab-domain";
  domain.textContent = domainOf(tab.url);
  text.append(title, domain);
  const why = whyLine(tab.url);
  if (why) text.appendChild(why);
  text.title = tab.url;
  text.addEventListener("click", () => {
    void chrome.tabs.update(tab.tabId, { active: true });
    void chrome.windows.update(tab.windowId, { focused: true });
  });
  row.appendChild(text);

  const move = document.createElement("button");
  move.className = "add-btn";
  move.title = "Move into a folder";
  move.textContent = "⤷";
  move.addEventListener("click", () => {
    toggleFolderSelect(row, folders, (folderId) => {
      void (async () => {
        await fileTabManually({ title: tab.title, url: tab.url }, folderId);
        state.openFolders.add(folderId);
        showToast("Moved ✓", () => unfileQuietly(tab.url));
        await requestRefresh();
      })();
    });
  });
  row.appendChild(move);

  const close = document.createElement("button");
  close.className = "remove-btn";
  close.title = tab.dupCount > 1 ? `Close all ${tab.dupCount} duplicates` : "Close tab";
  close.textContent = "✕";
  close.addEventListener("click", async () => {
    const count = tab.tabIds.length;
    await closeTabsSafely(tab.tabIds);
    showToast(count > 1 ? `Closed ${count} duplicate tabs` : "Tab closed", () =>
      reopenTabsWithNotice(Array.from({ length: count }, () => tab.url))
    );
    await requestRefresh();
  });
  row.appendChild(close);

  return row;
}

export function makeDomainGroup(
  domain: string,
  tabs: UnsortedEntry[],
  folders: { id: string; path: string[] }[]
): HTMLElement {
  const details = document.createElement("details");
  details.className = "domain-group";
  details.open = !!state.searchQuery || state.openDomains.has(domain);
  details.addEventListener("toggle", () => {
    if (state.searchQuery) return; // search auto-expansion shouldn't be remembered
    if (details.open) state.openDomains.add(domain);
    else state.openDomains.delete(domain);
  });

  const summary = document.createElement("summary");

  const chev = document.createElement("span");
  chev.className = "chev";
  chev.textContent = "▶";
  summary.appendChild(chev);

  summary.appendChild(makeIcon(`https://${domain}/`));

  const text = document.createElement("div");
  text.className = "tab-text";
  const title = document.createElement("div");
  title.className = "tab-title";
  title.textContent = domain;
  const totalTabCount = tabs.reduce((acc, t) => acc + t.dupCount, 0);
  const sub = document.createElement("div");
  sub.className = "tab-domain";
  sub.textContent = `${totalTabCount} tab${totalTabCount === 1 ? "" : "s"}`;
  text.append(title, sub);
  summary.appendChild(text);

  // No "file all by domain" — same site rarely means same topic; filing is the
  // AI chat's job (or per-tab). The cluster is purely for browsing and closing.

  // close-all needs a second tap to confirm — 150-tab users fat-finger things
  const closeAll = document.createElement("button");
  closeAll.className = "remove-btn";
  closeAll.title = `Close all ${totalTabCount} tabs`;
  closeAll.textContent = "✕";
  let armed = false;
  closeAll.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!armed) {
      armed = true;
      closeAll.textContent = "Sure?";
      closeAll.classList.add("danger");
      setTimeout(() => {
        armed = false;
        closeAll.textContent = "✕";
        closeAll.classList.remove("danger");
      }, 3000);
      return;
    }
    const urls = tabs.flatMap((t) => t.tabIds.map(() => t.url));
    void (async () => {
      await closeTabsSafely(tabs.flatMap((t) => t.tabIds));
      showToast(`Closed ${urls.length} tabs`, () => reopenTabsWithNotice(urls));
      await requestRefresh();
    })();
  });
  summary.appendChild(closeAll);

  details.appendChild(summary);
  for (const tab of tabs) details.appendChild(makeTabRow(tab, folders));
  return details;
}

export async function renderUnsorted(): Promise<void> {
  const allUnsorted = (await getOpenTabs()).filter((t) => !t.sorted);
  const folders = await listFolders();
  const container = $("unsorted");
  container.replaceChildren();

  const note = (text: string) => {
    const el = document.createElement("div");
    el.className = "empty-note";
    el.textContent = text;
    container.appendChild(el);
  };

  if (!allUnsorted.length) return note("Everything is sorted 🎉");

  const visible = allUnsorted.filter((t) => passesFilter(t.url, `${t.title} ${t.url}`));
  if (!visible.length)
    return note(
      state.findFilter
        ? "The AI found nothing here for that description."
        : "No titles or URLs contain that text — press Enter to ask the AI instead."
    );

  // Collapse duplicate URLs into one row with a ×N badge.
  const byUrl = new Map<string, UnsortedEntry>();
  for (const tab of visible) {
    const key = normalizeUrl(tab.url);
    const entry = byUrl.get(key);
    if (entry) {
      entry.dupCount++;
      entry.tabIds.push(tab.tabId);
    } else {
      byUrl.set(key, { ...tab, dupCount: 1, tabIds: [tab.tabId] });
    }
  }

  // Cluster big domains so 150 tabs stay navigable; loners stay as flat rows.
  const byDomain = new Map<string, UnsortedEntry[]>();
  for (const tab of byUrl.values()) {
    const domain = domainOf(tab.url);
    const list = byDomain.get(domain) ?? [];
    list.push(tab);
    byDomain.set(domain, list);
  }
  const singles: UnsortedEntry[] = [];
  for (const [domain, list] of byDomain) {
    if (list.length >= 3) container.appendChild(makeDomainGroup(domain, list, folders));
    else singles.push(...list);
  }
  for (const tab of singles) container.appendChild(makeTabRow(tab, folders));
}

export function wireTabActions(): void {
  $("closeSortedBtn").addEventListener("click", async () => {
    const sorted = (await getOpenTabs()).filter((t) => t.sorted);
    if (!sorted.length) return;
    const urls = sorted.map((t) => t.url);
    state.suppressCloseTrackingUntil = Date.now() + 3000; // bulk close = "keep the bookmarks"
    await closeTabsSafely(sorted.map((t) => t.tabId));
    showToast(`Closed ${sorted.length} sorted tab${sorted.length === 1 ? "" : "s"}`, () =>
      reopenTabsWithNotice(urls)
    );
    await requestRefresh();
  });
}
