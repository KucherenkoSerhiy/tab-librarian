// home tests — run in the browser harness (see tests/harness/run.js)
window.__harness.suite(async ({ t, assert, wait, $ }) => {
    await t("home renders with panel counters", async () => {
      assert(/^\d+$/.test($("unsortedPanelCount").textContent), "unmanaged counter empty");
      assert(/^\d+$/.test($("foldersPanelCount").textContent), "managed counter empty");
    });
    await t("local file tabs are listed with a 'local file' label", async () => {
      const rows = [...document.querySelectorAll("#unsorted .tab-row")];
      const fileRow = rows.find((r) => r.textContent.includes("stretch-guide.html"));
      assert(fileRow, "file:// tab missing from unmanaged list");
      assert(fileRow.textContent.includes("local file"), "no 'local file' domain label");
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
    await t("panels collapse and reopen", async () => {
      const toggle = document.querySelector('[data-panel="unsortedPanel"]');
      toggle.click();
      await wait(100);
      assert(!$("unsortedPanel").classList.contains("open"), "panel did not collapse");
      toggle.click();
      await wait(100);
      assert($("unsortedPanel").classList.contains("open"), "panel did not reopen");
    });
    await t("folder picker: indented tree + type-to-filter", async () => {
      document.querySelector("#unsorted .tab-row .add-btn").click();
      await wait(150);
      const picker = document.querySelector(".folder-picker");
      assert(picker, "no folder picker opened");
      const nested = [...picker.querySelectorAll(".picker-item")].find((o) =>
        o.textContent.includes("└")
      );
      assert(nested, "no indented nested item found");
      const input = picker.querySelector(".picker-input");
      input.value = "client";
      input.dispatchEvent(new Event("input"));
      await wait(100);
      const items = [...picker.querySelectorAll(".picker-item")];
      assert(
        items.length === 1 && items[0].textContent.includes("Work / Client A"),
        `filtering failed: ${items.map((i) => i.textContent).join(" | ")}`
      );
      picker.remove();
    });
    await t("theme toggle flips light/dark and persists choice", async () => {
      const before = document.documentElement.dataset.theme ?? "system";
      $("themeBtn").click();
      await wait(100);
      const after = document.documentElement.dataset.theme;
      assert(after === "dark" || after === "light", "no data-theme set after toggle");
      assert(after !== before, "theme did not change");
      const { theme } = await chrome.storage.local.get("theme");
      assert(theme === after, "theme choice not persisted");
      $("themeBtn").click(); // restore
      await wait(100);
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
    await t("picker items keep full height with many folders (no flex squish)", async () => {
      // inflate the tree so the list exceeds its max-height
      const root = (await chrome.bookmarks.getChildren("2")).find((n) => !n.url);
      for (let i = 0; i < 15; i++) {
        await chrome.bookmarks.create({ parentId: root.id, title: `Bulk folder ${i}` });
      }
      await wait(2600); // let the poll consume the dirty flags from folder creation
      // deterministic re-render so the row we click can't be replaced mid-test
      const search = $("searchInput");
      search.value = "zz";
      search.dispatchEvent(new Event("input"));
      await wait(250);
      search.value = "";
      search.dispatchEvent(new Event("input"));
      await wait(300);
      // flat (ungrouped) row — a collapsed domain group isn't clickable in real UI
      document.querySelector("#unsorted > .tab-row .add-btn")?.click();
      await wait(500); // let layout settle before measuring
      const items = [...document.querySelectorAll(".folder-picker .picker-item")];
      assert(items.length >= 15, `expected many items, got ${items.length}`);
      const heights = items.map((i) => i.getBoundingClientRect().height);
      const short = heights.filter((h) => h < 28);
      assert(short.length === 0, `squished heights: ${heights.map((h) => Math.round(h)).join(",")}`);
      document.querySelector(".folder-picker")?.remove();
    });
    await t("search: folder badges count matches, not folder size", async () => {
      const s = $("searchInput");
      s.value = "figma";
      s.dispatchEvent(new Event("input"));
      await wait(300);
      const badges = [...document.querySelectorAll("#tree details > summary .count")].map((c) => Number(c.textContent));
      assert(badges.length > 0, "no folders shown for the search");
      assert(badges.every((n) => n >= 1 && n <= 2), `badges should be small match counts, got ${badges.join(",")}`);
      s.value = "";
      s.dispatchEvent(new Event("input"));
      await wait(300);
    });
    await t("deleting an empty folder needs no confirmation", async () => {
      const rootId = (await chrome.storage.local.get("managedRootId")).managedRootId;
      const folder = await chrome.bookmarks.create({ parentId: rootId, title: "Empty test folder" });
      await chrome.bookmarks.create({ parentId: folder.id, title: "Empty child" }); // empty subfolder is not "contents"
      await wait(2600);
      const summary = [...document.querySelectorAll("#tree details > summary")].find((s) => s.textContent.includes("Empty test folder"));
      assert(summary, "empty folder not rendered");
      const del = summary.querySelector(".mini-btn.danger-hover");
      assert(del.title === "Delete folder", `title should not mention contents: ${del.title}`);
      del.click();
      await wait(700);
      assert(!/Sure\?/.test(document.body.innerText), "a 'Sure?' confirmation appeared for an empty folder");
      const left = (await chrome.bookmarks.getChildren(rootId)).some((n) => n.title === "Empty test folder");
      assert(!left, "empty folder still exists after one click");
    });
});
