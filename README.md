# Tab Librarian

An AI librarian for your browser tabs. A Manifest V3 side-panel extension for Chrome/Brave that files 100+ open tabs into a **persistent, nested bookmark folder structure** you approve — so you can close them without fear. Bring your own AI: an **Anthropic API key** or **any OpenAI-compatible endpoint** (OpenAI, OpenRouter, Groq, local models via Ollama/LM Studio). No backend, no account, no telemetry.

> **Why an API key and not a Claude/ChatGPT subscription?** Consumer subscriptions only authenticate their vendors' own apps — third-party extensions can't use them. Direct API access (pay-per-use, your key) is what keeps this free, private, and backend-less. Sorting ~150 tabs costs a few cents; daily upkeep is fractions of a cent.

## The panel

Mobile-first (large touch targets, one task per screen), with a one-click 🌙/☀️ **theme toggle** in the header:

1. **Home** — a search + ✨ Sort toolbar, then two **collapsible panels that budget their own scroll areas** so the screen never overflows:
   - *Unmanaged tabs* — open tabs not yet in the library, duplicates collapsed with a ×N badge, clustered by domain for browsing/closing (filing by domain is deliberately not offered — same site ≠ same topic; that's the AI's job). Local `file://` pages are included (toggleable).
   - *Managed tabs* — the bookmark library: expansion state survives updates, recursive counts, per-folder ↗ open-all-as-tabs / ＋ inline subfolder / ✕ deep-delete, double-click to rename, and full drag-and-drop (tabs onto folders, bookmarks between folders, folders into folders with cycle protection).
   - The **AI chat is a docked drawer** at the bottom — always visible as a bar, expandable to ~⅔ height.
   - Close a tab that's in the library and a **"Closed just now — keep in library?"** strip offers one-click bookmark removal (keep is the passive default; entries expire on their own).
2. **Review** — the proposal as a nested checkbox tree with folder-level master checkboxes, `new`/`moved` **diff badges** versus the previous proposal (with an "only show changes" filter), proposed **removals** with reasons, and the model's **questions — answerable inline** (type an answer, batch-send) or resolved instantly by filing the tab yourself via the **type-ahead folder picker**.
3. **Setup / Options** — provider toggle (Anthropic / OpenAI-compatible), key + model, a token-free **Test connection** button, behavior toggles, and the Backup section (snapshots on/off, export/import, restore).

Every destructive or filing action (file, unfile, close tab(s), delete folder, apply proposal) raises a 5-second toast with **Undo** — apply-undo fully reverts created bookmarks/folders, moves, deletions, and metadata. Bulk closes never kill the browser: a window about to be emptied gets a fresh New Tab first.

## How it works

**Initial sort**
1. Open the side panel (toolbar icon), pick a provider and paste your API key (stored only in `chrome.storage.local`, sent only to that provider).
2. Hit **Sort all tabs** — or describe your taxonomy in chat first (project names, rules for edge cases).
3. The model proposes a folder tree with every tab assigned; ambiguous tabs come back as questions. Nothing is applied yet.
4. Refine in chat, answer questions inline, uncheck what you don't want — each reply produces a fresh, complete proposal, diffed against the last one.
5. **Apply** creates real bookmark folders + bookmarks under a dedicated `Tab Librarian` folder in *Other Bookmarks*. Applying is **bookmarks-only** — the AI pipeline never touches open tabs; tabs change only through explicit user buttons (close tab, close-all in a cluster, close sorted, open folder as tabs).
6. Press **Close sorted tabs** and exhale.

**Maintenance**
- Drag an unmanaged tab onto any folder (or ⤷ pick one by typing) to file it instantly — no AI call.
- Right-click any page → **"File this page into…"** files it without even opening the panel.
- **Sort unsorted only** asks the model to place new tabs into the *existing* tree without restructuring it.
- **Clean up** audits the library: duplicates, stale entries (the model sees per-bookmark age), overloaded folders — proposing removals with reasons, behind the same review gate.
- Manual placements are marked 📌 and never moved by the AI. Your removals are remembered so the model doesn't silently re-propose them.
- ↗ on any folder reopens its bookmarks as tabs when you resume that work.

## Architecture

| Piece | Role |
|---|---|
| `chrome.bookmarks` | Source of truth for the folder tree (natively nested, survives restarts, syncs natively, user-editable in the bookmarks manager). Everything lives under one managed root found by stored ID, never by name. |
| `chrome.storage.local` | Metadata overlay: settings, theme, placement provenance (`manual` vs `llm`), user removals, backup snapshots. |
| `chrome.storage.session` | Chat history + pending proposal + diff baseline, so the panel survives close/reopen within a session. |
| `src/background.ts` | Service worker: opens the panel, runs the cyclic backup alarm, maintains the "File this page into…" context menu. |
| `src/sidepanel/` | All interactive logic: tree UI, drag-and-drop, review UI, chat, provider calls (Anthropic SDK with streaming + strict tool use; raw fetch for OpenAI-compatible endpoints). |

The apply step is a **diff, not a rebuild**: it creates missing folders/bookmarks, moves only AI-placed items, and deletes only what you approved in the removals section. Rendering is event-driven with a 2-second dirty-flag poll and a 30-second heartbeat — updates never interrupt a drag, an open picker, or a rename, and can never wedge. Tabs asleep since a browser restart (empty `url`, address in `pendingUrl`) are counted like any other.

## Development

```bash
npm install
npm run build     # typecheck + production build to dist/
npm run dev       # rebuild on change
```

Load it: `chrome://extensions` (or `brave://extensions`) → enable Developer mode → **Load unpacked** → select the `dist/` folder.

### UI preview & tests without loading the extension

`preview/mock-chrome.js` fakes the `chrome.*` APIs (with real event emitters) and seeds demo data:

```bash
npm run build && npm run preview:setup && npm run preview
```

- `http://localhost:4173/preview.html` — interactive preview. Comment out the seeded `settings` line in the mock to see the first-run welcome screen.
- `http://localhost:4173/test.html` — runs the automated smoke suite (`preview/tests.js`, 20 tests covering layout budgets, duplicates, drag-drop persistence, apply/undo, diff review, pickers, snapshots, theme, and regression cases) with results in an overlay + `window.__TEST_RESULTS`.

Other scripts: `npm run build:firefox` produces `dist-firefox/` (Firefox port: `sidebar_action` + event-page manifest — functional, lightly tested; load via about:debugging); `npm run package` zips `dist/` for the Web Store. `PRIVACY.md` is the store-ready privacy policy (hosted at https://kucherenkoserhiy.github.io/tab-librarian/PRIVACY).

## Chrome Web Store review notes

Permissions and their justifications:

- **`tabs`** — reads title/URL of open tabs so the user can sort them. Tab data leaves the machine only when the user sends a chat message, and only to the AI provider they configured with their own key.
- **`bookmarks`** — creates/moves/deletes bookmarks inside the extension's own `Tab Librarian` folder only.
- **`host_permissions: api.anthropic.com`** — the default provider. Identity-linked Anthropic keys additionally send the workspace ID (Options field) as the `anthropic-workspace-id` header.
- **`optional_host_permissions`** — requested at save time for the specific origin of a user-configured OpenAI-compatible endpoint; no other host is ever contacted.
- **`favicon`** — real site icons via Chrome's internal `_favicon` endpoint (no network requests).
- **`alarms` + `unlimitedStorage`** — the 3-hourly backup snapshots (see below).
- **`contextMenus`** — the "File this page into…" right-click action.
- **`storage` / `sidePanel`** — settings and the panel itself.

### Backup & data safety

- Bookmarks are the durable store; if browser sync is on they already replicate to the user's account natively.
- **Cyclic snapshots**: a `chrome.alarms` job snapshots the whole tree + metadata every 3 hours; snapshots older than 7 days are pruned (hard cap 80). Extra snapshots are taken before every apply, folder delete, restore, and import. Options lists them with a two-tap **Restore** (which force-snapshots the current state first), a count-labeled **Clear**, and an on/off toggle.
- Snapshots live in `chrome.storage.local`, sandboxed per-extension — websites and other extensions cannot read it. They contain only bookmark URLs/titles. Nothing is ever uploaded.
- **Options → Export** downloads the tree as JSON; **Import** merges a file back additively — it never deletes or moves existing bookmarks.

### AI providers

- **Anthropic** (default): official SDK, streaming, strict tool use, prompt caching, optional workspace ID for identity-linked keys.
- **OpenAI-compatible**: any `/v1/chat/completions` endpoint with tool-calling (OpenAI, OpenRouter, Groq, local Ollama/LM Studio, …) — set base URL + model id in Options. Non-streaming on this path.

### Browser support

- **Chrome, Brave, Edge** (Chromium ≥ 116 with `chrome.sidePanel`): works as-is.
- **Firefox**: `npm run build:firefox` produces a working port (sidebar instead of side panel; letter avatars instead of `_favicon` icons). Lightly tested — feedback and PRs welcome.
- **Safari**: would require an Xcode-converted build; not planned.
