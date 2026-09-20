// The AI chat: messages, one turn, stop, persistence.
import type { DisplayMessage, Proposal } from "../../../types";
import { emit } from "../../app/bus";
import { $, scrollChatToBottom } from "../dom";
import { friendlyApiError, isAbortError, runChatTurn } from "../../services/llm/index";
import { setDrawer } from "../../app/nav";
import { openSetup } from "../options/options";
import type { OutgoingScope } from "../../services/payload";
import { buildOutgoing } from "../../services/payload";
import { confirmOutgoing } from "../privacy/outgoing";
import { mapProposalBack } from "../../domain/privacy";
import { state } from "../../app/state";
import { clearSessionState, getSettings, setSessionState } from "../../services/storage";
import { normalizeUrl } from "../../domain/urls";

let busy = false;
let stopCurrentTurn: (() => void) | null = null;

export async function persistChat(): Promise<void> {
  await setSessionState("apiHistory", state.apiHistory);
  await setSessionState("displayMessages", state.displayMessages);
  await setSessionState("pendingProposal", state.pendingProposal);
  await setSessionState("prevProposalMap", state.prevProposalMap);
}

export function proposalMap(proposal: Proposal): Record<string, string> {
  const map: Record<string, string> = {};
  for (const folder of proposal.folders) {
    for (const tab of folder.tabs) map[normalizeUrl(tab.url)] = folder.path.join("/");
  }
  return map;
}


// ---------- chat ----------

export function addDisplayMessage(msg: DisplayMessage): HTMLElement {
  state.displayMessages.push(msg);
  const el = renderMessage(msg);
  return el;
}

export function renderMessage(msg: DisplayMessage): HTMLElement {
  $("messages").querySelector(".chat-empty")?.remove();
  const el = document.createElement("div");
  el.className = `msg ${msg.role}`;
  el.textContent = msg.text;
  $("messages").appendChild(el);
  scrollChatToBottom();
  return el;
}

export function renderAllMessages(): void {
  const container = $("messages");
  container.replaceChildren();
  if (!state.displayMessages.length) {
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.innerHTML =
      '<span class="big-emoji">🗂️</span>Tell me how you think about your tabs — projects, topics, whatever fits — and I\'ll propose a folder structure. Or start with a quick action below.';
    container.appendChild(empty);
    return;
  }
  for (const msg of state.displayMessages) renderMessage(msg);
}

/**
 * One chat turn. `scope` decides what the CURRENT STATE block carries: open
 * tabs plus folder summaries by default; the library only for cleanup, when
 * the user ticks it in the Before-sending step, or once the user has shared
 * it in this conversation because the model asked (`state.conversationScope`).
 */
export async function sendChat(userText: string, scope: OutgoingScope = "tabs"): Promise<void> {
  if (busy || !userText.trim()) return;
  const settings = await getSettings();
  if (!settings.apiKey) {
    openSetup(false);
    return;
  }

  const effectiveScope: OutgoingScope = state.conversationScope === "library" ? "library" : scope;
  let outgoing = await confirmOutgoing(await buildOutgoing(effectiveScope), "This message");
  if (!outgoing) return;

  busy = true;
  setBusyUi(true);
  addDisplayMessage({ role: "user", text: userText });
  setDrawer(true);

  const historyMark = state.apiHistory.length; // everything past this is dropped if the turn fails
  state.apiHistory.push({ role: "user", content: `${userText}\n\n${outgoing.text}` });

  let bubble = renderMessage({ role: "assistant", text: "Thinking…" });
  let streamed = "";
  const turn = () =>
    runChatTurn({
      settings,
      history: state.apiHistory,
      onDelta: (delta) => {
        streamed += delta;
        bubble.textContent = streamed;
        scrollChatToBottom();
      },
      registerStop: (stop) => {
        stopCurrentTurn = stop;
      },
    });

  try {
    let result = await turn();

    // The model asked for the library. The tool call carries no data; the
    // user sees the request on the Before-sending step (always shown) and
    // decides. Either way the tool call is answered and the model continues.
    if (!result.refusal && result.libraryRequest && outgoing.scope !== "library") {
      const { reason, toolUseId } = result.libraryRequest;
      state.apiHistory.push(...result.appendToHistory);
      bubble.textContent = result.text.trim() || "I need to see your library bookmarks for that.";
      state.displayMessages.push({ role: "assistant", text: bubble.textContent });
      const shared = await confirmOutgoing(await buildOutgoing("library"), "This message", {
        force: true,
        note: `The AI asked for your library bookmarks${reason ? `: ${reason}` : ""}`,
      });
      let answer: string;
      if (shared && shared.scope === "library") {
        outgoing = shared;
        state.conversationScope = "library";
        await setSessionState("conversationScope", "library");
        addDisplayMessage({ role: "status", text: "Library shared with the AI for this conversation." });
        answer = `The user shared the library. The authoritative state now follows.\n\n${shared.text}`;
      } else {
        addDisplayMessage({ role: "status", text: "Library not sent." });
        answer = "The user declined to share the library. Continue with the open tabs only and say what you could not do.";
      }
      state.apiHistory.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: answer }] });
      streamed = "";
      bubble = renderMessage({ role: "assistant", text: "Thinking…" });
      result = await turn();
    }

    if (result.refusal) {
      state.apiHistory.length = historyMark; // keep history clean of the refused turn
      bubble.remove();
      addDisplayMessage({ role: "status", text: `Declined: ${result.refusal}` });
    } else {
      state.apiHistory.push(...result.appendToHistory);
      const finalText =
        result.text.trim() || (result.proposal ? "Here's my proposal — tap Review to check it." : "(no reply)");
      bubble.textContent = finalText;
      state.displayMessages.push({ role: "assistant", text: finalText });
      if (result.proposal) {
        // diff baseline: the proposal this one replaces
        if (state.pendingProposal) state.prevProposalMap = proposalMap(state.pendingProposal);
        // the model saw sanitized URLs; resolve them back to the real tabs/bookmarks
        state.pendingProposal = mapProposalBack(result.proposal, outgoing.map);
        ($("onlyChangesToggle") as HTMLInputElement).checked = !!state.prevProposalMap;
        void emit("proposal");
      }
    }
  } catch (err) {
    state.apiHistory.length = historyMark; // request failed or was stopped — drop the unanswered turn
    bubble.remove();
    addDisplayMessage({
      role: "status",
      text: isAbortError(err) ? "Stopped — nothing was changed." : friendlyApiError(err),
    });
  } finally {
    stopCurrentTurn = null;
    busy = false;
    setBusyUi(false);
    void emit("proposal");
    await persistChat();
  }
}

export function setBusyUi(isBusy: boolean): void {
  const sendBtn = $("sendBtn") as HTMLButtonElement;
  sendBtn.textContent = isBusy ? "■" : "↑";
  sendBtn.title = isBusy ? "Stop generating" : "Send";
  sendBtn.classList.toggle("stopmode", isBusy);
  document.querySelectorAll<HTMLButtonElement>(".chip").forEach((b) => (b.disabled = isBusy));
}


export function wireChat(): void {
  $("newChatBtn").addEventListener("click", async () => {
    state.apiHistory = [];
    state.displayMessages = [];
    state.pendingProposal = null;
    state.sessionExcludedUrls = new Set();
    state.approvedOutgoingKey = "";
    state.conversationScope = null;
    await clearSessionState([
      "apiHistory",
      "displayMessages",
      "pendingProposal",
      "sessionExcludedUrls",
      "approvedOutgoingKey",
      "conversationScope",
    ]);
    renderAllMessages();
    void emit("proposal");
  });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy) {
      stopCurrentTurn?.(); // the send button doubles as Stop while generating
      return;
    }
    const input = $("chatInput") as HTMLTextAreaElement;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    void sendChat(text);
  });
  ($("chatInput") as HTMLTextAreaElement).addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ($("composer") as HTMLFormElement).requestSubmit();
    }
  });
  document.querySelectorAll<HTMLButtonElement>(".chip").forEach((btn) => {
    btn.addEventListener("click", () => void sendChat(btn.dataset.quick!, (btn.dataset.scope as OutgoingScope) ?? "tabs"));
  });
}
