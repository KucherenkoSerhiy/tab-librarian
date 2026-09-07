// One entry point for everything that talks to an AI provider. Callers never
// see which provider is configured; the settings decide.
import Anthropic from "@anthropic-ai/sdk";
import type { Settings } from "../../../types";
import * as anthropic from "./anthropic";
import * as openai from "./openai";
import type { ChatTurnResult, FindMatch, FindOptions, TurnOptions } from "./types";

export type { ApiMessage, ChatTurnResult, FindMatch, FindOptions, TurnOptions } from "./types";

function provider(settings: Settings) {
  return settings.provider === "openai" ? openai : anthropic;
}

export async function testApiKey(
  settings: Settings
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await provider(settings).testKey(settings);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: friendlyApiError(err) };
  }
}

/** One chat turn. The caller has already pushed the user message onto `history`. */
export function runChatTurn(opts: TurnOptions): Promise<ChatTurnResult> {
  return provider(opts.settings).runTurn(opts);
}

/** One-shot recall — independent of the chat history; the tool call is forced. */
export function runFindTurn(opts: FindOptions): Promise<FindMatch[]> {
  return provider(opts.settings).runFind(opts);
}

/** True when the turn ended because the user hit Stop. */
export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Anthropic.APIUserAbortError ||
    (err instanceof DOMException && err.name === "AbortError")
  );
}

export function friendlyApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Your API key was rejected. Check it in Settings.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Rate limited by the API — wait a moment and try again.";
  }
  if (err instanceof Anthropic.BadRequestError) {
    if (err.message.includes("anthropic-workspace-id")) {
      return "Your API key is identity-linked and needs a Workspace ID. Open Options (⚙) and paste the workspace's ID (from console.anthropic.com → Settings → Workspaces, looks like wrkspc_…).";
    }
    return `The API rejected the request: ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Could not reach api.anthropic.com. Check your connection.";
  }
  if (err instanceof Anthropic.APIError) {
    return `API error ${err.status}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

