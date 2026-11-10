---
name: iFacto.translation-review
description: 'Review and complete the translations of a Business Central app (the XLF files: nl-BE, fr-BE or any target language) with AI, let the customer confirm them in an Excel workbook — no Claude licence needed — and write the result back to the translation files. Use when: "vertalingen nakijken", "review the translations of this app", "translate the missing captions", "vertalingen laten nakijken door de klant", "export the translations to Excel", "import the translations the customer sent back", "a translation round for this customer". Scripts do the file work; never edit XLF files by hand.'
---

# iFacto.translation-review — translations the customer signs off in Excel

The translations of a customer app drift: strings that never reached the nl-BE or fr-BE file,
machine translations nobody read ("Wksh." as week), broken placeholders, one concept translated
three ways, and a field that reads differently from the standard field next to it. Code review
does not catch any of it — a PR with only translation files is approved without review. This
skill is that review: AI judges and completes every string, the customer confirms in Excel, and
the import writes it back with technical checks.

## Required toolset

No MCP server. The skill needs Node 18+, git, the AL compiler (the AL command-line tool
`al compile`, or a build in VS Code) and the project's `.alpackages` for the reference
translations of standard BC and DistriApps.

The app must generate a translation file: `"features": ["TranslationFile"]` in `app.json`.
Without it there is no `.g.xlf` — stop and say so; adding it is a code change for a ticket.

## The flow

| Step | Who | What |
|---|---|---|
| 1. Snapshot | developer + Claude | the strings of `origin/master`, the current translations, the reference translations |
| 2. Glossary | Claude | built during the run: the key terms with a proposal per language |
| 3. Terms round — optional | customer | chooses the terms in Excel first, only when asked for |
| 4. Review | Claude (subagents) | a verdict and a proposal for every string, with the glossary |
| 5. Customer round | customer | checks the texts in Excel, starting with the focus rows |
| 6. Import | Claude | validates the workbook and rewrites the XLF files |
| 7. Build and hand over | developer | compile, then `/iFacto.Pullrequest` |

Nobody prepares the glossary: step 2 builds it during the run, from the standard BC and
DistriApps translations and the app's own strings. It keeps the parallel reviewers consistent —
one concept, one translation — and the customer sees it in the workbook as information.

By default the customer gets **one workbook** (step 5). The terms round (step 3) is optional: run
it only when the developer asks for it, for instance for an app with many of the customer's own
concepts. Objections to a term then come back in the Opmerking column of step 5; carry them into
the glossary for the next round.

A customer round takes days. It ends the session's work: hand over the workbook and stop.

## The work folder

Every step reads and writes one folder, by default
`~/Downloads/translation-review/<app>-<date>/` (`--work` to choose another). It holds the
snapshot, the reference translations, `glossary.json`, the review and the workbooks, and it
outlives the session — give the developer its path at every step.

It holds customer texts and internal verdicts: it never goes into a repository, and only the
workbooks go to the customer.

Every command runs the one script with `node`; the file is not executable. Quote every path:
a Windows profile path can hold a space.

## Procedure

### 1. Snapshot of origin/master

Review what is on master, not a feature branch. In a worktree, so the developer's checkout is
untouched:

```bash
git -C "<repo>" fetch origin
git -C "<repo>" worktree add --detach "<scratchpad>/tr-master" origin/master
cp -r "<repo>/<App>/.alpackages" "<scratchpad>/tr-master/<App>/"
al compile "/project:<scratchpad>/tr-master/<App>" "/packagecachepath:<scratchpad>/tr-master/<App>/.alpackages" "/out:<scratchpad>/tr-master.app"
node ~/.claude/skills/iFacto.translation-review/scripts/translation-review.mjs snapshot --project "<scratchpad>/tr-master/<App>"
git -C "<repo>" worktree remove --force "<scratchpad>/tr-master"
```

No AL command-line tool: let the developer check out an up-to-date master and build it in
VS Code, run `snapshot --project "<repo>/<App>"` on that, and say so in the report.

- `--langs nl-BE,fr-BE` limits the languages; `--add-lang es-ES` adds one that has no file yet.
- The output gives, per language, the states (`missing` = not in the file at all), the strings
  whose English changed since they were translated (`stale`), and how many strings have an exact
  standard-BC or DistriApps translation (`refMatches`). `referencePackages: 0` means there are
  no symbols in `.alpackages`: download them first, or the review works without a reference.

### 2. Glossary

```bash
node ~/.claude/skills/iFacto.translation-review/scripts/translation-review.mjs terms --work "<work>"
```

The first run seeds `<work>/glossary.json` with the project's own glossary
(`<App>/translation-glossary.json`, from earlier rounds) and the generic BC terms that occur in
the app. It prints them with their counts, and `candidates`: frequent words and phrases in the
captions with their standard-BC and DistriApps translation.

Complete the glossary with the Edit tool:

- Add the customer's own concepts from the candidates, words that are ambiguous here (Agent,
  Ship, Batch), and terms the app now translates in several ways. Aim for 30–80 terms; more is
  noise for the customer.
- Per term and language: the standard-BC translation first, the DistriApps one when it is
  right, else your own proposal. A `note` in Dutch when the choice needs explaining.
- Shape of a term: `{"key": "delivery-method", "en": "Delivery Method", "match": ["Delivery
  Method"], "nl-BE": "Leveringswijze", "fr-BE": "Mode de livraison", "note": "…"}` — `match`
  lists the English forms to find it by (default: `en`).

### 3. Terms round — optional

Only when the developer asks for it. Otherwise go on with step 4: the glossary from step 2 is used
as it is.

```bash
node ~/.claude/skills/iFacto.translation-review/scripts/translation-review.mjs export --work "<work>" --round terms
```

Give the developer the workbook path. It is meant for a short session with the customer; share
it as one file (Teams, SharePoint), not as mailed copies. Stop here.

When it comes back:

```bash
node ~/.claude/skills/iFacto.translation-review/scripts/translation-review.mjs import-terms --work "<work>" --xlsx "<file>" --project "<repo>/<App>"
```

The chosen terms go into `glossary.json` and into `<App>/translation-glossary.json`. Report the
changed terms and the remarks.

### 4. Review

```bash
node ~/.claude/skills/iFacto.translation-review/scripts/translation-review.mjs chunk --work "<work>"
```

`--scope open` for a later round: only strings without a finished translation or with a changed
English. The review then holds only those strings, and the customer workbook shows only them. Then start **one general-purpose subagent per chunk, all in one message,
`model: "sonnet"`**, each with this prompt:

```
Review chunk <NN> of a Business Central translation review.
Read and follow ~/.claude/skills/iFacto.translation-review/references/review-brief.md exactly.
<work> = <absolute path of the work folder>, NN = <NN>.
Finish only when validate reports 0 problems, then end with the report the brief describes.
```

Do not read their transcripts. When a report shows a gap that affects the chunks still running
— a missing glossary term, a misread rule — fix the glossary and tell the running ones.

When all are done:

```bash
node ~/.claude/skills/iFacto.translation-review/scripts/translation-review.mjs merge --work "<work>"
```

- `incomplete`: a chunk has no output or does not validate. Run that chunk again with a new
  subagent, then merge again.
- The merge gives the same English the same translation, by majority, and lists what it
  aligned in `review/inconsistencies.json`. Where the majority is wrong (glossary, standard
  BC), put the right text in `review/choices.json` — `{"nl-BE|Delivery Method": "Leveringswijze"}`
  — and merge again.
- `review/developer-findings.json` holds what the reviewers found in the English or the code: a
  label that must be `Locked = true`, a wrong English text. Report it to the developer as a
  separate list; it is not for the customer.

Report the verdict counts and the focus rows per language.

### 5. Customer round — the texts

```bash
node ~/.claude/skills/iFacto.translation-review/scripts/translation-review.mjs export --work "<work>" --round texts
```

Tell the developer the workbook path, the number of focus rows per language, and who has to
check each language: a language nobody at the customer checks goes in as our proposal,
unchecked. Share it as one file. Stop here.

### 6. Import

When the workbook is back, on a new branch from an up-to-date master of the customer repo.
Compile first, so the `.g.xlf` matches that branch. Then:

```bash
node ~/.claude/skills/iFacto.translation-review/scripts/translation-review.mjs import --work "<work>" --xlsx "<file>" --project "<repo>/<App>" --dry-run
```

Report per language: rows, proposals taken, texts changed by the customer, and:

- **rejected** — the text breaks a placeholder, the option count, the maximum length or the
  spacing; or Excel stored it as a number or date. Show them with the reason; they stay as they
  are until the workbook is corrected and imported again.
- **conflicts** — the English changed since the export. Never overwritten: they go to the next
  round.
- **removed** — no longer in the app.
- **stale** — existing translations kept although their English changed (conflicts, rejected or
  empty rows). A file with states marks them `needs-adaptation`; a file without states cannot,
  so `unmarked` counts them. List them: they go to the next round.
- **dropped** — translations of strings the `.g.xlf` no longer has. Normal for strings removed
  from the app; many of them mean the `.g.xlf` was compiled from another branch.
- **warnings** — a workbook without `_meta`, a tab that is not a language and was ignored.

Then run it without `--dry-run`, adding `--allow-drop` once the dropped list is confirmed — the
import refuses to drop translations without it. Every language is built before any file is
written. Each translation file is rewritten from the `.g.xlf`: every string in `.g.xlf` order,
untouched translations kept byte for byte, strings missing so far added, dropped ones gone. The
glossary goes into `<App>/translation-glossary.json`, so the next round starts from the same terms.

The remarks (`Opmerking`) are in the report. Read them before the commit:

- A remark that objects to a term: change that term in `<App>/translation-glossary.json` (or
  add a `note`), so the next round does not propose it again.
- Texts of standard BC or DistriApps that the customer wants changed are not in this app's
  translation files: collect them for a separate ticket.

### 7. Build and hand over

- Compile again: 0 errors.
- `git diff --stat`: only `Translations/*.xlf` and `translation-glossary.json`. Restore anything
  else the build rewrote (report layouts, for instance).
- Do not commit. The developer continues with `/iFacto.Pullrequest`.

## Hard rules

- **Never edit an XLF file by hand** or with Edit for these changes: the import writes them, after
  its checks.
- **Never overwrite a translation whose English changed** since the export.
- **Never change a customer's text silently.** A rejected text is reported, not repaired.
- **Only the workbooks go to the customer** — never the work folder.
- **No customer data in BCCompanyGuidelines.** This skill is published; a customer's terms
  live in the customer repo (`translation-glossary.json`).
- **Subagents on Sonnet.** The review is broad, not deep; the validator guards the format.

## Limits

- **Reference per language.** The packages decide which languages have a standard-BC reference.
  In a Belgian project the Base Application carries nl-BE and fr-BE only, DistriApps nl-BE,
  fr-BE and nl-NL, System Application and Business Foundation about 25 languages. Spanish in a
  Belgian project therefore gets few references and more `twijfel`.
- **Style is not validated.** The import checks what breaks Business Central; capitals or
  wording the customer typed go in as typed.
- **States.** A translation file that uses `state` attributes gets `translated` for every
  imported text and `needs-translation` for new strings; a file without states stays without.
- **Headers.** The import reads the workbook by column name: renamed or deleted headers stop it.
