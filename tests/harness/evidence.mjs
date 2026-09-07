// Drives the preview harness in headless Brave/Chrome over the DevTools protocol
// at side-panel width and saves a PNG per step. Needs `npm run preview` running.
//   npm run evidence   (or: node tests/harness/evidence.mjs [outDir])
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] ?? join("marketing", "evidence-v1.1"); // gitignored: evidence is attached to the PR, not committed
const URL_ = "http://[::1]:4173/preview.html";
const PORT = 9333;
const BROWSERS = [
  "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
];
const exe = BROWSERS.find((p) => existsSync(p));
if (!exe) throw new Error("no Chromium browser found");
mkdirSync(OUT, { recursive: true });

const proc = spawn(exe, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + join(process.env.TEMP ?? "/tmp", "tl-evidence-profile"),
  "--no-first-run",
  "--disable-gpu",
  "--window-size=420,900",
  "about:blank",
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let targets;
for (let i = 0; i < 50 && !targets; i++) {
  await sleep(200);
  targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).catch(() => null);
}
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
};
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate failed");
  return r.result.value;
};
let n = 0;
const shot = async (name) => {
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  const file = join(OUT, `${String(++n).padStart(2, "0")}-${name}.png`);
  writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log("saved", file);
};

await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 2, mobile: false });
await cdp("Page.navigate", { url: URL_ });
await sleep(2500);

// helpers injected once
await evaluate(`window.__h = {
  $: (id) => document.getElementById(id),
  setInput: (el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); },
  key: (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}; "ok"`);

await shot("home");

// Options → Privacy: exclude a domain, save
await evaluate(`__h.$("optionsBtn").click(); __h.sleep(300)`);
await evaluate(`const ta = __h.$("excludedDomainsInput"); __h.setInput(ta, "bank.example.com"); ta.scrollIntoView({ block: "center" }); __h.sleep(200)`);
await shot("options-privacy");
await evaluate(`__h.$("saveSettingsBtn").click(); __h.sleep(500)`);

// Home: the excluded tab carries a lock
await evaluate(`var row = [...document.querySelectorAll("#unsorted .tab-row")].find((r) => r.textContent.includes("Bank")); row && row.scrollIntoView({ block: "center" }); __h.sleep(200)`);
await shot("home-excluded-lock");

// Add a private-host tab and one with an email + card number in the title, then send a message
await evaluate(`(async () => {
  await chrome.tabs.create({ url: "http://intranet/wiki/onboarding", title: "Onboarding wiki – jane.doe@example.com" });
  await chrome.tabs.create({ url: "https://portal.example.com/statements/3f2a9c1e-7b4d-4c8e-9a1f-2b3c4d5e6f70?session=SECRET123", title: "Statement for jane.doe@example.com – card 4111 1111 1111 1111" });
  await __h.sleep(2600);
  __h.setInput(__h.$("chatInput"), "sort my tabs into folders please");
  __h.$("composer").dispatchEvent(new Event("submit", { cancelable: true }));
  await __h.sleep(800);
  return !document.getElementById("view-outgoing").hidden;
})()`);
await shot("before-sending");
await evaluate(`(async () => { var g = [...document.querySelectorAll("#outgoingGroups .og-group")].find((r) => r.textContent.includes("portal.example.com")); g.open = true; g.scrollIntoView({ block: "center" }); await __h.sleep(200); })()`);
await shot("before-sending-redacted-entry");
await evaluate(`(async () => { var g = [...document.querySelectorAll("#outgoingGroups .og-group")].find((r) => r.textContent.includes("youtube")); g.querySelector("summary .add-btn").click(); await __h.sleep(700); document.querySelector("#outgoingKeptBack").scrollIntoView({ block: "start" }); })()`);
await shot("before-sending-kept-back");
await evaluate(`(async () => { const box = document.querySelector("#outgoingRawBox"); box.open = true; box.scrollIntoView({ block: "start" }); await __h.sleep(300); })()`);
await shot("before-sending-exact-text");
await evaluate(`__h.$("outgoingCancelBtn").click(); __h.sleep(400)`);

// Search: badges count matches; sentence → hint; Enter → preview
await evaluate(`__h.setInput(__h.$("searchInput"), "figma"); __h.sleep(400)`);
await shot("search-match-counts");
await evaluate(`__h.setInput(__h.$("searchInput"), "that article about css grid layouts"); __h.sleep(400)`);
await shot("search-sentence-hint");
await evaluate(`__h.key(__h.$("searchInput"), "Enter"); __h.sleep(800)`);
await shot("enter-opens-preview");

// Recall result: the model is stubbed (no network in the harness) with a canned report_matches
await evaluate(`window.fetch = async (url, init) => new Response(JSON.stringify({
  id: "msg_demo", type: "message", role: "assistant", model: "claude-sonnet-5",
  content: [{ type: "tool_use", id: "tu_1", name: "report_matches", input: { matches: [
    { url: "https://stackoverflow.com/q/1000", why: "the CSS grid question you saved" },
    { url: "https://developer.mozilla.org/docs/1", why: "MDN reference on the same topic" },
  ] } }],
  stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
}), { status: 200, headers: { "content-type": "application/json", "request-id": "demo" } }); "stubbed"`);
await evaluate(`__h.$("outgoingSendBtn").click(); __h.sleep(1800)`);
await shot("recall-results-with-why");

// Review: folder note
await evaluate(`__h.setInput(__h.$("searchInput"), ""); __h.sleep(300)`);
await evaluate(`__h.$("resumeReviewBtn").click(); __h.sleep(400)`);
await shot("review-folder-note");

ws.close();
proc.kill();
console.log("done:", n, "screenshots in", OUT);
