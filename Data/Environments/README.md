# Environments

Hand-made roll tables for the environment randomizer (the left panel of the encounter page, `App/environment.js`).
One file per environment; every `*.json` here is loaded and offered in the panel's drop-down, sorted by name.
Adapted from `DataInspo/Old Exploration tables.md`.

```jsonc
{
    "name": "Desert",                 // shown in the drop-down; its slug ("desert") is the API key
    "rolls": [                        // rolled once each when the environment is generated, in this order
        {
            "key": "twist",           // unique within the file; used to reroll just this one
            "name": "Twist",
            "die": "1d8",
            "entries": [
                {
                    "roll": 5,                    // a face, or [low, high] for a range ("roll": [3, 4])
                    "name": "Sandstorm Approaching",
                    "description": "…",           // optional
                    "effects": [                  // optional: rolled when this entry is picked
                        { "label": "Max visual range", "dice": "1d4", "multiplier": 10, "unit": "ft" }
                    ],
                    "tables": ["obelisk"]          // optional: nested tables to show when this entry is picked
                }
            ]
        }
    ],
    "tables": {                       // nested tables, keyed by the ids used in "tables" above
        "obelisk": { "name": "Obelisk Rolls", "die": "1d12", "usage": "…", "entries": [ … ] }
    }
}
```

- Each table's entries must cover every face of its die exactly once (the loader checks this).
- Nested tables are only displayed, not rolled: they're for rolling at the table during play (e.g. each round of a
  storm). Their entries use the same shape, without `effects` or `tables`.
- `effects` dice are `NdM` (optionally `+K`/`-K`); the result is multiplied by `multiplier` (default 1).
