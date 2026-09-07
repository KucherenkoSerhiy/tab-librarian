// Architecture guard: dependencies point inward and no two modules import each other.
//   ui/* → app/*, services/*, domain/*      app/* → services/*, domain/* (+ ui renderers via bus only)
//   services/* → domain/*, app/state          domain/* → types only
// Run: node scripts/check-layers.mjs   (exit 1 on a violation)
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, posix } from "node:path";

const root = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "src");
const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".ts")) files.push(p);
  }
};
walk(root);

const id = (p) => posix.normalize(relative(root, p).replace(/\\/g, "/")).replace(/\.ts$/, "");
const layer = (m) =>
  m.includes("/ui/") ? "ui" : m.includes("/app/") ? "app" : m.includes("/services/") ? "services" : m.includes("/domain/") ? "domain" : "root";
const allowed = {
  root: new Set(["root", "ui", "app", "services", "domain"]),
  ui: new Set(["root", "ui", "app", "services", "domain"]),
  app: new Set(["root", "app", "services", "domain", "ui"]), // refresh.ts renders; it is the composition point
  services: new Set(["root", "services", "domain", "app"]), // payload/tabs read shared state
  domain: new Set(["root", "domain"]),
};

const graph = new Map();
for (const f of files) {
  const from = id(f);
  const deps = new Set();
  for (const [, spec] of readFileSync(f, "utf8").matchAll(/from "(\.[^"]+)"/g)) {
    let t = posix.normalize(posix.join(posix.dirname(from), spec));
    if (!existsSync(join(root, `${t}.ts`)) && existsSync(join(root, t, "index.ts"))) t = `${t}/index`;
    deps.add(t);
  }
  graph.set(from, deps);
}

const problems = [];
for (const [from, deps] of graph) {
  for (const to of deps) {
    if (!allowed[layer(from)].has(layer(to))) problems.push(`layer: ${from} → ${to}`);
    if (graph.get(to)?.has(from)) problems.push(`cycle: ${from} ↔ ${to}`);
  }
}
const unique = [...new Set(problems.map((p) => p.replace(/(cycle: )(\S+) ↔ (\S+)/, (_, c, a, b) => c + [a, b].sort().join(" ↔ "))))];
if (unique.length) {
  console.error(unique.join("\n"));
  process.exit(1);
}
console.log(`layers ok: ${graph.size} modules, no cycles`);
