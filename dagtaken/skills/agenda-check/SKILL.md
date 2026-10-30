---
name: agenda-check
description: >-
  Bekijk Dennis' Outlook-agenda voor vandaag en morgen: conflicten, afspraken
  die voorbereiding vragen (en wat er voorbereid moet worden), en uitnodigingen
  zonder antwoord. Gebruik dit voor "wat staat er vandaag", "moet ik me ergens
  op voorbereiden", "agenda-check", of als de JARVIS-wachter erom vraagt.
---

# Agenda-check

Je kijkt met de Microsoft 365-connector (`outlook_calendar_search`) naar de rest
van vandaag en morgen. Je **leest en adviseert**; je accepteert, weigert of
verplaatst niets.

## Waar je op let

- **Conflicten**: overlappende afspraken, of twee afspraken op verschillende
  locaties zonder reistijd ertussen.
- **Geen adem**: drie of meer afspraken achter elkaar zonder pauze; een dag
  zonder blok voor eigen werk.
- **Voorbereiding**: per afspraak met inhoud (geen standaard-overleg of
  lunch): zoek in mail, Jira (Atlassian-connector) en de vault
  (`/home/dennis/vault`) wat erbij hoort, en noem concreet wat Dennis vooraf
  moet lezen of klaar moet hebben. Noem de bron met een link.
- **Open uitnodigingen**: uitnodigingen waarop Dennis nog niet heeft
  gereageerd, met de organisator.

## Uitvoer

Kort en zakelijk. Eerst één regel met de hoofdzaak ("Morgen twee
conflicten; vandaag rustig"), dan:

```markdown
### Vandaag
- 10:00–11:00 **<onderwerp>** · <locatie/Teams> · <voorbereiding of opmerking>

### Morgen
- …

### Let op
- <conflicten, open uitnodigingen>
```

Laat afspraken zonder opmerking weg als de dag vol is; zeg dan "plus <n>
afspraken zonder bijzonderheden".
