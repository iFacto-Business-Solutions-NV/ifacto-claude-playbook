// xlf.mjs — read XLIFF 1.2 files the AL compiler generates, and write a target-language file
// from the generated .g.xlf plus decisions.
//
// Part of the iFacto.translation-review skill. Text-level on purpose: an existing translation
// file is changed in place. Only the units whose English, translation or state change are
// rewritten. Every other unit, the order of the units and the layout stay byte for byte, so
// the diff a developer reviews holds only what changed.

const NAB_TAG = /^\[NAB: (NOT TRANSLATED|REVIEW|SUGGESTION)\]\s?/;

export const unescapeXml = (s) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

export const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const attrsOf = (s) => Object.fromEntries([...(s ?? '').matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], unescapeXml(m[2])]));

/** Normalises a culture code: nl-be → nl-BE. */
export const normLang = (code) => {
    const [a, b] = String(code).split('-');
    return b ? `${a.toLowerCase()}-${b.toUpperCase()}` : a.toLowerCase();
};

/**
 * Parses an XLIFF file into { bom, eol, targetLanguage, sourceLanguage, original, usesStates,
 * units } — units in file order, each { id, attrs, raw, start, end, source, target, state,
 * targetRaw, notes, maxwidth, translate }. `target` is null when there is none, or only a
 * NAB "not translated" tag.
 */
export function parseXlf(text) {
    const bom = text.startsWith('﻿');
    const eol = /\r\n/.test(text) ? '\r\n' : '\n';
    const file = attrsOf(/<file\b([^>]*)>/.exec(text)?.[1]);
    const units = [];
    let usesStates = false;
    for (const m of text.matchAll(/<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/g)) {
        const attrs = attrsOf(m[1]);
        const body = m[2];
        const sm = /<source\b[^>]*?(?:\/>|>([\s\S]*?)<\/source>)/.exec(body);
        const tm = /<target\b([^>]*?)(?:\/>|>([\s\S]*?)<\/target>)/.exec(body);
        const notes = {};
        for (const nm of body.matchAll(/<note\b([^>]*?)(?:\/>|>([\s\S]*?)<\/note>)/g)) {
            const na = attrsOf(nm[1]);
            notes[na.from ?? ''] = unescapeXml(nm[2] ?? '');
        }
        let target = null;
        let state = null;
        if (tm) {
            const ta = attrsOf(tm[1]);
            if (ta.state) { usesStates = true; state = ta.state; }
            let t = unescapeXml(tm[2] ?? '');
            const tag = NAB_TAG.exec(t);
            if (tag) {
                t = t.slice(tag[0].length);
                state = tag[1] === 'NOT TRANSLATED' ? 'needs-translation' : 'needs-review-translation';
            }
            target = tag?.[1] === 'NOT TRANSLATED' || t === '' ? null : t;
        }
        units.push({
            id: attrs.id,
            attrs,
            raw: m[0],
            start: m.index,
            end: m.index + m[0].length,
            source: sm ? unescapeXml(sm[1] ?? '') : '',
            target,
            state,
            targetRaw: tm ? tm[0] : null,
            notes,
            maxwidth: attrs.maxwidth ? Number(attrs.maxwidth) : null,
            translate: attrs.translate !== 'no',
        });
    }
    return {
        bom, eol, units, usesStates,
        targetLanguage: file['target-language'] ?? null,
        sourceLanguage: file['source-language'] ?? null,
        original: file.original ?? null,
        text,
    };
}

/** States of a finished translation: a decision equal to its text leaves the unit as it is. */
const DONE = new Set(['translated', 'final', 'signed-off']);

/**
 * True when the unit `old` of a target file already says what a rebuild of the generated unit
 * `u` would say. That means the same English, the same translate flag, and either no decision
 * or a decision equal to its translation in a finished state. In a file without states,
 * "finished" means no state at all. Such a unit is kept as it stands, layout and notes included.
 */
function unchangedUnit(u, old, decisions, states) {
    if (!old || old.source !== u.source || old.translate !== u.translate) { return false; }
    if (!u.translate || !decisions.has(u.id)) { return true; }
    return decisions.get(u.id) === old.target && (states ? DONE.has(old.state) : old.state === null);
}

/**
 * How the file `parsed` puts a <target> after its <source>. It returns the spaces between the
 * two when the target sits on the source's line (often none). It returns null when the target
 * starts a line of its own, and for a file that has no target yet.
 */
function targetGap(parsed) {
    const u = parsed?.units.find((x) => x.targetRaw);
    const m = u && /(?:<source\b[^>]*\/>|<\/source>)([ \t]*)<target\b/.exec(u.raw);
    return m ? m[1] : null;
}

/**
 * The trans-unit block of the generated unit `u` for a target file. It takes g's source and
 * notes. The target comes from `decisions`, else from the existing target of `old` (marked
 * needs-adaptation when the English changed and the file uses states), else there is none.
 * The target goes on the source's line when `ctx.gap` is a string, else on a line of its own.
 * Counts into `ctx.stats` and `ctx.stale`.
 */
function unitBlock(u, old, decisions, ctx) {
    const { eol, states, stats, stale, gap } = ctx;
    const targetXml = (text, state) => (states ? `<target state="${state}">${escapeXml(text)}</target>` : `<target>${escapeXml(text)}</target>`);
    let block = u.raw.replace(/\r?\n/g, eol);
    if (!u.translate) { return block; }
    let target = null;
    if (decisions.has(u.id)) {
        target = targetXml(decisions.get(u.id), 'translated');
        stats.decided++;
    } else if (old?.targetRaw) {
        target = old.targetRaw;
        if (old.source !== u.source) {
            stats.staleKept++;
            stale.push({ id: u.id, en: u.source, old: old.source, target: old.target, marked: states });
            // Only the opening tag changes; the translation text is never touched.
            if (states) { target = target.replace(/^<target\b([^>]*?)(\/?)>/, (_, attrs, slash) => `<target state="needs-adaptation"${attrs.replace(/\sstate="[^"]*"/, '')}${slash}>`); }
        } else {
            stats.kept++;
        }
    } else {
        if (!old) { stats.added++; } else { stats.empty++; }
        target = states ? '<target state="needs-translation"></target>' : null;
    }
    if (target) {
        const sm = /^([ \t]*)(?:<source\b[^>]*\/>|<source\b[^>]*>[\s\S]*?<\/source>)/m.exec(block);
        if (!sm) { throw new Error(`trans-unit ${u.id} has no <source>`); }
        const at = sm.index + sm[0].length;
        block = `${block.slice(0, at)}${gap ?? `${eol}${sm[1]}`}${target}${block.slice(at)}`;
    }
    return block;
}

/** The text between two trans-units of a parsed file, to lay out an added unit the same way. */
function unitSeparator(parsed, eol) {
    const { units, text } = parsed;
    return units.length > 1 ? text.slice(units[0].end, units[1].start) : `${eol}${/([ \t]*)$/.exec(text.slice(0, units[0].start))[1]}`;
}

/**
 * Writes `decisions` into the existing file `current` (at least one unit) in place:
 *   - a unit of g that `current` has is rewritten only when it changes (see unchangedUnit);
 *     otherwise it stays byte for byte, in its place;
 *   - a unit of g that `current` lacks goes after the nearest unit before it in g's order that
 *     `current` has (before the first unit when there is none), laid out like the file;
 *   - the text around and between the units is kept.
 * `scope` (a Set of ids, or null for every unit of g) limits what is written; `drop` removes the
 * units g no longer has. Counts the replaced, inserted and untouched units into `ctx.stats`.
 */
function mergeIntoFile(g, current, decisions, ctx, { scope, drop }) {
    const { stats } = ctx;
    const { text: old, units } = current;
    const at = new Map(units.map((u, i) => [u.id, i]));
    const replace = new Map();
    const insert = new Map(); // index in current → blocks added after it; -1 = before the first unit
    let anchor = -1;
    for (const u of g.units) {
        const i = at.get(u.id);
        if (!scope || scope.has(u.id)) {
            const was = i === undefined ? undefined : units[i];
            const block = unitBlock(u, was, decisions, ctx);
            if (i === undefined) {
                if (!insert.has(anchor)) { insert.set(anchor, []); }
                insert.get(anchor).push(block);
                stats.inserted++;
            } else if (!unchangedUnit(u, was, decisions, ctx.states)) {
                replace.set(i, block);
                stats.replaced++;
            }
        }
        if (i !== undefined) { anchor = i; }
    }
    const gIds = new Set(g.units.map((u) => u.id));
    const dropped = drop ? units.filter((u) => !gIds.has(u.id)).map((u) => u.id) : [];
    const gone = new Set(dropped);
    stats.untouched = units.length - stats.replaced - dropped.length;

    // Each piece is [the text before it, the unit]: an original unit keeps the text that stood
    // before it, an added one gets the file's usual separator.
    const separator = unitSeparator(current, ctx.eol);
    const pieces = (insert.get(-1) ?? []).map((b) => [separator, b]);
    units.forEach((u, i) => {
        if (!gone.has(u.id)) { pieces.push([i ? old.slice(units[i - 1].end, u.start) : separator, replace.get(i) ?? u.raw]); }
        for (const b of insert.get(i) ?? []) { pieces.push([separator, b]); }
    });
    const body = pieces.map(([before, b], k) => (k ? before + b : b)).join('');
    return { text: old.slice(0, units[0].start) + body + old.slice(units.at(-1).end), dropped };
}

/**
 * The text of a target-language file for the generated file `g`, with `decisions` (Map id →
 * text) written into it.
 *   - An existing file (`current`, parsed, with units) is changed in place by mergeIntoFile: only
 *     the units that change are rewritten, from g's source and notes. Every other unit stays byte
 *     for byte, in the file's own order. A missing unit is added after its predecessor in g, and
 *     the units g no longer has are dropped. The file keeps its own conventions: state attributes
 *     only when it already uses them, and the target on the source's line when it puts it there.
 *   - A new file (`current` null or without units) takes g's frame, units and order, with the
 *     target language set, and state attributes when `useStates`.
 * A unit's target comes from its decision, else from the existing target (marked
 * needs-adaptation when the English changed since and the file uses states), else there is none
 * (an empty needs-translation target in a new file with states).
 * Returns { text, stats, stale, dropped }. `stale` lists the kept translations whose English
 * changed (marked only when the file uses states); `dropped` lists the ids that were in
 * `current` and are gone.
 */
export function buildTargetXlf(g, current, decisions, { lang, useStates }) {
    const stats = { decided: 0, kept: 0, staleKept: 0, added: 0, empty: 0, dropped: 0, replaced: 0, inserted: 0, untouched: 0 };
    const stale = [];
    if (current?.units.length) {
        const ctx = { eol: current.eol, states: current.usesStates, gap: targetGap(current), stats, stale };
        const { text, dropped } = mergeIntoFile(g, current, decisions, ctx, { scope: null, drop: true });
        stats.dropped = dropped.length;
        return { text, stats, stale, dropped };
    }

    const eol = current?.eol ?? g.eol;
    const bom = current ? current.bom : g.bom;
    const ctx = { eol, states: useStates, gap: null, stats, stale };
    const blocks = g.units.map((u) => unitBlock(u, undefined, decisions, ctx));
    stats.inserted = blocks.length;
    // The frame (xliff, file, body, group) comes from g, with the target language set.
    let frame = g.text.replace(/(<file\b[^>]*?\btarget-language=")[^"]*(")/, `$1${lang.toLowerCase()}$2`);
    if (eol !== g.eol) { frame = frame.replace(/\r?\n/g, eol); }
    frame = frame.replace(/^﻿/, '');
    const fp = parseXlf(frame);
    const separator = unitSeparator(fp, eol);
    const text = `${bom ? '﻿' : ''}${frame.slice(0, fp.units[0].start)}${blocks.join(separator)}${frame.slice(fp.units.at(-1).end)}`;
    return { text, stats, stale, dropped: [] };
}

/**
 * The feature mode of buildTargetXlf: only the units in `scope` (a Set of ids) are written, and
 * nothing is dropped, not even a unit g no longer has. Everything else in `current` stays byte
 * for byte. `current` must be an existing file with at least one unit. Returns { text, stats,
 * stale, dropped } like buildTargetXlf; `dropped` is always empty.
 */
export function patchTargetXlf(g, current, decisions, { scope }) {
    if (!current?.units.length) { throw new Error('patchTargetXlf needs an existing translation file with at least one unit'); }
    const stats = { decided: 0, kept: 0, staleKept: 0, added: 0, empty: 0, dropped: 0, replaced: 0, inserted: 0, untouched: 0 };
    const stale = [];
    const ctx = { eol: current.eol, states: current.usesStates, gap: targetGap(current), stats, stale };
    const { text } = mergeIntoFile(g, current, decisions, ctx, { scope, drop: false });
    return { text, stats, stale, dropped: [] };
}
