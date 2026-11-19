# NPC Generator

Randomly generates an NPC (level 1–20) using the simplified NPC classes in this folder (Warrior, Martial, Expert,
Spellcaster). It reuses the companion generator in `Generators/CharacterGenerator/` (race, stats, skills, HP, statblock text)
and outputs the same `BlankTemplate.json` shape.

```sh
node Generators/NpcGenerator/generateNpc.js --level 5                                   # random type, JSON
node Generators/NpcGenerator/generateNpc.js 9 -t warrior -f text
node Generators/NpcGenerator/generateNpc.js -l 12 -t spellcaster --role healer -m 3 --max-rarity rare -f text
node Generators/NpcGenerator/generateNpc.js -l 4 -n 6 -s bandit-camp -o bandits.json    # six NPCs
node Generators/NpcGenerator/generateNpc.js --list                                      # types, roles, races, rarities
npm run npc -- --level 5 --format text
```

| Option | Meaning |
| --- | --- |
| `-l, --level` | NPC level 1–20 (required; a bare number also works) |
| `-t, --type` | `warrior`, `martial`, `expert`, `spellcaster` (default random) |
| `--role` | Spellcaster role: `mage` (wizard list, Int), `healer` (cleric + druid, Wis), `prodigy` (bard + warlock, Cha) |
| `-r, --race`, `--variant` | Race / variant (default random) |
| `--background`, `--alignment`, `--stats` | As for the character generator. NPCs get no generic background unless one is given |
| `-m, --magic-items` | How many magic items to carry (default 0) |
| `--max-rarity` | Highest rarity: `common`, `uncommon` (default), `rare`, `"very rare"`, `legendary` |
| `-s, --seed`, `-n, --count`, `--keep-tokens`, `-f, --format`, `-o, --out` | As for the character generator |

From code:

```js
const { generateNpc, renderText } = require('./Generators/NpcGenerator/generateNpc.js');
const npc = generateNpc({ level: 6, type: 'expert', magicItems: 2, maxRarity: 'rare', seed: 'docks' });
console.log(renderText(npc));
```

## Rules

1. **Weapons first.** One melee and one ranged weapon: Martial for the Warrior, Simple for the Expert and Spellcaster,
   Simple for the Martial until Combat Training gives it martial weapons, then either (the Warrior and Martial never get a net or lance). The melee weapon sets the stat order: finesse means Dex first, anything
   else Str first, then Con. Spellcasters put their role's casting ability first.
2. **Armor.** A random armor of the heaviest rating the NPC is proficient with (heavy, else medium, else light), never
   simply the best AC. It must be unlocked at the NPC's level (`armorUnlockLevel` in `Generators/CharacterGenerator/BuildHints.json`
   stands in for wealth) and meet its Strength requirement. With no armor proficiency the NPC goes unarmored. Spellcaster: light armor only. Expert: light and medium armor and shields, avoiding
   armor with stealth disadvantage. Warrior: all armor and shields. Martial: no armor until
   Combat Training or an armor feat adds some. An NPC that could carry a shield (proficient, one-handed melee weapon, not
   dual-wielding) has a 50% chance to carry one (`SHIELD_CHANCE` in `generateNpc.js`). Without one, versatile weapons show their two-handed damage.
   **Martial: Combat Training.** At 3rd, 8th, 13th and 19th level the Martial (d8 hit dice) gains one random proficiency it lacks:
   light armor, medium armor, heavy armor, shields or martial weapons. Feats are resolved in level order with these gains, so Lightly, Moderately or
   Heavily Armored is only taken for a proficiency it doesn't have yet, and a proficiency from one is never gained again later.
   Weapons are picked before feats, so the weapon pool counts the martial weapon gain as if no armor feat came first. An
   armor feat can only make that gain arrive sooner, so the Martial is always proficient with what it carries.
3. **Feats instead of ASIs.** Every Ability Score Improvement level grants a random feat the NPC qualifies for
   (same feat pool and prerequisite checks as the character generator). If no feat qualifies, it falls back to the ASI.
   A type can rule feats out with `excludedFeats` (feat names or keys, any case). Feats that depend on gear:
   - **Defensive Duelist** needs a finesse melee weapon, **Crossbow Expert** a crossbow, **Shield Master** a shield, **Polearm Master** a glaive, halberd,
     pike, quarterstaff or spear. **Slasher / Crusher / Piercer** need a weapon (melee or ranged) of that damage type.
   - **War Caster** and other "can cast a spell" feats need spellcasting from the NPC's class or from an earlier feat
     that grants spells (Magic Initiate, Fey Touched, ...). Racial spells don't count.
   - **Dual Wielder** swaps the melee weapon for two of a one-handed weapon from the type's category (no shield, +1 AC).
   - **Two-Weapon Fighting** (from Martial Role or Fighting Initiate) swaps the melee weapon for two light weapons.
     Swapped weapons prefer the NPC's lead ability (finesse for Dex) and never break an earlier feat or fighting style,
     e.g. no Dual Wielder with Protection, Dueling, Great Weapon Fighting or Shield Master.
   - **Lightly / Moderately / Heavily Armored** are only taken when they grant a proficiency the NPC lacks. The NPC then
     wears armor of that rating (or heavier) at random. Moderately Armored also grants shields (carried on the same 50% roll).
   - **Fighting Initiate** takes a style the NPC doesn't already have and that works with its gear. Its mechanics apply
     like Martial Role's.
   - Spells from feats are picked and get their own Spellcasting entry; attack cantrips also get an action.
4. **Class features** come from each type's JSON (written from the `outline` file next to it): saving throw choices,
   skills, tools, Expertise, the Warrior's fighting style (Martial Role), Extra Attack, Improved Defense, Potent
   Cantrips, Empowered Spells (the school it knows most spells from), and limited-use suffixes such as
   "Second Wind (Recharges after a Short or Long Rest)".
5. **Magic items** (`magicItems.js`). Items with variants are split into one entry per rarity ("Weapon +1" uncommon,
   "Weapon +2" rare, ...). The NPC draws `--magic-items` distinct items at or below `--max-rarity`, but only items that fit:
   - weapon items must match one of its two weapons (any sword, any axe, any ammunition, a named weapon), one item per weapon
   - armor and shield items must match what it wears
   - attunement prerequisites are checked: Spellcaster roles count as their lists' classes, plus race and alignment
   - Bracers of Defense and the Robe of the Archmagi go only to NPCs they don't make worse off, and the NPC takes its armor off

   Applied mechanics: +N to hit and damage, extra damage riders (Flame Tongue, Mace of Disruption), armor and shield
   bonuses, AC and saving throw bonuses, spell attack and DC bonuses, set or raised ability scores (HP follows Con),
   resistances and immunities, senses, speeds, languages, charges, and item spells with their DC.
   Potions and spell scrolls appear as actions. Scrolls go to any NPC and hold a random spell of their level from any list. If fewer items fit than were asked for, `Notes` says so.

## Output

Same as the character generator (see `Generators/CharacterGenerator/README.md`), with these differences:

- `Class` is the NPC type. `Subclass` is the Spellcaster role or the Warrior's fighting style. `Build` names the two weapons.
- `ProficiencyGains` (`[{ "3": "Shields" }, { "8": "Martial weapons" }]`), `Tools`, `Feats`, `MagicItems` (`[{ "Ring of Protection": "rare, requires attunement" }]`), `Notes`
- `Spellcasting.ItemSpells` / `Spellcasting.FeatSpells` list spells cast from items and learned from feats
- With a save-boosting item, `SavingThrows` lists all six saves

## Adding an NPC type

Add a folder with one JSON file (`Generators/NpcGenerator/<Type>/<Type>.json`). It's picked up automatically. The shape follows
`Data/Classes/Classes.json`, plus these fields:

| Field | Meaning |
| --- | --- |
| `weapons` | `{ "category": "Simple" or "Martial" (or a list of both), "exclude": [weapon keys] }` |
| `abilityPriority` | Stat order after the weapon/casting ability and Con; `shuffleAbilityTail` randomises it |
| `stealthy` | Avoid armor with stealth disadvantage |
| `excludedFeats` | Feat keys (from `Data/Feats/Feats.json`) this type never takes |
| `spellcasting` | `{ progression: "table", maxSpellLevel, cantripsKnown[20], spellsKnown[20], slots[20][], roles[] }` |
| feature `savingThrowChoice` | `{ count, from, random }`: saving throw proficiencies picked toward the NPC's best abilities, or evenly with `random: true` (the Martial's Tenacity) |
| feature `toolChoice` | Number of random tools |
| feature `proficiencyGain` | `{ from: ["light", "medium", "heavy", "shields", "martial"] }`: one random proficiency from the list that the NPC doesn't have at that level, so ones from earlier feats are skipped (the Martial's Combat Training). Gained martial weapons widen the weapon pool |
| feature `choicesFrom` | `{ class, feature }`: copy a class feature's choices (e.g. the fighter's fighting styles) |
| feature `extraChoices.options: "skills"` | Expertise over every skill, `timesPerLevel` as in Classes.json |
| feature `acBonus`, `potentCantrips`, `schoolChoice` | Improved Defense, Potent Cantrips, Empowered Spells |
| feature `omit` | Folded into the numbers, so it gets no statblock entry |

Feature descriptions are statblock prose. `[MON]` becomes "the warrior", `{level}` becomes the NPC's level, and
`{additional}` becomes this level's entry of the feature's `additional` array.

## Tests

`npm test` sweeps every type at every level with and without items, and checks the rules above. The character generator's tests also run.
