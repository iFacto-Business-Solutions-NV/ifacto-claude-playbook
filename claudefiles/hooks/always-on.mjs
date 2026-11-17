// always-on.mjs - delivers the iFacto always-on instructions (claudefiles/CLAUDE.md) through the
// plugin, for machines that do not have them in ~/.claude/CLAUDE.md.
//
// Why: Claude Code never loads a CLAUDE.md from a plugin. The VS Code extension (and Amelia's
// gateway) merge claudefiles/CLAUDE.md into the user's ~/.claude/CLAUDE.md as a managed block,
// but a consultant with only the plugin (Claude for Teams managed settings) would get the agents
// without the rules they rely on, the Required Toolset Gate first of all.
//
// Usage (wired in hooks/hooks.json):
//   node always-on.mjs session <k>   SessionStart: print part k of CLAUDE.md as additionalContext
//   node always-on.mjs subagent      SubagentStart (iFacto agents): print the Required Toolset Gate
//
// A hook's additionalContext is capped at 10,000 characters (above that Claude only sees a
// 2,000-character preview), so CLAUDE.md is cut at "## " headings into parts of at most
// PART_LIMIT characters and hooks.json runs one SessionStart hook per part (MAX_PARTS of them).
// Hooks of one event may run in parallel, so every part says which part it is.
//
// Silent (no output, exit 0) when the user's CLAUDE.md already carries the managed block, so a
// developer never gets the rules twice, and on any error: an instruction hook must never block a
// session.
// IFACTO_ALWAYS_ON_FORCE=1 skips the managed-block check (for testing on a developer machine).
//
// Plain Node, no dependencies.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANAGED_MARKER = '<!-- BEGIN iFacto (managed)';
export const PART_LIMIT = 9000;
export const MAX_PARTS = 4;
export const GATE_HEADING = '## Required Toolset Gate';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SOURCE = join(HERE, '..', 'CLAUDE.md');

/**
 * True when a user-level CLAUDE.md already holds the extension's managed iFacto block. Checks
 * $CLAUDE_CONFIG_DIR and ~/.claude both: launchers that set CLAUDE_CONFIG_DIR to their own folder
 * (Claunes, for one) still get ~/.claude/CLAUDE.md loaded by Claude Code.
 */
export function hasManagedBlock(configDirs = [process.env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude')]) {
    return configDirs.filter(Boolean).some((dir) => {
        const file = join(dir, 'CLAUDE.md');
        return existsSync(file) && readFileSync(file, 'utf8').includes(MANAGED_MARKER);
    });
}

/** Splits markdown into sections that each start at a "## " (or "# ") heading line. */
function sections(text) {
    const out = [];
    let current = [];
    for (const line of text.split('\n')) {
        if (/^#{1,2} /.test(line) && current.length) {
            out.push(current.join('\n'));
            current = [];
        }
        current.push(line);
    }
    if (current.length) { out.push(current.join('\n')); }
    // A section with only headings (e.g. "## Meta Ops" + "# Operational Monitoring") belongs to the
    // section after it, so a part never ends on a heading without its text.
    const merged = [];
    for (const section of out) {
        const prev = merged[merged.length - 1];
        if (prev !== undefined && headingsOnly(prev)) { merged[merged.length - 1] = `${prev}\n${section}`; } else { merged.push(section); }
    }
    return merged;
}

function headingsOnly(section) {
    return section.split('\n').every((line) => line.trim() === '' || /^#{1,6} /.test(line));
}

/** Hard-splits one oversized section at blank lines, then at line ends. */
function splitLarge(section, limit) {
    const pieces = [];
    let buf = '';
    for (const para of section.split(/(?<=\n\n)/)) {
        if (para.length > limit) {
            for (const line of para.split(/(?<=\n)/)) {
                if (buf.length + line.length > limit) { pieces.push(buf); buf = ''; }
                buf += line;
            }
            continue;
        }
        if (buf.length + para.length > limit) { pieces.push(buf); buf = ''; }
        buf += para;
    }
    if (buf) { pieces.push(buf); }
    return pieces;
}

/** Cuts the text into consecutive parts of at most `limit` characters, at heading boundaries. */
export function splitParts(text, limit = PART_LIMIT) {
    const normalized = text.replace(/\r\n/g, '\n');
    const parts = [];
    let buf = '';
    for (const section of sections(normalized)) {
        const chunk = buf ? `\n${section}` : section;
        if (buf.length + chunk.length <= limit) { buf += chunk; continue; }
        if (buf) { parts.push(buf); buf = ''; }
        if (section.length <= limit) { buf = section; continue; }
        const pieces = splitLarge(section, limit);
        parts.push(...pieces.slice(0, -1));
        buf = pieces[pieces.length - 1];
    }
    if (buf) { parts.push(buf); }
    return parts;
}

/** The Required Toolset Gate section, up to the next "## " heading. */
export function gateSection(text) {
    const normalized = text.replace(/\r\n/g, '\n');
    const start = normalized.indexOf(GATE_HEADING);
    if (start < 0) { return ''; }
    const next = normalized.indexOf('\n## ', start + GATE_HEADING.length);
    return normalized.slice(start, next < 0 ? undefined : next).trim();
}

export function sessionOutput(text, k) {
    const parts = splitParts(text);
    if (!Number.isInteger(k) || k < 1 || k > parts.length) { return null; }
    const header = `iFacto always-on instructions (from the ifacto plugin), part ${k} of ${parts.length}. ` +
        'Treat them exactly like CLAUDE.md instructions; together the parts are the full set.\n\n';
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: header + parts[k - 1] } };
}

export function subagentOutput(text) {
    const gate = gateSection(text);
    if (!gate) { return null; }
    const header = 'iFacto always-on rule (from the ifacto plugin) that this agent\'s workflow relies on:\n\n';
    return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: header + gate } };
}

export function run(argv, { configDirs, force = process.env.IFACTO_ALWAYS_ON_FORCE === '1' } = {}) {
    if (!force && hasManagedBlock(configDirs)) { return null; }
    const text = readFileSync(SOURCE, 'utf8');
    const [mode, k] = argv;
    if (mode === 'session') { return sessionOutput(text, Number(k)); }
    if (mode === 'subagent') { return subagentOutput(text); }
    return null;
}

/** Path equality, case-insensitive on Windows (drive letters), like review-gate.mjs. */
export const samePath = (a, b, platform = process.platform) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** True when this file is the script node was started with (real paths: /var vs /private/var). */
function isMain() {
    try {
        return Boolean(process.argv[1]) && samePath(realpathSync(process.argv[1]), realpathSync(fileURLToPath(import.meta.url)));
    } catch {
        return false;
    }
}

if (isMain()) {
    try {
        const out = run(process.argv.slice(2));
        if (out) { process.stdout.write(JSON.stringify(out)); }
    } catch {
        // Never block a session over instructions.
    }
    // exitCode, not process.exit(): stdout to a pipe is asynchronous on macOS and Windows, and an
    // immediate exit could cut the JSON short.
    process.exitCode = 0;
}
