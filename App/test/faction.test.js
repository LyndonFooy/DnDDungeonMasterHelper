'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadNpcData } = require('../../Generators/NpcGenerator/generateNpc.js');
const { loadFactions, pickWeighted } = require('../faction.js');
const { buildEncounter } = require('../encounter.js');

const data = loadNpcData();
const factions = loadFactions(data);
const faction = (key) => factions.find((f) => f.key === key);
const raceOf = (npc) => npc.Race.toLowerCase();

function tempFactions(files) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factions-'));
	for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
	return dir;
}

// Rounded weights as { key: weight }, for comparing against the files' numbers.
const weights = (choices) => choices && Object.fromEntries(choices.map((c) => [c.key, Math.round(c.weight * 1000) / 1000]));

test('loads Adventurers, Bandits and Human Kingdoms, sorted by name, with names resolved to weighted keys', () => {
	assert.deepEqual(factions.map((f) => f.key), ['adventurers', 'bandits', 'human-kingdoms']);
	assert.equal(faction('adventurers').types, null);
	assert.equal(faction('adventurers').races, null);
	assert.deepEqual(weights(faction('bandits').types), { martial: 0.9, spellcaster: 0.1 });
	assert.equal(faction('bandits').races, null);
	assert.deepEqual(weights(faction('human-kingdoms').types), { martial: 0.75, spellcaster: 0.25 });
	assert.deepEqual(weights(faction('human-kingdoms').races), { human: 0.6, 'half-elf': 0.2, 'half-orc': 0.2 });
});

test('pickWeighted splits the 0–1 range by weight', () => {
	const choices = [{ key: 'a', weight: 0.75 }, { key: 'b', weight: 0.25 }];
	assert.equal(pickWeighted(choices, () => 0), 'a');
	assert.equal(pickWeighted(choices, () => 0.7499), 'a');
	assert.equal(pickWeighted(choices, () => 0.75), 'b');
	assert.equal(pickWeighted(choices, () => 0.9999), 'b');
	assert.equal(pickWeighted(null), undefined);
});

test('Human Kingdoms roll types and races close to their weights', () => {
	const types = {};
	const races = {};
	let n = 0;
	for (let i = 0; i < 60; i++) {
		for (const npc of buildEncounter({ count: 10, levels: 10, faction: faction('human-kingdoms') }, data).npcs) {
			types[npc.Class] = (types[npc.Class] || 0) + 1;
			races[raceOf(npc)] = (races[raceOf(npc)] || 0) + 1;
			n++;
		}
	}
	// 600 NPCs: each share's standard deviation is under 0.02, so ±0.07 fails only by a fluke.
	const near = (count, share, what) => assert.ok(Math.abs(count / n - share) < 0.07, `${what}: ${count}/${n}, expected about ${share}`);
	near(types.Martial, 0.75, 'Martial');
	near(types.Spellcaster, 0.25, 'Spellcaster');
	near(races.human, 0.6, 'Human');
	near(races['half-elf'], 0.2, 'Half-elf');
	near(races['half-orc'], 0.2, 'Half-orc');
});

test('Bandits roll only Martials and Spellcasters', () => {
	for (let i = 0; i < 20; i++) {
		const enc = buildEncounter({ count: 6, faction: faction('bandits') }, data);
		assert.equal(enc.faction, 'Bandits');
		for (const npc of enc.npcs) assert.ok(['Martial', 'Spellcaster'].includes(npc.Class), npc.Class);
	}
});

test('Human Kingdoms roll only human, half-elf and half-orc Martials and Spellcasters', () => {
	for (let i = 0; i < 20; i++) {
		for (const npc of buildEncounter({ count: 6, faction: faction('human-kingdoms') }, data).npcs) {
			assert.ok(['Martial', 'Spellcaster'].includes(npc.Class), npc.Class);
			assert.ok(['human', 'half-elf', 'half-orc'].includes(raceOf(npc)), npc.Name);
		}
	}
});

test('no faction, or Adventurers, can roll every type', () => {
	for (const f of [undefined, faction('adventurers')]) {
		const seen = new Set();
		for (let i = 0; i < 30 && seen.size < data.npcTypes.length; i++) {
			for (const npc of buildEncounter({ count: 6, faction: f }, data).npcs) seen.add(npc.Class);
		}
		assert.equal(seen.size, data.npcTypes.length);
	}
});

test('names are matched in any case; lists weigh evenly, weights are relative; empty means any', () => {
	const dir = tempFactions({
		'a.json': { name: 'Mixed', types: ['WARRIOR'], races: ['high elf', 'Tiefling'] },
		'b.json': { name: 'Open', types: [], races: {} },
		'c.json': { name: 'Relative', types: { martial: 3, EXPERT: 1 } },
	});
	const [mixed, open, relative] = loadFactions(data, dir);
	assert.deepEqual(weights(mixed.types), { warrior: 1 });
	assert.deepEqual(weights(mixed.races), { 'high elf': 0.5, tiefling: 0.5 });
	assert.equal(open.types, null);
	assert.equal(open.races, null);
	assert.deepEqual(weights(relative.types), { martial: 0.75, expert: 0.25 });
});

test('rejects unknown types and races, missing names and duplicate factions', () => {
	assert.throws(() => loadFactions(data, tempFactions({ 'x.json': { name: 'X', types: ['Paladin'] } })), /unknown type "Paladin"/);
	assert.throws(() => loadFactions(data, tempFactions({ 'x.json': { name: 'X', races: ['Orc'] } })), /unknown race "Orc"/);
	assert.throws(() => loadFactions(data, tempFactions({ 'x.json': { types: ['Martial'] } })), /no name/);
	assert.throws(() => loadFactions(data, tempFactions({ 'x.json': { name: 'X' }, 'y.json': { name: 'x' } })), /two factions/);
	for (const bad of [0, -1, '0.5', null]) {
		assert.throws(() => loadFactions(data, tempFactions({ 'x.json': { name: 'X', types: { Martial: bad } } })), /weights must be numbers above 0/);
	}
	assert.throws(() => loadFactions(data, tempFactions({ 'x.json': { name: 'X', races: { human: 1, Human: 2 } } })), /listed twice/);
	assert.throws(() => loadFactions(data, tempFactions({ 'x.json': { name: 'X', types: 'Martial' } })), /must be a list/);
});
