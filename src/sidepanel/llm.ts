import Anthropic from "@anthropic-ai/sdk";
import type { Proposal, Settings } from "../types";

export type ApiMessage = Anthropic.Beta.BetaMessageParam;

const SYSTEM_PROMPT = `You are a tab-organizing assistant living in a browser side panel. The user has many open tabs and wants them filed into a persistent, possibly nested bookmark folder structure.

Every user message ends with a CURRENT STATE block describing open tabs, the existing folder tree, and placement metadata. The most recent CURRENT STATE block is authoritative; ignore state from earlier turns.

Rules:
- When you have a folder/tab assignment to suggest, call the submit_proposal tool. Always submit the COMPLETE current proposal (every folder and every tab assignment you are suggesting), not a diff. Each new proposal fully replaces the previous one.
- Folder paths are arrays from the root, e.g. ["Work", "Client A"] means a "Client A" folder nested inside "Work". Use nesting when the user's taxonomy calls for it. Keep the tree shallow (1-2 levels) unless the user asks for more depth.
- Keep any single folder to at most ~20 bookmarks. When more than 20 tabs would land in one folder, split it into meaningful subfolders (by project, topic, or status) instead of one bloated folder.
- Placements marked "manual" were placed by the user by hand. NEVER move or re-file them unless the user explicitly asks. Do not include them in proposals except to leave them where they are.
- URLs listed under "removed by user" were deliberately pulled out of a folder by the user. Do not silently re-propose the same placement; if you think one belongs somewhere, ask first.
- When the user asks to sort "new" or "unsorted" tabs, only propose placements for tabs marked sorted:false. Use the EXISTING folder tree as the taxonomy; do not invent new folders unless the user asks or nothing fits (then ask).
- If a tab is ambiguous, put your question in the questions array of submit_proposal instead of guessing.
- The removals array is for cleanup passes: when the user asks you to clean up, audit, or prune the library, you may propose deleting existing bookmarks (each with a reason — duplicate, outdated, superseded, etc.). Each bookmark's addedDaysAgo tells you how old it is. NEVER propose removing a manual placement unless the user explicitly asked for that bookmark or folder to be cleaned. When not doing cleanup, send an empty removals array.
- Nothing you propose is applied until the user approves it in the review UI, so propose freely and refine based on feedback.
- Keep your text replies short and conversational; the proposal itself is rendered separately by the UI.`;

const PROPOSAL_TOOL = {
  name: "submit_proposal",
  description:
    "Submit the complete current folder/bookmark proposal for user review. Call with the FULL proposal (all folders and all tab assignments), never a diff. The UI renders it as a review tree; nothing is applied until the user approves.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      folders: {
        type: "array",
        description: "Every proposed folder with the tabs assigned to it.",
        items: {
          type: "object",
          properties: {
            path: {
              type: "array",
              items: { type: "string" },
              description:
                'Folder path from the root, one element per nesting level, e.g. ["Work", "Client A"].',
            },
            tabs: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  url: { type: "string" },
                  title: { type: "string" },
                },
                required: ["url", "title"],
                additionalProperties: false,
              },
            },
          },
          required: ["path", "tabs"],
          additionalProperties: false,
        },
      },
      questions: {
        type: "array",
        description: "Questions about ambiguous tabs (empty array if none).",
        items: {
          type: "object",
          properties: {
            url: { type: "string" },
            question: { type: "string" },
          },
          required: ["url", "question"],
          additionalProperties: false,
        },
      },
      removals: {
        type: "array",
        description:
          "Existing bookmarks to delete (cleanup passes only; empty array otherwise). Each needs a short reason.",
        items: {
          type: "object",
          properties: {
            url: { type: "string" },
            reason: { type: "string" },
          },
          required: ["url", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["folders", "questions", "removals"],
    additionalProperties: false,
  },
};

function makeClient(settings: Settings): Anthropic {
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

function apiBase(settings: Settings): string {
  return settings.baseUrl.replace(/\/+$/, "");
}

/**
 * Cheap credentials check without spending tokens: Anthropic — retrieve the
 * model's metadata; OpenAI-compatible — list models.
 */
export async function testApiKey(
  settings: Settings
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    if (settings.provider === "openai") {
      const res = await fetch(`${apiBase(settings)}/models`, {
        headers: { authorization: `Bearer ${settings.apiKey}` },
      });
      if (!res.ok) {
        throw new Error(`Endpoint returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      return { ok: true };
    }
    await makeClient(settings).models.retrieve(settings.model);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: friendlyApiError(err) };
  }
}

export interface ChatTurnResult {
  text: string;
  proposal: Proposal | null;
  refusal: string | null;
  /** Assistant + tool_result messages to append to history (already includes them in order). */
  appendToHistory: ApiMessage[];
}

/**
 * Run one chat turn. The caller has already pushed the user message onto `history`.
 * Streams text deltas via onDelta; returns the parsed result plus messages to append.
 */
export async function runChatTurn(opts: {
  settings: Settings;
  history: ApiMessage[];
  onDelta: (text: string) => void;
  /** Receives a function that aborts the in-flight request (Stop button). */
  registerStop?: (stop: () => void) => void;
}): Promise<ChatTurnResult> {
  const { settings, history, onDelta, registerStop } = opts;
  if (settings.provider === "openai") return runOpenAiTurn(opts);

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

// ---------- OpenAI-compatible provider (OpenAI, OpenRouter, Groq, local servers…) ----------

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

/** Non-streaming chat-completions turn against an OpenAI-compatible endpoint. */
async function runOpenAiTurn(opts: {
  settings: Settings;
  history: ApiMessage[];
  onDelta: (text: string) => void;
  registerStop?: (stop: () => void) => void;
}): Promise<ChatTurnResult> {
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

function sanitizeProposal(input: unknown): Proposal {
  const raw = input as Partial<Proposal>;
  const folders = Array.isArray(raw.folders) ? raw.folders : [];
  const questions = Array.isArray(raw.questions) ? raw.questions : [];
  return {
    folders: folders
      .filter((f) => Array.isArray(f?.path) && f.path.length > 0 && f.path.every((p) => typeof p === "string" && p.trim()))
      .map((f) => ({
        path: f.path.map((p) => p.trim()),
        tabs: (Array.isArray(f.tabs) ? f.tabs : []).filter(
          (t) => typeof t?.url === "string" && t.url && typeof t?.title === "string"
        ),
      })),
    questions: questions.filter(
      (q) => typeof q?.question === "string" && q.question && typeof q?.url === "string"
    ),
    removals: (Array.isArray(raw.removals) ? raw.removals : []).filter(
      (r) => typeof r?.url === "string" && r.url && typeof r?.reason === "string"
    ),
  };
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
