/*
 * Environment randomizer: rolls a situation, twist and location (or whatever `rolls` an environment defines) from the
 * tables in Data/Environments/ (format: Data/Environments/README.md).
 *
 *   loadEnvironments(dir?) -> [{ key, name, rolls, tables }]   (validated, sorted by name)
 *   rollEnvironment(env, { only?, die? }) -> { key, name, rolls: [rolled] }
 *
 * Each rolled result is { key, name, die, roll, result: { name, description?, effects: [...] }, tables: [...] }.
 * `effects` are dice rolled along with the entry ("Max visual range: 30 ft"); `tables` are the nested tables the
 * entry unlocks, returned whole for the DM to roll on during play. `only` rerolls a single roll by key; `die` is the
 * roller, (sides) => 1..sides, for tests.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'Data', 'Environments');

const randomDie = (sides) => 1 + Math.floor(Math.random() * sides);
const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const faces = (roll) => (Array.isArray(roll) ? roll : [roll, roll]);

function parseDice(expr) {
	const m = /^(\d*)d(\d+)\s*(?:([+-])\s*(\d+))?$/i.exec(String(expr).trim());
	if (!m) throw new Error(`bad dice "${expr}"`);
	const count = Number(m[1] || 1);
	const sides = Number(m[2]);
	const bonus = m[3] ? Number(m[4]) * (m[3] === '-' ? -1 : 1) : 0;
	if (count < 1 || sides < 2) throw new Error(`bad dice "${expr}"`);
	return { count, sides, bonus };
}

// Every face of the table's die must belong to exactly one entry.
function checkTable(table, where, nestedIds) {
	const { count, sides, bonus } = parseDice(table.die);
	if (count !== 1 || bonus) throw new Error(`${where}: die must be a single die like 1d6, not "${table.die}"`);
	if (!Array.isArray(table.entries) || !table.entries.length) throw new Error(`${where}: no entries`);
	const owner = Array(sides + 1).fill(null);
	for (const e of table.entries) {
		if (!e.name) throw new Error(`${where}: an entry has no name`);
		const [lo, hi] = faces(e.roll);
		if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi > sides || lo > hi) {
			throw new Error(`${where}: "${e.name}" has roll ${JSON.stringify(e.roll)}, outside 1–${sides}`);
		}
		for (let f = lo; f <= hi; f++) {
			if (owner[f]) throw new Error(`${where}: roll ${f} is used by both "${owner[f]}" and "${e.name}"`);
			owner[f] = e.name;
		}
		for (const fx of e.effects || []) parseDice(fx.dice);
		for (const id of e.tables || []) {
			if (!nestedIds) throw new Error(`${where}: "${e.name}" links a table, but nested tables can't link further`);
			if (!nestedIds.includes(id)) throw new Error(`${where}: "${e.name}" links unknown table "${id}"`);
		}
	}
	const missing = owner.slice(1).map((o, i) => (o ? 0 : i + 1)).filter(Boolean);
	if (missing.length) throw new Error(`${where}: no entry for roll ${missing.join(', ')}`);
}

function checkEnvironment(env, file) {
	if (!env.name) throw new Error(`${file}: no name`);
	if (!Array.isArray(env.rolls) || !env.rolls.length) throw new Error(`${file}: no rolls`);
	const tables = env.tables || {};
	const ids = Object.keys(tables);
	const keys = new Set();
	for (const r of env.rolls) {
		if (!r.key || !r.name) throw new Error(`${file}: every roll needs a key and a name`);
		if (keys.has(r.key)) throw new Error(`${file}: duplicate roll key "${r.key}"`);
		keys.add(r.key);
		checkTable(r, `${file} ${r.key}`, ids);
	}
	for (const id of ids) {
		if (!tables[id].name) throw new Error(`${file}: table "${id}" has no name`);
		checkTable(tables[id], `${file} table ${id}`, null);
	}
}

function loadEnvironments(dir = DIR) {
	const envs = fs.readdirSync(dir)
		.filter((f) => f.toLowerCase().endsWith('.json'))
		.map((f) => {
			const env = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
			checkEnvironment(env, f);
			return { key: slug(env.name), name: env.name, rolls: env.rolls, tables: env.tables || {} };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
	const seen = new Set();
	for (const e of envs) {
		if (seen.has(e.key)) throw new Error(`two environments are named "${e.name}"`);
		seen.add(e.key);
	}
	return envs;
}

function rollEffect(fx, die) {
	const { count, sides, bonus } = parseDice(fx.dice);
	const rolls = Array.from({ length: count }, () => die(sides));
	const multiplier = fx.multiplier ?? 1;
	const value = (rolls.reduce((a, b) => a + b, 0) + bonus) * multiplier;
	return { label: fx.label, dice: fx.dice, rolls, bonus, multiplier, value, unit: fx.unit || '' };
}

function rollOne(env, def, die) {
	const { sides } = parseDice(def.die);
	const roll = die(sides);
	const entry = def.entries.find((e) => { const [lo, hi] = faces(e.roll); return roll >= lo && roll <= hi; });
	return {
		key: def.key,
		name: def.name,
		die: def.die,
		roll,
		result: {
			name: entry.name,
			...(entry.description ? { description: entry.description } : {}),
			effects: (entry.effects || []).map((fx) => rollEffect(fx, die)),
		},
		tables: (entry.tables || []).map((id) => ({ key: id, ...env.tables[id] })),
	};
}

function rollEnvironment(env, { only, die = randomDie } = {}) {
	const defs = only ? env.rolls.filter((r) => r.key === only) : env.rolls;
	if (only && !defs.length) throw new Error(`${env.name} has no roll "${only}"`);
	return { key: env.key, name: env.name, rolls: defs.map((d) => rollOne(env, d, die)) };
}

module.exports = { loadEnvironments, rollEnvironment, parseDice, DIR };
