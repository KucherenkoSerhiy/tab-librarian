// Setup / Options form: provider, key, behavior, privacy, backup.
import type { Provider, Settings } from "../types";
import { clearSnapshots, exportBackup, importBackup, listSnapshots, restoreSnapshot, snapshotCount, snapshotNow } from "./backup";
import { requestRefresh } from "./bus";
import { $, showToast } from "./dom";
import { testApiKey } from "./llm";
import { showView } from "./nav";
import { parseExcludedDomains } from "./privacy";
import { state } from "./state";
import { getSettings, saveSettings } from "./storage";

// ---------- setup / options ----------

export function formProvider(): Provider {
  const active = document.querySelector<HTMLButtonElement>(".seg-btn.active");
  return (active?.dataset.provider as Provider) ?? "anthropic";
}

export function applyProviderUi(provider: Provider): void {
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

export function settingsFromForm(): Settings {
  return {
    provider: formProvider(),
    apiKey: ($("apiKeyInput") as HTMLInputElement).value.trim(),
    workspaceId: ($("workspaceIdInput") as HTMLInputElement).value.trim(),
    baseUrl: ($("baseUrlInput") as HTMLInputElement).value.trim() || "https://api.openai.com/v1",
    model: ($("modelInput") as HTMLInputElement).value.trim(),
    includeAllWindows: ($("allWindowsInput") as HTMLInputElement).checked,
    includeLocalFiles: ($("includeLocalFilesInput") as HTMLInputElement).checked,
    backupsEnabled: ($("backupsEnabledInput") as HTMLInputElement).checked,
    previewOutgoing: ($("previewOutgoingInput") as HTMLInputElement).checked,
    stripQueryStrings: ($("stripQueryInput") as HTMLInputElement).checked,
    excludedDomains: parseExcludedDomains(($("excludedDomainsInput") as HTMLTextAreaElement).value).join("\n"),
  };
}

export function showFormError(message: string | null): void {
  const errorEl = $("apiKeyError");
  errorEl.textContent = message ?? "";
  errorEl.hidden = !message;
}

export function validateForm(settings: Settings): string | null {
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
export async function ensureHostPermission(settings: Settings): Promise<string | null> {
  if (settings.provider !== "openai" || !chrome.permissions?.request) return null;
  const origin = `${new URL(settings.baseUrl).origin}/*`;
  try {
    const granted = await chrome.permissions.request({ origins: [origin] });
    return granted ? null : `Access to ${origin} was declined — the endpoint can't be reached without it.`;
  } catch (err) {
    return `Could not request access to ${origin}: ${err instanceof Error ? err.message : err}`;
  }
}

export function openSetup(asOptions: boolean): void {
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
    ($("previewOutgoingInput") as HTMLInputElement).checked = s.previewOutgoing;
    ($("stripQueryInput") as HTMLInputElement).checked = s.stripQueryStrings;
    ($("excludedDomainsInput") as HTMLTextAreaElement).value = s.excludedDomains;
  });
  void snapshotCount().then((n) => {
    $("clearBackupsBtn").textContent = `🗑 Clear (${n})`;
  });
  void renderSnapshotList();
  showView("setup");
}

export async function renderSnapshotList(): Promise<void> {
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
          await requestRefresh();
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

export async function testConnectionFromForm(): Promise<void> {
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

export async function saveSettingsFromForm(): Promise<void> {
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
  state.firstRun = false;
  showView("home");
  showToast("Settings saved ✓");
}


export function wireOptions(): void {
  $("optionsBtn").addEventListener("click", () => openSetup(true));
  $("setupBackBtn").addEventListener("click", () => showView("home"));
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
      await requestRefresh();
    } catch (err) {
      showToast(`Import failed: ${err instanceof Error ? err.message : err}`);
    }
  });
}
