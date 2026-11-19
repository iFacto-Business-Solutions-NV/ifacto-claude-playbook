#!/usr/bin/env node
// translation-review.mjs — review the translations of an AL app with AI, let the customer
// confirm them in Excel, and write the result back to the XLF files.
//
// Part of the iFacto.translation-review skill. Zero dependencies, Node 18+.
//
// Usage:  node translation-review.mjs snapshot     --project <App> [--base <merge-base .g.xlf>] [--full] [--work <dir>] [--g <file>] [--packages <dir>] [--langs nl-BE,fr-BE] [--add-lang es-ES] [--commit <label>] [--separate-variants] [--force]
//         node translation-review.mjs terms        --work <dir> [--top 120]
//         node translation-review.mjs export       --work <dir> --round terms|texts [--out <file.xlsx>]
//         node translation-review.mjs import-terms --work <dir> --xlsx <file> [--project <App>]
//         node translation-review.mjs chunk        --work <dir> [--size 270] [--scope all|open] [--force]
//         node translation-review.mjs tm           --work <dir> [--lang nl-BE] "<phrase>" ["<phrase>" ...]
//         node translation-review.mjs join         --work <dir> --chunk <NN>
//         node translation-review.mjs validate     --work <dir> --chunk <NN>
//         node translation-review.mjs merge        --work <dir>
//         node translation-review.mjs import       --work <dir> --xlsx <file> --project <App> [--g <file>] [--dry-run] [--allow-drop]
//
// The work folder (default ~/Downloads/translation-review/<app>-<date>) holds the snapshot,
// the reference translations, the glossary, the review and the workbooks. It holds customer
// texts: it never goes into a repository, and only the workbooks go to the customer.
//
// Prints one JSON document on stdout (tm and validate print text). Exit 0 = done,
// 1 = problems found (validate, merge) or an error, 2 = usage error.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { readZip } from './lib/zip.mjs';
import { writeWorkbook, readWorkbook, STYLE } from './lib/xlsx.mjs';
import { parseXlf, buildTargetXlf, patchTargetXlf, normLang } from './lib/xlf.mjs';
import { VERDICTS, categoryOf, isFocus, readableContext, placeholdersOf, isBlank, problemsOf } from './lib/rules.mjs';

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = 1;
const DEFAULT_CHUNK = 270;
const SHORT = 60; // reference strings up to this length are kept for term and phrase lookups
const DONE_STATES = new Set(['translated', 'final', 'signed-off']);
const BASE_COPY = 'base.g.xlf'; // the feature mode's base, kept in the work folder

const USAGE = `Usage:
  node translation-review.mjs snapshot     --project <App> [--base <merge-base .g.xlf>] [--full] [--work <dir>] [--g <file>] [--packages <dir>] [--langs nl-BE,fr-BE] [--add-lang es-ES] [--commit <label>] [--separate-variants] [--force]
  node translation-review.mjs terms        --work <dir> [--top 120]
  node translation-review.mjs export       --work <dir> --round terms|texts [--out <file.xlsx>]
  node translation-review.mjs import-terms --work <dir> --xlsx <file> [--project <App>]
  node translation-review.mjs chunk        --work <dir> [--size 270] [--scope all|open] [--force]
  node translation-review.mjs tm           --work <dir> [--lang <code>] "<phrase>" ...
  node translation-review.mjs join         --work <dir> --chunk <NN>
  node translation-review.mjs validate     --work <dir> --chunk <NN>
  node translation-review.mjs merge        --work <dir>
  node translation-review.mjs import       --work <dir> --xlsx <file> --project <App> [--g <file>] [--dry-run] [--allow-drop]`;

export class UsageError extends Error {}

/* ------------------------------------------------------------------ *
 * Arguments and files
 * ------------------------------------------------------------------ */

const FLAGS = new Set(['dry-run', 'force', 'allow-drop', 'full', 'separate-variants']);

export function parseArgs(argv) {
    const [command, ...rest] = argv;
    const opts = { _: [] };
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (!a.startsWith('--')) { opts._.push(a); continue; }
        const key = a.slice(2);
        if (FLAGS.has(key)) { opts[key] = true; continue; }
        const value = rest[i + 1];
        if (value === undefined || value.startsWith('--')) { throw new UsageError(`--${key} needs a value`); }
        opts[key] = value;
        i++;
    }
    return { command, opts };
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
const writeJson = (p, value, { compact = false } = {}) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(value, null, compact ? 0 : 1)}\n`, 'utf8');
};
const today = () => new Date().toISOString().slice(0, 10);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
const pad = (n) => String(n).padStart(2, '0');
const need = (opts, key) => {
    if (!opts[key]) { throw new UsageError(`--${key} is required`); }
    return opts[key];
};

/** The app.json, the generated .g.xlf and the target-language files of an AL project. */
export function projectFiles(project, gOverride) {
    const dir = resolve(project);
    const appJson = join(dir, 'app.json');
    if (!existsSync(appJson)) { throw new UsageError(`${dir} has no app.json — pass the AL project folder (App/ in the usual layout)`); }
    const app = readJson(appJson);
    const tdir = join(dir, 'Translations');
    let gFile = gOverride ? resolve(gOverride) : null;
    const files = existsSync(tdir) ? readdirSync(tdir).filter((f) => f.toLowerCase().endsWith('.xlf')) : [];
    if (!gFile) {
        const gs = files.filter((f) => f.toLowerCase().endsWith('.g.xlf'));
        if (gs.length !== 1) {
            throw new UsageError(`expected one .g.xlf in ${tdir}, found ${gs.length}. Compile the app with "features": ["TranslationFile"] in app.json, or pass --g`);
        }
        gFile = join(tdir, gs[0]);
    }
    if (!existsSync(gFile)) { throw new UsageError(`${gFile} does not exist`); }
    const targets = files.filter((f) => !f.toLowerCase().endsWith('.g.xlf')).map((f) => join(tdir, f));
    return { dir, app, tdir, gFile, targets };
}

const langOfFile = (path, parsed) => normLang(parsed.targetLanguage ?? /\.([A-Za-z]{2,3}-[A-Za-z]{2,4})\.xlf$/i.exec(path)?.[1] ?? 'xx');

function loadWork(opts, { review = false } = {}) {
    const dir = resolve(need(opts, 'work'));
    const snapPath = join(dir, 'snapshot.json');
    if (!existsSync(snapPath)) { throw new UsageError(`${dir} holds no snapshot — run snapshot first`); }
    const work = { dir, snapshot: readJson(snapPath), units: readJson(join(dir, 'units.json')) };
    work.langs = work.snapshot.langs;
    if (review) {
        const rp = join(dir, 'review.json');
        if (!existsSync(rp)) { throw new UsageError(`${dir} holds no review.json — run merge first`); }
        work.review = readJson(rp);
    }
    return work;
}

/* ------------------------------------------------------------------ *
 * Language variants — nl-BE and nl-NL, fr-BE and fr-FR share one tab
 * ------------------------------------------------------------------ */

/**
 * The groups of variants of one language in a round, lead first: one group per primary language with two or more
 * variants. The lead is the variant with the most standard-BC reference translations (the one the customer works in:
 * nl-BE in a Belgian project); on a tie -- a feature round whose strings have no reference -- the variant whose file
 * holds the most translations, then the first in the round. Only the lead is reviewed; the others follow its text.
 */
export function variantGroups(langs, units, translated = {}) {
    const byPrimary = new Map();
    for (const l of langs) {
        const k = l.split('-')[0].toLowerCase();
        if (!byPrimary.has(k)) { byPrimary.set(k, []); }
        byPrimary.get(k).push(l);
    }
    const ms = (l) => units.filter((u) => u.ref?.[l]?.ms).length;
    return [...byPrimary.values()].filter((m) => m.length > 1).map((members) => {
        const lead = [...members].sort((a, b) => ms(b) - ms(a) || (translated[b] ?? 0) - (translated[a] ?? 0) || members.indexOf(a) - members.indexOf(b))[0];
        return [lead, ...members.filter((l) => l !== lead)];
    });
}

/** The tabs of a workbook: one per language, or one per group of variants (`label` "nl-BE + nl-NL", lead first). */
export function tabsOf(work) {
    const groups = work.snapshot.variants ?? [];
    const tabs = [];
    for (const l of work.langs) {
        const members = groups.find((g) => g.includes(l)) ?? [l];
        if (tabs.some((t) => t.langs.includes(l))) { continue; }
        tabs.push({ label: members.join(' + '), lead: members[0], langs: members });
    }
    return tabs;
}

/** The languages the reviewers judge: one per tab, the lead of each group of variants. */
const reviewLangs = (work) => tabsOf(work).map((t) => t.lead);

/** The languages of a workbook tab: "nl-BE", or "nl-BE + nl-NL" for a group of variants; null when it is not a language tab. */
export function sheetLangs(name) {
    const parts = String(name).split('+').map((s) => s.trim());
    return parts.every((s) => LANG_SHEET.test(s)) ? parts.map(normLang) : null;
}

const FOLLOW_REASON = {
    nl: (lead) => `zelfde tekst als ${lead}`,
    fr: (lead) => `même texte que ${lead}`,
    de: (lead) => `gleicher Text wie ${lead}`,
    es: (lead) => `mismo texto que ${lead}`,
};
const followReason = (lang, lead) => (FOLLOW_REASON[lang.split('-')[0]] ?? ((l) => `same text as ${l}`))(lead);

/**
 * A variant's decision, from its lead's: the text the lead ends with. When the variant had the lead's old text, it
 * gets the lead's verdict and reason; without a translation it is new; with another text it is aligned (stijl).
 */
function followerDecision(u, lang, lead, dLead) {
    const text = finalFor(u, lead, dLead);
    const cur = u.langs[lang].cur;
    if (text === cur) { return { v: 'ok' }; }
    if (cur === null) { return { v: 'nieuw', p: text }; }
    if (cur === u.langs[lead].cur && dLead.v !== 'ok') { return { v: dLead.v, p: text, ...(dLead.r ? { r: dLead.r } : {}) }; }
    return { v: 'stijl', p: text, r: followReason(lang, lead) };
}

const SEVERITY = ['fout', 'twijfel', 'nieuw', 'stijl', 'ok'];

/** What a tab shows for a string: the most severe verdict of its languages, with that language's reason. */
function tabVerdict(tab, d) {
    return tab.langs.map((l) => d[l]).sort((a, b) => SEVERITY.indexOf(a.v) - SEVERITY.indexOf(b.v))[0];
}

/**
 * Gives every variant the term of its lead: one translation per term for the whole group. Returns what changed; an
 * entry with `from` overwrote a term the variant had (from an earlier round with --separate-variants, typically).
 */
function alignVariantTerms(glossary, work) {
    const changed = [];
    for (const tab of tabsOf(work)) {
        for (const t of glossary?.terms ?? []) {
            if (!t[tab.lead]) { continue; }
            for (const f of tab.langs.slice(1)) {
                if (t[f] !== t[tab.lead]) { changed.push({ key: t.key, lang: f, from: t[f] ?? null, to: t[tab.lead] }); t[f] = t[tab.lead]; }
            }
        }
    }
    return changed;
}
const overwritten = (aligned) => aligned.filter((a) => a.from !== null);

const loadReference = (dir) => (existsSync(join(dir, 'reference.json')) ? readJson(join(dir, 'reference.json')) : {});
const loadGlossary = (dir) => (existsSync(join(dir, 'glossary.json')) ? readJson(join(dir, 'glossary.json')) : null);

const glossaryFileOf = (projectDir) => join(resolve(projectDir), 'translation-glossary.json');

function readProjectGlossary(projectDir) {
    const path = glossaryFileOf(projectDir);
    if (!existsSync(path)) { return null; }
    try { return readJson(path); } catch { return null; }
}

/** The project glossary for a write: an unreadable file (a merge conflict, typically) stops the import, never gets overwritten. */
function projectGlossaryForWrite(projectDir) {
    const path = glossaryFileOf(projectDir);
    if (!existsSync(path)) { return null; }
    try { return readJson(path); } catch {
        throw new UsageError(`${path} is not valid JSON (a merge conflict?). Resolve it first, then import again: the import would overwrite its terms and the record of the last full round`);
    }
}

/**
 * Keeps the glossary in the customer repo, so the next round starts from the same terms, and records the last full
 * round (`lastFullRound`: date, commit, languages), so the next full round offers only what is still open. Unchanged
 * terms are not rewritten: a new date alone would make every feature PR conflict on this file. Returns the path, or
 * null when nothing changed.
 */
function writeProjectGlossary(projectDir, glossary, { fullRound = null } = {}) {
    if (!glossary && !fullRound) { return null; }
    const path = glossaryFileOf(projectDir);
    const existing = projectGlossaryForWrite(projectDir);
    const terms = glossary ? glossary.terms.map(({ origin, ...t }) => t) : existing?.terms ?? [];
    const last = fullRound
        ? { ...fullRound, langs: [...new Set([...(existing?.lastFullRound?.langs ?? []), ...fullRound.langs])].sort() }
        : existing?.lastFullRound ?? null;
    if (existing
        && JSON.stringify(existing.terms ?? null) === JSON.stringify(terms)
        && JSON.stringify(existing.lastFullRound ?? null) === JSON.stringify(last)) { return null; }
    writeJson(path, { schema: SCHEMA, updated: today(), ...(last ? { lastFullRound: last } : {}), terms });
    return path;
}

/* ------------------------------------------------------------------ *
 * Reference translations from the packages in .alpackages
 * ------------------------------------------------------------------ */

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/** Adds the source → target pairs of one package translation file to `map`. */
function addReferenceUnits(map, text, kind, wanted) {
    for (const m of text.matchAll(/<trans-unit\b[^>]*>([\s\S]*?)<\/trans-unit>/g)) {
        const sm = /<source>([\s\S]*?)<\/source>/.exec(m[1]);
        const tm = /<target\b([^>]*)>([\s\S]*?)<\/target>/.exec(m[1]);
        if (!sm || !tm) { continue; }
        if (/state="needs-translation"/.test(tm[1])) { continue; }
        const src = sm[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
        const tgt = tm[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
        if (!src.trim() || !tgt.trim() || tgt.startsWith('[NAB:')) { continue; }
        if (!wanted.has(src) && (src.length > SHORT || src.includes('\n'))) { continue; }
        let e = map.get(src);
        if (!e) { e = { ms: new Map(), other: new Map() }; map.set(src, e); }
        e[kind].set(tgt, (e[kind].get(tgt) ?? 0) + 1);
    }
}

/**
 * Reads the translation files of the requested languages from every .app in `packagesDir`.
 * A package whose file name starts with "Microsoft_" is standard BC; the rest are other apps.
 */
export function readReference(packagesDir, langs, wanted) {
    const maps = Object.fromEntries(langs.map((l) => [l, new Map()]));
    const read = [];
    if (!packagesDir || !existsSync(packagesDir)) { return { reference: {}, read }; }
    for (const f of readdirSync(packagesDir).filter((n) => n.toLowerCase().endsWith('.app')).sort()) {
        let zip;
        try { zip = readZip(readFileSync(join(packagesDir, f))); } catch { continue; }
        const kind = /^microsoft_/i.test(f) ? 'ms' : 'other';
        for (const name of zip.names()) {
            const m = /Translations\/[^/]*\.([A-Za-z]{2,3}-[A-Za-z]{2,4})\.xlf$/i.exec(safeDecode(name));
            if (!m) { continue; }
            const lang = langs.find((l) => l.toLowerCase() === m[1].toLowerCase());
            if (!lang) { continue; }
            addReferenceUnits(maps[lang], zip.text(name), kind, wanted);
            read.push({ package: f, lang, kind });
        }
    }
    const top = (counter) => [...counter.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
    const reference = {};
    for (const lang of langs) {
        reference[lang] = {};
        for (const [src, e] of maps[lang]) {
            const entry = {};
            if (e.ms.size) { entry.ms = top(e.ms); }
            if (e.other.size) { entry.other = top(e.other); }
            reference[lang][src] = entry;
        }
    }
    return { reference, read };
}

/* ------------------------------------------------------------------ *
 * snapshot
 * ------------------------------------------------------------------ */

function gitLabel(dir) {
    try { return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

/** The branch a folder is on ("HEAD" when detached) and the remote's default branch(es); null outside git. */
function branchOf(dir) {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    let branch;
    try { branch = git('rev-parse', '--abbrev-ref', 'HEAD'); } catch { return null; }
    let remoteDefault = null;
    try { remoteDefault = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, ''); } catch { /* origin/HEAD not set */ }
    return { branch, defaults: remoteDefault ? [remoteDefault] : ['master', 'main'] };
}

/**
 * The feature mode: the units of `g` whose id or English is not in `base` -- the .g.xlf of the commit where the
 * branch left master (the merge-base). Every other unit belongs to someone else's work. The scope holds Locked
 * (translate="no") units too, so the import adds them; the counts are of translatable units only.
 */
function featureScope(g, gFile, basePath) {
    if (!existsSync(basePath)) { throw new UsageError(`--base ${basePath} does not exist`); }
    if (basePath.toLowerCase() === resolve(gFile).toLowerCase()) {
        throw new UsageError('--base is the project\'s own .g.xlf — pass the .g.xlf of the merge-base with origin/master');
    }
    const base = parseXlf(readFileSync(basePath, 'utf8'));
    if (!base.units.length) { throw new UsageError(`${basePath} holds no trans-units — pass the .g.xlf of the merge-base with origin/master`); }
    if (base.original && g.original && base.original !== g.original) {
        throw new UsageError(`--base is the .g.xlf of "${base.original}", the project generates "${g.original}"`);
    }
    const baseSource = new Map(base.units.map((u) => [u.id, u.source]));
    const ids = g.units.filter((u) => baseSource.get(u.id) !== u.source).map((u) => u.id);
    const translatable = new Set(g.units.filter((u) => u.translate).map((u) => u.id));
    return {
        base,
        ids,
        added: ids.filter((id) => translatable.has(id) && !baseSource.has(id)).length,
        changed: ids.filter((id) => translatable.has(id) && baseSource.has(id)).length,
    };
}

export function commandSnapshot(opts) {
    const p = projectFiles(need(opts, 'project'), opts.g);
    const dir = resolve(opts.work ?? join(homedir(), 'Downloads', 'translation-review', `${slug(p.app.name)}-${today()}`));
    if (existsSync(join(dir, 'snapshot.json')) && !opts.force) {
        throw new UsageError(`${dir} already holds a snapshot — use a new --work folder, or --force to replace it`);
    }
    if (opts.base && opts.full) { throw new UsageError('--base (the feature mode) and --full (a round over the whole app) exclude each other'); }
    // A full round on a feature branch drags every other feature's strings into that branch.
    if (!opts.base && !opts.full) {
        const b = branchOf(p.dir);
        if (b && b.branch !== 'HEAD' && !b.defaults.includes(b.branch)) {
            throw new UsageError(`${p.dir} is on branch "${b.branch}", not on ${b.defaults.join(' or ')}. For the strings this branch adds or changes: pass --base with the .g.xlf of the merge-base with origin/master (the feature mode, SKILL.md step 1). A round over the whole app runs on a worktree of origin/master; --full only for a repository whose default branch is not ${b.defaults.join(' or ')}`);
        }
    }
    const g = parseXlf(readFileSync(p.gFile, 'utf8'));
    const feature = opts.base ? featureScope(g, p.gFile, resolve(opts.base)) : null;
    const inScope = feature ? new Set(feature.ids) : null;
    const targets = p.targets.map((path) => {
        const parsed = parseXlf(readFileSync(path, 'utf8'));
        return { path, parsed, lang: langOfFile(path, parsed) };
    });
    let langs = targets.map((t) => t.lang);
    if (opts.langs) {
        const want = opts.langs.split(',').map((s) => normLang(s.trim())).filter(Boolean);
        langs = langs.filter((l) => want.includes(l));
    }
    for (const extra of (opts['add-lang'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!langs.includes(normLang(extra))) { langs.push(normLang(extra)); }
    }
    if (!langs.length) { throw new UsageError(`no target language: ${p.tdir} has no translation file — pass --add-lang <code>`); }
    if (feature) {
        const missing = langs.filter((l) => !targets.find((t) => t.lang === l)?.parsed.units.length);
        if (missing.length) { throw new UsageError(`the feature mode adds to existing translation files, and ${missing.join(', ')} has none with units in ${p.tdir} — a new language is a round over the whole app`); }
    }

    const byLang = Object.fromEntries(langs.map((l) => [l, new Map((targets.find((t) => t.lang === l)?.parsed.units ?? []).map((u) => [u.id, u]))]));
    const units = [];
    for (const u of g.units) {
        if (!u.translate || (inScope && !inScope.has(u.id))) { continue; }
        const note = u.notes['Xliff Generator'] ?? '';
        const unit = { id: u.id, src: u.source, note, obj: note.split(' - ')[0], cat: categoryOf(note) };
        if (u.notes.Developer) { unit.dev = u.notes.Developer; }
        if (u.maxwidth) { unit.maxw = u.maxwidth; }
        const ph = placeholdersOf(u.source);
        if (ph.length) { unit.ph = ph; }
        unit.langs = {};
        for (const lang of langs) {
            const t = byLang[lang].get(u.id);
            const x = t ? { cur: t.target, st: t.state ?? (t.target === null ? 'needs-translation' : 'translated') } : { cur: null, st: 'missing' };
            if (t && t.source !== u.source) { x.oldsrc = t.source; }
            unit.langs[lang] = x;
        }
        units.push(unit);
    }
    if (feature && !units.some((u) => !isBlank(u.src))) {
        throw new UsageError(`this branch adds or changes no translatable string compared to ${resolve(opts.base)} — nothing to review. Check that the branch was compiled and that --base comes from the merge-base with origin/master`);
    }

    const packages = opts.packages ? resolve(opts.packages) : join(p.dir, '.alpackages');
    const { reference, read } = readReference(packages, langs, new Set(units.map((u) => u.src)));
    for (const unit of units) {
        unit.ref = {};
        for (const lang of langs) {
            const r = reference[lang]?.[unit.src];
            if (r) { unit.ref[lang] = { ...(r.ms ? { ms: r.ms[0][0] } : {}), ...(r.other ? { other: r.other[0][0] } : {}) }; }
        }
    }

    const snapshot = {
        schema: SCHEMA,
        created: new Date().toISOString(),
        app: { name: p.app.name, id: p.app.id, version: p.app.version },
        project: p.dir,
        gFile: p.gFile,
        commit: opts.commit ?? gitLabel(p.dir),
        langs,
        files: Object.fromEntries(langs.map((l) => [l, targets.find((t) => t.lang === l)?.path ?? null])),
        packages: { dir: existsSync(packages) ? packages : null, read },
    };
    // Variants of one language share a tab and one review, unless the round keeps them apart.
    const translated = Object.fromEntries(langs.map((l) => [l, [...byLang[l].values()].filter((t) => t.target).length]));
    const variants = opts['separate-variants'] ? [] : variantGroups(langs, units, translated);
    if (variants.length) { snapshot.variants = variants; }
    // The base goes into the work folder: the import needs it after the worktree is gone.
    if (feature) { snapshot.feature = { base: resolve(opts.base), added: feature.added, changed: feature.changed, ids: feature.ids }; }
    // A full round after an earlier one: chunk then takes only what is still open (see openLangs).
    const previous = feature ? null : readProjectGlossary(p.dir)?.lastFullRound;
    if (previous?.langs?.length) { snapshot.previousFullRound = previous; }
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'snapshot.json'), snapshot);
    writeJson(join(dir, 'units.json'), units);
    writeJson(join(dir, 'reference.json'), reference, { compact: true });
    if (feature) { writeFileSync(join(dir, BASE_COPY), feature.base.text, 'utf8'); } else { rmSync(join(dir, BASE_COPY), { force: true }); }

    const gIds = new Set(g.units.map((u) => u.id));
    const perLang = {};
    for (const lang of langs) {
        const states = {};
        let stale = 0;
        let refMatches = 0;
        for (const u of units) {
            states[u.langs[lang].st] = (states[u.langs[lang].st] ?? 0) + 1;
            if (u.langs[lang].oldsrc !== undefined) { stale++; }
            if (u.ref[lang]) { refMatches++; }
        }
        perLang[lang] = { file: snapshot.files[lang], states, stale, refMatches };
    }
    return {
        status: 'snapshot',
        mode: feature ? 'feature' : 'full',
        ...(feature ? { feature: { base: snapshot.feature.base, added: feature.added, changed: feature.changed, outside: g.units.filter((u) => u.translate && !inScope.has(u.id)).length } } : {}),
        ...(snapshot.previousFullRound ? { previousFullRound: snapshot.previousFullRound, open: Object.fromEntries(langs.map((l) => [l, units.filter((u) => !isBlank(u.src) && openLangs(u, langs, snapshot).includes(l)).length])) } : {}),
        work: dir,
        app: snapshot.app.name,
        commit: snapshot.commit,
        units: units.length,
        objects: new Set(units.map((u) => u.obj)).size,
        categories: units.reduce((a, u) => ({ ...a, [u.cat]: (a[u.cat] ?? 0) + 1 }), {}),
        langs: perLang,
        variants: variants.map(([lead, ...follow]) => ({ lead, follow })),
        referencePackages: read.length,
        orphans: Object.fromEntries(langs.map((l) => [l, [...byLang[l].keys()].filter((id) => !gIds.has(id)).length])),
    };
}

/* ------------------------------------------------------------------ *
 * terms — the glossary
 * ------------------------------------------------------------------ */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const termPhrases = (term) => (term.match?.length ? term.match : [term.en]);
export const termRegex = (term) => new RegExp(termPhrases(term).map((p) => `(?<![\\w-])${escapeRe(p)}(?![\\w-])`).join('|'), 'i');

const STOP = new Set('a an and are as at be by can cannot do does for from has have if in into is it its no not of on or per than that the this to was when which will with without you your'.split(' '));

/** The reference translation of a phrase: exact, then in another capitalisation. */
function referenceFor(reference, lang, phrase) {
    const r = reference[lang] ?? {};
    const variants = [phrase, phrase.toLowerCase(), phrase.charAt(0).toUpperCase() + phrase.slice(1).toLowerCase(), phrase.replace(/\b\w/g, (c) => c.toUpperCase())];
    for (const v of variants) {
        if (r[v]) { return { ms: r[v].ms?.[0]?.[0] ?? null, other: r[v].other?.[0]?.[0] ?? null }; }
    }
    return { ms: null, other: null };
}

export function commandTerms(opts) {
    const work = loadWork(opts);
    const reference = loadReference(work.dir);
    const glossaryPath = join(work.dir, 'glossary.json');
    const projectGlossaryPath = join(work.snapshot.project, 'translation-glossary.json');
    const base = readJson(join(SKILL_DIR, 'references', 'glossary.base.json')).terms;
    const project = existsSync(projectGlossaryPath) ? readJson(projectGlossaryPath).terms ?? [] : [];
    const countOf = (term) => {
        const re = termRegex(term);
        return work.units.filter((u) => re.test(u.src)).length;
    };

    let seeded = false;
    if (!existsSync(glossaryPath)) {
        const terms = project.map((t) => ({ ...t, origin: 'project' }));
        for (const t of base) {
            if (terms.some((x) => x.key === t.key)) { continue; }
            if (countOf(t) > 0) { terms.push({ ...t, origin: 'base' }); }
        }
        writeJson(glossaryPath, { schema: SCHEMA, langs: work.langs, terms });
        seeded = true;
    }
    const glossary = readJson(glossaryPath);
    // Variants share one term: what the lead says, the others say too.
    const aligned = alignVariantTerms(glossary, work);
    if (aligned.length) { writeJson(glossaryPath, glossary); }
    const covered = glossary.terms.flatMap(termPhrases).map((s) => s.toLowerCase());

    const counts = new Map();
    for (const u of work.units) {
        if (!['veld', 'enum', 'actie', 'caption'].includes(u.cat)) { continue; }
        const words = u.src.match(/[A-Za-z][A-Za-z.'-]*/g) ?? [];
        const seen = new Set();
        for (let n = 1; n <= 3; n++) {
            for (let i = 0; i + n <= words.length; i++) {
                const gram = words.slice(i, i + n);
                if (STOP.has(gram[0].toLowerCase()) || STOP.has(gram.at(-1).toLowerCase())) { continue; }
                const phrase = gram.join(' ');
                if (phrase.length < 3 || seen.has(phrase.toLowerCase())) { continue; }
                seen.add(phrase.toLowerCase());
                counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
            }
        }
    }
    const top = Number(opts.top ?? 120);
    const candidates = [...counts.entries()]
        .filter(([phrase, n]) => n >= 3 && !covered.includes(phrase.toLowerCase()))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, top)
        .map(([phrase, n]) => ({ en: phrase, count: n, ref: Object.fromEntries(work.langs.map((l) => [l, referenceFor(reference, l, phrase)])) }));

    return {
        status: 'terms',
        glossary: glossaryPath,
        seeded,
        projectGlossary: existsSync(projectGlossaryPath) ? projectGlossaryPath : null,
        alignedVariants: overwritten(aligned),
        terms: glossary.terms.map((t) => ({ key: t.key, en: t.en, count: countOf(t), ...Object.fromEntries(work.langs.map((l) => [l, t[l] ?? null])) })),
        candidates,
    };
}

/* ------------------------------------------------------------------ *
 * export — the workbooks
 * ------------------------------------------------------------------ */

const UITLEG = {
    terms: [
        ['Vertalingen nakijken - termen', STYLE.title],
        ['Dit bestand bevat de kernbegrippen van de app met onze voorgestelde vertaling. Wat u hier kiest, passen we daarna toe op alle teksten.', undefined, 'nl'],
        ['Pas alleen de gele kolommen aan: Definitief per taal, en Opmerking. Definitief bevat al ons voorstel: laat het staan als het klopt, overschrijf het als het anders moet.'],
        ['Standaard BC en Andere apps tonen hoe Business Central en de andere apps hetzelfde begrip vertalen. Wijkt u daarvan af, dan ziet de gebruiker op hetzelfde scherm twee woorden voor hetzelfde.'],
        ['Sorteren en filteren mag. Verwijder geen rijen of kolommen en wijzig de kolom Engels niet.'],
        [''],
        ['Vérification des traductions - termes', STYLE.title],
        ["Ce fichier contient les termes clés de l'application avec notre proposition de traduction. Ce que vous choisissez ici sera ensuite appliqué à tous les textes.", undefined, 'fr'],
        ['Modifiez uniquement les colonnes jaunes : Definitief par langue, et Opmerking (remarque). Definitief contient déjà notre proposition : laissez-la si elle est correcte, remplacez-la si elle doit changer.'],
        ["Standaard BC et Andere apps montrent comment Business Central et les autres applications traduisent le même terme. Si vous vous en écartez, l'utilisateur verra deux mots pour la même chose sur le même écran."],
        ['Vous pouvez trier et filtrer. Ne supprimez ni lignes ni colonnes et ne modifiez pas la colonne Engels.'],
        [''],
        ['Translation review - terms', STYLE.title],
        ['This file holds the key terms of the app with our proposed translation. What you choose here is then applied to every text.', undefined, 'en'],
        ['Only change the yellow columns: Definitief per language, and Opmerking (remarks). Definitief already holds our proposal: leave it when it is right, overwrite it when it must change.'],
        ['Standaard BC and Andere apps show how Business Central and the other apps translate the same term. If you deviate, users see two words for the same thing on one screen.'],
        ['Sorting and filtering are fine. Do not delete rows or columns, and do not change the Engels column.'],
    ],
    texts: [
        ['Vertalingen nakijken - teksten', STYLE.title],
        ['Dit bestand bevat de vertaalbare teksten van de app, met een tabblad per taal.', undefined, 'nl'],
        ['Pas alleen de gele kolommen aan: Definitief en Opmerking. Definitief bevat al ons voorstel; een rij die u niet aanpast, nemen we over zoals ze er staat. Alleen Definitief wordt overgenomen: een opmerking verandert zelf geen tekst.'],
        ['Begin met de filter Focus = Ja: alles wat wij fout of twijfelachtig vinden, en nieuwe teksten op het scherm.'],
        ['Laat %1, %2 ... staan: daar vult Business Central een waarde in. Een backslash (\\) is een nieuwe regel.'],
        ['Oordeel: fout = de huidige vertaling is fout - twijfel = alleen u kunt beslissen - nieuw = er was nog geen vertaling - stijl = kleine correctie, nakijken hoeft niet - ok = goed zoals het is.'],
        ['Sorteren en filteren mag. Verwijder geen rijen of kolommen en wijzig de kolom Engels niet.'],
        ['Het tabblad Termen toont de vertaling van de kernbegrippen die we overal gebruiken. Het is ter informatie: wat u daar typt, wordt niet overgenomen.'],
        ['Niet akkoord met een term? Pas Definitief aan in elke rij waarin hij voorkomt (filter de kolom Definitief op "bevat") en zet in de kolom Opmerking van één van die rijen welke term het moet zijn. Dan gebruiken we die term ook in volgende rondes.'],
        [''],
        ['Vérification des traductions - textes', STYLE.title],
        ["Ce fichier contient les textes traduisibles de l'application, avec un onglet par langue.", undefined, 'fr'],
        ['Modifiez uniquement les colonnes jaunes : Definitief et Opmerking (remarque). Definitief contient déjà notre proposition ; une ligne que vous ne modifiez pas est reprise telle quelle. Seule la colonne Definitief est reprise : une remarque ne modifie aucun texte.'],
        ['Commencez par le filtre Focus = Ja : tout ce que nous jugeons faux ou douteux, et les nouveaux textes à l\'écran.'],
        ['Laissez %1, %2 ... en place : Business Central y insère une valeur. Une barre oblique inverse (\\) est un saut de ligne.'],
        ['Oordeel : fout = la traduction actuelle est incorrecte - twijfel = à décider par vous - nieuw = pas encore traduit - stijl = petite correction, pas besoin de vérifier - ok = correct tel quel.'],
        ['Vous pouvez trier et filtrer. Ne supprimez ni lignes ni colonnes et ne modifiez pas la colonne Engels.'],
        ["L'onglet Termen montre la traduction des termes clés utilisée partout. Il sert d'information : ce que vous y tapez n'est pas repris."],
        ["Pas d'accord avec un terme ? Modifiez Definitief dans chaque ligne où il apparaît (filtrez la colonne Definitief sur « contient ») et indiquez dans la colonne Opmerking d'une de ces lignes le terme à utiliser. Nous l'utiliserons aussi lors des prochaines vérifications."],
        [''],
        ['Translation review - texts', STYLE.title],
        ['This file holds the translatable texts of the app, with one tab per language.', undefined, 'en'],
        ['Only change the yellow columns: Definitief and Opmerking (remarks). Definitief already holds our proposal; a row you leave untouched is taken as it stands. Only Definitief is imported: a remark changes no text by itself.'],
        ['Start with the filter Focus = Ja: everything we consider wrong or doubtful, and new texts on screen.'],
        ['Leave %1, %2 ... in place: Business Central fills in a value there. A backslash (\\) is a line break.'],
        ['Oordeel: fout = the current translation is wrong - twijfel = only you can decide - nieuw = not translated yet - stijl = small correction, no need to check - ok = right as it is.'],
        ['Sorting and filtering are fine. Do not delete rows or columns, and do not change the Engels column.'],
        ['The Termen tab shows the translation of the key terms used throughout. It is for information: nothing you type there is imported.'],
        ['Disagree with a term? Change Definitief in every row where it appears (filter the Definitief column on "contains") and say in the Opmerking column of one of those rows which term it should be. We then use that term in later rounds too.'],
    ],
};

const VARIANTS_LINE = {
    nl: (labels) => `Varianten van dezelfde taal staan samen (${labels}): de tekst die u kiest, gebruiken we voor elk van die talen.`,
    fr: (labels) => `Les variantes d'une même langue sont regroupées (${labels}) : le texte que vous choisissez vaut pour chacune de ces langues.`,
    en: (labels) => `Variants of the same language are grouped (${labels}): the text you choose is used for each of those languages.`,
};

/** The explanation sheet; with variants of a language in the round, each language block says they are grouped. */
const uitlegSheet = (round, tabs = []) => {
    const labels = tabs.filter((t) => t.langs.length > 1).map((t) => t.label).join('; ');
    return {
        name: 'Uitleg',
        columns: [{ width: 130, style: STYLE.text }],
        rows: UITLEG[round].flatMap(([text, style, variants]) => [
            [{ v: text, s: style ?? STYLE.text }],
            ...(variants && labels ? [[{ v: VARIANTS_LINE[variants](labels), s: STYLE.text }]] : []),
        ]),
    };
};

const metaSheet = (work, round) => ({
    name: '_meta',
    hidden: true,
    columns: [{ width: 14 }, { width: 40 }],
    rows: [
        ['schema', String(SCHEMA)],
        ['round', round],
        ['app', work.snapshot.app.name],
        ['snapshot', work.snapshot.commit ?? ''],
        ['scope', work.snapshot.feature ? 'feature' : 'full'],
        ['created', today()],
        ['languages', work.langs.join(',')],
        ['tabs', tabsOf(work).map((t) => t.label).join('; ')],
    ],
});

/** The text a unit ends with in a language: the current translation when ok, else the proposal. */
const finalFor = (unit, lang, d) => (d.v === 'ok' ? unit.langs[lang].cur : d.p);

const verdictStyle = (v) => STYLE[v] ?? STYLE.text;

export function commandExport(opts) {
    const round = need(opts, 'round');
    if (!['terms', 'texts'].includes(round)) { throw new UsageError('--round is terms or texts'); }
    const work = loadWork(opts, { review: round === 'texts' });
    if (work.review && work.review.snapshot !== work.snapshot.created) {
        throw new UsageError('review.json belongs to another snapshot of this folder — run chunk, the review and merge again');
    }
    const glossary = loadGlossary(work.dir);
    if (round === 'terms' && !glossary) { throw new UsageError(`${work.dir} holds no glossary.json — run terms first`); }
    const reference = loadReference(work.dir);
    const langs = work.langs;
    // One tab (and one Definitief) per language, or per group of variants: the customer decides a text once.
    const tabs = tabsOf(work);
    const sheets = [uitlegSheet(round, tabs)];

    const countOf = (term) => {
        const re = termRegex(term);
        return work.units.filter((u) => re.test(u.src)).length;
    };

    if (round === 'terms') {
        const header = ['Sleutel', 'Engels', 'Aantal teksten', 'Toelichting', ...tabs.flatMap(({ label }) => [`Standaard BC ${label}`, `Andere apps ${label}`, `Voorstel ${label}`, `Definitief ${label}`]), 'Opmerking'];
        const columns = [{ width: 14, hidden: true }, { width: 26 }, { width: 9 }, { width: 40 }, ...tabs.flatMap(() => [{ width: 20 }, { width: 20 }, { width: 22 }, { width: 22, style: STYLE.edit }]), { width: 30, style: STYLE.edit }];
        const rows = [header.map((h) => ({ v: h, s: STYLE.header }))];
        const terms = [...glossary.terms].map((t) => ({ t, n: countOf(t) })).sort((a, b) => b.n - a.n || a.t.en.localeCompare(b.t.en));
        for (const { t, n } of terms) {
            // A group shows the reference of its lead, else of the first variant that has one.
            const refs = tabs.map((tab) => {
                const all = tab.langs.map((l) => referenceFor(reference, l, termPhrases(t)[0]));
                return { ms: all.find((r) => r.ms)?.ms ?? null, other: all.find((r) => r.other)?.other ?? null };
            });
            rows.push([t.key, t.en, String(n), t.note ?? '', ...tabs.flatMap((tab, i) => [refs[i].ms ?? '', refs[i].other ?? '', t[tab.lead] ?? '', t[tab.lead] ?? '']), '']);
        }
        sheets.push({ name: 'Termen', columns, rows, freeze: { columns: 2, rows: 1 }, autoFilter: true });
    } else {
        // A round over what is still open shows per tab only the strings open in one of its languages, and only the
        // terms those strings use: what the customer confirmed before does not come back.
        const openOnly = work.review.scope === 'open';
        const shown = (u, tab) => Boolean(work.review.units[u.id]?.[tab.lead]) && !isBlank(u.src)
            && (!openOnly || openLangs(u, langs, work.snapshot).some((l) => tab.langs.includes(l)));
        if (glossary) {
            const srcs = work.units.filter((u) => tabs.some((t) => shown(u, t))).map((u) => u.src);
            const terms = openOnly ? glossary.terms.filter((t) => { const re = termRegex(t); return srcs.some((s) => re.test(s)); }) : glossary.terms;
            const rows = [['Sleutel', 'Engels', ...tabs.map((t) => t.label), 'Toelichting'].map((h) => ({ v: h, s: STYLE.header }))];
            for (const t of terms) { rows.push([t.key, t.en, ...tabs.map((tab) => t[tab.lead] ?? ''), t.note ?? '']); }
            sheets.push({ name: 'Termen', columns: [{ width: 14, hidden: true }, { width: 26 }, ...tabs.map(() => ({ width: 26 })), { width: 50 }], rows, freeze: { columns: 2, rows: 1 }, autoFilter: true });
        }
        const refTextOf = (u, l) => { const ref = u.ref?.[l]; return ref?.ms ? `BC: ${ref.ms}` : ref?.other ? `App: ${ref.other}` : ''; };
        for (const tab of tabs) {
            const group = tab.langs.length > 1;
            // A group shows the current text of every variant, so the customer sees where they differ today.
            const header = ['Sleutel', 'Waar', 'Engels', ...(group ? tab.langs.map((l) => `Huidig ${l}`) : ['Huidig']), 'Referentie', 'Oordeel', 'Reden', 'Focus', 'Definitief', 'Opmerking'];
            const columns = [{ width: 18, hidden: true }, { width: 36 }, { width: 36 }, ...tab.langs.map(() => ({ width: 36 })), { width: 24 }, { width: 10 }, { width: 40 }, { width: 8 }, { width: 36, style: STYLE.edit }, { width: 30, style: STYLE.edit }];
            const rows = [header.map((h) => ({ v: h, s: STYLE.header }))];
            for (const u of work.units) {
                if (!shown(u, tab)) { continue; }
                const d = work.review.units[u.id];
                const refs = tab.langs.map((l) => [l, refTextOf(u, l)]).filter(([, t]) => t);
                const refText = new Set(refs.map(([, t]) => t)).size > 1 ? refs.map(([l, t]) => `${l} ${t}`).join(' | ') : refs[0]?.[1] ?? '';
                // Each variant has its decision (merge derives the followers'); the tab shows the most severe one.
                const v = group && tab.langs.every((l) => d[l]) ? tabVerdict(tab, d) : d[tab.lead];
                rows.push([u.id, readableContext(u.note), u.src, ...tab.langs.map((l) => u.langs[l].cur ?? ''), refText, { v: v.v, s: verdictStyle(v.v) }, v.r ?? '', isFocus(u.cat, v.v) ? 'Ja' : 'Nee', finalFor(u, tab.lead, d[tab.lead]) ?? '', '']);
            }
            sheets.push({ name: tab.label, columns, rows, freeze: { columns: 3, rows: 1 }, autoFilter: true });
        }
    }
    sheets.push(metaSheet(work, round));

    const out = resolve(opts.out ?? join(work.dir, `${slug(work.snapshot.app.name)}-${round === 'terms' ? 'termen' : 'teksten'}.xlsx`));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, writeWorkbook(sheets));
    return { status: 'exported', round, file: out, sheets: sheets.filter((s) => !s.hidden).map((s) => ({ name: s.name, rows: s.rows.length - 1 })) };
}

/* ------------------------------------------------------------------ *
 * Reading a workbook back
 * ------------------------------------------------------------------ */

function metaOf(sheets) {
    const meta = sheets.find((s) => s.name === '_meta');
    return meta ? Object.fromEntries(meta.rows.filter((r) => r?.[0]).map((r) => [r[0].v, r[1]?.v ?? ''])) : null;
}

/** Rows of a sheet as objects keyed by header, with the 1-based row number. */
function recordsOf(sheet) {
    const [head = [], ...rows] = sheet.rows;
    const names = head.map((c) => (c?.v ?? '').trim());
    return rows.map((row, i) => {
        const rec = { _row: i + 2 };
        names.forEach((n, c) => { if (n) { rec[n] = row?.[c] ?? null; } });
        return rec;
    }).filter((rec) => Object.entries(rec).some(([k, v]) => k !== '_row' && v && v.v !== ''));
}

const cellText = (cell) => (cell ? String(cell.v).replace(/\r\n/g, '\n') : '');

/** Stops when a column the import reads was renamed or deleted in the workbook. */
function requireColumns(sheet, names) {
    const head = (sheet.rows[0] ?? []).map((c) => (c?.v ?? '').trim());
    const missing = names.filter((n) => !head.includes(n));
    if (missing.length) {
        throw new UsageError(`sheet "${sheet.name}" lacks the column(s) ${missing.join(', ')} — the headers of the workbook must stay as exported`);
    }
}

export function commandImportTerms(opts) {
    const work = loadWork(opts);
    const glossaryPath = join(work.dir, 'glossary.json');
    if (!existsSync(glossaryPath)) { throw new UsageError(`${work.dir} holds no glossary.json`); }
    const glossary = readJson(glossaryPath);
    const sheets = readWorkbook(readFileSync(resolve(need(opts, 'xlsx'))));
    const meta = metaOf(sheets);
    if (meta && meta.round !== 'terms') { throw new UsageError(`this workbook is round "${meta.round}", not the terms round`); }
    const sheet = sheets.find((s) => s.name === 'Termen');
    if (!sheet) { throw new UsageError('the workbook has no Termen sheet'); }
    const tabs = tabsOf(work);
    requireColumns(sheet, ['Sleutel', 'Engels', ...tabs.map((t) => `Definitief ${t.label}`)]);

    const changed = [];
    const unknown = [];
    const remarks = [];
    let kept = 0;
    for (const rec of recordsOf(sheet)) {
        const key = cellText(rec.Sleutel).trim();
        const term = glossary.terms.find((t) => t.key === key);
        if (!term) { unknown.push({ row: rec._row, key, en: cellText(rec.Engels) }); continue; }
        // A group of variants has one column: its term goes to every variant.
        for (const tab of tabs) {
            const value = cellText(rec[`Definitief ${tab.label}`]).trim();
            for (const lang of tab.langs) {
                if (!value || value === (term[lang] ?? '')) { kept++; continue; }
                changed.push({ key, en: term.en, lang, from: term[lang] ?? null, to: value });
                term[lang] = value;
            }
        }
        const remark = cellText(rec.Opmerking).trim();
        if (remark) { remarks.push({ key, en: term.en, remark }); }
        term.decided = today();
    }
    // An unreadable project glossary stops here, before the work glossary takes the customer's terms.
    if (opts.project) { projectGlossaryForWrite(opts.project); }
    writeJson(glossaryPath, glossary);
    const projectGlossary = opts.project ? writeProjectGlossary(opts.project, glossary) : null;
    return { status: 'terms-imported', glossary: glossaryPath, projectGlossary, kept, changed, unknown, remarks };
}

/* ------------------------------------------------------------------ *
 * chunk / tm / join / validate — the AI review
 * ------------------------------------------------------------------ */

const reviewDir = (work) => join(work.dir, 'review');

/**
 * The languages in which a string is still open: no translation, its English changed since, or a state that is not
 * finished. A language the last full round did not cover is open throughout: its translations were never offered.
 */
function openLangs(u, langs, snapshot) {
    const covered = snapshot.previousFullRound?.langs;
    return langs.filter((l) => {
        if (covered && !covered.includes(l)) { return true; }
        const x = u.langs[l];
        return x.cur === null || x.oldsrc !== undefined || !DONE_STATES.has(x.st);
    });
}

export function commandChunk(opts) {
    const work = loadWork(opts);
    const size = Number(opts.size ?? DEFAULT_CHUNK);
    // After a full round the next one offers only what is still open: what the customer confirmed does not come back.
    const scope = opts.scope ?? (work.snapshot.previousFullRound ? 'open' : 'all');
    if (!['all', 'open'].includes(scope)) { throw new UsageError('--scope is all or open'); }
    const dir = reviewDir(work);
    if (existsSync(dir)) {
        const old = readdirSync(dir).filter((f) => /^(in|out)-\d+\.json$|^tmp-\d+$/.test(f));
        if (old.some((f) => f.startsWith('out-')) && !opts.force) {
            throw new UsageError(`${dir} already holds review results — merge them, or pass --force to start the review over`);
        }
        for (const f of old) { rmSync(join(dir, f), { recursive: true, force: true }); }
    }
    mkdirSync(dir, { recursive: true });

    writeJson(join(dir, 'chunk.json'), { snapshot: work.snapshot.created, scope });
    const selected = work.units.filter((u) => !isBlank(u.src) && (scope === 'all' || openLangs(u, work.langs, work.snapshot).length));
    const groups = new Map();
    for (const u of selected) {
        if (!groups.has(u.obj)) { groups.set(u.obj, []); }
        groups.get(u.obj).push(u);
    }
    const chunks = [[]];
    for (const list of groups.values()) {
        if (chunks.at(-1).length && chunks.at(-1).length + list.length > size) { chunks.push([]); }
        chunks.at(-1).push(...list);
    }
    if (!chunks.at(-1).length) { chunks.pop(); }

    const slim = (u) => {
        const r = { id: u.id, src: u.src, ctx: u.note, cat: u.cat };
        if (u.dev) { r.dev = u.dev; }
        if (u.maxw) { r.maxw = u.maxw; }
        if (u.ph) { r.ph = u.ph; }
        // The reviewers judge the lead of each group of variants; the variants that follow its text come along as
        // `var`, so the proposal can suit them too.
        for (const tab of tabsOf(work)) {
            const lang = tab.lead;
            const x = u.langs[lang];
            const c = { cur: x.cur, st: x.st };
            if (x.oldsrc !== undefined) { c.oldsrc = x.oldsrc; }
            if (u.ref?.[lang]?.ms) { c.ms = u.ref[lang].ms; }
            if (u.ref?.[lang]?.other) { c.other = u.ref[lang].other; }
            if (tab.langs.length > 1) {
                c.var = Object.fromEntries(tab.langs.slice(1).map((f) => [f, { cur: u.langs[f].cur, ...(u.ref?.[f]?.ms ? { ms: u.ref[f].ms } : {}) }]));
            }
            r[lang] = c;
        }
        return r;
    };
    const list = chunks.map((c, i) => {
        const nn = pad(i + 1);
        writeFileSync(join(dir, `in-${nn}.json`), `[\n${c.map((u) => JSON.stringify(slim(u))).join(',\n')}\n]\n`, 'utf8');
        return { chunk: nn, units: c.length, from: c[0].obj, to: c.at(-1).obj };
    });
    return {
        status: 'chunked',
        scope,
        ...(work.snapshot.previousFullRound ? { previousFullRound: work.snapshot.previousFullRound } : {}),
        langs: reviewLangs(work),
        ...(work.snapshot.variants ? { variants: work.snapshot.variants.map(([lead, ...follow]) => ({ lead, follow })) } : {}),
        units: selected.length,
        chunks: list,
        dir,
    };
}

export function commandTm(opts) {
    const work = loadWork(opts);
    const reference = loadReference(work.dir);
    const langs = opts.lang ? [normLang(opts.lang)] : work.langs;
    if (!opts._.length) { throw new UsageError('tm needs at least one phrase'); }
    const lines = [];
    const fmt = (e) => [e.ms ? `BC: ${e.ms.map((x) => x[0]).join(' | ')}` : null, e.other ? `apps: ${e.other.map((x) => x[0]).join(' | ')}` : null].filter(Boolean).join('  ;  ');
    for (const phrase of opts._) {
        const rx = new RegExp(`(?<![\\w])${escapeRe(phrase)}(?![\\w])`, 'i');
        for (const lang of langs) {
            const entries = Object.entries(reference[lang] ?? {});
            const exact = entries.filter(([src]) => src.toLowerCase() === phrase.toLowerCase());
            const part = entries.filter(([src]) => src.toLowerCase() !== phrase.toLowerCase() && rx.test(src))
                .sort((a, b) => (b[1].ms ? 1 : 0) - (a[1].ms ? 1 : 0) || a[0].length - b[0].length)
                .slice(0, 12);
            lines.push(`=== ${phrase} [${lang}]`);
            for (const [src, e] of exact) { lines.push(`  EXACT [${src}]  ${fmt(e)}`); }
            for (const [src, e] of part) { lines.push(`  [${src}]  ${fmt(e)}`); }
            if (!exact.length && !part.length) { lines.push('  (no match)'); }
        }
    }
    return lines.join('\n');
}

export function commandJoin(opts) {
    const work = loadWork(opts);
    const nn = pad(Number(need(opts, 'chunk')));
    const tmp = join(reviewDir(work), `tmp-${nn}`);
    if (!existsSync(tmp)) { throw new UsageError(`${tmp} does not exist — write the part files there first`); }
    const parts = readdirSync(tmp).filter((f) => /^part-.*\.json$/.test(f)).sort();
    const rows = parts.flatMap((f) => readJson(join(tmp, f)));
    const out = join(reviewDir(work), `out-${nn}.json`);
    writeFileSync(out, `[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]\n`, 'utf8');
    return { status: 'joined', chunk: nn, parts: parts.length, rows: rows.length, file: out };
}

/** Every problem of a reviewer's output against its input chunk; [] = valid. */
export function validateRows(inUnits, outRows, langs) {
    const byId = new Map(inUnits.map((u) => [u.id, u]));
    const problems = [];
    const seen = new Set();
    for (const r of outRows) {
        const u = byId.get(r?.id);
        if (!u) { problems.push(`unknown id: ${r?.id}`); continue; }
        if (seen.has(u.id)) { problems.push(`duplicate id: ${u.id}`); }
        seen.add(u.id);
        if (r.dev !== undefined && typeof r.dev !== 'string') { problems.push(`${u.id} dev must be a string`); }
        for (const lang of langs) {
            const x = r[lang];
            if (!x || typeof x !== 'object') { problems.push(`${u.id} [${lang}] missing`); continue; }
            if (!VERDICTS.includes(x.v)) { problems.push(`${u.id} [${lang}] verdict ${JSON.stringify(x.v)} is not one of ${VERDICTS.join(', ')}`); continue; }
            const cur = u[lang]?.cur ?? null;
            if (x.v === 'ok') {
                if (!cur) { problems.push(`${u.id} [${lang}] ok, but there is no current translation — use nieuw`); continue; }
                if (x.p !== undefined && x.p !== cur) { problems.push(`${u.id} [${lang}] ok must not carry a different proposal — use stijl or fout`); }
                for (const p of problemsOf({ src: u.src, note: u.ctx, maxw: u.maxw }, cur)) { problems.push(`${u.id} [${lang}] ok, but the current translation is broken (${p}) — use fout`); }
                continue;
            }
            if (typeof x.p !== 'string' || !x.p.trim()) { problems.push(`${u.id} [${lang}] ${x.v} needs a proposal p`); continue; }
            if (['fout', 'twijfel', 'stijl'].includes(x.v) && !(typeof x.r === 'string' && x.r.trim())) { problems.push(`${u.id} [${lang}] ${x.v} needs a reason r`); }
            if (x.v !== 'nieuw' && cur !== null && x.p === cur) { problems.push(`${u.id} [${lang}] ${x.v}, but the proposal equals the current translation — use ok`); }
            for (const p of problemsOf({ src: u.src, note: u.ctx, maxw: u.maxw }, x.p)) { problems.push(`${u.id} [${lang}] ${p}`); }
        }
    }
    const missing = inUnits.filter((u) => !seen.has(u.id));
    for (const u of missing.slice(0, 20)) { problems.push(`missing id: ${u.id}`); }
    if (missing.length > 20) { problems.push(`... ${missing.length - 20} more missing ids`); }
    return { covered: seen.size, total: inUnits.length, problems };
}

export function commandValidate(opts) {
    const work = loadWork(opts);
    const nn = pad(Number(need(opts, 'chunk')));
    const inUnits = readJson(join(reviewDir(work), `in-${nn}.json`));
    const outPath = join(reviewDir(work), `out-${nn}.json`);
    if (!existsSync(outPath)) { return { code: 1, text: `out-${nn}.json does not exist — run join first` }; }
    let outRows;
    try { outRows = readJson(outPath); } catch (e) { return { code: 1, text: `out-${nn}.json is not valid JSON: ${e.message}` }; }
    const { covered, total, problems } = validateRows(inUnits, outRows, reviewLangs(work));
    const text = [`${covered}/${total} units covered, ${problems.length} problems`, ...problems.slice(0, 200).map((p) => ` - ${p}`)].join('\n');
    return { code: problems.length ? 1 : 0, text };
}

/* ------------------------------------------------------------------ *
 * merge — one review out of the chunks, the same English translated the same way
 * ------------------------------------------------------------------ */

const NORM_REASON = {
    nl: 'gelijkgetrokken met dezelfde tekst elders in de app',
    fr: "harmonisé avec le même texte ailleurs dans l'application",
    de: 'an denselben Text an anderer Stelle der App angeglichen',
    es: 'igualado con el mismo texto en otra parte de la aplicación',
};
const normReason = (lang) => NORM_REASON[lang.split('-')[0]] ?? 'aligned with the same text elsewhere in the app';

export function commandMerge(opts) {
    const work = loadWork(opts);
    const dir = reviewDir(work);
    if (!existsSync(dir)) { throw new UsageError(`${dir} does not exist — run chunk and the review first`); }
    const ins = readdirSync(dir).filter((f) => /^in-\d+\.json$/.test(f)).sort();
    const missingChunks = [];
    const invalid = [];
    const rows = new Map();
    const findings = [];
    for (const f of ins) {
        const nn = f.slice(3, -5);
        const outPath = join(dir, `out-${nn}.json`);
        if (!existsSync(outPath)) { missingChunks.push(nn); continue; }
        const inUnits = readJson(join(dir, f));
        const outRows = readJson(outPath);
        const { problems } = validateRows(inUnits, outRows, reviewLangs(work));
        if (problems.length) { invalid.push({ chunk: nn, problems: problems.length }); continue; }
        for (const r of outRows) {
            rows.set(r.id, { ...r, chunk: nn });
            if (r.dev) { findings.push({ id: r.id, chunk: nn, note: r.dev }); }
        }
    }
    if (missingChunks.length || invalid.length) {
        return { code: 1, result: { status: 'incomplete', missingChunks, invalid, hint: 'review the missing chunks and validate every chunk to 0 problems, then merge again' } };
    }

    const unitById = new Map(work.units.map((u) => [u.id, u]));
    const chunkInfo = existsSync(join(dir, 'chunk.json')) ? readJson(join(dir, 'chunk.json')) : {};
    const scope = chunkInfo.snapshot === work.snapshot.created && chunkInfo.scope === 'open' ? 'open' : 'all';
    // In an open round a language that is not open for a string is hidden from the customer: its finished translation
    // stands. It is pinned to `ok`, so it votes with that text in the harmonisation below and an AI proposal the
    // customer never sees cannot pull a visible string away from what they confirmed before.
    const hiddenIn = (u) => (scope === 'open' ? work.langs.filter((l) => !openLangs(u, work.langs, work.snapshot).includes(l)) : []);
    // Only the lead of each group of variants is reviewed; the variants follow its text after the harmonisation.
    const tabs = tabsOf(work);
    const leads = tabs.map((t) => t.lead);
    const decisions = {};
    for (const [id, r] of rows) {
        decisions[id] = {};
        const hidden = hiddenIn(unitById.get(id));
        for (const lang of leads) {
            // A verdict on a hidden language is not lost: it goes to the developer findings, not to the customer.
            if (hidden.includes(lang) && r[lang].v !== 'ok') {
                const x = r[lang];
                // A lead whose group tab is shown (a variant is open) is in the workbook, kept as it is.
                const tab = tabs.find((t) => t.lead === lang);
                const inTab = tab.langs.length > 1 && !tab.langs.every((l) => hidden.includes(l));
                const where = inTab ? `Kept as it is in the ${tab.label} tab: the customer can change it there` : 'Not in this round: change it by hand or with --scope all';
                findings.push({ id, chunk: r.chunk, note: `[${lang}] finished translation judged ${x.v}${x.p ? `: ${x.p}` : ''}${x.r ? ` (${x.r})` : ''}. ${where}` });
            }
            const { v, p, r: why } = hidden.includes(lang) ? { v: 'ok' } : r[lang];
            decisions[id][lang] = { v, ...(v !== 'ok' ? { p } : {}), ...(why ? { r: why } : {}) };
        }
    }

    // Same English, same kind of string → one translation. A field caption and the page
    // control showing that field name the same thing, so they count as one kind.
    const choicesPath = join(dir, 'choices.json');
    const choices = existsSync(choicesPath) ? readJson(choicesPath) : {};
    const kind = (cat) => (cat === 'veld' ? 'caption' : cat);
    const inconsistencies = [];
    let normalised = 0;
    const setText = (u, lang, d, text) => {
        const cur = u.langs[lang].cur;
        const now = finalFor(u, lang, d);
        if (now === text || problemsOf(u, text).length) { return; }
        if (d.v === 'ok') {
            Object.assign(d, { v: 'stijl', p: text, r: normReason(lang) });
        } else {
            d.p = text;
            if (d.v !== 'nieuw' && text === cur) { d.v = 'ok'; delete d.p; delete d.r; }
        }
        normalised++;
    };
    // In an open round the strings finished in every language are not in the round, but their translation stands:
    // they vote with it, as `ok`, so a new string with the same English follows what the customer confirmed before.
    const voters = scope === 'open' ? work.units.filter((u) => !isBlank(u.src) && !decisions[u.id]) : [];
    const decisionOf = (u, lang) => decisions[u.id]?.[lang] ?? { v: 'ok' };
    for (const lang of leads) {
        const groups = new Map();
        for (const u of [...Object.keys(decisions).map((id) => unitById.get(id)), ...voters]) {
            const key = `${u.src}\u0000${kind(u.cat)}`;
            if (!groups.has(key)) { groups.set(key, []); }
            groups.get(key).push(u);
        }
        for (const list of groups.values()) {
            const src = list[0].src;
            // A hidden language votes but is never rewritten: the customer does not see it, the import does not write it.
            const shown = list.filter((u) => decisions[u.id] && !hiddenIn(u).includes(lang));
            if (!shown.length) { continue; }
            const chosen = choices[`${lang}|${src}`];
            if (chosen) {
                for (const u of shown) { setText(u, lang, decisions[u.id][lang], chosen); }
                // In an open round a choice reaches only the strings in it: a finished translation that differs stays
                // listed, so the developer knows it changes only in a round over everything (--scope all).
                const notReached = [...new Set(list.map((u) => finalFor(u, lang, decisionOf(u, lang))).filter((t) => t !== chosen))];
                if (notReached.length) { inconsistencies.push({ lang, src, kind: kind(list[0].cat), chosen, notReached }); }
                continue;
            }
            const counts = new Map();
            for (const u of list) { const t = finalFor(u, lang, decisionOf(u, lang)); counts.set(t, (counts.get(t) ?? 0) + 1); }
            if (counts.size < 2) { continue; }
            inconsistencies.push({ lang, src, kind: kind(list[0].cat), variants: Object.fromEntries(counts) });
            const best = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.length - b.length || a.localeCompare(b))[0];
            for (const u of shown) { setText(u, lang, decisions[u.id][lang], best); }
        }
    }

    // A tab is shown for a string when one of its languages is open (in a round over everything: always). There every
    // variant takes the text its lead ends with; where the tab is not shown, a variant keeps its finished translation.
    const tabShown = (u, tab) => scope !== 'open' || openLangs(u, work.langs, work.snapshot).some((l) => tab.langs.includes(l));
    for (const tab of tabs.filter((t) => t.langs.length > 1)) {
        for (const [id, d] of Object.entries(decisions)) {
            const u = unitById.get(id);
            for (const f of tab.langs.slice(1)) { d[f] = tabShown(u, tab) ? followerDecision(u, f, tab.lead, d[tab.lead]) : { v: 'ok' }; }
        }
    }

    // The counts are of what the workbook will show, per tab: in an open round, a tab only where the string is open.
    const counts = Object.fromEntries(tabs.map((t) => [t.label, Object.fromEntries(VERDICTS.map((v) => [v, 0]))]));
    const focus = Object.fromEntries(tabs.map((t) => [t.label, 0]));
    for (const [id, d] of Object.entries(decisions)) {
        const u = unitById.get(id);
        for (const tab of tabs.filter((t) => tabShown(u, t))) {
            const { v } = tabVerdict(tab, d);
            counts[tab.label][v]++;
            if (isFocus(u.cat, v)) { focus[tab.label]++; }
        }
    }
    writeJson(join(work.dir, 'review.json'), { schema: SCHEMA, snapshot: work.snapshot.created, merged: new Date().toISOString(), scope, langs: work.langs, units: decisions });
    writeJson(join(dir, 'inconsistencies.json'), inconsistencies);
    writeJson(join(dir, 'developer-findings.json'), findings.map((f) => ({ ...f, src: unitById.get(f.id).src, ctx: unitById.get(f.id).note })));
    return {
        code: 0,
        result: {
            status: 'merged',
            scope,
            reviewed: Object.keys(decisions).length,
            counts,
            focus,
            normalised,
            inconsistencies: inconsistencies.length,
            choices: Object.keys(choices).length,
            developerFindings: findings.length,
            files: { review: join(work.dir, 'review.json'), inconsistencies: join(dir, 'inconsistencies.json'), developerFindings: join(dir, 'developer-findings.json') },
        },
    };
}

/* ------------------------------------------------------------------ *
 * import — the customer's workbook back into the XLF files
 * ------------------------------------------------------------------ */

const LANG_SHEET = /^[a-z]{2,3}-[a-z]{2,4}$/i;
const INFO_SHEETS = ['Uitleg', 'Termen'];

export function commandImport(opts) {
    const work = loadWork(opts);
    const reviewPath = join(work.dir, 'review.json');
    const review = existsSync(reviewPath) ? readJson(reviewPath) : { units: {} };
    const sheets = readWorkbook(readFileSync(resolve(need(opts, 'xlsx'))));
    const meta = metaOf(sheets);
    if (meta && meta.round !== 'texts') { throw new UsageError(`this workbook is round "${meta.round}" — import-terms reads the terms round`); }
    if (meta?.app && meta.app !== work.snapshot.app.name) {
        throw new UsageError(`this workbook belongs to app "${meta.app}", the work folder to "${work.snapshot.app.name}"`);
    }
    const warnings = [];
    if (!meta) { warnings.push('the workbook has no _meta sheet: check that it comes from this review'); }
    const workScope = work.snapshot.feature ? 'feature' : 'full';
    if (meta?.scope && meta.scope !== workScope) {
        warnings.push(`the workbook comes from a ${meta.scope} round, the work folder is a ${workScope} round: only rows within this work folder's scope are imported`);
    }
    for (const s of sheets) {
        if (!s.hidden && !sheetLangs(s.name) && !INFO_SHEETS.includes(s.name)) { warnings.push(`sheet "${s.name}" is not a language tab and was ignored`); }
    }
    // A tab is one language, or a group of variants ("nl-BE + nl-NL") whose Definitief goes to each of them.
    const langSheets = sheets.filter((s) => !s.hidden && sheetLangs(s.name)).flatMap((sheet) => sheetLangs(sheet.name).map((lang, i) => ({ sheet, lang, first: i === 0 })));
    const twice = langSheets.map((x) => x.lang).filter((l, i, all) => all.indexOf(l) !== i);
    if (twice.length) { throw new UsageError(`the workbook has more than one tab for ${[...new Set(twice)].join(', ')} — keep one tab per language`); }
    const p = projectFiles(need(opts, 'project'), opts.g);
    const g = parseXlf(readFileSync(p.gFile, 'utf8'));
    const gById = new Map(g.units.map((u) => [u.id, u]));
    const currents = p.targets.map((path) => {
        const parsed = parseXlf(readFileSync(path, 'utf8'));
        return { path, parsed, lang: langOfFile(path, parsed) };
    });
    const useStates = currents.length ? currents.some((c) => c.parsed.usesStates) : true;
    const gBase = basename(p.gFile).replace(/\.g\.xlf$/i, '');
    const dry = Boolean(opts['dry-run']);
    // The feature mode: only the units of the snapshot's scope change; the rest of each file stays as it is.
    const scope = work.snapshot.feature ? new Set(work.snapshot.feature.ids) : null;

    const results = {};
    const remarks = [];
    for (const { sheet, lang, first } of langSheets) {
        requireColumns(sheet, ['Sleutel', 'Engels', 'Definitief']);
        const current = currents.find((c) => c.lang === lang) ?? null;
        if (scope && !current?.parsed.units.length) {
            throw new UsageError(`the feature mode adds to existing translation files, and ${lang} has none with units in ${p.tdir} — a new language is a round over the whole app`);
        }
        const r = { file: current?.path ?? join(p.tdir, `${gBase}.${lang}.xlf`), rows: 0, proposal: 0, changedByCustomer: 0, unchanged: 0, rejected: [], conflicts: [], removed: [], outOfScope: [], empty: [], duplicates: [] };
        const decisions = new Map();
        const curById = new Map((current?.parsed.units ?? []).map((u) => [u.id, u]));
        for (const rec of recordsOf(sheet)) {
            const key = cellText(rec.Sleutel).trim();
            if (!key) { continue; }
            r.rows++;
            const gu = gById.get(key);
            if (!gu) { r.removed.push({ row: rec._row, key }); continue; }
            if (scope && !scope.has(key)) { r.outOfScope.push({ row: rec._row, key }); continue; }
            const en = cellText(rec.Engels);
            if (en !== gu.source) { r.conflicts.push({ row: rec._row, key, exported: en, now: gu.source }); continue; }
            const def = rec.Definitief;
            if (!def || def.v === '') { r.empty.push({ row: rec._row, key, en }); continue; }
            if (decisions.has(key)) { r.duplicates.push({ row: rec._row, key }); continue; }
            const text = cellText(def);
            if (def.t !== 's' && def.t !== 'str' && text !== gu.source) {
                r.rejected.push({ row: rec._row, key, en, text, problems: ['Excel stored this cell as a number or date, not as text'] });
                continue;
            }
            const problems = problemsOf({ src: gu.source, note: gu.notes['Xliff Generator'] ?? '', maxw: gu.maxwidth }, text);
            if (problems.length) { r.rejected.push({ row: rec._row, key, en, text, problems }); continue; }
            decisions.set(key, text);
            const d = review.units?.[key]?.[lang];
            const proposal = d ? (d.v === 'ok' ? curById.get(key)?.target ?? null : d.p) : null;
            if (text === curById.get(key)?.target) { r.unchanged++; }
            if (proposal !== null && text === proposal) { r.proposal++; } else { r.changedByCustomer++; }
            // A remark is the row's, not the language's: a group of variants reports it once, under its tab.
            const remark = cellText(rec.Opmerking).trim();
            if (remark && first) { remarks.push({ lang: sheetLangs(sheet.name).join(' + '), key, ctx: readableContext(gu.notes['Xliff Generator'] ?? ''), en, remark }); }
        }
        // An empty enum value has nothing to translate: it keeps the source as it is.
        for (const u of g.units) {
            if (u.translate && isBlank(u.source) && !decisions.has(u.id) && !curById.get(u.id)?.targetRaw) { decisions.set(u.id, u.source); }
        }
        const built = scope
            ? patchTargetXlf(g, current.parsed, decisions, { scope })
            : buildTargetXlf(g, current?.parsed ?? null, decisions, { lang, useStates });
        Object.assign(r, { stats: built.stats, stale: built.stale, dropped: built.dropped, text: built.text });
        results[lang] = r;
    }
    if (!Object.keys(results).length) { throw new UsageError('the workbook has no language sheet (a tab named like nl-BE)'); }

    // Feature mode: strings outside this round that differ from the snapshot's base -- what the branch added or changed
    // after the snapshot, and, after a merge of master, master's new strings too. Listed as a hint for a next round,
    // whose fresh merge-base sorts out which are the branch's.
    let newSinceSnapshot = [];
    if (scope) {
        const basePath = join(work.dir, BASE_COPY);
        if (existsSync(basePath)) {
            const baseSource = new Map(parseXlf(readFileSync(basePath, 'utf8')).units.map((u) => [u.id, u.source]));
            newSinceSnapshot = g.units
                .filter((u) => u.translate && !isBlank(u.source) && !scope.has(u.id) && baseSource.get(u.id) !== u.source)
                .map((u) => ({ id: u.id, en: u.source }));
        } else {
            warnings.push(`${BASE_COPY} is missing from the work folder: strings the branch added after the snapshot cannot be listed`);
        }
    }

    // Translations whose string is gone from the .g.xlf are dropped. A .g.xlf compiled from
    // another branch would drop real translations, so a write needs --allow-drop after a dry run.
    const dropping = Object.values(results).flatMap((r) => r.dropped);
    if (dropping.length && !dry && !opts['allow-drop']) {
        throw new UsageError(`the import would drop ${dropping.length} translation(s) of strings the .g.xlf no longer has (first: ${dropping.slice(0, 3).join(' | ')}). Check that the .g.xlf was compiled from this branch; --dry-run lists them, --allow-drop confirms`);
    }
    // An unreadable project glossary stops the import here, before any translation file is written.
    projectGlossaryForWrite(p.dir);
    // Every language is built before any file is written: a failure leaves all files as they were.
    if (!dry) { for (const r of Object.values(results)) { writeFileSync(r.file, r.text, 'utf8'); } }
    for (const r of Object.values(results)) { delete r.text; }
    const glossary = loadGlossary(work.dir);
    // Variants share one term in the project glossary too.
    const aligned = alignVariantTerms(glossary, work);
    // A full round records itself, so the next full round offers the customer only what is still open.
    const fullRound = scope ? null : { date: today(), commit: work.snapshot.commit, langs: Object.keys(results) };
    const projectGlossary = dry ? null : writeProjectGlossary(p.dir, glossary, { fullRound });

    const reportPath = join(work.dir, `import-report${dry ? '-dry-run' : ''}.json`);
    writeJson(reportPath, { imported: new Date().toISOString(), dryRun: dry, mode: scope ? 'feature' : 'full', warnings, results, remarks, ...(scope ? { newSinceSnapshot } : {}) });
    const brief = (list) => ({ count: list.length, first: list.slice(0, 20) });
    return {
        status: dry ? 'dry-run' : 'imported',
        mode: scope ? 'feature' : 'full',
        ...(scope ? { newSinceSnapshot: brief(newSinceSnapshot) } : {}),
        report: reportPath,
        projectGlossary,
        alignedVariants: overwritten(aligned),
        warnings,
        remarks: remarks.length,
        langs: Object.fromEntries(Object.entries(results).map(([lang, r]) => [lang, {
            file: r.file,
            written: !dry,
            rows: r.rows,
            proposal: r.proposal,
            changedByCustomer: r.changedByCustomer,
            unchanged: r.unchanged,
            rejected: brief(r.rejected),
            conflicts: brief(r.conflicts),
            removed: brief(r.removed),
            ...(scope ? { outOfScope: brief(r.outOfScope) } : {}),
            empty: r.empty.length,
            duplicates: r.duplicates.length,
            stale: { ...brief(r.stale), unmarked: r.stale.filter((s) => !s.marked).length },
            dropped: brief(r.dropped),
            stats: r.stats,
        }])),
    };
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

export async function main(argv = process.argv.slice(2), io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
    const json = (v) => io.out(`${JSON.stringify(v, null, 2)}\n`);
    try {
        const { command, opts } = parseArgs(argv);
        switch (command) {
        case 'snapshot': json(commandSnapshot(opts)); return 0;
        case 'terms': json(commandTerms(opts)); return 0;
        case 'export': json(commandExport(opts)); return 0;
        case 'import-terms': json(commandImportTerms(opts)); return 0;
        case 'chunk': json(commandChunk(opts)); return 0;
        case 'tm': io.out(`${commandTm(opts)}\n`); return 0;
        case 'join': json(commandJoin(opts)); return 0;
        case 'validate': { const { code, text } = commandValidate(opts); io.out(`${text}\n`); return code; }
        case 'merge': { const { code, result } = commandMerge(opts); json(result); return code; }
        case 'import': json(commandImport(opts)); return 0;
        default: throw new UsageError(command ? `unknown command: ${command}` : 'no command');
        }
    } catch (err) {
        if (err instanceof UsageError) {
            io.err(`${err.message}\n\n${USAGE}\n`);
            return 2;
        }
        io.err(`${err.stack ?? err}\n`);
        return 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = await main();
}
