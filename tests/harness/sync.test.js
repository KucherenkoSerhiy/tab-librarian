// sync tests — run in the browser harness (see tests/harness/run.js)
window.__harness.suite(async ({ t, assert, wait, $ }) => {
    await t("updates resume after an abandoned drag (regression: latched drag froze the poll)", async () => {
      // dragstart with NO dragend — previously this froze background updates forever
      document
        .querySelector("#unsorted .tab-row")
        ?.dispatchEvent(new DragEvent("dragstart", { bubbles: true }));
      const before = Number($("unsortedPanelCount").textContent);
      await chrome.tabs.create({ url: "https://latch-test.example.com/page" });
      await wait(4500); // drag signal expires (1.5s) + poll tick (2s) + margin
      assert(
        Number($("unsortedPanelCount").textContent) === before + 1,
        `poll stayed frozen: count ${$("unsortedPanelCount").textContent}, expected ${before + 1}`
      );
    });
});
