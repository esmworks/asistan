# Changelog

All notable changes to Yumak Bot are listed here. Versions follow [Semantic Versioning](https://semver.org/). While the
version is 0.x, a minor release may change the data format or the API; the server migrates its database on start.

## Unreleased

### Apps

- The desktop app updates itself from GitHub releases on macOS and Windows: a new version downloads in the background,
  and the app offers to restart into it or installs it when it quits. Apps from 0.2.0 and earlier have no updater, so
  this version is installed by hand once.

## 0.2.0 — 2026-11-16

### Apps

- A phone app for iOS and Android, built with Expo, with every screen of the web app's phone layout: bots, rooms,
  conversations, Today, search, the editors and every settings section. It is run from source for now; see the README.
- The product name is written "Yumak Bot", with a space, everywhere a person reads it. Code names, package names,
  environment variables and the desktop app's install path keep "YumakBot", so an existing installation stays as it is.
- Larger text, icons and avatars on the web and the phone.
- A sent message stays in place until the server's copy arrives instead of seeming to land twice.
- The bot's browser opens as a small card with the actions that fit while there is no picture to show.
- The icons in the macOS installer window are centered.

### Connections and models

- One card on the connection page holds every AI the bots can use (Claude, each provider with a key, each endpoint)
  with a single "add a provider"; the model card only chooses. The phone has the same layout.
- A model a provider does not list yet can be named by hand, for a built-in provider and for an endpoint; its price is
  unknown and counted as nothing.
- Model names can be searched as you type, and Claude settings fold away when another provider is chosen.
- Trying an OpenCode model works; the test request now names a session, as OpenCode requires.

### Memory

- Bots' notes take effect as soon as they are written, without waiting for approval, so a bot can use and tidy notes
  written by routines, other bots or an import.
- Bots can correct a note with `memory_update` and delete one with `memory_forget`, for their own notes and the shared
  memory but not another bot's notes; `memory_search` without a query lists every note the bot sees.
- Importing bots copies only what the other app saved as memory, and imported notes are saved active.
- The memory screen groups the bots' notes by bot, archived bots marked, and one bot's notes can be deleted at once.

### Running it

- `docker/apparmor.sh` checks a Linux host and picks the `YUMAKBOT_APPARMOR` value the shell and desktop sandboxes need,
  loading the AppArmor profile only where it is required.

### Upgrading from 0.1.0

- Notes that were waiting as proposals become active memory the bot can see, and the memory status goes away; no note
  is lost. The API still reports status `active` on every note for phone builds made before this change.

## 0.1.0 — 2026-11-15

The first public release.

### Bots

- Create as many bots as you like and group them; each has its own name, avatar, instructions, model, memory, files
  and permissions.
- Two engines: Claude through the Claude Agent SDK (a Claude subscription token or an Anthropic API key), or models
  from other providers with your own key.
- A manager bot can create, update and hand work to other bots; bot-to-bot messages are guarded against loops.
- Rooms: a group conversation where chosen bots talk with you and with each other.
- Skills, imported from a link, with a warning for skill text that hides something.
- Import bots exported from other assistants, and export your own to a file the importer reads.

### Chat

- Streamed replies, file attachments, stopping at any time, and turns that carry on after a server restart.
- Unread marks, find in a conversation, `/` commands, quick replies, a goal per conversation, branching from a reply,
  Markdown export, sortable tables and Mermaid diagrams.
- Approvals: bots ask before using a tool you have not allowed, and a decision can be remembered per bot.

### Memory, routines and usage

- Bots keep notes across chats (or work without memory) and look through their past conversations.
- Routines run on a schedule (including cron and day and hour windows), when the server starts, from a filtered
  webhook, or when a watched page changes. Bots can turn their routines off, change them and delete them.
- A Today page of what the bots did and what waits for you.
- Spending by bot, model and routine, a monthly limit and a CSV export.
- Call a bot from a script with the access key and get its reply.

### Tools

- Connections to remote MCP servers, chosen per bot, with more than one account per service.
- A browser per bot, which you can watch live and take over for sign-ins and verification codes.
- A password vault: you type credentials into a card and the server fills them in; the bot never sees them.
- An optional sandboxed Linux desktop per bot (Docker), viewable from the app.
- Claude's shell commands run in a sandbox that sees only the bot's own folders; one switch per bot turns its internet
  access on or off.

### Apps

- A desktop app for macOS that runs its own server or connects to a remote one.
- A web app served by the server, in English and Turkish.

### Running it

- On your own computer through the desktop app, or on a Linux host with Docker Compose.
- PostgreSQL, or embedded PGlite when no database URL is set.

### Upgrading from an earlier build

- Turns used to store the running cost of their whole Claude session instead of their own, which inflated the usage
  report and the monthly limit. On start the server recalculates the stored cost of earlier Claude turns once; the new
  figures are estimates, since earlier turns did not record where a session began.

### Known limitations

- The desktop installer is built from source; see the README.
- There is no phone app yet; the web app works in a phone's browser.
- Spending figures are estimates reported by the engines, not a bill.
