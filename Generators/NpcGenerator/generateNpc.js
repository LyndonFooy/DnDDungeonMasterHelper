#!/usr/bin/env node
/*
 * Random NPC generator.
 *
 * Builds an NPC with one of the simplified NPC classes in Generators/NpcGenerator/<Type>/<Type>.json (Warrior, Expert,
 * Spellcaster, ...). It reuses the companion generator's pipeline (Generators/CharacterGenerator/generateCharacter.js) with the
 * NPC rules: weapons are picked first and decide the stat order, armor comes from the type's proficiencies, every
 * Ability Score Improvement is a random feat, and NPCs can carry magic items.
 *
 *   node Generators/NpcGenerator/generateNpc.js --level 5
 *   node Generators/NpcGenerator/generateNpc.js -l 9 -t spellcaster --role healer --magic-items 2 --max-rarity rare -f text
 *   node Generators/NpcGenerator/generateNpc.js --help
 */
'use strict';
const fs = require('fs');
const path = require('path');
const {
	CompanionBuilder, loadData, renderText, readJson, prose, findEntry, titleCase, listJoin, signed, mod, avgDice,
	ABILITIES, SPELL_LEVELS,
} = require('../CharacterGenerator/generateCharacter.js');
const items = require('./magicItems.js');

const POLEARMS = new Set(['glaive', 'halberd', 'pike', 'quarterstaff', 'spear']);
const ARMOR_RATINGS = ['light', 'medium', 'heavy'];
// Chance that an NPC who could carry a shield (proficient, one-handed weapon, not dual-wielding) actually does.
const SHIELD_CHANCE = 0.5;

// ---------------------------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------------------------

// Every Generators/NpcGenerator/<Type>/*.json is an NPC type, so adding a type only needs a new folder.
function loadNpcTypes(data) {
	const types = [];
	for (const dir of fs.readdirSync(__dirname, { withFileTypes: true })) {
		if (!dir.isDirectory() || dir.name === 'test') continue;
		for (const file of fs.readdirSync(path.join(__dirname, dir.name)).filter((f) => f.endsWith('.json')).sort()) {
			types.push(resolveType(JSON.parse(fs.readFileSync(path.join(__dirname, dir.name, file), 'utf8')), data));
		}
	}
	return types;
}

// Fills in data the type files point to rather than repeat: fighting styles from a class, skill lists for expertise.
function resolveType(type, data) {
	const features = type.features.map((f) => {
		const out = { ...f };
		if (f.choicesFrom) {
			const cls = data.classes.find((c) => c.key === f.choicesFrom.class);
			const source = cls && cls.features.find((x) => x.key === f.choicesFrom.feature);
			if (!source || !source.choices) throw new Error(`${type.name}: can't find choices for ${JSON.stringify(f.choicesFrom)}`);
			out.choices = source.choices.map((c) => ({ ...c }));
		}
		if (f.extraChoices && f.extraChoices.options === 'skills') {
			out.extraChoices = { ...f.extraChoices, options: data.skills.map((s) => ({ key: s.name.toLowerCase(), name: `${s.name} Expertise` })) };
		}
		return out;
	});
	return { ...type, features };
}

let cachedNpcData;
function loadNpcData() {
	if (cachedNpcData) return cachedNpcData;
	const base = loadData();
	cachedNpcData = {
		...base,
		npcTypes: loadNpcTypes(base),
		magicItems: items.expandItems(readJson('MagicItems/MagicItems.json')),
		tools: readJson('Equipment/Tools.json'),
	};
	return cachedNpcData;
}

// ---------------------------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------------------------

class NpcBuilder extends CompanionBuilder {
	constructor(options, data) {
		// Every Ability Score Improvement becomes a feat (an ASI only if no feat qualifies).
		super({ ...options, featChance: 1 }, data);
		this.useGenericBackground = false;
		this.tools = [];
		this.magicItems = [];
		this.notes = [];
	}

	build() {
		this.chooseIdentity();
		this.chooseWeapons();
		this.collectFeatures();
		this.resolveChoices();
		this.rollAbilityScores();
		this.applyProficiencies();
		this.pickWeapons();
		this.chooseArmor();
		this.chooseMagicItems();
		this.listEquipment();
		this.chooseSpells();
		this.resolveExtraChoices();
		this.addOptionSpells();
		this.renderFeatures();
		this.renderItems();
		this.renderAttacks();
		this.renderSpellcasting();
		return this.assemble();
	}

	// --- identity ----------------------------------------------------------------------------

	chooseIdentity() {
		const { d, o, rng } = this;
		this.race = o.race ? findEntry(d.races, o.race, 'race') : rng.pick(d.races);
		this.variant = this.race.variants
			? (o.raceVariant ? findEntry(this.race.variants, o.raceVariant, 'race variant') : rng.pick(this.race.variants))
			: undefined;
		this.cls = o.type ? findEntry(d.npcTypes, o.type, 'NPC type') : rng.pick(d.npcTypes);
		this.sub = undefined;
		const sc = this.cls.spellcasting;
		if (o.role && !sc) throw new Error(`${this.cls.name} NPCs have no roles`);
		this.role = sc ? (o.role ? findEntry(sc.roles, o.role, 'role') : rng.pick(sc.roles)) : undefined;
		this.hint = { builds: [], signatureSpells: this.role ? this.role.signatureSpells || [] : [], focus: this.role && this.role.focus };
		this.background = o.background ? findEntry(d.backgrounds, o.background, 'background') : undefined;
		this.alignment = o.alignment || rng.pick(d.alignments);
	}

	// --- proficiency gains (the Martial's Combat Training) -------------------------------------
	//
	// A feature with `proficiencyGain: { from }` grants one armor or weapon proficiency from `from` that the NPC
	// doesn't have when it reaches the feature's level, so one already granted by a feat (Moderately Armored, ...) is
	// never picked again. The order is shuffled once up front: taking the first one not yet owned is the same as a
	// fresh random pick at each level.

	proficiencyGainFeatures() {
		return this.cls.features.filter((f) => f.proficiencyGain && (f.level || 1) <= this.level).sort((a, b) => a.level - b.level);
	}

	setupProficiencyGains() {
		const from = [...new Set(this.cls.features.flatMap((f) => (f.proficiencyGain && f.proficiencyGain.from) || []))];
		this.profGainOrder = this.rng.sample(from, from.length);
		this.gainedProfs = [];
		// Weapons are picked before feats, so the weapon pool assumes no armor feats. Feats only ever make a gain come
		// sooner, so every proficiency expected here is really gained.
		const owned = this.ownedProfs();
		this.expectedProfs = this.profGainOrder.filter((p) => !owned.has(p)).slice(0, this.proficiencyGainFeatures().length);
	}

	// Armor (light, medium, heavy, shields) and weapon (simple, martial) proficiencies the NPC has so far.
	ownedProfs() {
		const profs = this.npcArmorProfs();
		const wp = this.cls.weaponProficiencies || {};
		for (const t of ['simple', 'martial']) if (wp[t]) profs.add(t);
		for (const g of this.gainedProfs || []) if (g.prof) profs.add(g.prof);
		return profs;
	}

	// Resolves every proficiency gain up to `maxLevel` that hasn't been resolved yet.
	applyProficiencyGains(maxLevel) {
		for (const f of this.proficiencyGainFeatures()) {
			if (f.level > maxLevel || this.gainedProfs.some((g) => g.level === f.level)) continue;
			const owned = this.ownedProfs();
			this.gainedProfs.push({ level: f.level, prof: this.profGainOrder.find((p) => !owned.has(p)) });
		}
	}

	// Weapons from the type's category plus any weapon category it gains, minus its excluded weapons.
	weaponPool() {
		const rules = this.cls.weapons || {};
		const gained = [...(this.expectedProfs || []), ...(this.gainedProfs || []).map((g) => g.prof)];
		const categories = new Set([...[].concat(rules.category || []), ...gained.filter((p) => p === 'simple' || p === 'martial').map(titleCase)]);
		const exclude = new Set(rules.exclude || []);
		return this.d.weapons.filter((w) => categories.has(w.category) && !exclude.has(w.key));
	}

	// One melee and one ranged weapon from the type's category. The melee weapon decides whether the NPC leads with
	// Strength or Dexterity (finesse -> Dex); spellcasters put their casting ability first.
	chooseWeapons() {
		const { rng, cls } = this;
		this.setupProficiencyGains();
		const pool = this.weaponPool();
		const melee = rng.pick(pool.filter((w) => w.list === 'melee'));
		const ranged = rng.pick(pool.filter((w) => w.list === 'ranged'));
		if (!melee || !ranged) throw new Error(`${cls.name}: no ${[].concat(cls.weapons.category).join('/')} weapons to pick from`);
		this.mainWeapon = { ...melee };
		this.rangedWeapon = { ...ranged };

		const weaponAb = melee.finesse ? 'Dex' : 'Str';
		const otherPhysical = weaponAb === 'Dex' ? 'Str' : 'Dex';
		let tail = [...(cls.abilityPriority || [])];
		if (cls.shuffleAbilityTail) tail = rng.sample(tail, tail.length);
		const head = this.role ? [this.role.ability, 'Con', weaponAb] : [weaponAb, 'Con', otherPhysical];
		const avg = (w) => (w.damage && w.damage.count ? avgDice(w.damage.count, w.damage.die) : 0);
		// Rolled for every NPC (so seeds stay stable); only matters when it can use a shield
		this.wantsShield = rng.float() < SHIELD_CHANCE;
		this.build = {
			name: `${melee.name} & ${ranged.name}`,
			abilityPriority: [...new Set([...head, ...tail, ...ABILITIES])],
			mainWeapons: [melee.key],
			rangedWeapons: [ranged.key],
			offHand: this.wantsShield && (cls.armorProficiencies || []).includes('shields') && !melee.twoHanded ? 'shield' : undefined,
			preferRanged: weaponAb === 'Dex' && avg(ranged) >= avg(melee),
			stealthy: !!cls.stealthy,
			leadAbility: weaponAb,
		};
	}

	// Feature text can use {level} and {additional} (this level's entry of the feature's `additional` array).
	collectFeatures() {
		super.collectFeatures();
		const L = this.level;
		this.classFeatures = this.classFeatures.map(({ f, origin }) => {
			const add = Array.isArray(f.additional) ? f.additional[L - 1] : f.additional;
			const description = String(f.description || '').replace(/\{level\}/g, L).replace(/\{additional\}/g, add || '');
			return { f: { ...f, description }, origin };
		});
	}

	// --- feats and fighting styles that depend on gear ---------------------------------------
	//
	// Gear is described by a state { main, ranged, dual }: the melee weapon, the ranged weapon and whether the NPC
	// fights with a weapon in each hand. Feats and styles that need certain gear are only offered when the gear fits,
	// and feats/styles that change the gear (Dual Wielder, Two-Weapon Fighting) only pick weapons that keep every
	// earlier feat and style working.

	gearState() {
		return { main: this.mainWeapon, ranged: this.rangedWeapon, dual: !!this.dualWield };
	}

	// Armor proficiencies from the type, race, proficiency gains and feats taken so far.
	npcArmorProfs() {
		const profs = new Set([...(this.cls.armorProficiencies || []), ...(this.race.armorProficiencies || [])]);
		for (const p of this.feats) {
			['light', 'medium', 'heavy', 'shields'].forEach((t, i) => { if ((p.feat.armorProficiencies || [])[i]) profs.add(t); });
		}
		for (const g of this.gainedProfs || []) if (['light', 'medium', 'heavy', 'shields'].includes(g.prof)) profs.add(g.prof);
		return profs;
	}

	usesShield(s = this.gearState()) {
		return this.wantsShield && this.npcArmorProfs().has('shields') && !s.main.twoHanded && !s.dual;
	}

	// Spellcasting from the NPC's class or from a feat taken earlier that really grants spells (racial spells don't
	// count; Artificer Initiate doesn't either, as there is no artificer spell list in the data).
	hasSpellcasting() {
		if (this.cls.spellcasting) return true;
		// Cached per number of feats taken: this runs for every candidate feat
		if (!this.spellcastingCache || this.spellcastingCache.feats !== this.feats.length) {
			const value = this.feats.some((p) => [p.feat, p.option]
				.some((x) => x && (x.spellcastingBonus || []).some((b) => (b.spells && b.spells.length) || this.featSpellPool(b).length)));
			this.spellcastingCache = { feats: this.feats.length, value };
		}
		return this.spellcastingCache.value;
	}

	// Whether a feat's gear requirement holds for a gear state.
	featFits(feat, s = this.gearState()) {
		const damage = (type) => [s.main, s.ranged].some((w) => w && w.damage && w.damage.type === type);
		switch (feat.key) {
			case 'defensive duelist': return !!s.main.finesse;
			case 'crossbow expert': return [s.main, s.ranged].some((w) => w && /crossbow/.test(w.key));
			case 'shield master': return this.usesShield(s);
			case 'polearm master': return POLEARMS.has(s.main.key);
			case 'slasher': return damage('slashing');
			case 'crusher': return damage('bludgeoning');
			case 'piercer': return damage('piercing');
			default: return true;
		}
	}

	// Whether a fighting style does anything with a gear state.
	styleFits(key, s = this.gearState()) {
		switch (key) {
			case 'great weapon fighting': return !s.dual && (!!s.main.twoHanded || (!!s.main.versatileDamage && !this.usesShield(s)));
			case 'protection': return this.usesShield(s);
			case 'dueling': return !s.dual && !s.main.twoHanded;
			case 'two-weapon fighting': return s.dual;
			case 'archery': return !!this.build.preferRanged;
			case 'thrown weapon fighting': return !!(s.main.thrown || (s.ranged && s.ranged.thrown));
			default: return true;
		}
	}

	// Every feat and fighting style taken so far still works with this gear.
	gearKeepsChoices(s) {
		return this.feats.every((p) => this.featFits(p.feat, s)) && [...this.fightingStyleKeys()].every((k) => this.styleFits(k, s));
	}

	// One-handed (or light) melee weapons from the type's category to wield one in each hand. Weapons matching the
	// NPC's lead ability come first (finesse for Dex); the current weapon is kept when it qualifies.
	dualWieldOptions(lightOnly) {
		const pool = this.weaponPool().filter((w) => w.list === 'melee' && !w.twoHanded && (!lightOnly || w.light));
		const valid = (list) => list.filter((w) => this.gearKeepsChoices({ ...this.gearState(), main: w, dual: true }));
		const matching = valid(pool.filter((w) => !!w.finesse === (this.build.leadAbility === 'Dex')));
		const options = matching.length ? matching : valid(pool);
		const current = options.find((w) => w.key === this.mainWeapon.key);
		return current ? [current] : options;
	}

	wieldTwo(lightOnly) {
		const w = this.rng.pick(this.dualWieldOptions(lightOnly));
		if (!w) return;
		this.mainWeapon = { ...w };
		this.dualWield = true;
		this.build = { ...this.build, mainWeapons: [w.key], offHand: 'weapon', name: `${w.name} & ${this.rangedWeapon.name}` };
	}

	styleAvailable(key) {
		if (key === 'two-weapon fighting') return this.dualWield || this.dualWieldOptions(true).length > 0;
		return this.styleFits(key) && this.gearKeepsChoices(this.gearState());
	}

	// Martial Role and Fighting Initiate: a style the NPC doesn't have yet that works with its gear.
	// Two-Weapon Fighting swaps the melee weapon for two light weapons.
	pickFightingStyle(f) {
		const taken = this.fightingStyleKeys();
		const open = f.choices.filter((c) => !taken.has(c.key));
		const pick = this.rng.pick(open.filter((c) => this.styleAvailable(c.key))) || this.rng.pick(open);
		if (pick && pick.key === 'two-weapon fighting' && !this.dualWield) this.wieldTwo(true);
		return pick;
	}

	isFightingStyle(option) {
		return this.d.classes.find((c) => c.key === 'fighter').features
			.some((f) => f.choices && /fighting style/i.test(f.name) && f.choices.some((c) => c.key === option.key));
	}

	// Fighting styles from feats count too.
	fightingStyleKeys() {
		const keys = super.fightingStyleKeys();
		for (const p of this.feats) if (p.option && this.isFightingStyle(p.option)) keys.add(p.option.key);
		return keys;
	}

	featAllowed(feat) {
		if (!this.featFits(feat)) return false;
		if (feat.key === 'dual wielder') return this.dualWield || this.dualWieldOptions(false).length > 0;
		// Armor feats only when they grant a proficiency the NPC doesn't have
		if (Array.isArray(feat.armorProficiencies)) {
			const profs = this.npcArmorProfs();
			return ['light', 'medium', 'heavy', 'shields'].some((t, i) => feat.armorProficiencies[i] && !profs.has(t));
		}
		if (feat.choices && feat.choices.some((c) => this.isFightingStyle(c))) {
			const taken = this.fightingStyleKeys();
			return feat.choices.some((c) => !taken.has(c.key) && this.styleAvailable(c.key));
		}
		return true;
	}

	// Spellcasting prerequisites count spells from feats and race, armor prerequisites count armor feats.
	meetsFeatPrereqs(p, scores, level) {
		if (!p) return true;
		let q = p;
		if (q.spellcasting) {
			if (!this.hasSpellcasting()) return false;
			q = { ...q, spellcasting: false };
		}
		const armor = q.proficiency && /(light|medium|heavy) armor/i.exec(q.proficiency);
		if (armor) {
			if (!this.npcArmorProfs().has(armor[1].toLowerCase())) return false;
			q = { ...q, proficiency: undefined };
		} else if (q.proficiency && /martial weapon/i.test(q.proficiency)) {
			if (!this.ownedProfs().has('martial')) return false;
			q = { ...q, proficiency: undefined };
		}
		return super.meetsFeatPrereqs(q, scores, level);
	}

	// Fighting Initiate takes a style the NPC doesn't have yet; Dual Wielder puts a weapon in each hand.
	// Proficiency gains from earlier levels are resolved first, so the feat sees them (and vice versa).
	pickFeat(scores, level) {
		this.applyProficiencyGains(level - 1);
		let pick = super.pickFeat(scores, level);
		if (!pick) return pick;
		if (pick.feat.choices && pick.feat.choices.some((c) => this.isFightingStyle(c))) {
			const option = this.pickFightingStyle({ choices: pick.feat.choices });
			if (option) pick = { ...pick, option, increase: { ...(pick.feat.abilityScoreIncrease || {}), ...(option.abilityScoreIncrease || {}) } };
		}
		if (pick.feat.key === 'dual wielder' && !this.dualWield) this.wieldTwo(false);
		return pick;
	}

	// --- proficiencies -----------------------------------------------------------------------

	applyProficiencies() {
		this.applyProficiencyGains(this.level);
		super.applyProficiencies();
		for (const g of this.gainedProfs) if (g.prof === 'simple' || g.prof === 'martial') this.weaponProfs[g.prof] = true;
		for (const t of this.npcArmorProfs()) this.armorProfs.add(t);
		for (const { f } of this.classFeatures) {
			if (f.savingThrowChoice) {
				// Picked toward the NPC's best abilities, or evenly with `random: true`
				const pool = f.savingThrowChoice.from.filter((ab) => !this.saves.has(ab));
				const weight = f.savingThrowChoice.random ? () => 1 : (ab) => 1 + Math.max(0, this.mods[ab]) * 3;
				const picks = this.rng.sample(pool, f.savingThrowChoice.count || 1, weight);
				for (const ab of picks) this.saves.add(ab);
			}
			if (f.toolChoice) this.tools.push(...this.rng.sample(this.d.tools, f.toolChoice).map((t) => t.name));
		}
	}

	// --- gear --------------------------------------------------------------------------------

	// The weapons were picked in chooseWeapons() (and maybe swapped by feats); this decides the shield and off-hand.
	pickWeapons() {
		this.shield = this.usesShield();
		this.offHandWeapon = this.dualWield ? this.mainWeapon : undefined;
	}

	// The heaviest armor rating an armor feat (Lightly/Moderately/Heavily Armored) gave the NPC.
	armorFeatRating() {
		let best = -1;
		for (const p of this.feats) {
			ARMOR_RATINGS.forEach((t, i) => { if ((p.feat.armorProficiencies || [])[i]) best = Math.max(best, i); });
		}
		return ARMOR_RATINGS[best];
	}

	// A random armor of the heaviest rating the NPC is proficient with and can wear: unlocked at its level
	// (`armorUnlockLevel`), Strength requirement met and, for stealthy types, no stealth disadvantage. An armor feat
	// lifts the stealth rule, since the NPC took it to wear that armor. With no armor proficiency it goes unarmored.
	// Items that replace armor (Robe of the Archmagi, ...) take the best unarmored option instead.
	chooseArmor() {
		const dex = this.mods.Dex;
		const stealthy = this.build.stealthy;
		if (this.armorFeatRating()) this.build.stealthy = false;
		const options = this.armorOptions();
		this.build.stealthy = stealthy;
		for (const it of this.magicItems) {
			for (const ao of it.unarmoredOptions || []) options.push({ ac: ao.ac + dex, label: ao.label, unarmored: true });
		}
		if (this.forceUnarmored) return this.pickArmor(options.filter((o) => !o.armor));
		const worn = options.filter((o) => o.armor);
		const rating = [...ARMOR_RATINGS].reverse().find((r) => worn.some((o) => o.armor.type === r));
		if (!rating) return this.pickArmor(options);
		this.armorChoice = this.rng.pick(worn.filter((o) => o.armor.type === rating));
	}

	chooseMagicItems() {
		const n = Number(this.o.magicItems) || 0;
		if (n <= 0) return;
		const max = items.rarityRank(this.o.maxRarity || 'uncommon');
		if (max < 0) throw new Error(`Unknown rarity "${this.o.maxRarity}". Options: ${items.RARITIES.join(', ')}`);
		const pool = this.d.magicItems.filter((it) => items.rarityRank(it.rarity) <= max);
		for (let i = 0; i < n; i++) {
			const taken = new Set(this.magicItems.map((it) => it.baseKey));
			const pick = this.rng.pick(pool.filter((it) => !taken.has(it.baseKey) && items.fits(this, it)));
			if (!pick) break;
			items.equip(this, pick);
		}
		if (this.magicItems.length < n) {
			this.notes.push(`Only ${this.magicItems.length} of the ${n} requested magic items (${this.o.maxRarity || 'uncommon'} or lower) fit this NPC's gear.`);
		}
		items.applyScores(this);
		this.mods = Object.fromEntries(ABILITIES.map((ab) => [ab, mod(this.scores[ab])]));
		if (this.forceUnarmored) this.chooseArmor();
	}

	listEquipment() {
		super.listEquipment();
		// A magic weapon in one hand of a pair: list the pair as two separate weapons
		const main = this.mainWeapon;
		if (this.offHandWeapon && main.magicItem) {
			const i = this.equipment.indexOf(`2 ${(main.displayName || main.name).toLowerCase()}s`);
			if (i >= 0) this.equipment.splice(i, 1, (main.displayName || main.name).toLowerCase(), this.offHandWeapon.name.toLowerCase());
		}
		for (const it of this.magicItems) if (!it.attachedTo) this.equipment.push(it.name);
	}

	extraAC() {
		let n = this.classFeatures.reduce((s, { f }) => s + (f.acBonus || 0), 0);
		if (this.offHandWeapon && this.feats.some((p) => p.feat.key === 'dual wielder')) n += 1;
		const armored = !!this.armorChoice.armor;
		if (this.armorItem && armored) n += this.armorItem.acBonus;
		if (this.shieldItem && this.shield) n += this.shieldItem.acBonus;
		for (const it of this.magicItems) {
			if (it === this.armorItem || it === this.shieldItem || items.isConsumable(it)) continue;
			for (const e of it.extraAC || []) {
				if (/not wearing armor/i.test(e.text || '') && (armored || this.shield)) continue;
				n += e.mod || 0;
			}
		}
		return n;
	}

	// --- spells ------------------------------------------------------------------------------

	onClassList(spell, classKey = this.cls.key) {
		if (classKey === this.cls.key && this.role) return this.role.lists.some((l) => spell.classes.has(l));
		return super.onClassList(spell, classKey);
	}

	spellListName() {
		return this.role ? listJoin(this.role.lists) : super.spellListName();
	}

	casterSetup() {
		const sc = this.cls.spellcasting;
		if (!sc || !this.role) return undefined;
		const row = sc.slots[this.level - 1] || [];
		const slots = {};
		for (let lvl = 1; lvl <= 9; lvl++) slots[SPELL_LEVELS[lvl]] = row[lvl - 1] || 0;
		const maxLevel = Math.min(row.filter((x) => x > 0).length, sc.maxSpellLevel || 9);
		return { sc, slots, maxLevel, cantrips: sc.cantripsKnown[this.level - 1] || 0, ability: this.role.ability };
	}

	chooseSpells() {
		super.chooseSpells();
		this.chooseFeatSpells();
	}
	// Spells from feats (Magic Initiate, Fey Touched, Spell Sniper, ...): { source, ability, spells: [{ name, level, frequency }] }
	chooseFeatSpells() {
		this.featSpells = [];
		const known = (name) => this.knowsSpell(name);
		for (const p of this.feats) {
			const parts = [p.feat, p.option].filter((x) => x && x.spellcastingBonus);
			if (!parts.length) continue;
			const entry = { source: p.option ? `${p.feat.name} (${p.option.name})` : p.feat.name, ability: this.featSpellAbility(p), spells: [] };
			this.featSpells.push(entry);
			for (const b of parts.flatMap((x) => x.spellcastingBonus)) {
				const times = Number(b.times) || 1;
				let picks;
				if (b.spells) {
					const names = b.times && b.spells.length > times ? this.rng.sample(b.spells, times) : b.spells;
					picks = names.map((n) => this.d.spells.get(n.toLowerCase()) || { name: titleCase(n), level: 0 });
				} else {
					picks = this.rng.sample(this.featSpellPool(b), times);
				}
				for (const s of picks) {
					if (known(s.name)) continue;
					const frequency = s.level === 0 || b.frequency === 'at will' ? 'at will' : b.frequency === '1/short rest' ? '1/short rest' : '1/day';
					entry.spells.push({ name: s.name, level: s.level, frequency });
				}
			}
		}
		this.featSpells = this.featSpells.filter((e) => e.spells.length);
	}

	// Spells a "pick a spell" feat entry can choose from: class list(s), level range, schools named like
	// "Ench/Div", attack cantrips for Spell Sniper.
	featSpellPool(b) {
		const classes = b.class === 'any' ? undefined : [].concat(b.class || []);
		const [lo, hi] = b.spellLevels || [0, 0];
		const allSchools = [...new Set([...this.d.spells.values()].map((s) => s.school).filter(Boolean))];
		const named = (/(\w+)\/(\w+)/.exec(b.name || '') || []).slice(1)
			.map((t) => allSchools.find((s) => s.toLowerCase().startsWith(t.toLowerCase()))).filter(Boolean);
		const attackCantrips = new Set(this.d.weapons.filter((w) => w.category === 'Cantrip' && !w.savingThrow).map((w) => w.key));
		return [...this.d.spells.values()].filter((s) => s.level >= lo && s.level <= hi
			&& (!classes || classes.some((c) => s.classes.has(c)))
			&& (!named.length || named.includes(s.school))
			&& (!/attack/i.test(b.name || '') || attackCantrips.has(s.name.toLowerCase()))
			&& !this.knowsSpell(s.name));
	}

	// The option's chosen ability (Fey Touched: Int/Wis/Cha), "<Ability> is my spellcasting ability", the feat's
	// listed ability, or the NPC's best mental ability.
	featSpellAbility(p) {
		const mental = ['Int', 'Wis', 'Cha'];
		const fromOption = Object.keys((p.option && p.option.abilityScoreIncrease) || {}).find((ab) => mental.includes(ab));
		if (fromOption && p.feat.spellcastingAbility) return fromOption;
		const full = { Strength: 'Str', Dexterity: 'Dex', Constitution: 'Con', Intelligence: 'Int', Wisdom: 'Wis', Charisma: 'Cha' };
		for (const x of [p.option, p.feat]) {
			const m = x && /(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) is my spellcasting ability/.exec(x.description || '');
			if (m) return full[m[1]];
		}
		if (p.feat.spellcastingAbility) return p.feat.spellcastingAbility;
		return [...mental].sort((a, b) => this.mods[b] - this.mods[a])[0];
	}

	knowsSpell(name) {
		const n = name.toLowerCase();
		return super.knowsSpell(name) || (this.featSpells || []).some((e) => e.spells.some((s) => s.name.toLowerCase() === n));
	}

	renderSpellcasting() {
		super.renderSpellcasting();
		const full = { Str: 'Strength', Dex: 'Dexterity', Con: 'Constitution', Int: 'Intelligence', Wis: 'Wisdom', Cha: 'Charisma' };
		for (const e of this.featSpells) {
			const dc = this.keepTokens ? `[${e.ability.toUpperCase()} SAVE]` : 8 + this.prof + this.mods[e.ability];
			const atk = this.keepTokens ? `[${e.ability.toUpperCase()} ATK]` : signed(this.prof + this.mods[e.ability]);
			const group = (freq) => e.spells.filter((s) => s.frequency === freq).map((s) => s.name.toLowerCase()).sort();
			const lines = [];
			for (const [freq, label] of [['at will', 'At will'], ['1/short rest', '1/short rest each'], ['1/day', '1/day each']]) {
				const names = group(freq);
				if (names.length) lines.push(`> ${label}: _${names.join(', ')}_`);
			}
			this.push('Abilities', `Spellcasting (${e.source})`, `The [MON]'s spellcasting ability for these spells is ${full[e.ability]} `
				+ `(spell save DC ${dc}, ${atk} to hit with spell attacks). It can cast the following spells without expending a spell slot:\n\n${lines.join('\n')}`);
		}
	}

	// Attack cantrips learned from feats get an action, after the weapon and class cantrip attacks.
	renderAttacks() {
		const before = this.entries.Actions.length;
		super.renderAttacks();
		const at = this.entries.Actions.length - before;
		const cantripWeapons = this.d.weapons.filter((w) => w.category === 'Cantrip');
		const extra = [];
		for (const e of this.featSpells) {
			for (const s of e.spells.filter((x) => x.level === 0)) {
				const w = cantripWeapons.find((cw) => cw.key === s.name.toLowerCase());
				if (w && !this.entries.Actions.some((a) => a[w.name])) extra.push({ [w.name]: this.cantripAction(w, e.ability) });
			}
		}
		this.entries.Actions.splice(at, 0, ...extra);
	}

	cantripDamageBonus(ability) {
		return this.classFeatures.some(({ f }) => f.potentCantrips) ? this.mods[ability] : 0;
	}

	itemBonus(kind) {
		return this.magicItems.reduce((s, it) => s + ((it.bonuses && it.bonuses[kind]) || 0), 0);
	}

	spellDCBonus() {
		return this.itemBonus('spellDC');
	}

	spellAttackBonus() {
		return this.itemBonus('spellAttack');
	}

	// Empowered Spells: the school the NPC knows the most levelled spells from.
	resolveExtraChoices() {
		super.resolveExtraChoices();
		for (const entry of this.classFeatures) {
			if (!entry.f.schoolChoice) continue;
			const counts = new Map();
			for (const s of this.spellList.filter((x) => x.level > 0)) {
				const school = (this.d.spells.get(s.name.toLowerCase()) || {}).school;
				if (school) counts.set(school, (counts.get(school) || 0) + 1);
			}
			const best = Math.max(0, ...counts.values());
			const school = this.rng.pick([...counts.keys()].filter((k) => counts.get(k) === best))
				|| this.rng.pick([...new Set([...this.d.spells.values()].map((s) => s.school).filter(Boolean))]);
			entry.f = { ...entry.f, name: `${entry.f.name} (${school})`, description: entry.f.description.replace(/\{school\}/g, school) };
		}
	}

	// --- magic item text ---------------------------------------------------------------------

	// DC for spells cast from an item: the item's own DC, else the NPC's spell DC, else its best mental ability.
	itemSpellDC(it) {
		if (it.fixedDC) return it.fixedDC;
		const ab = this.caster ? this.caster.ability : ['Int', 'Wis', 'Cha'].sort((a, b) => this.mods[b] - this.mods[a])[0];
		return 8 + this.prof + this.mods[ab] + (this.caster ? this.spellDCBonus() : 0);
	}

	renderItems() {
		const categoryOf = (it) => {
			const type = it.actions && it.actions[0] && it.actions[0].type;
			if (type === 'bonus action') return 'BonusActions';
			if (type === 'reaction') return 'Reactions';
			if (type === 'action' || items.isConsumable(it) || it.spellcastingBonus) return 'Actions';
			return 'Abilities';
		};
		this.itemSpells = [];
		for (const it of this.magicItems) {
			if (it.scrollSpell) {
				const s = it.scrollSpell;
				const dc = items.SCROLL_DC[s.level];
				this.push('Actions', it.name, `The [MON] reads the scroll to cast _${s.name.toLowerCase()}_ (spell save DC ${dc}, ${signed(dc - 8)} to hit with spell attacks). The scroll then crumbles to dust.`);
				this.itemSpells.push({ [it.name]: [s.name] });
				continue;
			}
			if (items.isPlainBonus(it)) continue;
			let desc = prose(it.description);
			const lines = items.spellLines(it);
			if (lines.length) {
				const dc = this.itemSpellDC(it);
				desc += `\n\nThe [MON] can cast the following spells from the item (spell save DC ${dc}, ${signed(dc - 8)} to hit with spell attacks):\n\n${lines.join('\n')}`;
				this.itemSpells.push({ [it.name]: (it.spellcastingBonus || []).flatMap((b) => (b.spells || []).map(titleCase)) });
			}
			if (!desc) continue;
			const usage = items.usageText(it);
			this.push(categoryOf(it), usage ? `${it.name} (${usage})` : it.name, desc);
		}
	}

	// --- statblock numbers -------------------------------------------------------------------

	senses() {
		const ranges = new Map();
		for (const s of [...(this.race.senses || []), ...this.activeFeatures.flatMap((f) => f.senses || [])]) {
			const k = s.name.toLowerCase();
			ranges.set(k, Math.max(ranges.get(k) || 0, Number(s.range) || 0));
		}
		const hadBefore = new Set(ranges.keys());
		for (const it of this.magicItems) {
			for (const s of it.senses || []) {
				const k = s.name.toLowerCase();
				if (/^adv/.test(k)) continue; // advantage notes are in the item's description
				const r = String(s.range);
				let m;
				if ((m = /^fixed (\d+)/.exec(r))) ranges.set(k, Math.max(ranges.get(k) || 0, Number(m[1])));
				else if ((m = /^\+(\d+)/.exec(r))) { if (hadBefore.has(k)) ranges.set(k, ranges.get(k) + Number(m[1])); }
				else if (Number(r) > 1) ranges.set(k, Math.max(ranges.get(k) || 0, Number(r)));
			}
		}
		const out = [...ranges.entries()].map(([k, r]) => `${k} ${r} ft.`);
		const perception = this.skills.get('Perception');
		out.push(`passive Perception ${10 + this.mods.Wis + (perception ? this.prof * (perception.expertise ? 2 : 1) : 0)}`);
		return out;
	}

	speeds() {
		const speed = super.speeds();
		for (const it of this.magicItems) {
			if (items.isConsumable(it)) continue;
			for (const [mode, v] of Object.entries(it.speed || {})) {
				const m = /fixed (\d+)/.exec(v.spd);
				const value = m ? Number(m[1]) : v.spd === 'walk' ? speed.walk : 0;
				if (mode === 'walk') speed.walk = Math.max(speed.walk, value);
				else if (value) speed.other[mode] = Math.max(speed.other[mode] || 0, value);
			}
		}
		return speed;
	}

	resistances() {
		const r = super.resistances();
		const res = new Set(r.res);
		const immune = new Set(r.immune);
		const condImmune = new Set(r.condImmune);
		for (const it of this.magicItems) {
			if (items.isConsumable(it)) continue;
			for (const dr of it.damageResistances || []) {
				const k = dr.toLowerCase();
				res.add(k === 'all (nonmagical)' ? 'damage from nonmagical attacks' : k === 'ranged weapons' ? 'damage from ranged weapon attacks' : k);
			}
			for (const im of (it.saveNotes && it.saveNotes.immune) || []) {
				if (/^poison$/i.test(im)) { immune.add('poison'); condImmune.add('poisoned'); }
			}
		}
		return { res: [...res], immune: [...immune], condImmune: [...condImmune] };
	}

	// --- output ------------------------------------------------------------------------------

	shortName() {
		return (this.role ? this.role.name : this.cls.name).toLowerCase();
	}

	decorate(npc) {
		const style = this.chosen.find((c) => /fighting style/i.test(c.option.name));
		npc.Name = `${titleCase(this.race.name)} ${this.role ? this.role.name : this.cls.name}`;
		npc.Subclass = this.role ? this.role.name : style ? style.option.name : null;
		const saveBonus = this.itemBonus('saves');
		if (saveBonus) {
			npc.SavingThrows = ABILITIES.map((a) => ({ [a]: this.mods[a] + (this.saves.has(a) ? this.prof : 0) + saveBonus }));
		}
		if (this.tools.length) npc.Tools = this.tools;
		npc.Feats = this.feats.map((p) => (p.option ? `${p.feat.name} (${p.option.name})` : p.feat.name));
		npc.MagicItems = this.magicItems.map((it) => ({ [it.name]: `${it.rarity}${it.attunement ? ', requires attunement' : ''}` }));
		if (this.itemSpells && this.itemSpells.length) npc.Spellcasting.ItemSpells = this.itemSpells;
		if (this.featSpells.length) npc.Spellcasting.FeatSpells = this.featSpells.map((e) => ({ [e.source]: e.spells.map((s) => s.name) }));
		if (this.gainedProfs.length) {
			const label = { light: 'Light armor', medium: 'Medium armor', heavy: 'Heavy armor', shields: 'Shields', simple: 'Simple weapons', martial: 'Martial weapons' };
			npc.ProficiencyGains = this.gainedProfs.map((g) => ({ [g.level]: g.prof ? label[g.prof] || titleCase(g.prof) : 'none left to gain' }));
		}
		if (this.notes.length) npc.Notes = this.notes;
	}
}

function generateNpc(options = {}, data = loadNpcData()) {
	return new NpcBuilder(options, data).build();
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const HELP = `Random NPC generator

Usage: node Generators/NpcGenerator/generateNpc.js [level] [options]

  -l, --level <1-20>        NPC level (required)
  -t, --type <name>         NPC type: warrior, martial, expert, spellcaster, ... (default: random)
      --role <name>         Spellcaster role: mage, healer or prodigy (default: random)
  -r, --race <name>         Race (default: random)
      --variant <name>      Race variant, e.g. dragonborn colour
      --background <name>   Background from Data/Backgrounds/Backgrounds.json (default: none)
      --alignment <text>    Alignment (default: random)
      --stats <method>      standard (default) or roll (4d6 drop lowest)
  -m, --magic-items <n>     Number of magic items to carry (default: 0)
      --max-rarity <r>      Highest item rarity: common, uncommon (default), rare, "very rare", legendary
  -s, --seed <text>         Seed for reproducible results
  -n, --count <n>           Generate several NPCs
      --keep-tokens         Keep [MON], [STR ATK], [DEX 1D8] tokens instead of resolving them
  -f, --format <fmt>        json (default), text, or both
  -o, --out <file>          Write JSON to a file instead of stdout
      --list                List NPC types, roles and races
  -h, --help                Show this help`;

function parseArgs(argv) {
	const opts = { format: 'json', count: 1 };
	const alias = { l: 'level', t: 'type', r: 'race', s: 'seed', n: 'count', f: 'format', o: 'out', h: 'help', m: 'magic-items' };
	const flags = new Set(['keep-tokens', 'list', 'help']);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (/^\d+$/.test(a) && opts.level === undefined) { opts.level = Number(a); continue; }
		const m = /^--?([\w-]+)(?:=(.*))?$/.exec(a);
		if (!m) throw new Error(`Unexpected argument "${a}"`);
		const name = alias[m[1]] || m[1];
		if (flags.has(name)) { opts[name] = true; continue; }
		const value = m[2] !== undefined ? m[2] : argv[++i];
		if (value === undefined) throw new Error(`Missing value for --${name}`);
		opts[name] = value;
	}
	return {
		level: opts.level !== undefined ? Number(opts.level) : undefined,
		type: opts.type, role: opts.role, race: opts.race, raceVariant: opts.variant, background: opts.background,
		alignment: opts.alignment, stats: opts.stats, seed: opts.seed, keepTokens: !!opts['keep-tokens'],
		magicItems: opts['magic-items'] !== undefined ? Number(opts['magic-items']) : 0, maxRarity: opts['max-rarity'],
		count: Number(opts.count) || 1, format: opts.format, out: opts.out, list: opts.list, help: opts.help,
	};
}

function listOptions(d) {
	const lines = [];
	for (const t of d.npcTypes) {
		const roles = t.spellcasting ? ` roles [${t.spellcasting.roles.map((r) => `${r.name}: ${listJoin(r.lists)}`).join('; ')}]` : '';
		lines.push(`${t.name}: d${t.hitDie}, ${[].concat(t.weapons.category).join('/').toLowerCase()} weapons, armor [${t.armorProficiencies.join(', ')}]${roles}`);
	}
	lines.push('Races: ' + d.races.map((r) => r.name + (r.variants ? ` (${r.variants.map((v) => v.key.split('-')[1]).join('/')})` : '')).join(', '));
	lines.push('Rarities: ' + items.RARITIES.join(', '));
	return lines.join('\n');
}

function main() {
	let args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (e) {
		console.error(e.message + '\n\n' + HELP);
		process.exit(1);
	}
	if (args.help) return console.log(HELP);
	const data = loadNpcData();
	if (args.list) return console.log(listOptions(data));
	if (!args.level) {
		console.error('Please give a level, e.g. --level 5\n\n' + HELP);
		process.exit(1);
	}
	const results = [];
	try {
		for (let i = 0; i < args.count; i++) {
			const seed = args.seed != null ? (args.count > 1 ? `${args.seed}-${i + 1}` : args.seed) : undefined;
			results.push(generateNpc({ ...args, seed }, data));
		}
	} catch (e) {
		console.error(e.message);
		process.exit(1);
	}
	const json = JSON.stringify(results.length === 1 ? results[0] : results, null, 4);
	if (args.out) {
		fs.writeFileSync(args.out, json + '\n');
		console.error(`Wrote ${results.length} NPC(s) to ${args.out}`);
	}
	if (args.format === 'text' || args.format === 'both') console.log(results.map(renderText).join('\n\n' + '='.repeat(60) + '\n\n'));
	if (!args.out && (args.format === 'json' || args.format === 'both')) console.log(json);
}

if (require.main === module) main();
module.exports = { generateNpc, loadNpcData, loadNpcTypes, NpcBuilder, parseArgs, renderText };
