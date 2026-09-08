// The undo strip: after an apply, one line on Home that reverts it. It stays
// until the user undoes, dismisses it, or applies something else — a toast
// that vanishes in five seconds is no use to someone who got distracted.
// Older changes are still recoverable from Options → Snapshots.
import { requestRefresh } from "../../app/bus";
import { state } from "../../app/state";
import { revertApply } from "../../services/bookmarks";
import { setSessionState } from "../../services/storage";
import { addDisplayMessage, persistChat } from "../chat/chat";
import { $, showToast } from "../dom";

export type LastApply = NonNullable<typeof state.lastApply>;

export async function setLastApply(last: LastApply | null): Promise<void> {
  state.lastApply = last;
  await setSessionState("lastApply", last);
  renderUndoStrip();
}

export function renderUndoStrip(): void {
  const strip = $("undoStrip");
  strip.hidden = !state.lastApply;
  if (state.lastApply) $("undoText").textContent = state.lastApply.summary;
}

export async function undoLastApply(): Promise<void> {
  const last = state.lastApply;
  if (!last) return;
  const btn = $("undoBtn") as HTMLButtonElement;
  btn.disabled = true;
  try {
    await revertApply(last.undo);
    await setLastApply(null);
    state.apiHistory.push({ role: "user", content: "(I undid that apply — the bookmarks were reverted.)" });
    addDisplayMessage({ role: "status", text: "Apply undone — bookmarks reverted." });
    await persistChat();
    showToast("Reverted ✓");
  } catch (err) {
    showToast(`Undo failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    btn.disabled = false;
    await requestRefresh();
  }
}

export function wireUndo(): void {
  $("undoBtn").addEventListener("click", () => void undoLastApply());
  $("undoDismissBtn").addEventListener("click", () => void setLastApply(null));
  renderUndoStrip();
}
