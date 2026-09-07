// Regenerates dist/preview.html + dist/test.html so the side panel UI can be
// previewed and tested in a plain browser (npm run preview). Run after every
// build — vite build empties dist/: node tests/harness/make-preview.mjs
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "dist");

copyFileSync(join(here, "mock-chrome.js"), join(dist, "mock-chrome.js"));

// One bundle: the runner, then every suite in a fixed order, then start.
const order = ["home", "review", "chat", "options", "sync", "privacy"];
const suites = order.map((n) => readFileSync(join(here, `${n}.test.js`), "utf8"));
const extra = readdirSync(here).filter(
  (f) => f.endsWith(".test.js") && !order.includes(f.replace(".test.js", ""))
);
if (extra.length) throw new Error(`add to the run order in make-preview.mjs: ${extra.join(", ")}`);
const bundle = [readFileSync(join(here, "run.js"), "utf8"), ...suites, "window.__harness.run();\n"].join("\n");
writeFileSync(join(dist, "tests.js"), bundle);

const html = readFileSync(join(dist, "sidepanel.html"), "utf8").replace(
  '<script type="module"',
  '<script src="/mock-chrome.js"></script><script type="module"'
);
writeFileSync(join(dist, "preview.html"), html);
writeFileSync(join(dist, "test.html"), html.replace("</body>", '<script src="/tests.js"></script></body>'));
console.log("dist/preview.html + dist/test.html ready — `npm run preview`, open /preview.html or /test.html");
