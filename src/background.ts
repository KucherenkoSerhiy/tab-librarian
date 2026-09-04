// Service worker: side-panel behavior, cyclic backups, and the
// "File this page into…" context menu. All interactive logic lives in the panel.
import { snapshotNow } from "./sidepanel/backup";
import { fileTabManually, listFolders } from "./sidepanel/bookmarks";
import { isSortableUrl } from "./sidepanel/urls";

// chrome.sidePanel doesn't exist on Firefox (sidebar_action opens the panel there)
chrome.sidePanel
  ?.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("sidePanel.setPanelBehavior failed", err));

// ---------- cyclic backups ----------

const BACKUP_ALARM = "cyclic-backup";

function ensureBackupAlarm(): void {
  chrome.alarms.get(BACKUP_ALARM, (existing) => {
    if (!existing) chrome.alarms.create(BACKUP_ALARM, { periodInMinutes: 180 });
  });
}

chrome.runtime.onInstalled.addListener(ensureBackupAlarm);
chrome.runtime.onStartup.addListener(ensureBackupAlarm);
ensureBackupAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BACKUP_ALARM) void snapshotNow("cyclic", true);
});

// ---------- context menu: file the current page without opening the panel ----------

const MENU_ROOT = "file-into";
const MENU_FOLDER_PREFIX = "file-into-folder:";
const MENU_CAP = 50;

async function rebuildContextMenu(): Promise<void> {
  if (!chrome.contextMenus) return;
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU_ROOT, title: "File this page into…", contexts: ["page"] });
  try {
    const folders = await listFolders();
    if (!folders.length) {
      chrome.contextMenus.create({
        id: "file-into-none",
        parentId: MENU_ROOT,
        title: "(no folders yet — open the panel to create some)",
        enabled: false,
        contexts: ["page"],
      });
      return;
    }
    for (const folder of folders.slice(0, MENU_CAP)) {
      chrome.contextMenus.create({
        id: `${MENU_FOLDER_PREFIX}${folder.id}`,
        parentId: MENU_ROOT,
        title: folder.path.join(" / "),
        contexts: ["page"],
      });
    }
  } catch (err) {
    console.warn("context menu rebuild failed", err);
  }
}

let menuRebuildTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleMenuRebuild(): void {
  clearTimeout(menuRebuildTimer);
  menuRebuildTimer = setTimeout(() => void rebuildContextMenu(), 1500);
}

chrome.runtime.onInstalled.addListener(() => void rebuildContextMenu());
chrome.runtime.onStartup.addListener(() => void rebuildContextMenu());
chrome.bookmarks.onCreated.addListener(scheduleMenuRebuild);
chrome.bookmarks.onRemoved.addListener(scheduleMenuRebuild);
chrome.bookmarks.onMoved.addListener(scheduleMenuRebuild);
chrome.bookmarks.onChanged.addListener(scheduleMenuRebuild);

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  if (!id.startsWith(MENU_FOLDER_PREFIX) || !tab?.url || !isSortableUrl(tab.url)) return;
  const folderId = id.slice(MENU_FOLDER_PREFIX.length);
  void fileTabManually({ title: tab.title ?? tab.url, url: tab.url }, folderId);
});
