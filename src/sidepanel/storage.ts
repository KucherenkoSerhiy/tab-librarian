import type { Placement, Removal, Settings } from "../types";

const SETTINGS_DEFAULTS: Settings = {
  provider: "anthropic",
  apiKey: "",
  workspaceId: "",
  baseUrl: "https://api.openai.com/v1",
  model: "claude-sonnet-5",
  includeAllWindows: true,
  includeLocalFiles: true,
  backupsEnabled: true,
};

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...SETTINGS_DEFAULTS, ...((settings as Partial<Settings> | undefined) ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

export async function getManagedRootId(): Promise<string | undefined> {
  const { managedRootId } = await chrome.storage.local.get("managedRootId");
  return managedRootId as string | undefined;
}

export async function setManagedRootId(id: string): Promise<void> {
  await chrome.storage.local.set({ managedRootId: id });
}

export async function getPlacements(): Promise<Record<string, Placement>> {
  const { placements } = await chrome.storage.local.get("placements");
  return (placements as Record<string, Placement> | undefined) ?? {};
}

export async function setPlacements(placements: Record<string, Placement>): Promise<void> {
  await chrome.storage.local.set({ placements });
}

export async function getRemovals(): Promise<Record<string, Removal>> {
  const { removals } = await chrome.storage.local.get("removals");
  return (removals as Record<string, Removal> | undefined) ?? {};
}

export async function setRemovals(removals: Record<string, Removal>): Promise<void> {
  await chrome.storage.local.set({ removals });
}

// Chat state survives panel close/reopen within a browser session.
export async function getSessionState<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.session.get(key);
  return result[key] as T | undefined;
}

export async function setSessionState(key: string, value: unknown): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}

export async function clearSessionState(keys: string[]): Promise<void> {
  await chrome.storage.session.remove(keys);
}
