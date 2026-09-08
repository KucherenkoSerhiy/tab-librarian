// Runs the browser harness (dist/test.html) in headless Brave/Chrome over the
// DevTools protocol and prints the results. Exit code 1 on any failure.
//   npm run test:ui   (builds, regenerates dist/test.html, starts the preview server if needed)
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const URL_ = process.env.HARNESS_URL ?? "http://[::1]:4173/test.html";
const PORT = 9334;
const BROWSERS = [
  "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
];
const exe = BROWSERS.find((p) => existsSync(p));
if (!exe) throw new Error("no Chromium browser found");

// Start the preview server unless one is already answering.
let server = null;
const up = await fetch(URL_).then((r) => r.ok).catch(() => false);
if (!up) {
  server = spawn("npx", ["vite", "preview", "--port", "4173", "--strictPort"], { shell: true, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await fetch(URL_).then((r) => r.ok).catch(() => false)) break;
  }
}

const proc = spawn(exe, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + join(process.env.TEMP ?? "/tmp", "tl-harness-profile"),
  "--no-first-run",
  "--disable-gpu",
  "--window-size=480,900",
  "about:blank",
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bye = (code) => {
  try {
    proc.kill();
  } catch {}
  if (server) spawn("taskkill", ["/pid", String(server.pid), "/t", "/f"], { shell: true, stdio: "ignore" });
  process.exit(code);
};

let targets;
for (let i = 0; i < 50 && !targets; i++) {
  await sleep(200);
  targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).catch(() => null);
}
if (!targets) bye(2);
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

await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: 480, height: 900, deviceScaleFactor: 1, mobile: false });
await cdp("Page.navigate", { url: URL_ });

const started = Date.now();
let results = null;
while (!results && Date.now() - started < 240_000) {
  await sleep(2000);
  results = await evaluate("window.__TEST_RESULTS ?? null");
  if (!results) {
    const cur = await evaluate("window.__TEST_CURRENT ?? ''");
    const done = await evaluate("(window.__TEST_PROGRESS ?? []).length");
    process.stdout.write(`\r  ${done} done — ${cur.slice(0, 70).padEnd(70)}`);
  }
}
process.stdout.write("\n");
if (!results) {
  console.error("harness did not finish within 4 minutes");
  bye(2);
}
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok ? "" : " — " + r.error}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
ws.close();
bye(failed ? 1 : 0);
