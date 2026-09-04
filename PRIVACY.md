# Privacy Policy — AI Smart Tab Manager

_Last updated: 2026-09-04_

**Summary: your data stays on your device, except when you explicitly ask the AI to sort, in which case tab titles and URLs are sent directly to the AI provider you configured, using your own API key. There is no backend, no analytics, and no data collection by the extension's author.**

## What the extension accesses

- **Open tabs** (title, URL, pinned state, window) — to show them in the panel and let you sort them.
- **Bookmarks** — the extension creates and manages folders/bookmarks inside its own "AI Smart Tab Manager" folder. It never modifies bookmarks outside that folder.

## What leaves your device

- When you send a chat message, your open tabs' titles/URLs and your managed folder structure are sent **directly to the AI provider you configured** (Anthropic's api.anthropic.com by default, or an OpenAI-compatible endpoint you set), authenticated with **your own API key**. That provider's privacy policy governs that data.
- Nothing else is transmitted, ever. There is no telemetry, no analytics, and no author-operated server.

## What is stored locally

- Your API key, settings, placement metadata, chat state (session-only), and automatic backup snapshots of your bookmark tree — all in the browser's extension storage on your device, sandboxed from websites and other extensions.
- Snapshots can be disabled and cleared at any time in Options.

## Your choices

- Remove the extension to delete all locally stored data.
- Export your bookmark tree at any time (Options → Backup → Export).
