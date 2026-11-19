/*
 * Builds an NPC's spellbook: every spell it can cast (class spells, innate, item and feat spells), looked up in
 * Data/Spells/SpellsAll.json and grouped by spell level.
 *
 *   buildSpellbook(npc) -> [{ level: 'Cantrip', slots: null, spells: [{ name, sources: ['Spellcasting'], ...SpellsAll fields }] }, ...]
 */
'use strict';
const path = require('path');

const LEVELS = ['Cantrip', '1st-level', '2nd-level', '3rd-level', '4th-level', '5th-level', '6th-level', '7th-level', '8th-level', '9th-level'];

const spellsByName = new Map(require(path.join(__dirname, '..', 'Data', 'Spells', 'SpellsAll.json')).map((s) => [s.name.toLowerCase(), s]));

const first = (o) => Object.entries(o)[0];

// [name, source, level the generator listed it under (class spells only)]
function spellEntries(sc) {
	return [
		...(sc.Spells || []).flatMap((o) => { const [level, names] = first(o); return names.map((n) => [n, 'Spellcasting', level]); }),
		...(sc.InnateSpells || []).map((o) => { const [name, freq] = first(o); return [name, `Innate (${freq})`]; }),
		...(sc.ItemSpells || []).flatMap((o) => { const [item, names] = first(o); return names.map((n) => [n, item]); }),
		...(sc.FeatSpells || []).flatMap((o) => { const [feat, names] = first(o); return names.map((n) => [n, feat]); }),
	];
}

function buildSpellbook(npc) {
	const sc = npc.Spellcasting || {};
	const spells = new Map();
	for (const [name, source, listedLevel] of spellEntries(sc)) {
		const key = name.toLowerCase();
		if (!spells.has(key)) {
			const data = spellsByName.get(key);
			spells.set(key, { ...(data || {}), name: data ? data.name : name, level: data ? data.level : listedLevel || 'Unknown', sources: [] });
		}
		const spell = spells.get(key);
		if (!spell.sources.includes(source)) spell.sources.push(source);
	}
	const slots = Object.fromEntries((sc.SpellSlots || []).map(first));
	const order = (level) => (LEVELS.includes(level) ? LEVELS.indexOf(level) : LEVELS.length);
	const groups = new Map();
	for (const spell of [...spells.values()].sort((a, b) => order(a.level) - order(b.level) || a.name.localeCompare(b.name))) {
		if (!groups.has(spell.level)) groups.set(spell.level, { level: spell.level, slots: slots[spell.level] || null, spells: [] });
		groups.get(spell.level).spells.push(spell);
	}
	return [...groups.values()];
}

module.exports = { buildSpellbook };
