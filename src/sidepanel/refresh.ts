// Keeps the panel in sync with the browser: dirty flags from chrome events,
// a 2 s poll that renders, and a full refresh on demand.
import { reconcile } from "./bookmarks";
import { on } from "./bus";
import { interactionInProgress } from "./drag";
import { addRecentlyClosed, renderRecentlyClosed } from "./recent";
import { state } from "./state";
import { getPlacements } from "./storage";
import { getOpenTabs } from "./tabs";
import { renderTree } from "./tree";
import { renderStats, renderUnsorted } from "./unsorted";
import { normalizeUrl } from "./urls";

// ---------- refresh & events ----------

let refreshQueued = false;
export async function refreshAll(): Promise<void> {
  if (refreshQueued) return;
  refreshQueued = true;
  tabsDirty = false; // a full refresh supersedes any pending dirty work
  bookmarksDirty = false;
  lastFullRefresh = Date.now();
  try {
    await reconcile();
    await Promise.all([renderStats(), renderTree(), renderUnsorted(), renderRecentlyClosed()]);
  } finally {
    refreshQueued = false;
  }
}


let tabsDirty = false;
let bookmarksDirty = false;
let pollRunning = false;

// Drag state must self-expire: when a drop re-renders the list, the dragged
// row is detached before its dragend can bubble to document, so a plain
// boolean latches true forever and silently freezes all updates.

let lastFullRefresh = 0;

export async function pollDirty(): Promise<void> {
  if (pollRunning || state.applying || state.currentView !== "home" || interactionInProgress()) return;
  // heartbeat: even if an event was missed entirely, never stay stale > 30s
  const heartbeatDue = Date.now() - lastFullRefresh > 30_000;
  if (!tabsDirty && !bookmarksDirty && !heartbeatDue) return;
  const doTree = bookmarksDirty || heartbeatDue;
  tabsDirty = false;
  bookmarksDirty = false;
  pollRunning = true;
  try {
    if (doTree) {
      await reconcile();
      await renderTree();
      lastFullRefresh = Date.now();
    }
    await Promise.all([renderStats(), renderUnsorted()]);
  } finally {
    pollRunning = false;
  }
}


/** Wire chrome events → dirty flags, and start the 2 s poll. */
export function startSync(): void {
  on("refresh", refreshAll);
  const markBookmarksDirty = () => {
    bookmarksDirty = true;
    tabsDirty = true; // sorted/unsorted status derives from bookmarks
  };
  chrome.bookmarks.onCreated.addListener(markBookmarksDirty);
  chrome.bookmarks.onRemoved.addListener(markBookmarksDirty);
  chrome.bookmarks.onMoved.addListener(markBookmarksDirty);
  chrome.bookmarks.onChanged.addListener(markBookmarksDirty);
  chrome.tabs.onCreated.addListener(() => (tabsDirty = true));
  chrome.tabs.onRemoved.addListener((tabId) => {
    tabsDirty = true;
    const known = state.lastKnownTabs.get(tabId);
    state.lastKnownTabs.delete(tabId);
    if (!known || Date.now() < state.suppressCloseTrackingUntil) return;
    void (async () => {
      const placements = await getPlacements();
      if (!(normalizeUrl(known.url) in placements)) return; // wasn't in the library
      const stillOpen = (await getOpenTabs()).some(
        (t) => normalizeUrl(t.url) === normalizeUrl(known.url)
      );
      if (stillOpen) return; // a duplicate remains — nothing to decide yet
      addRecentlyClosed({ url: known.url, title: known.title, at: Date.now() });
    })();
  });
  chrome.tabs.onUpdated.addListener((_id, changeInfo) => {
    // ignore loading-progress noise; only meaningful changes matter to the list
    if (changeInfo.url || changeInfo.title || changeInfo.status === "complete") tabsDirty = true;
  });
  // window/tab focus changes and moves don't fire the events above — without
  // these, counts go stale when the user works in another window
  chrome.tabs.onActivated?.addListener(() => (tabsDirty = true));
  chrome.tabs.onAttached?.addListener(() => (tabsDirty = true));
  chrome.tabs.onDetached?.addListener(() => (tabsDirty = true));
  chrome.windows?.onFocusChanged?.addListener(() => (tabsDirty = true));
  // panel re-shown (window switch, panel reopen) → full refresh, not just a poll tick
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refreshAll();
  });
  setInterval(() => void pollDirty(), 2000);
}
