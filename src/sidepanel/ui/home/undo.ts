// The undo strip: after an apply, one line on Home that reverts it, and after
// an undo, the same line offers Redo. It stays until dismissed or replaced by
// the next apply — a toast that vanishes in five seconds is no use to someone
// who got distracted. Older changes are still recoverable from Options → Snapshots.
import { requestRefresh } from "../../app/bus";
import { state } from "../../app/state";
import { snapshotNow } from "../../services/backup";
import { applyProposal, revertApply } from "../../services/bookmarks";
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
  const last = state.lastApply;
  $("undoStrip").hidden = !last;
  if (!last) return;
  $("undoText").textContent = last.undone ? `Reverted · ${last.summary}` : `Applied · ${last.summary}`;
  const btn = $("undoBtn") as HTMLButtonElement;
  btn.textContent = last.undone ? "Redo" : "Undo";
  btn.title = last.undone ? "Apply it again" : "Put the bookmarks back where they were";
}

/** Undo reverts the last apply; Redo applies the same proposal again (fresh undo data). */
export async function toggleLastApply(): Promise<void> {
  const last = state.lastApply;
  if (!last) return;
  const btn = $("undoBtn") as HTMLButtonElement;
  btn.disabled = true;
  try {
    if (last.undone) {
      await snapshotNow("before redo");
      const result = await applyProposal(last.applied.folders, new Set(last.applied.include), new Set(last.applied.remove));
      await setLastApply({ ...last, undo: result.undo, undone: false, at: Date.now() });
      state.apiHistory.push({ role: "user", content: "(I redid that apply — the bookmarks were filed again.)" });
      addDisplayMessage({ role: "status", text: "Apply redone — bookmarks filed again." });
      showToast("Applied again ✓");
    } else {
      await revertApply(last.undo);
      await setLastApply({ ...last, undone: true, at: Date.now() });
      state.apiHistory.push({ role: "user", content: "(I undid that apply — the bookmarks were reverted.)" });
      addDisplayMessage({ role: "status", text: "Apply undone — bookmarks reverted." });
      showToast("Reverted ✓");
    }
    await persistChat();
  } catch (err) {
    showToast(`${last.undone ? "Redo" : "Undo"} failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    btn.disabled = false;
    await requestRefresh();
  }
}

export function wireUndo(): void {
  $("undoBtn").addEventListener("click", () => void toggleLastApply());
  $("undoDismissBtn").addEventListener("click", () => void setLastApply(null));
  renderUndoStrip();
}
