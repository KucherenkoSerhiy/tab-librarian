// options tests — run in the browser harness (see tests/harness/run.js)
window.__harness.suite(async ({ t, assert, wait, $ }) => {
    await t("options: provider switch toggles fields", async () => {
      $("optionsBtn").click();
      await wait(200);
      document.querySelector('.seg-btn[data-provider="openai"]').click();
      await wait(100);
      assert(!$("baseUrlField").hidden && $("workspaceField").hidden, "openai fields wrong");
      document.querySelector('.seg-btn[data-provider="anthropic"]').click();
      await wait(100);
      assert($("baseUrlField").hidden && !$("workspaceField").hidden, "anthropic fields wrong");
    });
    await t("options: validation blocks empty model (openai)", async () => {
      document.querySelector('.seg-btn[data-provider="openai"]').click();
      $("modelInput").value = "";
      $("apiKeyInput").value = "sk-test";
      $("saveSettingsBtn").click();
      await wait(150);
      assert(!$("apiKeyError").hidden, "no validation error shown");
      document.querySelector('.seg-btn[data-provider="anthropic"]').click();
    });
    await t("snapshots: list renders and clear empties it", async () => {
      assert(document.querySelectorAll("#snapshotList .snap-row").length >= 1, "no snapshot rows");
      $("clearBackupsBtn").click();
      await wait(300);
      assert(document.querySelectorAll("#snapshotList .snap-row").length === 0, "list not cleared");
      $("setupBackBtn").click();
      await wait(100);
    });
    await t("options: Privacy section carries the settings", async () => {
      const { settings } = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({ settings: { ...settings, excludedDomains: "bank.example.com" } });
      $("optionsBtn").click();
      await wait(300);
      try {
        assert($("previewOutgoingInput").checked, "preview toggle not on by default");
        assert($("stripQueryInput").checked, "redact toggle not on by default");
        assert($("excludePrivateHostsInput").checked, "private-hosts toggle not on by default");
        assert($("excludedDomainsInput").value.includes("bank.example.com"), "excluded domains not shown");
      } finally {
        $("setupBackBtn").click();
        await wait(300);
      }
    });
});
