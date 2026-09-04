// Produces dist-firefox/ from a finished dist/ build:
// same code, Firefox manifest (sidebar_action, event-page background, no
// sidePanel/favicon permissions). Run after `npm run build`.
import { cpSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const out = join(root, "dist-firefox");

rmSync(out, { recursive: true, force: true });
cpSync(dist, out, { recursive: true });
copyFileSync(join(root, "manifest.firefox.json"), join(out, "manifest.json"));
console.log("dist-firefox/ ready — load via about:debugging → This Firefox → Load Temporary Add-on");
