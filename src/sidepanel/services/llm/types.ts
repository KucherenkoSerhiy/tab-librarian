// Types shared by the provider implementations and the dispatcher.
import type Anthropic from "@anthropic-ai/sdk";
import type { Proposal, Settings } from "../../../types";

/** History is kept in Anthropic block format; the OpenAI path converts on the wire. */
export type ApiMessage = Anthropic.Beta.BetaMessageParam;

export interface ChatTurnResult {
  text: string;
  proposal: Proposal | null;
  refusal: string | null;
  /** Assistant + tool_result messages to append to history (already includes them in order). */
  appendToHistory: ApiMessage[];
}

export interface FindMatch {
  url: string;
  why: string;
}

export interface TurnOptions {
  settings: Settings;
  history: ApiMessage[];
  onDelta: (text: string) => void;
  /** Receives a function that aborts the in-flight request (Stop button). */
  registerStop?: (stop: () => void) => void;
}

export interface FindOptions {
  settings: Settings;
  query: string;
  library: string;
  registerStop?: (stop: () => void) => void;
}
