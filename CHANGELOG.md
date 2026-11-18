# Changelog

All notable changes to Yumak Bot are listed here. Versions follow [Semantic Versioning](https://semver.org/). While the
version is 0.x, a minor release may change the data format or the API; the server migrates its database on start.

## Unreleased

### Connections

- Gmail asks for the read and compose scopes as well, so the bot gets the tools that send, reply, forward and change
  drafts. A Gmail account connected before keeps its old tools until it is signed out and signed in again; with your
  own Google app, add the `gmail.readonly` and `gmail.compose` scopes to its consent screen first.

## 0.4.1 — 2026-11-18

### Safety

- Outside text now counts from the step a run reads it, not only when it started the run: a page, a search, an API's
  answer, a mail, a host a command reached, or (with nobody watching) a ticket or a table marks the run from there on,
  in both engines. The mark goes with the reply, a request to another bot and its answer, a conversation the bot
  opens and the session it resumes. Work nobody asked for (a mail, a webhook, a watched page) asks for every change;
  work that goes back to the person's own message keeps the bot's level and "always allow" rules, the reviewer is told
  outside text was read, and steps that can reach another host (a page, the browser, an API call, a network command,
  inline interpreter code) still ask.
- A connected app's answer is no longer counted as outside text, and an app's own read-only tools run without a card
  in handed-over runs; app tools that take an address still count as reading the web.
- "Always allow" covers only the bot that asked and only as wide as the step: a command and its subcommand, a file's
  folder, a page's site. A command rule no longer covers another command chained after it.
- Permission rules can carry an amount limit on a field: an allow rule covers a call only while the value is readable
  and within the limit, an ask or block rule once it is above or cannot be read.
- Every step that goes through is kept for 90 days with what let it (a card, a rule, the bot's level or the reviewer),
  shown in the bot's panel and downloadable as a spreadsheet. From the last 30 days of answers the panel suggests an
  "always allow" for steps the person always allowed, or the review for a bot whose cards they nearly always allowed.
- A step the person just refused is refused again without a card until they write something new. Answers on a bot's
  question cards count as the person's words for the review.
- Bots the person creates, a manager creates or an import brings start on the auto review instead of asking for
  everything. A manager changing another bot's instructions, section, engine, model or skills asks the person.
- Instructions can be kept in a public document owned elsewhere: it is read once a day or on request, and a change
  reaches the bot only after the person accepts the diff in the bot's panel.
- Memory changes from a run that read outside text are only proposed; shared memory and another bot's notes change
  after a card. Messages forwarded on Telegram or WhatsApp reach the bot as outside data.
- The safety floor also refuses removing a top-level or home folder, deleting from one with find, recursive chmod or
  chown on one, writing over device mapper disks, and such commands inside inline interpreter code.
- Saved passwords and two-step codes go only into a password, username or code field of the saved site over https,
  in a form that posts only to that site; they are hidden from every text a browser step returns and no screenshot is
  taken while one shows. Clicks and keys that send a form ask the person whatever the bot said, and a form submission
  not approved as sending is cancelled.
- Vault secrets and API keys are sealed together with their row and site or origin, so a value moved or redirected in
  the database no longer opens; older values are bound once on first use. The mail relay's secret is sealed too.
- Backups and new password hashes use stronger scrypt settings; older ones still work and passwords are hashed again
  on the next sign-in. A restore checks entry sizes, the unpacked total and the free disk space.
- Sign-in is decided by the route a request matched, so a percent-escaped path no longer skips it. Sign-in tries are
  counted before the password check, per /64 on IPv6, with a daily ceiling across all addresses that slows guesses
  without shutting the owner out; wrong access keys are limited too. A password change signs out every other device.
- Link fetches (skills, plugins, API specs, watched pages) check every address a name resolves to and connect only to
  those, refuse more wrapped and reserved private ranges, and stop reading at the size limit. The bots' browser goes
  through the checking proxy on the person's own computer too, and service workers are blocked in it.
- Commands of a bot with internet go out through a proxy that connects to the address it checked.
- A page in a conversation or a connected app asks before opening a link by itself; on the phone every such link asks.
- The server sends Strict-Transport-Security when reached over HTTPS.

### Server

- The bots' containers can no longer reach services on the host itself, and more reserved and NAT64 ranges are
  blocked on the way out.
- PostgreSQL, Caddy, cloudflared and Tailscale images are pinned to a version and digest, `YUMAKBOT_VERSION` is
  required in the compose file, and the Tailscale container drops every capability and runs on a read-only root.
- The Cloudflare guide shows how to send the proxy header so sign-in limits count each visitor, and the sandbox guide
  explains each relaxed container setting.
- Chat formatting no longer loops for ever (freezing the server) on a reply that contains its own markers.
- katex, esbuild and minimatch were moved past their security advisories.

### Apps

- The desktop app compares the server's whole origin before letting a page navigate, gives the microphone and
  clipboard only to the top frame, and ships with Electron's fuses set.
- The phone app uses plain http only for this device, the local network and Tailscale; an internet server is reached
  over https, and an `http://` internet address is used only after a warning.
- A card asked while a reply is streaming shows below the text written before it, on the desktop and the phone. A card
  waiting in an exchange between bots shows at the end of the conversation.
- Settings → Connection offers to move existing bots to the AI new bots start with. A bot that changes engine drops its
  room sessions too, and its routines' models are cleared.

### Fixes

- A reply the provider cut off is retried once on the same model before the backup model, when nothing was changed
  yet.
- "Retry" no longer refuses almost every failed turn: row times are compared in the database, which also fixes a
  forked conversation missing its chosen message, a skipped message between pages and a repeated search result.
- An answer written together with quick replies is kept instead of being replaced by the closing line, and an error
  whose request was run again is hidden.

### Releases

- The release workflow runs in three jobs, so only the jobs that create the draft and attach the files hold a writing
  token and none of them runs project code. Third-party actions are pinned to a commit. Windows signing is used when a
  certificate is set up.

## 0.4.0 — 2026-11-17

### Safety

- A routine started by outside text (a mail, a webhook's body, a watched page, an app's new answer) asks before every
  change: "always allow" rules do not count, the auto review is skipped, and only reads and talking to the person go
  without a card. Reaching the web asks too, since an address could carry away what the bot read. The card says what
  started the run and offers no "always allow". The same holds for a later turn that reads that text: a resumed
  session, a routine report read in the main chat, or a report carried into the next run. A read-only bot stays
  read-only, and runs the person starts are as before.
- A mail or watched change that arrives while its routine is still running waits and starts once the run ends, instead
  of being dropped; pausing the routine drops what waited.
- Block a tool outright: a block rule refuses the call in every mode, before any other rule, review or card, and tells
  the bot so. A card's "Never allow" adds one; blocks are listed with the other rules under Settings → Permissions.
- Encrypt conversations in the database (Settings → Vault): message text, turn prompts, memory notes, bot-to-bot
  requests, mail and ticket text are stored with AES-256-GCM under a key derived from the vault key, which lives in the
  data folder and never in the database. Turning it on or off converts what is stored in the background; a value that
  cannot be opened is never written over and is counted in the settings. Text search is slower while it is on.

### Board

- A board of tickets the person and the bots work from, with a status, priority, assignee and comments. Assigning a
  ticket to a bot starts it in a conversation of the ticket's own; its reply comes back as a comment and the ticket
  moves to review, where a comment from the person sends it back. Bots list, read, open and update tickets; a ticket a
  bot opens while working on one waits for the person instead of starting its assignee.
- The board fills the window with five columns, cards show the priority, the bot, a line of the description and
  whether the bot is working on it, and a ticket opens beside the columns. Cards are dragged between columns and into
  any place in a column; a move that would start a bot asks first. The board can be searched and filtered.

### Bots

- Bots get mail addresses of their own under a domain set in Settings → Chat apps. The server runs no mail server: a
  relay (Cloudflare Email Routing, a provider's inbound webhook) posts each message with a secret, and attachments go
  to the bot's folder. Mail starts a bot only through routines marked to run on mail, filtered by sender, subject or
  text, and is outside data wherever the bot reads it.
- API keys a bot never sees: a key is saved by name for one address and sealed with the vault key. A bot asks for one
  on a card that shows where it will go and names it in `api_request`; the server adds the key to requests for that
  address alone, does not follow redirects and takes the key out of the response. Keys are listed in the vault.
- An OpenAPI JSON document, added by address or pasted, lets a bot list its operations and call one by its id; the
  request goes only to that API, through the saved key the person picked, and operations that change something ask.
- Teach a bot a task by showing it: start teach mode in the bot's browser, do the task once, and get a skill back to
  look over and save. Typing into password fields is never recorded.
- A bot can keep tables with typed columns; the person reads, corrects and downloads them from the bot's panel.

### Connections

- Install a plugin from its address, in the shared format or as a Claude Code plugin: its remote MCP servers and
  skills are listed, the person picks what goes in, and they install as ordinary connections and switched-off skills.
  Parts that would run the plugin's own code on the server (hooks, local servers) are never installed and are named.
- A routine's webhook takes GitHub events: calls signed with `X-Hub-Signature-256` are checked against the routine's
  secret, the filter reads the event kind as `event`, and GitHub's set-up ping only answers. The routine dialog walks
  through adding the webhook on GitHub.
- Settings → AI services sets three services of the person's own: memory search by meaning through an
  OpenAI-compatible embedding service (such as bge-m3 on Ollama), speech to text through a Whisper server and reading
  aloud through a Kokoro server. Plain http is accepted only on the private network. When left empty, the
  `AI_EMBEDDINGS_*`, `STT_*` and `TTS_*` environment variables apply.

### Memory

- A search finds notes near the query in meaning, with word matches ranked higher; it falls back to words while the
  embedding service is down.
- A note keeps the conversation it was written in and the page the fact came from, with anything that could sign
  someone in taken out of the address.

### Routines

- A routine keeps the instructions it has had; an older one can be compared with the current text and brought back.
- An instruction that names an app the bot cannot use yet says so, with a way to connect it.

### Chat

- Pages a bot builds can be shared by link with someone without an account, served sandboxed as the app frames them;
  links are turned off from the page card or the vault. The page card also opens the page with the print dialog, to
  save it as a PDF.
- Voice notes from Telegram and WhatsApp are written out, so the bot reads what was said.
- Replies read aloud pause at headings, list items and table rows and leave out emoji, addresses and drawn marks; the
  most natural system voice is chosen, and a reply in English is read with an English voice. The reading speed is a
  slider from 0.5x to 2x that a reply being read follows as it moves.

### Apps

- In the desktop app, Cmd/Ctrl+Shift+Space opens a small window listing what the bots wait on, answered from the
  keyboard without switching to the app; it can be turned off from the menu bar.
- Each kind of notice has its own sound, so a question, a permission request and an error can be told apart.
- The folded sidebar keeps the today, board and apps buttons, two to a row, and is wider; a room's faces fit the square
  of a bot's avatar; the sidebar's footer stays tidy at every width.

## 0.3.0 — 2026-11-17

### Safety

- The auto review (the "review" approval level) reads only the person's own words: their latest messages in the
  conversation, the instructions saved on a routine, or, for work another bot handed over, the request it started from.
  A webhook's payload, a routine's last report, another bot's message or a quoted reply no longer counts as what the
  person asked for. To let a step run, the reviewer must quote those words, and the server checks the quote is really
  there; the note in the conversation keeps the quote. Work with no request from the person behind it goes to a card.
- Memory changes a bot asks for while nobody watches (a routine's run, another bot's request) no longer take effect at
  once: they wait under "Waiting for approval" in the memory settings, and the Today page counts them. The person
  accepts or rejects each one, or all at once; a change asked for twice waits once. A bot the person is talking to still
  keeps its memory itself.
- What a connected app or a page in the bot's browser returns reaches the model in an `<outside-data>` block that names
  where it came from and says it is not instructions; a tag in the text that would end the block early is broken up.

### Running it

- Sign a phone or another computer in with a one-time pairing code from a device already signed in (Settings →
  Connection → Connect another device), instead of the password or the access key. A code works once, within five
  minutes; wrong codes are slowed like wrong passwords. The web, the phone and the desktop app's server window take
  it.
- Docker Compose profiles reach the server from elsewhere without opening a port: `--profile cloudflare` runs a
  Cloudflare Tunnel, `--profile tailscale` serves it on your tailnet with HTTPS. The tunnel reaches the server over a
  network of its own with no way out.
- Install on a fresh Ubuntu or Debian server with one command (`docker/install.sh`, from curl or a provider's
  cloud-init box): Docker, the `.env`, AppArmor, the firewall and HTTPS through Caddy (an sslip.io name when there is no
  domain). Running it again, or `yumakbot update`, updates the installation and keeps its secrets and data. The
  firewall rules come back after every reboot and Docker restart, and the server and computer images are published
  for amd64 and arm64 on each version, so a server pulls them instead of building them.

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
- Bots make pictures: with an OpenAI or xAI key saved, `image_create` draws what the bot describes and posts it as a
  file in the chat (Telegram and WhatsApp too). The bot's own provider goes first; only bots with the internet on get
  it, and asking bots open a card first. At most four pictures a turn.
- Bots turn their pages into pictures: `page_to_image` renders a page the bot wrote (a banner, a cover, a social card)
  at the size it asks for and posts the PNG. It costs nothing and runs without a card.
- A file or page a bot hands over while talking to another bot comes to its conversation with the person.
- When a bot's latest reply is in another of its conversations, the chat shows a bar that opens it.

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
- When memory outgrows the prompt, the notes a bot wrote, changed or looked up most recently go in, rather than the
  newest ones. An old note a bot keeps finding by search stays in the prompt, and one nobody needed makes room. A
  search with a query and a site the bot opens count as looking a note up; being in the prompt does not.
- The memory screen lists the notes no bot uses: nobody changed them and no bot looked them up in 30 days, and no bot reads them on
  every turn. They can be deleted one by one or all at once; a note a bot uses again before that stays. Today shows
  how many there are and opens the memory screen from there.

### Routines

- A routine can wait on an app: before each run it calls a read-only tool of a connected app (unread mail, open
  issues) without the AI, and the bot runs only when the answer changed, with the new answer. A quiet tick costs
  nothing. Bots set it up when asked ("tell me when a new invoice email arrives"); the routine screen shows the check
  and removes it. Only a tool that reads, of an app open to the bot, can be a check.
- A routine pre-check on the usage page, on the web, the desktop and the phone: before a run that a watched page, an app's check or a webhook call started, the
  cheapest Claude model says whether the run has anything new to work on (only page noise changed, an event the
  routine does not care about, nothing beyond the last report). "Watch" only records what it said, beside the run and
  as a total on the usage page with what those runs cost; "On" skips such runs with the reason before the bot starts.
  When it is unsure or fails, the run goes ahead, and reminders always run. It is off by default.
- A watched page keeps its last text, so the pre-check reads the sentences that were removed and added instead of the
  whole page.
- A routine's report lands in the bot's main chat under a label that opens the run's steps, and the bot reads the
  reports that came since its last turn there. Routine conversations leave the list unless a card waits in them or
  they are pinned.
- Bots set the model a routine runs with, and the approval card names it.
- The red mark of a failed routine opens that routine at its latest runs, and goes away once the person has seen the
  failure.

### Browser

- A "Just a moment..." page that clears by itself no longer reaches the bot: opening a site waits for it, reloading
  once, before the bot reads the page. When a site still shows a check a person has to answer, or turns the browser
  away, the bot is told so plainly: hand the step to the person with Take control, or use another source. It is
  never to get past a check itself.
- The bots' browsers can go out through the person's own computer (Settings, one switch for the server): sites that
  refuse sign-ins from a datacenter see the home connection while the desktop app is connected, and the server's
  while that computer is off. The desktop app reaches only web ports on public addresses, so the server never reaches
  the person's own machine or home network. The bots' commands still go out from the server.

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
- On the phone, the bots' avatars look around and blink like on the web and the desktop.

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
