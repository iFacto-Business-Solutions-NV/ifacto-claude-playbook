#!/usr/bin/env node
// export-chat.mjs — export one Claude Code session to readable markdown.
//
// Part of the iFacto.chatexport skill. Zero dependencies, Node 18+.
//
// Reads  ~/.claude/projects/<cwd-slug>/<session-id>.jsonl
//        plus the sidecars Claude Code writes next to it:
//          <session-id>/tool-results/<tool_use_id>.txt   (spilled large outputs)
//          <session-id>/subagents/agent-<id>.jsonl|.meta.json
//
// Writes up to three files into the system Downloads folder, plus a zip of them:
//   <date>-<slug>-full.md          everything: reasoning, tool IO, sub-agents
//   <date>-<slug>-conversation.md  the dialogue only — the reading version
//   <date>-<slug>-diagnose.md      compact workflow analysis — the agent's entry point
//
// Usage:  node export-chat.mjs [session|latest|@N] [options]
//         node export-chat.mjs --list --limit 15
//
// Secrets are always redacted. --sanitize additionally redacts e-mail addresses.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

/* ==================================================================== */
/* CLI                                                                   */
/* ==================================================================== */

const BOOL_FLAGS = new Set(['list', 'json', 'all-projects', 'stdout', 'quiet', 'sanitize', 'help', 'zip', 'no-zip']);
const VALUE_OPTS = new Set([
    'limit', 'project', 'slug', 'title', 'out', 'mode', 'thinking',
    'subagents', 'max-input', 'max-result', 'redactions', 'zip-dir',
]);

export function parseArgs(argv) {
    const cfg = {
        list: false, json: false, allProjects: false, stdout: false, quiet: false,
        sanitize: false, help: false,
        limit: 20, project: process.cwd(), slug: null, title: null,
        out: null, mode: 'all', thinking: 'details', subagents: 'report',
        maxInput: 6000, maxResult: 4000, redactions: null,
        zip: true, zipDir: null,
        target: null,
    };
    const positional = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) { positional.push(arg); continue; }

        const [rawName, inlineValue] = arg.slice(2).split(/=(.*)/s);
        const name = rawName;

        if (BOOL_FLAGS.has(name)) {
            if (name === 'no-zip') { cfg.zip = false; }
            else { cfg[name === 'all-projects' ? 'allProjects' : name] = true; }
            continue;
        }
        if (VALUE_OPTS.has(name)) {
            const value = inlineValue !== undefined ? inlineValue : argv[++i];
            switch (name) {
                case 'zip-dir': cfg.zipDir = value; break;
                case 'limit': cfg.limit = Number(value) || 20; break;
                case 'max-input': cfg.maxInput = Number(value) || 6000; break;
                case 'max-result': cfg.maxResult = Number(value) || 4000; break;
                default: cfg[name] = value;
            }
            continue;
        }
        process.stderr.write(`Unknown option: --${name}\n`);
        process.exit(64);
    }

    cfg.target = positional[0] || 'latest';
    return cfg;
}

const HELP = `
export-chat.mjs — export a Claude Code session to markdown (iFacto.chatexport)

  node export-chat.mjs [session|latest|@N] [options]

Session selector
  latest              the most recently modified session (default)
  @N                  the Nth most recent session (1-based)
  <id> | <prefix>     an explicit session id, or a unique prefix of one

Options
  --list              list sessions instead of exporting
  --limit <n>         how many to list (default 20)
  --json              machine-readable output for --list
  --project <path>    export sessions of another workspace (default: cwd)
  --all-projects      search every project directory
  --out <dir>         output directory (default: the system Downloads folder)
  --mode <m>          all | full | conversation | diagnose   (default all)
  --thinking <m>      details | inline | none                (default details)
  --subagents <m>     report | full | none                   (default report)
  --max-input <n>     truncate tool inputs  (default 6000 characters)
  --max-result <n>    truncate tool results (default 4000 characters)
  --sanitize          also redact e-mail addresses (secrets are always redacted)
  --redactions <f>    extra redaction patterns (JSON)
  --slug <s>          override the filename slug
  --title <s>         override the session title
  --zip               also bundle everything into one zip (default on)
  --no-zip            do not write the zip
  --zip-dir <dir>     write the zip somewhere other than --out
  --stdout            print markdown instead of writing files
  --quiet             suppress progress logging
  --help              show this help
`;

/* ==================================================================== */
/* Session discovery                                                     */
/* ==================================================================== */

export const DEFAULT_PROJECTS_ROOT = join(homedir(), '.claude', 'projects');

/** Claude Code's own project-dir scheme: every non-alphanumeric becomes '-'. */
export const slugifyPath = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

export function projectDirFor(cwdPath, projectsRoot = DEFAULT_PROJECTS_ROOT) {
    const abs = resolve(cwdPath);
    const candidates = [slugifyPath(abs), slugifyPath(abs.replace(/\/$/, ''))];
    for (const candidate of candidates) {
        const dir = join(projectsRoot, candidate);
        if (existsSync(dir)) { return dir; }
    }
    return null;
}

export function listSessionFiles(dir) {
    if (!existsSync(dir)) { return []; }
    return readdirSync(dir)
        .filter((n) => n.endsWith('.jsonl'))
        .map((name) => {
            const path = join(dir, name);
            const st = statSync(path);
            return { id: name.replace(/\.jsonl$/, ''), path, dir, mtime: st.mtimeMs, size: st.size };
        })
        .sort((a, b) => b.mtime - a.mtime);
}

const readLines = (path) =>
    readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);

/** Cheap scan for --list: title, timing and turn count without full parsing. */
export function peek(file) {
    const entries = readLines(file.path);
    let customTitle = null, aiTitle = null, firstPrompt = null;
    let start = null, end = null, cwd = null, branch = null, turns = 0;

    for (const e of entries) {
        if (e.type === 'custom-title') { customTitle = e.title || e.customTitle || customTitle; }
        if (e.type === 'ai-title') { aiTitle = e.aiTitle || e.title || aiTitle; }
        if (e.timestamp) { start ??= e.timestamp; end = e.timestamp; }
        cwd ??= e.cwd || null;
        branch ??= e.gitBranch || null;
        if (isHumanTurn(e)) {
            turns++;
            firstPrompt ??= humanText(e).slice(0, 200);
        }
    }
    const title = customTitle || aiTitle || (firstPrompt ? firstPrompt.slice(0, 60) : '(untitled)');
    return { ...file, title, customTitle, aiTitle, firstPrompt, start, end, cwd, branch, turns };
}

/* ==================================================================== */
/* Entry classification                                                  */
/* ==================================================================== */

const INJECTED_WRAPPERS = [
    'system-reminder', 'local-command-caveat', 'ide_opened_file',
    'ide_diagnostics', 'task-notification', 'ide_selection',
];

const INJECTED_PREFIXES = [
    '<task-notification>', '<system-reminder>',
    'Caveat: The messages below were generated by the user while running local commands',
    '<local-command-stdout>', '<bash-input>', '<bash-stdout>',
];

const INTERRUPT_RE = /^\[Request interrupted by user/i;

/** Records that carry no analysable signal — ~40% of a transcript's bytes. */
const NOISE_ATTACHMENTS = new Set([
    'total_tokens_reminder',
    'queued_command',
    'prompt_snapshot',
]);

export function isNoiseRecord(entry) {
    if (!entry) { return true; }
    if (entry.type === 'queue-operation') { return true; }
    if (entry.type === 'atis-latch') { return true; }
    if (entry.type === 'attachment') { return NOISE_ATTACHMENTS.has(entry.attachment?.type); }
    return false;
}

export function stripReminders(text) {
    let out = String(text ?? '');
    for (const tag of INJECTED_WRAPPERS) {
        out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '');
    }
    return out;
}

const contentBlocks = (entry) => {
    const content = entry?.message?.content;
    if (Array.isArray(content)) { return content; }
    if (typeof content === 'string') { return [{ type: 'text', text: content }]; }
    return [];
};

const rawUserText = (entry) =>
    contentBlocks(entry)
        .filter((b) => b.type === 'text')
        .map((b) => b.text || '')
        .join('\n');

export function isHumanTurn(entry) {
    if (entry?.type !== 'user' || entry.isSidechain) { return false; }
    if (entry.isMeta) { return false; }

    const blocks = contentBlocks(entry);
    if (!blocks.length) { return false; }
    if (blocks.every((b) => b.type === 'tool_result')) { return false; }

    const text = rawUserText(entry).trim();
    if (!text) { return false; }
    if (INTERRUPT_RE.test(text)) { return false; }

    const stripped = stripReminders(text).trim();
    if (!stripped) { return false; }
    if (INJECTED_PREFIXES.some((p) => stripped.startsWith(p))) { return false; }
    return true;
}

/** Human prompt text, with slash-command wrappers unwrapped. */
export function humanText(entry) {
    const raw = rawUserText(entry);
    const pick = (tag) => raw.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() || '';

    const command = pick('command-name');
    if (command) {
        const args = pick('command-args');
        const stdout = pick('local-command-stdout');
        const rest = stripReminders(raw.replace(/<command-[\s\S]*?<\/command-[a-z]+>/g, '')).trim();
        return [`/${command}${args ? ` ${args}` : ''}`, stdout && `↳ ${stdout}`, rest].filter(Boolean).join('\n');
    }
    return stripReminders(raw).trim();
}

/** 'mcp__<server>__<tool>' → '<server>'; null for built-in tools. */
export function mcpServerOf(toolName) {
    const match = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(String(toolName ?? ''));
    return match ? match[1] : null;
}

/* ==================================================================== */
/* Parsing                                                               */
/* ==================================================================== */

function resultText(block, structured) {
    const content = block?.content;
    if (typeof content === 'string') { return content; }
    if (Array.isArray(content)) {
        return content
            .map((c) => {
                if (c.type === 'text') { return c.text; }
                if (c.type === 'image') { return '[image]'; }
                return JSON.stringify(c);
            })
            .join('\n');
    }
    if (structured?.stdout || structured?.stderr) {
        return [structured.stdout, structured.stderr].filter(Boolean).join('\n');
    }
    if (structured) { return JSON.stringify(structured, null, 2); }
    return '';
}

const SKILL_INJECTION_RE = /Base directory for this skill:.*[/\\]skills[/\\]([^\s/\\]+)/;

export function parseSession(file) {
    const entries = readLines(file.path);

    const meta = {
        sessionId: file.id,
        path: file.path,
        dir: file.dir,
        title: null, aiTitle: null, customTitle: null,
        cwd: null, branch: null,
        versions: new Set(), models: new Set(),
        start: null, end: null,
    };

    // Capability evidence for the diagnose report.
    const capabilityRaw = { skillListings: [], mcpInstructions: [], skillInjections: new Set(), modes: [] };

    /* ---- pass 1: metadata, tool results, capability attachments -------- */
    const results = new Map();

    for (const e of entries) {
        if (e.type === 'custom-title') { meta.customTitle = e.title || e.customTitle || meta.customTitle; }
        if (e.type === 'ai-title') { meta.aiTitle = e.aiTitle || e.title || meta.aiTitle; }
        if (e.timestamp) { meta.start ??= e.timestamp; meta.end = e.timestamp; }
        meta.cwd ??= e.cwd || null;
        meta.branch ??= e.gitBranch || null;
        if (e.version) { meta.versions.add(e.version); }
        if (e.message?.model) { meta.models.add(e.message.model); }

        if (e.type === 'attachment' && !isNoiseRecord(e)) {
            const att = e.attachment || {};
            if (att.type === 'skill_listing') { capabilityRaw.skillListings.push(att); }
            if (att.type === 'mcp_instructions' || att.type === 'mcp_instructions_delta') {
                capabilityRaw.mcpInstructions.push(att);
            }
            if (att.type === 'model' && att.content) { meta.models.add(String(att.content).trim()); }
            if (att.type === 'plan_mode' || att.type === 'plan_mode_exit' || att.type === 'auto_mode') {
                capabilityRaw.modes.push({ type: att.type, ts: e.timestamp });
            }
        }

        if (e.type === 'user' && e.isMeta) {
            const skill = SKILL_INJECTION_RE.exec(rawUserText(e))?.[1];
            if (skill) { capabilityRaw.skillInjections.add(skill); }
        }

        for (const block of contentBlocks(e)) {
            if (block.type === 'tool_result' && block.tool_use_id) {
                results.set(block.tool_use_id, {
                    text: resultText(block, e.toolUseResult),
                    isError: !!block.is_error,
                    structured: e.toolUseResult ?? null,
                });
            }
        }
    }

    // Overlay tool results that Claude Code spilled to disk — they are complete
    // where the inline copy is truncated.
    const toolResultsDir = join(file.dir, file.id, 'tool-results');
    if (existsSync(toolResultsDir)) {
        for (const name of readdirSync(toolResultsDir)) {
            if (!name.endsWith('.txt')) { continue; }
            const id = name.replace(/\.txt$/, '');
            const body = readFileSync(join(toolResultsDir, name), 'utf8');
            const existing = results.get(id);
            if (!existing) {
                results.set(id, { text: body, isError: false, structured: null });
            } else if (body.length > (existing.text || '').length) {
                existing.text = body;
            }
        }
    }

    meta.title = meta.customTitle || meta.aiTitle || null;

    /* ---- pass 2: turns ------------------------------------------------- */
    const turns = [];
    const pre = [];
    let current = null;
    const bucket = () => (current ? current.items : pre);
    const byMessageId = new Map();

    for (const e of entries) {
        if (isNoiseRecord(e) || e.isSidechain) { continue; }

        if (isHumanTurn(e)) {
            current = { prompt: humanText(e), ts: e.timestamp, items: [] };
            turns.push(current);
            byMessageId.clear();
            continue;
        }

        if (e.type === 'user' && !e.isMeta && INTERRUPT_RE.test(rawUserText(e).trim())) {
            bucket().push({ kind: 'interrupt', ts: e.timestamp });
            continue;
        }

        if (e.type === 'user' && e.isMeta) {
            const skill = SKILL_INJECTION_RE.exec(rawUserText(e))?.[1];
            if (skill) { bucket().push({ kind: 'note', text: `🧩 Skill loaded: \`${skill}\``, ts: e.timestamp }); }
            continue;
        }

        if (e.type === 'attachment') {
            const att = e.attachment || {};
            if (att.type === 'hook_success') {
                bucket().push({
                    kind: 'hook',
                    label: att.hookName || att.hookEvent || 'hook',
                    text: att.stdout || att.content || '',
                    ts: e.timestamp,
                });
            } else if (att.type === 'plan_mode_exit') {
                bucket().push({ kind: 'note', text: '📋 Plan approved — left plan mode', ts: e.timestamp });
            } else if (att.type === 'edited_text_file') {
                bucket().push({ kind: 'note', text: '✏️ File edited outside the agent', ts: e.timestamp });
            }
            continue;
        }

        if (e.type === 'assistant') {
            const id = e.message?.id || e.uuid;
            let item = byMessageId.get(id);
            if (!item) {
                item = { kind: 'assistant', msgId: id, ts: e.timestamp, thinking: [], texts: [], tools: [], usage: null };
                byMessageId.set(id, item);
                bucket().push(item);
            }
            item.usage = e.message?.usage || item.usage;
            for (const block of contentBlocks(e)) {
                if (block.type === 'thinking' && block.thinking) { item.thinking.push(block.thinking); }
                else if (block.type === 'text' && block.text) { item.texts.push(block.text); }
                else if (block.type === 'tool_use') {
                    item.tools.push({ id: block.id, name: block.name, input: block.input || {}, ts: e.timestamp });
                }
            }
        }
    }

    // Attach results to their calls.
    for (const turn of [{ items: pre }, ...turns]) {
        for (const item of turn.items) {
            for (const tool of item.tools || []) { tool.result = results.get(tool.id) || null; }
        }
    }

    return { meta, turns, pre, capabilityRaw };
}

/* ==================================================================== */
/* Sub-agents                                                            */
/* ==================================================================== */

export function loadSubagents(session) {
    const dir = join(session.meta.dir, session.meta.sessionId, 'subagents');
    if (!existsSync(dir)) { return []; }

    const out = [];
    for (const name of readdirSync(dir).sort()) {
        if (!name.endsWith('.jsonl')) { continue; }
        const id = name.replace(/\.jsonl$/, '');
        const metaPath = join(dir, `${id}.meta.json`);
        let sidecar = {};
        if (existsSync(metaPath)) {
            try { sidecar = JSON.parse(readFileSync(metaPath, 'utf8')); } catch { /* ignore */ }
        }

        const entries = readLines(join(dir, name));
        const texts = [];
        const skills = new Set();
        let prompt = '';
        let handback = null;
        let toolCalls = 0, thinkingBlocks = 0, start = null, end = null;

        for (const e of entries) {
            if (e.timestamp) { start ??= e.timestamp; end = e.timestamp; }
            if (e.type === 'user' && !prompt) { prompt = rawUserText(e).trim(); }
            if (e.type === 'assistant') {
                for (const block of contentBlocks(e)) {
                    if (block.type === 'text' && block.text) { texts.push(block.text); }
                    if (block.type === 'tool_use') {
                        toolCalls++;
                        // Since Claude Code 2.1.31x a sub-agent delivers its final report through
                        // the SubagentHandback tool, not as a text block: that call IS the report.
                        if (block.name === 'SubagentHandback') { handback = String(block.input?.message ?? ''); }
                        if (block.name === 'Skill' && block.input?.skill) { skills.add(String(block.input.skill)); }
                    }
                    if (block.type === 'thinking') { thinkingBlocks++; }
                }
            }
        }

        out.push({
            id,
            agentType: sidecar.agentType || 'unknown',
            description: sidecar.description || '',
            toolUseId: sidecar.toolUseId || null,
            spawnDepth: sidecar.spawnDepth ?? null,
            prompt,
            texts,
            report: handback || texts.at(-1) || '',
            skills: [...skills],
            toolCalls,
            thinkingBlocks,
            start,
            end,
        });
    }
    return out;
}

/* ==================================================================== */
/* Capability inventory — what was available vs. what was used           */
/* ==================================================================== */

const allTools = (session) =>
    [{ items: session.pre }, ...session.turns].flatMap((t) => t.items.flatMap((i) => i.tools || []));

/**
 * Attachment list fields arrive either as a real array or as a JSON-encoded
 * string, depending on the Claude Code version that wrote the transcript.
 */
export function asList(value) {
    if (Array.isArray(value)) { return value.filter((v) => typeof v === 'string'); }
    if (typeof value === 'string' && value.trim().startsWith('[')) {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
        } catch { return []; }
    }
    return [];
}

/**
 * Server names out of an mcp_instructions attachment, whatever shape it uses.
 *
 * `addedNames` is authoritative when present. The heading fallback is only for
 * older transcripts that carry just the rendered instruction blocks — and it
 * takes only the FIRST heading of each block, because the instruction text
 * itself contains headings like "## Workflow" that are not server names.
 */
export function mcpNamesFrom(att) {
    const names = new Set(asList(att.addedNames));

    if (!names.size) {
        const blocks = [att.content, ...asList(att.addedBlocks)].filter(Boolean);
        for (const block of blocks) {
            const first = /^##\s+(.+?)\s*$/m.exec(String(block));
            if (first) { names.add(first[1]); }
        }
    }

    for (const removed of asList(att.removedNames)) { names.delete(removed); }
    return names;
}

/** Split skill names into iFacto's own (the ones we can fix) and the rest. */
/** iFacto's own skills (`iFacto.x`, `iFacto-x`, `ifacto:x`) plus BCQuality's: the agents are told to invoke them, so they must be visible by name. */
const isOurSkill = (name) => /^(ifacto[.:-]|bcquality)/i.test(name);

/** Split skill names into ours (listed one by one in the diagnose) and others (collapsed). */
export function partitionSkills(names) {
    const all = [...names].sort((a, b) => a.localeCompare(b));
    return {
        ours: all.filter(isOurSkill),
        others: all.filter((n) => !isOurSkill(n)),
    };
}

/**
 * @param subagents  loadSubagents() output — a skill invoked inside a sub-agent counts as
 *                   used, and skillsUsedBy says in which agent type(s). Without this the
 *                   diagnose report lists the reviewer's own skills as "never invoked".
 */
export function collectCapabilities(session, subagents = []) {
    const skillsOffered = new Set();
    for (const listing of session.capabilityRaw.skillListings) {
        for (const name of asList(listing.names)) { skillsOffered.add(name); }
    }

    const mcpConnected = new Set();
    for (const att of session.capabilityRaw.mcpInstructions) {
        for (const name of mcpNamesFrom(att)) { mcpConnected.add(name); }
    }

    const skillsUsed = new Set(session.capabilityRaw.skillInjections);
    const mcpUsed = new Map();
    const toolFrequency = new Map();

    for (const tool of allTools(session)) {
        toolFrequency.set(tool.name, (toolFrequency.get(tool.name) || 0) + 1);
        if (tool.name === 'Skill' && tool.input?.skill) { skillsUsed.add(tool.input.skill); }
        const server = mcpServerOf(tool.name);
        if (server) {
            mcpUsed.set(server, (mcpUsed.get(server) || 0) + 1);
            mcpConnected.add(server);
        }
    }

    const skillsUsedBy = new Map();
    for (const sub of subagents) {
        for (const skill of sub.skills || []) {
            skillsUsed.add(skill);
            const by = skillsUsedBy.get(skill) || new Set();
            by.add(sub.agentType);
            skillsUsedBy.set(skill, by);
        }
    }

    const skillsUnused = new Set([...skillsOffered].filter((s) => !skillsUsed.has(s)));
    const mcpUnused = new Set([...mcpConnected].filter((s) => !mcpUsed.has(s)));

    return { skillsOffered, skillsUsed, skillsUsedBy, skillsUnused, mcpConnected, mcpUsed, mcpUnused, toolFrequency };
}

/* ==================================================================== */
/* Analysis                                                              */
/* ==================================================================== */

const ms = (a, b) => (a && b ? new Date(b) - new Date(a) : 0);

export function analyze(session, subagents = []) {
    const tools = allTools(session);

    const toolFrequency = new Map();
    for (const tool of tools) { toolFrequency.set(tool.name, (toolFrequency.get(tool.name) || 0) + 1); }

    let errorCount = 0;
    const errors = [];
    for (const tool of tools) {
        if (tool.result?.isError) {
            errorCount++;
            errors.push({ name: tool.name, headline: toolHeadline(tool), text: (tool.result.text || '').slice(0, 300) });
        }
    }

    // Retry loops: the same bash command issued more than once.
    const commandCounts = new Map();
    for (const tool of tools) {
        if (tool.name !== 'Bash') { continue; }
        const command = String(tool.input?.command ?? '').trim();
        if (!command) { continue; }
        commandCounts.set(command, (commandCounts.get(command) || 0) + 1);
    }
    const repeatedCommands = [...commandCounts.entries()]
        .filter(([, count]) => count > 1)
        .map(([command, count]) => ({ command, count }))
        .sort((a, b) => b.count - a.count);

    let interruptions = 0;
    for (const turn of [{ items: session.pre }, ...session.turns]) {
        for (const item of turn.items) { if (item.kind === 'interrupt') { interruptions++; } }
    }
    for (const tool of tools) {
        if (/Request interrupted by user/i.test(tool.result?.text || '')) { interruptions++; }
    }

    let outputTokens = 0, ctxTokens = 0, cacheRead = 0;
    let thinkingBlocks = 0, thinkingWithText = 0, assistantMessages = 0;
    const seen = new Set();
    for (const turn of [{ items: session.pre }, ...session.turns]) {
        for (const item of turn.items) {
            if (item.kind !== 'assistant') { continue; }
            assistantMessages++;
            thinkingBlocks += item.thinking.length;
            thinkingWithText += item.thinking.filter((t) => String(t).trim()).length;
            if (item.msgId && seen.has(item.msgId)) { continue; }
            if (item.msgId) { seen.add(item.msgId); }
            const usage = item.usage || {};
            outputTokens += usage.output_tokens || 0;
            cacheRead += usage.cache_read_input_tokens || 0;
            ctxTokens += (usage.input_tokens || 0)
                + (usage.cache_read_input_tokens || 0)
                + (usage.cache_creation_input_tokens || 0);
        }
    }

    const turnStats = session.turns.map((turn, index) => {
        const items = turn.items;
        const turnTools = items.flatMap((i) => i.tools || []);
        const last = turnTools.at(-1)?.ts || items.at(-1)?.ts || turn.ts;
        const previous = session.turns[index - 1];
        const previousEnd = previous
            ? (previous.items.flatMap((i) => i.tools || []).at(-1)?.ts || previous.items.at(-1)?.ts || previous.ts)
            : null;
        const labels = new Map();
        for (const tool of turnTools) { labels.set(tool.name, (labels.get(tool.name) || 0) + 1); }

        return {
            index: index + 1,
            ts: turn.ts,
            gap: previousEnd ? ms(previousEnd, turn.ts) : 0,
            duration: ms(turn.ts, last),
            messages: items.filter((i) => i.kind === 'assistant').length,
            toolCalls: turnTools.length,
            toolLabel: [...labels.entries()].map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join(', '),
            skills: turnTools.filter((t) => t.name === 'Skill').map((t) => t.input?.skill).filter(Boolean),
            agents: turnTools.filter((t) => t.name === 'Agent' || t.name === 'Task').length,
            asks: turnTools.filter((t) => t.name === 'AskUserQuestion').length,
            errors: turnTools.filter((t) => t.result?.isError).length,
            interrupted: items.some((i) => i.kind === 'interrupt'),
        };
    });

    return {
        toolFrequency, errorCount, errors, repeatedCommands, interruptions,
        outputTokens, ctxTokens, cacheRead,
        thinkingBlocks, thinkingWithText, assistantMessages,
        toolCalls: tools.length,
        subagentCount: subagents.length,
        askRounds: tools.filter((t) => t.name === 'AskUserQuestion').length,
        turnStats,
        duration: ms(session.meta.start, session.meta.end),
    };
}

/* ==================================================================== */
/* Redaction                                                             */
/* ==================================================================== */

const SECRET_REDACTIONS = [
    { regex: 'Bearer\\s+[A-Za-z0-9._~+/=-]{20,}', flags: 'g', replace: 'Bearer «token»' },
    { regex: '(Authorization:\\s*Basic\\s+)[A-Za-z0-9+/=]{8,}', flags: 'gi', replace: '$1«redacted»' },
    {
        regex: '\\b(gh[pousr]_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}'
            + '|eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,})\\b',
        flags: 'g', replace: '«token»',
    },
    {
        regex: '((?:password|pwd|passwd|secret|api[_-]?key|access[_-]?key|client[_-]?secret)'
            + '["\']?\\s*[=:]\\s*)["\']?[^\\s"\',;)]{4,}',
        flags: 'gi', replace: '$1«redacted»',
    },
    { regex: '(Server|Data Source)=[^;\\s]+;\\s*(Database|Initial Catalog)=[^;\\s]+;', flags: 'gi', replace: '$1=«server»;$2=«db»;' },
    { regex: '(https?://)[^\\s/@]+:[^\\s/@]+@', flags: 'gi', replace: '$1«user»:«password»@' },
    { regex: '\\b(sig|sv|se|st)=[A-Za-z0-9%2F+=-]{20,}', flags: 'gi', replace: '$1=«sas»' },
];

const PII_REDACTIONS = [
    { regex: '\\b[\\w.+-]+@[\\w.-]+\\.[a-z]{2,}\\b', flags: 'gi', replace: 'user@example.com' },
];

export function buildSanitizer(pii = false, redactionsFile = null) {
    const patterns = [...SECRET_REDACTIONS];
    let literals = [];

    if (redactionsFile && existsSync(redactionsFile)) {
        try {
            const extra = JSON.parse(readFileSync(redactionsFile, 'utf8'));
            patterns.push(...(extra.patterns || []));
            literals = extra.replacements || [];
        } catch { /* ignore an unreadable redactions file */ }
    }
    if (pii) { patterns.push(...PII_REDACTIONS); }

    const compiled = patterns.map((p) => ({ re: new RegExp(p.regex, p.flags || 'g'), replace: p.replace ?? '«redacted»' }));

    return function sanitize(text) {
        let out = String(text ?? '');
        for (const { find, replace } of literals) { out = out.split(find).join(replace); }
        for (const { re, replace } of compiled) { out = out.replace(re, replace); }
        return out;
    };
}

/* ==================================================================== */
/* Formatting helpers                                                    */
/* ==================================================================== */

const TZ = 'Europe/Brussels';
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
});

export const fmtTime = (iso) => (iso ? timeFmt.format(new Date(iso)) : '—');
export const fmtDateTime = (iso) => (iso ? dateTimeFmt.format(new Date(iso)) : '—');
export const fmtDay = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '0000-00-00');
export const fmtNum = (n) => new Intl.NumberFormat('en-GB').format(n || 0);

export function fmtDuration(milliseconds) {
    if (!milliseconds || milliseconds < 0) { return '—'; }
    const minutes = Math.round(milliseconds / 60000);
    if (minutes < 60) { return `${minutes} min`; }
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** A code fence that can never be broken by backticks inside the content. */
export function fence(text, lang = '') {
    const body = String(text ?? '').replace(/\r/g, '');
    const longest = (body.match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
    const ticks = '`'.repeat(Math.max(3, longest + 1));
    return `${ticks}${lang}\n${body}\n${ticks}`;
}

/** Markdown table cell: neutralise pipes and newlines. */
export const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function truncate(text, max, label = 'characters') {
    const body = String(text ?? '');
    if (body.length <= max) { return body; }
    return `${body.slice(0, max)}\n… [truncated — ${fmtNum(body.length)} ${label} total]`;
}

export function slugify(text) {
    return String(text ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 70)
        .replace(/-+$/g, '');
}

const HEADLINE_FIELDS = ['command', 'file_path', 'filePath', 'pattern', 'path', 'skill', 'url', 'query', 'description', 'prompt', 'subagent_type'];

export function toolHeadline(tool) {
    for (const field of HEADLINE_FIELDS) {
        const value = tool.input?.[field];
        if (typeof value === 'string' && value.trim()) { return value.trim().split('\n')[0].slice(0, 120); }
    }
    const json = JSON.stringify(tool.input || {});
    return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

/* ==================================================================== */
/* Rendering                                                             */
/* ==================================================================== */

const PROVENANCE = '> Generated by the `iFacto.chatexport` skill. Internal material for '
    + 'development-workflow analysis — never share with a customer.';

function renderToolInput(tool, cfg, S) {
    const input = {};
    for (const [key, value] of Object.entries(tool.input || {})) {
        input[key] = typeof value === 'string' ? truncate(value, cfg.maxInput) : value;
    }
    return fence(S(JSON.stringify(input, null, 2)), 'json');
}

function renderAskUserQuestion(tool, S) {
    const questions = tool.input?.questions || [];
    const answers = tool.result?.structured?.answers || {};
    const lines = ['> ❓ **Decision point — the agent asked the developer**', '>'];

    for (const q of questions) {
        const chosen = answers[q.question];
        lines.push(`> **${S(q.question)}**`, '>');
        for (const option of q.options || []) {
            const picked = chosen && option.label === chosen;
            lines.push(`> - ${picked ? `**✅ ${S(option.label)}**` : S(option.label)}`);
        }
        if (chosen) { lines.push('>', `> 🗣️ **Developer chose:** ${S(chosen)}`); }
        lines.push('>');
    }
    return lines.join('\n');
}

function renderTool(tool, cfg, S) {
    if (tool.name === 'AskUserQuestion') { return renderAskUserQuestion(tool, S); }

    const parts = [
        `<details><summary>🔧 <code>${tool.name}</code> — ${S(toolHeadline(tool))}</summary>`,
        '',
        '**Input:**',
        '',
        renderToolInput(tool, cfg, S),
        '',
    ];

    if (!tool.result) {
        parts.push('*(no result in the transcript — aborted or asynchronous)*');
    } else {
        parts.push(tool.result.isError ? '**Result (❌ error):**' : '**Result:**', '');
        parts.push(fence(S(truncate(tool.result.text, cfg.maxResult))));
    }
    parts.push('', '</details>');
    return parts.join('\n');
}

function renderItem(item, cfg, S, subagents) {
    if (item.kind === 'interrupt') { return '> ⛔ **Interrupted by the developer**'; }
    if (item.kind === 'note') { return `> ${S(item.text)}`; }
    if (item.kind === 'hook') {
        return [`> 🪝 **Hook \`${S(item.label)}\`**`, '', fence(S(truncate(item.text, 1000)))].join('\n');
    }

    const out = [`### 🤖 Claude — ${fmtTime(item.ts)}`, ''];

    if (cfg.thinking !== 'none') {
        for (const thought of item.thinking) {
            const first = String(thought).trim().split('\n')[0].slice(0, 90);
            if (cfg.thinking === 'inline') {
                out.push(`> 🧠 ${S(thought).replace(/\n/g, '\n> ')}`, '');
            } else {
                out.push(
                    `<details><summary>🧠 <b>Reasoning</b> — ${S(first)}</summary>`, '',
                    S(thought), '', '</details>', '',
                );
            }
        }
    }

    for (const text of item.texts) { out.push(S(text), ''); }

    for (const tool of item.tools) {
        out.push(renderTool(tool, cfg, S), '');
        const sub = subagents.find((s) => s.toolUseId === tool.id);
        if (sub) { out.push(`> 🧭 Sub-agent \`${sub.agentType}\` — see appendix A`, ''); }
    }
    return out.join('\n');
}

export function renderFull(ctx, cfg = {}) {
    const config = { maxInput: 6000, maxResult: 4000, thinking: 'details', subagents: 'report', ...cfg };
    const { session, subagents, stats, caps, S } = ctx;
    const { meta } = session;
    const title = meta.title || session.turns[0]?.prompt?.slice(0, 60) || '(untitled)';

    const out = [
        `# Chat export — ${S(title)}`,
        '',
        PROVENANCE,
        '',
        '| | |',
        '|---|---|',
        `| Session | \`${meta.sessionId}\` |`,
        `| Start | ${fmtDateTime(meta.start)} |`,
        `| End | ${fmtDateTime(meta.end)} |`,
        `| Duration | ${fmtDuration(stats.duration)} |`,
        `| Workspace | \`${S(meta.cwd || '—')}\` (branch \`${S(meta.branch || '—')}\`) |`,
        `| Model(s) | ${[...meta.models].join(', ') || '—'} |`,
        `| Claude Code | ${[...meta.versions].join(', ') || '—'} |`,
        `| Turns | ${stats.turnStats.length} |`,
        `| Assistant messages | ${stats.assistantMessages} |`,
        `| Tool calls | ${stats.toolCalls} |`,
        `| Sub-agents | ${stats.subagentCount} |`,
        `| Interruptions | ${stats.interruptions} |`,
        `| Output tokens | ${fmtNum(stats.outputTokens)} |`,
        '',
    ];

    if (stats.thinkingBlocks > 0 && stats.thinkingWithText === 0) {
        out.push(
            '> ⚠️ This session stored only encrypted thinking signatures, so the reasoning is',
            '> not in the transcript. That is a property of the session, not an export failure.',
            '',
        );
    }

    out.push('## Turn overview', '', '| # | Time | Wait | Duration | Msg | Tools | Skills | Sub-agents | Errors | ⛔ |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const t of stats.turnStats) {
        out.push(`| [${t.index}](#turn-${t.index}) | ${fmtTime(t.ts)} | ${fmtDuration(t.gap)} | ${fmtDuration(t.duration)} | ${t.messages} | ${cell(t.toolLabel) || '—'} | ${cell(t.skills.join(', ')) || '—'} | ${t.agents || '—'} | ${t.errors || '—'} | ${t.interrupted ? '⛔' : ''} |`);
    }
    out.push('');

    out.push('## Tool usage', '', '| Tool | Calls |', '|---|---|');
    for (const [name, count] of [...stats.toolFrequency.entries()].sort((a, b) => b[1] - a[1])) {
        out.push(`| \`${cell(name)}\` | ${count} |`);
    }
    out.push('');

    if (session.pre.length) {
        out.push('## Before the first prompt', '');
        for (const item of session.pre) { out.push(renderItem(item, config, S, subagents), ''); }
    }

    for (const [index, turn] of session.turns.entries()) {
        out.push(
            `<a id="turn-${index + 1}"></a>`, '',
            `## 👤 Turn ${index + 1} — ${fmtTime(turn.ts)}`, '',
            fence(S(turn.prompt)), '',
        );
        for (const item of turn.items) { out.push(renderItem(item, config, S, subagents), ''); }
    }

    if (subagents.length && config.subagents !== 'none') {
        out.push('## Appendix A — sub-agent investigations', '');
        for (const sub of subagents) {
            out.push(
                `### \`${sub.agentType}\` — ${S(sub.description) || sub.id}`, '',
                `*${fmtTime(sub.start)} → ${fmtTime(sub.end)} · ${sub.toolCalls} tool calls · depth ${sub.spawnDepth ?? '—'}*`, '',
                '**Assignment:**', '', fence(S(truncate(sub.prompt, 20000))), '',
                '**Report:**', '',
            );
            if (config.subagents === 'full') {
                for (const text of sub.texts) { out.push(S(truncate(text, 60000)), ''); }
            } else {
                out.push(S(truncate(sub.report, 60000)), '');
            }
        }
    }

    return out.join('\n');
}

export function renderConversation(ctx) {
    const { session, stats, S } = ctx;
    const { meta } = session;
    const title = meta.title || session.turns[0]?.prompt?.slice(0, 60) || '(untitled)';

    const out = [
        `# Conversation — ${S(title)}`,
        '',
        PROVENANCE,
        '',
        `*${fmtDateTime(meta.start)} · ${stats.turnStats.length} turns · ${fmtDuration(stats.duration)} · \`${S(meta.cwd || '—')}\`*`,
        '',
    ];

    for (const [index, turn] of session.turns.entries()) {
        out.push(`## 👤 Turn ${index + 1} — ${fmtTime(turn.ts)}`, '', fence(S(turn.prompt)), '');
        for (const item of turn.items) {
            if (item.kind === 'interrupt') { out.push('> ⛔ **Interrupted by the developer**', ''); continue; }
            if (item.kind === 'note') { out.push(`> ${S(item.text)}`, ''); continue; }
            if (item.kind !== 'assistant') { continue; }

            for (const text of item.texts) { out.push(S(text), ''); }
            for (const tool of item.tools) {
                if (tool.name === 'AskUserQuestion') { out.push(renderAskUserQuestion(tool, S), ''); }
            }
            if (item.tools.length) {
                const labels = new Map();
                for (const tool of item.tools) { labels.set(tool.name, (labels.get(tool.name) || 0) + 1); }
                const summary = [...labels.entries()].map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join(', ');
                out.push(`> ⚙️ *${item.tools.length} tool call(s): ${cell(summary)}*`, '');
            }
        }
    }
    return out.join('\n');
}

export function renderDiagnose(ctx) {
    const { session, stats, caps, subagents, S } = ctx;
    const { meta } = session;
    const title = meta.title || session.turns[0]?.prompt?.slice(0, 60) || '(untitled)';

    const out = [
        `# Workflow diagnosis — ${S(title)}`,
        '',
        PROVENANCE,
        '',
        'Compact analysis of **how** this session went: what the agent had available, what it',
        'actually used, and where it struggled. Full detail lives in the `-full.md` export.',
        '',
        '## Session',
        '',
        '| | |',
        '|---|---|',
        `| Session | \`${meta.sessionId}\` |`,
        `| When | ${fmtDateTime(meta.start)} → ${fmtDateTime(meta.end)} (${fmtDuration(stats.duration)}) |`,
        `| Workspace | \`${S(meta.cwd || '—')}\` (branch \`${S(meta.branch || '—')}\`) |`,
        `| Model(s) | ${[...meta.models].join(', ') || '—'} |`,
        `| Claude Code | ${[...meta.versions].join(', ') || '—'} |`,
        `| Turns / assistant messages / tool calls | ${stats.turnStats.length} / ${stats.assistantMessages} / ${stats.toolCalls} |`,
        '',
        '## Capabilities: available vs. used',
        '',
        `**Skills offered:** ${caps.skillsOffered.size} · **used:** ${caps.skillsUsed.size}`,
        '',
    ];

    if (caps.skillsUsed.size) {
        out.push('Used:', '');
        for (const skill of [...caps.skillsUsed].sort()) {
            const by = caps.skillsUsedBy?.get(skill);
            out.push(`- ✅ \`${cell(skill)}\`${by ? ` — in sub-agent ${[...by].map((a) => `\`${cell(a)}\``).join(', ')}` : ''}`);
        }
        out.push('');
    }
    if (caps.skillsUnused.size) {
        const { ours, others } = partitionSkills(caps.skillsUnused);
        out.push('Offered but never invoked — check whether one of these *should* have triggered:', '');
        if (ours.length) {
            for (const skill of ours) { out.push(`- ⚪ \`${cell(skill)}\``); }
        } else {
            out.push('- *(no unused iFacto skills)*');
        }
        if (others.length) {
            out.push('', `Plus ${others.length} other unused skill(s) (built-in / third-party), not listed.`);
        }
        out.push('');
    }

    out.push('### MCP servers', '', '| Server | Calls | Verdict |', '|---|---|---|');
    for (const server of [...caps.mcpConnected].sort()) {
        const calls = caps.mcpUsed.get(server) || 0;
        out.push(`| \`${cell(server)}\` | ${calls} | ${calls ? '✅ used' : '⚪ connected but never called'} |`);
    }
    if (!caps.mcpConnected.size) { out.push('| *(none connected)* | — | — |'); }
    out.push('');

    out.push('## Friction signals', '', '| Signal | Count |', '|---|---|');
    out.push(`| Tool errors | ${stats.errorCount} |`);
    out.push(`| User interruptions | ${stats.interruptions} |`);
    out.push(`| Retry loops (repeated commands) | ${stats.repeatedCommands.length} |`);
    out.push(`| Clarifying questions asked | ${stats.askRounds} |`);
    out.push(`| Sub-agents spawned | ${stats.subagentCount} |`);
    out.push('');

    if (stats.errors.length) {
        out.push('### Failing tool calls', '');
        for (const error of stats.errors.slice(0, 15)) {
            out.push(`- \`${cell(error.name)}\` — ${cell(S(error.headline))}`);
        }
        out.push('');
    }

    if (stats.repeatedCommands.length) {
        out.push('### Repeated commands', '', '| Count | Command |', '|---|---|');
        for (const repeat of stats.repeatedCommands.slice(0, 15)) {
            out.push(`| ${repeat.count} | \`${cell(S(repeat.command))}\` |`);
        }
        out.push('');
    }

    out.push('## Turn timeline', '', '| # | Wait | Duration | Tools | Skills | Errors | ⛔ |', '|---|---|---|---|---|---|---|');
    for (const t of stats.turnStats) {
        out.push(`| ${t.index} | ${fmtDuration(t.gap)} | ${fmtDuration(t.duration)} | ${cell(t.toolLabel) || '—'} | ${cell(t.skills.join(', ')) || '—'} | ${t.errors || '—'} | ${t.interrupted ? '⛔' : ''} |`);
    }
    out.push('');

    out.push('## Tool usage', '', '| Tool | Calls |', '|---|---|');
    for (const [name, count] of [...stats.toolFrequency.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
        out.push(`| \`${cell(name)}\` | ${count} |`);
    }
    out.push('');

    if (subagents.length) {
        out.push('## Sub-agents', '', '| Type | Assignment | Tool calls | Skills invoked |', '|---|---|---|---|');
        for (const sub of subagents) {
            const skills = (sub.skills || []).map((s) => `\`${cell(s)}\``).join(', ') || '—';
            out.push(`| \`${cell(sub.agentType)}\` | ${cell(S(sub.description))} | ${sub.toolCalls} | ${skills} |`);
        }
        out.push('');
    }

    out.push(
        '## Tokens',
        '',
        `Output: ${fmtNum(stats.outputTokens)} · cumulative context: ${fmtNum(stats.ctxTokens)} · `
        + `cache reads: ${fmtNum(stats.cacheRead)}`,
        '',
    );

    return out.join('\n');
}

/* ==================================================================== */
/* Zip archive — one attachment instead of three files                   */
/* ==================================================================== */

/**
 * The system Downloads folder. Windows and macOS both use <home>/Downloads;
 * Linux desktops can relocate it via XDG_DOWNLOAD_DIR.
 * Injectable for testing.
 */
export function downloadsDir({ platform = process.platform, home = homedir(), env = process.env } = {}) {
    if (platform === 'linux' && env.XDG_DOWNLOAD_DIR) {
        return env.XDG_DOWNLOAD_DIR.replace(/^\$HOME/, home).replace(/^~/, home);
    }
    return join(home, 'Downloads');
}

/**
 * Where an export lands by default: the Downloads folder, never a repository.
 * Exports carry customer code and command output, so keeping them out of any
 * working tree means they can never be committed by accident.
 */
export function defaultOutDir(opts) { return downloadsDir(opts); }

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) { c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; }
        table[i] = c;
    }
    return table;
})();

export function crc32(buffer) {
    let c = -1;
    for (let i = 0; i < buffer.length; i++) { c = CRC_TABLE[(c ^ buffer[i]) & 0xFF] ^ (c >>> 8); }
    return (c ^ -1) >>> 0;
}

const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xFFFF;
const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;

/**
 * Build a ZIP archive in memory. Deflate-compressed, no zip64, no encryption —
 * enough for a handful of markdown files, and written by hand because Node ships
 * no zip writer and Windows has no `zip` command.
 *
 * @param {{name: string, data: Buffer}[]} entries
 * @returns {Buffer}
 */
export function createZip(entries, when = new Date()) {
    const time = dosTime(when);
    const date = dosDate(when);
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
        const deflated = deflateRawSync(data, { level: 9 });
        const crc = crc32(data);

        const local = Buffer.alloc(30 + name.length);
        local.writeUInt32LE(0x04034b50, 0);   // local file header signature
        local.writeUInt16LE(20, 4);           // version needed
        local.writeUInt16LE(0, 6);            // flags
        local.writeUInt16LE(8, 8);            // method: deflate
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(deflated.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);           // extra field length
        name.copy(local, 30);
        locals.push(local, deflated);

        const central = Buffer.alloc(46 + name.length);
        central.writeUInt32LE(0x02014b50, 0); // central directory header signature
        central.writeUInt16LE(20, 4);         // version made by
        central.writeUInt16LE(20, 6);         // version needed
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(deflated.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(0, 30);         // extra
        central.writeUInt16LE(0, 32);         // comment
        central.writeUInt16LE(0, 34);         // disk number start
        central.writeUInt16LE(0, 36);         // internal attributes
        central.writeUInt32LE(0, 38);         // external attributes
        central.writeUInt32LE(offset, 42);    // offset of local header
        name.copy(central, 46);
        centrals.push(central);

        offset += local.length + deflated.length;
    }

    const centralBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);        // end of central directory signature
    eocd.writeUInt16LE(0, 4);                 // this disk
    eocd.writeUInt16LE(0, 6);                 // disk with central directory
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);                // comment length

    return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ==================================================================== */
/* main                                                                  */
/* ==================================================================== */

export function main(argv = process.argv.slice(2)) {
    const cfg = parseArgs(argv);
    const log = (msg) => { if (!cfg.quiet) { process.stderr.write(`${msg}\n`); } };

    if (cfg.help) { process.stdout.write(`${HELP}\n`); return 0; }

    /* ---- find candidate sessions ---- */
    let files = [];
    if (cfg.allProjects) {
        for (const name of readdirSync(DEFAULT_PROJECTS_ROOT)) {
            files.push(...listSessionFiles(join(DEFAULT_PROJECTS_ROOT, name)));
        }
        files.sort((a, b) => b.mtime - a.mtime);
    } else {
        const dir = projectDirFor(cfg.project);
        if (!dir) {
            log(`No transcript directory for ${cfg.project}. Try --all-projects.`);
            return 2;
        }
        files = listSessionFiles(dir);
    }
    if (!files.length) { log('No sessions found.'); return 2; }

    /* ---- --list ---- */
    if (cfg.list) {
        const rows = files.slice(0, cfg.limit).map(peek);
        if (cfg.json) {
            process.stdout.write(`${JSON.stringify(rows.map((r) => ({
                id: r.id, title: r.title, turns: r.turns, start: r.start, end: r.end,
                sizeKB: Math.round(r.size / 1024), cwd: r.cwd, branch: r.branch, firstPrompt: r.firstPrompt,
            })), null, 2)}\n`);
        } else {
            for (const [index, row] of rows.entries()) {
                process.stdout.write(
                    `@${index + 1}  ${fmtDateTime(row.start)}  ${String(row.turns).padStart(3)} turns  `
                    + `${row.title}\n      ${row.id}\n`,
                );
            }
        }
        return 0;
    }

    /* ---- select the session ---- */
    let file = null;
    if (cfg.target === 'latest') { file = files[0]; }
    else if (/^@\d+$/.test(cfg.target)) { file = files[Number(cfg.target.slice(1)) - 1]; }
    else {
        file = files.find((f) => f.id === cfg.target) || files.find((f) => f.id.startsWith(cfg.target));
    }
    if (!file) { log(`Session not found: ${cfg.target}`); return 2; }

    /* ---- parse + analyse ---- */
    log(`Reading ${file.path}`);
    const session = parseSession(file);
    if (!session.turns.length) { log('This session has no human turns.'); return 3; }

    const subagents = loadSubagents(session);
    const caps = collectCapabilities(session, subagents);
    const stats = analyze(session, subagents);
    const S = buildSanitizer(cfg.sanitize, cfg.redactions);
    const ctx = { session, subagents, stats, caps, S };

    const title = cfg.title || session.meta.title || session.turns[0].prompt.slice(0, 60);
    const slug = cfg.slug || slugify(title) || 'session';
    const day = fmtDay(session.meta.start);

    const wanted = cfg.mode === 'all' ? ['full', 'conversation', 'diagnose'] : [cfg.mode];
    const renderers = {
        full: () => renderFull(ctx, cfg),
        conversation: () => renderConversation(ctx),
        diagnose: () => renderDiagnose(ctx),
    };

    if (cfg.stdout) {
        for (const mode of wanted) { process.stdout.write(`${renderers[mode]()}\n`); }
        return 0;
    }

    const outDir = resolve(cfg.out || defaultOutDir());
    mkdirSync(outDir, { recursive: true });

    const written = [];
    for (const mode of wanted) {
        const path = join(outDir, `${day}-${slug}-${mode}.md`);
        const body = renderers[mode]();
        writeFileSync(path, `${body}\n`);
        written.push({ path, kB: Math.round(Buffer.byteLength(body) / 1024) });
        log(`Wrote ${path}`);
    }

    // One attachment beats three files when this goes to a devlead.
    let zipPath = null;
    if (cfg.zip) {
        try {
            const zipDir = resolve(cfg.zipDir || outDir);
            mkdirSync(zipDir, { recursive: true });
            zipPath = join(zipDir, `${day}-${slug}-chatexport.zip`);
            writeFileSync(zipPath, createZip(
                written.map((w) => ({ name: basename(w.path), data: readFileSync(w.path) })),
            ));
            log(`Wrote ${zipPath}`);
        } catch (err) {
            zipPath = null;
            log(`Could not write the zip: ${err.message}`);
        }
    }

    process.stdout.write(`${JSON.stringify({
        sessionId: session.meta.sessionId,
        title, slug, day,
        turns: stats.turnStats.length,
        assistantMessages: stats.assistantMessages,
        toolCalls: stats.toolCalls,
        thinkingBlocks: stats.thinkingBlocks,
        thinkingWithText: stats.thinkingWithText,
        subagents: stats.subagentCount,
        interruptions: stats.interruptions,
        errors: stats.errorCount,
        retryLoops: stats.repeatedCommands.length,
        skillsOffered: [...caps.skillsOffered],
        skillsUsed: [...caps.skillsUsed],
        skillsUnused: [...caps.skillsUnused],
        mcpConnected: [...caps.mcpConnected],
        mcpUnused: [...caps.mcpUnused],
        outputTokens: stats.outputTokens,
        outDir,
        files: written,
        zip: zipPath,
    }, null, 2)}\n`);

    return 0;
}

/* Run only when invoked directly, so tests can import the functions above. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exit(main());
}
