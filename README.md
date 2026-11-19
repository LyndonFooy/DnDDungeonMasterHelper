# Random Encounter Generator

D&D 5e data in JSON, plus tools that build statblocks from it.

## Layout

| Folder | Contents |
| --- | --- |
| `Data/` | Game data: `Classes/`, `Races/`, `Backgrounds/`, `Feats/`, `Equipment/`, `Spells/`, `MagicItems/`, `Creatures/`, `Companions/`, `Rules/`, `Catalog/`. Most of it is extracted from MPMB's Character Record Sheet. `Spells/SpellsAll.json`, `Spells/SpellcasterLevels.json` and `Equipment/BasicWeapons.json` are hand-made. `Modifiers/` holds statblock modifiers (e.g. `Zombie.json`). `Environments/` holds hand-made environment roll tables ([README](Data/Environments/README.md)). `Factions/` holds hand-made faction outlines that limit which NPC types and races an encounter rolls ([README](Data/Factions/README.md)). Data file paths in these READMEs (and `detailedIn` in `Catalog/*.json`) are relative to `Data/`. |
| `BlankTemplate.json` | The statblock shape the generators output |
| `App/` | Web app: `npm run app`, open http://localhost:3000. **NPC Generator** (`npc.html`): press Generate for a random NPC statblock (styled after `DataInspo/StatblockDisplayTemplate`). Spellcasters also get a spellbook below it, with spells grouped by level and full details from `Data/Spells/SpellsAll.json`. **Random Encounter** (`encounter.html`): filter by faction (from `Data/Factions/`), number of enemies, sum of NPC levels and total magic items (blank = random), track players by name and initiative, and step through the initiative order (1d20 + Dex + bonuses such as Alert, with advantage from Battle Readiness) with Next character. Its left panel is the environment randomizer: pick an environment (from `Data/Environments/`) to roll a situation, twist and location, reroll any one with ↻, and see any nested tables they unlock (e.g. Storm Rolls for "Storm Incoming") for rolling during play. |
| `Generators/` | `CharacterGenerator/`: random class-levelled character generator. See its [README](Generators/CharacterGenerator/README.md) for usage and a file-by-file data reference. `NpcGenerator/`: NPC generator built on it ([README](Generators/NpcGenerator/README.md)). |
| `tools/` | The extraction pipeline (PDF → JSON) |
| `DataInspo/` | Source material: the MPMB PDF and statblock-generator templates |
| `build/mpmb/` | Raw extraction output (scripts, page text, stored fields). Regenerable, so it's safe to delete. |

## Commands

```sh
npm test                       # all tests
npm run companion -- -l 5 -f text
npm run app                    # NPC statblock web app on http://localhost:3000
pip install pypdf              # once, for the extraction step
npm run extract                # PDF -> build/mpmb -> Data/
```

## TODO: extract the rest of the stored add-on

`DataInspo/MPMB's Character Record Sheet (...).pdf` has two layers of data:

1. **Built-in SRD scripts.** These are the source for almost every data file today: 12 classes with one subclass
   each, 9 races, 1 background, 319 spells, 239 magic items and 131 creatures.
2. **An imported add-on, "all_WotC_pub+UA" (3.8 MB).** It's stored in the hidden form field
   `User_Imported_Files.Stringified` and holds all published WotC content plus Unearthed Arcana.
   `tools/extract-mpmb-data.js` already runs it (`loadRuntime()`), but so far only **feats** are written from it
   (`Feats/Feats.json`, 211 feats).

Still to write out from the add-on runtime:

| List | Base (SRD) | With add-on | Current file |
| --- | --- | --- | --- |
| Classes | 12 | 21 | `Classes/Classes.json` |
| Subclasses | 12 | 235 | `Classes/Subclasses.json` |
| Races (+ variants) | 9 (+10) | 213 (+115) | `Races/Races.json` |
| Backgrounds (+ features) | 1 | 81 (+117) | `Backgrounds/Backgrounds.json` |
| Spells | 319 | 575 | `Spells/SpellsSRD.json` |
| Magic items | 239 | 832 | `MagicItems/MagicItems.json` |
| Creatures | 131 | 217 | `Creatures/Creatures.json` |
| Weapons / armor | 55 / 14 | 97 / 15 | `Equipment/` |
| Psionics | 0 | 231 | (none yet) |
| Sources | 5 | 123 | `Rules/Sources.json` |

How to do it:

- In `main()` of `tools/extract-mpmb-data.js`, build each file from `deepCopy(rt.<List>)` (`rt.ClassList`,
  `rt.RaceList`, …) instead of `m.Base_<List>`, the same way feats use `rt.FeatsList`. The `deepCopy` matters: the
  sheet replaces `Array.prototype.find` and friends inside the sandbox.
- Bring over the feat handling. Resolve `sources`/`sourceName` from `rt.SourceList`. Flag `unearthedArcana` and
  `hiddenInSheet` using the sheet's source settings (`CurrentSources.Stringified`: `globalExcl` plus per-list
  exclusions such as `racesExcl`, `classExcl` and `magicitemExcl`). Only count sources the sheet defines.
- Expect new property shapes from the add-on that the SRD normalizers haven't seen. Check for unmapped keys after
  each list, as was done for feats.
- `Generators/CharacterGenerator` assumes SRD-sized data (one subclass per class, a handful of races). It will need to filter
  out UA and hidden content, as it already does for feats, and its `BuildHints.json` only covers the 12 SRD classes.
  `Catalog/*.json` will pick up the new `detailedIn` matches automatically.
