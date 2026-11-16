# Changelog

All notable changes to Yumak Bot are listed here. Versions follow [Semantic Versioning](https://semver.org/). While the
version is 0.x, a minor release may change the data format or the API; the server migrates its database on start.

## Unreleased

### Running it

- Sign a phone or another computer in with a one-time pairing code from a device already signed in (Settings →
  Connection → Connect another device), instead of the password or the access key. A code works once, within five
  minutes; wrong codes are slowed like wrong passwords. The web, the phone and the desktop app's server window take
  it.
- Docker Compose profiles reach the server from elsewhere without opening a port: `--profile cloudflare` runs a
  Cloudflare Tunnel, `--profile tailscale` serves it on your tailnet with HTTPS. The tunnel reaches the server over a
  network of its own with no way out.

### Connections and models

- Sign in with your ChatGPT plan instead of an OpenAI API key, through OpenAI's "Sign in with ChatGPT", which lets an
  app use a person's plan with its name on the consent page. On the computer that runs the server the sign-in comes
  back by itself; on a server elsewhere you paste the address the browser ended on.
- Sign in with your GitHub Copilot plan with a code typed on GitHub (GitHub Enterprise too); bots get the models your
  plan opens.
- Both are sealed like keys, refreshed when they run out, and signed out from the connection page. A saved API key for
  the same provider comes first.

### Chat

- A microphone button in the message box: speak instead of typing. With an OpenAI or Groq key saved, the recording is
  written out by that provider (on the web and in the desktop app); without one, a browser with its own speech
  recognition (Chrome, Safari) writes as you speak. The desktop app may use the microphone and nothing else of the
  camera or screen; on macOS it asks first. On the phone, the keyboard's own dictation does the same.

### Bots

- Each bot's settings have a Tools section: give it only the tools listed, or leave some out, named as approval cards
  name them (`Read`, `mcp__gmail__search_threads`), with `*` at the end for a whole app. A small local model gets
  room to work, and a bot stays to its job. Both engines leave the other tools out of the request, and one the engine
  offers anyway is refused.

### Chat apps

- Each bot can have a Telegram bot of its own: paste the token BotFather gives in the bot's settings, then open the
  pairing link (or scan its QR code) and press Start. Only the paired Telegram account is read. What it writes goes to
  the bot's main conversation; while the person last wrote from Telegram, replies, files, "typing…" and approval and
  question cards (with buttons) go back there. `/stop` stops the work in progress and `/new` starts afresh. Routine
  reports and cards from the bot's other conversations can come to Telegram too.
- WhatsApp connects as a linked device, the way WhatsApp Web does, from the new "Chat apps" settings section: with a
  separate bot number only the person's own number is read, and with their own number only "Message yourself". The
  messages go to one chosen bot and `/bot <name>` switches it; cards come with numbered choices that a typed number
  answers. Groups and other people's messages are never read. This uses Baileys, an unofficial WhatsApp client, so a
  separate number is recommended.
- Sign-in cards, secret answers and cards with several questions are left to the Yumak Bot app; passwords never go
  through a chat app.

### Memory

- A password, key or token a bot writes to memory is replaced with a marker before the note is saved, and the bot is
  told to ask for the vault instead: memory reaches the model on every turn, so a secret there would leak with it.
- Writing a note that is already saved, give or take case, spacing and closing punctuation, makes no second copy.
- Each note reaches the bot with the day it was last written, so of two notes that disagree it can trust the newer.

### Routines

- A routine can wait on an app: before each run it calls a read-only tool of a connected app (unread mail, open
  issues) without the AI, and the bot runs only when the answer changed, with the new answer. A quiet tick costs
  nothing. Bots set it up when asked ("tell me when a new invoice email arrives"); the routine screen shows the check
  and removes it. Only a tool that reads, of an app open to the bot, can be a check.
- A routine pre-check on the usage page: before a run that a watched page, an app's check or a webhook call started, the
  cheapest Claude model says whether the run has anything new to work on (only page noise changed, an event the
  routine does not care about, nothing beyond the last report). "Watch" only records what it said, beside the run and
  as a total on the usage page with what those runs cost; "On" skips such runs with the reason before the bot starts.
  When it is unsure or fails, the run goes ahead, and reminders always run. It is off by default.
- A watched page keeps its last text, so the pre-check reads the sentences that were removed and added instead of the
  whole page.

### Browser

- A "Just a moment..." page that clears by itself no longer reaches the bot: opening a site waits for it, reloading
  once, before the bot reads the page. When a site still shows a check a person has to answer, or turns the browser
  away, the bot is told so plainly: hand the step to the person with Take control, or use another source. It is
  never to get past a check itself.

### Backups

- A full backup in one file, sealed with a password of your choosing (scrypt and AES-256-GCM): the bots,
  conversations, memory, routines, skills, connections, the bots' folders, and the vault key the saved logins need.
  Download it under Settings → Import and backup, on the web, the desktop or the phone.
- Restoring one, on the web or the desktop, replaces everything on the server with what the file holds, then starts the
  server again. A wrong password, a damaged file or a backup from a newer version changes nothing, and a restore waits
  until no bot is working. The folders it replaced stay beside the new ones as `*.before-restore` until the next
  restore. Who is signed in to the server stays signed in.

### Apps

- The desktop app for Linux: an AppImage that updates itself, and a `.deb` for Debian and Ubuntu, built by the release
  workflow with the others.
- `yumakbot://` links open a bot, a conversation or a room in the desktop app from outside it (a bookmark, a dashboard,
  a script). In the desktop app, "Copy a link to this conversation" copies one, and such a link pasted into a chat
  opens the conversation in place.
- The desktop app itself is called "Yumak Bot": the macOS menu bar and Dock, the Windows exe and shortcuts. macOS takes
  the menu bar title from the app bundle, so the menu's own label did not reach it. The installer and update files
  keep "YumakBot" in their names, and so do the data folder and the keychain entry. An app that updates itself keeps
  its folder name; renaming `YumakBot.app` to `Yumak Bot.app` in Applications fixes the name the Dock shows.

### Memory

- When memory outgrows the prompt, the notes a bot wrote, changed or looked up most recently go in, rather than the
  newest ones. An old note a bot keeps finding by search stays in the prompt, and one nobody needed makes room. A
  search with a query and a site the bot opens count as looking a note up; being in the prompt does not.
- The memory screen lists the notes no bot uses: nobody changed them and no bot looked them up in 30 days, and no bot reads them on
  every turn. They can be deleted one by one or all at once; a note a bot uses again before that stays. Today shows
  how many there are and opens the memory screen from there.

## 0.2.1 — 2026-11-16

### Apps

- The desktop app updates itself from GitHub releases on macOS and Windows: a new version downloads in the background,
  and the app offers to restart into it or installs it when it quits. Apps from 0.2.0 and earlier have no updater, so
  this version is installed by hand once.

### Memory

- A manager bot also sees, corrects and deletes the own notes of bots that are not managers, archived ones included;
  `memory_search` names the bot each note belongs to and takes a bot to list one bot's notes alone. It is told that
  the other bots still see only their own notes, so a fact is not deleted from a bot just because it exists elsewhere.
- The memory screen shows one line per bot with its number of notes; a bot's notes open below it when tapped.

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
