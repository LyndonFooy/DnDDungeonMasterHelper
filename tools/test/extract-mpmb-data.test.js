'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const x = require('../extract-mpmb-data.js');

const ROOT = path.resolve(__dirname, '..', '..', 'Data');
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

test('parsePrereq reads levels, spells and features from option names', () => {
	assert.deepEqual(x.parsePrereq('Thirsting Blade (prereq: level 5 warlock, Pact of the Blade)'),
		{ text: 'level 5 warlock, Pact of the Blade', level: 5, features: ['Pact of the Blade'] });
	assert.deepEqual(x.parsePrereq('Agonizing Blast (prereq: Eldritch Blast cantrip)'),
		{ text: 'Eldritch Blast cantrip', spells: ['Eldritch Blast'] });
	assert.equal(x.parsePrereq("Devil's Sight"), undefined);
});

test('parseSkillChoice handles lists and "any"', () => {
	assert.deepEqual(x.parseSkillChoice('Choose two from History, Insight, Medicine, Persuasion, and Religion'),
		{ count: 2, from: ['History', 'Insight', 'Medicine', 'Persuasion', 'Religion'] });
	assert.deepEqual(x.parseSkillChoice('Choose one from Animal Handling, Athletics, or Survival'),
		{ count: 1, from: ['Animal Handling', 'Athletics', 'Survival'] });
	assert.deepEqual(x.parseSkillChoice('Choose any three skills'), { count: 3, from: 'any' });
});

test('parseUsagesCalc turns Acrobat field scripts into formulas', () => {
	assert.deepEqual(x.parseUsagesCalc("event.value = Math.max(1, What('Cha Mod'));"), { ability: 'Cha', min: 1 });
	assert.deepEqual(x.parseUsagesCalc("event.value = 1 + What('Cha Mod');"), { ability: 'Cha', plus: 1 });
	assert.equal(x.parseUsagesCalc('event.value = 3;'), undefined);
});

test('normalizeDamage covers weapon, cantrip and flat damage', () => {
	assert.deepEqual(x.normalizeDamage([2, 6, 'slashing']), { dice: '2d6', count: 2, die: 6, type: 'slashing' });
	assert.deepEqual(x.normalizeDamage(['C', 10, 'fire']), { dice: '1d10', die: 10, type: 'fire', scalesWithCantripDie: true });
	assert.deepEqual(x.normalizeDamage([1, '', 'piercing']), { flat: 1, type: 'piercing' });
});

test('helpers for spell and race text', () => {
	assert.equal(x.expandCastingTime('1 a'), '1 action');
	assert.equal(x.expandCastingTime('1 bns'), '1 bonus action');
	assert.equal(x.expandCastingTime('10 min'), '10 minutes');
	const { header, traits } = x.parseRaceTraits('Elf (+2 Dex)\nTrance: I meditate\n   for 4 hours.\nLucky: I reroll 1s');
	assert.equal(header, 'Elf (+2 Dex)');
	assert.deepEqual(traits, [{ name: 'Trance', desc: 'I meditate for 4 hours.' }, { name: 'Lucky', desc: 'I reroll 1s' }]);
	assert.equal(x.linesToProse('line one\nline two,\nthree'), 'line one. line two, three.');
});

test('parsePlayerReference reads sections whose headings follow their entries', () => {
	const text = [
		'AREA OF EFFECT', 'CUBE', ' SPHERE CYLINDER', 'Point of Origin CONE', 'PLAYER REFERENCE',
		'FALLING', '1d6 bludgeoning damage per 10 feet fallen.', 'ENVIRONMENT', '(PHB 183)',
		'DISARM (instead of one attack) (DMG 271)', 'Knock an item from grasp, see ‘Two-', 'Weapon Fighting’.', 'ATTACK ACTION', '(PHB 195)',
		'BLINDED', 'Fail checks involving sight. ', 'Attacks have disadvantage.', 'CONDITIONS', '(PHB 290)',
		'LEVEL EFFECT (cumulative)', '1 Disadvantage on ability checks', '6 Death', ' EXHAUSTION  (PHB 291)',
		'PACE MINUTE HOUR DAY EFFECT', 'Normal 300 feet 3 miles 24 miles ––', 'TRAVEL PACE (PHB 182)',
	].join('\n');
	const r = x.parsePlayerReference(text);
	assert.deepEqual(r['Area of Effect'].shapes, ['Cube', 'Sphere', 'Cylinder', 'Cone']);
	assert.deepEqual(r.Environment, { source: 'PHB 183', entries: [{ name: 'Falling', description: '1d6 bludgeoning damage per 10 feet fallen.' }] });
	assert.deepEqual(r['Attack Action'].entries[0], { name: 'Disarm', timing: 'instead of one attack', source: 'DMG 271', description: 'Knock an item from grasp, see ‘Two-Weapon Fighting’.' });
	assert.equal(r.Conditions.entries[0].description, 'Fail checks involving sight. Attacks have disadvantage.');
	assert.deepEqual(r.Exhaustion, { source: 'PHB 291', levels: [{ level: 1, effect: 'Disadvantage on ability checks' }, { level: 6, effect: 'Death' }], cumulative: true });
	assert.deepEqual(r['Travel Pace'].paces[0], { pace: 'Normal', perMinuteFeet: 300, perHourMiles: 3, perDayMiles: 24, effect: null });
});

test('buildCatalogs classifies drop-down lists and flags names with full data', () => {
	const lists = [
		{ fields: ['Feat Name 1'], tooltip: null, options: ['', 'Grappler', 'Made-Up Feat', 'Made-Up Feat'] },
		{ fields: ['["", "Acolyte"]'], tooltip: '𝘽𝙖𝙘𝙠𝙜𝙧𝙤𝙪𝙣𝙙\nType...', options: ['', 'Acolyte', 'Sage'] },
	];
	const c = x.buildCatalogs(lists, ROOT);
	assert.deepEqual(c.Feats, [{ name: 'Grappler', detailedIn: 'Feats/Feats.json' }, { name: 'Made-Up Feat' }]);
	assert.deepEqual(c.Backgrounds, [{ name: 'Acolyte', detailedIn: 'Backgrounds/Backgrounds.json' }, { name: 'Sage' }]);
});

// ---------------------------------------------------------------------------------------------
// The extracted JSON in the repo
// ---------------------------------------------------------------------------------------------

test('extracted classes are complete', () => {
	const classes = read('Classes/Classes.json');
	const subs = read('Classes/Subclasses.json');
	assert.equal(classes.length, 12);
	for (const c of classes) {
		assert.ok(c.hitDie && c.savingThrows.length === 2 && c.attacksPerLevel.length === 20, c.key);
		assert.ok(c.features.length >= 5, `${c.key} features`); // Extra Attack/ASIs live in attacksPerLevel/asiLevels
		for (const sk of c.subclasses) assert.ok(subs.some((s) => s.key === sk), `${c.key} subclass ${sk}`);
		if (c.spellcasting) assert.ok(['full', 'half', 'pact'].includes(c.spellcasting.progression), c.key);
	}
	// Every choice/extra choice resolved to a real option object (not just a name)
	for (const owner of [...classes, ...subs]) {
		for (const f of owner.features) {
			for (const o of f.choices || []) assert.ok(o.description || o.spellcastingExtra || o.dependentChoices, `${owner.key}/${f.key}/${o.key}`);
			for (const o of (f.extraChoices || {}).options || []) assert.ok(o.name, `${owner.key}/${f.key}/${o.key}`);
		}
	}
});

test('extracted lists have the expected shape', () => {
	const fs = read('Classes/FightingStyles.json');
	assert.deepEqual(fs.map((f) => f.key), ['archery', 'defense', 'dueling', 'great_weapon', 'protection', 'two_weapon']);
	const spells = read('Spells/SpellsSRD.json');
	assert.equal(spells.length, 319);
	for (const s of spells) assert.ok(s.name && s.level && s.school && s.casting_time && s.class !== undefined, s.name);
	assert.equal(read('Spells/SpellSlotTables.json').full[20]['9th-level'], 1);
	const weapons = read('Equipment/Weapons.json');
	assert.ok(weapons.find((w) => w.key === 'longsword').versatileDamage === '1d10');
	assert.ok(weapons.filter((w) => w.category === 'Cantrip').length >= 10);
	const races = read('Races/Races.json');
	assert.equal(races.find((r) => r.key === 'dragonborn').variants.length, 10);
	assert.ok(read('Creatures/Creatures.json').filter((c) => (c.companionTypes || []).includes('familiar')).length >= 10);
	assert.equal(read('Rules/Levels.json')[19].experiencePoints, 355000);
	assert.equal(read('Rules/Skills.json').length, 18);
	const items = read('MagicItems/MagicItems.json');
	assert.equal(items.length, 239);
	for (const i of items) assert.ok(i.rarity || (i.choices && i.choices.every((c) => c.rarity)) || i.dmgTable === undefined, `${i.key}: rarity`);
	assert.equal(items.find((i) => i.key === 'weapon, +1, +2, or +3').choices[1].rarity, 'rare');
});

test('parseFeatPrerequisite structures prerequisite text', () => {
	assert.deepEqual(x.parseFeatPrerequisite('Intelligence or Wisdom 13 or higher'),
		{ text: 'Intelligence or Wisdom 13 or higher', abilityScores: { anyOf: ['Int', 'Wis'], minimum: 13 } });
	assert.deepEqual(x.parseFeatPrerequisite('Being an Elf or a Half-Elf'), { text: 'Being an Elf or a Half-Elf', races: ['Elf', 'Half-Elf'] });
	assert.deepEqual(x.parseFeatPrerequisite('4th level, Strike of the Giants (Fire Strike) feat'),
		{ text: '4th level, Strike of the Giants (Fire Strike) feat', level: 4, feats: ['Strike of the Giants (Fire Strike)'] });
	assert.deepEqual(x.parseFeatPrerequisite('Proficiency with heavy armor'), { text: 'Proficiency with heavy armor', proficiency: 'heavy armor' });
	assert.equal(x.parseFeatPrerequisite('The ability to cast at least one spell').spellcasting, true);
	assert.equal(x.parseFeatPrerequisite('No other dragonmark').other, 'No other dragonmark');
});

test('feats come from the add-on stored in the PDF', () => {
	const feats = read('Feats/Feats.json');
	assert.equal(feats.length, 211);
	for (const name of ['Charger', 'Durable', 'Observant', 'Grappler', 'Sentinel', 'War Caster']) {
		const f = feats.find((x) => x.name === name);
		assert.ok(f && f.description && f.descriptionFull && f.sourceName, name);
	}
	assert.deepEqual(feats.find((f) => f.name === 'Durable').abilityScoreIncrease, { Con: 1 });
	const resilient = feats.find((f) => f.name === 'Resilient');
	assert.equal(resilient.choices.length, 6);
	assert.deepEqual(resilient.choices[2].savingThrows, ['Con']);
	// The sheet's source settings show exactly the drop-down's feats
	const visible = feats.filter((f) => !f.hiddenInSheet).map((f) => f.name).sort();
	assert.deepEqual(visible, read('Catalog/Feats.json').map((c) => c.name).sort());
	assert.ok(feats.filter((f) => f.unearthedArcana).every((f) => f.sources.some((s) => /^UA/.test(s.key))));
	for (const f of feats) assert.doesNotMatch(f.source, /undefined/, f.key);
});

test('extracted rules, reference and catalogs', () => {
	const ref = read('Rules/PlayerReference.json');
	assert.deepEqual(Object.keys(ref), ['Area of Effect', 'Environment', 'Attack Action', 'Conditions', 'Exhaustion', 'Travel Pace', 'Cover', 'Light & Vision', 'Combat Actions', 'Movement']);
	const conditions = read('Rules/Conditions.json');
	assert.equal(conditions.conditions.length, 14);
	assert.equal(conditions.exhaustion.levels.length, 6);
	for (const c of conditions.conditions) assert.ok(c.description.length > 10, c.name);
	assert.equal(ref['Combat Actions'].entries.length, 13);
	assert.deepEqual(read('Rules/AbilityScores.json').pointBuy.costs, { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 });
	assert.equal(read('Rules/Lifestyles.json').find((l) => l.name === 'Modest').dailyCost, '1 gp');
	assert.equal(read('Rules/Factions.json').length, 15);
	assert.equal(read('Spells/SpellPoints.json').levels[19].spellPoints, 133);
	assert.equal(read('Rules/Licenses.json')[0].name, 'OPEN GAME LICENSE Version 1.0a');
	// Every SRD entry with full data is found in its drop-down catalog
	const catalogDetailed = (file) => read(`Catalog/${file}`).filter((e) => e.detailedIn).length;
	assert.equal(catalogDetailed('MagicItems.json'), read('MagicItems/MagicItems.json').length);
	assert.equal(catalogDetailed('Races.json'), read('Races/Races.json').length);
	assert.equal(catalogDetailed('Weapons.json'), read('Equipment/Weapons.json').length);
	assert.ok(read('Catalog/MagicItems.json').length > 700);
});
