// Regenerates dist/preview.html + copies the chrome-API mock into dist so the
// side panel UI can be previewed in a plain browser (npm run preview).
// Run after every build: node preview/make-preview.mjs
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");

copyFileSync(join(here, "mock-chrome.js"), join(dist, "mock-chrome.js"));
copyFileSync(join(here, "tests.js"), join(dist, "tests.js"));

const html = readFileSync(join(dist, "sidepanel.html"), "utf8").replace(
  '<script type="module"',
  '<script src="/mock-chrome.js"></script><script type="module"'
);
writeFileSync(join(dist, "preview.html"), html);
writeFileSync(join(dist, "test.html"), html.replace("</body>", '<script src="/tests.js"></script></body>'));
console.log("dist/preview.html + dist/test.html ready — `npm run preview`, open /preview.html or /test.html");
