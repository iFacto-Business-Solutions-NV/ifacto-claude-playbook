---
name: iFacto.object-id-assignment
description: 'Reserve object, field, and enum-value IDs with AL Object ID Ninja before creating any AL artifact, and release IDs that end up unused. Use when: creating a new AL object (table, page, codeunit, report, enum, interface, xmlport, query, permissionset, ...), adding table/tableextension fields, adding enum/enumextension values, deleting an object you reserved. Covers every access path — the Ninja MCP server (Claude Code, Cursor, any MCP client) and the VS Code language model tools (Copilot Chat) — including how to install the MCP server when no Ninja tool is present. Use from iFacto.ALCoder and iFacto.SDD.'
---

# AL Object ID Assignment (via AL Object ID Ninja)

Every object, field, and enum-value ID in an iFacto AL project is **reserved from AL Object
ID Ninja before the artifact is written**. Ninja owns the shared ID ranges across every
developer and branch; an ID you pick yourself is not reserved, so a colleague's next
reservation collides with it and the conflict only surfaces at publish time.

Hardcoded, guessed, incremented, counted-from-existing-files, and `idRanges`-derived IDs
are **forbidden**. This is a company rule, not a convenience.

> **Availability is not adoption.** Seeing the tool in your tool list does not make
> reserving optional — it removes every excuse for inventing an ID.

## When to Use

- Before creating any new AL object
- Before adding a field to a table or tableextension
- Before adding a value to an enum or enumextension
- After deleting, renaming away, or reverting an object whose ID you reserved (release it)

Not needed when: editing the body of an object that already exists, or moving code between
existing objects. An existing object **keeps** its ID — an SDD stub that gains real logic in
GREEN is the same object, so it is never re-reserved.

## Reaching Ninja — Three Access Paths

Ninja exposes ID assignment through an **MCP server** (any MCP-compatible client) and
through **VS Code language model tools** (built into the extension). Different hosts see
different tool names, but all paths hit the same Ninja back end, so IDs stay collision-free
no matter which assistant reserved them.

| Host | Path | Reserve | Release |
|------|------|---------|---------|
| GitHub Copilot in VS Code | VS Code language model tools — built into the Ninja extension, no MCP setup | `vjeko.vjeko-al-objid/ninjaNextId` | `vjeko.vjeko-al-objid/ninjaUnassignId` |
| Claude Code via the `ifacto` plugin (default) | the plugin ships the Ninja MCP server (`@vjeko.com/al-object-id-ninja-mcp@1`, `npx`) in its `.mcp.json` | `mcp__plugin_ifacto_al-object-id-ninja__ninja_assignObjectId` | `ninja_unassignObjectId` |
| Claude Code direct server, Cursor, any MCP client | the Ninja MCP server (`@vjeko.com/al-object-id-ninja-mcp`) | `ninja_assignObjectId` — as `mcp__al-object-id-ninja__ninja_assignObjectId` in Claude Code | `ninja_unassignObjectId` |
| Claude Code via the iFacto AL bridge | the bridge proxying the VS Code tools | `mcp__al-mcp-bridge__vjeko-al-objid_getNextObjectId` | `mcp__al-mcp-bridge__vjeko-al-objid_unassignObjectId` |

**Use whichever the current session actually exposes** — list your tools, do not assume a
name from this table. In Copilot Chat the VS Code tools also answer plain requests such as
"get me the next table ID" or "release object ID 50105 for codeunit".

### If no Ninja tool is present (Claude Code / Cursor)

Never work around its absence. Until a Ninja tool is present and answers, the workflow is ⛔
stopped (always-on Required Toolset Gate): no object, field or enum value is written with a
guessed ID; report what unblocks it. In Claude Code the `ifacto` plugin brings the server:
check `/plugin` (`ifacto` enabled) and `/mcp` (`plugin:ifacto:al-object-id-ninja` not toggled
off; failed means Node.js is missing, since it runs with `npx`). Only without the plugin
install it by hand:

Claude Code:

```
claude mcp add --scope user --transport stdio al-object-id-ninja -- npx -y @vjeko.com/al-object-id-ninja-mcp
```

Cursor — add to the MCP configuration:

```json
{
    "mcpServers": {
        "al-object-id-ninja": {
            "command": "npx",
            "args": ["-y", "@vjeko.com/al-object-id-ninja-mcp"]
        }
    }
}
```

In VS Code with the Ninja extension installed, nothing to set up — the language model
tools are already registered.

## How It Works

You pass the **object type** and a **file path inside the AL app**. Ninja then:

1. Detects which AL app that path belongs to
2. Reads the configured ranges from that app's `app.json` and `.objidconfig`
3. Asks the Ninja back end to reserve the next free ID in range
4. Returns the assigned ID

You then write that ID into the code. This is why you never read `idRanges` yourself —
Ninja already did, against the shared reservation state that your local workspace cannot
see.

**Arguments:** object type plus any path within the target app — the absolute path of the
`.al` file you are about to create is the natural choice, and an existing file in the same
app works just as well for app detection. For a field or enum value, name the parent object
wherever the tool's schema accepts it. Read the tool's actual input schema at call time;
never guess parameter names.

## Procedure

### Step 1 — List every artifact that needs an ID

Enumerate before calling anything: objects, new table/tableextension fields, new
enum/enumextension values. In a multi-project workspace (App + Test), list them per project
— each app has its own ranges, so an ID must be reserved against the project that will own
the object.

### Step 2 — Reserve one ID per artifact

Call the reserve tool **once per artifact**, passing the object type and a path inside the
owning app. Never reuse one returned ID for a second object, and never increment a returned
ID to "get the next one" — the second ID was never reserved.

For a field or enum value, the ID must come from the **parent object's** range, not the
extension object's range.

### Step 3 — Write the artifact with the returned ID

Use the returned ID verbatim, in both places:

- the object declaration — `table 50143 "IFA Sales Discount Group"`
- the file name — `<ObjectType> <ID> <Name>.al`

The file name is finalized *after* the reservation returns — the path you passed in Step 2
only had to identify the app, so passing the intended target path costs nothing and reads
best. No placeholder IDs, no `50000`-style fillers "to be fixed later" — a filler that
survives one build survives to production.

### Step 4 — Release IDs that end up unused

If a reserved ID is never used — object dropped from the design, deleted, renamed away, the
change reverted, an SDD stub or test double removed — call the release tool for it. An
unreleased ID stays consumed for everyone.

### Step 5 — Report

```
Object ID Reservation
  ✅ Table   "IFA Sales Discount Group"          → 50143  (App)
  ✅ field   "Discount Group Code" (Table 18)    → 50143  (App, parent range)
  ✅ Codeunit "IFA Sales Discount Meth"          → 50144  (App)
  ✅ Codeunit "IFA Sales Discount Tests"         → 80100  (Test)
  ♻️ Released: 50145 (stub dropped)
```

## Hard Stop — No Fallback

> ⛔ If no Ninja tool is available — MCP server not installed, extension missing, no back
> end configured, the bridge not running — or the call errors, **STOP and report it.** Do
> NOT fall back to `app.json` `idRanges`, to the highest existing ID in the project, or to
> "a safe-looking number". Give the user the install command above (or ask them to supply
> the IDs explicitly) and wait.

Reporting a blocked reservation costs one message. An invented ID costs a publish-time
collision in someone else's branch.

## Important

- **Never** hardcode or guess an object ID, in code or in a design document. Design docs
  refer to planned objects by type + name with the ID left as `<Ninja>`; a guessed ID in a
  design becomes a guessed ID in the code.
- **Never** treat a compiling build as proof the ID was free — the collision is with a
  *reservation*, not with the local workspace.
- Reserve before writing, not after. Retro-fitting an ID means renaming the file, the
  declaration, and every reference.

## Related

- `iFacto.company-guidelines` — the iFacto company AL rules this skill enforces one of
  (naming, one object per file, `PTE`/affix conventions that shape the file name you create)
- `iFacto.ALCoder`, `iFacto.SDD` — the agents that own Step 2.5 "Assign Object IDs", which
  is this procedure
- `iFacto.SolutionDesigner` — writes design documents with `<Ninja>` ID placeholders only
