import type { Placement, ProposalFolderEntry, Removal } from "../types";
import {
  getManagedRootId,
  getPlacements,
  getRemovals,
  setManagedRootId,
  setPlacements,
  setRemovals,
} from "./storage";
import { normalizeUrl } from "./urls";

const ROOT_TITLE = "AI Smart Tab Manager";
const OTHER_BOOKMARKS_ID = "2"; // Chromium convention: 1 = Bookmarks Bar, 2 = Other Bookmarks

type BookmarkNode = chrome.bookmarks.BookmarkTreeNode;

/** Find or create the dedicated root folder; never trust the name alone once an id is stored. */
export async function ensureManagedRoot(): Promise<string> {
  const stored = await getManagedRootId();
  if (stored) {
    try {
      const [node] = await chrome.bookmarks.get(stored);
      if (node && !node.url) return node.id;
    } catch {
      // stored id no longer exists — fall through and recreate
    }
  }

  let parentId = OTHER_BOOKMARKS_ID;
  try {
    const [other] = await chrome.bookmarks.get(parentId);
    if (!other || other.url) throw new Error("unexpected node");
  } catch {
    const tree = await chrome.bookmarks.getTree();
    const children = tree[0]?.children ?? [];
    parentId = (children[1] ?? children[0])!.id;
  }

  const siblings = await chrome.bookmarks.getChildren(parentId);
  const existing = siblings.find((n) => !n.url && n.title === ROOT_TITLE);
  const root = existing ?? (await chrome.bookmarks.create({ parentId, title: ROOT_TITLE }));
  await setManagedRootId(root.id);
  return root.id;
}

export async function getManagedTree(): Promise<BookmarkNode> {
  const rootId = await ensureManagedRoot();
  const [subtree] = await chrome.bookmarks.getSubTree(rootId);
  return subtree!;
}

export function walkTree(node: BookmarkNode, visit: (n: BookmarkNode, path: string[]) => void, path: string[] = []): void {
  for (const child of node.children ?? []) {
    if (child.url) {
      visit(child, path);
    } else {
      visit(child, path);
      walkTree(child, visit, [...path, child.title]);
    }
  }
}

/** All folders under the managed root as { id, path } — path relative to the root. */
export async function listFolders(): Promise<{ id: string; path: string[] }[]> {
  const tree = await getManagedTree();
  const folders: { id: string; path: string[] }[] = [];
  walkTree(tree, (n, path) => {
    if (!n.url) folders.push({ id: n.id, path: [...path, n.title] });
  });
  return folders;
}

/** Create (or find) nested folders along `path` under the managed root; returns the leaf folder id. */
export async function ensureFolderPath(path: string[], createdFolderIds?: string[]): Promise<string> {
  let parentId = await ensureManagedRoot();
  for (const name of path) {
    const children = await chrome.bookmarks.getChildren(parentId);
    const hit = children.find((n) => !n.url && n.title === name);
    if (hit) {
      parentId = hit.id;
    } else {
      const created = await chrome.bookmarks.create({ parentId, title: name });
      createdFolderIds?.push(created.id);
      parentId = created.id;
    }
  }
  return parentId;
}

export interface ApplyUndoData {
  createdBookmarkIds: string[];
  createdFolderIds: string[];
  moved: { id: string; oldParentId: string }[];
  deletedBookmarks: { url: string; title: string; parentId: string }[];
  placementsSnapshot: Record<string, Placement>;
  removalsSnapshot: Record<string, Removal>;
}

export interface ApplyResult {
  created: number;
  moved: number;
  removed: number;
  skippedManual: number;
  undo: ApplyUndoData;
}

/**
 * Apply a proposal as a diff against the current managed tree.
 * - Missing folders are created; existing ones are reused.
 * - A URL already bookmarked in the target folder is left alone.
 * - A URL bookmarked elsewhere moves only if its placement is not manual.
 * - Nothing is ever deleted here.
 */
export async function applyProposal(
  folders: ProposalFolderEntry[],
  includeUrls: Set<string>,
  removeUrls: Set<string> = new Set()
): Promise<ApplyResult> {
  const placements = await getPlacements();
  const removals = await getRemovals();
  const tree = await getManagedTree();

  const undo: ApplyUndoData = {
    createdBookmarkIds: [],
    createdFolderIds: [],
    moved: [],
    deletedBookmarks: [],
    placementsSnapshot: structuredClone(placements),
    removalsSnapshot: structuredClone(removals),
  };

  const existingByUrl = new Map<string, { id: string; parentId: string; title: string }>();
  walkTree(tree, (n) => {
    if (n.url) existingByUrl.set(normalizeUrl(n.url), { id: n.id, parentId: n.parentId!, title: n.title });
  });

  const result: ApplyResult = { created: 0, moved: 0, removed: 0, skippedManual: 0, undo };

  // approved cleanup deletions first, so a removal + re-file of the same URL behaves predictably
  for (const url of removeUrls) {
    const key = normalizeUrl(url);
    const existing = existingByUrl.get(key);
    if (!existing) continue;
    await chrome.bookmarks.remove(existing.id);
    undo.deletedBookmarks.push({ url, title: existing.title, parentId: existing.parentId });
    existingByUrl.delete(key);
    delete placements[key];
    removals[key] = { folderPath: "(cleanup)", removedAt: Date.now() };
    result.removed++;
  }

  for (const folder of folders) {
    if (folder.tabs.length === 0 && folder.path.length > 0) {
      await ensureFolderPath(folder.path, undo.createdFolderIds); // empty folder is a deliberate part of the taxonomy
      continue;
    }
    let folderId: string | null = null;
    for (const tab of folder.tabs) {
      const key = normalizeUrl(tab.url);
      if (!includeUrls.has(key)) continue;
      folderId ??= await ensureFolderPath(folder.path, undo.createdFolderIds);

      const existing = existingByUrl.get(key);
      const placement = placements[key];
      if (existing) {
        if (existing.parentId === folderId) continue;
        if (placement?.source === "manual") {
          result.skippedManual++;
          continue;
        }
        await chrome.bookmarks.move(existing.id, { parentId: folderId });
        undo.moved.push({ id: existing.id, oldParentId: existing.parentId });
        result.moved++;
        placements[key] = { bookmarkId: existing.id, folderId, source: "llm", placedAt: Date.now() };
      } else {
        const created = await chrome.bookmarks.create({
          parentId: folderId,
          title: tab.title || tab.url,
          url: tab.url,
        });
        undo.createdBookmarkIds.push(created.id);
        result.created++;
        placements[key] = { bookmarkId: created.id, folderId, source: "llm", placedAt: Date.now() };
      }
      delete removals[key]; // re-filed with user approval — no longer "removed"
    }
  }

  await setPlacements(placements);
  await setRemovals(removals);
  return result;
}

/** Reverts an applyProposal: deletes created bookmarks/folders, moves moved ones back, restores metadata. */
export async function revertApply(undo: ApplyUndoData): Promise<void> {
  for (const removed of undo.deletedBookmarks) {
    try {
      await chrome.bookmarks.create({ parentId: removed.parentId, title: removed.title, url: removed.url });
    } catch {
      /* parent folder vanished — reconcile will absorb it */
    }
  }
  for (const id of undo.createdBookmarkIds) {
    try {
      await chrome.bookmarks.remove(id);
    } catch {
      /* already gone */
    }
  }
  for (const m of undo.moved) {
    try {
      await chrome.bookmarks.move(m.id, { parentId: m.oldParentId });
    } catch {
      /* target vanished — leave it */
    }
  }
  // deepest-first so nested created folders empty out before their parents
  for (const id of [...undo.createdFolderIds].reverse()) {
    try {
      const children = await chrome.bookmarks.getChildren(id);
      if (children.length === 0) await chrome.bookmarks.remove(id);
    } catch {
      /* already gone */
    }
  }
  await setPlacements(undo.placementsSnapshot);
  await setRemovals(undo.removalsSnapshot);
  await reconcile(); // recreated bookmarks have fresh ids — rebind by URL
}

/** Direct user action — applies immediately, marked manual so the LLM never overrides it. */
export async function fileTabManually(tab: { title: string; url: string }, folderId: string): Promise<void> {
  const key = normalizeUrl(tab.url);
  const placements = await getPlacements();
  const removals = await getRemovals();

  const existing = placements[key];
  if (existing) {
    try {
      await chrome.bookmarks.move(existing.bookmarkId, { parentId: folderId });
      placements[key] = { ...existing, folderId, source: "manual", placedAt: Date.now() };
      delete removals[key];
      await setPlacements(placements);
      await setRemovals(removals);
      return;
    } catch {
      // stale bookmark id — fall through and create fresh
    }
  }

  const created = await chrome.bookmarks.create({
    parentId: folderId,
    title: tab.title || tab.url,
    url: tab.url,
  });
  placements[key] = { bookmarkId: created.id, folderId, source: "manual", placedAt: Date.now() };
  delete removals[key];
  await setPlacements(placements);
  await setRemovals(removals);
}

export interface RemovedBookmarkInfo {
  url: string;
  title: string;
  folderId: string;
  folderPath: string;
}

/** Pull a bookmark out of its folder; remembers the removal so the LLM knows the user did it. */
export async function removeManagedBookmark(bookmarkId: string): Promise<RemovedBookmarkInfo | null> {
  const [node] = await chrome.bookmarks.get(bookmarkId);
  if (!node?.url) return null;
  const key = normalizeUrl(node.url);

  const folderId = node.parentId!;
  const folderPath = await folderPathOf(folderId);
  await chrome.bookmarks.remove(bookmarkId);

  const placements = await getPlacements();
  delete placements[key];
  await setPlacements(placements);

  const removals = await getRemovals();
  removals[key] = { folderPath, removedAt: Date.now() };
  await setRemovals(removals);

  return { url: node.url, title: node.title, folderId, folderPath };
}

/** Undo for removeManagedBookmark: put the bookmark back and erase the removal record. */
export async function restoreRemovedBookmark(info: RemovedBookmarkInfo): Promise<void> {
  let parentId = info.folderId;
  try {
    const [folder] = await chrome.bookmarks.get(parentId);
    if (!folder || folder.url) throw new Error("gone");
  } catch {
    parentId = await ensureManagedRoot();
  }
  const created = await chrome.bookmarks.create({ parentId, title: info.title, url: info.url });

  const key = normalizeUrl(info.url);
  const placements = await getPlacements();
  placements[key] = { bookmarkId: created.id, folderId: parentId, source: "manual", placedAt: Date.now() };
  await setPlacements(placements);

  const removals = await getRemovals();
  delete removals[key];
  await setRemovals(removals);
}

/** Undo for a manual filing: delete the bookmark + placement WITHOUT recording a user removal. */
export async function unfileQuietly(url: string): Promise<void> {
  const key = normalizeUrl(url);
  const placements = await getPlacements();
  const placement = placements[key];
  if (!placement) return;
  try {
    await chrome.bookmarks.remove(placement.bookmarkId);
  } catch {
    /* already gone */
  }
  delete placements[key];
  await setPlacements(placements);
}

/** Move an existing managed bookmark into another folder (drag inside the tree). */
export async function moveBookmark(
  bookmarkId: string,
  url: string,
  targetFolderId: string
): Promise<{ oldParentId: string }> {
  const [node] = await chrome.bookmarks.get(bookmarkId);
  const oldParentId = node?.parentId ?? (await ensureManagedRoot());
  await chrome.bookmarks.move(bookmarkId, { parentId: targetFolderId });
  const key = normalizeUrl(url);
  const placements = await getPlacements();
  placements[key] = { bookmarkId, folderId: targetFolderId, source: "manual", placedAt: Date.now() };
  await setPlacements(placements);
  return { oldParentId };
}

/** Re-parent a folder. Returns null when the move is invalid (self, own descendant) or a no-op. */
export async function moveFolderNode(
  folderId: string,
  targetFolderId: string
): Promise<{ oldParentId: string } | null> {
  if (folderId === targetFolderId) return null;
  const rootId = await ensureManagedRoot();
  // reject dropping a folder into its own subtree
  let cursor: string | undefined = targetFolderId;
  while (cursor && cursor !== rootId) {
    if (cursor === folderId) return null;
    const nodes: BookmarkNode[] = await chrome.bookmarks.get(cursor);
    cursor = nodes[0]?.parentId;
  }
  const [node] = await chrome.bookmarks.get(folderId);
  const oldParentId = node?.parentId ?? rootId;
  if (oldParentId === targetFolderId) return null;
  await chrome.bookmarks.move(folderId, { parentId: targetFolderId });
  return { oldParentId };
}

export interface DeletedFolderData {
  subtree: BookmarkNode;
  parentId: string;
  placementsSnapshot: Record<string, Placement>;
  removalsSnapshot: Record<string, Removal>;
  bookmarkCount: number;
}

/** Delete a folder and everything inside it. Contained URLs are logged as user removals. */
export async function deleteFolderDeep(folderId: string): Promise<DeletedFolderData | null> {
  const [subtree] = await chrome.bookmarks.getSubTree(folderId);
  if (!subtree || subtree.url) return null;

  const placements = await getPlacements();
  const removals = await getRemovals();
  const data: DeletedFolderData = {
    subtree,
    parentId: subtree.parentId!,
    placementsSnapshot: structuredClone(placements),
    removalsSnapshot: structuredClone(removals),
    bookmarkCount: 0,
  };

  const basePath = await folderPathOf(folderId);
  const strip = (node: BookmarkNode, path: string) => {
    for (const child of node.children ?? []) {
      if (child.url) {
        const key = normalizeUrl(child.url);
        delete placements[key];
        removals[key] = { folderPath: path, removedAt: Date.now() };
        data.bookmarkCount++;
      } else {
        strip(child, path ? `${path}/${child.title}` : child.title);
      }
    }
  };
  strip(subtree, basePath);

  await chrome.bookmarks.removeTree(folderId);
  await setPlacements(placements);
  await setRemovals(removals);
  return data;
}

/** Undo for deleteFolderDeep: recreate the subtree and heal metadata. */
export async function restoreDeletedFolder(data: DeletedFolderData): Promise<void> {
  await setPlacements(data.placementsSnapshot);
  await setRemovals(data.removalsSnapshot);

  let parentId = data.parentId;
  try {
    const [parent] = await chrome.bookmarks.get(parentId);
    if (!parent || parent.url) throw new Error("gone");
  } catch {
    parentId = await ensureManagedRoot();
  }
  const recreate = async (node: BookmarkNode, parent: string): Promise<void> => {
    if (node.url) {
      await chrome.bookmarks.create({ parentId: parent, title: node.title, url: node.url });
      return;
    }
    const folder = await chrome.bookmarks.create({ parentId: parent, title: node.title });
    for (const child of node.children ?? []) await recreate(child, folder.id);
  };
  await recreate(data.subtree, parentId);
  // the snapshot's bookmark/folder ids are stale after recreation — reconcile
  // re-binds placements by URL while preserving their manual/llm source
  await reconcile();
}

/** Open every bookmark in a folder (recursively) as background tabs; returns the new tab ids. */
export async function openFolderTabs(folderId: string): Promise<number[]> {
  const [subtree] = await chrome.bookmarks.getSubTree(folderId);
  const urls: string[] = [];
  const collect = (node: BookmarkNode) => {
    for (const child of node.children ?? []) {
      if (child.url) urls.push(child.url);
      else collect(child);
    }
  };
  if (subtree) collect(subtree);
  const tabIds: number[] = [];
  for (const url of urls) {
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab.id !== undefined) tabIds.push(tab.id);
  }
  return tabIds;
}

async function folderPathOf(folderId: string | undefined): Promise<string> {
  if (!folderId) return "";
  const rootId = await ensureManagedRoot();
  const parts: string[] = [];
  let currentId: string | undefined = folderId;
  while (currentId && currentId !== rootId) {
    const nodes: BookmarkNode[] = await chrome.bookmarks.get(currentId);
    const node = nodes[0];
    if (!node) break;
    parts.unshift(node.title);
    currentId = node.parentId;
  }
  return parts.join("/");
}

/**
 * Bring the placements map back in line with reality (external edits via the
 * bookmarks manager, sync from another machine, etc.).
 * Bookmarks found under the root with no placement are recorded as manual —
 * the user (or their sync) put them there, so the LLM must respect them.
 */
export async function reconcile(): Promise<void> {
  const tree = await getManagedTree();
  const placements = await getPlacements();

  const actualByUrl = new Map<string, { id: string; parentId: string }>();
  walkTree(tree, (n) => {
    if (n.url) actualByUrl.set(normalizeUrl(n.url), { id: n.id, parentId: n.parentId! });
  });

  let changed = false;
  for (const [key, placement] of Object.entries(placements)) {
    const actual = actualByUrl.get(key);
    if (!actual) {
      delete placements[key];
      changed = true;
    } else if (actual.id !== placement.bookmarkId || actual.parentId !== placement.folderId) {
      placements[key] = { ...placement, bookmarkId: actual.id, folderId: actual.parentId };
      changed = true;
    }
  }
  for (const [key, actual] of actualByUrl) {
    if (!placements[key]) {
      placements[key] = {
        bookmarkId: actual.id,
        folderId: actual.parentId,
        source: "manual",
        placedAt: Date.now(),
      };
      changed = true;
    }
  }
  if (changed) await setPlacements(placements);
}

