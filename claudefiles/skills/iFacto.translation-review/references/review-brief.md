# Review brief — one chunk of translations

You review and translate one chunk of the translatable strings of a Business Central app, in
every target language of the review. A consultant then goes through your verdicts with the
customer in Excel: your verdicts decide what the customer has to look at. Be strict, but do not
create noise.

You run as a subagent: you cannot ask anyone anything. When something is unclear, decide what
you can, mark the rest `twijfel`, and say it in your final report.

`<work>` and `NN` below come from your assignment. The script is
`node ~/.claude/skills/iFacto.translation-review/scripts/translation-review.mjs` — always run it
with `node`.

## Read first

1. `~/.claude/skills/iFacto.translation-review/references/conventions.md` — how BC is translated
   per language. Follow it.
2. `<work>/glossary.json` — the agreed terms. `terms[].<lang>` is the translation to use, `match`
   lists the English forms, `note` explains. A term the customer decided (`decided` set) is
   binding.
3. `<work>/review/in-NN.json` — your chunk. Do not change it.

## Input

A JSON array, one object per string (trans-unit), grouped per AL object:

| Key | Meaning |
|---|---|
| `id` | trans-unit id — copy it verbatim |
| `src` | the English source |
| `ctx` | generator note: object, element, property (`TableExtension Sales Header Ext - Field Delivery Method - Property Caption`) |
| `cat` | `veld` field caption · `enum` enum value · `actie` action · `caption` other caption · `tooltip` · `melding` message, error, question, label |
| `dev` | developer comment, often explains the placeholders (optional) |
| `maxw` | maximum length (optional) |
| `ph` | the placeholders of the source (optional) |
| `<lang>` | per language: `cur` the current translation (null = none), `st` its state, `oldsrc` the old English when the source changed since it was translated, `ms` the standard BC translation of exactly this English, `other` the translation another app (DistriApps, iFacto) uses |

States: `translated` (set by someone — still not necessarily right), `needs-review-*` (machine
translated and never reviewed — expect literal nonsense), `needs-translation`,
`needs-adaptation`, `missing` (not in the translation file at all).

## Output

One object per input string, every language present:

```json
{"id":"<id>","nl-BE":{"v":"ok"},"fr-BE":{"v":"fout","p":"Mode de livraison","r":"« Méthode de diffusion » n'est pas une notion de livraison"}}
```

`v`, the verdict:

| Verdict | When | `p` | `r` |
|---|---|---|---|
| `ok` | The current translation is right, natural, and follows the glossary and conventions | — | — |
| `stijl` | The meaning is right; only a cosmetic fix: capitals, typo, spacing, punctuation, tooltip phrasing. The customer does not review these | fixed text | short reason |
| `nieuw` | No usable current translation (null, empty, or the English left in) | your translation | only when worth knowing |
| `fout` | Wrong meaning, a literal machine translation that reads wrong, English left in, a term that deviates from the glossary or standard BC, a stale translation (`oldsrc` set and no longer matching), a broken placeholder | correct text | why |
| `twijfel` | Only someone who knows the customer's business can decide: an ambiguous English you cannot resolve from the context, or a term choice for the customer | your best proposal | what the customer must decide |

- `r`, the reason: **in the language of that target** (Dutch for nl-BE, French for fr-BE, …),
  one concrete sentence of at most 15 words: "« Wksh. » est une feuille, pas une semaine",
  "wijkt af van standaard BC: Verzendcode".
- Optional `dev`: a note for the developers about the **English** or the code, not the
  translation — a label that must be `Locked = true` (a value written to a file), a typo or a
  wrong word in the English, a tooltip that describes something else than its field. Write it
  in English.

## Rules

1. **Glossary first.** Use the glossary term, also inside longer strings. Never mark a string
   `twijfel` only because it contains a glossary term — that decision is made on the glossary.
2. **Standard BC next.** Where `ms` is set, prefer it for captions unless the glossary says
   otherwise. `other` is a hint, not an authority: DistriApps translations are sometimes wrong.
   For phrases, look them up:
   `node ~/.claude/skills/iFacto.translation-review/scripts/translation-review.mjs tm --work "<work>" --lang fr-BE "Ship-to Code"`
3. **Context before twijfel.** Read the tooltip and the other strings of the same object
   first; most ambiguity resolves there ("Ship" next to "Truck" is the vessel, not the verb).
4. **Consistency within your chunk.** The same English in the same kind of string gets the same
   translation. A field caption and the page control that shows it are the same thing.
5. **Technical validity.** Placeholders, option commas, maximum length, leading and trailing
   spaces — the validator rejects anything else (see conventions.md).
6. **A blank source** (an empty enum value) is not in your chunk: it needs no translation.
7. **`ok` is a real verdict**: only when you would sign it yourself.

## Process

1. Read the brief, the conventions, the glossary and your chunk.
2. Write your verdicts in part files of at most 60 strings, in order:
   `<work>/review/tmp-NN/part-01.json`, `part-02.json`, … — each a JSON array of output
   objects. Write them with the Write tool, or generate them with a short script; copy every
   `id` from the input, never retype it.
3. Join and validate:

   ```bash
   node ~/.claude/skills/iFacto.translation-review/scripts/translation-review.mjs join --work "<work>" --chunk NN
   node ~/.claude/skills/iFacto.translation-review/scripts/translation-review.mjs validate --work "<work>" --chunk NN
   ```

4. Fix every problem in the part files, join and validate again. You are done only at
   **0 problems** with every string covered.
5. End with a short report:
   - the verdict counts per language;
   - at most eight notable findings (patterns, recurring wrong terms, broken placeholders);
   - every `dev` note, one line each;
   - terms you would add to the glossary, with your proposal per language.

Never edit `in-NN.json`, another chunk's files, or any XLF file.
