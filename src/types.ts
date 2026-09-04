export type Provider = "anthropic" | "openai";

export interface Settings {
  provider: Provider;
  apiKey: string;
  /** Anthropic only: required by the API when the key is identity-linked; empty otherwise. */
  workspaceId: string;
  /** OpenAI-compatible only: endpoint base, e.g. https://api.openai.com/v1 or a local server. */
  baseUrl: string;
  model: string;
  includeAllWindows: boolean;
  includeLocalFiles: boolean;
  backupsEnabled: boolean;
}

export type PlacementSource = "manual" | "llm";

/** Keyed by normalized URL in the placements map. */
export interface Placement {
  bookmarkId: string;
  folderId: string;
  source: PlacementSource;
  placedAt: number;
}

/** Record of a user pulling a bookmark out of a folder (keyed by normalized URL). */
export interface Removal {
  folderPath: string;
  removedAt: number;
}

/** One entry of the LLM proposal: a folder path from the managed root, plus tabs filed there. */
export interface ProposalFolderEntry {
  path: string[];
  tabs: ProposalTab[];
}

export interface ProposalTab {
  url: string;
  title: string;
}

export interface ProposalQuestion {
  url: string;
  question: string;
}

/** A bookmark the model suggests deleting during a cleanup pass. */
export interface ProposalRemoval {
  url: string;
  reason: string;
}

export interface Proposal {
  folders: ProposalFolderEntry[];
  questions: ProposalQuestion[];
  removals: ProposalRemoval[];
}

/** A chat message as displayed in the UI (not the API wire format). */
export interface DisplayMessage {
  role: "user" | "assistant" | "status";
  text: string;
}

export interface OpenTabInfo {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  pinned: boolean;
  sorted: boolean;
}
