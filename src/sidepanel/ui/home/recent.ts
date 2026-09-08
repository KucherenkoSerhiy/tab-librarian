import { openOrFocusTabWithNotice } from "../tabActions";
// "Closed just now" strip: offer to drop a bookmark after its tab closes.
import { removeManagedBookmark, restoreRemovedBookmark } from "../../services/bookmarks";
import { requestRefresh } from "../../app/bus";
import { $, makeIcon, showToast } from "../dom";
import { state } from "../../app/state";
import { getPlacements } from "../../services/storage";
import { getOpenTabs } from "../../services/tabs";
import { normalizeUrl } from "../../domain/urls";

// ---------- "closed just now" tracking ----------
// Closing a managed tab keeps its bookmark (the library's promise), but for
// consumed content the user may want the bookmark gone too — offer it, opt-in.

export interface RecentlyClosedEntry {
  url: string;
  title: string;
  at: number;
}
const recentlyClosed: RecentlyClosedEntry[] = [];
// bulk closes ("Close sorted tabs", undo of open-all) explicitly mean "keep bookmarks"
const RC_TTL_MS = 10 * 60 * 1000;

export function addRecentlyClosed(entry: RecentlyClosedEntry): void {
  const key = normalizeUrl(entry.url);
  const existing = recentlyClosed.findIndex((e) => normalizeUrl(e.url) === key);
  if (existing >= 0) recentlyClosed.splice(existing, 1);
  recentlyClosed.unshift(entry);
  while (recentlyClosed.length > 5) recentlyClosed.pop();
  void renderRecentlyClosed();
}

export async function renderRecentlyClosed(): Promise<void> {
  const el = $("recentlyClosed");
  const placements = await getPlacements();
  const openNow = new Set((await getOpenTabs()).map((t) => normalizeUrl(t.url)));
  const cutoff = Date.now() - RC_TTL_MS;
  for (let i = recentlyClosed.length - 1; i >= 0; i--) {
    const entry = recentlyClosed[i]!;
    const key = normalizeUrl(entry.url);
    // expired, reopened, or no longer in the library → nothing left to decide
    if (entry.at < cutoff || openNow.has(key) || !(key in placements)) {
      recentlyClosed.splice(i, 1);
    }
  }
  el.replaceChildren();
  el.hidden = recentlyClosed.length === 0;
  if (!recentlyClosed.length) return;

  const head = document.createElement("div");
  head.className = "rc-head";
  head.textContent = "Closed just now — keep in library?";
  el.appendChild(head);

  for (const entry of recentlyClosed) {
    const row = document.createElement("div");
    row.className = "rc-row";
    row.appendChild(makeIcon(entry.url, 20));

    const title = document.createElement("span");
    title.className = "rc-title";
    title.textContent = entry.title;
    title.title = `${entry.url} — click to reopen`;
    title.addEventListener("click", () => void openOrFocusTabWithNotice(entry.url));
    row.appendChild(title);

    const keep = document.createElement("button");
    keep.className = "mini-btn accent-hover";
    keep.title = "Keep the bookmark";
    keep.textContent = "✓";
    keep.addEventListener("click", () => {
      recentlyClosed.splice(recentlyClosed.indexOf(entry), 1);
      void renderRecentlyClosed();
    });
    row.appendChild(keep);

    const remove = document.createElement("button");
    remove.className = "mini-btn danger-hover";
    remove.title = "Remove the bookmark too";
    remove.textContent = "🗑";
    remove.addEventListener("click", () => {
      void (async () => {
        const current = await getPlacements();
        const placement = current[normalizeUrl(entry.url)];
        if (placement) {
          const removed = await removeManagedBookmark(placement.bookmarkId);
          showToast("Bookmark removed", removed ? () => restoreRemovedBookmark(removed) : undefined);
        }
        recentlyClosed.splice(recentlyClosed.indexOf(entry), 1);
        await renderRecentlyClosed();
        await requestRefresh();
      })();
    });
    row.appendChild(remove);

    el.appendChild(row);
  }
}

// Browser events only mark state dirty; a 2-second poll does the actual
// re-render, and only for the parts that changed. This caps UI work no matter
// how noisy tab events get (page loads, title flickers, etc.).
