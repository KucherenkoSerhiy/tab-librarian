// DOM helpers shared by every view: element lookup, icons, toast, debounce.
import { requestRefresh } from "../app/bus";

export const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export function scrollChatToBottom(): void {
  const messages = $("messages");
  messages.scrollTop = messages.scrollHeight;
}


import { domainOf } from "../domain/urls";
export { domainOf };

/** Deterministic hue from a domain so each site gets a stable letter avatar. */
export function makeAvatar(url: string, size = 32): HTMLElement {
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
export function makeIcon(url: string, size = 32): HTMLElement {
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
export function showToast(text: string, undo?: () => Promise<void>): void {
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
        await requestRefresh();
      })();
    });
    toast.appendChild(btn);
  }

  toast.hidden = false;
  toastTimer = setTimeout(() => (toast.hidden = true), 5000);
}


export function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

