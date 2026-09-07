// Browser harness runner. The mock chrome API (mock-chrome.js) is loaded first;
// each *.test.js file registers a suite; the last file calls __harness.run().
// Results render in an overlay and in window.__TEST_RESULTS.
window.__harness = (() => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const suites = [];
  window.__TEST_PROGRESS = results;
  const t = async (name, fn) => {
    window.__TEST_CURRENT = name;
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

  return {
    /** Register a suite: fn receives the helpers and awaits its own tests in order. */
    suite: (fn) => suites.push(fn),
    async run() {
      await wait(800); // let the app initialize
      for (const s of suites) await s({ t, assert, wait, $ });
      const passed = results.filter((r) => r.ok).length;
      const box = document.createElement("div");
      box.id = "test-results";
      box.style.cssText =
        "position:fixed;inset:auto 8px 8px 8px;z-index:9999;background:#111;color:#eee;font:12px monospace;padding:10px;border-radius:10px;max-height:45%;overflow:auto;";
      box.innerHTML =
        `<b>${passed}/${results.length} passed</b><br>` +
        results.map((r) => `${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : " — " + r.error}`).join("<br>");
      document.body.appendChild(box);
      window.__TEST_RESULTS = results;
    },
  };
})();
