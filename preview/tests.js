// Automated smoke tests for the side panel, run against the chrome-API mock.
// Loaded only by dist/test.html (npm run preview:setup && npm run preview,
// then open /test.html). Results render in an overlay + window.__TEST_RESULTS.
(() => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const t = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, error: String(err) });
    }
  };
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  const $ = (id) => document.getElementById(id);

  async function run() {
    await wait(800); // let the app initialize

    await t("home renders with panel counters", async () => {
      assert(/^\d+$/.test($("unsortedPanelCount").textContent), "unmanaged counter empty");
      assert(/^\d+$/.test($("foldersPanelCount").textContent), "managed counter empty");
    });

    await t("sleeping tabs (pendingUrl only) are counted", async () => {
      const titles = [...document.querySelectorAll("#unsorted .tab-title")].map((e) => e.textContent);
      assert(titles.some((t) => t.includes("Sleeping – restored tab")), "pendingUrl tab missing");
    });

    await t("no vertical page overflow", async () => {
      assert(document.body.scrollHeight - window.innerHeight <= 1, "body overflows vertically");
    });

    await t("duplicate tabs collapse with ×N badge", async () => {
      await chrome.tabs.create({ url: "https://news.ycombinator.com" });
      await chrome.tabs.create({ url: "https://news.ycombinator.com" });
      const s = $("searchInput");
      s.value = "zz";
      s.dispatchEvent(new Event("input"));
      await wait(250);
      s.value = "";
      s.dispatchEvent(new Event("input"));
      await wait(250);
      assert(document.querySelector("#unsorted .dup-badge")?.textContent === "×3", "no ×3 badge");
    });

    await t("drop files tab into folder, folder stays open, undo works", async () => {
      const card = document.querySelector("#tree > details");
      card.open = true;
      await wait(100);
      const dt = new DataTransfer();
      dt.setData(
        "application/json",
        JSON.stringify({ kind: "tab", title: "HN", url: "https://news.ycombinator.com" })
      );
      card.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      await wait(400);
      assert(document.querySelector("#tree > details").open, "folder collapsed after drop");
      const undo = document.querySelector("#toast .undo-btn");
      assert(undo, "no undo on drop toast");
      undo.click();
      await wait(400);
    });

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
      // direct-file path resolves the question without any AI round trip
      const before = document.querySelectorAll("#reviewQuestions .question").length;
      document.querySelector("#reviewQuestions .add-btn").click();
      await wait(150);
      const select = document.querySelector("#reviewQuestions .inline-select");
      assert(select, "no folder select on question card");
      select.value = select.options[1].value;
      select.dispatchEvent(new Event("change"));
      await wait(400);
      assert(
        document.querySelectorAll("#reviewQuestions .question").length === before - 1,
        "question not resolved after direct filing"
      );
      $("reviewBackBtn").click();
      await wait(100);
    });

    await t("apply proposal then undo reverts", async () => {
      const counts = () => `${$("unsortedPanelCount").textContent}/${$("foldersPanelCount").textContent}`;
      const before = counts();
      $("resumeReviewBtn").click();
      await wait(150);
      $("approveBtn").click();
      await wait(700);
      assert(/Applied/.test(document.querySelector("#toast .toast-text").textContent), "no applied toast");
      document.querySelector("#toast .undo-btn").click();
      await wait(700);
      assert(counts() === before, `counters not reverted: "${counts()}" vs "${before}"`);
    });

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

    await t("panels collapse and reopen", async () => {
      const toggle = document.querySelector('[data-panel="unsortedPanel"]');
      toggle.click();
      await wait(100);
      assert(!$("unsortedPanel").classList.contains("open"), "panel did not collapse");
      toggle.click();
      await wait(100);
      assert($("unsortedPanel").classList.contains("open"), "panel did not reopen");
    });

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

    await t("folder picker renders as an indented tree", async () => {
      document.querySelector("#unsorted .tab-row .add-btn").click();
      await wait(150);
      const select = document.querySelector(".inline-select");
      assert(select, "no folder select opened");
      const nested = [...select.options].find((o) => o.textContent.includes("└"));
      assert(nested, "no indented nested option found");
      select.remove();
    });

    await t("folder rename input appears on double-click", async () => {
      const name = document.querySelector("#tree .folder-name");
      name.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      await wait(100);
      const input = document.querySelector(".rename-input");
      assert(input, "no rename input");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await wait(300);
    });

    const passed = results.filter((r) => r.ok).length;
    const box = document.createElement("div");
    box.id = "test-results";
    box.style.cssText =
      "position:fixed;inset:auto 8px 8px 8px;z-index:9999;background:#111;color:#eee;font:12px monospace;padding:10px;border-radius:10px;max-height:45%;overflow:auto;";
    box.innerHTML =
      `<b>${passed}/${results.length} passed</b><br>` +
      results
        .map((r) => `${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : " — " + r.error}`)
        .join("<br>");
    document.body.appendChild(box);
    window.__TEST_RESULTS = results;
  }

  run();
})();
