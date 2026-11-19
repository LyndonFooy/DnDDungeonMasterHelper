/*
 * Builds a random encounter: a group of NPCs whose levels add up to a level budget, sharing a pool of magic items,
 * each with an initiative roll (1d20 + Dex modifier + bonuses).
 *
 *   buildEncounter({ count, levels, items, faction }, data)
 *     -> { count, levels, items: { requested, carried }, faction?, npcs: [npc + Initiative] }
 *
 * Every option is optional and random when left out. Levels are split at random (each NPC 1–20); magic items go
 * preferentially to higher-level NPCs. `faction` (from App/faction.js) picks each NPC's type and race by its weights.
 */
'use strict';
const { generateNpc } = require('../Generators/NpcGenerator/generateNpc.js');
const { pickWeighted } = require('./faction.js');

const MAX_COUNT = 20;
const MAX_LEVEL = 20;
const MAX_ITEMS = 60;
// Magic items that give advantage on initiative without adding a trait to the statblock.
const ADVANTAGE_ITEMS = [/^rod of alertness$/i, /^weapon of warning/i];

const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const d20 = () => randInt(1, 20);

function checkInt(name, value, lo, hi) {
	if (!Number.isInteger(value) || value < lo || value > hi) throw new Error(`${name} must be a whole number from ${lo} to ${hi}`);
	return value;
}

// Splits `total` into `n` parts, each between `min` and `max`, one unit at a time with weighted random picks.
function splitTotal(total, n, { min, max, weights }) {
	const parts = Array(n).fill(min);
	for (let left = total - n * min; left > 0; left--) {
		const open = parts.map((p, i) => (p < max ? i : -1)).filter((i) => i >= 0);
		let r = Math.random() * open.reduce((sum, i) => sum + weights[i], 0);
		const pick = open.find((i) => (r -= weights[i]) < 0) ?? open[open.length - 1];
		parts[pick]++;
	}
	return parts;
}

// Dex modifier, plus "+N bonus on initiative" traits (Alert), plus advantage from traits (Battle Readiness) or items.
function initiativeOf(npc) {
	const traits = (npc.Abilities || []).map((o) => Object.values(o)[0]).join('\n');
	const extra = [...traits.matchAll(/\+(\d+) bonus (?:on|to) initiative/gi)].reduce((sum, m) => sum + Number(m[1]), 0);
	const itemNames = (npc.MagicItems || []).map((o) => Object.keys(o)[0]);
	const advantage = /advantage on initiative/i.test(traits) || itemNames.some((n) => ADVANTAGE_ITEMS.some((re) => re.test(n)));
	const bonus = Math.floor((npc.Stats.Dex - 10) / 2) + extra;
	const rolls = advantage ? [d20(), d20()] : [d20()];
	return { bonus, advantage, rolls, total: Math.max(...rolls) + bonus };
}

function buildEncounter(opts, data, decorate = (npc) => npc) {
	const levelsGiven = opts.levels != null;
	if (levelsGiven) checkInt('Sum of NPC levels', opts.levels, 1, MAX_COUNT * MAX_LEVEL);

	let count;
	if (opts.count != null) {
		count = checkInt('Number of enemies', opts.count, 1, MAX_COUNT);
	} else {
		// Random 2–6, but enough NPCs to hold the level budget and not more than it allows.
		const lo = levelsGiven ? Math.ceil(opts.levels / MAX_LEVEL) : 1;
		const hi = levelsGiven ? Math.min(opts.levels, MAX_COUNT) : MAX_COUNT;
		count = Math.min(hi, Math.max(lo, randInt(2, 6)));
	}

	let levels;
	if (levelsGiven) {
		levels = opts.levels;
		if (levels < count || levels > count * MAX_LEVEL) {
			throw new Error(`${count} enem${count === 1 ? 'y needs' : 'ies need'} a level sum from ${count} to ${count * MAX_LEVEL}`);
		}
	} else {
		levels = Array.from({ length: count }, () => randInt(1, 10)).reduce((a, b) => a + b, 0);
	}

	const items = opts.items != null ? checkInt('Total magic items', opts.items, 0, MAX_ITEMS) : randInt(0, count);

	const npcLevels = splitTotal(levels, count, { min: 1, max: MAX_LEVEL, weights: Array.from({ length: count }, () => 0.3 + Math.random()) });
	const npcItems = splitTotal(items, count, { min: 0, max: Infinity, weights: npcLevels });

	// A faction picks each NPC's type and race by its weights (null = any, left to the generator).
	const faction = opts.faction;

	const npcs = npcLevels.map((level, i) => {
		const type = pickWeighted(faction && faction.types);
		const race = pickWeighted(faction && faction.races);
		const npc = generateNpc({ level, magicItems: npcItems[i], type, race }, data);
		return { ...decorate(npc), Initiative: initiativeOf(npc) };
	});
	const carried = npcs.reduce((sum, npc) => sum + (npc.MagicItems || []).length, 0);
	return { count, levels, items: { requested: items, carried }, ...(faction ? { faction: faction.name } : {}), npcs };
}

module.exports = { buildEncounter, initiativeOf, splitTotal };
