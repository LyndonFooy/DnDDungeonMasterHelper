# NPC Generator: plan

## Context
`Generators/CharacterGenerator/generateCharacter.js` builds PC-class companions. We want a sibling **NPC generator** for the
simplified NPC classes in `Generators/NpcGenerator/<Type>/outline` (Warrior, Expert, Spellcaster to start, more to come).
NPCs reuse the character pipeline (race, stats, skills, HP, statblock output in the `BlankTemplate.json` shape) with
these rule changes:
- Weapons are picked first: Warrior gets 1 Martial melee + 1 Martial ranged; Expert and Spellcaster get 1 Simple melee + 1 Simple ranged.
  The weapons then decide whether Str or Dex comes first in the stat order.
- Armor comes next: Spellcaster wears light only; Expert wears light/medium and can use a shield; Warrior can wear any armor and use a shield.
- Every Ability Score Improvement level grants a **random feat** (never an ASI).
- Optional: N magic items of rarity ≤ X, with **full mechanics**, filtered to items that fit the NPC's gear.

Decisions already made: Hit Dice are Warrior d10, Expert d8, Spellcaster d8. The weapons drive the stat priority. Magic items use full mechanics, the only limit is "must fit gear", and there is no attunement cap, no consumable ban and no cursed-item ban.

## Architecture
Adding a new NPC type should only need a new folder and one JSON file. Behavior shared by all types lives in
generic, data-flagged code, not in per-type branches.

```
Generators/NpcGenerator/
  generateNpc.js          # NpcBuilder extends CompanionBuilder + CLI
  magicItems.js           # item pool, fit checks, mechanics
  Warrior/Warrior.json    # class data (Classes.json-like shape), hand-written from outline
  Expert/Expert.json
  Spellcaster/Spellcaster.json
  test/generateNpc.test.js
  README.md               # mirrors Generators/CharacterGenerator/README.md
  Plan.md                 # copy of this plan (currently empty)
```

`loadNpcTypes()` globs `Generators/NpcGenerator/*/*.json`, so a new type folder is picked up automatically.

### Type JSON shape (one per folder)
```jsonc
{
  "key": "warrior", "name": "Warrior", "hitDie": 10,
  "savingThrowChoice": { "count": 1, "from": ["Str","Dex","Con"] },
  "skillChoice": { "count": 2, "from": [...] },        // Expert: count 5, from "any"
  "toolChoice": 0,                                      // Expert: 2
  "weaponCategory": "Martial",                          // drives weapon picks + proficiency
  "armorProficiencies": ["light","medium","heavy","shields"],
  "asiLevels": [4,8,12,14,16,19],                       // from each outline
  "attacksPerLevel": [1,1,1,1,1,2,...,3,...],           // Warrior: 2 at 6, 3 at 15
  "abilityPriority": { "tail": ["Con","Wis","Int","Cha"] }, // weapon ability goes first (see below)
  "spellcasting": null,                                 // Spellcaster only (below)
  "features": [ { "key","name","level","description","usages","recovery","actions","additional",
                  "acBonus","critRange","potentCantrips","choices","extraChoices","savingThrowChoice" } ]
}
```
Feature text is written as statblock prose using the existing `[MON]` token, so `prose()` passes it through
unchanged. Per-level values use the 20-length arrays the generator already supports (`additional`, `usages`):
Second Wind `1d10+L` with 1 use (2 at L20), Indomitable 1/long rest (2 at L18), Inspiring Help 1d6 (2d6 at L20).
The "Ability Score Improvement" features are left out of the JSON; `asiLevels` covers them.

Spellcaster `spellcasting` block: `{ progression: "table", maxSpellLevel: 5, cantripsKnown[20], spellsKnown[20],
slots[20] (from the outline table), roles: [{ key:"mage", lists:["wizard"], ability:"Int", focus:"Arcane focus",
signatureSpells:[...] }, { key:"healer", lists:["cleric","druid"], ability:"Wis", focus:"Holy symbol" },
{ key:"prodigy", lists:["bard","warlock"], ability:"Cha", focus:"Arcane focus" }] }`.

## Changes to `Generators/CharacterGenerator/generateCharacter.js` (small, backward-compatible)
- `module.exports`: add `CompanionBuilder`, `ABILITIES`, `ABILITY_FULL`, `SPELL_LEVELS`, `findEntry`, `mod`, `signed`,
  `titleCase`, `ordinal`, `avgDice`, `listJoin`, `spellLevelNumber`.
- `mergeSpells` (line 36): also keep `school`. Empowered Spells needs it.
- `weaponAction` (line 848): add `w.magicBonus` to hit and damage, add an optional `w.extraDamage` rider, and use the
  displayed name `w.displayName || w.name`.
- `cantripAction` (line 883): add a hook `this.cantripDamageBonus(ability)` that returns 0 in the base class.
- `armorText` (line 1096): add a hook `this.extraAC()` that returns 0 in the base class.
- `loadData`: also load `Data/MagicItems/MagicItems.json` (lazy-load it so the character tests stay fast).

The character generator's behavior stays the same, and its existing tests must still pass.

## `NpcBuilder extends CompanionBuilder`: build order
1. **chooseIdentity**: random race and variant (as for characters), type (`--type` or random), Spellcaster role
   (`--role` or random), alignment. `this.cls` = the type JSON; `this.sub` = undefined.
2. **chooseWeapons** (new, runs before stats): pool = `Data/Equipment/Weapons.json` filtered to `category === weaponCategory`.
   Pick one from `list === 'melee'` and one from `list === 'ranged'`. Exclude `net` and `lance` (no damage, or needs a mount).
   Thrown melee weapons (javelin, dagger, handaxe, spear) count as melee.
3. **Stat priority from weapons**: if the melee weapon is finesse, or the Warrior/Expert melee weapon is light and the ranged weapon is not thrown, Dex leads; otherwise Str leads.
   Order: Warrior/Expert = [weapon ability, Con, the other physical ability, ...tail];
   Spellcaster = [role ability, Con, weapon ability, ...]. A synthetic `this.build`
   (`{ name: "<Melee> & <Ranged>", abilityPriority, mainWeapons:[melee], rangedWeapons:[ranged], offHand }`) lets
   `pickFightingStyle`, `pickFeat` and `renderAttacks` work unchanged.
4. **collectFeatures / resolveChoices**: reuse. The Warrior's Martial Role choices come from `Data/Classes/FightingStyles.json`
   (Archery, Defense, Dueling, Great Weapon, Protection, Two-Weapon), and `pickFightingStyle` (line 299) fits the style to the weapons.
5. **rollAbilityScores**: override the ASI loop. At every `asiLevels` level, call `pickFeat(scores, lvl)` (line 415).
   If no feat is eligible, fall back to a +2 ASI so the build never fails. Racial bonuses and feat bonuses are applied as before.
6. **applyProficiencies**: saving throw from `savingThrowChoice`, weighted toward the higher modifier, plus Sharp Mind at L18
   (one of Int/Wis/Cha the NPC doesn't already have). Skills come from `skillChoice`; the Expert gets 5 from any skill. Armor and
   weapon proficiencies come from the type JSON. The Expert gets 2 random tools from `Data/Equipment/Tools.json` (listed under Equipment/Proficiencies).
7. **chooseArmor**: reuse the best-AC loop from `chooseGear` (line 544) with `armorUnlockLevel`, limited to the type's armor
   proficiencies. The NPC uses a shield if it is proficient and the melee weapon isn't two-handed. The Expert avoids armor with stealth disadvantage.
8. **chooseMagicItems** (see below), then recompute mods for any score overrides.
9. **chooseSpells** (Spellcaster): override `casterSetup` to use the type's slot table (keyed by `SPELL_LEVELS`, so the
   base `renderSpellcasting` works). The pool is spells whose `classes` intersect the role's lists and whose level is ≤ the highest slot level (5 at most).
   Count = `spellsKnown[L-1]`, spread round-robin across levels as the base class does. At least one attack cantrip.
10. **resolveExtraChoices**: Expertise at L3 and L15 (2 skills each) via `chooseExpertise` (line 352).
    Empowered Spells (L14): pick the school with the most known levelled spells.
11. Render features, items, attacks and spellcasting (reusing base methods), then `assemble()` with
    `Class: "Warrior"`, `Subclass: role name or fighting style`, `Build: weapon pair`, `MagicItems: [{name: rarity}]`.
    Statblock text names role lists as "wizard spells" or "cleric and druid spells".

Type-specific mechanics come from data flags: `acBonus` (Improved Defense +1, applied through `extraAC()`), `critRange: 19`
(Improved Critical, as an Abilities entry), `potentCantrips` (adds the casting modifier through `cantripDamageBonus`), and
`attacksPerLevel` (Multiattack, already rendered by `renderAttacks`).

## Magic items (`Generators/NpcGenerator/magicItems.js`)
- CLI: `--magic-items <n>` (default 0) and `--max-rarity <common|uncommon|rare|very rare|legendary>` (default `uncommon`).
- **Pool**: expand items with `choices` into one entry per variant. Each variant inherits the parent's fields and uses its own
  `rarity` (e.g. Weapon +1 uncommon / +2 rare / +3 very rare, belts, potions). Keep variants with rarity ≤ max. Items stay unique.
- **Fits gear** (`fits(item, npc)`):
  - `weapon (X)` → matches the melee or ranged weapon: any sword, any axe, any ammunition (ranged weapon uses ammo), named
    weapon, any. Each weapon carries at most one magic weapon item.
  - `armor (X)` → matches the worn armor's type or name. At most one armor item. `shield` → the NPC has a shield.
  - `prerequisite`: class lists map to Spellcaster roles (mage = wizard, healer = cleric/druid, prodigy = bard/warlock;
    "spellcaster" = any Spellcaster). Race (Dwarven Thrower) and alignment (Talismans) are checked. Prerequisites that can't be checked
    (wind instruments, Manual of Golems) are skipped.
  - `extraAC` / `armorOptions` that need no armor (Bracers of Defense) fit only an unarmored NPC.
- **Selection**: `rng.sample(pool, n)`. If fewer items fit than requested, take all of them and add a `Notes` warning.
- **Mechanics** (full), reusing the base feature plumbing by exposing items through an overridden `activeFeatures` getter:
  - Magic weapon/ammo +N → `magicBonus` on that weapon; the displayed name becomes "+1 Longsword". Riders from `mechanicsNotes`
    (Flame Tongue +2d6 fire) become `extraDamage`. Armor/shield +N and `extraAC` (Ring/Cloak of Protection) go into AC.
  - Ring/Cloak of Protection-style "+N to saving throws" is added to every save in `SavingThrows`.
  - `abilityScoreOverride` (Gauntlets, Headband, Amulet of Health, Belts) → `max(score, override)`; `abilityScoreIncrease`.
  - `damageResistances`, `saveNotes.immune`, `senses`, `speed`, `languages`, `armorOptions` → picked up automatically by the existing
    `resistances()`, `senses()`, `speeds()` and armor loop once items are in `activeFeatures`.
  - `spellcastingBonus` → one entry per item, e.g. "Wand of Magic Missiles (7 Charges; regains 1d6+1 at dawn). The [MON] can
    expend charges to cast: magic missile (1+ charges)". DC is `fixedDC` if present, else the NPC's spell DC, else 8 + prof + highest mental mod.
  - `attacks` → Actions entries rendered in the same format as `weaponAction`.
  - `usages`/`recovery`/`actions` → name suffix and category via existing `usageSuffix`/`emit` logic. Potions and scrolls go in Actions
    (Spell Scroll picks a random spell of its level from the NPC's lists, or any list).
  - Every item also appears in `Equipment` and `MagicItems`.

## CLI and packaging
`node Generators/NpcGenerator/generateNpc.js -l 7 -t warrior --magic-items 2 --max-rarity rare -f text`
Options mirror the character CLI (`--level, --type, --role, --race, --variant, --background, --alignment, --stats, --seed,
--count, --keep-tokens, --format, --out, --list`) plus the two item flags. Add `"npc"` to the `package.json` scripts and add the
new test file to `npm test`. Reuse `renderText`; it already prints Equipment and the action sections.

## Verification
- `npm test`: the existing character tests still pass (shared code changed).
- New `Generators/NpcGenerator/test/generateNpc.test.js`, sweeping every type × levels 1–20 × 3 seeds:
  - No `undefined`/`NaN`/unresolved tokens. Proficiency bonus is correct. HP matches the fixed-average formula with the type's hit die.
  - Exactly one melee and one ranged weapon, both in the right category.
  - Armor type is allowed for the type. Shield only for Warrior/Expert and never with a two-handed weapon.
  - Feats taken = number of `asiLevels` ≤ level (the ASI fallback is counted separately). No feat is repeated unless `allowDuplicates`.
  - Spellcaster: slots match the outline table, every spell is ≤ 5th level and on the role's lists, cantrip and known counts match.
  - Warrior: Multiattack at 6 (two attacks) and 15 (three), and AC is +1 at 10+.
  - Items: count = min(n, eligible), every rarity ≤ max, every weapon/armor item is attached to the NPC's own gear, and
    Gauntlets of Ogre Power sets Str ≥ 19.
  - The same seed gives the same output.
- Manual: `npm run npc -- -l 12 -t spellcaster --role healer --magic-items 3 --max-rarity rare -f text` and read the statblock.
