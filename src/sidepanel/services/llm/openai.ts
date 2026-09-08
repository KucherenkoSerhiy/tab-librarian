// OpenAI-compatible provider (OpenAI, OpenRouter, Groq, Ollama, LM Studio…):
// non-streaming chat-completions with function tools.
import type Anthropic from "@anthropic-ai/sdk";
import type { Proposal, Settings } from "../../../types";
import { FIND_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./prompts";
import { FIND_TOOL, PROPOSAL_TOOL, sanitizeMatches, sanitizeProposal } from "./tools";
import type { ApiMessage, ChatTurnResult, FindMatch, FindOptions, TurnOptions } from "./types";

export function apiBase(settings: Settings): string {
  return settings.baseUrl.replace(/\/+$/, "");
}

/**
 * Cheap credentials check without spending tokens: Anthropic — retrieve the
 * model's metadata; OpenAI-compatible — list models.

/** Cheap credentials check without spending tokens: list models. */
export async function testKey(settings: Settings): Promise<void> {
  const res = await fetch(`${apiBase(settings)}/models`, {
    headers: { authorization: `Bearer ${settings.apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Endpoint returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

/** History is stored in Anthropic block format; convert on the wire for OpenAI-style endpoints. */
function toOpenAiMessages(history: ApiMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  for (const msg of history) {
    if (typeof msg.content === "string") {
      out.push({ role: msg.role as "user" | "assistant", content: msg.content });
      continue;
    }
    if (msg.role === "assistant") {
      let text = "";
      const toolCalls: OpenAiToolCall[] = [];
      for (const block of msg.content) {
        if (block.type === "text") text += block.text;
        else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
        }
        // thinking blocks are Anthropic-specific — dropped on this path
      }
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else {
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          out.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: typeof block.content === "string" ? block.content : "ok",
          });
        } else if (block.type === "text") {
          out.push({ role: "user", content: block.text });
        }
      }
    }
  }
  return out;
}


export async function runTurn(opts: TurnOptions): Promise<ChatTurnResult> {
  const { settings, history, registerStop } = opts;

  const controller = new AbortController();
  registerStop?.(() => controller.abort());

  const res = await fetch(`${apiBase(settings)}/chat/completions`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...toOpenAiMessages(history)],
      tools: [
        {
          type: "function",
          function: {
            name: PROPOSAL_TOOL.name,
            description: PROPOSAL_TOOL.description,
            parameters: PROPOSAL_TOOL.input_schema,
          },
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Endpoint returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: OpenAiToolCall[] } }[];
  };
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("The endpoint returned no message — is the model name right?");

  const text = message.content ?? "";
  const toolCall = (message.tool_calls ?? []).find((t) => t?.function?.name === PROPOSAL_TOOL.name);

  const assistantBlocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (text) assistantBlocks.push({ type: "text", text });

  let proposal: Proposal | null = null;
  const appendToHistory: ApiMessage[] = [];
  if (toolCall) {
    let input: unknown = {};
    try {
      input = JSON.parse(toolCall.function.arguments || "{}");
    } catch {
      /* malformed arguments — sanitize handles the empty object */
    }
    proposal = sanitizeProposal(input);
    assistantBlocks.push({ type: "tool_use", id: toolCall.id, name: PROPOSAL_TOOL.name, input });
  }
  appendToHistory.push({
    role: "assistant",
    content: assistantBlocks.length ? assistantBlocks : [{ type: "text", text: "(no reply)" }],
  });
  if (toolCall) {
    appendToHistory.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolCall.id,
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
  {
    const res = await fetch(`${apiBase(settings)}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: "system", content: FIND_SYSTEM_PROMPT },
          { role: "user", content: userText },
        ],
        tools: [
          {
            type: "function",
            function: { name: FIND_TOOL.name, description: FIND_TOOL.description, parameters: FIND_TOOL.input_schema },
          },
        ],
        tool_choice: { type: "function", function: { name: FIND_TOOL.name } },
      }),
    });
    if (!res.ok) throw new Error(`Endpoint returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { choices?: { message?: { tool_calls?: OpenAiToolCall[] } }[] };
    const call = (data.choices?.[0]?.message?.tool_calls ?? []).find((t) => t?.function?.name === FIND_TOOL.name);
    if (!call) return [];
    try {
      return sanitizeMatches(JSON.parse(call.function.arguments || "{}"));
    } catch {
      return [];
    }
  }

}
