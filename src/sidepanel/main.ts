import type { DisplayMessage, OpenTabInfo, Proposal, ProposalFolderEntry, Provider, Settings } from "../types";
import {
  applyProposal,
  deleteFolderDeep,
  ensureFolderPath,
  ensureManagedRoot,
  fileTabManually,
  getManagedTree,
  listFolders,
  moveBookmark,
  moveFolderNode,
  openFolderTabs,
  reconcile,
  removeManagedBookmark,
  restoreDeletedFolder,
  restoreRemovedBookmark,
  revertApply,
  unfileQuietly,
} from "./bookmarks";
import {
  clearSnapshots,
  exportBackup,
  importBackup,
  listSnapshots,
  restoreSnapshot,
  snapshotCount,
  snapshotNow,
} from "./backup";
import { friendlyApiError, isAbortError, runChatTurn, testApiKey, type ApiMessage } from "./llm";
import {
  clearSessionState,
  getPlacements,
  getRemovals,
  getSessionState,
  getSettings,
  saveSettings,
  setSessionState,
} from "./storage";
import { isLocalFileUrl, isSortableUrl, normalizeUrl } from "./urls";

// ---------- state ----------

type View = "home" | "review" | "setup";

let currentView: View = "home";
let apiHistory: ApiMessage[] = [];
let displayMessages: DisplayMessage[] = [];
let pendingProposal: Proposal | null = null;
/** url → folder path of the previous proposal — the baseline the diff view compares against. */
let prevProposalMap: Record<string, string> | null = null;
let stopCurrentTurn: (() => void) | null = null;
let busy = false;
let applying = false;
let firstRun = false;
let searchQuery = "";
// Expansion state survives re-renders — this is what keeps the tree from
// collapsing every time something updates.
const openFolders = new Set<string>();
const openDomains = new Set<string>();

type DragPayload =
  | { kind: "tab"; title: string; url: string }
  | { kind: "bookmark"; id: string; url: string; title: string }
  | { kind: "folder"; id: string; title: string };

function readDragPayload(dt: DataTransfer | null): DragPayload | null {
  if (!dt) return null;
  const raw = dt.getData("application/json");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<DragPayload> & { url?: string; title?: string };
      if (parsed.kind === "tab" || parsed.kind === "bookmark" || parsed.kind === "folder") {
        return parsed as DragPayload;
      }
      if (typeof parsed.url === "string") {
        return { kind: "tab", title: parsed.title ?? parsed.url, url: parsed.url };
      }
    } catch {
      /* fall through */
    }
  }
  const plain = dt.getData("text/plain");
  if (plain && isSortableUrl(plain)) return { kind: "tab", title: plain, url: plain };
  return null;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------- navigation ----------

function showView(view: View): void {
  currentView = view;
  for (const v of ["home", "review", "setup"] as const) {
    $(`view-${v}`).hidden = v !== view;
  }
  if (view === "home") {
    void refreshAll();
    scrollChatToBottom();
  }
}

function isDrawerOpen(): boolean {
  return !$("chatDrawer").classList.contains("collapsed");
}

function setDrawer(open: boolean): void {
  $("chatDrawer").classList.toggle("collapsed", !open);
  $("drawerToggle").title = open ? "Collapse chat" : "Expand chat";
  if (open) scrollChatToBottom();
  void setSessionState("chatOpen", open);
}

function setPanel(id: "unsortedPanel" | "foldersPanel", open: boolean): void {
  $(id).classList.toggle("open", open);
  void setSessionState(id, open);
}

function scrollChatToBottom(): void {
  const messages = $("messages");
  messages.scrollTop = messages.scrollHeight;
}

// ---------- data helpers ----------

async function getOpenTabs(): Promise<OpenTabInfo[]> {
  const settings = await getSettings();
  const tabs = await chrome.tabs.query(settings.includeAllWindows ? {} : { currentWindow: true });
  const placements = await getPlacements();
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
    .map(({ tab, url }) => ({
      tabId: tab.id!,
      windowId: tab.windowId,
      title: tab.title || url,
      url,
      pinned: tab.pinned,
      sorted: normalizeUrl(url) in placements,
    }));
}

async function buildContextBlock(): Promise<string> {
  const [tree, placements, removals, tabs] = await Promise.all([
    getManagedTree(),
    getPlacements(),
    getRemovals(),
    getOpenTabs(),
  ]);

  const folders: string[] = [];
  const bookmarks: {
    url: string;
    title: string;
    folder: string;
    source: string;
    addedDaysAgo?: number;
  }[] = [];
  const walk = (node: chrome.bookmarks.BookmarkTreeNode, path: string[]) => {
    for (const child of node.children ?? []) {
      if (child.url) {
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

  const removedByUser = Object.entries(removals).map(([url, r]) => ({
    url,
    removedFromFolder: r.folderPath,
  }));

  const state = {
    openTabs: tabs.map((t) => ({
      title: t.title,
      url: t.url,
      sorted: t.sorted,
      pinned: t.pinned || undefined,
    })),
    existingFolders: folders,
    existingBookmarks: bookmarks,
    removedByUser,
  };

  return `<CURRENT STATE>\n${JSON.stringify(state, null, 1)}\n</CURRENT STATE>`;
}

async function persistChat(): Promise<void> {
  await setSessionState("apiHistory", apiHistory);
  await setSessionState("displayMessages", displayMessages);
  await setSessionState("pendingProposal", pendingProposal);
  await setSessionState("prevProposalMap", prevProposalMap);
}

function proposalMap(proposal: Proposal): Record<string, string> {
  const map: Record<string, string> = {};
  for (const folder of proposal.folders) {
    for (const tab of folder.tabs) map[normalizeUrl(tab.url)] = folder.path.join("/");
  }
  return map;
}

function domainOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return "local file";
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Deterministic hue from a domain so each site gets a stable letter avatar. */
function makeAvatar(url: string, size = 32): HTMLElement {
  const domain = domainOf(url);
  let hash = 0;
  for (let i = 0; i < domain.length; i++) hash = (hash * 31 + domain.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  const el = document.createElement("div");
  el.className = "avatar";
  el.style.background = `hsl(${hue}, 55%, 48%)`;
  el.style.width = el.style.height = `${size}px`;
  el.style.fontSize = `${Math.round(size * 0.45)}px`;
  el.textContent = (domain[0] ?? "?").toUpperCase();
  return el;
}

/** Real site favicon via Chrome's _favicon endpoint; letter avatar outside an extension context. */
function makeIcon(url: string, size = 32): HTMLElement {
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    const img = document.createElement("img");
    img.className = "site-icon";
    img.style.width = img.style.height = `${size}px`;
    img.alt = "";
    img.src = chrome.runtime.getURL(
      `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=${size >= 24 ? 32 : 16}`
    );
    img.addEventListener("error", () => img.replaceWith(makeAvatar(url, size)));
    return img;
  }
  return makeAvatar(url, size);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** Action toast: shows for 5s; pass `undo` to render an Undo button. */
function showToast(text: string, undo?: () => Promise<void>): void {
  const toast = $("toast");
  clearTimeout(toastTimer);
  toast.replaceChildren();

  const label = document.createElement("span");
  label.className = "toast-text";
  label.textContent = text;
  toast.appendChild(label);

  if (undo) {
    const btn = document.createElement("button");
    btn.className = "undo-btn";
    btn.textContent = "Undo";
    btn.addEventListener("click", () => {
      clearTimeout(toastTimer);
      toast.hidden = true;
      void (async () => {
        try {
          await undo();
          showToast("Undone ✓");
        } catch (err) {
          showToast(`Undo failed: ${err instanceof Error ? err.message : err}`);
        }
        await refreshAll();
      })();
    });
    toast.appendChild(btn);
  }

  toast.hidden = false;
  toastTimer = setTimeout(() => (toast.hidden = true), 5000);
}

function matchesQuery(text: string): boolean {
  return !searchQuery || text.toLowerCase().includes(searchQuery.toLowerCase());
}

/** Option label with tree indentation — folders read as a hierarchy, not paths. */
function folderOptionLabel(path: string[]): string {
  const depth = path.length - 1;
  return depth === 0 ? path[0]! : `${"   ".repeat(depth)}└ ${path[path.length - 1]}`;
}

function makeFolderSelect(
  folders: { id: string; path: string[] }[],
  onPick: (folderId: string) => void
): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "inline-select";
  const placeholder = document.createElement("option");
  placeholder.textContent = "Choose a folder…";
  placeholder.value = "";
  select.appendChild(placeholder);
  for (const folder of folders) {
    const opt = document.createElement("option");
    opt.value = folder.id;
    opt.textContent = folderOptionLabel(folder.path);
    opt.title = folder.path.join(" / ");
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    if (select.value) onPick(select.value);
  });
  return select;
}

/** Undo helper for closed tabs; local files can be blocked by the browser. */
async function reopenTabs(urls: string[]): Promise<void> {
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
async function openOrFocusTab(url: string): Promise<void> {
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

/** Toggle an inline folder select right after `anchor`; only one open at a time. */
function toggleFolderSelect(
  anchor: HTMLElement,
  folders: { id: string; path: string[] }[],
  onPick: (folderId: string) => void
): void {
  const existing = anchor.nextElementSibling;
  if (existing?.classList.contains("inline-select")) {
    existing.remove();
    return;
  }
  document.querySelectorAll(".inline-select").forEach((el) => el.remove());
  const select = makeFolderSelect(folders, onPick);
  anchor.after(select);
  select.focus();
}

// ---------- chat ----------

function addDisplayMessage(msg: DisplayMessage): HTMLElement {
  displayMessages.push(msg);
  const el = renderMessage(msg);
  return el;
}

function renderMessage(msg: DisplayMessage): HTMLElement {
  $("messages").querySelector(".chat-empty")?.remove();
  const el = document.createElement("div");
  el.className = `msg ${msg.role}`;
  el.textContent = msg.text;
  $("messages").appendChild(el);
  scrollChatToBottom();
  return el;
}

function renderAllMessages(): void {
  const container = $("messages");
  container.replaceChildren();
  if (!displayMessages.length) {
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.innerHTML =
      '<span class="big-emoji">🗂️</span>Tell me how you think about your tabs — projects, topics, whatever fits — and I\'ll propose a folder structure. Or start with a quick action below.';
    container.appendChild(empty);
    return;
  }
  for (const msg of displayMessages) renderMessage(msg);
}

async function sendChat(userText: string): Promise<void> {
  if (busy || !userText.trim()) return;
  const settings = await getSettings();
  if (!settings.apiKey) {
    openSetup(false);
    return;
  }

  busy = true;
  setBusyUi(true);
  addDisplayMessage({ role: "user", text: userText });

  const context = await buildContextBlock();
  apiHistory.push({ role: "user", content: `${userText}\n\n${context}` });

  const bubble = renderMessage({ role: "assistant", text: "Thinking…" });
  let streamed = "";

  try {
    const result = await runChatTurn({
      settings,
      history: apiHistory,
      onDelta: (delta) => {
        streamed += delta;
        bubble.textContent = streamed;
        scrollChatToBottom();
      },
      registerStop: (stop) => {
        stopCurrentTurn = stop;
      },
    });

    if (result.refusal) {
      apiHistory.pop(); // keep history clean of the refused turn
      bubble.remove();
      addDisplayMessage({ role: "status", text: `Declined: ${result.refusal}` });
    } else {
      apiHistory.push(...result.appendToHistory);
      const finalText =
        result.text.trim() || (result.proposal ? "Here's my proposal — tap Review to check it." : "(no reply)");
      bubble.textContent = finalText;
      displayMessages.push({ role: "assistant", text: finalText });
      if (result.proposal) {
        // diff baseline: the proposal this one replaces
        if (pendingProposal) prevProposalMap = proposalMap(pendingProposal);
        pendingProposal = result.proposal;
        ($("onlyChangesToggle") as HTMLInputElement).checked = !!prevProposalMap;
        renderReview();
      }
    }
  } catch (err) {
    apiHistory.pop(); // request failed or was stopped — drop the unanswered user turn
    bubble.remove();
    addDisplayMessage({
      role: "status",
      text: isAbortError(err) ? "Stopped — nothing was changed." : friendlyApiError(err),
    });
  } finally {
    stopCurrentTurn = null;
    busy = false;
    setBusyUi(false);
    updateProposalUi();
    await persistChat();
  }
}

function setBusyUi(isBusy: boolean): void {
  const sendBtn = $("sendBtn") as HTMLButtonElement;
  sendBtn.textContent = isBusy ? "■" : "↑";
  sendBtn.title = isBusy ? "Stop generating" : "Send";
  sendBtn.classList.toggle("stopmode", isBusy);
  document.querySelectorAll<HTMLButtonElement>(".chip").forEach((b) => (b.disabled = isBusy));
}

// ---------- home: stats, unsorted, tree ----------

async function renderStats(): Promise<void> {
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
interface UnsortedEntry extends OpenTabInfo {
  dupCount: number;
  tabIds: number[];
}

function makeTabRow(tab: UnsortedEntry, folders: { id: string; path: string[] }[]): HTMLElement {
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
  const domain = document.createElement("div");
  domain.className = "tab-domain";
  domain.textContent = domainOf(tab.url);
  text.append(title, domain);
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
        openFolders.add(folderId);
        showToast("Moved ✓", () => unfileQuietly(tab.url));
        await refreshAll();
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
    await chrome.tabs.remove(tab.tabIds);
    showToast(count > 1 ? `Closed ${count} duplicate tabs` : "Tab closed", () =>
      reopenTabs(Array.from({ length: count }, () => tab.url))
    );
    await refreshAll();
  });
  row.appendChild(close);

  return row;
}

function makeDomainGroup(
  domain: string,
  tabs: UnsortedEntry[],
  folders: { id: string; path: string[] }[]
): HTMLElement {
  const details = document.createElement("details");
  details.className = "domain-group";
  details.open = !!searchQuery || openDomains.has(domain);
  details.addEventListener("toggle", () => {
    if (searchQuery) return; // search auto-expansion shouldn't be remembered
    if (details.open) openDomains.add(domain);
    else openDomains.delete(domain);
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
      await chrome.tabs.remove(tabs.flatMap((t) => t.tabIds));
      showToast(`Closed ${urls.length} tabs`, () => reopenTabs(urls));
      await refreshAll();
    })();
  });
  summary.appendChild(closeAll);

  details.appendChild(summary);
  for (const tab of tabs) details.appendChild(makeTabRow(tab, folders));
  return details;
}

async function renderUnsorted(): Promise<void> {
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

  const visible = allUnsorted.filter((t) => matchesQuery(`${t.title} ${t.url}`));
  if (!visible.length) return note("No unsorted tabs match your search.");

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

function countBookmarks(node: chrome.bookmarks.BookmarkTreeNode): number {
  return (node.children ?? []).reduce((acc, c) => acc + (c.url ? 1 : countBookmarks(c)), 0);
}

async function renderTree(): Promise<void> {
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

  const query = searchQuery.toLowerCase();

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
    text.appendChild(title);
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
      await refreshAll();
    });
    row.appendChild(remove);
    return row;
  };

  const renderFolder = (node: chrome.bookmarks.BookmarkTreeNode): HTMLElement | null => {
    const nameMatch = !!query && node.title.toLowerCase().includes(query);
    const childEls: HTMLElement[] = [];
    for (const child of node.children ?? []) {
      if (child.url) {
        if (!query || nameMatch || `${child.title} ${child.url}`.toLowerCase().includes(query)) {
          childEls.push(makeBookmarkRow(child));
        }
      } else {
        const el = renderFolder(child);
        if (el) childEls.push(el);
      }
    }
    if (query && !nameMatch && !childEls.length) return null;

    const details = document.createElement("details");
    // collapsed by default, but re-renders keep the user's expansion state
    details.open = !!query || openFolders.has(node.id);
    details.addEventListener("toggle", () => {
      if (query) return;
      if (details.open) openFolders.add(node.id);
      else openFolders.delete(node.id);
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
        await refreshAll();
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
    count.textContent = String(bookmarkTotal);
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
            await chrome.tabs.remove(tabIds).catch(() => {});
          });
          await refreshAll();
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
          openFolders.add(node.id);
          await refreshAll();
        }
      });
      details.open = true;
      openFolders.add(node.id);
      summary.after(input);
      input.focus();
    });
    summary.appendChild(addSub);

    // ✕ delete folder (with contents); non-empty folders need a confirming second tap
    const del = document.createElement("button");
    del.className = "mini-btn danger-hover";
    del.title = "Delete folder and its contents";
    del.textContent = "✕";
    let delArmed = false;
    del.addEventListener("click", (e) => {
      stopThrough(e);
      const hasContents = (node.children?.length ?? 0) > 0;
      if (hasContents && !delArmed) {
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
        await refreshAll();
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
      openFolders.add(node.id);
      await refreshAll();
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
    note.textContent = "No bookmarks match your search.";
    container.appendChild(note);
  }
}

// ---------- proposal review ----------

interface ReviewNode {
  children: Map<string, ReviewNode>;
  tabs: { url: string; title: string }[];
}

function buildReviewTree(folders: ProposalFolderEntry[]): ReviewNode {
  const root: ReviewNode = { children: new Map(), tabs: [] };
  for (const folder of folders) {
    let node = root;
    for (const part of folder.path) {
      if (!node.children.has(part)) node.children.set(part, { children: new Map(), tabs: [] });
      node = node.children.get(part)!;
    }
    node.tabs.push(...folder.tabs);
  }
  return root;
}

function updateProposalUi(): void {
  const has = !!pendingProposal;
  $("proposalBanner").hidden = !has;
  $("resumeReviewBtn").hidden = !has;
}

function renderReview(): void {
  updateProposalUi();
  if (!pendingProposal) return;

  const base = prevProposalMap;
  $("reviewControls").hidden = !base;
  const onlyChanges = !!base && ($("onlyChangesToggle") as HTMLInputElement).checked;

  const statusOf = (url: string, path: string): "new" | "moved" | "same" => {
    if (!base) return "same";
    const prev = base[normalizeUrl(url)];
    if (prev === undefined) return "new";
    return prev === path ? "same" : "moved";
  };

  const treeEl = $("reviewTree");
  treeEl.replaceChildren();

  const totalTabs = (node: ReviewNode): number =>
    node.tabs.length + [...node.children.values()].reduce((acc, c) => acc + totalTabs(c), 0);

  const renderNode = (name: string, node: ReviewNode, path: string[]): HTMLElement | null => {
    const fullPath = [...path, name].join("/");

    const rows: HTMLElement[] = [];
    for (const tab of node.tabs) {
      const status = statusOf(tab.url, fullPath);
      if (onlyChanges && status === "same") continue;
      const row = document.createElement("div");
      row.className = "review-tab";
      const lbl = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.dataset.url = normalizeUrl(tab.url);
      const text = document.createElement("span");
      text.textContent = tab.title || tab.url;
      text.title = tab.url;
      const icon = makeIcon(tab.url, 18);
      icon.classList.add("clickable-icon");
      icon.title = "Open this tab";
      icon.addEventListener("click", (e) => {
        e.preventDefault(); // inside the label — don't toggle the checkbox
        e.stopPropagation();
        void openOrFocusTab(tab.url);
      });
      lbl.append(cb, icon, text);
      if (base && status !== "same") {
        const badge = document.createElement("span");
        badge.className = `diff-badge ${status}`;
        badge.textContent = status;
        lbl.appendChild(badge);
      }
      row.appendChild(lbl);
      rows.push(row);
    }

    const childEls: HTMLElement[] = [];
    for (const [childName, child] of node.children) {
      const el = renderNode(childName, child, [...path, name]);
      if (el) childEls.push(el);
    }
    if (onlyChanges && !rows.length && !childEls.length) return null;

    const details = document.createElement("details");
    details.open = true;
    const summary = document.createElement("summary");
    const chev = document.createElement("span");
    chev.className = "chev";
    chev.textContent = "▶";

    // master checkbox: accept/reject this whole folder at once
    const master = document.createElement("input");
    master.type = "checkbox";
    master.checked = true;
    master.className = "master-check";
    master.title = "Toggle everything in this folder";
    master.addEventListener("click", (e) => e.stopPropagation());
    master.addEventListener("change", () => {
      details
        .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
        .forEach((cb) => (cb.checked = master.checked));
    });

    const label = document.createElement("span");
    label.className = "folder-name";
    label.textContent = `📁 ${name}`;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(totalTabs(node));
    summary.append(chev, master, label, count);
    details.appendChild(summary);
    for (const row of rows) details.appendChild(row);
    for (const el of childEls) details.appendChild(el);
    return details;
  };

  const root = buildReviewTree(pendingProposal.folders);
  for (const [name, node] of root.children) {
    const el = renderNode(name, node, []);
    if (el) treeEl.appendChild(el);
  }
  if (onlyChanges && !treeEl.childElementCount) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = "No placement changes versus the previous proposal.";
    treeEl.appendChild(note);
  }

  // proposed cleanup deletions — reviewed like everything else
  const removalsEl = $("reviewRemovals");
  removalsEl.replaceChildren();
  const removals = pendingProposal.removals ?? [];
  if (removals.length) {
    const head = document.createElement("div");
    head.className = "removal-head";
    head.textContent = `🗑 Proposed removals (${removals.length})`;
    removalsEl.appendChild(head);
    for (const removal of removals) {
      const row = document.createElement("div");
      row.className = "removal-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.dataset.removeUrl = normalizeUrl(removal.url);
      const text = document.createElement("div");
      text.className = "removal-text";
      const title = document.createElement("div");
      title.className = "removal-title";
      title.textContent = removal.url;
      title.title = "Open this tab";
      title.addEventListener("click", () => void openOrFocusTab(removal.url));
      const reason = document.createElement("div");
      reason.className = "removal-reason";
      reason.textContent = removal.reason;
      text.append(title, reason);
      row.append(cb, makeIcon(removal.url, 18), text);
      removalsEl.appendChild(row);
    }
  }

  const questionsEl = $("reviewQuestions");
  questionsEl.replaceChildren();
  const questions = pendingProposal.questions ?? [];
  for (const q of questions) {
    const div = document.createElement("div");
    div.className = "question";
    const question = document.createElement("div");
    question.textContent = `❓ ${q.question}`;
    const url = document.createElement("div");
    url.className = "q-url";
    url.textContent = q.url;
    url.title = "Open this tab";
    url.addEventListener("click", () => void openOrFocusTab(q.url));

    const controls = document.createElement("div");
    controls.className = "q-controls";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "answer-input";
    input.placeholder = "Type an answer…";
    input.dataset.q = q.question;
    input.dataset.url = q.url;
    input.addEventListener("input", updateSendAnswersState);

    // knows-the-answer shortcut: file it directly, no AI round trip needed
    const fileBtn = document.createElement("button");
    fileBtn.className = "add-btn";
    fileBtn.title = "Skip the question — file this tab into a folder now";
    fileBtn.textContent = "⤷";
    fileBtn.addEventListener("click", async () => {
      const folders = await listFolders();
      toggleFolderSelect(controls, folders, (folderId) => {
        void (async () => {
          const tabs = await getOpenTabs();
          const title = tabs.find((t) => normalizeUrl(t.url) === normalizeUrl(q.url))?.title ?? q.url;
          await fileTabManually({ title, url: q.url }, folderId);
          if (pendingProposal) {
            pendingProposal.questions = pendingProposal.questions.filter((x) => x !== q);
            await persistChat();
          }
          showToast("Filed ✓ — question resolved", () => unfileQuietly(q.url));
          renderReview();
        })();
      });
    });

    controls.append(input, fileBtn);
    div.append(question, url, controls);
    questionsEl.appendChild(div);
  }

  if (questions.length) {
    const send = document.createElement("button");
    send.id = "sendAnswersBtn";
    send.className = "btn primary";
    send.textContent = "Send answers to AI";
    send.disabled = true;
    send.addEventListener("click", () => {
      const answers = [...document.querySelectorAll<HTMLInputElement>(".answer-input")]
        .filter((i) => i.value.trim())
        .map((i) => `- "${i.dataset.q}" (${i.dataset.url}) → ${i.value.trim()}`);
      if (!answers.length) return;
      showView("home");
      setDrawer(true);
      void sendChat(
        `Answers to your questions:\n${answers.join("\n")}\nPlease update the proposal accordingly.`
      );
    });
    questionsEl.appendChild(send);
  }
}

function updateSendAnswersState(): void {
  const btn = document.getElementById("sendAnswersBtn") as HTMLButtonElement | null;
  if (!btn) return;
  btn.disabled = ![...document.querySelectorAll<HTMLInputElement>(".answer-input")].some((i) =>
    i.value.trim()
  );
}

async function approveProposal(): Promise<void> {
  if (!pendingProposal) return;
  // The diff filter hides unchanged rows, but hidden placements are still part
  // of the proposal. Remember what the user explicitly unchecked, re-render
  // unfiltered, then include everything that wasn't excluded.
  const excludedUrls = new Set<string>();
  document
    .querySelectorAll<HTMLInputElement>("#reviewTree input[data-url]:not(:checked)")
    .forEach((cb) => cb.dataset.url && excludedUrls.add(cb.dataset.url));
  const excludedRemovals = new Set<string>();
  document
    .querySelectorAll<HTMLInputElement>("#reviewRemovals input:not(:checked)")
    .forEach((cb) => cb.dataset.removeUrl && excludedRemovals.add(cb.dataset.removeUrl));

  const included = new Set<string>();
  for (const folder of pendingProposal.folders) {
    for (const tab of folder.tabs) {
      const key = normalizeUrl(tab.url);
      if (!excludedUrls.has(key)) included.add(key);
    }
  }
  const removeUrls = new Set<string>();
  for (const removal of pendingProposal.removals ?? []) {
    const key = normalizeUrl(removal.url);
    if (!excludedRemovals.has(key)) removeUrls.add(key);
  }

  applying = true;
  ($("approveBtn") as HTMLButtonElement).disabled = true;
  try {
    await snapshotNow("before apply");
    const result = await applyProposal(pendingProposal.folders, included, removeUrls);
    let note = `Applied: ${result.created} bookmark(s) created, ${result.moved} moved.`;
    if (result.removed) note += ` ${result.removed} removed.`;
    if (result.skippedManual) note += ` ${result.skippedManual} manual placement(s) left untouched.`;
    addDisplayMessage({ role: "status", text: note });
    apiHistory.push({ role: "user", content: `(I approved the proposal and it has been applied. ${note})` });
    prevProposalMap = proposalMap(pendingProposal); // next proposal diffs against what was applied
    pendingProposal = null;
    updateProposalUi();
    showView("home");
    showToast(note, async () => {
      await revertApply(result.undo);
      apiHistory.push({ role: "user", content: "(I undid that apply — the bookmarks were reverted.)" });
      addDisplayMessage({ role: "status", text: "Apply undone — bookmarks reverted." });
      await persistChat();
    });
  } catch (err) {
    addDisplayMessage({ role: "status", text: `Apply failed: ${err instanceof Error ? err.message : err}` });
    showView("home");
    setDrawer(true);
  } finally {
    applying = false;
    ($("approveBtn") as HTMLButtonElement).disabled = false;
  }
  await persistChat();
  await refreshAll();
}

async function dismissProposal(): Promise<void> {
  if (!pendingProposal) return;
  pendingProposal = null;
  updateProposalUi();
  apiHistory.push({ role: "user", content: "(I dismissed that proposal without applying it.)" });
  addDisplayMessage({ role: "status", text: "Proposal dismissed — nothing was applied." });
  showView("home");
  setDrawer(true);
  await persistChat();
}

// ---------- setup / options ----------

function formProvider(): Provider {
  const active = document.querySelector<HTMLButtonElement>(".seg-btn.active");
  return (active?.dataset.provider as Provider) ?? "anthropic";
}

function applyProviderUi(provider: Provider): void {
  document
    .querySelectorAll<HTMLButtonElement>(".seg-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.provider === provider));
  $("workspaceField").hidden = provider !== "anthropic";
  $("baseUrlField").hidden = provider !== "openai";
  const list = $("modelList") as HTMLDataListElement;
  list.replaceChildren();
  if (provider === "anthropic") {
    for (const id of ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"]) {
      const opt = document.createElement("option");
      opt.value = id;
      list.appendChild(opt);
    }
  }
  ($("modelInput") as HTMLInputElement).placeholder =
    provider === "anthropic" ? "claude-sonnet-5" : "model id";
}

function settingsFromForm(): Settings {
  return {
    provider: formProvider(),
    apiKey: ($("apiKeyInput") as HTMLInputElement).value.trim(),
    workspaceId: ($("workspaceIdInput") as HTMLInputElement).value.trim(),
    baseUrl: ($("baseUrlInput") as HTMLInputElement).value.trim() || "https://api.openai.com/v1",
    model: ($("modelInput") as HTMLInputElement).value.trim(),
    includeAllWindows: ($("allWindowsInput") as HTMLInputElement).checked,
    includeLocalFiles: ($("includeLocalFilesInput") as HTMLInputElement).checked,
    backupsEnabled: ($("backupsEnabledInput") as HTMLInputElement).checked,
  };
}

function showFormError(message: string | null): void {
  const errorEl = $("apiKeyError");
  errorEl.textContent = message ?? "";
  errorEl.hidden = !message;
}

function validateForm(settings: Settings): string | null {
  if (!settings.apiKey) return "An API key is required.";
  if (!settings.model) {
    return settings.provider === "anthropic"
      ? "Pick a model (e.g. claude-sonnet-5)."
      : "Enter the model id your endpoint serves.";
  }
  if (settings.provider === "openai") {
    try {
      new URL(settings.baseUrl);
    } catch {
      return "Base URL is not a valid URL.";
    }
  }
  return null;
}

/** Custom endpoints need a host permission grant (must run inside a user gesture). */
async function ensureHostPermission(settings: Settings): Promise<string | null> {
  if (settings.provider !== "openai" || !chrome.permissions?.request) return null;
  const origin = `${new URL(settings.baseUrl).origin}/*`;
  try {
    const granted = await chrome.permissions.request({ origins: [origin] });
    return granted ? null : `Access to ${origin} was declined — the endpoint can't be reached without it.`;
  } catch (err) {
    return `Could not request access to ${origin}: ${err instanceof Error ? err.message : err}`;
  }
}

function openSetup(asOptions: boolean): void {
  $("setupBackBtn").hidden = !asOptions;
  $("setupTitle").textContent = asOptions ? "Options" : "Welcome";
  $("setupIntro").hidden = asOptions;
  showFormError(null);
  $("testResult").hidden = true;
  void getSettings().then((s) => {
    applyProviderUi(s.provider);
    ($("apiKeyInput") as HTMLInputElement).value = s.apiKey;
    ($("workspaceIdInput") as HTMLInputElement).value = s.workspaceId;
    ($("baseUrlInput") as HTMLInputElement).value = s.baseUrl;
    ($("modelInput") as HTMLInputElement).value = s.model;
    ($("allWindowsInput") as HTMLInputElement).checked = s.includeAllWindows;
    ($("includeLocalFilesInput") as HTMLInputElement).checked = s.includeLocalFiles;
    ($("backupsEnabledInput") as HTMLInputElement).checked = s.backupsEnabled;
  });
  void snapshotCount().then((n) => {
    $("clearBackupsBtn").textContent = `🗑 Clear (${n})`;
  });
  void renderSnapshotList();
  showView("setup");
}

async function renderSnapshotList(): Promise<void> {
  const listEl = $("snapshotList");
  listEl.replaceChildren();
  const snaps = (await listSnapshots()).reverse(); // newest first
  if (!snaps.length) return;

  for (const snap of snaps) {
    const row = document.createElement("div");
    row.className = "snap-row";
    const text = document.createElement("span");
    text.className = "snap-text";
    text.textContent = `${new Date(snap.at).toLocaleString()} · ${snap.reason} · ${snap.bookmarkCount} bookmarks`;
    row.appendChild(text);

    const restore = document.createElement("button");
    restore.className = "btn ghost";
    restore.textContent = "Restore";
    let armed = false;
    restore.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        restore.textContent = "Replace tree?";
        setTimeout(() => {
          armed = false;
          restore.textContent = "Restore";
        }, 3000);
        return;
      }
      void (async () => {
        try {
          const result = await restoreSnapshot(snap.index);
          showToast(`Restored ${result.bookmarks} bookmarks — the replaced state was snapshotted first`);
          await refreshAll();
          await renderSnapshotList();
          const n = await snapshotCount();
          $("clearBackupsBtn").textContent = `🗑 Clear (${n})`;
        } catch (err) {
          showToast(`Restore failed: ${err instanceof Error ? err.message : err}`);
        }
      })();
    });
    row.appendChild(restore);
    listEl.appendChild(row);
  }
}

async function testConnectionFromForm(): Promise<void> {
  const settings = settingsFromForm();
  const invalid = validateForm(settings);
  const resultEl = $("testResult");
  if (invalid) {
    showFormError(invalid);
    return;
  }
  showFormError(null);
  const permissionError = await ensureHostPermission(settings);
  if (permissionError) {
    showFormError(permissionError);
    return;
  }
  const btn = $("testKeyBtn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Testing…";
  resultEl.hidden = true;
  const test = await testApiKey(settings);
  btn.disabled = false;
  btn.textContent = "🔌 Test connection";
  resultEl.textContent = test.ok ? "✓ Connection and model look good." : `✗ ${test.message}`;
  resultEl.hidden = false;
}

async function saveSettingsFromForm(): Promise<void> {
  const settings = settingsFromForm();
  const invalid = validateForm(settings);
  if (invalid) {
    showFormError(invalid);
    return;
  }
  showFormError(null);
  const permissionError = await ensureHostPermission(settings);
  if (permissionError) {
    showFormError(permissionError);
    return;
  }
  await saveSettings(settings);
  firstRun = false;
  showView("home");
  showToast("Settings saved ✓");
}

// ---------- new folder form ----------

async function populateParentSelect(): Promise<void> {
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

async function createFolderFromForm(): Promise<void> {
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
  await refreshAll();
}

// ---------- refresh & events ----------

let refreshQueued = false;
async function refreshAll(): Promise<void> {
  if (refreshQueued) return;
  refreshQueued = true;
  tabsDirty = false; // a full refresh supersedes any pending dirty work
  bookmarksDirty = false;
  lastFullRefresh = Date.now();
  try {
    await reconcile();
    await Promise.all([renderStats(), renderTree(), renderUnsorted()]);
  } finally {
    refreshQueued = false;
  }
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

// Browser events only mark state dirty; a 2-second poll does the actual
// re-render, and only for the parts that changed. This caps UI work no matter
// how noisy tab events get (page loads, title flickers, etc.).
let tabsDirty = false;
let bookmarksDirty = false;
let pollRunning = false;

// Drag state must self-expire: when a drop re-renders the list, the dragged
// row is detached before its dragend can bubble to document, so a plain
// boolean latches true forever and silently freezes all updates.
let dragLastSeen = 0;
document.addEventListener("dragstart", () => (dragLastSeen = Date.now()));
document.addEventListener("dragover", () => (dragLastSeen = Date.now()));
document.addEventListener("dragend", () => (dragLastSeen = 0));
document.addEventListener("drop", () => (dragLastSeen = 0));

function interactionInProgress(): boolean {
  const dragging = dragLastSeen !== 0 && Date.now() - dragLastSeen < 1500;
  return dragging || !!document.querySelector(".inline-select, .subfolder-input, .rename-input");
}

let lastFullRefresh = 0;

async function pollDirty(): Promise<void> {
  if (pollRunning || applying || currentView !== "home" || interactionInProgress()) return;
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

// ---------- init ----------

async function init(): Promise<void> {
  await ensureManagedRoot();

  apiHistory = (await getSessionState<ApiMessage[]>("apiHistory")) ?? [];
  displayMessages = (await getSessionState<DisplayMessage[]>("displayMessages")) ?? [];
  pendingProposal = (await getSessionState<Proposal | null>("pendingProposal")) ?? null;
  prevProposalMap = (await getSessionState<Record<string, string> | null>("prevProposalMap")) ?? null;

  renderAllMessages();
  renderReview();
  updateProposalUi();
  setDrawer((await getSessionState<boolean>("chatOpen")) ?? false);
  setPanel("unsortedPanel", (await getSessionState<boolean>("unsortedPanel")) ?? true);
  setPanel("foldersPanel", (await getSessionState<boolean>("foldersPanel")) ?? true);
  void snapshotNow("routine", true); // rolling safety net, at most every ~6h
  await refreshAll();

  const settings = await getSettings();
  if (!settings.apiKey) {
    firstRun = true;
    openSetup(false);
  }

  // search
  const searchInput = $("searchInput") as HTMLInputElement;
  searchInput.addEventListener(
    "input",
    debounce(() => {
      searchQuery = searchInput.value.trim();
      void Promise.all([renderTree(), renderUnsorted()]);
    }, 150)
  );

  // navigation
  $("optionsBtn").addEventListener("click", () => openSetup(true));
  $("setupBackBtn").addEventListener("click", () => showView("home"));
  $("startSortBtn").addEventListener("click", () => {
    setDrawer(true);
    ($("chatInput") as HTMLTextAreaElement).focus();
  });
  $("drawerToggle").addEventListener("click", () => setDrawer(!isDrawerOpen()));
  document.querySelectorAll<HTMLButtonElement>(".panel-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.panel as "unsortedPanel" | "foldersPanel";
      setPanel(id, !$(id).classList.contains("open"));
    });
  });
  $("closeSortedBtn").addEventListener("click", async () => {
    const sorted = (await getOpenTabs()).filter((t) => t.sorted);
    if (!sorted.length) return;
    const urls = sorted.map((t) => t.url);
    await chrome.tabs.remove(sorted.map((t) => t.tabId));
    showToast(`Closed ${sorted.length} sorted tab${sorted.length === 1 ? "" : "s"}`, () =>
      reopenTabs(urls)
    );
    await refreshAll();
  });
  $("openReviewBtn").addEventListener("click", () => {
    renderReview();
    showView("review");
  });
  $("resumeReviewBtn").addEventListener("click", () => {
    renderReview();
    showView("review");
  });
  $("reviewBackBtn").addEventListener("click", () => {
    showView("home");
    setDrawer(true);
  });

  // setup / options
  $("saveSettingsBtn").addEventListener("click", () => void saveSettingsFromForm());
  $("testKeyBtn").addEventListener("click", () => void testConnectionFromForm());
  document.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => applyProviderUi(btn.dataset.provider as Provider));
  });
  $("exportBackupBtn").addEventListener("click", () => void exportBackup());
  $("clearBackupsBtn").addEventListener("click", async () => {
    const cleared = await clearSnapshots();
    $("clearBackupsBtn").textContent = "🗑 Clear (0)";
    await renderSnapshotList();
    showToast(`Cleared ${cleared} snapshot${cleared === 1 ? "" : "s"}`);
  });
  $("onlyChangesToggle").addEventListener("change", () => renderReview());
  $("importBackupBtn").addEventListener("click", () => ($("importBackupFile") as HTMLInputElement).click());
  $("importBackupFile").addEventListener("change", async () => {
    const input = $("importBackupFile") as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      await snapshotNow("before import");
      const result = await importBackup(file);
      showView("home");
      showToast(`Import merged ${result.bookmarks} bookmark${result.bookmarks === 1 ? "" : "s"} ✓`);
      await refreshAll();
    } catch (err) {
      showToast(`Import failed: ${err instanceof Error ? err.message : err}`);
    }
  });

  // chat
  $("newChatBtn").addEventListener("click", async () => {
    apiHistory = [];
    displayMessages = [];
    pendingProposal = null;
    await clearSessionState(["apiHistory", "displayMessages", "pendingProposal"]);
    renderAllMessages();
    updateProposalUi();
  });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy) {
      stopCurrentTurn?.(); // the send button doubles as Stop while generating
      return;
    }
    const input = $("chatInput") as HTMLTextAreaElement;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    void sendChat(text);
  });
  ($("chatInput") as HTMLTextAreaElement).addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ($("composer") as HTMLFormElement).requestSubmit();
    }
  });
  document.querySelectorAll<HTMLButtonElement>(".chip").forEach((btn) => {
    btn.addEventListener("click", () => void sendChat(btn.dataset.quick!));
  });

  // review
  $("approveBtn").addEventListener("click", () => void approveProposal());
  $("dismissBtn").addEventListener("click", () => void dismissProposal());

  // new folder
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

  // keep the panel in sync with the world: events mark dirty, the poll renders
  const markBookmarksDirty = () => {
    bookmarksDirty = true;
    tabsDirty = true; // sorted/unsorted status derives from bookmarks
  };
  chrome.bookmarks.onCreated.addListener(markBookmarksDirty);
  chrome.bookmarks.onRemoved.addListener(markBookmarksDirty);
  chrome.bookmarks.onMoved.addListener(markBookmarksDirty);
  chrome.bookmarks.onChanged.addListener(markBookmarksDirty);
  chrome.tabs.onCreated.addListener(() => (tabsDirty = true));
  chrome.tabs.onRemoved.addListener(() => (tabsDirty = true));
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

void init();
