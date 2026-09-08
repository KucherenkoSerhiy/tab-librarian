import type { ApiMessage } from "../services/llm/index";
import type { DisplayMessage, Proposal } from "../../types";

export type View = "home" | "review" | "setup" | "outgoing";

export const state = {
  currentView: "home" as View,

  // chat + proposal
  apiHistory: [] as ApiMessage[],
  displayMessages: [] as DisplayMessage[],
  pendingProposal: null as Proposal | null,
  /** normalized URL → folder path of the proposal this one replaces (diff baseline) */
  prevProposalMap: null as Record<string, string> | null,
  /** an apply is running: the poll must not re-render mid-way */
  applying: false,
  /** first launch: the setup view is a welcome, not options */
  firstRun: false,

  // home filtering
  searchQuery: "",
  /** recall results: normalized real URL → why it matched; when set, only these are shown */
  findFilter: null as Map<string, string> | null,

  // privacy preview
  /** URLs the user skipped in the "before sending" preview (this conversation only) */
  sessionExcludedUrls: new Set<string>(),
  /** fingerprint of the last outgoing set the user approved — no re-ask while unchanged */
  approvedOutgoingKey: "",

  // tree/list expansion, preserved across re-renders
  openFolders: new Set<string>(),
  openDomains: new Set<string>(),

  // "closed just now" tracking
  lastKnownTabs: new Map<number, { url: string; title: string }>(),
  /** bulk closes set this so the closed-tab strip doesn't fire for each one */
  suppressCloseTrackingUntil: 0,
};
