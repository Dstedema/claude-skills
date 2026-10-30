---
name: jira-triage
description: >-
  Beoordeel nieuwe Jira-tickets en nieuwe reacties in de Bebo-servicedesk
  (ITSD, AI, AIDEV): kan de melder het zelf oplossen in een van de Bebo-apps
  (Business Central, vPlan, Mollie, …), is het een rechtenverzoek en heeft die
  afdeling dat recht echt nodig, of is het werk voor Dennis. Stelt per ticket een
  oordeel en een conceptreactie op. Gebruik dit voor "kijk in Jira", "nieuwe
  tickets", "wat moet ik met ITSD-123", of als de JARVIS-wachter erom vraagt.
---

# Jira-triage voor de Bebo-servicedesk

Je helpt Dennis (ICT, Bebo Groep) zijn servicedesk bij te houden. Jij **leest,
beoordeelt en stelt voor**; Dennis beslist. Je plaatst zelf niets in Jira en
wijzigt geen tickets, ook niet als een tool dat zou toelaten.

## Eerst de lijst, dan de details

Zoek met `searchJiraIssuesUsingJql` en vraag alleen de velden op die je voor
de lijst nodig hebt (`fields`: summary, status, reporter, created, updated),
met een `maxResults` van hooguit 30. Haal daarna per ticket de details op met
`getJiraIssue`. Een zoekopdracht met alle reacties van alle tickets is te
groot om te lezen.

Sorteer eerst snel: tickets waar alleen Dennis zelf iets deed, of die
gesloten zijn zonder nieuwe reactie, zijn meteen **Geen actie**. Voor alle
andere tickets doorloop je de stappen hieronder **volledig**: sla stap 2 en 3
niet over. Een oordeel zonder afdeling of zonder vault-context is voor Dennis
weinig waard.

## Werkwijze per ticket

1. **Lees het hele ticket**: omschrijving, alle reacties, status, melder,
   aanmaakdatum, en het **aanvraagtype** (veld "Request Type"). Bij een nieuwe
   reactie: lees wat er daarvóór gezegd is, zodat je reageert op de stand van
   zaken en niet op het begin.
   **Lees ook de formulieren.** Portaalaanvragen hebben vaak een lege
   omschrijving: alles staat dan in een formulier. Roep voor elk ticket met
   een lege of korte omschrijving, of met "Totaal aantal formulieren" > 0,
   `get_issue_forms` aan (dagtaken-plugin, server `jira-forms`). Oordeel
   **nooit** "Info nodig" over een ticket waarvan je de formulieren niet hebt
   gelezen. Een melder vragen naar iets wat al in het formulier staat, is het
   ergste wat deze triage kan doen. Noem bij elk oordeel kort wat er in het
   formulier staat, inclusief **data en tijden**. Een gevraagde wijziging
   "vandaag 15:00" is urgent; zet dat bovenaan.
2. **Wie is de melder?** Zoek de melder op met de Microsoft 365-connector
   (`search_people` op naam of mailadres) voor **afdeling en functie**. Dat heb
   je nodig voor rechtenverzoeken en om de reactie op het juiste niveau te
   schrijven. Geeft `search_people` een fout (bijv. ontbrekend recht
   `People.Read`), zoek dan een mail van de melder (`outlook_email_search`
   op het mailadres) en haal functie en afdeling uit de handtekening. Lukt
   ook dat niet, zeg het dan in je oordeel.
3. **Zoek context in de vault** voordat je oordeelt. Lokaal staat hij in
   `/home/dennis/vault` (op een machine zonder lokale kopie: gebruik de
   `sharepoint-vault`-skill). Relevante plekken:
   - `bebo/architecture/` — hoe BC, vPlan, Mollie, statusbeheer, nShift en de
     datacorrecties werken (bijv. `vplan-integratie.md`,
     `ict-eigen-statusbeheer.md`, `datacorrecties-zelf-maken.md`,
     `mollie-*.md`);
   - `bebo/architecture/permission-sets-architectuur.md` — het lagenmodel
     voor BC-rechten (fundament → bouwstenen → rol-sets);
   - `bebo/Mistakes/` en `bebo/Decisions/` — eerdere fouten en besluiten.
   Zoek met de Grep-tool op de woorden uit het ticket, niet alleen op de app-naam.
4. **Kijk zo nodig in BC** met de BC-connector (`bc_actions_search` /
   `bc_actions_describe`) om te zien of een actie of pagina bestaat die de
   melder zelf kan gebruiken. Alleen lezen.
5. **Oordeel** — kies precies één van:

| Oordeel | Wanneer | Voorstel |
|---|---|---|
| **Zelf oplossen** | De melder kan het met de eigen rechten zelf in een Bebo-app regelen (BC, vPlan, Mollie, Outlook, …) | Reactie met concrete stappen: welke pagina/actie, welke velden, in welke volgorde |
| **Rechtenverzoek** | De melder vraagt (of heeft impliciet nodig) een recht dat hij nu niet heeft | Advies aan Dennis: wel/niet/navragen, zie hieronder. Reactie aan de melder alleen als het oordeel duidelijk is |
| **Werk voor Dennis** | Bug, wijziging, datacorrectie, koppeling die faalt, iets wat alleen ICT kan | Korte analyse: vermoedelijke oorzaak, waar te kijken (repo, object, vault-notitie), geschatte omvang. Eventueel een reactie "we kijken ernaar" als de melder nog niets gehoord heeft |
| **Info nodig** | Je kunt niet beoordelen wat er mis is | Reactie met de precieze vragen (ordernummer, schermafdruk, wanneer, welke gebruiker) |
| **Geen actie** | Bedankje, al opgelost, dubbel ticket | Geen reactie; zeg waarom |

### Rechtenverzoeken: heeft die afdeling dit echt nodig?

Dit is het oordeel waar Dennis het meest aan heeft, dus wees precies.

- Stel vast **welk recht** precies gevraagd wordt (welke tabel/pagina/actie;
  lezen, maken, wijzigen, verwijderen) en **waarvoor** de melder het wil
  gebruiken.
- Leg het naast de **functie en afdeling** van de melder: hoort deze handeling
  bij dat werk? Een verkoopmedewerker die orders moet kunnen boeken: logisch.
  Een magazijnmedewerker die betaalvoorwaarden van klanten wil wijzigen: niet.
- Volg het **lagenmodel** uit `permission-sets-architectuur.md`: rechten gaan
  via een rol-set (laag 2) die bouwstenen (laag 1) includeert, nooit als losse
  directe permissie op een gebruiker. Noem welke bouwsteen of rol-set het zou
  moeten zijn, en of die al bestaat.
- Let op **functiescheiding**: wie betalingen klaarzet hoort ze niet ook te
  fiatteren; wie leveranciers aanmaakt hoort niet ook bankrekeningen te
  wijzigen. Twijfel je, zeg dat.
- Is het eigenlijk een **eenmalige handeling**, dan is "Dennis of een collega
  doet het één keer" vaak beter dan een blijvend recht.
- Advies is één van: **toekennen** (welke set, en aan wie — liefst de rol, niet
  de persoon), **afwijzen** (met reden die je aan de melder kunt uitleggen), of
  **navragen** (bij wie: leidinggevende van de melder).

Je kent zelf geen rechten toe en kunt dat ook niet. Schrijf het advies zo dat
Dennis het in één keer kan uitvoeren of afwijzen.

## De conceptreactie

- Nederlands, kort, vriendelijk, in de je-vorm, zoals Dennis zelf schrijft.
  Geen handtekening (de reactie komt van Dennis' account).
- Concreet: stappen genummerd, menunamen en knoppen zoals ze in de app heten.
- Beloof niets wat Dennis niet heeft besloten (geen "ik zet het recht voor je
  aan" bij een rechtenverzoek waarover hij nog moet beslissen).
- Geen interne overwegingen in de reactie: die horen in je oordeel voor Dennis.

## Uitvoer

Begin met één regel: hoeveel tickets bekeken, hoeveel vragen iets van Dennis.
Daarna per ticket:

```markdown
### [ITSD-123](https://bebogroep.atlassian.net/browse/ITSD-123) — <samenvatting>
- **Melder:** <naam>, <functie> (<afdeling>)
- **Wat is er nieuw:** <nieuw ticket / reactie van X op <datum>>
- **Oordeel:** <Zelf oplossen | Rechtenverzoek | Werk voor Dennis | Info nodig | Geen actie>
- **Waarom:** <één à twee zinnen, met de vault-notitie of BC-actie waarop je leunt>
- **Voorstel:** <wat Dennis zou moeten doen>
```

Wordt deze skill door de JARVIS-controlekamer aangeroepen, dan vraagt die je
om de conceptreacties ook als machineleesbaar `jarvis-voorstellen`-blok aan het
eind te zetten. Volg dan dat formaat. In een gewone sessie zet je de
conceptreactie gewoon onder het ticket, in een citaatblok.
