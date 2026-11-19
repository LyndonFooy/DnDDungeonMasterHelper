# Character Generator

Randomly generates a class-levelled NPC character (level 1–20) from the JSON data extracted out of
*MPMB's Character Record Sheet*, and outputs it in the same shape as `BlankTemplate.json` (project root).

```sh
node Generators/CharacterGenerator/generateCharacter.js --level 5                       # random race/class, JSON
node Generators/CharacterGenerator/generateCharacter.js 9 -c wizard -r "high elf" -f text
node Generators/CharacterGenerator/generateCharacter.js -l 3 -n 4 -s goblin-cave -o party.json   # a party of 4
node Generators/CharacterGenerator/generateCharacter.js -l 7 -c fighter --build archer --keep-tokens
node Generators/CharacterGenerator/generateCharacter.js --list                          # races, classes, builds
npm run character -- --level 5 --format text                                 # same thing via npm
npm test
```

| Option | Meaning |
| --- | --- |
| `-l, --level` | Character level 1–20 (required; a bare number also works) |
| `-c, --class`, `--subclass` | Pick a class / subclass (default random; subclass appears at the class's subclass level) |
| `-r, --race`, `--variant` | Pick a race / variant (e.g. dragonborn colour) |
| `--build` | Pick a build from `BuildHints.json` (e.g. `"Sword and Board"`, `Archer`) |
| `--background` | Use a background from `Data/Backgrounds/Backgrounds.json` (adds its skills, gear and personality) |
| `--stats` | `standard` array (default) or `roll` (4d6 drop lowest) |
| `--feat-chance` | Chance (0–1) of taking a feat instead of an ASI |
| `-s, --seed` | Same seed + options = same character |
| `--keep-tokens` | Leave `[MON]`, `[STR ATK]`, `[DEX 1D8]`, `[WIS SAVE]` tokens in the text instead of resolving them |
| `-f, --format` | `json` (default), `text` (readable statblock) or `both` |
| `-o, --out` | Write the JSON to a file |

From code:

```js
const { generatecharacter, renderText } = require('./characterGenerator/generatecharacter.js');
const character = generatecharacter({ level: 6, class: 'cleric', seed: 'temple' });
console.log(renderText(character));
```

## What it does

1. Picks a race (+ variant), class, subclass (once the level allows it), a **build** and an alignment.
2. Assigns ability scores by the build's priority, adds racial bonuses, then applies ASIs at the class's ASI levels
   (sometimes a feat instead), plus features like Primal Champion.
3. Proficiencies: class saves, class/race/background skills (weighted toward the character's good abilities),
   expertise, armor and weapon proficiencies, languages.
4. Gear: picks proficient weapons from the build, and the best-AC armor it can wear at that level
   (`armorUnlockLevel` stands in for wealth). It compares this against Unarmored Defense, Draconic Resilience and mage armor.
5. Features: every class, subclass and race feature up to the level. It resolves choices (fighting styles, pact boons,
   Hunter's Prey, dragon ancestors with their dependent Elemental Affinity, land circles) and extra choices
   (invocations with prerequisites, metamagic, favored enemies/terrain). Features with limited uses get
   "(3/Day)" or "(Recharges after a Short or Long Rest)" suffixes, and per-level values are filled in, e.g. "Sneak Attack (5d6)".
6. Attacks: Multiattack from Extra Attack, weapon attacks (finesse, versatile, thrown, Archery/Dueling/Two-Weapon
   Fighting, monk Martial Arts dice, Improved Divine Smite), attack cantrips with cantrip scaling, and the dragonborn breath weapon.
7. Spellcasting: slots from the full/half/pact tables, cantrips and spells known/prepared. Spells come from
   `Spells/SpellsAll.json` merged with `Spells/SpellsSRD.json`. Signature spells come from `BuildHints.json`.
   Domain, oath and circle spells are always prepared, while patron spells only expand a warlock's list. Also covers
   Magical Secrets, Mystic Arcanum, invocation spells and racial innate spellcasting.
8. Pets: a character who knows *Find Familiar* (or has Pact of the Chain) or *Find Steed* gets a creature statblock
   from `Creatures/Creatures.json` under `Companions`.

## Output

Same keys as `BlankTemplate.json`, in the same `{ "Name": "description" }` style used by `Data/Modifiers/Zombie.json` and
`Data/Equipment/BasicWeapons.json`, plus a few additions:

- Metadata: `Name`, `Level`, `Race`, `Class`, `Subclass`, `Build`, `Background`, `Alignment`, `Seed`
- `SavingThrows` and `BonusActions` (not in the template, but needed for a statblock)
- `Speeds` (only when there's a climb/fly speed), `Equipment`, `Personality` (with `--background`), `Companions` (pets)
- `Skills` / `SavingThrows` are `[{ "Athletics": 7 }]`, `SpellSlots` is `[{ "1st-level": 4 }]`, and `Spells` is
  grouped by level: `[{ "Cantrip": [...] }, { "1st-level": [...] }, { "1/day each": [...] }]`

The `Spellcasting` ability text follows the format in `DataInspo/Spellcasting.json`.

## Tuning: `BuildHints.json`

This is the only hand-written data. It holds per-class builds (stat priority, preferred weapons, shield or off-hand
weapon, fighting style preferences, stealthy armor), signature spells, druid armor limits, armor unlock levels,
features to fold into the numbers rather than list, extra languages, feat chance, and which spells summon pets.
Weapon, fighting style and spell names must match the keys in the extracted JSON.

## Data (extracted from the PDF)

All paths below are relative to `Data/` in the project root.

| File | Contents |
| --- | --- |
| `Classes/Classes.json` | 12 classes: hit die, saves, skill choices, proficiencies, ASI levels, attacks per level, spellcasting, features with choice options |
| `Classes/Subclasses.json` | Subclasses with features, expanded or always-prepared spell lists |
| `Classes/FightingStyles.json` | Fighting styles |
| `Races/Races.json` | Races with variants (dragonborn colours), traits, ability scores, senses, innate spells |
| `Backgrounds/Backgrounds.json` | Backgrounds (with personality tables) |
| `Feats/Feats.json` | All 211 feats from the add-on stored in the PDF (see below): rules text, ability increases, choice options (e.g. Resilient's six abilities), usages, actions, proficiencies, bonus spells, and `prerequisites` parsed into `level`, `abilityScores`, `races`, `spellcasting`, `proficiency`, `classes`, `feats`, `campaign` (anything unrecognised goes in `other`). `sources`/`sourceName` name the books. `unearthedArcana` marks playtest feats, and `hiddenInSheet` marks the 106 feats the sheet's source settings hide, leaving the 105 shown in its page 3 drop-down. Published and UA versions of the same feat are separate entries (UA keys end in `-ua`). |
| `Equipment/Armor.json`, `Weapons.json`, `Ammunition.json`, `EquipmentPacks.json`, `AdventuringGear.json`, `Tools.json` | Equipment, including attack-cantrip data in `Weapons.json` |
| `Spells/SpellsSRD.json` | MPMB's spells in the `SpellsAll.json` format |
| `Spells/SpellSlotTables.json` | Full-caster and pact-magic slot tables |
| `MagicItems/MagicItems.json`, `TreasureCheckpoints.json` | Magic items with rarity, attunement, DMG table and variants |
| `Creatures/Creatures.json` | Beasts and other companion creatures, tagged with which companion types they can be |
| `Companions/CompanionTypes.json` | Familiar, Pact of the Chain, Find Steed and Ranger's Companion rules |
| `Classes/GenericClassFeatures.json` | Shared class features (Potent Spellcasting) |
| `Spells/SpellSchools.json`, `SpellLevels.json`, `SpellPoints.json` | School abbreviations, level names, DMG spell points table |
| `Rules/PlayerReference.json` | The sheet's Player Reference page: area of effect, environment (forced march, food, water, falling, suffocating, rests), attack action options, conditions, exhaustion, travel pace, cover, light & vision, combat actions, movement, with PHB/DMG page refs |
| `Rules/Conditions.json` | The 14 conditions plus exhaustion levels (from the same page) |
| `Rules/AbilityScores.json` | Ability names, standard array, point buy budget and costs |
| `Rules/Lifestyles.json`, `Factions.json`, `UnitConversions.json`, `Licenses.json` | Lifestyle costs, Forgotten Realms and Ravnica factions with ranks, imperial→metric factors, and the OGL 1.0a and GPLv3 texts |
| `Rules/Skills.json`, `Alignments.json`, `DamageTypes.json`, `Levels.json`, `Sources.json` | Skills, alignments, damage types, XP/proficiency per level, sources |
| `Catalog/*.json` | **Names only.** The sheet's drop-down lists were saved with every sourcebook loaded, so they name 787 magic items, 479 companion creatures, 238 wild shapes, 139 races, 122 backgrounds, 116 background features, 105 feats and 76 weapons, plus creature types, sizes and recovery types. `detailedIn` marks the names that have full data in the files above. |

To regenerate it (for example from a newer sheet), run:

```sh
pip install pypdf
npm run extract         # both steps below
npm run extract:pdf     # PDF -> build/mpmb/ (tools/extract_pdf.py): js/*.js, pdf/player-reference.txt,
                        #   pdf/option-lists.json, pdf/fields/*.txt (stored sheet data, incl. the imported
                        #   add-on), pdf/embedded/* (the sheet's FAQ.pdf and import script)
npm run extract:data    # build/mpmb -> the JSON above (tools/extract-mpmb-data.js)
```

**The stored add-on.** Besides its built-in SRD scripts, the sheet keeps imported add-on scripts in a hidden form
field (`User_Imported_Files.Stringified`). This PDF holds MPMB's "all_WotC_pub+UA" add-on (3.8 MB): all published WotC
content plus Unearthed Arcana. The extractor recreates the sheet's runtime: base lists, `InitiateLists()`, then the
add-on run through the sheet's own import helpers. Small shims cover two Acrobat quirks: `toSource()` and old-style
`replace` callbacks. Feats are currently taken from this runtime. The same runtime also holds 21 classes, 235
subclasses, 213 races, 575 spells, 832 magic items, 217 creatures and 81 backgrounds. Those files still come from the
SRD-only base lists for now.

The extractor runs the sheet's list scripts in a Node `vm` sandbox with Acrobat functions stubbed out. It then drops
Acrobat-only code (`calcChanges`, `eval`, ...). Where a function only carries data, the extractor parses it into plain
fields instead: usage formulas like "Charisma modifier per long rest", invocation prerequisites, and cantrip damage.
The point-buy costs come from running the sheet's own cost function.

Not converted: the rest of the scripts are sheet code (dialogs, field layout, colours, icons, bookmarks), and the other
page templates are empty form layouts. Field tooltips are help text for using the sheet, and the embedded FAQ covers
the sheet itself rather than the game; it's kept as a raw file in `build/mpmb/pdf/embedded/`.

## Limitations

- Apart from feats, the data files hold only the SRD content: one subclass per class, 9 races and one background
  (Acolyte). Background is opt-in because every character would otherwise be an acolyte. The stored add-on has the
  rest (see above) but isn't written out yet.
- Feats taken instead of an ASI come only from feats the sheet shows (no UA). Their prerequisites must be
  machine-checkable (level, ability score, race, spellcasting, armor/martial proficiency, class). Feats that need
  another feat, a campaign or a background are skipped.
- Feature text is MPMB's terse first-person wording, rewritten into third person automatically. It reads well, but some
  sentences come out clipped ("attacks vs. it advantage until next turn").
- Gear is mundane. Magic items are extracted but not handed out yet.
