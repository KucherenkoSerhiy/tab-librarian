// Home: the Managed-tabs folder tree (drag/drop, rename, subfolders, delete)
// and the New-folder form.
import { snapshotNow } from "../../services/backup";
import { deleteFolderDeep, ensureFolderPath, fileTabManually, getManagedTree, listFolders, moveBookmark, moveFolderNode, openFolderTabs, removeManagedBookmark, restoreDeletedFolder, restoreRemovedBookmark, unfileQuietly } from "../../services/bookmarks";
import { requestRefresh } from "../../app/bus";
import { $, makeIcon, showToast } from "../dom";
import { readDragPayload } from "../drag";
import { lockMark, whyLine } from "../filter";
import { folderOptionLabel } from "../picker";
import { isExcludedUrl, parseExcludedDomains } from "../../domain/privacy";
import { state } from "../../app/state";
import { getPlacements, getSettings } from "../../services/storage";
import { closeTabsSafely } from "../../services/tabs";
import { isSortableUrl, normalizeUrl } from "../../domain/urls";

export function countBookmarks(node: chrome.bookmarks.BookmarkTreeNode): number {
  return (node.children ?? []).reduce((acc, c) => acc + (c.url ? 1 : countBookmarks(c)), 0);
}

export async function renderTree(): Promise<void> {
  const tree = await getManagedTree();
  const placements = await getPlacements();
  const container = $("tree");
  container.replaceChildren();

  if (!tree.children?.length) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = "No folders yet — let the assistant propose some, or create one.";
    container.appendChild(note);
    return;
  }

  const query = state.searchQuery.toLowerCase();
  const excludedDomains = parseExcludedDomains((await getSettings()).excludedDomains);

  const makeBookmarkRow = (child: chrome.bookmarks.BookmarkTreeNode): HTMLElement => {
    const row = document.createElement("div");
    row.className = "bm-row";
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      if (!e.dataTransfer) return;
      e.stopPropagation();
      e.dataTransfer.effectAllowed = "copyMove";
      e.dataTransfer.setData(
        "application/json",
        JSON.stringify({ kind: "bookmark", id: child.id, url: child.url, title: child.title })
      );
      e.dataTransfer.setData("text/plain", child.url!);
    });

    row.appendChild(makeIcon(child.url!));

    const text = document.createElement("div");
    text.className = "tab-text";
    const title = document.createElement("div");
    title.className = "tab-title";
    const source = placements[normalizeUrl(child.url!)]?.source;
    title.textContent = (child.title || child.url!) + (source === "manual" ? " 📌" : "");
    if (isExcludedUrl(child.url!, excludedDomains)) title.appendChild(lockMark());
    text.appendChild(title);
    const why = whyLine(child.url!);
    if (why) text.appendChild(why);
    text.title = child.url!;
    text.addEventListener("click", () => void chrome.tabs.create({ url: child.url }));
    row.appendChild(text);

    const remove = document.createElement("button");
    remove.className = "remove-btn";
    remove.title = "Delete bookmark";
    remove.textContent = "✕";
    remove.addEventListener("click", async () => {
      const removed = await removeManagedBookmark(child.id);
      showToast("Bookmark deleted", removed ? () => restoreRemovedBookmark(removed) : undefined);
      await requestRefresh();
    });
    row.appendChild(remove);
    return row;
  };

  const renderFolder = (node: chrome.bookmarks.BookmarkTreeNode): HTMLElement | null => {
    const nameMatch = !state.findFilter && !!query && node.title.toLowerCase().includes(query);
    const childEls: HTMLElement[] = [];
    for (const child of node.children ?? []) {
      if (child.url) {
        const show = state.findFilter
          ? state.findFilter.has(normalizeUrl(child.url))
          : !query || nameMatch || `${child.title} ${child.url}`.toLowerCase().includes(query);
        if (show) {
          childEls.push(makeBookmarkRow(child));
        }
      } else {
        const el = renderFolder(child);
        if (el) childEls.push(el);
      }
    }
    if (query && !nameMatch && !childEls.length) return null;
    // while filtering, the badge counts what is shown inside, not the folder's full size
    const filtering = !!query || !!state.findFilter;
    const shownInside = childEls.reduce(
      (n, el) => n + (el.classList.contains("bm-row") ? 1 : Number(el.dataset.matches ?? 0)),
      0
    );

    const details = document.createElement("details");
    // collapsed by default, but re-renders keep the user's expansion state
    details.open = !!query || state.openFolders.has(node.id);
    details.addEventListener("toggle", () => {
      if (query) return;
      if (details.open) state.openFolders.add(node.id);
      else state.openFolders.delete(node.id);
    });

    const summary = document.createElement("summary");
    summary.dataset.folderId = node.id;
    summary.draggable = true;
    summary.addEventListener("dragstart", (e) => {
      if (!e.dataTransfer) return;
      e.stopPropagation();
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(
        "application/json",
        JSON.stringify({ kind: "folder", id: node.id, title: node.title })
      );
    });

    const chev = document.createElement("span");
    chev.className = "chev";
    chev.textContent = "▶";
    summary.appendChild(chev);

    const name = document.createElement("span");
    name.className = "folder-name";
    name.textContent = `📁 ${node.title}`;
    name.title = "Double-click to rename";
    name.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const input = document.createElement("input");
      input.type = "text";
      input.className = "rename-input";
      input.value = node.title;
      name.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const commit = async (save: boolean) => {
        if (done) return;
        done = true;
        const newTitle = input.value.trim();
        if (save && newTitle && newTitle !== node.title) {
          const oldTitle = node.title;
          await chrome.bookmarks.update(node.id, { title: newTitle });
          showToast(`Renamed to "${newTitle}"`, async () => {
            await chrome.bookmarks.update(node.id, { title: oldTitle });
          });
        }
        await requestRefresh();
      };
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          void commit(true);
        } else if (ev.key === "Escape") {
          void commit(false);
        }
      });
      input.addEventListener("blur", () => void commit(true));
    });
    summary.appendChild(name);

    const bookmarkTotal = countBookmarks(node);
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(filtering ? shownInside : bookmarkTotal);
    count.title = filtering ? `${shownInside} match${shownInside === 1 ? "" : "es"} of ${bookmarkTotal}` : "";
    details.dataset.matches = String(shownInside);
    summary.appendChild(count);

    const stopThrough = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };

    // ↗ open every bookmark inside as background tabs
    if (bookmarkTotal > 0) {
      const openAll = document.createElement("button");
      openAll.className = "mini-btn accent-hover";
      openAll.title = `Open all ${bookmarkTotal} bookmarks as tabs`;
      openAll.textContent = "↗";
      openAll.addEventListener("click", (e) => {
        stopThrough(e);
        void (async () => {
          const { tabIds, blocked } = await openFolderTabs(node.id);
          const note = blocked
            ? `Opened ${tabIds.length} tabs · ${blocked} local file(s) blocked (needs “Allow access to file URLs”)`
            : `Opened ${tabIds.length} tabs`;
          showToast(note, async () => {
            state.suppressCloseTrackingUntil = Date.now() + 3000; // undoing an open-all keeps bookmarks
            await closeTabsSafely(tabIds).catch(() => {});
          });
          await requestRefresh();
        })();
      });
      summary.appendChild(openAll);
    }

    // ＋ create a subfolder inline
    const addSub = document.createElement("button");
    addSub.className = "mini-btn accent-hover";
    addSub.title = "New subfolder";
    addSub.textContent = "＋";
    addSub.addEventListener("click", (e) => {
      stopThrough(e);
      const existing = summary.nextElementSibling;
      if (existing?.classList.contains("subfolder-input")) {
        existing.remove();
        return;
      }
      document.querySelectorAll(".subfolder-input").forEach((el) => el.remove());
      const input = document.createElement("input");
      input.type = "text";
      input.className = "subfolder-input";
      input.placeholder = `New folder inside "${node.title}"…`;
      input.addEventListener("keydown", async (ev) => {
        if (ev.key === "Escape") input.remove();
        if (ev.key === "Enter") {
          ev.preventDefault();
          const name = input.value.trim();
          if (!name) return;
          await chrome.bookmarks.create({ parentId: node.id, title: name });
          state.openFolders.add(node.id);
          await requestRefresh();
        }
      });
      details.open = true;
      state.openFolders.add(node.id);
      summary.after(input);
      input.focus();
    });
    summary.appendChild(addSub);

    // ✕ delete folder; only a folder that still holds bookmarks asks for a second tap
    const hasBookmarks = (n: chrome.bookmarks.BookmarkTreeNode): boolean => !!n.url || (n.children ?? []).some(hasBookmarks);
    const del = document.createElement("button");
    del.className = "mini-btn danger-hover";
    del.title = hasBookmarks(node) ? "Delete folder and its contents" : "Delete folder";
    del.textContent = "✕";
    let delArmed = false;
    del.addEventListener("click", (e) => {
      stopThrough(e);
      if (hasBookmarks(node) && !delArmed) {
        delArmed = true;
        del.textContent = "Sure?";
        del.classList.add("danger");
        setTimeout(() => {
          delArmed = false;
          del.textContent = "✕";
          del.classList.remove("danger");
        }, 3000);
        return;
      }
      void (async () => {
        await snapshotNow("before folder delete");
        const deleted = await deleteFolderDeep(node.id);
        showToast(
          `Deleted "${node.title}"${deleted?.bookmarkCount ? ` (${deleted.bookmarkCount} bookmarks)` : ""}`,
          deleted ? () => restoreDeletedFolder(deleted) : undefined
        );
        await requestRefresh();
      })();
    });
    summary.appendChild(del);

    // Whole folder card is a drop target (not just the summary row); events
    // stop at the innermost folder so nested drops don't double-file.
    details.addEventListener("dragenter", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    details.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      summary.classList.add("drop-target");
    });
    details.addEventListener("dragleave", (e) => {
      if (!details.contains(e.relatedTarget as Node)) summary.classList.remove("drop-target");
    });
    details.addEventListener("drop", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      summary.classList.remove("drop-target");
      const payload = readDragPayload(e.dataTransfer);
      if (!payload) return;

      if (payload.kind === "tab") {
        if (!isSortableUrl(payload.url)) return;
        const url = payload.url;
        await fileTabManually({ title: payload.title, url }, node.id);
        showToast(`Moved into ${node.title} ✓`, () => unfileQuietly(url));
      } else if (payload.kind === "bookmark") {
        const { oldParentId } = await moveBookmark(payload.id, payload.url, node.id);
        if (oldParentId === node.id) return;
        showToast(`Moved to ${node.title} ✓`, async () => {
          await moveBookmark(payload.id, payload.url, oldParentId);
        });
      } else {
        const moved = await moveFolderNode(payload.id, node.id);
        if (!moved) {
          showToast("Can't move a folder into itself or where it already is");
          return;
        }
        showToast(`Moved "${payload.title}" into ${node.title} ✓`, async () => {
          await moveFolderNode(payload.id, moved.oldParentId);
        });
      }
      state.openFolders.add(node.id);
      await requestRefresh();
    });

    details.appendChild(summary);
    for (const el of childEls) details.appendChild(el);
    return details;
  };

  let anyVisible = false;
  for (const child of tree.children) {
    if (!child.url) {
      const el = renderFolder(child);
      if (el) {
        container.appendChild(el);
        anyVisible = true;
      }
    }
  }
  for (const child of tree.children) {
    if (child.url && (!query || `${child.title} ${child.url}`.toLowerCase().includes(query))) {
      container.appendChild(makeBookmarkRow(child));
      anyVisible = true;
    }
  }
  if (!anyVisible) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = state.findFilter
      ? "The AI found nothing here for that description."
      : "No titles or URLs contain that text — press Enter to ask the AI instead.";
    container.appendChild(note);
  }
}


// ---------- new folder form ----------

export async function populateParentSelect(): Promise<void> {
  const select = $("newFolderParent") as HTMLSelectElement;
  select.replaceChildren();
  const rootOpt = document.createElement("option");
  rootOpt.value = "";
  rootOpt.textContent = "(top level)";
  select.appendChild(rootOpt);
  for (const folder of await listFolders()) {
    const opt = document.createElement("option");
    opt.value = folder.id;
    opt.textContent = folderOptionLabel(folder.path);
    opt.title = folder.path.join(" / ");
    select.appendChild(opt);
  }
}

export async function createFolderFromForm(): Promise<void> {
  const name = ($("newFolderName") as HTMLInputElement).value.trim();
  if (!name) return;
  const parentValue = ($("newFolderParent") as HTMLSelectElement).value;
  if (parentValue) {
    await chrome.bookmarks.create({ parentId: parentValue, title: name });
  } else {
    await ensureFolderPath([name]);
  }
  ($("newFolderName") as HTMLInputElement).value = "";
  $("newFolderForm").hidden = true;
  await requestRefresh();
}


export function wireNewFolder(): void {
  $("newFolderBtn").addEventListener("click", async () => {
    const form = $("newFolderForm");
    form.hidden = !form.hidden;
    if (!form.hidden) {
      await populateParentSelect();
      $("newFolderName").focus();
    }
  });
  $("cancelNewFolderBtn").addEventListener("click", () => ($("newFolderForm").hidden = true));
  $("newFolderForm").addEventListener("submit", (e) => {
    e.preventDefault();
    void createFolderFromForm();
  });
}
