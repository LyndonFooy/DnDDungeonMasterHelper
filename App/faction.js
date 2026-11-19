/*
 * Factions: limits on which NPCs a random encounter can roll, from the outlines in Data/Factions/
 * (format: Data/Factions/README.md).
 *
 *   loadFactions(data, dir?) -> [{ key, name, description, types, races }]   (validated, sorted by name)
 *   pickWeighted(choices, random?) -> key   (undefined for null = "any")
 *
 * `types` and `races` are weighted choices, [{ key, weight }] with the weights summing to 1, of NPC type / race keys
 * (as in data.npcTypes / data.races), or null for "any". In the files they're either a list of names (equal weights)
 * or an object of name -> weight (relative: { "Martial": 3, "Spellcaster": 1 } is the same as 0.75 / 0.25).
 * `data` is the NPC generator's data (loadNpcData()), used to check every name in the files.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'Data', 'Factions');

const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Resolves names (or keys, any case) to weighted keys. An omitted or empty list or object means "any" (null).
function resolve(spec, list, label, file) {
	if (spec == null) return null;
	let entries;
	if (Array.isArray(spec)) entries = spec.map((n) => [n, 1]);
	else if (typeof spec === 'object') entries = Object.entries(spec);
	else throw new Error(`${file}: "${label}s" must be a list of names or an object of name -> weight`);
	if (!entries.length) return null;
	const weights = new Map();
	for (const [n, weight] of entries) {
		const q = String(n).toLowerCase().trim();
		const hit = list.find((e) => e.key === q || e.name.toLowerCase() === q);
		if (!hit) throw new Error(`${file}: unknown ${label} "${n}". Options: ${list.map((e) => e.name).join(', ')}`);
		if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
			throw new Error(`${file}: ${label} "${n}" has weight ${JSON.stringify(weight)}; weights must be numbers above 0`);
		}
		if (weights.has(hit.key)) throw new Error(`${file}: ${label} "${hit.name}" is listed twice`);
		weights.set(hit.key, weight);
	}
	const total = [...weights.values()].reduce((a, b) => a + b, 0);
	return [...weights].map(([key, weight]) => ({ key, weight: weight / total }));
}

function pickWeighted(choices, random = Math.random) {
	if (!choices) return undefined;
	let r = random();
	return (choices.find((c) => (r -= c.weight) < 0) ?? choices[choices.length - 1]).key;
}

function loadFactions(data, dir = DIR) {
	const factions = fs.readdirSync(dir)
		.filter((f) => f.toLowerCase().endsWith('.json'))
		.map((f) => {
			const faction = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
			if (!faction.name) throw new Error(`${f}: no name`);
			return {
				key: slug(faction.name),
				name: faction.name,
				description: faction.description || '',
				types: resolve(faction.types, data.npcTypes, 'type', f),
				races: resolve(faction.races, data.races, 'race', f),
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
	const seen = new Set();
	for (const f of factions) {
		if (seen.has(f.key)) throw new Error(`two factions are named "${f.name}"`);
		seen.add(f.key);
	}
	return factions;
}

module.exports = { loadFactions, pickWeighted, DIR };
