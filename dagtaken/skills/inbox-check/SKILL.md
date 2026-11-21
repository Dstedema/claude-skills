---
name: inbox-check
description: >-
  Bekijk Dennis' Outlook-inbox op wat aandacht vraagt, zet waar nodig een
  antwoord klaar als Outlook-concept (nooit versturen) en geef een kort
  overzicht. Gebruik dit voor "check mijn mail", "wat is er binnengekomen",
  "moet ik nog iets beantwoorden", of als de JARVIS-wachter erom vraagt.
---

# Inbox-check

Je houdt Dennis' mail bij met de Microsoft 365-connector. Je **leest en zet
concepten klaar**; Dennis verstuurt zelf vanuit Outlook. Je verstuurt, verwijdert,
verplaatst of markeert niets, ook niet als een tool dat zou toelaten.

## Werkwijze

1. Haal de mail op uit de gevraagde periode (`outlook_email_search`). Lees
   alleen de volledige inhoud (`read_resource`) van berichten die er iets toe
   lijken te doen; nieuwsbrieven en meldingen herken je aan afzender en onderwerp.
2. Sorteer elk bericht in één van:
   - **Actie** — iemand vraagt Dennis iets, wacht op hem, of er gaat iets mis
     (storingsmelding, mislukte koppeling, factuur die vastzit).
   - **Ter info** — goed om te weten, geen actie.
   - **Ruis** — nieuwsbrieven, automatische meldingen zonder fout, marketing.
3. Bij **Actie**:
   - Hoort het eigenlijk in Jira (een verzoek of storing van een collega)? Zeg
     dat, en noem het ticket als het al bestaat (zoek met de Atlassian-connector).
   - Is het antwoord duidelijk uit de mail, de vault (`/home/dennis/vault`) of
     Jira, zet dan een **conceptantwoord** klaar met `outlook_create_reply_draft`
     (HTML, `bodyType: "html"`). Nederlands of de taal van de afzender, kort en
     zakelijk-vriendelijk, zoals Dennis schrijft. Geen handtekening toevoegen als
     Outlook die zelf al plaatst.
   - Is het antwoord niet duidelijk, schrijf dan geen concept maar zeg wat
     Dennis moet beslissen.
4. Uitnodigingen voor afspraken: noem ze, maar beantwoord ze niet.

## Uitvoer

```markdown
**<n> berichten, <m> vragen iets van je, <k> concepten klaar.**

### Actie
- **<afzender>** — <onderwerp> · <wat er gevraagd wordt> · <concept klaar / beslissing nodig: …>

### Ter info
- **<afzender>** — <onderwerp>: <één regel>
```

Ruis noem je niet, alleen het aantal. Is er niets dat aandacht vraagt, zeg dat
in één zin.
