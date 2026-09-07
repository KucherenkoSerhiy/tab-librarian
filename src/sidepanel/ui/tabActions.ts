// Tab actions as the UI uses them: the service does the work, this layer tells the user.
import { openOrFocusTab, reopenTabs } from "../services/tabs";
import { showToast } from "./dom";

export async function reopenTabsWithNotice(urls: string[]): Promise<void> {
  const blocked = await reopenTabs(urls);
  if (blocked) showToast(`${blocked} local file tab(s) couldn't reopen — needs “Allow access to file URLs”`);
}

export async function openOrFocusTabWithNotice(url: string): Promise<void> {
  const error = await openOrFocusTab(url);
  if (error) showToast(error);
}
