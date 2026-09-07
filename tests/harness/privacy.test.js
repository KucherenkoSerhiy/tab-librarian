// privacy tests — run in the browser harness (see tests/harness/run.js)
window.__harness.suite(async ({ t, assert, wait, $ }) => {
    await t("find strip is hidden until the AI is asked", async () => {
      assert($("findStrip").hidden, "find strip visible without a query");
    });
    await t("privacy: excluded domain shows a lock and is kept out of the payload", async () => {
      const { settings } = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({ settings: { ...settings, excludedDomains: "bank.example.com" } });
      const s = $("searchInput");
      s.value = "zz";
      s.dispatchEvent(new Event("input"));
      await wait(250);
      s.value = "";
      s.dispatchEvent(new Event("input"));
      await wait(300);
      const bankRow = [...document.querySelectorAll("#unsorted .tab-row")].find((r) => r.textContent.includes("Bank"));
      assert(bankRow, "bank tab not listed");
      assert(bankRow.querySelector(".lock"), "no lock marker on excluded-domain tab");
    });
    await t("privacy: preview shows stripped URLs, omits excluded domain, cancel sends nothing", async () => {
      const before = document.querySelectorAll("#messages .msg, #messages > *").length;
      $("chatInput").value = "sort my tabs please";
      $("composer").dispatchEvent(new Event("submit", { cancelable: true }));
      await wait(600);
      assert(!$("view-outgoing").hidden, "outgoing preview did not open");
      const urls = [...document.querySelectorAll("#view-outgoing .sent-url")].map((e) => e.textContent);
      assert(urls.length > 0, "no outgoing rows");
      assert(urls.every((u) => !u.includes("?") && !u.includes("SECRET")), `query string leaked: ${urls.find((u) => u.includes("?"))}`);
      assert(!$("view-outgoing").textContent.includes("bank.example.com"), "excluded domain present in preview");
      assert($("outgoingSummary").textContent.includes("kept back"), "summary does not mention kept-back items");
      $("outgoingCancelBtn").click();
      await wait(300);
      assert(!$("view-home").hidden, "did not return home after cancel");
      const after = document.querySelectorAll("#messages .msg, #messages > *").length;
      assert(after === before, "a message was added despite cancel");
    });
    await t("privacy: skipping an item in the preview removes it from the next preview", async () => {
      $("chatInput").value = "sort my tabs please";
      $("composer").dispatchEvent(new Event("submit", { cancelable: true }));
      await wait(600);
      const rowsBefore = document.querySelectorAll("#outgoingTabs .tab-row").length;
      document.querySelector("#outgoingTabs .tab-row .remove-btn").click();
      await wait(500);
      const rowsAfter = document.querySelectorAll("#outgoingTabs .tab-row").length;
      assert(rowsAfter === rowsBefore - 1, `expected ${rowsBefore - 1} rows, got ${rowsAfter}`);
      $("outgoingCancelBtn").click();
      await wait(300);
    });
    await t("recall: Enter in the search box opens the sending preview", async () => {
      const s = $("searchInput");
      s.value = "that article about grid layouts";
      s.dispatchEvent(new Event("input"));
      await wait(250);
      s.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await wait(600);
      assert(!$("view-outgoing").hidden, "preview did not open on Enter");
      assert($("outgoingSummary").textContent.includes("This search"), "summary should name the search");
      $("outgoingCancelBtn").click();
      await wait(300);
      s.value = "";
      s.dispatchEvent(new Event("input"));
      await wait(300);
    });
    await t("privacy: titles are redacted and private hosts are kept back", async () => {
      await chrome.tabs.create({ url: "http://intranet/wiki", title: "Wiki – jane.doe@example.com – 4111 1111 1111 1111" });
      await chrome.tabs.create({ url: "https://public.example.com/report", title: "Report for jane.doe@example.com" });
      await wait(2600);
      $("chatInput").value = "sort my tabs please";
      $("composer").dispatchEvent(new Event("submit", { cancelable: true }));
      await wait(600);
      const text = $("view-outgoing").textContent;
      assert(!text.includes("intranet"), "private host was listed for sending");
      assert(!text.includes("jane.doe@example.com"), "email leaked into the payload preview");
      assert(text.includes("[email]"), "redacted title marker missing");
      $("outgoingCancelBtn").click();
      await wait(300);
    });
});
