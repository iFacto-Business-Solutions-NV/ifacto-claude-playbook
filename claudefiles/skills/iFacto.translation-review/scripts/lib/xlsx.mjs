// xlsx.mjs — write and read the review workbook with the Node standard library only.
//
// Part of the iFacto.translation-review skill. The writer produces exactly what the review
// needs: text cells, a handful of fixed styles, column widths, hidden columns and sheets,
// frozen panes and an autofilter. The reader accepts what Excel, Excel Online and
// LibreOffice save: shared strings (rich-text runs included), inline strings, numbers.

import { readZip, writeZip } from './zip.mjs';

/** Cell styles, by name. The ids index cellXfs in STYLES_XML. */
export const STYLE = Object.freeze({
    normal: 0, header: 1, text: 2, edit: 3,
    fout: 4, twijfel: 5, nieuw: 6, stijl: 7, ok: 8,
    title: 9, bold: 10,
});

const VERDICT_COLOURS = [ // fill, font — in STYLE order fout … ok
    ['FDE8E6', 'B42318'],
    ['FDF1DC', 'A15C07'],
    ['E3EBFB', '1F4FBF'],
    ['ECEEF1', '5D6670'],
    ['E1F2E6', '17733A'],
];

// numFmtId 49 is the text format "@": what someone types in a data cell stays text, so
// "1/2" or "1-3" never turns into a date or a number.
const xf = (font, fill, wrap, text = true) => `<xf numFmtId="${text ? 49 : 0}" fontId="${font}" fillId="${fill}" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyAlignment="1">${wrap ? '<alignment wrapText="1" vertical="top"/>' : '<alignment vertical="top"/>'}</xf>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="${3 + VERDICT_COLOURS.length}">
<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="13"/><name val="Calibri"/><family val="2"/></font>
${VERDICT_COLOURS.map(([, font]) => `<font><b/><sz val="11"/><color rgb="FF${font}"/><name val="Calibri"/><family val="2"/></font>`).join('\n')}
</fonts>
<fills count="${4 + VERDICT_COLOURS.length}">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill>
${VERDICT_COLOURS.map(([fill]) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${fill}"/><bgColor indexed="64"/></patternFill></fill>`).join('\n')}
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="11">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
${xf(1, 2, true)}
${xf(0, 0, true)}
${xf(0, 3, true)}
${VERDICT_COLOURS.map((_, i) => xf(3 + i, 4 + i, true)).join('\n')}
${xf(2, 0, false, false)}
${xf(1, 0, false, false)}
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

export function columnName(index) { // 0 → A, 26 → AA
    let n = index + 1;
    let s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
}

function columnIndex(letters) {
    let n = 0;
    for (const ch of letters.toUpperCase()) { n = n * 26 + (ch.charCodeAt(0) - 64); }
    return n - 1;
}

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Cell text as OOXML stores it: a literal "_xHHHH_" is protected as "_x005F_xHHHH_", and
 * control characters XML cannot carry become "_xHHHH_".
 */
function encodeText(s) {
    return String(s)
        .replace(/_(x[0-9A-Fa-f]{4}_)/g, '_x005F_$1')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\r\n/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\r]/g, (c) => `_x${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`);
}

function decodeText(s) {
    return s
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&amp;/g, '&')
        .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function sheetXml(sheet, selected) {
    const rows = sheet.rows ?? [];
    const width = Math.max(1, sheet.columns?.length ?? 0, ...rows.map((r) => r.length));
    const lastRef = `${columnName(width - 1)}${Math.max(1, rows.length)}`;
    const out = [`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`];
    out.push(`<dimension ref="A1:${lastRef}"/>`);

    const fc = sheet.freeze?.columns ?? 0;
    const fr = sheet.freeze?.rows ?? 0;
    let pane = '';
    if (fc || fr) {
        const topLeft = `${columnName(fc)}${fr + 1}`;
        const active = fc && fr ? 'bottomRight' : fr ? 'bottomLeft' : 'topRight';
        pane = `<pane${fc ? ` xSplit="${fc}"` : ''}${fr ? ` ySplit="${fr}"` : ''} topLeftCell="${topLeft}" activePane="${active}" state="frozen"/><selection pane="${active}" activeCell="${topLeft}" sqref="${topLeft}"/>`;
    }
    out.push(`<sheetViews><sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews>`);
    out.push('<sheetFormatPr defaultRowHeight="15"/>');

    if (sheet.columns?.length) {
        out.push('<cols>');
        sheet.columns.forEach((c, i) => {
            out.push(`<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 12}" customWidth="1"${c.hidden ? ' hidden="1"' : ''}/>`);
        });
        out.push('</cols>');
    }

    out.push('<sheetData>');
    rows.forEach((row, r) => {
        const cells = [];
        row.forEach((cell, c) => {
            if (cell === null || cell === undefined) { return; }
            const value = typeof cell === 'object' ? cell.v : cell;
            const style = typeof cell === 'object' && cell.s !== undefined ? cell.s : (sheet.columns?.[c]?.style ?? STYLE.text);
            const ref = `${columnName(c)}${r + 1}`;
            if (value === null || value === undefined || value === '') {
                cells.push(`<c r="${ref}" s="${style}"/>`);
            } else {
                cells.push(`<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${encodeText(value)}</t></is></c>`);
            }
        });
        out.push(`<row r="${r + 1}">${cells.join('')}</row>`);
    });
    out.push('</sheetData>');
    if (sheet.autoFilter && rows.length) { out.push(`<autoFilter ref="A1:${lastRef}"/>`); }
    out.push('</worksheet>');
    return { xml: out.join('\n'), filterRef: sheet.autoFilter && rows.length ? `$A$1:$${columnName(width - 1)}$${rows.length}` : null };
}

/**
 * A workbook from `sheets`: [{ name, rows: [[cell]], columns?: [{ width, hidden, style }],
 * freeze?: { columns, rows }, autoFilter?: bool, hidden?: bool }]. A cell is a string, null,
 * or { v, s } with s a STYLE id. Cells without a style take their column's style.
 */
export function writeWorkbook(sheets) {
    const firstVisible = Math.max(0, sheets.findIndex((s) => !s.hidden));
    const built = sheets.map((s, i) => sheetXml(s, i === firstVisible));
    const quoteName = (n) => `'${n.replace(/'/g, "''")}'`;
    const defined = built
        .map((b, i) => (b.filterRef ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${escAttr(`${quoteName(sheets[i].name)}!${b.filterRef}`)}</definedName>` : ''))
        .filter(Boolean);

    const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">
<bookViews><workbookView activeTab="${firstVisible}"/></bookViews>
<sheets>${sheets.map((s, i) => `<sheet name="${escAttr(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets>
${defined.length ? `<definedNames>${defined.join('')}</definedNames>` : ''}
</workbook>`;

    const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_PKG_REL}">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>
</Relationships>`;

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

    return writeZip([
        { name: '[Content_Types].xml', data: contentTypes },
        { name: '_rels/.rels', data: rootRels },
        { name: 'xl/workbook.xml', data: workbook },
        { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
        { name: 'xl/styles.xml', data: STYLES_XML },
        ...built.map((b, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: b.xml })),
    ]);
}

// Elements may carry a namespace prefix (x:row) when another tool saved the file.
const P = '(?:[A-Za-z][\\w.-]*:)?';
const attrsOf = (s) => Object.fromEntries([...(s ?? '').matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], decodeText(m[2])]));
const textRuns = (xml) => [...xml.replace(new RegExp(`<${P}rPh\\b[\\s\\S]*?</${P}rPh>`, 'g'), '')
    .matchAll(new RegExp(`<${P}t\\b[^>]*?(?:/>|>([\\s\\S]*?)</${P}t>)`, 'g'))]
    .map((m) => decodeText(m[1] ?? '')).join('');

/**
 * The sheets of an .xlsx: [{ name, hidden, rows }] where rows[r][c] is null or { v, t } —
 * v the text as shown, t the cell type ('s' text, 'n' number, 'b', 'e', 'str').
 */
export function readWorkbook(buf) {
    const zip = readZip(buf);
    const workbook = zip.text('xl/workbook.xml');
    if (!workbook) { throw new Error('not an Excel workbook (xl/workbook.xml is missing)'); }
    const rels = Object.fromEntries([...(zip.text('xl/_rels/workbook.xml.rels') ?? '').matchAll(new RegExp(`<${P}Relationship\\b([^>]*)/?>`, 'g'))]
        .map((m) => attrsOf(m[1])).map((a) => [a.Id, a.Target]));
    const shared = [...(zip.text('xl/sharedStrings.xml') ?? '').matchAll(new RegExp(`<${P}si\\b[^>]*?(?:/>|>([\\s\\S]*?)</${P}si>)`, 'g'))]
        .map((m) => textRuns(m[1] ?? ''));

    const sheets = [];
    for (const m of workbook.matchAll(new RegExp(`<${P}sheet\\b([^>]*?)/?>`, 'g'))) {
        const a = attrsOf(m[1]);
        const relId = a['r:id'] ?? Object.entries(a).find(([k]) => k.endsWith(':id'))?.[1];
        let target = rels[relId];
        if (!target) { continue; }
        target = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
        const xml = zip.text(target) ?? '';
        const rows = [];
        let nextRow = 0;
        for (const rm of xml.matchAll(new RegExp(`<${P}row\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${P}row>)`, 'g'))) {
            const ra = attrsOf(rm[1]);
            const r = ra.r ? Number(ra.r) - 1 : nextRow;
            nextRow = r + 1;
            const row = [];
            let nextCol = 0;
            for (const cm of (rm[2] ?? '').matchAll(new RegExp(`<${P}c\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${P}c>)`, 'g'))) {
                const ca = attrsOf(cm[1]);
                const col = ca.r ? columnIndex(ca.r.replace(/\d+$/, '')) : nextCol;
                nextCol = col + 1;
                const body = cm[2] ?? '';
                const t = ca.t ?? 'n';
                const vm = new RegExp(`<${P}v\\b[^>]*>([\\s\\S]*?)</${P}v>`).exec(body);
                let v = null;
                let type = t;
                if (t === 's') { v = vm ? (shared[Number(vm[1])] ?? '') : null; }
                else if (t === 'inlineStr') { const im = new RegExp(`<${P}is\\b[^>]*>([\\s\\S]*?)</${P}is>`).exec(body); v = im ? textRuns(im[1]) : null; type = 's'; }
                else { v = vm ? decodeText(vm[1]) : null; }
                if (v === null) { continue; }
                while (row.length < col) { row.push(null); }
                row[col] = { v, t: type };
            }
            while (rows.length < r) { rows.push([]); }
            rows[r] = row;
        }
        sheets.push({ name: a.name, hidden: a.state === 'hidden' || a.state === 'veryHidden', rows });
    }
    return sheets;
}
