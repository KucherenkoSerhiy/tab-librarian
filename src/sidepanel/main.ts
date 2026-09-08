// Entry point: restore session state, wire every module, start syncing.
import type { DisplayMessage, Proposal } from "../types";
import type { ApiMessage } from "./services/llm/index";
import { ensureManagedRoot } from "./services/bookmarks";
import { snapshotNow } from "./services/backup";
import { getSessionState, getSettings } from "./services/storage";
import { state } from "./app/state";
import { emit, requestRefresh } from "./app/bus";
import { initTheme, setDrawer, setPanel, wireNav } from "./app/nav";
import { renderAllMessages, wireChat } from "./ui/chat/chat";
import { wireRecall } from "./ui/home/recall";
import { wireOutgoing } from "./ui/privacy/outgoing";
import { wireTabActions } from "./ui/home/unsorted";
import { wireReview } from "./ui/review/review";
import { openSetup, wireOptions } from "./ui/options/options";
import { wireNewFolder } from "./ui/home/tree";
import { startSync } from "./app/refresh";

async function init(): Promise<void> {
  await initTheme();
  await ensureManagedRoot();

  state.apiHistory = (await getSessionState<ApiMessage[]>("apiHistory")) ?? [];
  state.displayMessages = (await getSessionState<DisplayMessage[]>("displayMessages")) ?? [];
  state.pendingProposal = (await getSessionState<Proposal | null>("pendingProposal")) ?? null;
  state.prevProposalMap = (await getSessionState<Record<string, string> | null>("prevProposalMap")) ?? null;
  state.approvedOutgoingKey = (await getSessionState<string>("approvedOutgoingKey")) ?? "";
  state.sessionExcludedUrls = new Set((await getSessionState<string[]>("sessionExcludedUrls")) ?? []);

  wireNav();
  wireChat();
  wireRecall();
  wireOutgoing();
  wireTabActions();
  wireReview();
  wireOptions();
  wireNewFolder();
  startSync();

  renderAllMessages();
  await emit("proposal");
  setDrawer((await getSessionState<boolean>("chatOpen")) ?? false);
  setPanel("unsortedPanel", (await getSessionState<boolean>("unsortedPanel")) ?? true);
  setPanel("foldersPanel", (await getSessionState<boolean>("foldersPanel")) ?? true);
  void snapshotNow("routine", true); // rolling safety net, at most every ~6h
  await requestRefresh();

  const settings = await getSettings();
  if (!settings.apiKey) {
    state.firstRun = true;
    openSetup(false);
  }
}

void init();
