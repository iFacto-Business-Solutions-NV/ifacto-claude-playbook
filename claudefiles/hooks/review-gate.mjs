#!/usr/bin/env node
// review-gate.mjs — SubagentStop hook: iFacto.CodeReviewer may not finish before all three
// review passes have run.
//
// Part of the `ifacto` plugin (claudefiles/hooks/hooks.json). Zero dependencies, Node 18+.
//
// Why a hook and not a sentence in the agent: the agent definition already says MANDATORY,
// BCQuality's super-skill already says "MUST NOT filter sub-skills by task content", and the
// reviewer skipped both anyway (2026-11-05: it judged BCQuality "covered by the rulebook",
// never dispatched a leaf skill and replaced the security skill with a manual diff check,
// then reported `fix`). Prose is advice; this hook is a gate the harness runs.
//
// What it checks in the sub-agent's own transcript (`agent_transcript_path`):
//   1. rulebook  — the `iFacto.code-review` skill was invoked (Skill tool)
//   2. bcquality — the BCQuality `al-code-review` skill was invoked AND every leaf skill of
//                  its super-skill shows up in a later tool call (read, grep, child agent):
//                  the dispatch was executed, not summarised
//   3. security  — the `iFacto.al-security-review` skill was invoked
// A pass whose Skill call *failed* (plugin not installed, unknown skill) counts as attempted:
// the toolset gate then applies and the agent reports the hard stop. What never counts is a
// pass that was never tried.
// Legitimate early stops are let through: a review that ended at the build gate of the
// rulebook skill (the rulebook itself was never opened and the report says why), the
// developer interrupting the agent, and a BCQuality dispatch that answered `no-match`/`failed`.
//
// Missing pass → `{"decision":"block","reason":...}`: Claude Code keeps the sub-agent running
// and hands it the reason as its next instruction. At most IFACTO_REVIEW_GATE_MAX_BLOCKS
// (default 2) blocks per agent, then the gate lets go so a broken environment cannot loop.
// IFACTO_REVIEW_GATE=off disables it. Any failure inside the hook itself is fail-open.

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ==================================================================== */
/* The three passes                                                      */
/* ==================================================================== */

export const AGENT_RE = /iFacto\.CodeReviewer/i;

/** Leaf skills of BCQuality's `al-code-review` super-skill (microsoft/skills/review/al-code-review.md,
 *  frontmatter `sub-skills`, BCQuality 1.10.0). Used only when the installed BCQuality cannot be
 *  located; the installed list wins, so a new leaf upstream needs no change here. */
export const DEFAULT_LEAVES = [
    'al-performance-review', 'al-security-review', 'al-privacy-review', 'al-upgrade-review',
    'al-style-review', 'al-ui-review', 'al-error-handling-review', 'al-events-review',
    'al-interfaces-review', 'al-breaking-changes-review', 'al-web-services-review',
    'al-testing-review', 'al-data-modeling-review', 'al-query-review', 'al-reporting-review',
    'al-appsource-review', 'al-telemetry-review', 'al-scm-review', 'al-finance-review',
];

export const PASSES = [
    {
        id: 'rulebook',
        label: 'iFacto review rulebook',
        skill: /(^|[:/])iFacto[.-]code-review$/i,
        instruction: 'invoke the `iFacto.code-review` skill with the Skill tool and follow it end to end (build gate, Jira requirement, rulebook, finding gate).',
    },
    {
        id: 'bcquality',
        label: 'BCQuality technical review',
        skill: /(^|[:/])(al-code-review|bcquality-al-review)$/i,
        instruction: 'invoke the `al-code-review` skill of the BCQuality plugin (`bcquality:al-code-review`) with the Skill tool, let Entry route it, and execute the whole dispatch: every leaf skill of the `al-code-review` super-skill, each against the changed files, on every enabled layer (microsoft, community, custom).',
    },
    {
        id: 'security',
        label: 'security review',
        skill: /(^|[:/])iFacto[.-]al-security-review$/i,
        instruction: 'invoke the `iFacto.al-security-review` skill with the Skill tool in `review` mode on the changed files. A manual scan of the diff for secrets, HttpClient or permissions is not that pass.',
    },
];

/* ==================================================================== */
/* Transcript                                                            */
/* ==================================================================== */

const readLines = (path) =>
    readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);

const contentBlocks = (entry) => {
    const content = entry?.message?.content;
    if (Array.isArray(content)) { return content; }
    if (typeof content === 'string') { return [{ type: 'text', text: content }]; }
    return [];
};

const INTERRUPT_RE = /\[Request interrupted by user/i;

const resultText = (block) => {
    const c = block.content;
    if (typeof c === 'string') { return c; }
    if (Array.isArray(c)) { return c.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('\n'); }
    return '';
};

/**
 * Tool calls in order, each with its result status; the hand-back report; and whether the
 * developer's interrupt is the LAST thing that happened (an agent resumed after an interrupt
 * is gated again).
 */
export function parseTranscript(entries) {
    const calls = [];
    const byId = new Map();
    let handback = null;
    let lastText = '';
    let interrupted = false;

    for (const e of entries) {
        for (const block of contentBlocks(e)) {
            if (e.type === 'user' && block.type === 'text' && INTERRUPT_RE.test(String(block.text || ''))) {
                interrupted = true; // the developer stopped it: the gate must not restart it
            }
            if (e.type === 'assistant' && block.type === 'tool_use') {
                interrupted = false;
                const call = { id: block.id, name: block.name, input: block.input || {}, isError: false, hasResult: false };
                calls.push(call);
                if (block.id) { byId.set(block.id, call); }
                if (block.name === 'SubagentHandback') { handback = String(block.input?.message ?? ''); }
            } else if (e.type === 'assistant' && block.type === 'text' && block.text) {
                interrupted = false;
                lastText = block.text;
            } else if (block.type === 'tool_result' && block.tool_use_id) {
                const call = byId.get(block.tool_use_id);
                if (call) { call.hasResult = true; call.isError = !!block.is_error; }
                if (INTERRUPT_RE.test(resultText(block))) { interrupted = true; } // interrupted during a tool call
            }
        }
    }
    return { calls, handback, lastText, interrupted };
}

/**
 * The sub-agent's transcript: the `agent_transcript_path` the hook payload names, or — if
 * that field is absent — Claude Code's own layout next to the main transcript,
 * `<dir>/<session-id>/subagents/agent-<agent_id>.jsonl`. Null when neither exists.
 */
export function transcriptPathOf(input) {
    const named = input.agent_transcript_path;
    if (named && existsSync(named)) { return named; }
    const main = input.transcript_path;
    const id = String(input.agent_id || '');
    if (main && id) {
        const sessionId = basename(main).replace(/\.jsonl$/, '');
        const guess = join(dirname(main), sessionId, 'subagents', `agent-${id}.jsonl`);
        if (existsSync(guess)) { return guess; }
    }
    return null;
}

const skillName = (call) => (call.name === 'Skill' ? String(call.input?.skill ?? call.input?.name ?? '') : '');

/* ==================================================================== */
/* BCQuality leaves — from the installed plugin when it can be found     */
/* ==================================================================== */

const SUPER_SKILL = join('microsoft', 'skills', 'review', 'al-code-review.md');

/** Same search order as the iFacto.company-guidelines skill; newest plugin version first. */
function bcqualityRoots(env, home) {
    const roots = [];
    if (env.BCQUALITY_ROOT) { roots.push(env.BCQUALITY_ROOT); }
    const cache = join(home, '.claude', 'plugins', 'cache');
    if (existsSync(cache)) {
        for (const marketplace of safeList(cache)) {
            const pluginDir = join(cache, marketplace, 'bcquality');
            const versions = safeList(pluginDir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
            for (const version of versions) { roots.push(join(pluginDir, version)); }
        }
    }
    const clone = join(home, '.ifacto-playbook', 'bcquality');
    for (const profile of safeList(clone)) { roots.push(join(clone, profile)); }
    return roots;
}

const safeList = (dir) => { try { return readdirSync(dir); } catch { return []; } };

export function parseSubSkills(markdown) {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1];
    if (!fm) { return []; }
    const block = /^sub-skills:\s*\n((?:\s+-\s+.*\n?)+)/m.exec(fm)?.[1];
    if (!block) { return []; }
    return block.split('\n')
        .map((l) => /^\s+-\s+(.+?)\s*$/.exec(l)?.[1])
        .filter(Boolean)
        .map((p) => p.replace(/\\/g, '/').split('/').pop().replace(/\.md$/, ''));
}

export function resolveLeaves({ env = process.env, home = homedir() } = {}) {
    let leaves = null;
    for (const root of bcqualityRoots(env, home)) {
        const file = join(root, SUPER_SKILL);
        if (!existsSync(file)) { continue; }
        const parsed = parseSubSkills(readFileSync(file, 'utf8'));
        if (parsed.length) { leaves = parsed; break; }
    }
    leaves ??= [...DEFAULT_LEAVES];
    const disabled = new Set(String(env.BCQUALITY_DISABLED_SKILLS || '').split(',').map((s) => s.trim()).filter(Boolean));
    return leaves.filter((l) => !disabled.has(l));
}

/* ==================================================================== */
/* Evaluation                                                            */
/* ==================================================================== */

/** The build actually ran: the AL MCP build/diagnostics tools (local mode) or `az` for the PR's validation build (pr mode). */
const BUILD_TOOL_RE = /al_build|al_getdiagnostics|\balc\b|\baz\s+(repos|devops|pipelines|rest)\b/;
/** A local build-gate stop: a `## Build` section listing at least one real diagnostic code, and the "not clean" verdict. */
const LOCAL_BUILD_STOP_RE = /## Build\b[\s\S]*\b[A-Z]{2,3}\d{4}\b[\s\S]*(not clean|unknown build is not a clean build|build cannot run)/i;
/** A pr-mode stop: the validation build is not green. */
const PR_BUILD_STOP_RE = /validation build[^\n]{0,120}\b(red|fail|failed|failing|queued|running|rejected|broken|expired|not green|no validation build)\b/i;
/** BCQuality Entry answered with nothing to dispatch (or could not route) — pasted into the report. */
const NO_DISPATCH_RE = /outcome["'\s:]*["']?(no-match|failed)\b/i;
/** Only a read of every leaf file counts as reading every leaf; listing the folder does not. */
const WHOLE_FOLDER_READ_RE = /\b(cat|Get-Content|gc|type)\b[^\n]*skills[\\/]+review[\\/]+\*\.md/;

/**
 * Which passes are missing. Returns [] when the review may finish.
 * Each entry: { id, label, reason, instruction }.
 */
export function evaluate({ calls, handback = '', lastText = '' }, leaves = DEFAULT_LEAVES) {
    const missing = [];
    const report = handback || lastText || '';
    const inputs = calls.map((c) => JSON.stringify(c.input)).join('\n');

    // Stopped at the build gate: the rulebook skill ran, a build was actually run, and the report
    // shows the build verdict that stopped it (diagnostic codes, or a red validation build).
    // "No rulebook, no findings" - nothing is owed after it. Whether the agent had already
    // opened the rulebook does not matter; what matters is the evidence of the build.
    const rulebookRan = calls.some((c) => PASSES[0].skill.test(skillName(c)) && !c.isError);
    const buildRan = calls.some((c) => c.name !== 'Skill' && BUILD_TOOL_RE.test(`${c.name} ${JSON.stringify(c.input)}`));
    if (rulebookRan && buildRan && (LOCAL_BUILD_STOP_RE.test(report) || PR_BUILD_STOP_RE.test(report))) { return []; }

    for (const pass of PASSES) {
        const attempts = calls.filter((c) => pass.skill.test(skillName(c)));
        if (!attempts.length) {
            missing.push({ ...pick(pass), reason: 'never invoked' });
            continue;
        }
        const succeeded = attempts.some((c) => !c.isError);
        if (!succeeded) { continue; } // attempted, failed: the toolset gate owns this, not us

        if (pass.id === 'bcquality') {
            if (NO_DISPATCH_RE.test(report)) { continue; } // Entry had nothing to dispatch; the report says so
            const first = calls.indexOf(attempts.find((c) => !c.isError));
            const later = calls.slice(first + 1).filter((c) => c.name !== 'Skill');
            const evidence = later.map((c) => JSON.stringify(c.input)).join('\n');
            const unread = WHOLE_FOLDER_READ_RE.test(evidence) ? [] : leaves.filter((leaf) => !evidence.includes(leaf));
            if (unread.length) {
                missing.push({
                    ...pick(pass),
                    reason: `the skill was invoked but its dispatch was not executed — ${unread.length} of ${leaves.length} leaf skills never ran (${unread.join(', ')})`,
                });
            }
        }
    }
    return missing;
}

const pick = (pass) => ({ id: pass.id, label: pass.label, instruction: pass.instruction });

export function blockReason(missing, blocks, maxBlocks) {
    const lines = [
        '⛔ iFacto review gate: the review is not finished. These mandatory passes have not run:',
        '',
        ...missing.map((m) => `- ${m.label}: ${m.reason}. Now ${m.instruction}`),
        '',
        'Run every missing pass now, exactly as the agent definition says, then re-issue the one',
        'consolidated report with the findings of all three passes merged. Overlap between the',
        'rulebook and BCQuality is resolved on findings after the passes have run — never by',
        'skipping a pass. If a skill or plugin turns out to be missing, invoke it anyway so the',
        'failure is on record, say so under `## Not fetched / problems` and in the context line,',
        'and never recommend `approve` for a review that could not run all three passes.',
        `(gate check ${blocks} of ${maxBlocks})`,
    ];
    return lines.join('\n');
}

/* ==================================================================== */
/* Loop guard                                                            */
/* ==================================================================== */

function stateFile(agentId, dir) {
    const safe = String(agentId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(dir, `${safe}.json`);
}

/** Blocks so far for this agent, after counting this one; null when the state cannot be kept. */
function bumpBlocks(agentId, dir) {
    try {
        mkdirSync(dir, { recursive: true });
        const file = stateFile(agentId, dir);
        const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { blocks: 0 };
        state.blocks = (state.blocks || 0) + 1;
        state.at = new Date().toISOString();
        writeFileSync(file, JSON.stringify(state));
        return state.blocks;
    } catch {
        return null;
    }
}

/* ==================================================================== */
/* Decision                                                              */
/* ==================================================================== */

/**
 * @param input   the SubagentStop hook payload (stdin JSON)
 * @returns       { block: boolean, reason?: string, note?: string }
 */
export function decide(input, { env = process.env, home = homedir(), stateDir = join(tmpdir(), 'ifacto-review-gate') } = {}) {
    if (String(env.IFACTO_REVIEW_GATE || '').toLowerCase() === 'off') { return { block: false, note: 'gate off' }; }
    if (!AGENT_RE.test(String(input.agent_type || ''))) { return { block: false, note: 'not the reviewer' }; }

    const path = transcriptPathOf(input);
    if (!path) { return { block: false, note: 'no transcript' }; }

    const transcript = parseTranscript(readLines(path));
    if (transcript.interrupted) { return { block: false, note: 'interrupted by the developer' }; }
    const missing = evaluate(transcript, resolveLeaves({ env, home }));
    if (!missing.length) { return { block: false }; }

    const maxBlocks = Math.max(0, Number(env.IFACTO_REVIEW_GATE_MAX_BLOCKS ?? 2) || 0);
    // No writable state: block once at most - `stop_hook_active` says a stop hook already
    // sent the agent back, so the second stop lets go. The guard never fails closed.
    const blocks = bumpBlocks(input.agent_id, stateDir) ?? (input.stop_hook_active ? maxBlocks + 1 : 1);
    if (blocks > maxBlocks) {
        return {
            block: false,
            note: `review gate gave up after ${maxBlocks} blocks; still missing: ${missing.map((m) => m.id).join(', ')}`,
        };
    }
    return { block: true, reason: blockReason(missing, blocks, maxBlocks) };
}

/* ==================================================================== */
/* CLI                                                                   */
/* ==================================================================== */

export function main(stdinText) {
    let input;
    try { input = JSON.parse(stdinText || '{}'); } catch { return 0; }
    const result = decide(input);
    if (result.block) {
        process.stdout.write(JSON.stringify({ decision: 'block', reason: result.reason }));
    } else if (result.note && /gave up/.test(result.note)) {
        process.stdout.write(JSON.stringify({ systemMessage: `iFacto review gate: ${result.note}. The report is incomplete — relaunch iFacto.CodeReviewer for the missing passes.` }));
    } else if (result.note === 'no transcript') {
        // Visible in `claude --debug`; a gate that never sees a transcript never blocks, and
        // that must not stay invisible.
        process.stderr.write('review-gate: no sub-agent transcript found (agent_transcript_path / transcript_path + agent_id); gate skipped\n');
    }
    return 0;
}

// argv[1] may differ from import.meta.url in drive-letter case (Windows) or through a symlink,
// junction or subst path; compare real paths, case-insensitively on Windows, or the gate
// silently never runs.
const realPath = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const isCli = !!process.argv[1] && samePath(realPath(process.argv[1]), realPath(fileURLToPath(import.meta.url)));
if (isCli) {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { text += chunk; });
    process.stdin.on('end', () => {
        try { process.exit(main(text)); } catch (err) {
            process.stderr.write(`review-gate: ${err?.message || err}\n`);
            process.exit(0); // fail open: a broken gate must never block every review
        }
    });
}
