// chat tests — run in the browser harness (see tests/harness/run.js)
window.__harness.suite(async ({ t, assert, wait, $ }) => {
    await t("chat asks what you are working on, and 'Sort all tabs' says so", async () => {
      $("newChatBtn").click(); // a fresh conversation shows the empty-state advice
      await wait(300);
      const empty = document.querySelector("#messages .chat-empty");
      assert(empty && /what you're working on/.test(empty.textContent), "empty chat does not say 'what you're working on'");
      assert($("chatInput").placeholder === "What are you working on?", `placeholder: ${$("chatInput").placeholder}`);
      const chip = [...document.querySelectorAll(".chip")].find((c) => c.textContent.trim() === "Sort all tabs");
      assert(chip && /what I'm working on/.test(chip.dataset.quick), "'Sort all tabs' request does not mention what I'm working on");
      assert(/under Other/.test(chip.dataset.quick), "'Sort all tabs' request does not mention Other");
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
    await t("model asks for the library: the step is forced even with previews off; Send answers the tool call", async () => {
      const { settings } = await chrome.storage.local.get("settings");
      const realFetch = window.fetch;
      const bodies = [];
      try {
        await chrome.storage.local.set({ settings: { ...settings, provider: "openai", baseUrl: "https://stub.local/v1", apiKey: "k", model: "m", previewOutgoing: false } });
        window.fetch = async (url, init) => {
          bodies.push(JSON.parse(init.body));
          const first = bodies.length === 1;
          const message = first
            ? { content: "I need your library for that.", tool_calls: [{ id: "call_1", type: "function", function: { name: "request_library", arguments: JSON.stringify({ reason: "reorganize your existing folders by project" }) } }] }
            : { content: "Done — here is what I changed." };
          return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { "content-type": "application/json" } });
        };
        $("chatInput").value = "rearrange all my bookmarks by project";
        $("composer").dispatchEvent(new Event("submit", { cancelable: true }));
        await wait(900);
        assert(!$("view-outgoing").hidden, "Before-sending did not appear for the model's request (previews are off)");
        assert(/asked for your library bookmarks: reorganize your existing folders by project/.test($("outgoingNote").textContent), `note: ${$("outgoingNote").textContent}`);
        assert($("outgoingIncludeLibrary").checked, "library checkbox should be on");
        assert(bodies.length === 1 && !JSON.stringify(bodies[0].messages).includes('"existingBookmarks"'), "the library left before approval"); // (the tool description mentions the key; the messages must not carry it)
        $("outgoingSendBtn").click();
        await wait(900);
        assert(bodies.length === 2, `expected a second request after Send, got ${bodies.length}`);
        const toolMsg = bodies[1].messages.find((m) => m.role === "tool" && m.tool_call_id === "call_1");
        assert(toolMsg && /existingBookmarks/.test(toolMsg.content), "tool result does not carry the library");
        assert((await chrome.storage.session.get("conversationScope")).conversationScope === "library", "conversation scope not remembered");
        assert(/Library shared with the AI/.test($("messages").textContent), "no status line about sharing");
        assert(/Done — here is what I changed/.test($("messages").textContent), "second reply not shown");
      } finally {
        if (!$("view-outgoing").hidden) { $("outgoingCancelBtn").click(); await wait(900); }
        window.fetch = realFetch;
        await chrome.storage.local.set({ settings });
        $("newChatBtn").click();
        await wait(300);
      }
    });
    await t("model asks for the library: Cancel answers 'declined' and the model continues without it", async () => {
      const { settings } = await chrome.storage.local.get("settings");
      const realFetch = window.fetch;
      const bodies = [];
      try {
        await chrome.storage.local.set({ settings: { ...settings, provider: "openai", baseUrl: "https://stub.local/v1", apiKey: "k", model: "m", previewOutgoing: false } });
        window.fetch = async (url, init) => {
          bodies.push(JSON.parse(init.body));
          const message = bodies.length === 1
            ? { content: "", tool_calls: [{ id: "call_2", type: "function", function: { name: "request_library", arguments: JSON.stringify({ reason: "audit duplicates" }) } }] }
            : { content: "Understood, I only filed the open tabs." };
          return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { "content-type": "application/json" } });
        };
        $("chatInput").value = "find duplicates in my library";
        $("composer").dispatchEvent(new Event("submit", { cancelable: true }));
        await wait(900);
        assert(!$("view-outgoing").hidden, "Before-sending did not appear");
        $("outgoingCancelBtn").click();
        await wait(900);
        assert(bodies.length === 2, `expected a second request after Cancel, got ${bodies.length}`);
        const toolMsg = bodies[1].messages.find((m) => m.role === "tool" && m.tool_call_id === "call_2");
        assert(toolMsg && /declined/.test(toolMsg.content) && !/existingBookmarks/.test(toolMsg.content), "declined answer wrong or library leaked");
        assert(!(await chrome.storage.session.get("conversationScope")).conversationScope, "scope must not be remembered after Cancel");
        assert(/Library not sent/.test($("messages").textContent), "no status line about declining");
      } finally {
        if (!$("view-outgoing").hidden) { $("outgoingCancelBtn").click(); await wait(900); }
        window.fetch = realFetch;
        await chrome.storage.local.set({ settings });
        $("newChatBtn").click();
        await wait(300);
      }
    });
});
