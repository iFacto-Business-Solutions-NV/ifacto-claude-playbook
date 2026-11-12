---
name: iFacto.base-app-source
description: 'Look up how the Microsoft Business Central base application actually implements something: the real procedure body, who calls or subscribes to what, the exact signature of an event, what changed between versions, through the bc-code-atlas MCP server (Stefan Maron, hosted, w1-28 by default). Use when: writing an event subscriber, mirroring or extending base-app logic, designing against standard behaviour, documenting what BC does out of the box, answering "what does the base app do before/after X", "who subscribes to OnBefore...", "show me Sales-Post.PostSalesDoc". Covers every access path (Claude Code via the ifacto plugin, which brings the server by default; Claude Code direct server; Claude Code via the bc-observatory plugin; GitHub Copilot) and what to do when no bcatlas_ tool is present. Use from iFacto.ALCoder, iFacto.SolutionDesigner, iFacto.SDD, iFacto.Documentation, iFacto.codebase-reconnaissance and iFacto.impact-analysis.'
---

# Base-Application Source Lookup (via BC Code Atlas)

Claims about what the **Microsoft base application** does are verified in its **real source**,
not reconstructed from memory. Symbols (`al_symbolsearch`, `al_find_references`) tell you that
an object, procedure or event *exists* and how it is declared; they do not show the body, the
base-app callers, or the other subscribers. The atlas does.

> **Availability is not adoption.** Seeing `bcatlas_*` tools in your tool list does not make
> looking optional — it removes every excuse for guessing base-app behaviour.

## What the atlas is — and is not

[bc-code-atlas](https://github.com/StefanMaron/bc-code-atlas) (Stefan Maron, MIT) indexes
Microsoft's own base-application AL source, the public functional docs and the AL developer
reference, in three layers:

| Layer | Tools | Use for |
|-------|-------|---------|
| Semantic search | `bcatlas_search` | finding a starting point when you do not know the exact name |
| Structural graph (real call / subscribe / extend edges) | `bcatlas_resolve_node`, `bcatlas_get_neighbors`, `bcatlas_query_graph`, `bcatlas_shortest_path` | who calls it, who subscribes to it, what extends it, how two concepts connect |
| Exact source text | `bcatlas_get_signature`, `bcatlas_get_procedure_body`, `bcatlas_get_object_source` | confirming the node, reading the real body |
| Versions | `bcatlas_list_warm_versions`, `bcatlas_list_countries`, `bcatlas_list_versions`, `bcatlas_resolve_version`, `bcatlas_diff`, `bcatlas_symbol_history` | other country/version corpora, what changed between versions |

**In scope:** the Microsoft base application (and the public docs). The default corpus is
**`w1-28`** (W1, BC 28) — always warm, no setup.

**Out of scope:** the workspace's own objects, iFacto apps, DistriApps, and third-party
dependencies. Those stay with `ms-dynamics-smb.al/al_symbolsearch`,
`al-mcp-server/al_find_references` and the `iFacto.codebase-reconnaissance` /
`iFacto.impact-analysis` skills. DistriApps behaviour comes from `iFacto.DistriQuestions`.

## Reaching the atlas - four access paths

All paths hit the same hosted server (`https://bc-code-atlas.stefanmaron.dev/mcp`, public,
no authentication). Hosts prefix the tool names differently; the bare `bcatlas_` name is unique.

| Host | How it is connected | Tool name you will see |
|------|---------------------|------------------------|
| Claude Code via the iFacto plugin (default) | the `ifacto` plugin ships `bc-code-atlas` in its `.mcp.json`; every developer with the plugin has it | `mcp__plugin_ifacto_bc-code-atlas__bcatlas_search` |
| Claude Code, direct server (what the iFacto Playbook extension used to install) | `claude mcp add --transport http bc-code-atlas <url>` at user scope | `mcp__bc-code-atlas__bcatlas_search` |
| Claude Code via the community `bc-observatory` plugin | the plugin bundles the atlas next to `bc-observatory` | `mcp__plugin_bc-observatory_bc-code-atlas__bcatlas_search` |
| GitHub Copilot in VS Code | `servers.bc-code-atlas` (type `http`) in the user `mcp.json` | `bcatlas_search` with the host's `mcp_` prefix |

**Use whichever the current session actually exposes**: list your tools, do not assume a
prefix from this table. You normally see **one** set of `bcatlas_` tools even when the server
is configured in several places: Claude Code connects once per endpoint and matches plugin
servers by URL, so a server at the same URL in a higher-precedence scope (local, project,
user) wins over the plugin's copy. A developer who also has the direct server from the
extension therefore gets the `mcp__bc-code-atlas__` names, not the plugin ones. The docs do
not say which plugin wins when two plugins (for example `ifacto` and `bc-observatory`) declare
the same URL; whichever one the session lists is the one to use. Only if you really see two
sets of `bcatlas_` tools: use either, and mention it to the developer.

### Required toolset gate — `bc-code-atlas`

Apply the always-on **Required Toolset Gate** before the first lookup: at least one `bcatlas_`
tool is listed, and the probe `bcatlas_list_warm_versions` answers. ⛔ No `bcatlas_` tool, or
the probe fails → **stop the workflow** that needed the lookup (the design, the code, the
documentation). Report that `bc-code-atlas` is missing or unreachable, what it was needed for,
and what unblocks it (below). Do not answer base-app questions from memory instead, and do not
ask whether to continue with a degraded toolset. As a subagent: end the run with that report.

What unblocks it:

- **The ifacto plugin brings it** (Claude Code, default): check that the plugin is installed
  and enabled (`/plugin`, plugin `ifacto` from marketplace `ifacto-playbook`) and that the
  server `plugin:ifacto:bc-code-atlas` is not toggled off in `/mcp`. Nothing else to install.
- **iFacto Playbook extension** (fallback): `iFacto: Install MCP Servers (Claude Code CLI only)`
  or `iFacto: Install MCP Servers (GitHub Copilot only)`; `bc-code-atlas` is enabled in every
  profile. This is also the route for GitHub Copilot.
- **Claude Code by hand** (fallback):

  ```
  claude mcp add --scope user --transport http bc-code-atlas https://bc-code-atlas.stefanmaron.dev/mcp
  ```

- **GitHub Copilot by hand** — user `mcp.json` (or `.vscode/mcp.json`):

  ```json
  {
      "servers": {
          "bc-code-atlas": { "type": "http", "url": "https://bc-code-atlas.stefanmaron.dev/mcp" }
      }
  }
  ```

## Procedure

1. **Name known → resolve exactly.** `bcatlas_resolve_node(object_type, object_name[, member])`
   — never `bcatlas_get_node` with a free-text label (it is a fuzzy match and can hand you a
   same-named page control instead of the table field you meant).
2. **Confirm cheaply.** `bcatlas_get_signature` on the resolved node — right object, right
   parameters, right `var` modifiers — before pulling anything larger.
3. **Trace the edges.** `bcatlas_get_neighbors` for callers, callees, subscribers and extenders
   (use `relation_filter` to narrow); `bcatlas_shortest_path` when the question is "how does A
   reach B".
4. **Read the body — only as far as the question needs.** `bcatlas_get_procedure_body` for one
   procedure or trigger; `bcatlas_get_object_source` only when the whole object matters.
5. **Name unknown → search first.** `bcatlas_search(query, limit≤5)` by meaning, then continue
   at step 1 with the strongest candidate. Prefer `microsoft-learn-mcp` (or the observatory,
   if present) for *topics and docs*; the atlas search is for *code*.

### Versions and countries

- Every fact you state carries its corpus: **`w1-28`** unless you resolved another one.
- iFacto customers run BE: when behaviour may be localisation-specific, call
  `bcatlas_list_warm_versions` first and query a `be` build only if one is already warm —
  pass its `commit_sha` (never the `version_string`) as `version` together with `country`.
- `bcatlas_diff` and `bcatlas_symbol_history` are always **scoped** to a file, an object or a
  symbol — an unscoped diff is refused upstream and would be useless anyway.
- ⛔ **Never call `bcatlas_request_version` on your own.** It queues a build on the maintainer's
  server. If a question genuinely needs a corpus that is not warm, ask with `AskUserQuestion`
  whether the developer wants to request it and wait for the build (Recommended: answer from
  `w1-28` and flag the version gap). As a subagent you have no channel — report the gap to the
  caller instead of asking or requesting.

### Etiquette — this is one person's free server

- **One question → one or two atlas calls.** Resolve, confirm, read. No sweeps over many
  objects, no loops "to be thorough", nothing scheduled or repeated.
- **Timeout or error after the gate passed:** do not retry in a loop — one retry at most, then
  ⛔ stop with the toolset-gate report (server unreachable, what it was needed for, what
  unblocks it). Symbols and Microsoft Learn do not substitute for the body.
- Quote a body only as far as the answer needs it; summarise the rest.

## Output convention

State base-app facts with the full AL identification plus the corpus, matching the always-on
object-identification rule:

- `Codeunit 80 "Sales-Post"/PostSalesDoc (w1-28)`
- `Codeunit 80 "Sales-Post"/OnBeforePostSalesDoc(...) (w1-28)` — subscribers: `Codeunit 5760 "Whse.-Post Receipt"` ...

A base-app claim is only stated once it was read in the atlas. Workspace or dependency facts
that came from symbols are labelled "from symbols". Never present a remembered implementation
as a read one — and never a workflow output built on an unread one (see the gate above).

## Related

- `iFacto.codebase-reconnaissance` — the workspace side: existing objects, baseline errors, extension points
- `iFacto.impact-analysis` — what breaks in *our* code; this skill adds the base-app side of a hooked procedure or event
- `iFacto.company-guidelines` — the iFacto rules still apply to anything you mirror from the base app
