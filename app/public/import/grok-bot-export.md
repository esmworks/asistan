---
name: move-to-yumakbot
description: Packs the user's Grok Bot agents (instructions, picture, timed tasks, remembered facts, team chats) into a single yumakbot-bots.json file for the YumakBot app. Use when the user wants their agents in YumakBot.
---

# Move agents to YumakBot

The result of this task is one JSON file named `yumakbot-bots.json`. The user loads it in YumakBot
(**Settings → Import**), where it is previewed before anything is created. YumakBot checks the file
strictly; a file that does not match the shape below is rejected as a whole.

## What the file looks like

```json
{
  "format": "yumakbot-bot-import",
  "version": 1,
  "source": "grok-bot",
  "exportedAt": "2026-11-13T09:00:00Z",
  "bots": [
    {
      "ref": "trip-planner",
      "name": "Trip Planner",
      "description": "Plans trips and keeps bookings in order",
      "instructions": "You plan the user's trips. Prefer trains over flights under 600 km. …",
      "avatar": null,
      "routines": [
        {
          "name": "Sunday travel check",
          "prompt": "List the bookings for the coming week and flag missing tickets.",
          "schedule": { "type": "weekly", "days": [0], "time": "18:00" },
          "timezone": "Europe/Berlin",
          "enabled": true
        }
      ],
      "memories": ["The user has a rail pass valid until March 2027."]
    },
    {
      "ref": "bookkeeper",
      "name": "Bookkeeper",
      "description": "Tracks invoices and expenses",
      "instructions": "You keep the user's books. …",
      "avatar": null,
      "routines": [],
      "memories": []
    }
  ],
  "groups": [{ "name": "Household", "members": ["trip-planner", "bookkeeper"] }],
  "notImported": [
    { "bot": "bookkeeper", "what": "Task: file receipts from email", "reason": "starts on an email" }
  ]
}
```

### `bots` (1 to 50)

- `ref`: your own id for the agent, used only inside this file. Lowercase letters and digits,
  words joined by single hyphens, up to 64 characters. No two agents share one.
- `name`: up to 60 characters.
- `description`: what the agent is for, in one line of up to 500 characters.
- `instructions`: its system prompt, up to 20,000 characters. When it is longer, condense it,
  keeping every rule, and list what you cut under `notImported`.
- `avatar`: `null`, or the agent's picture as a base64 data URL of type `image/png`,
  `image/jpeg` or `image/webp`, no larger than 290 KB. SVG is not accepted.
- `routines`: up to 32 timed tasks (see below).
- `memories`: up to 50 facts (see below).

### `routines`

Each has a `name` (up to 80 characters), the `prompt` it runs (up to 20,000 characters), a
`schedule`, an IANA `timezone` (such as `Asia/Tokyo`) and `enabled`, which says whether the task
is currently switched on in Grok Bot. YumakBot imports every routine switched off so nothing runs
twice; the user turns them on.

`schedule` must be exactly one of the following. `HH:MM` is a 24-hour clock time in the routine's
own time zone; weekdays are numbered with Sunday as 0 and Saturday as 6.

```json
{ "type": "hourly", "minute": 0 }
{ "type": "daily", "time": "HH:MM" }
{ "type": "weekdays", "time": "HH:MM" }
{ "type": "weekly", "days": [1, 4], "time": "HH:MM" }
{ "type": "monthly", "day": 15, "time": "HH:MM" }
{ "type": "interval", "minutes": 90 }
```

`hourly` runs once an hour at the given minute; `weekdays` means Monday to Friday; `interval`
takes 5 to 10,080 minutes. Cron expressions are not accepted.

Some tasks will not fit: a schedule none of these shapes expresses exactly, or a task that is
triggered by something other than the clock (a webhook, an incoming email, a message). Never
approximate such a task with a nearby schedule. Leave it out of `routines` and describe it in
`notImported`, naming what triggers it. A task with two or more separate schedules becomes one
routine per schedule, each with the same prompt and a distinguishing name.

### `memories`

Plain sentences, one fact each, up to 2,000 characters: who the user is, how they like things
done, people and projects they mention, standing decisions and unfinished work. Derive them from
the agent's conversations, but summarise; never paste conversation text.

### `groups` (up to 50)

Team chats in which several agents work together: a `name` (up to 60 characters) and the `ref` of
each member. In YumakBot an agent belongs to at most one group.

### `notImported` (up to 200)

Everything the user had that the file cannot carry, such as skills, files, connected accounts or
event-triggered tasks: `bot` (the agent's `ref`, or `null`), `what` (up to 200 characters) and
`reason`.

## How to do it

1. Gather the user's agents and team chats and show them as a list. Ask which to include (all, or
   a selection) and wait for the reply. Skip any agent whose only job is to run this export.
2. For each chosen agent, collect the fields above and write its memories.
3. Keep credentials out of the file. API keys, passwords, tokens, cookies and signed URLs never
   go in, not even inside instructions or prompts; put a note such as `[needs the user's API key]`
   in their place.
4. Write `yumakbot-bots.json`, then check it:
   - it parses as JSON, with `format` `yumakbot-bot-import` and `version` `1`;
   - every `ref` is unique, and every group member is one of them;
   - every schedule is one of the six shapes, none of them guessed;
   - no credentials appear anywhere;
   - everything left behind is listed in `notImported`.
5. Tell the user where the file is, how many agents and groups it contains and what is in
   `notImported`, and that they can now load it under **Settings → Import** in YumakBot.
