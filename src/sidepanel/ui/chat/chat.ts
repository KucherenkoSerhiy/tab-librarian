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
 * tabs plus folder summaries by default; the library only for cleanup, or
 * when the user ticks it in the Before-sending step.
 */
export async function sendChat(userText: string, scope: OutgoingScope = "tabs"): Promise<void> {
  if (busy || !userText.trim()) return;
  const settings = await getSettings();
  if (!settings.apiKey) {
    openSetup(false);
    return;
  }

  const outgoing = await confirmOutgoing(await buildOutgoing(scope), "This message");
  if (!outgoing) return;

  busy = true;
  setBusyUi(true);
  addDisplayMessage({ role: "user", text: userText });
  setDrawer(true);

  state.apiHistory.push({ role: "user", content: `${userText}\n\n${outgoing.text}` });

  const bubble = renderMessage({ role: "assistant", text: "Thinking…" });
  let streamed = "";

  try {
    const result = await runChatTurn({
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

    if (result.refusal) {
      state.apiHistory.pop(); // keep history clean of the refused turn
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
    state.apiHistory.pop(); // request failed or was stopped — drop the unanswered user turn
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
    await clearSessionState([
      "apiHistory",
      "displayMessages",
      "pendingProposal",
      "sessionExcludedUrls",
      "approvedOutgoingKey",
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
