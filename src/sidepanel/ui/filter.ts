// Text search vs. recall filter — the one predicate every list uses.
import { state } from "../app/state";
import { normalizeUrl } from "../domain/urls";

export function matchesQuery(text: string): boolean {
  return !state.searchQuery || text.toLowerCase().includes(state.searchQuery.toLowerCase());
}

/** Text search as you type; once recall results exist, only those URLs pass. */
export function passesFilter(url: string, text: string): boolean {
  if (state.findFilter) return state.findFilter.has(normalizeUrl(url));
  return matchesQuery(text);
}

export function whyLine(url: string): HTMLElement | null {
  const why = state.findFilter?.get(normalizeUrl(url));
  if (!why) return null;
  const el = document.createElement("div");
  el.className = "why";
  el.textContent = `↳ ${why}`;
  return el;
}

export function lockMark(): HTMLElement {
  const el = document.createElement("span");
  el.className = "lock";
  el.textContent = "🔒";
  el.title = "On an excluded domain — never sent to the AI (Options → Privacy)";
  return el;
}

/** Option label with tree indentation — folders read as a hierarchy, not paths. */
