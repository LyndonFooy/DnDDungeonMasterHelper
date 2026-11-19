'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const { generateNpc, loadNpcData, renderText, parseArgs } = require('../generateNpc.js');
const items = require('../magicItems.js');

const data = loadNpcData();
const SCRIPT = path.join(__dirname, '..', 'generateNpc.js');
const ABILITIES = ['Str', 'Dex', 'Con', 'Int', 'Wis', 'Cha'];
const SPELL_LEVELS = ['Cantrip', '1st-level', '2nd-level', '3rd-level', '4th-level', '5th-level', '6th-level', '7th-level', '8th-level', '9th-level'];
const mod = (s) => Math.floor((s - 10) / 2);
const entryNames = (arr) => arr.map((o) => Object.keys(o)[0]);
const type = (key) => data.npcTypes.find((t) => t.key === key);
const weaponByName = (name) => data.weapons.find((w) => w.name === name);
// Proficiencies an NPC gained from Combat Training, as keys (medium, heavy, shields, martial, ...).
const GAIN_KEYS = { 'Light armor': 'light', 'Medium armor': 'medium', 'Heavy armor': 'heavy', Shields: 'shields', 'Simple weapons': 'simple', 'Martial weapons': 'martial' };
const gainedProfs = (c) => (c.ProficiencyGains || []).map((g) => GAIN_KEYS[Object.values(g)[0]]).filter(Boolean);
// Weapon categories the NPC may carry: the type's own plus any it gained.
const weaponCategories = (t, c) => [...[].concat(t.weapons.category), ...gainedProfs(c).filter((p) => p === 'simple' || p === 'martial').map((p) => p[0].toUpperCase() + p.slice(1))];
const ARMOR_FEAT_PROFS = { 'Lightly Armored': ['light'], 'Moderately Armored': ['medium', 'shields'], 'Heavily Armored': ['heavy'] };
// Armor proficiencies from the type, Combat Training and armor feats.
const armorProfsOf = (t, c) => new Set([...t.armorProficiencies, ...gainedProfs(c), ...c.Feats.flatMap((f) => ARMOR_FEAT_PROFS[f] || [])]);
const heaviestRating = (profs) => ['heavy', 'medium', 'light'].find((r) => profs.has(r));
// The light/medium/heavy armor named in the statblock's Armor line ("half plate" is listed before "plate").
const wornArmor = (c) => data.armor.find((a) => ['light', 'medium', 'heavy'].includes(a.type) && new RegExp(`\\b${a.inventoryName || a.name}\\b`, 'i').test(c.Armor));
// Only the items matching `re` are on offer.
const withItems = (re) => ({ ...data, magicItems: data.magicItems.filter((i) => re.test(i.name)) });

// Generates with seeds until one NPC gets an item from the restricted pool.
function npcWithItem(re, options) {
	const d = withItems(re);
	for (let i = 0; i < 300; i++) {
		const c = generateNpc({ magicItems: 1, maxRarity: 'legendary', ...options, seed: `${options.seed || 'item'}-${i}` }, d);
		if (c.MagicItems.length) return c;
	}
	throw new Error(`No NPC took an item matching ${re}`);
}

test('loads every NPC type folder', () => {
	assert.deepEqual(data.npcTypes.map((t) => t.key).sort(), ['expert', 'martial', 'spellcaster', 'warrior']);
	const martialRole = type('warrior').features.find((f) => f.key === 'martial role');
	assert.ok(martialRole.choices.some((c) => /fighting style/i.test(c.name)), 'fighting styles copied from the fighter');
	const expertise = type('expert').features.find((f) => f.key === 'expertise');
	assert.equal(expertise.extraChoices.options.length, data.skills.length);
});

// ---------------------------------------------------------------------------------------------
// Sweep: every type, every level, a few seeds, with and without magic items
// ---------------------------------------------------------------------------------------------

test('every NPC type generates a sane NPC at every level', () => {
	for (const t of data.npcTypes) {
		for (let level = 1; level <= 20; level++) {
			for (const seed of ['a', 'b', 'c']) {
				const label = `${t.key} L${level} seed ${seed}`;
				const magicItems = seed === 'c' ? 3 : 0;
				const c = generateNpc({ level, type: t.key, seed: `${seed}-${t.key}-${level}`, magicItems, maxRarity: 'rare' });
				const json = JSON.stringify(c);

				assert.doesNotMatch(json, /undefined|NaN|\[object|null \(|Infinity/, `${label}: bad value in output`);
				assert.doesNotMatch(json, /\[(MON|STR|DEX|CON|INT|WIS|CHA|FIN)[ \]]|\{(level|school|additional)\}/, `${label}: unresolved token`);
				assert.equal(c.Level, level);
				assert.equal(c.Class, t.name);
				assert.equal(c['Proficiency Bonus'], data.levels[level - 1].proficiencyBonus, `${label}: proficiency bonus`);

				// HP: fixed average with the type's hit die (+1/level for Dwarven Toughness)
				const [, hp, n, die] = /^(\d+) \((\d+)d(\d+)/.exec(c.HitPoints).map(Number);
				assert.equal(n, level);
				assert.equal(die, t.hitDie, `${label}: hit die`);
				const perLevel = mod(c.Stats.Con) + (/hill dwarf/i.test(c.Race) ? 1 : 0);
				assert.equal(hp, Math.max(level, die + (level - 1) * (die / 2 + 1) + perLevel * level), `${label}: HP`);

				// Weapons: one melee and one ranged from the type's category, listed as the first two actions
				const actions = entryNames(c.Actions).filter((a) => a !== 'Multiattack');
				const [melee, ranged] = c.Build.split(' & ').map(weaponByName);
				assert.ok(melee && ranged, `${label}: build names two weapons (${c.Build})`);
				assert.ok(weaponCategories(t, c).includes(melee.category), `${label}: melee category`);
				assert.ok(weaponCategories(t, c).includes(ranged.category), `${label}: ranged category`);
				assert.equal(melee.list, 'melee');
				assert.equal(ranged.list, 'ranged');
				assert.ok(!t.weapons.exclude.includes(melee.key) && !t.weapons.exclude.includes(ranged.key), `${label}: excluded weapon`);
				assert.ok(actions.length >= 2, `${label}: two weapon actions`);

				// Armor allowed for the type (or an armor feat); shields only when proficient, one-handed and not dual-wielding
				const profs = new Set([...t.armorProficiencies, ...gainedProfs(c)]);
				for (const f of c.Feats) {
					const feat = data.feats.find((x) => x.name === f.replace(/ \(.*$/, ''));
					['light', 'medium', 'heavy', 'shields'].forEach((r, i) => { if ((feat.armorProficiencies || [])[i]) profs.add(r); });
				}
				const worn = data.armor.find((a) => ['light', 'medium', 'heavy'].includes(a.type) && new RegExp(`\\b${a.inventoryName || a.name}\\b`, 'i').test(c.Armor));
				if (worn) assert.ok(profs.has(worn.type), `${label}: ${worn.type} armor not allowed (${c.Armor})`);
				// A random armor of the heaviest rating it's proficient with (items can swap armor for a robe or bracers)
				if (!magicItems) assert.equal(worn && worn.type, heaviestRating(profs), `${label}: ${c.Armor} with ${[...profs]}`);
				const dual = c.BonusActions.some((a) => /^Off-Hand /.test(Object.keys(a)[0]));
				if (/shield/i.test(c.Armor)) {
					assert.ok(profs.has('shields'), `${label}: shield not allowed`);
					assert.ok(!melee.twoHanded && !dual, `${label}: shield with a two-handed weapon or two weapons`);
				}
				if (dual) assert.ok(!melee.twoHanded, `${label}: dual-wielding a two-handed weapon`);

				// Every ASI level is a feat (or an ASI when nothing qualifies, which never happens with these types)
				const asis = t.asiLevels.filter((l) => l <= level).length;
				assert.equal(c.Feats.length, asis, `${label}: feats`);
				const singles = c.Feats.map((f) => f.replace(/ \(.*$/, '')).filter((n) => !data.feats.find((x) => x.name === n).allowDuplicates);
				assert.equal(new Set(singles).size, singles.length, `${label}: repeated feat`);

				// Ability scores stay within 20 unless a magic item sets them higher
				for (const ab of ABILITIES) assert.ok(c.Stats[ab] >= 3 && c.Stats[ab] <= (magicItems ? 29 : 20), `${label}: ${ab} ${c.Stats[ab]}`);

				// Multiattack from the attacks-per-level table
				const attacks = t.attacksPerLevel[level - 1];
				const multi = c.Actions.find((a) => a.Multiattack);
				if (attacks > 1) assert.match(multi.Multiattack, new RegExp(`makes ${['two', 'three', 'four', 'five'][attacks - 2]} attacks`), `${label}: multiattack`);
				else assert.equal(multi, undefined, `${label}: unexpected multiattack`);

				// Magic items: at most the number asked for, never above the max rarity
				assert.ok(c.MagicItems.length <= magicItems);
				for (const m of c.MagicItems) assert.ok(items.rarityRank(Object.values(m)[0].split(',')[0]) <= items.rarityRank('rare'), `${label}: rarity`);

				assert.ok(renderText(c).length > 100);
			}
		}
	}
});

test('the same seed gives the same NPC', () => {
	const a = generateNpc({ level: 9, seed: 'same', magicItems: 2, maxRarity: 'very rare' });
	const b = generateNpc({ level: 9, seed: 'same', magicItems: 2, maxRarity: 'very rare' });
	assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------------------------
// Type rules
// ---------------------------------------------------------------------------------------------

test('weapons decide whether Str or Dex leads', () => {
	for (let i = 0; i < 60; i++) {
		const c = generateNpc({ level: 1, type: i % 2 ? 'warrior' : 'expert', seed: `lead-${i}`, race: 'human' });
		// Two-Weapon Fighting can swap in a light weapon of either kind (martial light weapons are all finesse)
		if (c.BonusActions.some((a) => /^Off-Hand /.test(Object.keys(a)[0]))) continue;
		const melee = weaponByName(c.Build.split(' & ')[0]);
		const [lead, other] = melee.finesse ? ['Dex', 'Str'] : ['Str', 'Dex'];
		assert.ok(c.Stats[lead] > c.Stats[other], `${c.Build}: ${lead} ${c.Stats[lead]} vs ${other} ${c.Stats[other]}`);
	}
});

test('warrior feats: no Lightly/Moderately Armored, Fighting Initiate takes a different style that works', () => {
	let initiates = 0;
	for (let i = 0; i < 600; i++) {
		const level = 4 + (i % 17);
		const c = generateNpc({ level, type: 'warrior', seed: `feat-${i}` });
		assert.ok(!c.Feats.some((f) => /^(Lightly|Moderately) Armored/.test(f)), `${c.Seed}: ${c.Feats}`);
		const fi = c.Feats.find((f) => /^Fighting Initiate/.test(f));
		if (!fi) continue;
		initiates++;
		const style = /^Fighting Initiate \((.+)\)$/.exec(fi)[1];
		assert.ok(!c.Subclass.startsWith(style), `${c.Seed}: ${style} twice`);
		if (style === 'Defense' && /shield/.test(c.Armor)) {
			// Defense from the feat adds to AC: armor + Dex (capped) + shield + 1 + Improved Defense
			const armor = data.armor.find((a) => new RegExp(`^\\d+ \\(${a.inventoryName || a.name}\\b`, 'i').test(c.Armor));
			const dex = armor.type === 'heavy' ? 0 : armor.type === 'medium' ? Math.min(2, mod(c.Stats.Dex)) : mod(c.Stats.Dex);
			assert.equal(parseInt(c.Armor, 10), armor.ac + dex + 2 + 1 + (level >= 10 ? 1 : 0), `${c.Seed}: ${c.Armor}`);
		}
	}
	assert.ok(initiates > 10, 'some warriors take Fighting Initiate');
});

test('gear-dependent feats are only taken when the gear fits, and change the gear when they should', () => {
	const POLEARMS = ['glaive', 'halberd', 'pike', 'quarterstaff', 'spear'];
	const seen = {};
	for (let i = 0; i < 3000; i++) {
		const t = data.npcTypes[i % data.npcTypes.length];
		const c = generateNpc({ level: 4 + (i % 17), type: t.key, seed: `gear-${i}` });
		const label = `${c.Seed} (${t.key})`;
		const [melee, ranged] = c.Build.split(' & ').map(weaponByName);
		const names = c.Feats.map((f) => f.replace(/ \(.*$/, ''));
		const has = (n) => names.includes(n);
		const dual = c.BonusActions.some((a) => /^Off-Hand /.test(Object.keys(a)[0]));
		const styles = [c.Subclass || '', ...c.Feats].join('|');
		for (const n of names) seen[n] = (seen[n] || 0) + 1;
		if (/Two-Weapon Fighting/.test(styles)) seen.twf = (seen.twf || 0) + 1;

		const excluded = (t.excludedFeats || []).map((n) => n.toLowerCase());
		for (const n of names) assert.ok(!excluded.includes(n.toLowerCase()), `${label}: excluded feat ${n}`);
		if (has('Defensive Duelist')) assert.ok(melee.finesse, `${label}: Defensive Duelist with ${melee.name}`);
		if (has('Crossbow Expert')) assert.match(ranged.key, /crossbow/, `${label}: Crossbow Expert with ${c.Build}`);
		if (has('Shield Master')) assert.match(c.Armor, /shield/, `${label}: Shield Master without a shield`);
		if (has('Polearm Master')) assert.ok(POLEARMS.includes(melee.key), `${label}: Polearm Master with ${melee.name}`);
		for (const [feat, type] of [['Slasher', 'slashing'], ['Crusher', 'bludgeoning'], ['Piercer', 'piercing']]) {
			if (has(feat)) assert.ok([melee, ranged].some((w) => w.damage.type === type), `${label}: ${feat} with ${c.Build}`);
		}
		for (const n of names) {
			const feat = data.feats.find((x) => x.name === n);
			if (feat.prerequisites && feat.prerequisites.spellcasting) {
				assert.ok(c.Spellcasting.SpellcastingAbility || c.Spellcasting.FeatSpells, `${label}: ${n} without spellcasting`);
			}
			if (n === 'Lightly Armored') assert.equal(t.key, 'martial', `${label}: Lightly Armored with light armor proficiency`);
		}
		if (has('Dual Wielder') || /Two-Weapon Fighting/.test(styles)) {
			assert.ok(dual, `${label}: two weapons expected`);
			assert.ok(!/shield/.test(c.Armor) && !melee.twoHanded, `${label}: ${c.Armor} / ${melee.name}`);
			assert.ok(c.Equipment.includes(`2 ${melee.name.toLowerCase()}s`), `${label}: ${c.Equipment}`);
			assert.ok(weaponCategories(t, c).includes(melee.category), `${label}: dual-wield category`);
			if (!has('Dual Wielder')) assert.ok(melee.light, `${label}: Two-Weapon Fighting with ${melee.name}`);
		} else {
			assert.ok(!dual, `${label}: unexpected off-hand attack`);
		}
		// Spells from feats with big pools are picked and shown (small pools can be all known already)
		for (const p of c.Feats) {
			const feat = data.feats.find((x) => x.name === p.replace(/ \(.*$/, ''));
			const option = (feat.choices || []).find((o) => p.endsWith(`(${o.name})`));
			if (['Magic Initiate', 'Fey Touched', 'Shadow Touched'].includes(feat.name) && option && option.key !== 'artificer') {
				assert.ok((c.Spellcasting.FeatSpells || []).some((e) => Object.keys(e)[0] === p), `${label}: no spells listed for ${p}`);
				assert.ok(c.Abilities.some((a) => Object.keys(a)[0] === `Spellcasting (${p})`), `${label}: no spellcasting entry for ${p}`);
			}
		}
	}
	for (const n of ['Defensive Duelist', 'Crossbow Expert', 'Dual Wielder', 'Shield Master', 'Polearm Master', 'War Caster', 'Magic Initiate', 'twf']) {
		assert.ok(seen[n] > 0, `never saw ${n}`);
	}
});

test('armor feats grant the proficiency and switch to armor of that rating', () => {
	// The shipped types exclude these feats, so lift the exclusions here to test the behaviour
	const open = { ...data, npcTypes: data.npcTypes.map((t) => ({ ...t, excludedFeats: [] })) };
	const seen = {};
	for (let i = 0; i < 1500; i++) {
		const t = open.npcTypes[i % open.npcTypes.length];
		const c = generateNpc({ level: 4 + (i % 17), type: t.key, seed: `armor-${i}` }, open);
		const has = (n) => c.Feats.includes(n);
		for (const n of ['Lightly Armored', 'Moderately Armored', 'Heavily Armored']) if (has(n)) seen[n] = (seen[n] || 0) + 1;
		if (has('Lightly Armored')) assert.equal(t.key, 'martial', `${c.Seed}: only the Martial starts without light armor`);
		// The NPC wears armor of its heaviest rating, which an armor feat may have raised
		const worn = wornArmor(c);
		assert.equal(worn && worn.type, heaviestRating(armorProfsOf(t, c)), `${c.Seed}: ${c.Feats} in ${c.Armor}`);
		if (has('Moderately Armored') && !has('Heavily Armored')) {
			const melee = weaponByName(c.Build.split(' & ')[0]);
			const dual = c.BonusActions.some((a) => /^Off-Hand /.test(Object.keys(a)[0]));
			// Moderately Armored grants shields, which the NPC may or may not carry
			const key = /shield/.test(c.Armor) ? 'moderateShield' : 'moderateNoShield';
			if (!melee.twoHanded && !dual) seen[key] = (seen[key] || 0) + 1;
		}
		if (t.key === 'warrior') assert.ok(!has('Moderately Armored') && !has('Heavily Armored'), 'warriors already have all armor');
	}
	assert.ok(seen['Moderately Armored'] > 0 && seen['Heavily Armored'] > 0, JSON.stringify(seen));
	assert.ok(seen.moderateShield > 0, `a Moderately Armored spellcaster picks up a shield (${JSON.stringify(seen)})`);
});

test('NPCs who can use a shield carry one only some of the time', () => {
	const counts = { shield: 0, none: 0 };
	for (let i = 0; i < 800; i++) {
		const shieldTypes = data.npcTypes.filter((x) => x.armorProficiencies.includes('shields'));
		const t = shieldTypes[i % shieldTypes.length];
		const c = generateNpc({ level: 1 + (i % 20), type: t.key, seed: `shield-${i}` });
		const melee = weaponByName(c.Build.split(' & ')[0]);
		const dual = c.BonusActions.some((a) => /^Off-Hand /.test(Object.keys(a)[0]));
		if (melee.twoHanded || dual) continue;
		counts[/shield/.test(c.Armor) ? 'shield' : 'none']++;
	}
	const share = counts.shield / (counts.shield + counts.none);
	assert.ok(share > 0.35 && share < 0.65, `shield share ${share.toFixed(2)} (${JSON.stringify(counts)})`);
});

test('dual wielder: +1 AC, off-hand attack', () => {
	for (let i = 0; i < 2000; i++) {
		const c = generateNpc({ level: 4, type: 'warrior', seed: `dw-${i}`, race: 'human' });
		if (!c.Feats.includes('Dual Wielder')) continue;
		const armor = data.armor.find((a) => new RegExp(`^\\d+ \\(${a.inventoryName || a.name}\\b`, 'i').test(c.Armor));
		const dex = armor.type === 'heavy' ? 0 : armor.type === 'medium' ? Math.min(2, mod(c.Stats.Dex)) : mod(c.Stats.Dex);
		const defense = /^Defense/.test(c.Subclass) ? 1 : 0;
		assert.equal(parseInt(c.Armor, 10), armor.ac + dex + defense + 1, `${c.Seed}: ${c.Armor}`);
		const off = c.BonusActions.find((a) => /^Off-Hand /.test(Object.keys(a)[0]));
		assert.ok(off, 'off-hand attack');
		return;
	}
	assert.fail('no level 4 warrior took Dual Wielder');
});

test('warrior: saves, skills, fighting style, Improved Defense', () => {
	const c = generateNpc({ level: 10, type: 'warrior', seed: 'guard' });
	assert.equal(c.SavingThrows.length, 1);
	assert.ok(['Str', 'Dex', 'Con'].includes(Object.keys(c.SavingThrows[0])[0]));
	assert.ok(c.Skills.length >= 2);
	assert.match(c.Subclass, /Fighting Style$/);
	const names = entryNames([...c.Abilities, ...c.BonusActions]).join('|');
	assert.match(names, /Second Wind \(Recharges after a Short or Long Rest\)/);
	assert.match(names, /Improved Critical/);
	assert.match(names, /Battle Readiness/);
	assert.doesNotMatch(names, /Improved Defense|Bonus Proficiencies|Martial Role/);

	// Improved Defense: same seed at 9 and 10 wears the same armor, one more AC at 10
	const before = generateNpc({ level: 9, type: 'warrior', seed: 'ac', race: 'human' });
	const after = generateNpc({ level: 10, type: 'warrior', seed: 'ac', race: 'human' });
	assert.equal(before.Armor.replace(/^\d+/, ''), after.Armor.replace(/^\d+/, ''));
	assert.equal(parseInt(after.Armor, 10), parseInt(before.Armor, 10) + 1);

	const l20 = generateNpc({ level: 20, type: 'warrior', seed: 'old' });
	assert.ok(entryNames(l20.BonusActions).includes('Second Wind (2/Short Rest)'));
	assert.ok(entryNames(l20.Abilities).includes('Indomitable (2/Day)'));
});

test('expert: five skills, expertise, tools, Sharp Mind', () => {
	for (const level of [1, 3, 15, 18]) {
		const c = generateNpc({ level, type: 'expert', seed: `scout-${level}` });
		assert.ok(c.Skills.length >= 5, `L${level} skills`); // race traits and feats can add more
		assert.equal(c.Tools.length, 2);
		const expertise = c.Skills.filter((s) => {
			const [name, bonus] = Object.entries(s)[0];
			const ab = data.skills.find((x) => x.name === name).ability;
			return bonus === mod(c.Stats[ab]) + 2 * c['Proficiency Bonus'];
		}).length;
		assert.equal(expertise, level >= 15 ? 4 : level >= 3 ? 2 : 0, `L${level} expertise`);
		assert.ok(c.SavingThrows.length >= (level >= 18 ? 2 : 1), `L${level} saves`); // Resilient can add one
		assert.ok(c.SavingThrows.some((s) => ['Dex', 'Int', 'Cha'].includes(Object.keys(s)[0])), `L${level} Bonus Proficiencies save`);
		assert.ok(entryNames(c.BonusActions).includes('Helpful'));
	}
	const c = generateNpc({ level: 20, type: 'expert', seed: 'sage' });
	assert.ok(entryNames(c.Abilities).includes('Inspiring Help (2d6)'));
	assert.match(c.Abilities.find((a) => a['Inspiring Help (2d6)'])['Inspiring Help (2d6)'], /a 2d6 bonus/);
});

test('martial: extra attacks at 5/10/15/20, feats at 2/7/12/18, random saves at 1/6/11/16', () => {
	const t = type('martial');
	assert.deepEqual(t.asiLevels, [2, 7, 12, 18]);
	const savesAt = (level) => [1, 6, 11, 16].filter((l) => l <= level).length;
	const seenSaves = new Set();
	for (let level = 1; level <= 20; level++) {
		const attacks = 1 + [5, 10, 15, 20].filter((l) => l <= level).length;
		assert.equal(t.attacksPerLevel[level - 1], attacks, `L${level} attacks`);
		for (let i = 0; i < 5; i++) {
			const c = generateNpc({ level, type: 'martial', seed: `martial-${level}-${i}` });
			const saves = c.SavingThrows.map((s) => Object.keys(s)[0]);
			saves.forEach((s) => seenSaves.add(s));
			const resilient = c.Feats.filter((f) => /^Resilient/.test(f)).length;
			assert.equal(saves.length, savesAt(level) + resilient, `${c.Seed}: saves ${saves} with feats ${c.Feats}`);
			const names = entryNames([...c.Abilities, ...c.BonusActions]).join('|');
			assert.doesNotMatch(names, /Tenacity|Extra Attack|Bonus Proficiencies/, `${c.Seed}: bookkeeping feature shown`);
		}
	}
	assert.equal(seenSaves.size, 6, `every save can come up (${[...seenSaves]})`);
});

test('martial: no armor at first, Combat Training at 3/8/13/19 gains a random armor or weapon proficiency it lacks', () => {
	const t = type('martial');
	const firstPicks = {};
	let featOverlap = 0;
	let heavyFeat = 0;
	for (let i = 0; i < 1200; i++) {
		const level = 1 + (i % 20);
		const c = generateNpc({ level, type: 'martial', seed: `training-${i}` });
		const label = `${c.Seed} L${level}`;
		const levels = (c.ProficiencyGains || []).map((g) => Number(Object.keys(g)[0]));
		assert.deepEqual(levels, [3, 8, 13, 19].filter((l) => l <= level), `${label}: gain levels`);
		const gains = gainedProfs(c);
		assert.equal(new Set(gains).size, gains.length, `${label}: repeated gain ${gains}`);
		if (gains.length) firstPicks[gains[0]] = (firstPicks[gains[0]] || 0) + 1;

		// A proficiency from a feat is never gained again later, and nothing gained comes from outside the list
		const fromFeats = c.Feats.flatMap((f) => ARMOR_FEAT_PROFS[f] || []);
		gains.forEach((g, n) => {
			assert.ok(['light', 'medium', 'heavy', 'shields', 'martial'].includes(g), `${label}: gained ${g}`);
			// Feats are listed in ASI order (2, 7, 12, 18); the ones before this gain's level already granted theirs
			const earlierFeats = c.Feats.filter((f, k) => t.asiLevels[k] < levels[n]);
			assert.ok(!earlierFeats.flatMap((f) => ARMOR_FEAT_PROFS[f] || []).includes(g), `${label}: gained ${g} after a feat granted it (${c.Feats})`);
		});
		if (fromFeats.length) featOverlap++;
		if (c.Feats.includes('Heavily Armored')) heavyFeat++;
		// Every gain slot is used while something is left to gain
		const owned = new Set([...gains, ...fromFeats]);
		if (owned.size < 5) assert.ok(!(c.ProficiencyGains || []).some((g) => /none left/.test(Object.values(g)[0])), `${label}: wasted a gain`);

		// Gear follows the proficiencies
		const [melee, ranged] = c.Build.split(' & ').map(weaponByName);
		if (!gains.includes('martial')) assert.ok(melee.category === 'Simple' && ranged.category === 'Simple', `${label}: martial weapon without proficiency`);
		const profs = new Set(owned);
		const worn = data.armor.find((a) => ['light', 'medium', 'heavy'].includes(a.type) && new RegExp(`\\b${a.inventoryName || a.name}\\b`, 'i').test(c.Armor));
		if (worn) assert.ok(profs.has(worn.type), `${label}: ${worn.type} armor without proficiency (${c.Armor})`);
		if (/shield/.test(c.Armor)) assert.ok(profs.has('shields'), `${label}: shield without proficiency`);
	}
	for (const p of ['light', 'medium', 'heavy', 'shields', 'martial']) assert.ok(firstPicks[p] > 150, `first pick ${p}: ${JSON.stringify(firstPicks)}`);
	assert.ok(featOverlap > 0 && heavyFeat > 0, 'martials can take armor feats');
});

test('spellcaster: role lists, slot table, spells known, Potent Cantrips, Empowered Spells', () => {
	const sc = type('spellcaster').spellcasting;
	for (const role of sc.roles) {
		for (let level = 1; level <= 20; level++) {
			const c = generateNpc({ level, type: 'spellcaster', role: role.key, seed: `cast-${level}` });
			const label = `${role.key} L${level}`;
			assert.equal(c.Subclass, role.name);
			assert.equal(c.Spellcasting.SpellcastingAbility, role.ability);

			const expected = sc.slots[level - 1].map((n, i) => ({ [SPELL_LEVELS[i + 1]]: n }));
			assert.deepEqual(c.Spellcasting.SpellSlots, expected, `${label}: slots`);

			let cantrips = 0;
			let known = 0;
			for (const group of c.Spellcasting.Spells) {
				const [lvl, names] = Object.entries(group)[0];
				const n = SPELL_LEVELS.indexOf(lvl);
				assert.ok(n >= 0 && n <= 5, `${label}: spell level ${lvl}`);
				if (n > 0) assert.ok(sc.slots[level - 1][n - 1] > 0, `${label}: ${lvl} spell without slots`);
				for (const name of names) {
					const spell = data.spells.get(name.toLowerCase());
					assert.ok(role.lists.some((l) => spell.classes.has(l)), `${label}: ${name} not on ${role.lists}`);
				}
				if (n === 0) cantrips += names.length; else known += names.length;
			}
			assert.equal(cantrips, sc.cantripsKnown[level - 1], `${label}: cantrips`);
			assert.equal(known, sc.spellsKnown[level - 1], `${label}: spells known`);
			assert.match(c.Abilities.find((a) => a.Spellcasting).Spellcasting, new RegExp(`knows the following ${role.lists.join(' and ')} spells`));

			const names = entryNames(c.Abilities).join('|');
			if (level >= 14) assert.match(names, /Empowered Spells \((Abjuration|Conjuration|Divination|Enchantment|Evocation|Illusion|Necromancy|Transmutation)\)/);
			if (level >= 20) assert.match(names, /Focused Casting/);
		}
	}
	// Potent Cantrips: cantrip damage gains the casting modifier from 6th level
	const fireBolt = (level) => {
		const c = generateNpc({ level, type: 'spellcaster', role: 'mage', seed: 'bolt' });
		const action = c.Actions.find((a) => a['Fire Bolt']);
		return { text: action && action['Fire Bolt'], m: mod(c.Stats.Int) };
	};
	const low = fireBolt(5);
	const high = fireBolt(6);
	assert.match(low.text, /\(2d10\) fire/);
	assert.match(high.text, new RegExp(`\\(2d10 \\+ ${high.m}\\) fire`));
});

// ---------------------------------------------------------------------------------------------
// Magic items
// ---------------------------------------------------------------------------------------------

test('items never exceed the max rarity and the count asked for', () => {
	for (const rarity of items.RARITIES) {
		for (let i = 0; i < 15; i++) {
			const c = generateNpc({ level: 10, seed: `rar-${rarity}-${i}`, magicItems: 3, maxRarity: rarity });
			assert.ok(c.MagicItems.length <= 3);
			if (c.MagicItems.length < 3) assert.match(c.Notes[0], /Only \d of the 3 requested/);
			for (const m of c.MagicItems) assert.ok(items.rarityRank(Object.values(m)[0].split(',')[0]) <= items.rarityRank(rarity));
		}
	}
	assert.throws(() => generateNpc({ level: 3, magicItems: 1, maxRarity: 'mythic' }), /Unknown rarity/);
});

test('item pool expands +1/+2/+3 variants with their own rarity', () => {
	const weapons = data.magicItems.filter((i) => /^Weapon \+\d$/.test(i.name)).map((i) => `${i.name}:${i.rarity}`);
	assert.deepEqual(weapons, ['Weapon +1:uncommon', 'Weapon +2:rare', 'Weapon +3:very rare']);
	assert.ok(data.magicItems.every((i) => items.rarityRank(i.rarity) >= 0));
});

test('magic weapons attach to the NPC weapon and add to hit and damage', () => {
	const c = npcWithItem(/^Weapon \+2$/, { level: 5, type: 'warrior', seed: 'plus2' });
	const action = c.Actions.find((a) => /^\+2 /.test(Object.keys(a)[0]));
	assert.ok(action, 'a +2 weapon attack');
	const [name, text] = Object.entries(action)[0];
	const w = weaponByName(name.replace(/^\+2 /, ''));
	const ab = w.finesse ? (mod(c.Stats.Dex) > mod(c.Stats.Str) ? 'Dex' : 'Str') : w.list === 'ranged' ? 'Dex' : 'Str';
	const style = /Archery/.test(c.Subclass) && w.list === 'ranged' ? 2 : 0;
	assert.match(text, new RegExp(`^_\\w+[\\w ]*:_ \\+${c['Proficiency Bonus'] + mod(c.Stats[ab]) + 2 + style} to hit`));
	assert.ok(c.Equipment.some((e) => e === name.toLowerCase()));

	const flame = npcWithItem(/^Flame Tongue$/, { level: 5, type: 'warrior', seed: 'flame' });
	assert.match(JSON.stringify(flame.Actions), /Flame Tongue \(\w+\).*plus 7 \(2d6\) fire damage/);
	const disruption = npcWithItem(/^Mace of Disruption$/, { level: 5, type: 'expert', seed: 'mace' });
	assert.match(JSON.stringify(disruption.Actions), /plus 7 \(2d6\) radiant damage against fiends and undead/);
});

test('weapon and armor items only go to NPCs whose gear they fit', () => {
	for (let i = 0; i < 40; i++) {
		const c = generateNpc({ level: 8, seed: `fit-${i}`, magicItems: 4, maxRarity: 'legendary' });
		const [melee, ranged] = c.Build.split(' & ').map(weaponByName);
		for (const m of c.MagicItems) {
			const it = data.magicItems.find((x) => x.name === Object.keys(m)[0]);
			if (!it) continue; // spell scrolls are renamed after their spell
			if (items.isWeaponItem(it)) {
				const spec = (/\((.+)\)/.exec(it.type) || [])[1];
				assert.ok(items.weaponMatches(spec, melee) || items.weaponMatches(spec, ranged), `${it.name} on ${c.Build}`);
			}
			if (items.isArmorItem(it)) assert.ok(!/^\d+ \((mage|unarmored)/.test(c.Armor), `${it.name} without armor`);
			if (items.isShieldItem(it)) assert.match(c.Armor, /shield/);
			if (/^Staff of the Magi|^Staff of Power|^Robe of the Archmagi/.test(it.name)) assert.equal(c.Subclass === 'Mage' || c.Subclass === 'Prodigy', true);
		}
	}
});

test('AC, save and ability items change the numbers', () => {
	const ring = npcWithItem(/^Ring of Protection$/, { level: 4, type: 'warrior', seed: 'ring' });
	const plain = generateNpc({ level: 4, type: 'warrior', seed: ring.Seed });
	assert.equal(parseInt(ring.Armor, 10), parseInt(plain.Armor, 10) + 1);
	assert.equal(ring.SavingThrows.length, 6);
	for (const s of ring.SavingThrows) {
		const [ab, v] = Object.entries(s)[0];
		const prof = plain.SavingThrows.some((p) => p[ab]) ? ring['Proficiency Bonus'] : 0;
		assert.equal(v, mod(ring.Stats[ab]) + prof + 1, `${ab} save`);
	}

	const shield = npcWithItem(/^Shield \+2$/, { level: 5, type: 'expert', seed: 'shield' });
	assert.match(shield.Armor, /\+2 shield/);
	assert.equal(parseInt(shield.Armor, 10), parseInt(generateNpc({ level: 5, type: 'expert', seed: shield.Seed }).Armor, 10) + 2);

	const gauntlets = npcWithItem(/^Gauntlets of Ogre Power$/, { level: 3, type: 'spellcaster', seed: 'ogre' });
	assert.ok(gauntlets.Stats.Str >= 19);

	const amulet = npcWithItem(/^Amulet of Health$/, { level: 5, type: 'expert', seed: 'health' });
	assert.ok(amulet.Stats.Con >= 19);
	assert.match(amulet.HitPoints, new RegExp(`\\(5d8 \\+ ${mod(amulet.Stats.Con) * 5}\\)`));

	const bracers = npcWithItem(/^Bracers of Defense$/, { level: 6, type: 'spellcaster', role: 'mage', seed: 'bracers' });
	assert.equal(parseInt(bracers.Armor, 10), 12 + mod(bracers.Stats.Dex));
	assert.ok(!bracers.Equipment.some((e) => /armor/.test(e)), 'bracers wearer takes its armor off');

	const staff = npcWithItem(/^Staff of Power$/, { level: 15, type: 'spellcaster', role: 'mage', seed: 'staff' });
	assert.equal(staff.Spellcasting.SpellAttackBonus, staff['Proficiency Bonus'] + mod(staff.Stats.Int) + 2);
	assert.match(JSON.stringify(staff.Actions), /5 charges; 5th level: _fireball, lightning bolt_/);
});

test('senses, speeds, resistances and spells from items', () => {
	const goggles = npcWithItem(/^Goggles of Night$/, { level: 3, type: 'warrior', race: 'human', seed: 'goggles' });
	assert.ok(goggles.Senses.includes('darkvision 60 ft.'));
	const periapt = npcWithItem(/^Periapt of Proof Against Poison$/, { level: 3, type: 'warrior', seed: 'periapt' });
	assert.ok(periapt.DamageImmunities.includes('poison') && periapt.ConditionImmunities.includes('poisoned'));
	const slippers = npcWithItem(/^Slippers of Spider Climbing$/, { level: 3, type: 'expert', seed: 'climb' });
	assert.equal(slippers.Speeds.climb, slippers.Speed);
	const wand = npcWithItem(/^Wand of Fireballs$/, { level: 9, type: 'spellcaster', seed: 'wand' });
	const entry = wand.Actions.find((a) => /^Wand of Fireballs/.test(Object.keys(a)[0]));
	assert.match(Object.keys(entry)[0], /7 Charges; regains 1d6\+1 at dawn/);
	assert.match(Object.values(entry)[0], /spell save DC 15/);
	assert.deepEqual(wand.Spellcasting.ItemSpells, [{ 'Wand of Fireballs': ['Fireball'] }]);
	const scroll = npcWithItem(/^Spell Scroll \(3rd-level\)$/, { level: 7, type: 'spellcaster', role: 'healer', seed: 'scroll' });
	const spell = Object.keys(scroll.MagicItems[0])[0].replace(/^Spell Scroll \((.+)\)$/, '$1');
	assert.ok(data.spells.get(spell.toLowerCase()).level === 3);
	// Scrolls are random: any NPC, any spell of the scroll's level
	const warriorScroll = npcWithItem(/^Spell Scroll \(5th-level\)$/, { level: 3, type: 'warrior', seed: 'anyscroll' });
	const warriorSpell = Object.keys(warriorScroll.MagicItems[0])[0].replace(/^Spell Scroll \((.+)\)$/, '$1');
	assert.equal(data.spells.get(warriorSpell.toLowerCase()).level, 5);
	assert.ok(warriorScroll.Actions.some((a) => Object.keys(a)[0] === `Spell Scroll (${warriorSpell})`));
	const offList = new Set();
	for (let i = 0; i < 60; i++) {
		const c = npcWithItem(/^Spell Scroll \(1st-level\)$/, { level: 2, type: 'spellcaster', role: 'healer', seed: `offlist-${i}` });
		const name = Object.keys(c.MagicItems[0])[0].replace(/^Spell Scroll \((.+)\)$/, '$1');
		const spell = data.spells.get(name.toLowerCase());
		if (!spell.classes.has('cleric') && !spell.classes.has('druid')) offList.add(name);
	}
	assert.ok(offList.size > 0, 'scroll spells are not limited to the role lists');
});

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

test('parseArgs maps the NPC flags', () => {
	const a = parseArgs(['7', '-t', 'spellcaster', '--role', 'healer', '-m', '2', '--max-rarity', 'very rare', '-s', 'x']);
	assert.equal(a.level, 7);
	assert.equal(a.type, 'spellcaster');
	assert.equal(a.role, 'healer');
	assert.equal(a.magicItems, 2);
	assert.equal(a.maxRarity, 'very rare');
	assert.equal(a.seed, 'x');
});

test('CLI prints a statblock', () => {
	const run = spawnSync(process.execPath, [SCRIPT, '-l', '6', '-t', 'expert', '-s', 'cli', '-m', '1', '-f', 'text'], { encoding: 'utf8' });
	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /Level 6 Expert/);
	assert.match(run.stdout, /Armor Class \d+/);
	const bad = spawnSync(process.execPath, [SCRIPT, '-l', '6', '-t', 'warrior', '--role', 'mage'], { encoding: 'utf8' });
	assert.notEqual(bad.status, 0);
	assert.match(bad.stderr, /no roles/);
});
