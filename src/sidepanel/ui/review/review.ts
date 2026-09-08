import { openOrFocusTabWithNotice } from "../tabActions";
// Proposal review: diff badges, questions, removals, apply/undo, dismiss.
import type { Proposal, ProposalFolderEntry } from "../../../types";
import { snapshotNow } from "../../services/backup";
import { applyProposal, fileTabManually, listFolders, unfileQuietly } from "../../services/bookmarks";
import { on, requestRefresh } from "../../app/bus";
import { addDisplayMessage, persistChat, proposalMap, sendChat } from "../chat/chat";
import { $, makeIcon, showToast } from "../dom";
import { setLastApply } from "../home/undo";
import { setDrawer, showView } from "../../app/nav";
import { toggleFolderSelect } from "../picker";
import { state } from "../../app/state";
import { getOpenTabs } from "../../services/tabs";
import { normalizeUrl } from "../../domain/urls";

// ---------- proposal review ----------

export interface ReviewNode {
  children: Map<string, ReviewNode>;
  tabs: { url: string; title: string }[];
  note?: string;
}

export function buildReviewTree(folders: ProposalFolderEntry[]): ReviewNode {
  const root: ReviewNode = { children: new Map(), tabs: [] };
  for (const folder of folders) {
    let node = root;
    for (const part of folder.path) {
      if (!node.children.has(part)) node.children.set(part, { children: new Map(), tabs: [] });
      node = node.children.get(part)!;
    }
    node.tabs.push(...folder.tabs);
    if (folder.note) node.note = folder.note;
  }
  return root;
}

export function updateProposalUi(): void {
  const has = !!state.pendingProposal;
  $("proposalBanner").hidden = !has;
  $("resumeReviewBtn").hidden = !has;
}

export function renderReview(): void {
  updateProposalUi();
  if (!state.pendingProposal) return;

  const base = state.prevProposalMap;
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
        void openOrFocusTabWithNotice(tab.url);
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
    if (node.note) {
      const note = document.createElement("div");
      note.className = "folder-note";
      note.title = "One line from the model on why these tabs are grouped here";
      note.textContent = `Why: ${node.note}`;
      details.appendChild(note);
    }
    for (const row of rows) details.appendChild(row);
    for (const el of childEls) details.appendChild(el);
    return details;
  };

  const root = buildReviewTree(state.pendingProposal.folders);
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
  const removals = state.pendingProposal.removals ?? [];
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
      title.addEventListener("click", () => void openOrFocusTabWithNotice(removal.url));
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
  const questions = state.pendingProposal.questions ?? [];
  for (const q of questions) {
    const div = document.createElement("div");
    div.className = "question";
    const question = document.createElement("div");
    question.textContent = `❓ ${q.question}`;
    const url = document.createElement("div");
    url.className = "q-url";
    url.textContent = q.url;
    url.title = "Open this tab";
    url.addEventListener("click", () => void openOrFocusTabWithNotice(q.url));

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
          if (state.pendingProposal) {
            state.pendingProposal.questions = state.pendingProposal.questions.filter((x) => x !== q);
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

export function updateSendAnswersState(): void {
  const btn = document.getElementById("sendAnswersBtn") as HTMLButtonElement | null;
  if (!btn) return;
  btn.disabled = ![...document.querySelectorAll<HTMLInputElement>(".answer-input")].some((i) =>
    i.value.trim()
  );
}

export async function approveProposal(): Promise<void> {
  if (!state.pendingProposal) return;
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
  for (const folder of state.pendingProposal.folders) {
    for (const tab of folder.tabs) {
      const key = normalizeUrl(tab.url);
      if (!excludedUrls.has(key)) included.add(key);
    }
  }
  const removeUrls = new Set<string>();
  for (const removal of state.pendingProposal.removals ?? []) {
    const key = normalizeUrl(removal.url);
    if (!excludedRemovals.has(key)) removeUrls.add(key);
  }

  state.applying = true;
  ($("approveBtn") as HTMLButtonElement).disabled = true;
  try {
    await snapshotNow("before apply");
    const applied = { folders: state.pendingProposal.folders, include: [...included], remove: [...removeUrls] };
    const result = await applyProposal(applied.folders, included, removeUrls);
    let note = `Applied: ${result.created} bookmark(s) created, ${result.moved} moved.`;
    if (result.removed) note += ` ${result.removed} removed.`;
    if (result.skippedManual) note += ` ${result.skippedManual} manual placement(s) left untouched.`;
    addDisplayMessage({ role: "status", text: note });
    state.apiHistory.push({ role: "user", content: `(I approved the proposal and it has been applied. ${note})` });
    state.prevProposalMap = proposalMap(state.pendingProposal); // next proposal diffs against what was applied
    state.pendingProposal = null;
    updateProposalUi();
    showView("home");
    const parts = [
      result.created && `${result.created} filed`,
      result.moved && `${result.moved} moved`,
      result.removed && `${result.removed} removed`,
    ].filter(Boolean);
    // the strip stays until undone, dismissed or replaced; nothing to undo → no strip
    await setLastApply(
      parts.length ? { summary: parts.join(" · "), undo: result.undo, applied, undone: false, at: Date.now() } : null
    );
    if (!parts.length) showToast(note); // nothing changed → nothing to undo; say so once
  } catch (err) {
    addDisplayMessage({ role: "status", text: `Apply failed: ${err instanceof Error ? err.message : err}` });
    showView("home");
    setDrawer(true);
  } finally {
    state.applying = false;
    ($("approveBtn") as HTMLButtonElement).disabled = false;
  }
  await persistChat();
  await requestRefresh();
}

export async function dismissProposal(): Promise<void> {
  if (!state.pendingProposal) return;
  state.pendingProposal = null;
  updateProposalUi();
  state.apiHistory.push({ role: "user", content: "(I dismissed that proposal without state.applying it.)" });
  addDisplayMessage({ role: "status", text: "Proposal dismissed — nothing was applied." });
  showView("home");
  setDrawer(true);
  await persistChat();
}


export function wireReview(): void {
  on("proposal", () => renderReview());
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
  $("onlyChangesToggle").addEventListener("change", () => renderReview());
  $("approveBtn").addEventListener("click", () => void approveProposal());
  $("dismissBtn").addEventListener("click", () => void dismissProposal());
}
