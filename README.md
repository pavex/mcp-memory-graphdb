# Persistent Graph Memory for Claude & LLM Agents

**A persistent graph-database memory server for Claude and other LLM agents, built on the [Model Context Protocol (MCP)](https://modelcontextprotocol.io) and powered by [DuckDB](https://duckdb.org).**

Unlike flat key-value memory stores, mcp-memory-graphdb lets an AI agent remember people, projects, concepts and the *relationships* between them — as a real graph, stored locally in a single file, with a schema you control and can evolve safely over time.

If you're looking for a Claude memory MCP server, a persistent memory backend for LLM agents, or a lightweight embedded graph database for AI tooling, this project is built exactly for that.

---

## Table of contents

- [Why a graph, not just key-value memory](#why-a-graph-not-just-key-value-memory)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
  - [Option A — one-click install via .mcpb](#option-a--one-click-install-via-mcpb)
  - [Option B — manual install (claude_desktop_config.json)](#option-b--manual-install-claude_desktop_configjson)
  - [Choosing the database file](#choosing-the-database-file)
- [How it works](#how-it-works)
- [The tools](#the-tools)
- [Working with the schema](#working-with-the-schema)
  - [The default schema](#the-default-schema)
  - [Adding a new node or edge type](#adding-a-new-node-or-edge-type)
  - [Renaming a type](#renaming-a-type)
  - [Removing a type](#removing-a-type)
  - [Instructing an agent to manage the schema](#instructing-an-agent-to-manage-the-schema)
- [Dreaming — guided cleanup](#dreaming--guided-cleanup)
- [Project structure](#project-structure)
- [Development](#development)
  - [Running tests](#running-tests)
  - [Building](#building)
  - [Packaging as a .mcpb extension](#packaging-as-a-mcpb-extension)
- [Roadmap](#roadmap)
- [License](#license)

---

## Why a graph, not just key-value memory

Most memory servers for LLM agents store isolated facts: a note, a string, a timestamp. That's fine until the agent needs to answer something like *"what projects is Pavel working on that use DuckDB?"* — a question that's really about **relationships**, not isolated facts.

mcp-memory-graphdb stores two things: **nodes** (a person, a project, a concept, anything with a type and properties) and **edges** (a directed, typed relationship between two nodes — `works_on`, `uses`, `knows`, `part_of`, whatever your schema defines). The agent can then walk the graph with ordinary SQL — joins, filters, recursive traversals — instead of trying to reconstruct relationships from disconnected text snippets.

It runs on [DuckDB](https://duckdb.org), an embedded, file-based analytical database. No server process, no Docker container, no network port — just one `.duckdb` file on disk that the MCP server opens directly.

## Features

- **Persistent across sessions** — memory survives restarts, new conversations, even reinstalling the client. It's just a file.
- **Real relationships, not just facts** — typed, directed edges between typed nodes, queryable with full SQL.
- **User-defined schema** — you decide what kinds of things and relationships exist in your memory. Ships with a sensible default, fully customizable.
- **Safe schema evolution** — adding new types is always safe. Renaming and removing types go through an explicit, validated migration process — never silent, never guessed.
- **Zero external dependencies at runtime** — DuckDB is embedded; the whole server is one bundled JS file plus native bindings.
- **One-click installable** — packaged as a `.mcpb` Desktop Extension for Claude Desktop.
- **MCP-native** — exposes its tools and an onboarding `setup` prompt through the standard Model Context Protocol, so any MCP-compatible client can use it.

## Requirements

- [Node.js](https://nodejs.org) 18 or later
- Windows or macOS (Linux works too if you build the native DuckDB bindings yourself — see [Compatibility](#compatibility) below)
- An MCP-compatible client: [Claude Desktop](https://claude.ai/download), [Claude Code](https://docs.claude.com/en/docs/claude-code), or any other MCP host

## Installation

### Option A — one-click install via .mcpb

The easiest path. A `.mcpb` file is a [Desktop Extension](https://www.anthropic.com/engineering/desktop-extensions) — a self-contained package that Claude Desktop can install with a double-click, no manual JSON editing required.

1. Build the package yourself (there's no prebuilt release yet — see [Packaging as a .mcpb extension](#packaging-as-a-mcpb-extension)), or grab `mcpb/mcp-memory-graphdb.mcpb` if someone already built it for you.
2. Double-click the `.mcpb` file. Claude Desktop will open an install prompt.
3. Optionally set a custom database name in the install dialog (see [Choosing the database file](#choosing-the-database-file)).
4. Confirm. The server is now available in every new conversation.

### Option B — manual install (claude_desktop_config.json)

If you'd rather wire it in by hand, or you're using a different MCP client:

1. Clone this repository and build it:

   ```bash
   git clone https://github.com/pavex/mcp-memory-graphdb.git
   cd mcp-memory-graphdb
   build.cmd   # Windows
   ./build.sh  # macOS / Linux
   ```

   This installs dependencies, bundles the server into `dist/`, copies the native DuckDB bindings next to it, runs the full test suite, and cleans up `node_modules` afterwards. `dist/` is fully self-contained once it's done.

2. Add the server to your client's MCP config. For Claude Desktop, that's `claude_desktop_config.json`:

   ```json
   {
     "mcpServers": {
       "memory-graphdb": {
         "command": "node",
         "args": [
           "/absolute/path/to/mcp-memory-graphdb/dist/mcp.js",
           "/absolute/path/to/your/memory.duckdb"
         ]
       }
     }
   }
   ```

3. Restart your client.

### Choosing the database file

The server takes one optional argument: where to put the `.duckdb` file.

| Argument | Result |
|---|---|
| *(none)* | `.var/memory.duckdb` inside the project folder |
| `work` | `.var/work.duckdb` inside the project folder — a named, separate memory |
| `/absolute/path/to/file.duckdb` | exactly that path, anywhere on disk |

A path containing `/` or `\` is always treated as a direct file location; anything else is treated as a short name and stored under `.var/` next to the server. This lets you run multiple independent memories — e.g. one per project, or one personal and one work-related — just by pointing each MCP server entry at a different name or path.

The schema file (`schema.yaml`, see below) always lives in the same directory as the database file.

## How it works

On first startup against a fresh database, the server:

1. Creates the `nodes` and `edges` tables in the DuckDB file.
2. Writes a default `schema.yaml` next to the database (this is schema **revision 0** — see [The default schema](#the-default-schema)).
3. Exposes a `setup` MCP prompt that walks the agent through reviewing and optionally customizing that schema with the user.

From then on, every conversation that connects to this server can read and write nodes and edges through the tools below, and the schema can be safely extended at any time through `apply_schema`. As the graph grows, `dreaming` provides a guided way to walk through it in batches and clean up duplicates or fill in missing relationships.

## The tools

| Tool | Purpose |
|---|---|
| `add_node` | Create a node — give it a `type`, optional `labels`, and a free-form `properties` object. |
| `update_node` | Merge new properties and/or replace labels on an existing node. |
| `delete_node` | Delete a node. Any edges touching it are deleted automatically. |
| `get_node` | Fetch a single node by ID. |
| `add_edge` | Create a directed, typed edge between two existing nodes. |
| `delete_edge` | Delete a single edge by ID. |
| `list_edges` | List edges, optionally filtered by `source_id`, `target_id` and/or `type`. |
| `search` | Case-insensitive text search across node properties, optionally filtered by `type`. |
| `get_schema` | Return the current schema as YAML, including its revision number. |
| `apply_schema` | Apply additions, renames or removals to the schema (see below). |
| `dreaming` | Get a paginated batch of nodes with their immediate edges, for guided cleanup — merging duplicates and adding missing relationships (see below). |

There is deliberately **no raw query tool**. Letting an agent run arbitrary SQL against the memory store is a bigger attack surface than the convenience is worth; the tools above cover the realistic range of what an agent needs to read and write memory safely.

## Working with the schema

The schema defines what *kinds* of nodes and edges are allowed to exist — their names and descriptions, and for nodes, their expected properties. It's stored as a YAML file next to the database, and it's versioned: every change increments a `revision` number.

### The default schema

A fresh database starts with [`schema.default.yaml`](./schema.default.yaml) — revision 0. It covers a reasonably general-purpose starting point: `project`, `topic`, `technology`, `concept`, `person`, `article`, `note` as node types, and `uses`, `belongs_to`, `part_of`, `created_by`, `works_on`, `knows`, `relates_to`, `covers` as edge types. It's meant to be customized, not used as-is forever — the `setup` prompt exists specifically to walk through that customization on first run.

### Adding a new node or edge type

This is always safe and never requires anything special. Call `apply_schema` with just the new type — existing types don't need to be repeated:

```yaml
nodes:
  event:
    description: "A dated occurrence or milestone"
    properties:
      name: string
      date: string
```

The `nodes:` and `edges:` sections in what you send to `apply_schema` are always treated as a **patch**, not a full replacement. Anything you don't mention is left exactly as it was.

### Renaming a type

Renaming touches real data, so it has to be explicit. Add a `migrations` entry:

```yaml
migrations:
  - rename_node: { from: technology, to: tool }
```

This relabels every existing node of that type in the database first, then updates the schema. No data is lost. You can combine this with a redefinition of the new name in the same call if its description or properties should change too.

The same pattern works for edges with `rename_edge`.

### Removing a type

Removal is rejected if any node or edge of that type still exists in the database — there is no implicit data deletion:

```yaml
migrations:
  - remove_node: { type: note }
```

If `note` still has nodes, rename them elsewhere first (or delete them individually), then remove the now-empty type.

### Instructing an agent to manage the schema

If you're prompting an agent (Claude or otherwise) to manage this schema on your behalf, the short version is:

> Call `get_schema` first to see the exact current state. To add a type, just include it under `nodes:` or `edges:` with a description — you don't need to repeat what already exists. To rename or remove a type, add an explicit `migrations` entry; this is the *only* way to change or delete an existing type, and omitting a type from the YAML never does it silently.

The `apply_schema` tool's own description carries this same guidance, and the built-in `setup` MCP prompt walks through it interactively — so in most cases you can simply ask the agent to *"review the memory schema"* or *"add a new type to memory for X"* and let it take it from there.

## Dreaming — guided cleanup

Over time, any memory accumulates small problems: a node added twice under slightly different IDs, two relationships that should exist but were never written down. The `dreaming` tool exists to walk through the graph and fix exactly that — not automatically, but with an agent doing the reviewing.

Calling `dreaming` returns a batch of up to 10 nodes, ordered so that nodes of the same type sit next to each other (which makes duplicates easy to spot side by side), along with a capped 1-hop view of each node's edges — what it connects to, and what connects to it. If a node has more edges than the cap, the response says how many more exist (`out_more` / `in_more`) without flooding the batch with all of them. The response also carries `total`, `has_more` and `next_offset`, so an agent can walk the entire graph one batch at a time by feeding `next_offset` back in.

The tool itself makes no decisions and changes nothing — it only surfaces data and a set of instructions. All actual changes happen through the ordinary tools: redirecting a duplicate node's edges with `add_edge` and `delete_edge`, then removing it with `delete_node`; or adding a relationship that was missing with `add_edge`. If a duplicate spans an entire node *type* — say a schema revision introduced `tool` as a better name for what used to be `technology` — that's a job for `apply_schema`'s migration support instead (see [Renaming a type](#renaming-a-type)), not for `dreaming` directly.

A typical pass looks like:

> Use the `dreaming` tool to review the memory. Compare nodes batch by batch, merge anything that's clearly a duplicate, add any relationship that's obviously missing, and tell me what you changed. Continue with the next batch until there's nothing left.

In practice this has already caught real duplicate edges in this project's own memory — two identical `uses` relationships between the same two nodes, created a few sessions apart — found and cleaned up by an agent in a single `dreaming` pass.

## Project structure

```
mcp-memory-graphdb/
├── schema.default.yaml        # revision 0 — the schema a fresh database starts with
├── manifest.json               # .mcpb / Desktop Extension manifest
├── build.mjs / build.cmd / build.sh    # bundle + copy native DuckDB bindings + test
├── mcpb.cmd / mcpb.sh           # package dist/ into a .mcpb file
├── src/
│   ├── mcp.js                  # server entry point — tool & prompt registration
│   ├── Config.js                # database path resolution from argv
│   ├── Datastore/
│   │   ├── InstallerDatastore.js   # creates the nodes/edges tables
│   │   └── GraphDatastore.js       # all node/edge CRUD + search + schema-migration primitives
│   ├── Schema/
│   │   ├── DefaultSchema.js        # loads schema.default.yaml
│   │   ├── SchemaManager.js        # the deterministic apply() process
│   │   └── SchemaValidator.js      # strict structural validation (Zod)
│   ├── Tools/                   # one file per tool group (incl. DreamingTool.js)
│   ├── Prompts/
│   │   └── OnboardingPrompt.js      # the "setup" MCP prompt
│   └── Utils/
│       └── Schemas.js            # Zod input schemas for every tool
└── test/
    ├── unit.js                  # datastore + schema manager unit tests
    └── integration.js           # full stdio JSON-RPC round-trip, src and dist
```

## Development

### Running tests

```bash
npm test
```

This runs `test/unit.js` (in-memory DuckDB, no real files touched) followed by `test/integration.js` against both `src/` and `dist/` — spawning the actual server process and talking JSON-RPC over stdio, exactly as a real MCP client would.

### Building

```bash
node build.mjs
```

Bundles `src/mcp.js` with esbuild, copies the platform-specific native DuckDB bindings (`duckdb.node` plus the platform shared library) into `dist/`, and copies `schema.default.yaml` alongside. `build.cmd` / `build.sh` wrap this with a full install → build → test → cleanup cycle, ending in an audible beep so you don't have to watch the terminal.

### Packaging as a .mcpb extension

```bash
node build.mjs --mcpb
```

or simply run `mcpb.cmd` / `mcpb.sh`, which do the full install → build → package → cleanup cycle in one go. The result is `mcpb/mcp-memory-graphdb.mcpb`, ready to double-click into Claude Desktop.

## Roadmap

This is **Phase 2** of the project — graph CRUD, a fully deterministic and validated schema system, and a guided dreaming/cleanup workflow. Open for the future:

- Full-text search via DuckDB's FTS extension (current `search` uses a simple `ILIKE`).
- Optional property-level validation against the schema on write.
- A dedicated `merge_nodes` tool, if redirecting edges manually during dreaming proves too tedious in practice.

## Compatibility

Native DuckDB bindings are platform-specific. This project has been built and tested on **Windows (x64)**. macOS should work out of the box once built there (DuckDB ships official bindings for `darwin-x64` and `darwin-arm64`); Linux requires the matching `@duckdb/node-bindings-linux-*` package to be available for your architecture at build time.

## License

MIT
