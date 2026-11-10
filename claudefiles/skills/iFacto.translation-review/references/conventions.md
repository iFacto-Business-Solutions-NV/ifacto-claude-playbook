# Translation conventions — how Business Central is translated

> **Temporary location.** These conventions are company rules and belong in the iFacto
> BCQuality fork (`custom/knowledge/`, a translation domain). Until that article exists they
> live here, so the review works. When the article lands, replace this file with a pointer to
> it — do not keep two copies.

The yardstick is how Microsoft translates standard Business Central in the same language. A
field of a customer app sits next to standard and DistriApps fields on the same page; it has
to read the same way. When in doubt, look up how standard BC phrases a similar string:

```bash
node ~/.claude/skills/iFacto.translation-review/scripts/translation-review.mjs tm --work "<work>" --lang nl-BE "Ship-to Code" "Specifies the"
```

## Every language

- **Placeholders stay exactly as they are**: `%1`, `%2`, `#1#####`, `@1@@@`, and every
  backslash `\` (a line break in an AL message). Same set, same count. Their order may change
  when the sentence needs it.
- **Option captions** (`OptionCaption`): the same number of commas as the English, an empty
  option stays empty. A different count shifts every option after it.
- **Maximum length** (`maxw`): never longer.
- **Leading and trailing spaces** as in the English.
- **Keep acronyms and names** as they are: EDI, API, JSON, XML, URL, ID, GLN, GTIN, EAN, VAT
  number formats, WMS, PEPPOL, Intrastat, product names and company names.
- **Not language**: codes, JSON keys, URL schemes, file names, values written to a file or
  sent to another system. These must not be translated — propose the English unchanged and
  add a `dev` note that the label should be `Locked = true`.
- **API pages** (objects whose name starts with "API") are read by programs, not people:
  keep the English unless the page is shown to users.
- **Sentence case** for captions: only the first word and proper names get a capital.
  "Toon volledig gereserveerd op voorraad", not "Toon Volledig Gereserveerd Op Voorraad".
- **Keep the abbreviation level** of the English: a short caption stays short.
- **Messages and questions** address the user formally.

## nl-BE

- Formal **u**: "Wilt u doorgaan?".
- **No.** becomes **nr.**, glued to the noun: "Klantnr.", "Documentnr.", "Verzendbewijsnr.".
  "No. of …" is "Aantal …".
- **Qty.** becomes **Aantal**.
- Compounds are written as one word ("Verkooporderregel"); with an abbreviation or acronym a
  hyphen ("btw-nummer", "EDI-bericht").
- **btw** in lower case mid-sentence, **Btw** at the start of a caption.
- **Tooltips** as standard BC writes them:
  - "Specifies …" → "Hiermee wordt … opgegeven." — "Specifies the number of the customer." →
    "Hiermee wordt het nummer van de klant opgegeven."
  - "Specifies the value of the X field." → "Hiermee wordt de waarde van het veld X opgegeven."
    with X the translated caption.
  - For other patterns, look up a standard tooltip that starts the same way.
  - Keep the closing period.

## fr-BE

- Formal **vous**: "Voulez-vous continuer ?".
- **No.** becomes **N°** in front: "N° client", "N° document".
- **Qty.** becomes **Qté**.
- **Tooltips** as standard BC writes them:
  - "Specifies …" → "Spécifie …".
  - "Specifies the value of the X field." → "Spécifie la valeur du champ X." with X the
    translated caption.
- The straight apostrophe `'`, as standard BC uses it — not the typographic `’`.
- Spacing before `:` `;` `?` `!` and the form of quotation marks: follow the standard BC
  reference for the same kind of string.

## Other languages

No iFacto conventions yet. Follow the standard BC translation of that language: look up
captions and tooltips of the same shape with `tm` and copy their style. Say in the reason when
a choice is uncertain.
