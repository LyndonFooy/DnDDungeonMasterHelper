'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadEnvironments, rollEnvironment } = require('../environment.js');

const envs = loadEnvironments();
const env = (key) => envs.find((e) => e.key === key);
// A roller that returns the given faces in order (situation, twist, location, then any effect dice).
const faces = (...values) => () => {
	if (!values.length) throw new Error('ran out of faces');
	return values.shift();
};
const byKey = (rolled, key) => rolled.rolls.find((r) => r.key === key);

test('loads the Mangrove Swamp and Desert environments, sorted by name', () => {
	assert.deepEqual(envs.map((e) => [e.key, e.name]), [['desert', 'Desert'], ['mangrove-swamp', 'Mangrove Swamp']]);
	for (const e of envs) assert.deepEqual(e.rolls.map((r) => r.key), ['situation', 'twist', 'location']);
});

test('random rolls always land on an entry, within the die', () => {
	for (const e of envs) {
		for (let i = 0; i < 200; i++) {
			for (const r of rollEnvironment(e).rolls) {
				const sides = Number(r.die.slice(2));
				assert.ok(r.roll >= 1 && r.roll <= sides, `${e.name} ${r.key} rolled ${r.roll}`);
				assert.ok(r.result.name);
			}
		}
	}
});

test('Storm Incoming unlocks the Storm Rolls table; other twists unlock nothing', () => {
	const stormy = rollEnvironment(env('mangrove-swamp'), { die: faces(1, 5, 1) });
	const twist = byKey(stormy, 'twist');
	assert.equal(twist.result.name, 'Storm Incoming');
	assert.equal(twist.tables.length, 1);
	assert.equal(twist.tables[0].key, 'storm');
	assert.equal(twist.tables[0].name, 'Storm Rolls');
	assert.equal(twist.tables[0].entries.length, 5); // 3–4 is one "Nothing" row
	assert.deepEqual(stormy.rolls.flatMap((r) => r.tables).map((t) => t.key), ['storm']);

	const calm = rollEnvironment(env('mangrove-swamp'), { die: faces(1, 1, 1) });
	assert.deepEqual(calm.rolls.flatMap((r) => r.tables), []);
});

test('Obelisk of the Lost unlocks the Obelisk Rolls table', () => {
	const rolled = rollEnvironment(env('desert'), { die: faces(2, 3, 15) });
	const location = byKey(rolled, 'location');
	assert.equal(location.result.name, 'Obelisk of the Lost');
	assert.equal(location.tables[0].key, 'obelisk');
	assert.equal(location.tables[0].entries.length, 12);
});

test('Dense Fog and Sandstorm roll their max visual range (1d4 × 10 ft)', () => {
	const fog = byKey(rollEnvironment(env('mangrove-swamp'), { die: faces(1, 6, 3, 1) }), 'twist');
	assert.equal(fog.result.name, 'Dense Fog');
	assert.deepEqual(fog.result.effects, [
		{ label: 'Max visual range', dice: '1d4', rolls: [3], bonus: 0, multiplier: 10, value: 30, unit: 'ft' },
	]);
	const sand = byKey(rollEnvironment(env('desert'), { die: faces(1, 5, 4, 1) }), 'twist');
	assert.equal(sand.result.name, 'Sandstorm Approaching');
	assert.equal(sand.result.effects[0].value, 40);
});

test('`only` rerolls a single roll; an unknown key is an error', () => {
	const rolled = rollEnvironment(env('desert'), { only: 'location', die: faces(20) });
	assert.equal(rolled.rolls.length, 1);
	assert.equal(rolled.rolls[0].result.name, 'The Shattered Sky');
	assert.throws(() => rollEnvironment(env('desert'), { only: 'weather' }), /no roll "weather"/);
});

test('the loader rejects tables with gaps, overlaps or unknown links', (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const write = (rolls, tables) => fs.writeFileSync(path.join(dir, 'Test.json'), JSON.stringify({ name: 'Test', rolls, tables }));
	const roll = (entries) => [{ key: 'x', name: 'X', die: '1d2', entries }];

	write(roll([{ roll: 1, name: 'A' }]));
	assert.throws(() => loadEnvironments(dir), /no entry for roll 2/);
	write(roll([{ roll: [1, 2], name: 'A' }, { roll: 2, name: 'B' }]));
	assert.throws(() => loadEnvironments(dir), /roll 2 is used by both/);
	write(roll([{ roll: 1, name: 'A', tables: ['nope'] }, { roll: 2, name: 'B' }]));
	assert.throws(() => loadEnvironments(dir), /unknown table "nope"/);
	write(roll([{ roll: 1, name: 'A' }, { roll: 3, name: 'B' }]));
	assert.throws(() => loadEnvironments(dir), /outside 1–2/);
	write(roll([{ roll: 1, name: 'A', tables: ['t'] }, { roll: 2, name: 'B' }]),
		{ t: { name: 'T', die: '1d2', entries: [{ roll: [1, 2], name: 'Any' }] } });
	assert.equal(loadEnvironments(dir)[0].key, 'test');
});
