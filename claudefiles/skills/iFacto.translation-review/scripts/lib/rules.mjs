// rules.mjs — what makes a translation technically valid, and how a string is classified.
//
// Part of the iFacto.translation-review skill. Used by the reviewers' validator and by the
// import, so a translation that breaks Business Central never reaches the XLF.

export const VERDICTS = ['fout', 'twijfel', 'nieuw', 'stijl', 'ok'];

/** Category of a unit, from its "Xliff Generator" note. */
export function categoryOf(note = '') {
    if (/^(Table|TableExtension) .* - Field .* - Property Caption$/.test(note)) { return 'veld'; }
    if (/^(Enum|EnumExtension) .* - Property Caption$/.test(note)) { return 'enum'; }
    if (/ - Action .* - Property Caption$/.test(note)) { return 'actie'; }
    if (/Property (Caption|OptionCaption)$/.test(note)) { return 'caption'; }
    if (/Property (ToolTip|AboutTitle|AboutText|InstructionalText)$/.test(note)) { return 'tooltip'; }
    return 'melding';
}

/** On the screen as a label, value or action (not a tooltip or a message). */
export const isScreenText = (cat) => ['veld', 'enum', 'actie', 'caption'].includes(cat);

/** The rows the customer should look at first. */
export const isFocus = (cat, verdict) => verdict === 'fout' || verdict === 'twijfel' || (verdict === 'nieuw' && isScreenText(cat));

/** "TableExtension Sales Header Ext - Field Delivery Method - Property Caption" → "TableExtension Sales Header Ext › Field Delivery Method · Caption". */
export function readableContext(note = '') {
    const parts = note.split(' - ');
    if (parts.length < 2) { return note; }
    const prop = parts.at(-1).replace(/^Property /, '');
    const middle = parts.slice(1, -1);
    return middle.length ? `${parts[0]} › ${middle.join(' › ')} · ${prop}` : `${parts[0]} · ${prop}`;
}

const PLACEHOLDER = /%\d+|#\d+#*|@\d+@*|\\/g;

/** The placeholders of a text (%1, #1##, @1@@, and every backslash — a line break in AL), sorted. */
export const placeholdersOf = (text = '') => (text.match(PLACEHOLDER) ?? []).sort();

/** True when the source has nothing to translate: an empty or blank enum value. */
export const isBlank = (text) => !String(text ?? '').trim();

/**
 * The technical problems of `text` as a translation of `unit` ({ src, note | ctx, maxw }).
 * Each problem is a short English code with detail; [] means the text can be written.
 */
export function problemsOf(unit, text) {
    const problems = [];
    const src = unit.src ?? '';
    if (text === null || text === undefined || text === '') { return ['empty']; }
    const want = placeholdersOf(src);
    const got = placeholdersOf(text);
    if (want.join(' ') !== got.join(' ')) {
        problems.push(`placeholders: source has [${want.join(' ')}], translation has [${got.join(' ')}]`);
    }
    if (/Property OptionCaption$/.test(unit.note ?? unit.ctx ?? '')) {
        const a = src.split(',').length;
        const b = text.split(',').length;
        if (a !== b) { problems.push(`option count: source has ${a} options, translation has ${b}`); }
    }
    const maxw = Number(unit.maxw ?? unit.maxwidth ?? 0);
    if (maxw && text.length > maxw) { problems.push(`too long: ${text.length} characters, maximum ${maxw}`); }
    const lead = (s) => /^\s/.test(s);
    const trail = (s) => /\s$/.test(s);
    if (lead(text) !== lead(src) || trail(text) !== trail(src)) {
        problems.push('leading or trailing whitespace differs from the source');
    }
    return problems;
}
