// Drag-and-drop payload parsing + the "is the user mid-interaction?" signal that
// keeps the poll from re-rendering under a drag or an open picker.
import { isSortableUrl } from "./urls";

export type DragPayload =
  | { kind: "tab"; title: string; url: string }
  | { kind: "bookmark"; id: string; url: string; title: string }
  | { kind: "folder"; id: string; title: string };

export function readDragPayload(dt: DataTransfer | null): DragPayload | null {
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


let dragLastSeen = 0;
document.addEventListener("dragstart", () => (dragLastSeen = Date.now()));
document.addEventListener("dragover", () => (dragLastSeen = Date.now()));
document.addEventListener("dragend", () => (dragLastSeen = 0));
document.addEventListener("drop", () => (dragLastSeen = 0));

export function interactionInProgress(): boolean {
  const dragging = dragLastSeen !== 0 && Date.now() - dragLastSeen < 1500;
  return dragging || !!document.querySelector(".inline-select, .subfolder-input, .rename-input");
}

