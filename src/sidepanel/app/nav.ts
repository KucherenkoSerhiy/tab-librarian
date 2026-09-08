// View switching, chat drawer, collapsible panels, theme.
import type { View } from "./state";
import { requestRefresh } from "./bus";
import { $, scrollChatToBottom } from "../ui/dom";
import { state } from "./state";
import { setSessionState } from "../services/storage";

// ---------- navigation ----------

export function showView(view: View): void {
  state.currentView = view;
  for (const v of ["home", "review", "setup", "outgoing"] as const) {
    $(`view-${v}`).hidden = v !== view;
  }
  if (view === "home") {
    void requestRefresh();
    scrollChatToBottom();
  }
}

export function isDrawerOpen(): boolean {
  return !$("chatDrawer").classList.contains("collapsed");
}

export function setDrawer(open: boolean): void {
  $("chatDrawer").classList.toggle("collapsed", !open);
  $("drawerToggle").title = open ? "Collapse chat" : "Expand chat";
  if (open) scrollChatToBottom();
  void setSessionState("chatOpen", open);
}

export function setPanel(id: "unsortedPanel" | "foldersPanel", open: boolean): void {
  $(id).classList.toggle("open", open);
  void setSessionState(id, open);
}

// ---------- theme ----------

export function effectiveTheme(): "light" | "dark" {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === "light" || chosen === "dark") return chosen;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function updateThemeButton(): void {
  const btn = $("themeBtn");
  const current = effectiveTheme();
  btn.textContent = current === "dark" ? "☀️" : "🌙";
  btn.title = current === "dark" ? "Switch to light mode" : "Switch to dark mode";
}

export async function initTheme(): Promise<void> {
  const { theme } = await chrome.storage.local.get("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  updateThemeButton();
}

export function toggleTheme(): void {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  void chrome.storage.local.set({ theme: next });
  updateThemeButton();
}


export function wireNav(): void {
  $("themeBtn").addEventListener("click", toggleTheme);
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
}
