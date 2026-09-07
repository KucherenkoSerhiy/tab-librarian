// Entry point: restore session state, wire every module, start syncing.
import type { DisplayMessage, Proposal } from "../types";
import type { ApiMessage } from "./llm";
import { ensureManagedRoot } from "./bookmarks";
import { snapshotNow } from "./backup";
import { getSessionState, getSettings } from "./storage";
import { state } from "./state";
import { emit, requestRefresh } from "./bus";
import { initTheme, setDrawer, setPanel, wireNav } from "./nav";
import { renderAllMessages, wireChat } from "./chat";
import { wireRecall } from "./recall";
import { wireOutgoing } from "./outgoing";
import { wireTabActions } from "./tabs";
import { wireReview } from "./review";
import { openSetup, wireOptions } from "./options";
import { wireNewFolder } from "./tree";
import { startSync } from "./refresh";

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
