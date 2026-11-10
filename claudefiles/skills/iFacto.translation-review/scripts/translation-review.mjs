#!/usr/bin/env node
// translation-review.mjs — review the translations of an AL app with AI, let the customer
// confirm them in Excel, and write the result back to the XLF files.
//
// Part of the iFacto.translation-review skill. Zero dependencies, Node 18+.
//
// Usage:  node translation-review.mjs snapshot     --project <App> [--work <dir>] [--g <file>] [--packages <dir>] [--langs nl-BE,fr-BE] [--add-lang es-ES] [--commit <label>] [--force]
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
import { parseXlf, buildTargetXlf, normLang } from './lib/xlf.mjs';
import { VERDICTS, categoryOf, isFocus, readableContext, placeholdersOf, isBlank, problemsOf } from './lib/rules.mjs';

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = 1;
const DEFAULT_CHUNK = 270;
const SHORT = 60; // reference strings up to this length are kept for term and phrase lookups
const DONE_STATES = new Set(['translated', 'final', 'signed-off']);

const USAGE = `Usage:
  node translation-review.mjs snapshot     --project <App> [--work <dir>] [--g <file>] [--packages <dir>] [--langs nl-BE,fr-BE] [--add-lang es-ES] [--commit <label>] [--force]
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

const FLAGS = new Set(['dry-run', 'force', 'allow-drop']);

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

const loadReference = (dir) => (existsSync(join(dir, 'reference.json')) ? readJson(join(dir, 'reference.json')) : {});
const loadGlossary = (dir) => (existsSync(join(dir, 'glossary.json')) ? readJson(join(dir, 'glossary.json')) : null);

/** Keeps the glossary in the customer repo, so the next round starts from the same terms. */
function writeProjectGlossary(projectDir, glossary) {
    const path = join(resolve(projectDir), 'translation-glossary.json');
    writeJson(path, { schema: SCHEMA, updated: today(), terms: glossary.terms.map(({ origin, ...t }) => t) });
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

export function commandSnapshot(opts) {
    const p = projectFiles(need(opts, 'project'), opts.g);
    const dir = resolve(opts.work ?? join(homedir(), 'Downloads', 'translation-review', `${slug(p.app.name)}-${today()}`));
    if (existsSync(join(dir, 'snapshot.json')) && !opts.force) {
        throw new UsageError(`${dir} already holds a snapshot — use a new --work folder, or --force to replace it`);
    }
    const g = parseXlf(readFileSync(p.gFile, 'utf8'));
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

    const byLang = Object.fromEntries(langs.map((l) => [l, new Map((targets.find((t) => t.lang === l)?.parsed.units ?? []).map((u) => [u.id, u]))]));
    const units = [];
    for (const u of g.units) {
        if (!u.translate) { continue; }
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
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'snapshot.json'), snapshot);
    writeJson(join(dir, 'units.json'), units);
    writeJson(join(dir, 'reference.json'), reference, { compact: true });

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
        work: dir,
        app: snapshot.app.name,
        commit: snapshot.commit,
        units: units.length,
        objects: new Set(units.map((u) => u.obj)).size,
        categories: units.reduce((a, u) => ({ ...a, [u.cat]: (a[u.cat] ?? 0) + 1 }), {}),
        langs: perLang,
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
        ['Dit bestand bevat de kernbegrippen van de app met onze voorgestelde vertaling. Wat u hier kiest, passen we daarna toe op alle teksten.'],
        ['Pas alleen de gele kolommen aan: Definitief per taal, en Opmerking. Definitief bevat al ons voorstel: laat het staan als het klopt, overschrijf het als het anders moet.'],
        ['Standaard BC en Andere apps tonen hoe Business Central en de andere apps hetzelfde begrip vertalen. Wijkt u daarvan af, dan ziet de gebruiker op hetzelfde scherm twee woorden voor hetzelfde.'],
        ['Sorteren en filteren mag. Verwijder geen rijen of kolommen en wijzig de kolom Engels niet.'],
        [''],
        ['Vérification des traductions - termes', STYLE.title],
        ["Ce fichier contient les termes clés de l'application avec notre proposition de traduction. Ce que vous choisissez ici sera ensuite appliqué à tous les textes."],
        ['Modifiez uniquement les colonnes jaunes : Definitief par langue, et Opmerking (remarque). Definitief contient déjà notre proposition : laissez-la si elle est correcte, remplacez-la si elle doit changer.'],
        ["Standaard BC et Andere apps montrent comment Business Central et les autres applications traduisent le même terme. Si vous vous en écartez, l'utilisateur verra deux mots pour la même chose sur le même écran."],
        ['Vous pouvez trier et filtrer. Ne supprimez ni lignes ni colonnes et ne modifiez pas la colonne Engels.'],
        [''],
        ['Translation review - terms', STYLE.title],
        ['This file holds the key terms of the app with our proposed translation. What you choose here is then applied to every text.'],
        ['Only change the yellow columns: Definitief per language, and Opmerking (remarks). Definitief already holds our proposal: leave it when it is right, overwrite it when it must change.'],
        ['Standaard BC and Andere apps show how Business Central and the other apps translate the same term. If you deviate, users see two words for the same thing on one screen.'],
        ['Sorting and filtering are fine. Do not delete rows or columns, and do not change the Engels column.'],
    ],
    texts: [
        ['Vertalingen nakijken - teksten', STYLE.title],
        ['Dit bestand bevat de vertaalbare teksten van de app, met een tabblad per taal.'],
        ['Pas alleen de gele kolommen aan: Definitief en Opmerking. Definitief bevat al ons voorstel; een rij die u niet aanpast, nemen we over zoals ze er staat.'],
        ['Begin met de filter Focus = Ja: alles wat wij fout of twijfelachtig vinden, en nieuwe teksten op het scherm.'],
        ['Laat %1, %2 ... staan: daar vult Business Central een waarde in. Een backslash (\\) is een nieuwe regel.'],
        ['Oordeel: fout = de huidige vertaling is fout - twijfel = alleen u kunt beslissen - nieuw = er was nog geen vertaling - stijl = kleine correctie, nakijken hoeft niet - ok = goed zoals het is.'],
        ['Sorteren en filteren mag. Verwijder geen rijen of kolommen en wijzig de kolom Engels niet.'],
        ['Het tabblad Termen toont de vertaling van de kernbegrippen die we overal gebruiken. Niet akkoord met een term? Zet het in de kolom Opmerking van een rij waarin hij voorkomt.'],
        [''],
        ['Vérification des traductions - textes', STYLE.title],
        ["Ce fichier contient les textes traduisibles de l'application, avec un onglet par langue."],
        ['Modifiez uniquement les colonnes jaunes : Definitief et Opmerking (remarque). Definitief contient déjà notre proposition ; une ligne que vous ne modifiez pas est reprise telle quelle.'],
        ['Commencez par le filtre Focus = Ja : tout ce que nous jugeons faux ou douteux, et les nouveaux textes à l\'écran.'],
        ['Laissez %1, %2 ... en place : Business Central y insère une valeur. Une barre oblique inverse (\\) est un saut de ligne.'],
        ['Oordeel : fout = la traduction actuelle est incorrecte - twijfel = à décider par vous - nieuw = pas encore traduit - stijl = petite correction, pas besoin de vérifier - ok = correct tel quel.'],
        ['Vous pouvez trier et filtrer. Ne supprimez ni lignes ni colonnes et ne modifiez pas la colonne Engels.'],
        ["L'onglet Termen montre la traduction des termes clés utilisée partout. Pas d'accord avec un terme ? Indiquez-le dans la colonne Opmerking d'une ligne où il apparaît."],
        [''],
        ['Translation review - texts', STYLE.title],
        ['This file holds the translatable texts of the app, with one tab per language.'],
        ['Only change the yellow columns: Definitief and Opmerking (remarks). Definitief already holds our proposal; a row you leave untouched is taken as it stands.'],
        ['Start with the filter Focus = Ja: everything we consider wrong or doubtful, and new texts on screen.'],
        ['Leave %1, %2 ... in place: Business Central fills in a value there. A backslash (\\) is a line break.'],
        ['Oordeel: fout = the current translation is wrong - twijfel = only you can decide - nieuw = not translated yet - stijl = small correction, no need to check - ok = right as it is.'],
        ['Sorting and filtering are fine. Do not delete rows or columns, and do not change the Engels column.'],
        ['The Termen tab shows the translation of the key terms used throughout. Disagree with a term? Say so in the Opmerking column of a row where it appears.'],
    ],
};

const uitlegSheet = (round) => ({
    name: 'Uitleg',
    columns: [{ width: 130, style: STYLE.text }],
    rows: UITLEG[round].map(([text, style]) => [{ v: text, s: style ?? STYLE.text }]),
});

const metaSheet = (work, round) => ({
    name: '_meta',
    hidden: true,
    columns: [{ width: 14 }, { width: 40 }],
    rows: [
        ['schema', String(SCHEMA)],
        ['round', round],
        ['app', work.snapshot.app.name],
        ['snapshot', work.snapshot.commit ?? ''],
        ['created', today()],
        ['languages', work.langs.join(',')],
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
    const sheets = [uitlegSheet(round)];

    const countOf = (term) => {
        const re = termRegex(term);
        return work.units.filter((u) => re.test(u.src)).length;
    };

    if (round === 'terms') {
        const header = ['Sleutel', 'Engels', 'Aantal teksten', 'Toelichting', ...langs.flatMap((l) => [`Standaard BC ${l}`, `Andere apps ${l}`, `Voorstel ${l}`, `Definitief ${l}`]), 'Opmerking'];
        const columns = [{ width: 14, hidden: true }, { width: 26 }, { width: 9 }, { width: 40 }, ...langs.flatMap(() => [{ width: 20 }, { width: 20 }, { width: 22 }, { width: 22, style: STYLE.edit }]), { width: 30, style: STYLE.edit }];
        const rows = [header.map((h) => ({ v: h, s: STYLE.header }))];
        const terms = [...glossary.terms].map((t) => ({ t, n: countOf(t) })).sort((a, b) => b.n - a.n || a.t.en.localeCompare(b.t.en));
        for (const { t, n } of terms) {
            const refs = langs.map((l) => referenceFor(reference, l, termPhrases(t)[0]));
            rows.push([t.key, t.en, String(n), t.note ?? '', ...langs.flatMap((l, i) => [refs[i].ms ?? '', refs[i].other ?? '', t[l] ?? '', t[l] ?? '']), '']);
        }
        sheets.push({ name: 'Termen', columns, rows, freeze: { columns: 2, rows: 1 }, autoFilter: true });
    } else {
        if (glossary) {
            const rows = [['Sleutel', 'Engels', ...langs, 'Toelichting'].map((h) => ({ v: h, s: STYLE.header }))];
            for (const t of glossary.terms) { rows.push([t.key, t.en, ...langs.map((l) => t[l] ?? ''), t.note ?? '']); }
            sheets.push({ name: 'Termen', columns: [{ width: 14, hidden: true }, { width: 26 }, ...langs.map(() => ({ width: 26 })), { width: 50 }], rows, freeze: { columns: 2, rows: 1 }, autoFilter: true });
        }
        const header = ['Sleutel', 'Waar', 'Engels', 'Huidig', 'Referentie', 'Oordeel', 'Reden', 'Focus', 'Definitief', 'Opmerking'];
        const columns = [{ width: 18, hidden: true }, { width: 36 }, { width: 36 }, { width: 36 }, { width: 24 }, { width: 10 }, { width: 40 }, { width: 8 }, { width: 36, style: STYLE.edit }, { width: 30, style: STYLE.edit }];
        for (const lang of langs) {
            const rows = [header.map((h) => ({ v: h, s: STYLE.header }))];
            for (const u of work.units) {
                const d = work.review.units[u.id]?.[lang];
                if (!d || isBlank(u.src)) { continue; }
                const ref = u.ref?.[lang];
                const refText = ref?.ms ? `BC: ${ref.ms}` : ref?.other ? `App: ${ref.other}` : '';
                rows.push([u.id, readableContext(u.note), u.src, u.langs[lang].cur ?? '', refText, { v: d.v, s: verdictStyle(d.v) }, d.r ?? '', isFocus(u.cat, d.v) ? 'Ja' : 'Nee', finalFor(u, lang, d) ?? '', '']);
            }
            sheets.push({ name: lang, columns, rows, freeze: { columns: 3, rows: 1 }, autoFilter: true });
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
    requireColumns(sheet, ['Sleutel', 'Engels', ...work.langs.map((l) => `Definitief ${l}`)]);

    const changed = [];
    const unknown = [];
    const remarks = [];
    let kept = 0;
    for (const rec of recordsOf(sheet)) {
        const key = cellText(rec.Sleutel).trim();
        const term = glossary.terms.find((t) => t.key === key);
        if (!term) { unknown.push({ row: rec._row, key, en: cellText(rec.Engels) }); continue; }
        for (const lang of work.langs) {
            const value = cellText(rec[`Definitief ${lang}`]).trim();
            if (!value || value === (term[lang] ?? '')) { kept++; continue; }
            changed.push({ key, en: term.en, lang, from: term[lang] ?? null, to: value });
            term[lang] = value;
        }
        const remark = cellText(rec.Opmerking).trim();
        if (remark) { remarks.push({ key, en: term.en, remark }); }
        term.decided = today();
    }
    writeJson(glossaryPath, glossary);
    const projectGlossary = opts.project ? writeProjectGlossary(opts.project, glossary) : null;
    return { status: 'terms-imported', glossary: glossaryPath, projectGlossary, kept, changed, unknown, remarks };
}

/* ------------------------------------------------------------------ *
 * chunk / tm / join / validate — the AI review
 * ------------------------------------------------------------------ */

const reviewDir = (work) => join(work.dir, 'review');

function isOpen(u, langs) {
    return langs.some((l) => {
        const x = u.langs[l];
        return x.cur === null || x.oldsrc !== undefined || !DONE_STATES.has(x.st);
    });
}

export function commandChunk(opts) {
    const work = loadWork(opts);
    const size = Number(opts.size ?? DEFAULT_CHUNK);
    const scope = opts.scope ?? 'all';
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

    const selected = work.units.filter((u) => !isBlank(u.src) && (scope === 'all' || isOpen(u, work.langs)));
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
        for (const lang of work.langs) {
            const x = u.langs[lang];
            const c = { cur: x.cur, st: x.st };
            if (x.oldsrc !== undefined) { c.oldsrc = x.oldsrc; }
            if (u.ref?.[lang]?.ms) { c.ms = u.ref[lang].ms; }
            if (u.ref?.[lang]?.other) { c.other = u.ref[lang].other; }
            r[lang] = c;
        }
        return r;
    };
    const list = chunks.map((c, i) => {
        const nn = pad(i + 1);
        writeFileSync(join(dir, `in-${nn}.json`), `[\n${c.map((u) => JSON.stringify(slim(u))).join(',\n')}\n]\n`, 'utf8');
        return { chunk: nn, units: c.length, from: c[0].obj, to: c.at(-1).obj };
    });
    return { status: 'chunked', scope, langs: work.langs, units: selected.length, chunks: list, dir };
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
    const { covered, total, problems } = validateRows(inUnits, outRows, work.langs);
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
        const { problems } = validateRows(inUnits, outRows, work.langs);
        if (problems.length) { invalid.push({ chunk: nn, problems: problems.length }); continue; }
        for (const r of outRows) {
            rows.set(r.id, r);
            if (r.dev) { findings.push({ id: r.id, chunk: nn, note: r.dev }); }
        }
    }
    if (missingChunks.length || invalid.length) {
        return { code: 1, result: { status: 'incomplete', missingChunks, invalid, hint: 'review the missing chunks and validate every chunk to 0 problems, then merge again' } };
    }

    const unitById = new Map(work.units.map((u) => [u.id, u]));
    const decisions = {};
    for (const [id, r] of rows) {
        decisions[id] = {};
        for (const lang of work.langs) {
            const { v, p, r: why } = r[lang];
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
    for (const lang of work.langs) {
        const groups = new Map();
        for (const id of Object.keys(decisions)) {
            const u = unitById.get(id);
            const key = `${u.src}\u0000${kind(u.cat)}`;
            if (!groups.has(key)) { groups.set(key, []); }
            groups.get(key).push(u);
        }
        for (const list of groups.values()) {
            const src = list[0].src;
            const chosen = choices[`${lang}|${src}`];
            if (chosen) { for (const u of list) { setText(u, lang, decisions[u.id][lang], chosen); } continue; }
            const counts = new Map();
            for (const u of list) { const t = finalFor(u, lang, decisions[u.id][lang]); counts.set(t, (counts.get(t) ?? 0) + 1); }
            if (counts.size < 2) { continue; }
            inconsistencies.push({ lang, src, kind: kind(list[0].cat), variants: Object.fromEntries(counts) });
            const best = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.length - b.length || a.localeCompare(b))[0];
            for (const u of list) { setText(u, lang, decisions[u.id][lang], best); }
        }
    }

    const counts = Object.fromEntries(work.langs.map((l) => [l, Object.fromEntries(VERDICTS.map((v) => [v, 0]))]));
    const focus = Object.fromEntries(work.langs.map((l) => [l, 0]));
    for (const [id, d] of Object.entries(decisions)) {
        for (const lang of work.langs) {
            counts[lang][d[lang].v]++;
            if (isFocus(unitById.get(id).cat, d[lang].v)) { focus[lang]++; }
        }
    }
    writeJson(join(work.dir, 'review.json'), { schema: SCHEMA, snapshot: work.snapshot.created, merged: new Date().toISOString(), langs: work.langs, units: decisions });
    writeJson(join(dir, 'inconsistencies.json'), inconsistencies);
    writeJson(join(dir, 'developer-findings.json'), findings.map((f) => ({ ...f, src: unitById.get(f.id).src, ctx: unitById.get(f.id).note })));
    return {
        code: 0,
        result: {
            status: 'merged',
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
    for (const s of sheets) {
        if (!s.hidden && !LANG_SHEET.test(s.name) && !INFO_SHEETS.includes(s.name)) { warnings.push(`sheet "${s.name}" is not a language tab and was ignored`); }
    }
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

    const results = {};
    const remarks = [];
    for (const sheet of sheets.filter((s) => LANG_SHEET.test(s.name) && !s.hidden)) {
        const lang = normLang(sheet.name);
        requireColumns(sheet, ['Sleutel', 'Engels', 'Definitief']);
        const current = currents.find((c) => c.lang === lang) ?? null;
        const r = { file: current?.path ?? join(p.tdir, `${gBase}.${lang}.xlf`), rows: 0, proposal: 0, changedByCustomer: 0, unchanged: 0, rejected: [], conflicts: [], removed: [], empty: [], duplicates: [] };
        const decisions = new Map();
        const curById = new Map((current?.parsed.units ?? []).map((u) => [u.id, u]));
        for (const rec of recordsOf(sheet)) {
            const key = cellText(rec.Sleutel).trim();
            if (!key) { continue; }
            r.rows++;
            const gu = gById.get(key);
            if (!gu) { r.removed.push({ row: rec._row, key }); continue; }
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
            const remark = cellText(rec.Opmerking).trim();
            if (remark) { remarks.push({ lang, key, ctx: readableContext(gu.notes['Xliff Generator'] ?? ''), en, remark }); }
        }
        // An empty enum value has nothing to translate: it keeps the source as it is.
        for (const u of g.units) {
            if (u.translate && isBlank(u.source) && !decisions.has(u.id) && !curById.get(u.id)?.targetRaw) { decisions.set(u.id, u.source); }
        }
        const built = buildTargetXlf(g, current?.parsed ?? null, decisions, { lang, useStates });
        Object.assign(r, { stats: built.stats, stale: built.stale, dropped: built.dropped, text: built.text });
        results[lang] = r;
    }
    if (!Object.keys(results).length) { throw new UsageError('the workbook has no language sheet (a tab named like nl-BE)'); }

    // Translations whose string is gone from the .g.xlf are dropped. A .g.xlf compiled from
    // another branch would drop real translations, so a write needs --allow-drop after a dry run.
    const dropping = Object.values(results).flatMap((r) => r.dropped);
    if (dropping.length && !dry && !opts['allow-drop']) {
        throw new UsageError(`the import would drop ${dropping.length} translation(s) of strings the .g.xlf no longer has (first: ${dropping.slice(0, 3).join(' | ')}). Check that the .g.xlf was compiled from this branch; --dry-run lists them, --allow-drop confirms`);
    }
    // Every language is built before any file is written: a failure leaves all files as they were.
    if (!dry) { for (const r of Object.values(results)) { writeFileSync(r.file, r.text, 'utf8'); } }
    for (const r of Object.values(results)) { delete r.text; }
    const glossary = loadGlossary(work.dir);
    const projectGlossary = glossary && !dry ? writeProjectGlossary(p.dir, glossary) : null;

    const reportPath = join(work.dir, `import-report${dry ? '-dry-run' : ''}.json`);
    writeJson(reportPath, { imported: new Date().toISOString(), dryRun: dry, warnings, results, remarks });
    const brief = (list) => ({ count: list.length, first: list.slice(0, 20) });
    return {
        status: dry ? 'dry-run' : 'imported',
        report: reportPath,
        projectGlossary,
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
