---
name: bebo-docs
description: >-
  Turn a Markdown document into a Bebo-huisstijl HTML + PDF deliverable (red
  #E30613 title page, numbered chapters, styled tables), and lay documents out
  according to Bebo's internal FO/TO standard. Use this whenever the task
  involves a functioneel ontwerp (FO), technisch ontwerp (TO), or any document
  that has to be shared with the MT, a stakeholder, or a supplier as a PDF —
  and whenever Dennis asks to convert, restyle, or rebuild a .md in "de Bebo
  stijl" / "huisstijl".
---

# Bebo-documenten — Markdown naar huisstijl-PDF

Two things live in this skill:

1. **A builder** — `scripts/build-bebo-pdf.mjs` converts one Markdown file into
   a branded `.html` and `.pdf` next to it.
2. **The document standard** — how a Bebo FO or TO is laid out, so a generated
   document looks like the ones the organisation already signs off on.

## Building

```
node <skill>/scripts/build-bebo-pdf.mjs <document.md>
```

- Writes `<document>.html` **and** `<document>.pdf` beside the source. One
  command; no separate Edge step.
- `--no-pdf` stops after the HTML (useful while iterating on content).
- `--logo <pad.png>` overrides `assets/bebo-logo.png` (e.g. another Bebo label).
- The PDF is rendered by headless Edge or Chrome. Without either, the HTML is
  still written and the script prints the exact command to render it manually.
- Node only — no npm install, no dependencies.

After every content change, **re-run the builder**: the `.html` and `.pdf` are
generated artifacts and go stale silently.

## Front matter drives the title page

```markdown
---
title: Functioneel Ontwerp
subject: Nieuw CRM — Bebo Groep
version: 1.0
status: Concept — ter accordering MT
date: 10-08-2026
authors: Dennis Stedema & Jan Anne de Haan
---
```

`title` is what triggers the title page; `subject`, `version`, `status`, `date`
and `authors` are optional lines on it. Omit the front matter entirely and the
document starts with just the logo — the older, plainer look.

Dates in front matter are for people, so write them Dutch-style (`10-08-2026`).

## Markdown the builder understands

`#`–`####` headings, paragraphs, `**bold**`, `*cursief*`, `` `code` ``, links,
bullet and numbered lists (nested, and wrapped continuation lines), tables,
blockquotes, fenced code blocks, `---` rules, and `<!-- page -->` to force a
page break.

Layout rules baked into the CSS:

- **Every `##` starts a new page.** So `##` = chapter, `###` = paragraph,
  `####` = sub-paragraph. Don't use `##` for something small.
- Tables and code blocks never split across pages. A big table therefore pushes
  itself to the next page and leaves white space above — that is the trade-off,
  and it is the right one for a signed document.
- There is **no running footer and no page numbers**. Chromium places
  `position: fixed` unreliably when printing (it lands at the top of the page,
  over the heading). Don't try to re-add it with CSS; if page numbers ever
  become a hard requirement, that needs a real PDF library, not this script.

Known limitations of the parser — work around them, don't fight them:

- A **blockquote is flattened into one paragraph**: bullets inside a `>` block
  lose their list. Put long enumerations outside the quote.
- No images, footnotes, task lists, or heading anchors.
- No automatic chapter numbering or table of contents with page numbers.

Two authoring traps, both learned the hard way:

- **Never break a word across source lines with a hyphen**
  (`oplossings-\nrichtingen`). The builder joins lines with a space, so it
  prints as "oplossings- richtingen". Keep the word whole.
- **Blank line inside a list = two lists.** Keep list items adjacent.

## Verify before delivering

A document that will be signed deserves a look, not a hope. Render a few pages
to PNG and actually read them — title page, one page with a big table, and the
last page:

```
python -m pip install --quiet pymupdf
python -c "import pymupdf; d=pymupdf.open('doc.pdf'); print(d.page_count); [d[n].get_pixmap(dpi=95).save(f'_check_p{n+1}.png') for n in (0,3,9)]"
```

Check the images, then delete them. Three real layout bugs (invisible white
title, footer over the heading, orphaned list continuations) only surfaced this
way — never from reading the Markdown.

## The Bebo FO standard

Bebo's suppliers (GAC) deliver functional designs in a fixed shape, and our own
documents follow it so they read as equivalents. Reference: `Bebo Mollie FO
v2.1.pdf`. Structure:

1. Title page
2. **Documentinformatie** + **Versiebeheer** (version, date, authors, remarks)
3. **Inhoudsopgave**
4. `1 Inleiding` — inleiding, aanpak, waarom dit document
5. `2 Huidige situatie en probleemstelling`
6. `3 …` — the functional content
7. `… Testscenario's` — tables with `Nr. | Teststap | Verwacht resultaat`
8. `… Accordering` — signature block plus the rule that changes need a new
   revision or a new FO
9. Bijlagen

Number chapters manually in the heading text (`## 3 Kosten`) — the builder does
not number anything.

## FO 1.0 and FO 2.0 — Bebo's internal pro forma

An FO has **two stages**, and they are kept apart on purpose: no design effort
goes into an option the MT has not chosen yet.

**FO 1.0 — de keuzenota.** Sections, in this order:

- Welk probleem lossen we op
- Welke keuzes hebben we
- Opties met voor- en nadelen
- Kosten
- Tijdsbestek
- Lange termijn versus korte termijn
- Advies ontwikkelgroep
- Voorleggen ter accordering aan MT
- Akkoord MT op welke keuze

**FO 2.0 — de uitwerking** of the chosen option:

- Optie uitgewerkt
- Mogelijkheden
- Scope: wat wel en **wat zeker niet**

Writing guidance that makes these land:

- **Give every option a voor-/nadelentabel**, including a **nul-optie** ("niets
  doen"). A decision memo without a baseline reads as a sales pitch.
- **Name the downsides of the advised option** in its own words. For in-house
  builds that means maintenance load and knowledge concentration — put it in
  the risk table and ask the MT to accept it explicitly.
- **Mark every unverified number as indicative** and park the assumptions in an
  appendix. A list price found online is not a quote.
- Keep the MT ask concrete: a numbered table of decisions with the development
  group's recommendation per row.
- Leave the MT decision section **empty** until the MT has actually decided, and
  say in the document that the FO 2.0 chapter is conditional until then. Never
  fill in an approval that has not happened.
- Write for stakeholders, not developers: plain Dutch, technical choices go in
  the separate TO.

`templates/functioneel-ontwerp.md` is this structure as an empty skeleton —
copy it and fill it in. Worked example: `C:\Jarvis\Functioneel-Ontwerp-CRM.md`.

## Where documents live

Deliverables are generated next to their Markdown source. In the JARVIS repo
the FO/TO files and their artifacts are deliberately in `.gitignore` — company
deliverables, not JARVIS source. Keep it that way, and keep the `.md` as the
single source of truth: never hand-edit the generated `.html`.
