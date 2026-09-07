// The "Before sending" step: show the exact payload, wait for Send/Cancel.
import type { Settings } from "../../../types";
import type { OutgoingMap } from "../../domain/privacy";
import { getManagedTree } from "../../services/bookmarks";
import { on } from "../../app/bus";
import { $, domainOf, makeIcon, showToast } from "../dom";
import { showView } from "../../app/nav";
import { buildOutgoingMap, isExcludedUrl, outgoingKey, parseExcludedDomains } from "../../domain/privacy";
import { state } from "../../app/state";
import { getPlacements, getRemovals, getSettings, saveSettings, setSessionState } from "../../services/storage";
import { getOpenTabs } from "../../services/tabs";
import { normalizeUrl } from "../../domain/urls";

import type { Outgoing, OutgoingItem } from "../../services/payload";
import { buildOutgoing } from "../../services/payload";


let outgoingResolve: ((send: boolean) => void) | null = null;

/**
 * Show the exact payload and wait for Send/Cancel. Skipped when previews are
 * off or the same set was already approved in this session.
 */
export async function confirmOutgoing(outgoing: Outgoing, purpose: string): Promise<boolean> {
  const settings = await getSettings();
  if (!settings.previewOutgoing || outgoing.key === state.approvedOutgoingKey) return true;
  renderOutgoing(outgoing, purpose, settings);
  showView("outgoing");
  const send = await new Promise<boolean>((resolve) => (outgoingResolve = resolve));
  outgoingResolve = null;
  if (send) {
    state.approvedOutgoingKey = outgoing.key;
    await setSessionState("approvedOutgoingKey", state.approvedOutgoingKey);
  }
  showView("home");
  return send;
}

export function renderOutgoing(outgoing: Outgoing, purpose: string, settings: Settings): void {
  let providerHost = "api.anthropic.com";
  if (settings.provider !== "anthropic") {
    try {
      providerHost = new URL(settings.baseUrl).host;
    } catch {
      providerHost = settings.baseUrl;
    }
  }
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  $("outgoingSummary").textContent =
    `${purpose} will send ${plural(outgoing.tabs.length, "open tab")}, ${plural(outgoing.bookmarks.length, "bookmark")} ` +
    `and ${plural(outgoing.folderCount, "folder name")} to ${providerHost}` +
    (outgoing.excludedCount ? ` \u00b7 ${outgoing.excludedCount} kept back by your privacy rules` : "") +
    ".";
  ($("outgoingAskAgain") as HTMLInputElement).checked = settings.previewOutgoing;
  $("outgoingLibraryTitle").textContent = `Library: ${plural(outgoing.bookmarks.length, "bookmark")} (titles + URLs)`;
  ($("outgoingLibrary") as HTMLDetailsElement).open =
    outgoing.bookmarks.length > 0 && outgoing.bookmarks.length <= 12;

  const rerender = async () => {
    const fresh = await buildOutgoing();
    renderOutgoing(fresh, purpose, await getSettings());
  };
  const makeRow = (item: OutgoingItem) => {
    const row = document.createElement("div");
    row.className = "tab-row";
    row.appendChild(makeIcon(item.realUrl));
    const text = document.createElement("div");
    text.className = "tab-text";
    const title = document.createElement("div");
    title.className = "tab-title";
    title.textContent = item.title + (item.folder ? `  \u00b7  ${item.folder}` : "");
    const url = document.createElement("div");
    url.className = "sent-url";
    url.textContent = item.sentUrl;
    url.title = item.sentUrl === item.realUrl ? item.realUrl : `Sent as shown. Real URL: ${item.realUrl}`;
    text.append(title, url);
    row.appendChild(text);

    const lock = document.createElement("button");
    lock.className = "add-btn";
    lock.textContent = "🔒";
    lock.title = `Never send ${domainOf(item.realUrl)} (adds it to Options \u2192 Privacy)`;
    lock.addEventListener("click", async () => {
      const cur = await getSettings();
      const d = domainOf(item.realUrl);
      const list = parseExcludedDomains(cur.excludedDomains);
      if (!list.includes(d)) await saveSettings({ ...cur, excludedDomains: [...list, d].join("\n") });
      showToast(`${d} will never be sent`);
      await rerender();
    });
    row.appendChild(lock);

    const skipBtn = document.createElement("button");
    skipBtn.className = "remove-btn";
    skipBtn.textContent = "\u2715";
    skipBtn.title = "Don't send this one (for this conversation)";
    skipBtn.addEventListener("click", async () => {
      state.sessionExcludedUrls.add(normalizeUrl(item.realUrl));
      await setSessionState("sessionExcludedUrls", [...state.sessionExcludedUrls]);
      await rerender();
    });
    row.appendChild(skipBtn);
    return row;
  };

  const tabsEl = $("outgoingTabs");
  tabsEl.replaceChildren();
  if (!outgoing.tabs.length) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = "No open tabs will be sent.";
    tabsEl.appendChild(note);
  }
  for (const item of outgoing.tabs) tabsEl.appendChild(makeRow(item));
  const bmEl = $("outgoingBookmarks");
  bmEl.replaceChildren();
  for (const item of outgoing.bookmarks) bmEl.appendChild(makeRow(item));
}


export function wireOutgoing(): void {
  const decide = (send: boolean) => outgoingResolve?.(send);
  $("outgoingSendBtn").addEventListener("click", () => decide(true));
  $("outgoingCancelBtn").addEventListener("click", () => decide(false));
  $("outgoingBackBtn").addEventListener("click", () => decide(false));
  $("outgoingAskAgain").addEventListener("change", async (e) => {
    const on = (e.target as HTMLInputElement).checked;
    await saveSettings({ ...(await getSettings()), previewOutgoing: on });
  });
}

