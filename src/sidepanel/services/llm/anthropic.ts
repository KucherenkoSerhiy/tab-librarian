// Anthropic provider: streaming chat turn with the proposal tool, one-shot recall.
import Anthropic from "@anthropic-ai/sdk";
import type { Proposal, Settings } from "../../../types";
import { FIND_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./prompts";
import { FIND_TOOL, PROPOSAL_TOOL, sanitizeMatches, sanitizeProposal } from "./tools";
import type { ApiMessage, ChatTurnResult, FindMatch, FindOptions, TurnOptions } from "./types";

export function makeClient(settings: Settings): Anthropic {
  return new Anthropic({
    apiKey: settings.apiKey,
    dangerouslyAllowBrowser: true,
    defaultHeaders: {
      "anthropic-dangerous-direct-browser-access": "true",
      // identity-linked API keys must state which workspace the request acts in
      ...(settings.workspaceId ? { "anthropic-workspace-id": settings.workspaceId } : {}),
    },
  });
}

/** Cheap credentials check without spending tokens: retrieve the model's metadata. */
export async function testKey(settings: Settings): Promise<void> {
  await makeClient(settings).models.retrieve(settings.model);
}

export async function runTurn(opts: TurnOptions): Promise<ChatTurnResult> {
  const { settings, history, onDelta, registerStop } = opts;

  const client = makeClient(settings);

  // Server-side refusal fallbacks are supported on the Opus-5 tier.
  const opusTier = settings.model === "claude-opus-5" || settings.model === "claude-fable-5";

  const stream = client.beta.messages.stream({
    model: settings.model,
    max_tokens: 64000,
    // Prefix caching: tools + system are byte-stable, and the growing history
    // prefix gets cached turn over turn via the system-block breakpoint plus
    // the cache point the API places at the last cacheable block.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    cache_control: { type: "ephemeral" },
    tools: [PROPOSAL_TOOL],
    messages: history,
    ...(opusTier
      ? {
          betas: ["server-side-fallback-2026-06-01"],
          fallbacks: [{ model: "claude-opus-4-8" }],
        }
      : {}),
  });
  registerStop?.(() => stream.abort());

  stream.on("text", onDelta);
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    const explanation =
      (message as { stop_details?: { explanation?: string } }).stop_details?.explanation ??
      "The model declined to answer this request.";
    return { text: "", proposal: null, refusal: explanation, appendToHistory: [] };
  }

  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const toolUse = message.content.find(
    (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === "submit_proposal"
  );

  const appendToHistory: ApiMessage[] = [{ role: "assistant", content: message.content }];

  let proposal: Proposal | null = null;
  if (toolUse) {
    proposal = sanitizeProposal(toolUse.input);
    // Close the tool loop so the history stays valid; the turn ends here —
    // the user reviews the proposal in the UI instead of the model continuing.
    appendToHistory.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: "Proposal received and displayed to the user for review.",
        },
      ],
    });
  }

  return { text, proposal, refusal: null, appendToHistory };
}

export async function runFind(opts: FindOptions): Promise<FindMatch[]> {
  const { settings, query, library, registerStop } = opts;
  const userText = `Query: ${query}\n\n${library}`;
  const controller = new AbortController();
  registerStop?.(() => controller.abort());
  const message = await makeClient(settings).beta.messages.create(
    {
      model: settings.model,
      max_tokens: 2000,
      system: FIND_SYSTEM_PROMPT,
      tools: [FIND_TOOL],
      tool_choice: { type: "tool", name: FIND_TOOL.name },
      messages: [{ role: "user", content: userText }],
    },
    { signal: controller.signal }
  );
  const toolUse = message.content.find(
    (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === FIND_TOOL.name
  );
  return toolUse ? sanitizeMatches(toolUse.input) : [];
}
