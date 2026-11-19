# Factions

Hand-made faction outlines for the encounter page's **Faction** filter (`App/faction.js`). One file per faction; every
`*.json` here is loaded and offered in the drop-down, sorted by name. A faction limits which NPCs a random encounter
can roll: each enemy's type and race are picked at random from the faction's lists, by their weights.

```jsonc
{
    "name": "Human Kingdoms",                     // shown in the drop-down; its slug ("human-kingdoms") is the API key
    "description": "…",                           // optional, the drop-down tooltip
    "types": { "Martial": 0.75, "Spellcaster": 0.25 },          // optional: NPC types (Generators/NpcGenerator/<Type>/)
    "races": { "Human": 0.6, "Half-elf": 0.2, "Half-orc": 0.2 }  // optional: races (Races/Races.json, name or key)
}
```

`types` and `races` are each either:

- an object of name → weight. Weights are relative and needn't add up to 1: `{ "Martial": 3, "Spellcaster": 1 }` is the
  same as `0.75` / `0.25`. Every weight must be a number above 0.
- a list of names, all equally likely: `["Martial", "Spellcaster"]` is the same as `{ "Martial": 1, "Spellcaster": 1 }`.

Omitted, `[]` or `{}` means any type or race (equally likely). Weights are odds per NPC, not exact quotas: a Human
Kingdoms encounter of four is three Martials and one Spellcaster on average, but can roll four Martials or two of each.

Names are matched without regard to case, and an unknown type or race stops the app from starting, so typos show up
straight away. A race with variants (Dragonborn) rolls a random variant.

| File | Types | Races |
| --- | --- | --- |
| `Adventurers.json` | any | any |
| `Bandits.json` | Martial 0.9, Spellcaster 0.1 | any |
| `HumanKingdoms.json` | Martial 0.75, Spellcaster 0.25 | Human 0.6, Half-elf 0.2, Half-orc 0.2 |
