// chat tests — run in the browser harness (see tests/harness/run.js)
window.__harness.suite(async ({ t, assert, wait, $ }) => {
    await t("chat drawer toggles both ways", async () => {
      const wasCollapsed = $("chatDrawer").classList.contains("collapsed");
      $("drawerToggle").click();
      await wait(100);
      assert(
        $("chatDrawer").classList.contains("collapsed") === !wasCollapsed,
        "drawer did not toggle"
      );
      $("drawerToggle").click();
      await wait(100);
      assert(
        $("chatDrawer").classList.contains("collapsed") === wasCollapsed,
        "drawer did not toggle back"
      );
    });
});
