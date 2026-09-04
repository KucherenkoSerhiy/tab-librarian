# Tab Librarian

A Manifest V3 extension for Chrome/Brave that organizes 100+ open tabs into a **persistent, nested bookmark folder structure** through an AI chat in the side panel. Bring your own Anthropic API key — no backend, no proxy.

> **Why an API key and not a Claude subscription?** Claude Pro/Max subscriptions only authenticate Anthropic's own apps; there is no third-party OAuth for them. The Anthropic API (console.anthropic.com, pay-per-use) is the only supported path — the setup view explains this to users too.

The side panel is mobile-first (large touch targets, one task per screen):

1. **Home** — compact header (stats live in the title bar), a search + ✨ Sort toolbar, then two **collapsible panels that budget their own scroll areas** so the screen never overflows: *Unsorted tabs* (clustered by domain for browsing/closing only — filing by domain is deliberately not offered, since same site ≠ same topic; that's the AI's job) and *Folders* (the bookmark library: expansion state survives updates, recursive counts, per-folder ↗ open-all-as-tabs / ＋ inline subfolder / ✕ deep-delete, and full drag-and-drop — tabs onto folders, bookmarks between folders, folders into folders with cycle protection). A hero button closes all *sorted* open tabs (they're safe in bookmarks). The **AI chat is a docked drawer at the bottom** — always visible as a bar, expandable to ~⅔ height.
2. **Review** — the proposal as a nested checkbox tree with folder-level master checkboxes and the model's questions; apply bar pinned at the bottom.
3. **Setup / Options** — first-run welcome (API key, model, preferences) that later reopens as the options screen.

Every destructive or filing action (file, unfile, close tab(s), delete folder, apply proposal) raises a 5-second toast with **Undo** — apply-undo fully reverts created bookmarks/folders, moves, and metadata.

## How it works

**Initial sort**
1. Open the side panel (click the toolbar icon).
2. Enter your Anthropic API key in Settings (stored only in `chrome.storage.local`, sent only to `api.anthropic.com`).
3. Hit **Sort all tabs** (or describe your taxonomy in chat — project names, rules for edge cases).
4. The model proposes a folder tree with every tab assigned; ambiguous tabs come back as questions. Nothing is applied yet.
5. Keep chatting to refine — each reply produces a fresh, complete proposal.
6. **Approve & apply** creates real bookmark folders + bookmarks under a dedicated `Tab Librarian` folder in *Other Bookmarks*. Applying is **bookmarks-only** — open tabs are never touched by the AI pipeline; tabs change only through explicit user buttons (close tab, close-all in a cluster, close sorted, open folder as tabs).

**Maintenance**
- Drag an unsorted tab onto any folder (or use ＋) to file it instantly — no LLM call.
- ✕ on a bookmark pulls it back out of its folder.
- **Sort unsorted** asks the model to place only unfiled tabs into the *existing* tree.
- Manual placements are marked 📌 and are never moved by the LLM. Removals are remembered so the model doesn't silently re-propose them.

## Architecture

| Piece | Role |
|---|---|
| `chrome.bookmarks` | Source of truth for the folder tree (natively nested, survives restarts, user-editable in the bookmarks manager). Everything lives under one managed root found by stored ID, never by name. |
| `chrome.storage.local` | Metadata overlay: settings, placement provenance (`manual` vs `llm`), user removals. |
| `chrome.storage.session` | Chat history + pending proposal, so the panel survives close/reopen within a session. |
| `src/background.ts` | Minimal service worker — just opens the panel on toolbar click. |
| `src/sidepanel/` | All logic: tree UI, drag-and-drop, review UI, chat, Anthropic SDK calls (streaming, strict tool use for the proposal JSON). |

The apply step is a **diff, not a rebuild**: it creates missing folders/bookmarks and moves only LLM-placed items, never touching manual placements and never deleting anything.

### Power features

- **Proposal diff view** — when a proposal replaces an earlier one, rows are badged `new`/`moved` and an "Only show changes" filter hides the unchanged bulk. Hidden-but-proposed placements still apply; only explicit unchecks are excluded.
- **Cleanup passes** — the "Clean up" quick action lets the model propose bookmark deletions (each with a reason, using per-bookmark age); they appear as a red-bordered review section, and apply/undo covers them like everything else.
- **Stop button** — the send button becomes ■ while generating; stopping drops the turn cleanly.
- **Prompt caching** — stable system/tool prefix plus an auto breakpoint keeps repeat-turn input costs low on the Anthropic path.
- **Snapshot restore** — Options lists every snapshot with a two-tap Restore that replaces the tree (after force-snapshotting the current state first).
- **Folder rename** — double-click a folder name in the tree.
- **Context menu** — right-click any page → "File this page into…" files it without opening the panel.

## Development

```bash
npm install
npm run build     # typecheck + production build to dist/
npm run dev       # rebuild on change
```

Load it: `chrome://extensions` (or `brave://extensions`) → enable Developer mode → **Load unpacked** → select the `dist/` folder.

### UI preview without loading the extension

`preview/mock-chrome.js` fakes the `chrome.*` APIs with seeded demo data (clustered tabs, a folder tree, a pending proposal):

```bash
npm run build && npm run preview:setup && npm run preview
```

Then open `http://localhost:4173/preview.html`. Comment out the seeded `settings` line in the mock to preview the first-run welcome screen instead.

Opening `/test.html` instead runs the automated smoke suite (`preview/tests.js`) against the mock and reports pass/fail in an overlay + `window.__TEST_RESULTS`.

Other scripts: `npm run build:firefox` produces `dist-firefox/` (sidebar_action + event-page manifest; load via about:debugging); `npm run package` zips `dist/` for the Web Store. `PRIVACY.md` is the store-ready privacy policy.

## Chrome Web Store review notes

Things that will need justification at listing time:

- **`tabs` permission** — reads title/URL of open tabs so the user can sort them. Tab data is sent to `api.anthropic.com` *only* when the user sends a chat message, using their own key.
- **`bookmarks`** — creates/moves bookmarks inside the extension's own `Tab Librarian` folder only.
- **`host_permissions: api.anthropic.com`** — direct BYOK API calls; no other host is contacted. Identity-linked API keys additionally need the workspace ID (Options field) sent as the `anthropic-workspace-id` header.
- **`favicon`** — renders real site icons (via Chrome's internal `_favicon` endpoint, no network requests) in the tab lists, tree, and proposal review.

### Backup & data safety

- Bookmarks are the durable store; if browser sync is on they already replicate to the user's account natively.
- **Cyclic snapshots**: a `chrome.alarms` job in the service worker snapshots the whole tree + metadata every 3 hours; snapshots older than 7 days are pruned (hard cap 80). Extra snapshots are taken before every apply, folder delete, and import.
- Snapshots live in `chrome.storage.local`, which is sandboxed per-extension — websites and other extensions cannot read it. They contain only bookmark URLs/titles (same sensitivity as the bookmarks themselves, which any malware with profile access could read directly anyway). Nothing is ever uploaded.
- **Options → Export** downloads the tree as JSON; **Import** merges a file back additively — it never deletes or moves existing bookmarks.

### AI providers

- **Anthropic** (default): official SDK, streaming, strict tool use, optional workspace ID for identity-linked keys.
- **OpenAI-compatible**: any `/v1/chat/completions` endpoint (OpenAI, OpenRouter, Groq, local Ollama/LM Studio, …) — set base URL + model id; the extension requests host permission for that origin at save time (`optional_host_permissions`). Non-streaming on this path.

### Browser support

- **Chrome, Brave, Edge** (Chromium ≥ 116 with `chrome.sidePanel`): works as-is via Load unpacked.
- **Firefox**: needs a small port — `sidebar_action` instead of `side_panel`, `background.scripts` event page instead of a service worker, and a favicon fallback (no `_favicon` endpoint; the letter avatars already cover this). Core APIs (bookmarks, tabs, storage, alarms) are compatible.
- **Safari**: would require an Xcode-converted build; not planned.
- Privacy policy should state: no data collection, no analytics, no third-party backend; tab titles/URLs leave the machine only to Anthropic on the user's explicit action with their own key.
