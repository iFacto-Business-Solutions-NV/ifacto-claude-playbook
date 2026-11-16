// xlf.mjs — read XLIFF 1.2 files the AL compiler generates, and write a target-language file
// from the generated .g.xlf plus decisions.
//
// Part of the iFacto.translation-review skill. Text-level on purpose: a translation file is
// rewritten as the .g.xlf lays it out (same units, same order, same notes), with every
// untouched target kept byte for byte, so the diff a developer reviews holds only what changed.

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

/**
 * The trans-unit block of the generated unit `u` for a target file: g's source and notes, and
 * the target from `decisions`, else the existing target of `old` (marked needs-adaptation when
 * the English changed and the file uses states), else none. Counts into `ctx.stats` and
 * `ctx.stale`.
 */
function unitBlock(u, old, decisions, ctx) {
    const { eol, states, stats, stale } = ctx;
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
        block = `${block.slice(0, at)}${eol}${sm[1]}${target}${block.slice(at)}`;
    }
    return block;
}

/** The text between two trans-units of a parsed file, to lay out an added unit the same way. */
function unitSeparator(parsed, eol) {
    const { units, text } = parsed;
    return units.length > 1 ? text.slice(units[0].end, units[1].start) : `${eol}${/([ \t]*)$/.exec(text.slice(0, units[0].start))[1]}`;
}

/**
 * The text of a target-language file built from the generated file `g`:
 *   - every unit of g, in g's order, with g's source and notes;
 *   - the target from `decisions` (Map id → text) when there is one;
 *   - else the existing target of `current` (parsed target file or null), kept as it was —
 *     marked needs-adaptation when the English changed since and the file uses states;
 *   - else no target (or an empty needs-translation target when the file uses states).
 * Units of `current` that g no longer has are dropped. Returns { text, stats, stale, dropped }:
 * `stale` lists the kept translations whose English changed (marked only when the file uses
 * states), `dropped` the ids that were in `current` and are gone.
 */
export function buildTargetXlf(g, current, decisions, { lang, useStates }) {
    const eol = current?.eol ?? g.eol;
    const bom = current ? current.bom : g.bom;
    const states = current ? (current.usesStates || useStates) : useStates;
    const existing = new Map((current?.units ?? []).map((u) => [u.id, u]));
    const stats = { decided: 0, kept: 0, staleKept: 0, added: 0, empty: 0, dropped: 0 };
    const stale = [];
    const ctx = { eol, states, stats, stale };

    const blocks = g.units.map((u) => unitBlock(u, existing.get(u.id), decisions, ctx));
    const gIds = new Set(g.units.map((u) => u.id));
    const dropped = [...existing.keys()].filter((id) => !gIds.has(id));
    stats.dropped = dropped.length;

    // The frame (xliff, file, body, group) comes from the current file, or from g with the
    // target language set; the units in between are rebuilt.
    let frame = current && current.units.length ? current.text : g.text;
    if (!current || !current.units.length) {
        frame = frame.replace(/(<file\b[^>]*?\btarget-language=")[^"]*(")/, `$1${lang.toLowerCase()}$2`);
        if (current?.eol && current.eol !== g.eol) { frame = frame.replace(/\r?\n/g, eol); }
    }
    frame = frame.replace(/^﻿/, '');
    const fp = parseXlf(frame);
    const first = fp.units[0];
    const last = fp.units.at(-1);
    const separator = unitSeparator(fp, eol);
    const text = `${bom ? '﻿' : ''}${frame.slice(0, first.start)}${blocks.join(separator)}${frame.slice(last.end)}`;
    return { text, stats, stale, dropped };
}

/**
 * The feature mode of buildTargetXlf: only the units in `scope` (a Set of ids) change, the rest
 * of `current` stays byte for byte — every other unit, the order, the frame, nothing dropped.
 *   - a scoped unit `current` has is rebuilt from g in its place, as buildTargetXlf would;
 *   - a scoped unit `current` lacks is added after the nearest unit before it in g's order
 *     that `current` has (before the first unit when there is none).
 * The file keeps its own convention: `state` attributes only when it already uses them.
 * `current` must be an existing file with at least one unit. Returns { text, stats, stale,
 * dropped } like buildTargetXlf; `dropped` is always empty, and `stats` also counts the
 * replaced, inserted and untouched units.
 */
export function patchTargetXlf(g, current, decisions, { scope }) {
    if (!current?.units.length) { throw new Error('patchTargetXlf needs an existing translation file with at least one unit'); }
    const eol = current.eol;
    const states = current.usesStates;
    const stats = { decided: 0, kept: 0, staleKept: 0, added: 0, empty: 0, dropped: 0, replaced: 0, inserted: 0, untouched: 0 };
    const stale = [];
    const ctx = { eol, states, stats, stale };
    const at = new Map(current.units.map((u, i) => [u.id, i]));
    const replace = new Map();
    const insert = new Map(); // index in current → blocks added after it; -1 = before the first unit
    let anchor = -1;
    for (const u of g.units) {
        const i = at.get(u.id);
        if (scope.has(u.id)) {
            const block = unitBlock(u, i === undefined ? undefined : current.units[i], decisions, ctx);
            if (i === undefined) {
                if (!insert.has(anchor)) { insert.set(anchor, []); }
                insert.get(anchor).push(block);
                stats.inserted++;
            } else {
                replace.set(i, block);
                stats.replaced++;
            }
        }
        if (i !== undefined) { anchor = i; }
    }
    stats.untouched = current.units.length - stats.replaced;

    const { text: old, units } = current;
    const separator = unitSeparator(current, eol);
    let text = old.slice(0, units[0].start) + (insert.get(-1) ?? []).map((b) => `${b}${separator}`).join('');
    units.forEach((u, i) => {
        text += replace.get(i) ?? old.slice(u.start, u.end);
        for (const b of insert.get(i) ?? []) { text += `${separator}${b}`; }
        text += old.slice(u.end, i + 1 < units.length ? units[i + 1].start : old.length);
    });
    return { text, stats, stale, dropped: [] };
}
