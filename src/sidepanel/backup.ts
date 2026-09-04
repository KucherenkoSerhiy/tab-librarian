import type { Placement, Removal } from "../types";
import { ensureFolderPath, ensureManagedRoot, getManagedTree, reconcile, walkTree } from "./bookmarks";
import { getPlacements, getRemovals, getSettings } from "./storage";
import { normalizeUrl } from "./urls";

interface Snapshot {
  at: number;
  reason: string;
  tree: chrome.bookmarks.BookmarkTreeNode;
  placements: Record<string, Placement>;
  removals: Record<string, Removal>;
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // keep snapshots for 7 days
const ROUTINE_GAP_MS = 3 * 60 * 60 * 1000; // cyclic cadence: every 3 hours
const HARD_CAP = 80; // safety ceiling regardless of age

async function collectState(): Promise<Pick<Snapshot, "tree" | "placements" | "removals">> {
  const [tree, placements, removals] = await Promise.all([
    getManagedTree(),
    getPlacements(),
    getRemovals(),
  ]);
  return { tree, placements, removals };
}

/** Keep a rolling ring of tree snapshots in extension storage — cheap insurance. */
export async function snapshotNow(reason: string, routine = false, force = false): Promise<void> {
  try {
    if (!force && !(await getSettings()).backupsEnabled) return;
    const { backups } = await chrome.storage.local.get("backups");
    let list = (backups as Snapshot[] | undefined) ?? [];
    const last = list[list.length - 1];
    if (routine && last && Date.now() - last.at < ROUTINE_GAP_MS) return;
    list.push({ at: Date.now(), reason, ...(await collectState()) });
    const cutoff = Date.now() - RETENTION_MS;
    list = list.filter((s) => s.at >= cutoff);
    while (list.length > HARD_CAP) list.shift();
    await chrome.storage.local.set({ backups: list });
  } catch (err) {
    console.warn("snapshot failed", err);
  }
}

export async function snapshotCount(): Promise<number> {
  const { backups } = await chrome.storage.local.get("backups");
  return ((backups as Snapshot[] | undefined) ?? []).length;
}

export interface SnapshotMeta {
  index: number;
  at: number;
  reason: string;
  bookmarkCount: number;
}

export async function listSnapshots(): Promise<SnapshotMeta[]> {
  const { backups } = await chrome.storage.local.get("backups");
  return ((backups as Snapshot[] | undefined) ?? []).map((snap, index) => {
    let bookmarkCount = 0;
    walkTree(snap.tree, (n) => {
      if (n.url) bookmarkCount++;
    });
    return { index, at: snap.at, reason: snap.reason, bookmarkCount };
  });
}

/**
 * Replace the managed tree with a snapshot's state. A forced "before restore"
 * snapshot is taken first, so a restore is itself recoverable from the list.
 */
export async function restoreSnapshot(index: number): Promise<{ bookmarks: number }> {
  const { backups } = await chrome.storage.local.get("backups");
  const snap = ((backups as Snapshot[] | undefined) ?? [])[index];
  if (!snap) throw new Error("That snapshot no longer exists.");

  await snapshotNow("before restore", false, true);

  const rootId = await ensureManagedRoot();
  for (const child of await chrome.bookmarks.getChildren(rootId)) {
    if (child.url) await chrome.bookmarks.remove(child.id);
    else await chrome.bookmarks.removeTree(child.id);
  }

  let bookmarks = 0;
  const recreate = async (node: chrome.bookmarks.BookmarkTreeNode, parent: string): Promise<void> => {
    for (const child of node.children ?? []) {
      if (child.url) {
        await chrome.bookmarks.create({ parentId: parent, title: child.title, url: child.url });
        bookmarks++;
      } else {
        const folder = await chrome.bookmarks.create({ parentId: parent, title: child.title });
        await recreate(child, folder.id);
      }
    }
  };
  await recreate(snap.tree, rootId);

  await chrome.storage.local.set({ placements: snap.placements, removals: snap.removals });
  await reconcile(); // ids changed — rebind placements by URL, sources preserved
  return { bookmarks };
}

export async function clearSnapshots(): Promise<number> {
  const count = await snapshotCount();
  await chrome.storage.local.remove("backups");
  return count;
}

/** Download the whole managed tree + metadata as a JSON file the user can park anywhere. */
export async function exportBackup(): Promise<void> {
  const payload = {
    format: "tab-librarian-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    ...(await collectState()),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tab-librarian-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Merge a backup file back into the live tree. Purely additive: recreates
 * missing folders and bookmarks, never deletes or moves anything existing.
 */
export async function importBackup(file: File): Promise<{ bookmarks: number }> {
  const payload = JSON.parse(await file.text()) as {
    format?: string;
    tree?: chrome.bookmarks.BookmarkTreeNode;
  };
  const KNOWN_FORMATS = ["tab-librarian-backup", "ai-smart-tab-manager-backup"]; // old exports stay importable
  if (!KNOWN_FORMATS.includes(payload.format ?? "") || !payload.tree) {
    throw new Error("That file is not a Tab Librarian backup.");
  }

  const existing = new Set<string>();
  walkTree(await getManagedTree(), (n) => {
    if (n.url) existing.add(normalizeUrl(n.url));
  });

  let bookmarks = 0;
  const restore = async (node: chrome.bookmarks.BookmarkTreeNode, path: string[]): Promise<void> => {
    for (const child of node.children ?? []) {
      if (child.url) {
        if (existing.has(normalizeUrl(child.url))) continue;
        const folderId = await ensureFolderPath(path);
        await chrome.bookmarks.create({ parentId: folderId, title: child.title, url: child.url });
        bookmarks++;
      } else {
        await ensureFolderPath([...path, child.title]);
        await restore(child, [...path, child.title]);
      }
    }
  };
  await restore(payload.tree, []);
  return { bookmarks };
}
