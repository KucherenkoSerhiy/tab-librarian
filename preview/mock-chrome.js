// Dev-only mock of the chrome.* extension APIs so the side panel UI can be
// previewed in a plain browser tab. Loaded only by dist/preview.html — never
// shipped with the extension.
(() => {
  const noopEvent = () => ({ addListener: () => {}, removeListener: () => {} });
  const clone = (x) => (x === undefined ? x : structuredClone(x));

  const store = {
    local: {},
    session: {
      apiHistory: [],
      displayMessages: [
        { role: "user", text: "Sort my tabs — I mostly juggle client work, learning material, and shopping research." },
        {
          role: "assistant",
          text: "Got it! I found 6 unsorted tabs. I'm grouping client work under Work with one subfolder per client, learning material under Learning, and shopping under Shopping. One tab was ambiguous — see my question in the review. Tap Review to check the proposal.",
        },
      ],
      pendingProposal: {
        folders: [
          {
            path: ["Work", "Client A"],
            tabs: [{ url: "https://github.com/anthropics/anthropic-sdk-typescript", title: "GitHub – anthropic-sdk-typescript" }],
          },
          {
            path: ["Learning"],
            tabs: [
              { url: "https://stackoverflow.com/q/123", title: "Stack Overflow – CSS grid question" },
              { url: "https://typescriptlang.org/docs", title: "TypeScript Handbook" },
            ],
          },
          {
            path: ["Shopping"],
            tabs: [{ url: "https://amazon.com/dp/B0XYZ", title: "Amazon – standing desk" }],
          },
        ],
        questions: [
          {
            url: "https://news.ycombinator.com",
            question: "Is Hacker News reading for Learning, or should it get its own News folder?",
          },
        ],
        removals: [
          {
            url: "https://figma.com/file/abc",
            reason: "Duplicate of the design-system link kept under Projects",
          },
        ],
      },
      // diff baseline: pretend a previous proposal had the SO question under Work
      prevProposalMap: {
        "https://stackoverflow.com/q/123": "Work",
        "https://typescriptlang.org/docs": "Learning",
      },
    },
  };
  // Pre-fill settings so the preview lands on Home instead of Welcome.
  // Comment this line out to preview the first-run Welcome view.
  store.local.settings = { apiKey: "sk-ant-demo", model: "claude-opus-5", includeAllWindows: false, groupTabsOnApply: true };

  const makeArea = (area) => ({
    get: async (k) => {
      const keys = Array.isArray(k) ? k : [k];
      const out = {};
      for (const key of keys) if (key in area) out[key] = clone(area[key]);
      return out;
    },
    set: async (obj) => {
      for (const [k, v] of Object.entries(obj)) area[k] = clone(v);
    },
    remove: async (k) => {
      for (const key of Array.isArray(k) ? k : [k]) delete area[key];
    },
  });

  // ---- bookmarks ----
  let idCounter = 100;
  const nodes = new Map();
  const mk = (id, title, parentId, url) => {
    const n = url ? { id, title, parentId, url } : { id, title, parentId, children: [] };
    nodes.set(id, n);
    if (parentId) nodes.get(parentId).children.push(n);
    return n;
  };
  mk("0", "");
  mk("1", "Bookmarks bar", "0");
  mk("2", "Other bookmarks", "0");
  const create = ({ parentId, title, url }) => clone(mk(String(++idCounter), title, parentId, url));

  const root = create({ parentId: "2", title: "Tab Librarian" });
  const work = create({ parentId: root.id, title: "Work" });
  const clientA = create({ parentId: work.id, title: "Client A" });
  create({ parentId: clientA.id, title: "Figma – Design system", url: "https://figma.com/file/abc" });
  create({ parentId: work.id, title: "Jira board", url: "https://company.atlassian.net/board" });
  const learning = create({ parentId: root.id, title: "Learning" });
  create({ parentId: learning.id, title: "MDN – Drag and Drop API", url: "https://developer.mozilla.org/dnd" });

  // ---- tabs (a "150 open tabs" style workload, clustered by domain) ----
  const demoTabs = [];
  let tabId = 0;
  const addTab = (title, url, pinned = false) =>
    demoTabs.push({ id: ++tabId, windowId: 1, title, url, pinned });

  const ghRepos = ["anthropic-sdk-typescript", "vite", "typescript", "crxjs", "zod", "eslint", "prettier", "vitest"];
  for (const repo of ghRepos) addTab(`GitHub – ${repo}: issues, PRs and more`, `https://github.com/org/${repo}`);
  const soQs = ["CSS grid auto-flow", "MV3 service worker lifetime", "structuredClone vs JSON", "debounce vs throttle", "flexbox min-width 0"];
  soQs.forEach((q, i) => addTab(`Stack Overflow – ${q}?`, `https://stackoverflow.com/q/${1000 + i}`));
  const yt = ["Lo-fi beats to sort tabs to", "Chrome extension tutorial", "TypeScript tips", "Mechanical keyboard review"];
  yt.forEach((t, i) => addTab(`YouTube – ${t}`, `https://youtube.com/watch?v=vid${i}`, i === 0));
  const docs = ["Drag and Drop API", "details element", "prefers-color-scheme"];
  docs.forEach((t, i) => addTab(`MDN – ${t}`, `https://developer.mozilla.org/docs/${i}`));
  addTab("Hacker News", "https://news.ycombinator.com");
  addTab("Amazon – Ergonomic standing desk", "https://amazon.com/dp/B0XYZ");
  addTab("Amazon – USB-C dock comparison", "https://amazon.com/dp/B0ABC");
  addTab("TypeScript Handbook", "https://typescriptlang.org/docs");
  addTab("Figma – Q3 design review", "https://figma.com/file/q3-review");
  addTab("Notion – Meeting notes", "https://notion.so/meeting-notes");
  addTab("Google Docs – Draft blog post", "https://docs.google.com/document/d/1");
  // a tab never activated since browser restart: url empty, pendingUrl set
  demoTabs.push({ id: ++tabId, windowId: 1, title: "Sleeping – restored tab", url: "", pendingUrl: "https://sleeping.example.com/article", pinned: false });

  window.chrome = {
    storage: { local: makeArea(store.local), session: makeArea(store.session) },
    bookmarks: {
      get: async (id) => [clone(nodes.get(id))],
      getChildren: async (id) => clone(nodes.get(id)?.children ?? []),
      getSubTree: async (id) => [clone(nodes.get(id))],
      getTree: async () => [clone(nodes.get("0"))],
      create: async (info) => create(info),
      move: async (id, { parentId }) => {
        const n = nodes.get(id);
        const oldParent = nodes.get(n.parentId);
        oldParent.children = oldParent.children.filter((c) => c.id !== id);
        n.parentId = parentId;
        nodes.get(parentId).children.push(n);
        return clone(n);
      },
      remove: async (id) => {
        const n = nodes.get(id);
        const parent = nodes.get(n.parentId);
        parent.children = parent.children.filter((c) => c.id !== id);
        nodes.delete(id);
      },
      removeTree: async (id) => {
        const n = nodes.get(id);
        const parent = nodes.get(n.parentId);
        parent.children = parent.children.filter((c) => c.id !== id);
        const scrub = (node) => {
          nodes.delete(node.id);
          for (const c of node.children ?? []) scrub(c);
        };
        scrub(n);
      },
      onCreated: noopEvent(),
      onRemoved: noopEvent(),
      onMoved: noopEvent(),
      onChanged: noopEvent(),
    },
    tabs: {
      query: async () => clone(demoTabs),
      update: async () => ({}),
      create: async ({ url } = {}) => {
        if (url) {
          addTab(url, url);
          return clone(demoTabs[demoTabs.length - 1]);
        }
        return {};
      },
      remove: async (ids) => {
        const list = Array.isArray(ids) ? ids : [ids];
        for (const id of list) {
          const i = demoTabs.findIndex((t) => t.id === id);
          if (i >= 0) demoTabs.splice(i, 1);
        }
      },
      group: async () => 1,
      onCreated: noopEvent(),
      onRemoved: noopEvent(),
      onUpdated: noopEvent(),
    },
    tabGroups: { update: async () => ({}) },
    windows: { update: async () => ({}) },
    sidePanel: { setPanelBehavior: async () => ({}) },
  };
})();
