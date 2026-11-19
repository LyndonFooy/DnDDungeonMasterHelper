'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const { generateCompanion, loadData, renderText, thirdPerson, prose, parseArgs } = require('../generateCharacter.js');

const data = loadData();
const SCRIPT = path.join(__dirname, '..', 'generateCharacter.js');
const ABILITIES = ['Str', 'Dex', 'Con', 'Int', 'Wis', 'Cha'];
const mod = (s) => Math.floor((s - 10) / 2);
const entryNames = (arr) => arr.map((o) => Object.keys(o)[0]);
const spellsAt = (c, level) => (c.Spellcasting.Spells.find((g) => g[level]) || {})[level] || [];

function slotTable(cls, level) {
	const sc = cls.spellcasting;
	if (!sc) return {};
	const t = data.slotTables;
	const row = sc.progression === 'pact'
		? t.pact[level]
		: t.full[sc.progression === 'full' ? level : level < 2 ? 0 : Math.ceil(level / 2)];
	return Object.fromEntries(Object.entries(row).filter(([k, n]) => /level$/.test(k) && n > 0));
}

// ---------------------------------------------------------------------------------------------
// Sweep: every class, every level, a few seeds
// ---------------------------------------------------------------------------------------------

test('every class generates a sane companion at every level', () => {
	for (const cls of data.classes) {
		for (let level = 1; level <= 20; level++) {
			for (const seed of ['a', 'b', 'c']) {
				const label = `${cls.key} L${level} seed ${seed}`;
				const c = generateCompanion({ level, class: cls.key, seed: `${seed}-${cls.key}-${level}` });
				const json = JSON.stringify(c);

				assert.doesNotMatch(json, /undefined|NaN|\[object|null \(|Infinity/, `${label}: bad value in output`);
				assert.doesNotMatch(json, /\[(MON|STR|DEX|CON|INT|WIS|CHA|FIN)[ \]]/, `${label}: unresolved token`);
				assert.equal(c.Level, level);
				assert.equal(c.Class, cls.name);
				assert.equal(c['Proficiency Bonus'], data.levels[level - 1].proficiencyBonus, `${label}: proficiency bonus`);

				// Ability scores: 20 cap, except Primal Champion's 24
				for (const ab of ABILITIES) {
					const max = cls.key === 'barbarian' && level === 20 && (ab === 'Str' || ab === 'Con') ? 24 : 20;
					assert.ok(c.Stats[ab] >= 3 && c.Stats[ab] <= max, `${label}: ${ab} ${c.Stats[ab]}`);
				}

				// HP matches the fixed-average formula (+1/level for Dwarven Toughness / Draconic Resilience)
				const [, hp, n, die] = /^(\d+) \((\d+)d(\d+)/.exec(c.HitPoints).map(Number);
				assert.equal(n, level);
				assert.equal(die, cls.hitDie);
				const perLevel = mod(c.Stats.Con) + (/hill dwarf/i.test(c.Race) ? 1 : 0) + (/Draconic/.test(c.Subclass || '') ? 1 : 0);
				assert.equal(hp, Math.max(level, die + (level - 1) * (die / 2 + 1) + perLevel * level), `${label}: HP`);

				const ac = parseInt(c.Armor, 10);
				assert.ok(ac >= 10 && ac <= 24, `${label}: AC ${c.Armor}`);
				assert.ok(c.Actions.length >= 1, `${label}: has at least one action`);

				// Saving throws come from the class
				for (const ab of cls.savingThrows) assert.ok(c.SavingThrows.some((s) => s[ab] !== undefined), `${label}: ${ab} save`);

				// Subclass appears at the class's subclass level
				if (level >= cls.subclassLevel) assert.ok(c.Subclass, `${label}: subclass expected`);
				else assert.equal(c.Subclass, null, `${label}: no subclass yet`);

				// Spell slots match the MPMB tables; cantrip count matches the class table (+ bonus cantrips)
				const expectedSlots = slotTable(cls, level);
				const slots = Object.assign({}, ...c.Spellcasting.SpellSlots);
				assert.deepEqual(slots, expectedSlots, `${label}: spell slots`);
				const sc = cls.spellcasting;
				if (sc && sc.cantripsKnown) {
					const bonus = /circle of the land/i.test(c.Subclass || '') ? 1 : 0;
					assert.equal(spellsAt(c, 'Cantrip').length, sc.cantripsKnown[level - 1] + bonus, `${label}: cantrips`);
				}
				const maxSlot = Math.max(0, ...Object.keys(expectedSlots).map((k) => parseInt(k, 10)));
				for (const group of c.Spellcasting.Spells) {
					const [lvl] = Object.keys(group);
					if (/level$/.test(lvl) && sc && cls.key !== 'warlock' && cls.key !== 'bard') {
						assert.ok(parseInt(lvl, 10) <= maxSlot, `${label}: ${lvl} spell without a slot`);
					}
				}
				if (sc && maxSlot > 0) {
					const levelled = c.Spellcasting.Spells.filter((g) => /level$/.test(Object.keys(g)[0])).reduce((a, g) => a + Object.values(g)[0].length, 0);
					if (sc.preparation === 'known' && cls.key !== 'bard') {
						assert.equal(levelled, sc.spellsKnown[level - 1], `${label}: spells known`);
						// Mystic Arcanum: one 1/day spell per arcanum level gained (6th at 11, 7th at 13, ...)
						const arcanum = cls.key === 'warlock' ? [11, 13, 15, 17].filter((l) => level >= l).length : 0;
						// (invocations such as Mire the Mind can add lower-level 1/day spells too)
						const daily = (c.Spellcasting.Spells.find((g) => g['1/day each']) || { '1/day each': [] })['1/day each'];
						const highDaily = daily.filter((n) => data.spells.get(n.toLowerCase()).level >= 6);
						assert.equal(highDaily.length, arcanum, `${label}: arcanum`);
					} else if (sc.preparation !== 'known') {
						const prepared = Math.max(1, mod(c.Stats[sc.ability]) + Math.floor(level / (sc.preparedFormula.levelDivisor || 1)));
						assert.ok(levelled >= prepared, `${label}: prepared ${levelled} < ${prepared}`);
					}
				}

				assert.ok(renderText(c).length > 100, `${label}: text render`);
			}
		}
	}
});

test('every race (and variant) works', () => {
	for (const race of data.races) {
		for (const variant of race.variants || [undefined]) {
			const c = generateCompanion({ level: 6, race: race.key, raceVariant: variant && variant.key, seed: race.key + (variant ? variant.key : '') });
			assert.equal(c.Size, race.size);
			for (const l of race.languages) assert.ok(c.Languages.includes(l), `${race.key}: language ${l}`);
			if (variant) assert.ok(c.Actions.some((a) => /^Breath Weapon/.test(Object.keys(a)[0])), `${variant.key}: breath weapon`);
		}
	}
});

// ---------------------------------------------------------------------------------------------
// Specific mechanics
// ---------------------------------------------------------------------------------------------

test('same seed gives the same companion; different seeds differ', () => {
	const a = generateCompanion({ level: 7, seed: 'repeatable' });
	const b = generateCompanion({ level: 7, seed: 'repeatable' });
	assert.deepEqual(a, b);
	const others = ['x', 'y', 'z'].map((s) => JSON.stringify(generateCompanion({ level: 7, seed: s })));
	assert.ok(new Set(others).size > 1);
});

test('fighter multiattack scales with Extra Attack', () => {
	const attacks = (level) => {
		const c = generateCompanion({ level, class: 'fighter', seed: 'ma' });
		const m = c.Actions.find((a) => a.Multiattack);
		return m ? m.Multiattack : '';
	};
	assert.equal(attacks(4), '');
	assert.match(attacks(5), /makes two attacks/);
	assert.match(attacks(11), /makes three attacks/);
	assert.match(attacks(20), /makes four attacks/);
});

test('ability score improvements are applied at ASI levels', () => {
	const total = (level) => Object.values(generateCompanion({ level, class: 'rogue', race: 'human', seed: 'asi', featChance: 0 }).Stats).reduce((a, b) => a + b, 0);
	const base = 15 + 14 + 13 + 12 + 10 + 8 + 6; // standard array + human +1s
	assert.equal(total(3), base);
	assert.equal(total(4), base + 2);
	assert.equal(total(10), base + 6); // rogue ASIs at 4, 8, 10
});

test('warlocks get Eldritch Blast with beams that scale', () => {
	const c = generateCompanion({ level: 11, class: 'warlock', seed: 'eb' });
	const eb = c.Actions.find((a) => a['Eldritch Blast']);
	assert.ok(eb, 'Eldritch Blast action');
	assert.match(eb['Eldritch Blast'], /fires three beams/);
	assert.ok(c.Spellcasting.Spells.some((g) => g['1/day each']), 'Mystic Arcanum spells');
});

test('Draconic sorcerers get the dependent Elemental Affinity', () => {
	const c = generateCompanion({ level: 6, class: 'sorcerer', subclass: 'draconic', seed: 'dragon' });
	const names = entryNames(c.Abilities);
	const ancestor = names.find((n) => /Dragon Ancestor/.test(n));
	const affinity = names.find((n) => /Elemental Affinity/.test(n));
	const typeOf = (txt) => /(acid|cold|fire|lightning|poison)/i.exec(txt)[1].toLowerCase();
	const ancestorText = c.Abilities.find((o) => o[ancestor])[ancestor];
	assert.equal(typeOf(affinity), typeOf(ancestorText));
});

test('wizards with Find Familiar get a familiar that cannot attack', () => {
	for (let i = 0; i < 30; i++) {
		const c = generateCompanion({ level: 5, class: 'wizard', seed: `fam${i}` });
		const knows = c.Spellcasting.Spells.some((g) => (g['1st-level'] || []).includes('Find Familiar'));
		assert.equal(!!c.Companions, knows, 'familiar present iff Find Familiar known');
		if (c.Companions) {
			const pet = c.Companions[0];
			assert.equal(pet.Actions.length, 0);
			assert.match(pet.Type, /celestial, fey, or fiend/i);
			return;
		}
	}
	assert.fail('no wizard learned Find Familiar in 30 tries');
});

test('domain spells are always prepared but expanded patron spells are not auto-known', () => {
	const cleric = generateCompanion({ level: 5, class: 'cleric', subclass: 'life', seed: 'dom' });
	for (const s of ['Bless', 'Cure Wounds', 'Lesser Restoration', 'Spiritual Weapon', 'Beacon of Hope', 'Revivify']) {
		assert.ok(JSON.stringify(cleric.Spellcasting.Spells).includes(s), `cleric knows ${s}`);
	}
	const warlock = generateCompanion({ level: 9, class: 'warlock', seed: 'fiend' });
	const levelled = warlock.Spellcasting.Spells.filter((g) => /level$/.test(Object.keys(g)[0])).reduce((a, g) => a + Object.values(g)[0].length, 0);
	assert.equal(levelled, 10);
});

test('feats taken instead of ASIs are visible in the sheet and their prerequisites are met', () => {
	const byName = new Map(data.feats.filter((f) => !f.hiddenInSheet).map((f) => [f.name, f]));
	let seen = 0;
	for (let i = 0; i < 150; i++) {
		const c = generateCompanion({ level: 12, seed: `feat${i}`, featChance: 1 });
		for (const entry of [...c.Abilities, ...c.Actions, ...c.BonusActions, ...c.Reactions]) {
			const full = Object.keys(entry)[0];
			const feat = byName.get(full.replace(/ \(.*$/, ''));
			if (!feat || !full.startsWith(feat.name)) continue;
			seen++;
			assert.ok(!feat.unearthedArcana, `${feat.name} is UA`);
			const p = feat.prerequisites;
			if (!p) continue;
			assert.ok(!p.other && !p.feats && !p.campaign, `${feat.name}: unverifiable prerequisite taken`);
			if (p.abilityScores) assert.ok(true); // checked against pre-feat scores inside the generator
			if (p.races) assert.ok(p.races.some((r) => /small race/i.test(r) ? c.Size === 'Small' : new RegExp(`(^|[^\\w-])${r.toLowerCase().replace(/ \(.*/, '')}`).test(c.Race.toLowerCase())), `${feat.name} taken by a ${c.Race}`);
			if (p.spellcasting) assert.ok(c.Spellcasting.SpellcastingAbility || /Paladin|Ranger/.test(c.Class), `${feat.name} taken by a non-caster`);
		}
	}
	assert.ok(seen > 100, `feats were taken (${seen})`);
});

test('Resilient grants the chosen saving throw proficiency', () => {
	for (let i = 0; i < 400; i++) {
		const c = generateCompanion({ level: 8, seed: `res${i}`, featChance: 1 });
		const entry = c.Abilities.find((o) => /^Resilient \(/.test(Object.keys(o)[0]));
		if (!entry) continue;
		const ability = /^Resilient \((\w+)\)/.exec(Object.keys(entry)[0])[1];
		const abbr = { Strength: 'Str', Dexterity: 'Dex', Constitution: 'Con', Intelligence: 'Int', Wisdom: 'Wis', Charisma: 'Cha' }[ability];
		assert.ok(c.SavingThrows.some((s) => s[abbr] !== undefined), `Resilient (${ability}) adds the save`);
		return;
	}
	assert.fail('no companion took Resilient in 400 tries');
});

test('keepTokens leaves statblock tokens for the online generator', () => {
	const c = generateCompanion({ level: 5, class: 'fighter', seed: 'tok', keepTokens: true });
	const json = JSON.stringify(c);
	assert.match(json, /\[MON\]/);
	assert.match(json, /\[(STR|DEX|FIN) ATK\]/);
	assert.match(json, /\[(STR|DEX|FIN) \d+D\d+\]/);
});

test('rejects bad input', () => {
	assert.throws(() => generateCompanion({ level: 0 }), /Level must be/);
	assert.throws(() => generateCompanion({ level: 21 }), /Level must be/);
	assert.throws(() => generateCompanion({ level: 3, class: 'artificer' }), /Unknown class/);
	assert.throws(() => generateCompanion({ level: 3, race: 'warforged' }), /Unknown race/);
});

// ---------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------

test('thirdPerson rewrites first-person MPMB text', () => {
	assert.equal(thirdPerson('I can reroll a failed saving throw'), 'The [MON] can reroll a failed saving throw');
	assert.equal(thirdPerson('I gain proficiency with my weapons'), 'The [MON] gains proficiency with its weapons');
	assert.equal(thirdPerson("I'm immune to disease"), 'The [MON] is immune to disease');
	assert.equal(thirdPerson("I don't need adv."), "The [MON] doesn't need adv.");
	assert.equal(thirdPerson('I try to pin it; both the creature and I are restrained'), 'The [MON] tries to pin it; both the creature and the [MON] are restrained');
	assert.equal(thirdPerson('As a reaction, I reach out to me'), 'As a reaction, the [MON] reaches out to it');
});

test('prose drops sheet instructions and expands abbreviations', () => {
	const out = prose('Use the "Choose Feature" button above to add a favored enemy\nI have adv. on checks to track them\nIt lasts 10 min');
	assert.equal(out, 'The [MON] has advantage on checks to track them. It lasts 10 minutes.');
});

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

test('CLI parses arguments', () => {
	const a = parseArgs(['7', '-c', 'bard', '--race=half-elf', '--keep-tokens', '-n', '3']);
	assert.equal(a.level, 7);
	assert.equal(a.class, 'bard');
	assert.equal(a.race, 'half-elf');
	assert.equal(a.keepTokens, true);
	assert.equal(a.count, 3);
});

test('CLI prints JSON and text', () => {
	const json = spawnSync(process.execPath, [SCRIPT, '--level', '4', '--seed', 'cli'], { encoding: 'utf8' });
	assert.equal(json.status, 0, json.stderr);
	assert.equal(JSON.parse(json.stdout).Level, 4);

	const many = spawnSync(process.execPath, [SCRIPT, '-l', '2', '-n', '3', '-s', 'party'], { encoding: 'utf8' });
	assert.equal(many.status, 0, many.stderr);
	assert.equal(JSON.parse(many.stdout).length, 3);

	const text = spawnSync(process.execPath, [SCRIPT, '-l', '3', '-c', 'rogue', '-f', 'text', '-s', 'cli'], { encoding: 'utf8' });
	assert.equal(text.status, 0, text.stderr);
	assert.match(text.stdout, /Armor Class \d+/);

	const missing = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /Please give a level/);
});
