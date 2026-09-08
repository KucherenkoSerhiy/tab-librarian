// review tests — run in the browser harness (see tests/harness/run.js)
window.__harness.suite(async ({ t, assert, wait, $ }) => {
    await t("review shows icons + master checkboxes", async () => {
      $("resumeReviewBtn").click();
      await wait(200);
      assert(document.querySelectorAll("#reviewTree .master-check").length > 0, "no master checkboxes");
      assert(
        document.querySelectorAll("#reviewTree .review-tab .avatar, #reviewTree .review-tab .site-icon")
          .length > 0,
        "no icons in review"
      );
      $("reviewBackBtn").click();
      await wait(100);
    });
    await t("questions offer inline answers + direct filing", async () => {
      $("resumeReviewBtn").click();
      await wait(200);
      const input = document.querySelector(".answer-input");
      assert(input, "no answer input on question");
      const sendBtn = document.getElementById("sendAnswersBtn");
      assert(sendBtn && sendBtn.disabled, "send-answers should start disabled");
      input.value = "Entertainment";
      input.dispatchEvent(new Event("input"));
      assert(!sendBtn.disabled, "send-answers did not enable after typing");
      // direct-file path resolves the question without any AI round trip:
      // type to filter, Enter to pick
      const before = document.querySelectorAll("#reviewQuestions .question").length;
      document.querySelector("#reviewQuestions .add-btn").click();
      await wait(150);
      const pickerInput = document.querySelector("#reviewQuestions .folder-picker .picker-input");
      assert(pickerInput, "no folder picker on question card");
      pickerInput.value = "work";
      pickerInput.dispatchEvent(new Event("input"));
      await wait(100);
      pickerInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await wait(400);
      assert(
        document.querySelectorAll("#reviewQuestions .question").length === before - 1,
        "question not resolved after direct filing"
      );
      $("reviewBackBtn").click();
      await wait(100);
    });
    await t("closing a managed tab offers optional bookmark removal", async () => {
      // HN became managed in the direct-filing test above; close all its open tabs
      const hnTabs = (await chrome.tabs.query({})).filter((t) =>
        (t.url || "").includes("news.ycombinator")
      );
      assert(hnTabs.length > 0, "no HN tabs to close");
      await chrome.tabs.remove(hnTabs.map((t) => t.id));
      await wait(600);
      const strip = $("recentlyClosed");
      assert(!strip.hidden && strip.querySelector(".rc-row"), "closed-managed strip missing");
      // remove the bookmark from the strip
      strip.querySelector(".mini-btn.danger-hover").click();
      await wait(500);
      assert(/Bookmark removed/.test(document.querySelector("#toast .toast-text").textContent), "no removal toast");
      assert($("recentlyClosed").hidden, "strip did not clear");
    });
    await t("apply proposal then undo reverts", async () => {
      const counts = () => `${$("unsortedPanelCount").textContent}/${$("foldersPanelCount").textContent}`;
      const before = counts();
      $("resumeReviewBtn").click();
      await wait(150);
      $("approveBtn").click();
      await wait(700);
      assert(!$("view-home").hidden, "did not return home after apply");
      assert(!$("undoStrip").hidden && /Applied/.test($("undoText").textContent), `no undo strip; text: ${$("undoText").textContent}`);
      assert((await chrome.storage.session.get("lastApply")).lastApply, "undo data not persisted for the session");
      await wait(5500); // well past the old 5-second toast: the strip must still be there
      assert(!$("undoStrip").hidden, "undo strip vanished on its own");
      const applied = counts();
      $("undoBtn").click();
      await wait(700);
      assert(counts() === before, `counters not reverted: "${counts()}" vs "${before}"`);
      assert(!$("undoStrip").hidden && /Reverted/.test($("undoText").textContent), "strip should now offer Redo");
      assert($("undoBtn").textContent === "Redo", `button should read Redo, got ${$("undoBtn").textContent}`);
      $("undoBtn").click(); // redo
      await wait(900);
      assert(counts() === applied, `redo did not restore the apply: "${counts()}" vs "${applied}"`);
      assert($("undoBtn").textContent === "Undo", "button should read Undo again after redo");
      $("undoBtn").click(); // undo again, leave the library as it was
      await wait(700);
      assert(counts() === before, `second undo failed: "${counts()}" vs "${before}"`);
      $("undoDismissBtn").click();
      await wait(300);
      assert($("undoStrip").hidden, "strip still shown after dismiss");
      assert(!(await chrome.storage.session.get("lastApply")).lastApply, "undo data not cleared after dismiss");
    });
    await t("review shows the folder note (why grouped)", async () => {
      $("resumeReviewBtn").click();
      await wait(300);
      const note = [...document.querySelectorAll("#reviewTree .folder-note")].map((e) => e.textContent);
      assert(note.some((n) => n.includes("Client A engagement")), `no folder note; got ${JSON.stringify(note)}`);
      $("reviewBackBtn").click();
      await wait(300);
    });
});
