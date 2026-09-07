// Enter in the search box asks the AI to find things by description.
import { $, debounce, showToast } from "../dom";
import { friendlyApiError, runFindTurn } from "../../services/llm/index";
import { setPanel } from "../../app/nav";
import { openSetup } from "../options/options";
import { buildOutgoing } from "../../services/payload";
import { confirmOutgoing } from "../privacy/outgoing";
import { realUrlOf } from "../../domain/privacy";
import { state } from "../../app/state";
import { getSettings } from "../../services/storage";
import { renderTree } from "./tree";
import { renderUnsorted } from "./unsorted";
import { normalizeUrl } from "../../domain/urls";

// ---------- recall: Enter in the search box asks the AI ----------

let findBusy = false;

export function clearFind(rerender: boolean): void {
  state.findFilter = null;
  $("findStrip").hidden = true;
  if (rerender) void Promise.all([renderTree(), renderUnsorted()]);
}

export function setFindStrip(text: string): void {
  $("findText").textContent = text;
  $("findStrip").hidden = false;
}

export async function runFind(query: string): Promise<void> {
  if (!query || findBusy) return;
  const settings = await getSettings();
  if (!settings.apiKey) {
    openSetup(false);
    return;
  }
  const outgoing = await buildOutgoing();
  if (!(await confirmOutgoing(outgoing, "This search"))) return;

  findBusy = true;
  setFindStrip("Asking the librarian…");
  try {
    const matches = await runFindTurn({
      settings,
      query,
      library: outgoing.text.replace("<CURRENT STATE>", "<LIBRARY>").replace("</CURRENT STATE>", "</LIBRARY>"),
    });
    state.findFilter = new Map(matches.map((m) => [normalizeUrl(realUrlOf(m.url, outgoing.map)), m.why]));
    setFindStrip(
      matches.length
        ? `🔎 ${matches.length} match${matches.length === 1 ? "" : "es"} for “${query}”`
        : `🔎 Nothing in your library matches “${query}”`
    );
    setPanel("foldersPanel", true);
    setPanel("unsortedPanel", true);
    await Promise.all([renderTree(), renderUnsorted()]);
  } catch (err) {
    $("findStrip").hidden = true;
    showToast(friendlyApiError(err));
  } finally {
    findBusy = false;
  }
}


export function wireRecall(): void {
  const searchInput = $("searchInput") as HTMLInputElement;
  searchInput.addEventListener(
    "input",
    debounce(() => {
      state.searchQuery = searchInput.value.trim();
      if (state.findFilter) clearFind(false); // typing again returns to plain text search
      void Promise.all([renderTree(), renderUnsorted()]);
    }, 150)
  );
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void runFind(searchInput.value.trim());
    } else if (e.key === "Escape") {
      searchInput.value = "";
      state.searchQuery = "";
      clearFind(true);
    }
  });
  $("findClearBtn").addEventListener("click", () => {
    searchInput.value = "";
    state.searchQuery = "";
    clearFind(true);
  });
}
