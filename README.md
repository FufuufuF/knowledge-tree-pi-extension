# byte-mentor-pi-extension

Byte Mentor is a [Pi](https://github.com/earendil-works/pi) extension that gives a
coding/learning agent **cross-session learning memory**. It records how a user
actually performs while learning, distills that into a traceable long-term state,
and lets a Planner change future teaching accordingly.

The design is fixed by three documents in this repo:

- [`memory-requirements.md`](./memory-requirements.md) — the long-term memory domain model.
- [`pi-mvp-design.md`](./pi-mvp-design.md) — the MVP runtime architecture and reliability boundaries.
- [`DEVELOPMENT.md`](./DEVELOPMENT.md) — Pi extension development guide (events, loader, context).

## Architecture (MVP)

Three runtime roles plus two deterministic service boundaries:

| Component            | Runs as                     | May write                        |
| -------------------- | --------------------------- | -------------------------------- |
| **Planner Agent**    | isolated in-memory session  | nothing (read-only catalog)      |
| **Actor Agent**      | the user's main Pi session  | only a `learning_checkpoint` job |
| **Memory Agent**     | isolated in-memory session  | only via controlled submit tools |
| **Memory Committer** | deterministic TypeScript    | SQLite formal memory (sole writer) |
| **Note Patch Applier** | deterministic TypeScript  | user Markdown notes (sole writer) |

The cross-session loop this MVP validates:

```text
first lesson exposes a misconception
  -> Memory Agent extracts Evidence and commits state
  -> a review note is generated from what was actually taught
  -> next session, the Planner hits that state
  -> the Actor avoids re-teaching and runs a targeted re-test
```

## Storage

User-level, no vector DB. Node's built-in `node:sqlite` (Node >= 22.5, requires
`--experimental-sqlite` before Node 24) backs the store:

```text
~/.pi/agent/byte-mentor/
├── memory.sqlite
└── notes/
```

## Layout

```text
src/
├── index.ts              # extension factory (registration only)
├── pi/                   # Pi glue: commands, hooks, actor tools, runtime factory
├── agents/               # Planner + Memory agents and their prompts
├── domain/               # types + deterministic committer / reducer / checkpoint service
├── storage/              # sqlite + catalog / checkpoint / note stores
├── notes/                # markdown patch applier
└── resources/skills/     # Byte Mentor skill published to the Actor
```

## Install (dev)

Symlink into Pi's auto-discovery directory, then use `/reload`:

```bash
mkdir -p ~/.pi/agent/extensions/byte-mentor
ln -sf "$(pwd)/src/index.ts" ~/.pi/agent/extensions/byte-mentor/index.ts
# ...symlink the rest of src/ alongside, or point at this checkout directly.
```

Quick one-off test (no auto-discovery, no `/reload`):

```bash
pi -e ./src/index.ts
```

## Commands

| Command          | Effect                                                              |
| ---------------- | ------------------------------------------------------------------ |
| `/learn <goal>`  | create a lesson run, invoke the Planner, start Actor teaching mode  |
| `/learn stop`    | end the lesson run and drain all pending checkpoint / note jobs     |
| `/learn status`  | show the active plan, pending checkpoints, and dirty note count     |
