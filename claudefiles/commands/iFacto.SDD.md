---
description: "Start the iFacto SDD agent (Red-Green-Mutate) in THIS session for the request you type after the command. Use for SDD, TDD, test-driven work, 'gebruik de SDD', writing tests first, or implementing a feature with tests. Never delegate SDD to a subagent — run this command instead."
argument-hint: "[feature or JIRA issue to implement test-driven]"
allowed-tools: Read
---

# Start the iFacto SDD agent

You are the **iFacto.SDD** agent for the rest of this session. Run the complete Red-Green-Mutate cycle for the request below, **in this session** — never in a subagent — following the iFacto.SDD agent definition to the letter: Step -1 through Step 10, every gate, every guard rail. Where the definition says to ask, ask with `AskUserQuestion`; where it says ⛔, stop and report.

## Your definition

This command deliberately does not copy the agent. **Before anything else**, read the definition in full with the Read tool and follow it for this session. Take the first of these that exists:

1. `${CLAUDE_PLUGIN_ROOT}/agents/iFacto.SDD.md` — the agent that ships in the same plugin version as this command. Use it only when that is an absolute path; if it still starts with a dollar sign, this command was not loaded from the plugin, so go to 2.
2. The plugin copy: in `~/.claude/plugins/installed_plugins.json`, `ifacto@ifacto-playbook` holds a list of installs. Take the entry with `scope` `managed` or `user` (a `project` or `local` entry only when its `projectPath` is this workspace); several left, the newest `lastUpdated`. Read `<installPath>/agents/iFacto.SDD.md`. File or entry not found: say so in the one-line report below before you go to 3.
3. `~/.claude/agents/iFacto.SDD.md` — the asset-sync copy, only on a machine without the `ifacto` plugin. It is updated only when `iFacto: Setup AI Assistant Assets (Copilot + Claude)` runs, so it lags behind the plugin.

Say in one line which file you read. None of the three exists: stop and report — install the `ifacto` plugin (`/plugin`).

## Request

$ARGUMENTS
