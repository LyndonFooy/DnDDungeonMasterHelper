#!/usr/bin/env node
/*
 * Random companion (NPC party member) generator.
 *
 * Builds a class-levelled character from the JSON extracted from MPMB's Character Record Sheet
 * (Data/Classes/, Data/Races/, Data/Equipment/, Data/Spells/, ...) and outputs it in the BlankTemplate.json shape.
 *
 *   node Generators/CharacterGenerator/generateCharacter.js --level 5
 *   node Generators/CharacterGenerator/generateCharacter.js -l 9 -c wizard -r "high elf" --seed goblin-cave --format text
 *   node Generators/CharacterGenerator/generateCharacter.js --help
 */
'use strict';
const fs = require('fs');
const path = require('path');

// Game data lives in <project>/Data; generator-specific tuning sits next to this file.
const ROOT = path.resolve(__dirname, '..', '..', 'Data');
const ABILITIES = ['Str', 'Dex', 'Con', 'Int', 'Wis', 'Cha'];
const ABILITY_FULL = { Str: 'Strength', Dex: 'Dexterity', Con: 'Constitution', Int: 'Intelligence', Wis: 'Wisdom', Cha: 'Charisma' };
const SPELL_LEVELS = ['Cantrip', '1st-level', '2nd-level', '3rd-level', '4th-level', '5th-level', '6th-level', '7th-level', '8th-level', '9th-level'];
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];
const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
const DRAGON_LINE_BREATH = ['black', 'blue', 'brass', 'bronze', 'copper'];

// ---------------------------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------------------------

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

function spellLevelNumber(level) {
	const i = SPELL_LEVELS.indexOf(level);
	return i >= 0 ? i : /cantrip/i.test(level) ? 0 : parseInt(level, 10) || 0;
}

// SpellsAll.json (the project's own list) wins over the MPMB SRD list when both have a spell.
function mergeSpells(...lists) {
	const byName = new Map();
	for (const list of lists) {
		for (const s of list) {
			const key = s.name.toLowerCase();
			if (byName.has(key)) continue;
			byName.set(key, {
				name: s.name,
				level: spellLevelNumber(s.level),
				classes: new Set(String(s.class || '').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean)),
				school: s.school,
				concentration: s.concentration === 'yes',
			});
		}
	}
	return byName;
}

let cachedData;
function loadData() {
	if (cachedData) return cachedData;
	cachedData = {
		classes: readJson('Classes/Classes.json'),
		subclasses: readJson('Classes/Subclasses.json'),
		races: readJson('Races/Races.json'),
		backgrounds: readJson('Backgrounds/Backgrounds.json'),
		feats: readJson('Feats/Feats.json'),
		armor: readJson('Equipment/Armor.json'),
		weapons: readJson('Equipment/Weapons.json'),
		slotTables: readJson('Spells/SpellSlotTables.json'),
		levels: readJson('Rules/Levels.json'),
		skills: readJson('Rules/Skills.json'),
		alignments: readJson('Rules/Alignments.json'),
		creatures: readJson('Creatures/Creatures.json'),
		companionTypes: readJson('Companions/CompanionTypes.json'),
		hints: JSON.parse(fs.readFileSync(path.join(__dirname, 'BuildHints.json'), 'utf8')),
		spells: mergeSpells(readJson('Spells/SpellsAll.json'), readJson('Spells/SpellsSRD.json')),
	};
	return cachedData;
}

// ---------------------------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------------------------

class Rng {
	constructor(seed) {
		// xmur3 string hash -> mulberry32 generator
		let h = 1779033703 ^ seed.length;
		for (let i = 0; i < seed.length; i++) {
			h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
			h = (h << 13) | (h >>> 19);
		}
		h = Math.imul(h ^ (h >>> 16), 2246822507);
		h = Math.imul(h ^ (h >>> 13), 3266489909);
		this.state = (h ^ (h >>> 16)) >>> 0;
	}
	float() {
		let t = (this.state = (this.state + 0x6d2b79f5) | 0);
		t = Math.imul(t ^ (t >>> 15), 1 | t);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}
	int(min, max) { return min + Math.floor(this.float() * (max - min + 1)); }
	pick(arr) { return arr.length ? arr[Math.floor(this.float() * arr.length)] : undefined; }
	weighted(items, weightOf = (i) => i.weight || 1) {
		const total = items.reduce((s, i) => s + weightOf(i), 0);
		let r = this.float() * total;
		for (const i of items) if ((r -= weightOf(i)) < 0) return i;
		return items[items.length - 1];
	}
	// Weighted sampling without replacement.
	sample(items, n, weightOf = () => 1) {
		const pool = [...items];
		const out = [];
		while (out.length < n && pool.length) {
			const choice = this.weighted(pool, weightOf);
			out.push(choice);
			pool.splice(pool.indexOf(choice), 1);
		}
		return out;
	}
	roll(count, die) {
		let t = 0;
		for (let i = 0; i < count; i++) t += this.int(1, die);
		return t;
	}
}

// ---------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------

const mod = (score) => Math.floor((score - 10) / 2);
const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const titleCase = (s) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
const avgDice = (count, die) => Math.floor((count * (die + 1)) / 2);
const listJoin = (arr) => (arr.length <= 1 ? arr.join('') : arr.length === 2 ? arr.join(' and ') : `${arr.slice(0, -1).join(', ')}, and ${arr[arr.length - 1]}`);

function findEntry(list, query, label) {
	if (!query) return undefined;
	const q = String(query).toLowerCase().trim();
	const hit = list.find((e) => e.key === q || (e.name || '').toLowerCase() === q)
		|| list.find((e) => (e.fullName || '').toLowerCase() === q)
		|| list.find((e) => e.key.includes(q) || (e.name || '').toLowerCase().includes(q));
	if (!hit) throw new Error(`Unknown ${label} "${query}". Options: ${list.map((e) => e.name).join(', ')}`);
	return hit;
}

const MODAL_VERBS = new Set(['can', 'could', 'may', 'might', 'must', 'will', 'would', 'should', 'cannot', "can't", "won't", "couldn't", "wouldn't", 'was']);
// Words after "I" that must not be conjugated ("both the creature and I are restrained").
const NOT_VERBS = new Set(['and', 'or', 'to', 'in', 'on', 'with', 'a', 'an', 'the', 'as', 'at', 'of', 'are', 'were']);

function conjugate(verb) {
	const v = verb.toLowerCase();
	if (MODAL_VERBS.has(v) || NOT_VERBS.has(v)) return verb;
	if (v === 'am') return 'is';
	if (v === 'have') return 'has';
	if (v === 'do') return 'does';
	if (v === "don't") return "doesn't";
	if (/(s|sh|ch|x|z|o)$/.test(v)) return verb + 'es';
	if (/[^aeiou]y$/.test(v)) return verb.slice(0, -1) + 'ies';
	return verb + 's';
}

// MPMB descriptions are first person ("I can ...", "my ..."); statblocks are third person.
function thirdPerson(text) {
	const who = 'the [MON]';
	let s = text.replace(/\bI'm\b/g, 'I am').replace(/\bI've\b/g, 'I have').replace(/\bI'll\b/g, 'I will').replace(/\bI'd\b/g, 'I would');
	s = s.replace(/\bI\s+(?:(also|already|then|only|always|instead|automatically|immediately|still|now|either|once|can|could|may|might|must|will|would|should|cannot|can't|won't)\s+)?([A-Za-z']+)/g,
		(m, adv, verb) => {
			if (!adv) return `${who} ${conjugate(verb)}`;
			return MODAL_VERBS.has(adv) ? `${who} ${adv} ${verb}` : `${who} ${adv} ${conjugate(verb)}`;
		});
	s = s.replace(/\bI\b/g, who).replace(/\bmyself\b/g, 'itself').replace(/\bmy\b/g, 'its').replace(/\bMy\b/g, 'Its').replace(/\bmine\b/g, 'its').replace(/\bme\b/g, 'it');
	return s.replace(/(^|[.!?]\s+)the \[MON\]/g, '$1The [MON]');
}

const ABBREVIATIONS = [
	[/\bdisadv\.?(?=\s|$|[,;)])/g, 'disadvantage'], [/\badv\.?(?=\s|$|[,;)])/g, 'advantage'],
	[/\bDisadv\.?(?=\s|$|[,;)])/g, 'Disadvantage'], [/\bAdv\.?(?=\s|$|[,;)])/g, 'Advantage'], [/\bdmg\b/g, 'damage'],
	[/\bcrea\b/g, 'creature'], [/\bProf Bonus\b/gi, 'proficiency bonus'], [/\bprof\.(?=\s)/g, 'proficiency'],
	[/\bHD\b/g, 'Hit Dice'], [/\b1 min\b/g, '1 minute'], [/(\d) min\b/g, '$1 minutes'], [/\b1 h\b/g, '1 hour'], [/(\d) h\b/g, '$1 hours'],
	[/\bKOd\b/g, 'knocked out'],
];

// Turns MPMB's terse multi-line descriptions into statblock prose.
function prose(description) {
	if (!description) return '';
	const lines = String(description).split('\n')
		.map((l) => l.replace(/\(see third page\)/i, '').replace(/^[•\-]\s*/, '').trim())
		.filter((l) => l && !/choose feature|racial options|on the third page|"Class" field/i.test(l));
	let s = lines.map((l) => (/[.!?:;,]$/.test(l) ? l : l + '.')).join(' ').replace(/\s{2,}/g, ' ');
	for (const [re, rep] of ABBREVIATIONS) s = s.replace(re, rep);
	s = thirdPerson(s).trim();
	if (s && !/[.!?:]$/.test(s)) s += '.';
	return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------------------------

class CompanionBuilder {
	constructor(options, data) {
		this.d = data;
		this.o = options;
		this.level = Number(options.level);
		if (!Number.isInteger(this.level) || this.level < 1 || this.level > 20) throw new Error('Level must be an integer from 1 to 20');
		this.seed = String(options.seed != null ? options.seed : Math.random().toString(36).slice(2, 10));
		this.rng = new Rng(this.seed);
		this.prof = data.levels[this.level - 1].proficiencyBonus;
		this.keepTokens = !!options.keepTokens;
		this.chosen = []; // { parent, option, kind }
		this.feats = [];
		this.skills = new Map(); // skill name -> { expertise }
		this.languages = new Set();
		this.spellList = []; // { name, level, group }
		this.innate = []; // { name, frequency }
		this.entries = { Abilities: [], Actions: [], BonusActions: [], Reactions: [] };
		this.equipment = [];
	}

	build() {
		this.chooseIdentity();
		this.collectFeatures();
		this.resolveChoices();
		this.rollAbilityScores();
		this.applyProficiencies();
		this.chooseGear();
		this.chooseSpells();
		this.resolveExtraChoices();
		this.addOptionSpells();
		this.renderFeatures();
		this.renderAttacks();
		this.renderSpellcasting();
		return this.assemble();
	}

	// --- identity --------------------------------------------------------------------------

	chooseIdentity() {
		const { d, o, rng } = this;
		this.race = o.race ? findEntry(d.races, o.race, 'race') : rng.pick(d.races);
		this.variant = this.race.variants
			? (o.raceVariant ? findEntry(this.race.variants, o.raceVariant, 'race variant') : rng.pick(this.race.variants))
			: undefined;
		this.cls = o.class ? findEntry(d.classes, o.class, 'class') : rng.pick(d.classes);
		const subs = d.subclasses.filter((s) => s.class === this.cls.key);
		if (o.subclass) {
			this.sub = findEntry(subs, o.subclass, 'subclass');
		} else if (subs.length && this.level >= (this.cls.subclassLevel || 3)) {
			this.sub = rng.pick(subs);
		}
		if (this.sub && this.level < (this.cls.subclassLevel || 1)) this.sub = undefined;
		this.hint = d.hints.classes[this.cls.key] || { builds: [{ name: 'Default', abilityPriority: [...ABILITIES], mainWeapons: ['dagger'] }] };
		this.build = o.build ? findEntry(this.hint.builds.map((b) => ({ ...b, key: b.name.toLowerCase() })), o.build, 'build') : rng.weighted(this.hint.builds);
		this.background = o.background ? findEntry(d.backgrounds, o.background, 'background') : undefined;
		this.alignment = o.alignment || rng.pick(d.alignments);
	}

	collectFeatures() {
		const L = this.level;
		const byLevel = (a, b) => (a.f.level || 0) - (b.f.level || 0);
		this.classFeatures = [
			...this.cls.features.filter((f) => (f.level || 1) <= L).map((f) => ({ f, origin: 'class' })),
			...(this.sub ? this.sub.features.filter((f) => (f.level || 1) <= L).map((f) => ({ f, origin: 'subclass' })) : []),
		].sort(byLevel);
		this.raceFeatures = (this.race.features || []).filter((f) => (f.level || 1) <= L);
	}

	get activeFeatures() {
		return [...this.classFeatures.map((x) => x.f), ...this.chosen.map((c) => c.option)];
	}

	chosenNames() {
		return new Set([...this.chosen.map((c) => c.option.name.toLowerCase()), ...this.chosen.map((c) => c.option.key)]);
	}

	// --- choices -----------------------------------------------------------------------------

	resolveChoices() {
		const forced = {};
		for (const { f } of this.classFeatures) {
			if (f.choices) {
				let option;
				if (forced[f.key]) option = f.choices.find((c) => c.key === forced[f.key]);
				if (!option && f.choices.some((c) => /fighting style/i.test(c.name))) option = this.pickFightingStyle(f);
				if (!option && this.build.pactBoon) option = f.choices.find((c) => c.key === this.build.pactBoon);
				if (!option) option = this.rng.pick(f.choices.filter((c) => this.meetsPrereqs(c)));
				if (option) {
					this.chosen.push({ parent: f, option, kind: 'choice' });
					if (option.dependentChoices && f.choiceDependencies) {
						for (const dep of f.choiceDependencies) forced[dep.feature] = option.dependentChoices;
					}
				}
			}
			for (const auto of f.autoChoices || []) {
				if (auto.name && (auto.level || f.level || 1) <= this.level) this.chosen.push({ parent: f, option: auto, kind: 'auto' });
			}
		}
	}

	// Keys of the chosen options, used to apply fighting styles (archery, defense, dueling, ...) to the numbers.
	fightingStyleKeys() {
		return new Set(this.chosen.map((c) => c.option.key));
	}

	pickFightingStyle(f) {
		const b = this.build;
		const main = this.d.weapons.find((w) => w.key === (b.mainWeapons || [])[0]) || {};
		const taken = new Set(this.chosen.map((c) => c.option.key));
		const fits = (key) => ({
			'great weapon fighting': (main.twoHanded || main.versatileDamage) && !b.offHand,
			protection: b.offHand === 'shield',
			'two-weapon fighting': b.offHand === 'weapon',
			dueling: b.offHand !== 'weapon' && !main.twoHanded,
			archery: !!b.preferRanged,
		}[key] !== false);
		const open = f.choices.filter((c) => !taken.has(c.key));
		for (const pref of b.fightingStyles || []) {
			const hit = open.find((c) => c.key === pref);
			if (hit) return hit;
		}
		return this.rng.pick(open.filter((c) => fits(c.key))) || this.rng.pick(open);
	}

	meetsPrereqs(option) {
		const p = option.prerequisites;
		if (!p) return true;
		if (p.level && this.level < p.level) return false;
		const known = new Set([...this.spellList, ...this.innate].map((s) => s.name.toLowerCase()));
		if (p.spells && !p.spells.every((s) => known.has(s.toLowerCase()))) return false;
		const names = this.chosenNames();
		if (p.features && !p.features.every((fe) => names.has(fe.toLowerCase()))) return false;
		return true;
	}

	resolveExtraChoices() {
		const L = this.level;
		for (const { f } of this.classFeatures) {
			const ec = f.extraChoices;
			if (!ec) continue;
			const n = Array.isArray(ec.timesPerLevel) ? ec.timesPerLevel[L - 1] || 0 : Number(ec.times) || 1;
			if (!n) continue;
			const skillNames = new Set(this.d.skills.map((s) => s.name.toLowerCase()));
			if (ec.options.every((o) => skillNames.has(o.key) || /tools/.test(o.key))) {
				this.chooseExpertise(n);
				continue;
			}
			const preferred = this.hint.preferredOptions || [];
			for (let i = 0; i < n; i++) {
				const taken = new Set(this.chosen.map((c) => c.option.key));
				const eligible = ec.options.filter((o) => !taken.has(o.key) && this.meetsPrereqs(o));
				const option = eligible.find((o) => preferred.includes(o.key)) || this.rng.pick(eligible);
				if (!option) break;
				this.chosen.push({ parent: f, option, kind: 'extra' });
			}
		}
	}

	chooseExpertise(n) {
		const already = [...this.skills.values()].filter((s) => s.expertise).length;
		const candidates = [...this.skills.keys()].filter((name) => !this.skills.get(name).expertise);
		const abilityOf = (name) => this.d.skills.find((s) => s.name === name).ability;
		const picks = this.rng.sample(candidates, n - already, (name) => 1 + Math.max(0, this.mods[abilityOf(name)]) * 3);
		for (const p of picks) this.skills.get(p).expertise = true;
	}

	// --- ability scores ----------------------------------------------------------------------

	rollAbilityScores() {
		const { rng, build } = this;
		const priority = build.abilityPriority || ABILITIES;
		let base;
		if (this.o.stats === 'roll') {
			base = Array.from({ length: 6 }, () => {
				const dice = [rng.int(1, 6), rng.int(1, 6), rng.int(1, 6), rng.int(1, 6)].sort((a, b) => a - b);
				return dice[1] + dice[2] + dice[3];
			}).sort((a, b) => b - a);
		} else {
			base = [...STANDARD_ARRAY];
		}
		const scores = {};
		priority.forEach((ab, i) => { scores[ab] = base[i]; });

		// Racial increases (+ "choose N other abilities" for half-elves etc.)
		const inc = { ...this.race.abilityScoreIncrease, ...((this.variant && this.variant.abilityScoreIncrease) || {}) };
		for (const [ab, n] of Object.entries(inc)) scores[ab] = Math.min(20, scores[ab] + n);
		if (this.race.abilityScoreChoice) {
			const { count, amount } = this.race.abilityScoreChoice;
			priority.filter((ab) => !inc[ab]).slice(0, count).forEach((ab) => { scores[ab] = Math.min(20, scores[ab] + amount); });
		}

		// Ability Score Improvements, sometimes swapped for a feat
		const featChance = this.o.featChance != null ? Number(this.o.featChance) : this.d.hints.featChance || 0;
		for (const lvl of this.cls.asiLevels || []) {
			if (lvl > this.level) break;
			const pick = rng.float() < featChance ? this.pickFeat(scores, lvl) : undefined;
			if (pick) {
				this.feats.push(pick);
				for (const [ab, n] of Object.entries(pick.increase)) scores[ab] = Math.min(20, scores[ab] + n);
				continue;
			}
			let points = 2;
			for (const ab of priority) {
				while (points > 0 && scores[ab] < 20) { scores[ab]++; points--; }
			}
		}

		// Features like Primal Champion that raise scores (and their maximums) directly
		for (const f of this.activeFeatures) {
			if (!f.abilityScoreIncrease) continue;
			for (const [ab, n] of Object.entries(f.abilityScoreIncrease)) {
				const max = (f.abilityScoreMaximum && f.abilityScoreMaximum[ab]) || 20;
				scores[ab] = Math.min(Math.max(max, 20), scores[ab] + n);
			}
		}
		this.scores = scores;
		this.mods = Object.fromEntries(ABILITIES.map((ab) => [ab, mod(scores[ab])]));
	}

	// Picks a feat the companion qualifies for at this level: only feats the sheet shows (no Unearthed
	// Arcana) whose prerequisites can be checked. Returns { feat, option, increase }.
	pickFeat(scores, level) {
		const taken = new Set(this.feats.map((p) => p.feat.name));
		const excluded = new Set((this.cls.excludedFeats || []).map((n) => n.toLowerCase()));
		const eligible = this.d.feats.filter((feat) => !feat.hiddenInSheet && !feat.unearthedArcana
			&& !excluded.has(feat.key) && !excluded.has(feat.name.toLowerCase())
			&& (!taken.has(feat.name) || feat.allowDuplicates) && this.meetsFeatPrereqs(feat.prerequisites, scores, level)
			&& this.featAllowed(feat, scores, level));
		const feat = this.rng.pick(eligible);
		if (!feat) return undefined;
		const priority = (this.build.abilityPriority || ABILITIES).filter((ab) => scores[ab] < 20);
		const rank = (inc) => Math.min(...Object.keys(inc || {}).map((ab) => (priority.includes(ab) ? priority.indexOf(ab) : 99)), 99);
		// Choice feats (Resilient, Fey Touched, ...): prefer the option that raises the best ability
		let option;
		if (feat.choices) {
			const ranked = [...feat.choices].sort((a, b) => rank(a.abilityScoreIncrease) - rank(b.abilityScoreIncrease));
			option = rank(ranked[0].abilityScoreIncrease) < 99 ? ranked[0] : this.rng.pick(feat.choices);
		}
		let increase = { ...(feat.abilityScoreIncrease || {}), ...((option && option.abilityScoreIncrease) || {}) };
		// Half-feats described only in text ("+1 Intelligence or Wisdom")
		if (!Object.keys(increase).length && feat.abilityScoreText) {
			const named = (feat.abilityScoreText.match(/Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma/g) || [])
				.map((n) => Object.keys(ABILITY_FULL).find((k) => ABILITY_FULL[k] === n));
			const best = priority.find((ab) => named.includes(ab));
			const amount = Number((/\+(\d)/.exec(feat.abilityScoreText) || [])[1]) || 1;
			if (best) increase = { [best]: amount };
		}
		return { feat, option, increase };
	}

	// Extra feat filter on top of the prerequisites (e.g. NPCs skip feats their gear can't use); none for characters.
	featAllowed() {
		return true;
	}

	meetsFeatPrereqs(p, scores, level) {
		if (!p) return true;
		if (p.other || p.feats || p.campaign) return false; // not machine-checkable here
		if (p.level && level < p.level) return false;
		if (p.abilityScores && !p.abilityScores.anyOf.some((ab) => scores[ab] >= p.abilityScores.minimum)) return false;
		if (p.spellcasting && !this.cls.spellcasting) return false;
		if (p.classes && !p.classes.some((c) => c.toLowerCase() === this.cls.key)) return false;
		if (p.alignment && new RegExp(p.alignment.replace('non-', ''), 'i').test(this.alignment)) return false;
		if (p.proficiency) {
			const armor = /(light|medium|heavy) armor/i.exec(p.proficiency);
			const armorProfs = [...(this.cls.armorProficiencies || []), ...(this.race.armorProficiencies || [])];
			if (armor && !armorProfs.includes(armor[1].toLowerCase())) return false;
			if (/martial weapon/i.test(p.proficiency) && !(this.cls.weaponProficiencies || {}).martial) return false;
			if (!armor && !/martial weapon/i.test(p.proficiency)) return false;
		}
		if (p.races && !p.races.some((r) => this.raceMatches(r))) return false;
		return true;
	}

	// "Elf" matches "High elf" but not "Half-elf"; "Drow (Dark Elf)" matches either name; "small race" checks size.
	raceMatches(required) {
		if (/small race/i.test(required)) return this.race.size === 'Small';
		const name = [this.race.name, this.race.sortName, this.variant && this.variant.name].filter(Boolean).join(' ').toLowerCase();
		const alternatives = required.toLowerCase().replace(/\)/g, '').split(/\s*\(\s*/);
		return alternatives.some((alt) => new RegExp(`(^|[^\\w-])${alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`).test(name));
	}

	// --- proficiencies -----------------------------------------------------------------------

	applyProficiencies() {
		const { rng, d } = this;
		const feats = this.activeFeatures;
		const featParts = this.feats.flatMap((p) => [p.feat, p.option].filter(Boolean));
		this.saves = new Set([...(this.cls.savingThrows || []), ...feats.flatMap((f) => f.savingThrows || []), ...featParts.flatMap((f) => f.savingThrows || [])]);

		const armor = new Set([...(this.cls.armorProficiencies || []), ...(this.race.armorProficiencies || [])]);
		for (const f of feats) {
			if (Array.isArray(f.armorProficiencies)) ['light', 'medium', 'heavy', 'shields'].forEach((t, i) => { if (f.armorProficiencies[i]) armor.add(t); });
		}
		this.armorProfs = armor;

		const wp = this.cls.weaponProficiencies || {};
		const rwp = this.race.weaponProficiencies || {};
		this.weaponProfs = {
			simple: !!(wp.simple || rwp.simple),
			martial: !!(wp.martial || rwp.martial),
			specific: new Set([...(wp.specific || []), ...(rwp.specific || [])].map((s) => s.toLowerCase())),
		};

		const allSkills = d.skills.map((s) => s.name);
		const skillWeight = (name) => Math.max(0.2, 1 + this.mods[d.skills.find((s) => s.name === name).ability] * 2);
		const addSkills = (from, count) => {
			const pool = (from === 'any' ? allSkills : from).filter((s) => allSkills.includes(s) && !this.skills.has(s));
			const picks = rng.sample(pool.length >= count ? pool : allSkills.filter((s) => !this.skills.has(s)), count, skillWeight);
			for (const p of picks) this.skills.set(p, { expertise: false });
		};
		for (const s of this.race.skills || []) this.skills.set(s, { expertise: false });
		if (this.race.skillChoice && this.race.skillChoice.count) addSkills(this.race.skillChoice.from, this.race.skillChoice.count);
		if (this.cls.skillChoice && this.cls.skillChoice.count) addSkills(this.cls.skillChoice.from, this.cls.skillChoice.count);
		for (const f of feats) if (f.skillChoice && f.skillChoice.count) addSkills(f.skillChoice.from, f.skillChoice.count);
		if (this.background) {
			for (const s of this.background.skills || []) {
				if (this.skills.has(s)) addSkills('any', 1);
				else this.skills.set(s, { expertise: false });
			}
		} else if (this.useGenericBackground !== false) {
			addSkills('any', 2); // generic background
		}

		// Languages: race + features + any extra picks
		for (const l of this.race.languages || []) this.languages.add(l);
		for (const f of feats) for (const l of f.languages || []) if (typeof l === 'string') this.languages.add(l);
		const backgroundLanguages = this.background ? Number((this.background.languages || []).find((l) => typeof l === 'number')) || 0 : this.useGenericBackground !== false ? 1 : 0;
		const extra = (this.race.extraLanguages || 0) + backgroundLanguages;
		const pool = d.hints.languages.filter((l) => !this.languages.has(l));
		for (const l of rng.sample(pool, extra)) this.languages.add(l);
	}

	// --- gear --------------------------------------------------------------------------------

	isProficient(w) {
		const p = this.weaponProfs;
		if (p.specific.has(w.key) || p.specific.has(w.name.toLowerCase())) return true;
		if (w.category === 'Simple') return p.simple;
		if (w.category === 'Martial') return p.martial;
		return w.category === 'Natural';
	}

	weapon(key) { return this.d.weapons.find((w) => w.key === key); }

	chooseGear() {
		this.pickWeapons();
		this.chooseArmor();
		this.listEquipment();
	}

	pickWeapons() {
		const { rng, build } = this;
		const usable = (keys) => (keys || []).map((k) => this.weapon(k)).filter((w) => w && this.isProficient(w));
		const isMonk = this.cls.key === 'monk';

		this.mainWeapon = rng.pick(usable(build.mainWeapons))
			|| rng.pick(this.d.weapons.filter((w) => w.list === 'melee' && this.isProficient(w) && !w.twoHanded))
			|| this.weapon('unarmed strike');
		const rangedPool = usable(build.rangedWeapons).filter((w) => w.key !== this.mainWeapon.key);
		this.rangedWeapon = rng.pick(rangedPool);

		this.shield = build.offHand === 'shield' && this.armorProfs.has('shields') && !this.mainWeapon.twoHanded && !isMonk;
		this.offHandWeapon = build.offHand === 'weapon' && this.mainWeapon.light ? this.mainWeapon : undefined;
	}

	chooseArmor() {
		this.pickArmor(this.armorOptions());
	}

	// Every armor (and unarmored defense) the companion could use: { armor, ac, label, unarmored, noShield }
	armorOptions() {
		const { build } = this;
		const dex = this.mods.Dex;
		const unlock = this.d.hints.armorUnlockLevel || {};
		const allowed = this.hint.allowedArmor;
		const options = [];
		for (const a of this.d.armor) {
			if (!['light', 'medium', 'heavy'].includes(a.type) || !this.armorProfs.has(a.type)) continue;
			if ((unlock[a.key] || 1) > this.level) continue;
			if (allowed && !allowed.includes(a.key)) continue;
			if (a.strengthRequirement && this.scores.Str < a.strengthRequirement) continue;
			if (build.stealthy && a.stealthDisadvantage) continue;
			const ac = a.ac + (a.type === 'heavy' ? 0 : a.type === 'medium' ? Math.min(dex, 2) : dex);
			options.push({ armor: a, ac, label: (a.inventoryName || a.name).toLowerCase() });
		}
		// Unarmored options (Unarmored Defense, Draconic Resilience, ...)
		options.push({ ac: 10 + dex, label: null, unarmored: true });
		for (const f of this.activeFeatures) {
			for (const ao of f.armorOptions || []) {
				let ac = typeof ao.ac === 'number' ? ao.ac + dex : 10 + dex;
				const m = /10\+(\w{3})/.exec(String(ao.ac));
				if (m) ac = 10 + dex + this.mods[m[1]];
				options.push({ ac, label: ao.name.replace(/\s*\(\w+\)$/, '').toLowerCase(), unarmored: true, noShield: /Wis/.test(String(ao.ac)) });
			}
		}
		return options;
	}

	// Best AC wins; lighter armor breaks ties.
	pickArmor(options) {
		const shieldBonus = (o) => (this.shield && !o.noShield ? 2 : 0);
		options.sort((a, b) => (b.ac + shieldBonus(b)) - (a.ac + shieldBonus(a)) || (a.armor ? a.armor.weight || 0 : 0) - (b.armor ? b.armor.weight || 0 : 0));
		this.armorChoice = options[0];
		if (this.armorChoice.noShield) this.shield = false;
	}

	listEquipment() {
		const main = this.mainWeapon;
		const mainName = (main.displayName || main.name).toLowerCase();
		if (this.armorChoice.armor) this.equipment.push(this.armorChoice.label);
		if (this.shield) this.equipment.push(this.shieldLabel || 'shield');
		if (main.key !== 'unarmed strike') this.equipment.push(this.offHandWeapon ? `2 ${mainName}s` : mainName);
		if (this.rangedWeapon) {
			const r = this.rangedWeapon;
			const name = (r.displayName || r.name).toLowerCase();
			const thrownCount = { javelin: 4, dart: 10 }[r.key] || 2;
			this.equipment.push(r.thrown && !r.ammunition ? `${thrownCount} ${name}s` : name);
			if (r.ammunition) this.equipment.push(r.ammoLabel || `20 ${r.ammunition === 'arrow' ? 'arrows' : r.ammunition + 's'}`);
		}
		if (this.hint.focus) this.equipment.push(this.hint.focus.toLowerCase());
		if (this.background && this.background.equipment) {
			// MPMB inventory names are sorted-style ("Incense, sticks of") -> "sticks of incense"
			this.equipment.push(...this.background.equipment.map((e) => e.name.toLowerCase().replace(/^(.+), ([\w ]+ of)$/, '$2 $1')));
		}
	}

	// --- spells ------------------------------------------------------------------------------

	casterSetup() {
		const sc = this.cls.spellcasting;
		if (!sc) return undefined;
		const L = this.level;
		const t = this.d.slotTables;
		let slots;
		if (sc.progression === 'pact') {
			slots = { ...t.pact[L] };
			delete slots.warlockLevel;
		} else {
			const casterLevel = sc.progression === 'full' ? L : sc.progression === 'half' ? (L < 2 ? 0 : Math.ceil(L / 2)) : (L < 3 ? 0 : Math.ceil(L / 3));
			slots = { ...t.full[casterLevel] };
			delete slots.casterLevel;
		}
		const slotLevels = Object.entries(slots).filter(([, n]) => n > 0).map(([k]) => spellLevelNumber(k));
		const maxLevel = slotLevels.length ? Math.max(...slotLevels) : 0;
		const cantrips = sc.cantripsKnown ? sc.cantripsKnown[L - 1] : 0;
		if (!maxLevel && !cantrips) return undefined;
		return { sc, slots, maxLevel, cantrips, ability: sc.ability };
	}

	// Whether a spell is on the given class's list (subclasses can widen what "the class's list" means).
	onClassList(spell, classKey = this.cls.key) {
		return spell.classes.has(classKey);
	}

	spellPool(classKey, minLevel, maxLevel) {
		const known = new Set(this.spellList.map((s) => s.name.toLowerCase()));
		const expanded = classKey === this.cls.key ? this.expandedList : undefined;
		return [...this.d.spells.values()].filter((s) => (classKey === 'any' || this.onClassList(s, classKey) || (expanded && expanded.has(s.name.toLowerCase())))
			&& s.level >= minLevel && s.level <= maxLevel && !known.has(s.name.toLowerCase()));
	}

	addSpell(spell, group) {
		if (!spell || this.spellList.some((s) => s.name.toLowerCase() === spell.name.toLowerCase())) return false;
		this.spellList.push({ name: spell.name, level: spell.level, group });
		return true;
	}

	chooseSpells() {
		const c = (this.caster = this.casterSetup());
		const signature = (this.hint.signatureSpells || []).map((n) => this.d.spells.get(n.toLowerCase())).filter(Boolean);
		// Subclass/option spell lists: always prepared for prepared casters (domain, oath, circle spells),
		// but only an expanded list to pick from for known casters (e.g. a warlock patron's spells).
		const extras = [...((this.sub && this.sub.spellcastingExtra) || []), ...this.chosen.flatMap((x) => x.option.spellcastingExtra || [])]
			.map((n) => String(n).toLowerCase());
		const knownCaster = c && c.sc.preparation === 'known';
		this.expandedList = new Set(knownCaster ? extras : []);
		if (c) {
			const ck = this.cls.key;
			const attackCantrips = new Set(this.d.weapons.filter((w) => w.category === 'Cantrip').map((w) => w.key));
			// Cantrips: signature first, make sure there's at least one attack cantrip, then random
			let n = c.cantrips;
			for (const s of signature.filter((s) => s.level === 0 && this.onClassList(s, ck))) if (n > 0 && this.addSpell(s, 'class')) n--;
			if (n > 0 && !this.spellList.some((s) => attackCantrips.has(s.name.toLowerCase()))) {
				if (this.addSpell(this.rng.pick(this.spellPool(ck, 0, 0).filter((s) => attackCantrips.has(s.name.toLowerCase()))), 'class')) n--;
			}
			for (; n > 0; n--) if (!this.addSpell(this.rng.pick(this.spellPool(ck, 0, 0)), 'class')) break;

			// Levelled spells
			if (c.maxLevel) {
				const sc = c.sc;
				let count;
				if (sc.preparation === 'known') count = (sc.spellsKnown || [])[this.level - 1] || 0;
				else {
					const divisor = (sc.preparedFormula && sc.preparedFormula.levelDivisor) || 1;
					count = Math.max(1, this.mods[c.ability] + Math.floor(this.level / divisor));
				}
				// Always-prepared spells go first (they don't count against the limit) so signature
				// spells they already cover don't use up a prepared slot.
				for (const name of knownCaster ? [] : extras) {
					const s = this.d.spells.get(name);
					if (s && s.level <= c.maxLevel) this.addSpell(s, 'class');
				}
				for (const s of signature.filter((s) => s.level >= 1 && s.level <= c.maxLevel && this.onClassList(s, ck))) if (count > 0 && this.addSpell(s, 'class')) count--;
				// Round-robin from the highest level down so the list covers every slot level
				let guard = 0;
				while (count > 0 && guard++ < 500) {
					let added = false;
					for (let lvl = c.maxLevel; lvl >= 1 && count > 0; lvl--) {
						if (this.addSpell(this.rng.pick(this.spellPool(ck, lvl, lvl)), 'class')) { count--; added = true; }
					}
					if (!added) break;
				}
			}
		}
		// Bonus spells from class/subclass features (Magical Secrets, Mystic Arcanum, bonus cantrips)
		for (const f of this.classFeatures.map((x) => x.f)) this.addBonusSpells(f, c);
		// Racial innate spellcasting
		for (const b of [...(this.race.spellcastingBonus || []), ...this.raceFeatures.flatMap((f) => f.spellcastingBonus || [])]) this.addInnate(b);
	}

	addBonusSpells(f, c) {
		for (const b of f.spellcastingBonus || []) {
			const times = Array.isArray(b.times) ? b.times[this.level - 1] || 0 : b.times != null ? Number(b.times) : 1;
			if (!times) continue;
			if (b.spells) {
				if (!c && !b.frequency) continue; // e.g. Monk's Empty Body: described by the feature itself
				for (const name of b.spells) {
					const s = this.d.spells.get(name.toLowerCase()) || { name: titleCase(name), level: 0 };
					this.addSpell(s, b.frequency || 'class');
				}
				continue;
			}
			if (!c) continue;
			const [lo, hi] = b.spellLevels || [0, c.maxLevel];
			for (let i = 0; i < times; i++) {
				const pool = this.spellPool(b.class || this.cls.key, lo, Math.min(hi, 9)).filter((s) => s.level === 0 || s.level <= Math.max(c.maxLevel, hi));
				const group = b.frequency === '1/long rest' ? '1/day' : 'class';
				// Prefer the highest available level for spell-picking features like Magical Secrets
				// Spell-picking features like Magical Secrets lean towards the top three spell levels
				const top = Math.max(...pool.map((p) => p.level), 0);
				const level = this.rng.int(Math.max(1, top - 2), Math.max(1, top));
				const best = b.spellLevels ? pool : pool.filter((s) => s.level === level);
				this.addSpell(this.rng.pick(best.length ? best : pool), group);
			}
		}
	}

	addInnate(b) {
		const freq = b.frequency || 'at will';
		if (b.spells) {
			for (const name of b.spells) {
				const s = this.d.spells.get(name.toLowerCase());
				this.innate.push({ name: s ? s.name : titleCase(name), frequency: freq });
			}
		} else if (b.class) {
			const [lo, hi] = b.spellLevels || [0, 0];
			const taken = new Set(this.innate.map((s) => s.name));
			const s = this.rng.pick([...this.d.spells.values()].filter((x) => x.classes.has(b.class) && x.level >= lo && x.level <= hi && !taken.has(x.name)));
			if (s) this.innate.push({ name: s.name, frequency: freq });
		}
	}

	addOptionSpells() {
		for (const { option } of this.chosen.filter((x) => x.kind === 'extra')) this.addBonusSpells(option, this.caster);
	}

	knowsSpell(name) {
		const n = name.toLowerCase();
		return this.spellList.some((s) => s.name.toLowerCase() === n) || this.innate.some((s) => s.name.toLowerCase() === n);
	}

	// --- rendering helpers -------------------------------------------------------------------

	push(category, name, desc) {
		this.entries[category].push({ [name]: desc });
	}

	usageAt(f) {
		let u = f.usages;
		if (Array.isArray(u)) u = u[this.level - 1];
		if (f.usagesFormula) {
			const { ability, plus = 0, min = 0 } = f.usagesFormula;
			return Math.max(min, this.mods[ability] + plus);
		}
		if (typeof u === 'string') return /∞/.test(u) ? Infinity : parseInt(u, 10) || null;
		return typeof u === 'number' ? u : null;
	}

	usageSuffix(f) {
		const n = this.usageAt(f);
		if (!n || n === Infinity) return '';
		const rec = Array.isArray(f.recovery) ? f.recovery[this.level - 1] : f.recovery;
		const pointName = /points?$/i.test(f.limitedFeatureName || '') ? ` ${f.limitedFeatureName.replace(/^.*?(\w+ Points?)$/i, '$1')}` : '';
		if (/short/i.test(rec || '')) return n === 1 && !pointName ? 'Recharges after a Short or Long Rest' : `${n}${pointName}/Short Rest`;
		return `${n}${pointName}/Day`;
	}

	// --- features -> statblock entries -------------------------------------------------------

	renderFeatures() {
		const omit = new Set((this.d.hints.omitFeatures || []).map((n) => n.toLowerCase()));
		const hasOptions = new Set(this.chosen.filter((c) => c.kind !== 'auto').map((c) => c.parent));
		const L = this.level;

		const emit = (f, displayName) => {
			let name = displayName || f.name;
			if (omit.has(name.toLowerCase()) || f.omit) return;
			// Option costs like "[1 ki point]" move into the name: "Flurry of Blows (1 Ki Point)"
			const cost = /^\s*\[([^\]]+)\]\s*/.exec(f.description || '');
			let desc = prose(cost ? f.description.slice(cost[0].length) : f.description);
			const suffix = [];
			if (cost) suffix.push(titleCase(cost[1]));
			const usage = this.usageSuffix(f);
			if (usage) suffix.push(usage);
			let add = Array.isArray(f.additional) ? f.additional[L - 1] : f.additional;
			if (add && (/^optional/i.test(add) || (f.limitedFeatureName && add.toLowerCase() === f.limitedFeatureName.toLowerCase()))) add = '';
			if (add && add.length <= 24) suffix.push(add);
			else if (add) desc += ` (${prose(add).replace(/\.$/, '')}).`;
			if (!desc) return;
			if (suffix.length) name += ` (${suffix.join('; ')})`;
			const type = f.actions && f.actions[0] && f.actions[0].type;
			const category = type === 'action' ? 'Actions' : type === 'bonus action' ? 'BonusActions' : type === 'reaction' ? 'Reactions' : 'Abilities';
			this.push(category, name, desc);
		};

		// Race traits (prose comes from the trait text; limited uses from the matching race feature)
		const raceTraits = [...(this.race.traits || []), ...((this.variant && this.variant.traits) || [])];
		for (const t of raceTraits) {
			if (omit.has(t.name.toLowerCase()) || /breath weapon/i.test(t.name)) continue;
			const feature = this.raceFeatures.find((f) => f.name.toLowerCase() === t.name.toLowerCase());
			const suffix = feature ? this.usageSuffix(feature) : '';
			const desc = prose(t.desc.replace(/ I can't use this feature again until I finish a (short|long) rest\.?/i, ''));
			this.push('Abilities', suffix ? `${t.name} (${suffix})` : t.name, desc);
		}

		for (const { f } of this.classFeatures) {
			if (hasOptions.has(f) && !this.usageAt(f)) continue; // the chosen option(s) replace the "choose one" feature
			emit(f);
		}
		for (const { option, parent } of this.chosen) {
			const fsName = /fighting style/i.test(option.name) ? option.name.replace(/ Fighting Style$/, '').replace(/^/, 'Fighting Style: ') : undefined;
			if (option.extraAC || option.key === 'defense') continue; // folded into AC
			if (parent.extraChoices && /favored (enemy|terrain)/i.test(parent.extraChoices.name || '')) continue; // summarised below
			emit(option, fsName);
		}
		// Favored enemies / terrains read better as one line each
		for (const label of ['Favored Enemy', 'Favored Terrain']) {
			const picks = this.chosen.filter((c) => c.parent.extraChoices && c.parent.extraChoices.name === label && c.kind === 'extra');
			if (!picks.length) continue;
			const parent = picks[0].parent;
			// Favored Terrain's real rules text lives on its auto-granted "Travel Benefits" option
			const auto = this.chosen.find((c) => c.parent === parent && c.kind === 'auto');
			const desc = prose(parent.description) || (auto ? prose(auto.option.description) : '');
			this.push('Abilities', `${label} (${listJoin(picks.map((p) => p.option.name.toLowerCase()))})`, desc);
		}
		for (const { feat, option } of this.feats) {
			const source = option && option.description ? option : feat;
			// "[+1 Constitution]" notes are already applied to the stats
			const desc = prose(String(source.description || '').replace(/\s*\[\+\d[^\]]*\]/g, ''));
			const actions = (option && option.actions) || feat.actions;
			const type = actions && actions[0] && actions[0].type;
			const category = type === 'action' ? 'Actions' : type === 'bonus action' ? 'BonusActions' : type === 'reaction' ? 'Reactions' : 'Abilities';
			const usage = this.usageSuffix(feat);
			const name = `${feat.name}${option ? ` (${option.name})` : ''}${usage ? ` (${usage})` : ''}`;
			if (desc) this.push(category, name, desc);
		}
	}

	// --- attacks -----------------------------------------------------------------------------

	abilityFor(w) {
		const monk = this.cls.key === 'monk' && w.monkWeapon;
		if (w.finesse || monk) return this.mods.Dex > this.mods.Str ? 'Dex' : 'Str';
		if (w.list === 'ranged') return 'Dex';
		return 'Str';
	}

	toHit(ab, bonus = 0, token = ab) {
		return this.keepTokens && !bonus ? `[${token.toUpperCase()} ATK]` : signed(this.prof + this.mods[ab] + bonus);
	}

	damage(ab, dice, { bonus = 0, addMod = true, token = ab } = {}) {
		const [count, die] = dice.split('d').map(Number);
		if (this.keepTokens && !bonus && addMod) return `[${token.toUpperCase()} ${dice.toUpperCase()}]`;
		const total = (addMod ? this.mods[ab] : 0) + bonus;
		const avg = Math.max(1, avgDice(count, die) + total);
		return `${avg} (${dice}${total ? (total > 0 ? ' + ' : ' - ') + Math.abs(total) : ''})`;
	}

	weaponAction(w, { offHand = false } = {}) {
		const ab = this.abilityFor(w);
		const token = w.finesse && !(this.cls.key === 'monk') ? 'FIN' : ab;
		const styles = this.fightingStyleKeys();
		const melee = w.list === 'melee' || /^melee/i.test(w.range || '');
		const thrown = melee && w.thrown && w.rangeNormal;
		// magicBonus: +N weapons/ammunition; damageBonus: flat extra damage (e.g. Bracers of Archery)
		const magic = w.magicBonus || 0;
		const hitBonus = (!melee && styles.has('archery') ? 2 : 0) + magic;
		const twoHandsBusy = this.shield || this.offHandWeapon;
		const dmgBonus = (melee && !offHand && styles.has('dueling') && !w.twoHanded && !this.offHandWeapon ? 2 : 0) + magic + (w.damageBonus || 0);
		const addMod = !offHand || styles.has('two-weapon fighting') || this.mods[ab] < 0;

		let dice = w.damage && w.damage.dice;
		if (this.cls.key === 'monk' && (w.monkWeapon || w.key === 'unarmed strike')) {
			const ma = this.cls.features.find((f) => f.key === 'martial arts');
			const maDie = ma && ma.additional[this.level - 1];
			if (maDie && (!dice || avgDice(...maDie.split('d').map(Number)) > avgDice(...dice.split('d').map(Number)))) dice = maDie;
		}

		const kind = thrown ? 'Melee or Ranged Weapon Attack' : melee ? 'Melee Weapon Attack' : 'Ranged Weapon Attack';
		const reach = thrown ? `reach ${w.reach || 5} ft. or range ${w.rangeNormal}/${w.rangeLong} ft.`
			: melee ? `reach ${w.reach || 5} ft.` : `range ${w.rangeNormal}/${w.rangeLong} ft.`;
		const type = (w.damage && w.damage.type) || 'bludgeoning';
		let hit;
		if (dice) hit = `${this.damage(ab, dice, { bonus: dmgBonus, addMod, token })} ${type} damage`;
		else {
			const flat = ((w.damage && w.damage.flat) || 1) + (addMod ? this.mods[ab] : 0) + dmgBonus;
			hit = `${Math.max(1, flat)} ${type} damage`;
		}
		if (w.versatileDamage && !twoHandsBusy && !offHand) {
			hit += `, or ${this.damage(ab, w.versatileDamage, { bonus: dmgBonus, addMod, token })} ${type} damage if used with two hands`;
		}
		if (melee && this.activeFeatures.some((f) => f.key === 'improved divine smite')) hit += ', plus 4 (1d8) radiant damage';
		// Extra damage dice, e.g. a Flame Tongue's { dice: '2d6', type: 'fire' } or { ..., when: 'against undead' }
		for (const r of w.riders || []) {
			const [count, die] = r.dice.split('d').map(Number);
			hit += `, plus ${avgDice(count, die)} (${r.dice}) ${r.type} damage${r.when ? ' ' + r.when : ''}`;
		}
		return `_${kind}:_ ${this.toHit(ab, hitBonus, token)} to hit, ${reach}, one target. _Hit:_ ${hit}.`;
	}

	// Flat bonus added to cantrip damage (e.g. Potent Cantrips); none for class characters.
	cantripDamageBonus() {
		return 0;
	}

	// Extra bonus to spell save DCs / spell attack rolls (e.g. from magic items); none by default.
	spellDCBonus() {
		return 0;
	}

	spellAttackBonus() {
		return 0;
	}

	cantripAction(w, ability) {
		const dice = this.d.levels[this.level - 1].cantripDice;
		const save = 8 + this.prof + this.mods[ability] + this.spellDCBonus();
		const saveText = this.keepTokens && !this.spellDCBonus() ? `[${ability.toUpperCase()} SAVE]` : save;
		const die = w.damage.die;
		const flat = this.cantripDamageBonus(ability);
		const dmg = (count) => `${Math.max(1, avgDice(count, die) + flat)} (${count}d${die}${flat ? (flat > 0 ? ' + ' : ' - ') + Math.abs(flat) : ''})`;
		const range = /^melee/i.test(w.range) ? 'reach 5 ft.' : `range ${w.range.replace(/ft$/, 'ft.')}`;
		if (w.savingThrow) {
			return `Each target must succeed on a DC ${saveText} ${ABILITY_FULL[w.savingThrow] || w.savingThrow} saving throw or take ${dmg(dice)} ${w.damage.type} damage.`;
		}
		const kind = /^melee/i.test(w.range) ? 'Melee Spell Attack' : 'Ranged Spell Attack';
		const toHit = this.toHit(ability, this.spellAttackBonus());
		if (w.damage.perBeam) {
			const agonizing = (this.chosen.some((c) => /agonizing blast/i.test(c.option.name)) ? this.mods[ability] : 0) + flat;
			const beamDmg = `${avgDice(1, die) + agonizing} (1d${die}${agonizing ? ' + ' + agonizing : ''})`;
			const beams = dice > 1 ? ` The [MON] fires ${NUMBER_WORDS[dice] || dice} beams, making a separate attack roll for each.` : '';
			return `_${kind}:_ ${toHit} to hit, ${range}, one target. _Hit:_ ${beamDmg} ${w.damage.type} damage.${beams}`;
		}
		const rider = w.description && !/save/i.test(w.description) ? ' ' + prose(w.description) : '';
		return `_${kind}:_ ${toHit} to hit, ${range}, one target. _Hit:_ ${dmg(dice)} ${w.damage.type} damage.${rider}`;
	}

	renderAttacks() {
		const actions = [];
		const name = (w) => w.attackName || w.displayName || w.name;
		// Multiattack
		let attacks = (this.cls.attacksPerLevel || [])[this.level - 1] || 1;
		if (this.chosen.some((c) => /thirsting blade/i.test(c.option.name))) attacks = Math.max(attacks, 2);
		if (attacks > 1) {
			const w = this.build.preferRanged && this.rangedWeapon ? this.rangedWeapon : this.mainWeapon;
			const withWhat = w.key === 'unarmed strike' ? 'unarmed strikes' : `its ${(w.displayName || w.name).toLowerCase()}`;
			actions.push(['Multiattack', `The [MON] makes ${NUMBER_WORDS[attacks] || attacks} attacks with ${withWhat}.`]);
		}
		actions.push([name(this.mainWeapon), this.weaponAction(this.mainWeapon)]);
		if (this.cls.key === 'monk' && this.mainWeapon.key !== 'unarmed strike') {
			actions.push(['Unarmed Strike', this.weaponAction(this.weapon('unarmed strike'))]);
		}
		if (this.rangedWeapon) actions.push([name(this.rangedWeapon), this.weaponAction(this.rangedWeapon)]);

		// Attack cantrips
		const cantripWeapons = this.d.weapons.filter((w) => w.category === 'Cantrip');
		const castAbility = this.caster ? this.caster.ability : undefined;
		for (const s of this.spellList.filter((x) => x.level === 0)) {
			const w = cantripWeapons.find((cw) => cw.key === s.name.toLowerCase());
			if (w && castAbility) actions.push([w.name, this.cantripAction(w, castAbility)]);
		}
		for (const s of this.innate.filter((x) => x.frequency === 'at will')) {
			const w = cantripWeapons.find((cw) => cw.key === s.name.toLowerCase());
			if (w && this.race.spellcastingAbility) actions.push([w.name, this.cantripAction(w, this.race.spellcastingAbility)]);
		}

		// Racial breath weapon
		const breath = (this.race.attacks || []).find((a) => /breath/i.test(a.name));
		if (breath && this.variant) {
			const color = this.variant.key.split('-')[1];
			const type = ((this.variant.damageResistances || [])[0] || 'fire').toLowerCase();
			const saveAb = /cold|poison/.test(type) ? 'Con' : 'Dex';
			const count = this.level < 6 ? 2 : this.level < 11 ? 3 : this.level < 16 ? 4 : 5;
			const dc = this.keepTokens ? '[CON SAVE]' : 8 + this.prof + this.mods.Con;
			const area = DRAGON_LINE_BREATH.includes(color) ? '5-foot-wide, 30-foot line' : '15-foot cone';
			actions.push(['Breath Weapon (Recharges after a Short or Long Rest)',
				`The [MON] exhales ${type} in a ${area}. Each creature in that area must make a DC ${dc} ${ABILITY_FULL[saveAb]} saving throw, taking ${avgDice(count, 6)} (${count}d6) ${type} damage on a failed save, or half as much damage on a successful one.`]);
		}

		this.entries.Actions.unshift(...actions.map(([n, d]) => ({ [n]: d })));
		if (this.offHandWeapon) {
			this.entries.BonusActions.unshift({ [`Off-Hand ${this.offHandWeapon.name}`]: this.weaponAction(this.offHandWeapon, { offHand: true }) });
		}
	}

	// --- spellcasting text -------------------------------------------------------------------

	renderSpellcasting() {
		const c = this.caster;
		const groups = [];
		if (c || this.spellList.length) {
			const ab = (c && c.ability) || this.cls.saveDCAbility || 'Int';
			const dcBonus = this.spellDCBonus();
			const atkBonus = this.spellAttackBonus();
			const dc = this.keepTokens && !dcBonus ? `[${ab.toUpperCase()} SAVE]` : 8 + this.prof + this.mods[ab] + dcBonus;
			const atk = this.keepTokens && !atkBonus ? `[${ab.toUpperCase()} ATK]` : signed(this.prof + this.mods[ab] + atkBonus);
			const lower = (arr) => arr.map((s) => s.name.toLowerCase()).sort().join(', ');
			const classSpells = this.spellList.filter((s) => s.group === 'class');
			const lines = [];
			const cantrips = classSpells.filter((s) => s.level === 0);
			if (cantrips.length) lines.push(`> Cantrips (at will): _${lower(cantrips)}_`);
			if (c && c.sc.progression === 'pact') {
				const slotLevel = c.maxLevel;
				const count = c.slots[SPELL_LEVELS[slotLevel]];
				const spells = classSpells.filter((s) => s.level >= 1);
				if (spells.length) lines.push(`> ${slotLevel === 1 ? '1st' : `1st–${ordinal(slotLevel)}`} level (${count} ${ordinal(slotLevel)}-level slot${count > 1 ? 's' : ''}): _${lower(spells)}_`);
			} else if (c) {
				for (let lvl = 1; lvl <= 9; lvl++) {
					const n = c.slots[SPELL_LEVELS[lvl]];
					const spells = classSpells.filter((s) => s.level === lvl);
					if (n && spells.length) lines.push(`> ${ordinal(lvl)} level (${n} slot${n > 1 ? 's' : ''}): _${lower(spells)}_`);
				}
			}
			const atWill = this.spellList.filter((s) => s.group === 'at will');
			const daily = this.spellList.filter((s) => s.group === '1/day' || s.group === '1/long rest');
			if (atWill.length) lines.push(`> At will: _${lower(atWill)}_`);
			if (daily.length) lines.push(`> 1/day each: _${lower(daily)}_`);
			if (lines.length) {
				const verb = c && c.sc.preparation !== 'known' ? 'has the following' : 'knows the following';
				const tail = c && c.sc.preparation !== 'known' ? ' prepared' : '';
				const article = [8, 11, 18].includes(this.level) ? 'an' : 'a';
				const casterLevel = c ? `is ${article} ${ordinal(this.level)}-level spellcaster. Its` : 'has';
				const text = `The [MON] ${casterLevel} spellcasting ability is ${ABILITY_FULL[ab]} (spell save DC ${dc}, ${atk} to hit with spell attacks). `
					+ `The [MON] ${verb} ${this.spellListName()} spells${tail}:\n\n${lines.join('\n')}`;
				this.entries.Abilities.push({ Spellcasting: text });
			}
			groups.push(...this.groupSpells(classSpells), ...(atWill.length ? [{ 'At will': atWill.map((s) => s.name) }] : []), ...(daily.length ? [{ '1/day each': daily.map((s) => s.name) }] : []));
		}
		if (this.innate.length && this.race.spellcastingAbility) {
			const ab = this.race.spellcastingAbility;
			const dc = this.keepTokens ? `[${ab.toUpperCase()} SAVE]` : 8 + this.prof + this.mods[ab];
			const atk = this.keepTokens ? `[${ab.toUpperCase()} ATK]` : signed(this.prof + this.mods[ab]);
			const atWill = this.innate.filter((s) => s.frequency === 'at will').map((s) => s.name.toLowerCase());
			const daily = this.innate.filter((s) => s.frequency !== 'at will').map((s) => s.name.toLowerCase());
			const lines = [];
			if (atWill.length) lines.push(`> At will: _${atWill.join(', ')}_`);
			if (daily.length) lines.push(`> 1/day each: _${daily.join(', ')}_`);
			this.entries.Abilities.push({
				'Innate Spellcasting': `The [MON]'s innate spellcasting ability is ${ABILITY_FULL[ab]} (spell save DC ${dc}, ${atk} to hit with spell attacks). `
					+ `It can innately cast the following spells, requiring no material components:\n\n${lines.join('\n')}`,
			});
		}
		this.spellGroups = groups;
	}

	// "wizard" in "The [MON] has the following wizard spells prepared"
	spellListName() {
		return this.cls.name.toLowerCase();
	}

	groupSpells(spells) {
		const out = [];
		for (let lvl = 0; lvl <= 9; lvl++) {
			const names = spells.filter((s) => s.level === lvl).map((s) => s.name).sort();
			if (names.length) out.push({ [SPELL_LEVELS[lvl]]: names });
		}
		return out;
	}

	// --- pets (familiar / steed) -------------------------------------------------------------

	pets() {
		const pets = [];
		const pact = this.chosen.some((c) => c.option.key === 'pact of the chain');
		const wanted = Object.entries(this.d.hints.pets || {}).filter(([spell]) => this.knowsSpell(spell)).map(([, type]) => type);
		if (pact && !wanted.includes('familiar')) wanted.push('familiar');
		for (const type of wanted) {
			const pool = this.d.creatures.filter((cr) => (cr.companionTypes || []).includes(type) || (type === 'familiar' && pact && (cr.companionTypes || []).includes('pact_of_the_chain')));
			const creature = this.rng.pick(pool);
			if (creature) pets.push(this.creatureStatblock(creature, pact && type === 'familiar' ? 'pact_of_the_chain' : type));
		}
		return pets;
	}

	creatureStatblock(cr, companionType) {
		const ct = this.d.companionTypes.find((t) => t.key === companionType) || {};
		const mods = Object.fromEntries(ABILITIES.map((a) => [a, mod(cr.scores[a])]));
		const actions = [];
		const canAttack = companionType !== 'familiar';
		if (canAttack) {
			for (const a of cr.attacks || []) {
				const ab = a.ability || 'Str';
				const toHit = signed(cr.proficiencyBonus + mods[ab]);
				const melee = /melee/i.test(a.range || '');
				const reach = melee ? `reach ${(/(\d+) ft/.exec(a.range) || [0, 5])[1]} ft.` : `range ${(a.range || '').replace(/ ft$/, '')} ft.`;
				let dmg = '';
				if (a.damage && a.damage.dice) {
					const [n, die] = a.damage.dice.split('d').map(Number);
					const total = avgDice(n, die) + mods[ab];
					dmg = `${Math.max(1, total)} (${a.damage.dice}${mods[ab] ? (mods[ab] > 0 ? ' + ' : ' - ') + Math.abs(mods[ab]) : ''}) ${a.damage.type} damage`;
				} else if (a.damage) dmg = `${a.damage.flat || 1} ${a.damage.type} damage`;
				const rider = a.description ? ` ${a.description.replace(/\.?$/, '.')}` : '';
				actions.push({ [a.name]: `_${melee ? 'Melee' : 'Ranged'} Weapon Attack:_ ${toHit} to hit, ${reach}, one target. _Hit:_ ${dmg}.${rider}` });
			}
		}
		for (const a of cr.actions || []) actions.push({ [a.name]: a.desc });
		const abilities = [...(cr.traits || []), ...(ct.addedFeatures || []), ...(ct.addedTraits || [])].map((t) => ({ [t.name]: t.desc }));
		if (!canAttack) abilities.push({ 'Familiar': "The familiar can't attack, but it can take other actions as normal." });
		const pb = cr.proficiencyBonus;
		const pet = {
			Name: cr.name,
			Role: ct.name || companionType,
			Size: cr.size,
			Type: cr.type === 'Beast' && companionType !== 'mount' ? 'Celestial, fey, or fiend (beast form)' : cr.type,
			HitPoints: `${cr.hp} (${cr.hitDice})`,
			Armor: String(cr.ac),
			Speed: parseInt(cr.speed, 10) || 0,
			SpeedText: cr.speed,
			Stats: { ...cr.scores },
			Skills: Object.entries(cr.skills || {}).map(([k, v]) => ({ [titleCase(k)]: v })),
			'Proficiency Bonus': pb,
			DamageResistances: cr.damageResistances || [],
			DamageImmunities: cr.damageImmunities || [],
			ConditionImmunities: cr.conditionImmunities || [],
			Languages: cr.languages ? [cr.languages] : [],
			Senses: [...String(cr.senses || '').split(/;\s*/).filter(Boolean), `passive Perception ${cr.passivePerception}`],
			Abilities: abilities,
			Actions: actions,
		};
		return this.finalizeTokens(pet, cr.name.toLowerCase());
	}

	// --- assembly ----------------------------------------------------------------------------

	hitPoints() {
		const die = this.cls.hitDie;
		const L = this.level;
		const perLevelNames = new Set((this.d.hints.hpPerLevelFeatures || []).map((n) => n.toLowerCase()));
		const raceTraits = [...(this.race.traits || []), ...((this.variant && this.variant.traits) || [])];
		let perLevel = this.mods.Con;
		if (raceTraits.some((t) => perLevelNames.has(t.name.toLowerCase()))) perLevel++;
		if (this.activeFeatures.some((f) => perLevelNames.has(f.name.toLowerCase()))) perLevel++;
		const total = Math.max(L, die + (L - 1) * (die / 2 + 1) + perLevel * L);
		const bonus = perLevel * L;
		return `${total} (${L}d${die}${bonus ? (bonus > 0 ? ' + ' : ' - ') + Math.abs(bonus) : ''})`;
	}

	// AC bonuses beyond armor, shield and the Defense style (e.g. Improved Defense, Ring of Protection).
	extraAC() {
		return 0;
	}

	armorText() {
		const a = this.armorChoice;
		const defense = a.armor && this.fightingStyleKeys().has('defense') ? 1 : 0;
		const shield = this.shield ? 2 : 0;
		const extra = this.extraAC();
		const ac = a.ac + shield + defense + extra;
		const shieldLabel = this.shieldLabel || 'shield';
		const parts = [];
		// At-will mage armor (Armor of Shadows) simply replaces worse mundane armor.
		const atWillMageArmor = this.spellList.some((s) => s.group === 'at will' && /^mage armor$/i.test(s.name));
		if (atWillMageArmor && 13 + this.mods.Dex + shield > ac) {
			if (a.armor) this.equipment.splice(this.equipment.indexOf(a.label), 1);
			return `${13 + this.mods.Dex + shield} (mage armor${this.shield ? ', ' + shieldLabel : ''})`;
		}
		if (a.label) parts.push(a.label);
		if (this.shield) parts.push(shieldLabel);
		const mageArmor = !a.armor && (this.knowsSpell('Mage Armor')) ? 13 + this.mods.Dex + shield + extra : 0;
		if (mageArmor > ac) parts.push(`${mageArmor} with mage armor`);
		return parts.length ? `${ac} (${parts.join(', ')})` : String(ac);
	}

	speeds() {
		let walk = (this.race.speed && this.race.speed.walk) || 30;
		const heavy = this.armorChoice.armor && this.armorChoice.armor.type === 'heavy';
		const unarmored = !this.armorChoice.armor && !this.shield;
		const other = {};
		for (const f of this.activeFeatures) {
			if (f.speed && f.speed.allModes && !heavy) walk += parseInt(f.speed.allModes, 10) || 0;
			if (/unarmored movement/i.test(f.name) && unarmored) {
				const add = Array.isArray(f.additional) ? f.additional[this.level - 1] : '';
				walk += parseInt(String(add).replace('+', ''), 10) || 0;
			}
		}
		for (const f of this.activeFeatures) {
			for (const [mode, v] of Object.entries(f.speed || {})) {
				if (mode !== 'allModes' && v && v.spd === 'walk') other[mode] = walk;
			}
		}
		return { walk, other };
	}

	senses() {
		const out = [];
		for (const s of [...(this.race.senses || []), ...this.activeFeatures.flatMap((f) => f.senses || [])]) {
			out.push(`${s.name.toLowerCase()} ${s.range} ft.`);
		}
		const perception = this.skills.get('Perception');
		const pp = 10 + this.mods.Wis + (perception ? this.prof * (perception.expertise ? 2 : 1) : 0);
		out.push(`passive Perception ${pp}`);
		return out;
	}

	resistances() {
		const res = new Set();
		const immune = new Set();
		const condImmune = new Set();
		for (const r of [...(this.race.damageResistances || []), ...((this.variant && this.variant.damageResistances) || [])]) res.add(r.toLowerCase());
		for (const f of this.activeFeatures) {
			for (const r of f.damageResistances || []) if (!/\(/.test(r)) res.add(r.toLowerCase());
			for (const i of (f.saveNotes && f.saveNotes.immune) || []) {
				if (/poison/i.test(i)) { immune.add('poison'); condImmune.add('poisoned'); } else condImmune.add(i.toLowerCase());
			}
		}
		return { res: [...res], immune: [...immune], condImmune: [...condImmune] };
	}

	// Resolves [MON]/[STR ATK]/[DEX 1D8] tokens unless the caller asked to keep them.
	finalizeTokens(obj, shortName) {
		if (this.keepTokens) return obj;
		const json = JSON.stringify(obj).replace(/\[MON\]/g, shortName);
		return JSON.parse(json);
	}

	assemble() {
		const { res, immune, condImmune } = this.resistances();
		const speed = this.speeds();
		const sub = this.sub ? this.sub.fullName || this.sub.name : undefined;
		const raceName = titleCase(this.race.name);
		const c = this.caster;
		const spellAbility = c ? c.ability : undefined;
		const skillAbility = (name) => this.d.skills.find((s) => s.name === name).ability;

		const companion = {
			Name: `${raceName} ${sub || this.cls.name}`,
			Level: this.level,
			Race: this.variant ? titleCase(this.variant.name) : raceName,
			Class: this.cls.name,
			Subclass: sub || null,
			Build: this.build.name,
			Background: this.background ? this.background.name : null,
			Alignment: this.alignment,
			Seed: this.seed,
			Size: this.race.size,
			HitPoints: this.hitPoints(),
			Armor: this.armorText(),
			Speed: speed.walk,
			...(Object.keys(speed.other).length ? { Speeds: speed.other } : {}),
			Stats: Object.fromEntries(ABILITIES.map((a) => [a, this.scores[a]])),
			SavingThrows: ABILITIES.filter((a) => this.saves.has(a)).map((a) => ({ [a]: this.mods[a] + this.prof })),
			Skills: [...this.skills.entries()].sort(([a], [b]) => a.localeCompare(b))
				.map(([name, s]) => ({ [name]: this.mods[skillAbility(name)] + this.prof * (s.expertise ? 2 : 1) })),
			'Proficiency Bonus': this.prof,
			DamageVulnerabilities: [],
			DamageResistances: res,
			DamageImmunities: immune,
			ConditionImmunities: condImmune,
			Languages: [...this.languages],
			Senses: this.senses(),
			Abilities: this.entries.Abilities,
			Actions: this.entries.Actions,
			BonusActions: this.entries.BonusActions,
			Reactions: this.entries.Reactions,
			Spellcasting: {
				SpellcastingAbility: spellAbility || null,
				SpellSaveDC: spellAbility ? 8 + this.prof + this.mods[spellAbility] + this.spellDCBonus() : null,
				SpellAttackBonus: spellAbility ? this.prof + this.mods[spellAbility] + this.spellAttackBonus() : null,
				SpellSlots: c ? Object.entries(c.slots).filter(([, n]) => n > 0).map(([lvl, n]) => ({ [lvl]: n })) : [],
				Spells: this.spellGroups || [],
				...(this.innate.length ? { InnateSpells: this.innate.map((s) => ({ [s.name]: s.frequency })) } : {}),
			},
			Equipment: this.equipment,
		};
		if (this.background) {
			const b = this.background;
			companion.Personality = {
				Trait: this.rng.pick(b.personalityTraits || []) || null,
				Ideal: (this.rng.pick(b.ideals || []) || {}).desc || null,
				Bond: this.rng.pick(b.bonds || []) || null,
				Flaw: this.rng.pick(b.flaws || []) || null,
			};
		}
		const pets = this.pets();
		if (pets.length) companion.Companions = pets;
		this.decorate(companion);
		return this.finalizeTokens(companion, this.shortName());
	}

	// Last-minute additions to the output object before tokens are resolved (subclasses use this).
	decorate() {}

	// What [MON] becomes in the text: "the wizard".
	shortName() {
		return this.cls.name.toLowerCase();
	}
}

function generateCompanion(options = {}, data = loadData()) {
	return new CompanionBuilder(options, data).build();
}

// ---------------------------------------------------------------------------------------------
// Plain-text statblock
// ---------------------------------------------------------------------------------------------

function renderText(c) {
	const out = [];
	const strip = (s) => String(s).replace(/_/g, '').replace(/\n\n> /g, '\n  ').replace(/\n> /g, '\n  ');
	const kv = (arr) => arr.map((o) => Object.entries(o).map(([k, v]) => `${k} ${typeof v === 'number' ? signed(v) : v}`)[0]).join(', ');
	const section = (title, arr) => {
		if (!arr || !arr.length) return;
		if (title) out.push('', title.toUpperCase(), '-'.repeat(title.length));
		for (const o of arr) for (const [k, v] of Object.entries(o)) out.push(`${k}. ${strip(v)}`);
	};
	out.push(c.Name.toUpperCase());
	out.push(`${c.Size} humanoid (${c.Race.toLowerCase()}), ${c.Alignment.toLowerCase()}`);
	out.push(`Level ${c.Level} ${c.Class}${c.Subclass ? ` (${c.Subclass})` : ''} — ${c.Build} build${c.Background ? `, ${c.Background} background` : ''}  [seed: ${c.Seed}]`);
	out.push('');
	out.push(`Armor Class ${c.Armor}`);
	out.push(`Hit Points ${c.HitPoints}`);
	out.push(`Speed ${c.Speed} ft.${c.Speeds ? ', ' + Object.entries(c.Speeds).map(([m, v]) => `${m} ${v} ft.`).join(', ') : ''}`);
	out.push('');
	out.push(ABILITIES.map((a) => `${a.toUpperCase()} ${c.Stats[a]} (${signed(mod(c.Stats[a]))})`).join('  '));
	out.push('');
	if (c.SavingThrows.length) out.push(`Saving Throws ${kv(c.SavingThrows)}`);
	if (c.Skills.length) out.push(`Skills ${kv(c.Skills)}`);
	if (c.DamageResistances.length) out.push(`Damage Resistances ${c.DamageResistances.join(', ')}`);
	if (c.DamageImmunities.length) out.push(`Damage Immunities ${c.DamageImmunities.join(', ')}`);
	if (c.ConditionImmunities.length) out.push(`Condition Immunities ${c.ConditionImmunities.join(', ')}`);
	out.push(`Senses ${c.Senses.join(', ')}`);
	out.push(`Languages ${c.Languages.join(', ') || '—'}`);
	out.push(`Proficiency Bonus ${signed(c['Proficiency Bonus'])}`);
	if (c.Tools && c.Tools.length) out.push(`Tools ${c.Tools.join(', ')}`);
	if (c.Equipment && c.Equipment.length) out.push(`Equipment ${c.Equipment.join(', ')}`);
	if (c.MagicItems && c.MagicItems.length) out.push(`Magic Items ${c.MagicItems.map((o) => Object.entries(o).map(([k, v]) => `${k} (${v})`)[0]).join(', ')}`);
	section('', c.Abilities);
	section('Actions', c.Actions);
	section('Bonus Actions', c.BonusActions);
	section('Reactions', c.Reactions);
	if (c.Notes && c.Notes.length) out.push('', ...c.Notes.map((n) => `Note: ${n}`));
	if (c.Personality) {
		out.push('', 'PERSONALITY', '-----------');
		for (const [k, v] of Object.entries(c.Personality)) if (v) out.push(`${k}: ${v}`);
	}
	for (const pet of c.Companions || []) {
		out.push('', `${pet.Role.toUpperCase()}: ${pet.Name.toUpperCase()}`, `${pet.Size} ${pet.Type.toLowerCase()}`);
		out.push(`Armor Class ${pet.Armor}  Hit Points ${pet.HitPoints}  Speed ${pet.SpeedText}`);
		out.push(ABILITIES.map((a) => `${a.toUpperCase()} ${pet.Stats[a]} (${signed(mod(pet.Stats[a]))})`).join('  '));
		if (pet.Skills.length) out.push(`Skills ${kv(pet.Skills)}`);
		out.push(`Senses ${pet.Senses.join(', ')}`);
		section('', pet.Abilities);
		section('Actions', pet.Actions);
	}
	return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const HELP = `Random companion generator

Usage: node Generators/CharacterGenerator/generateCharacter.js [level] [options]

  -l, --level <1-20>      Character level (required)
  -c, --class <name>      Class (default: random)
      --subclass <name>   Subclass (default: random once the class has one)
  -r, --race <name>       Race (default: random)
      --variant <name>    Race variant, e.g. dragonborn colour
      --build <name>      Build from BuildHints.json, e.g. "Archer"
      --background <name> Background from Data/Backgrounds/Backgrounds.json (default: generic)
      --alignment <text>  Alignment (default: random)
      --stats <method>    standard (default) or roll (4d6 drop lowest)
      --feat-chance <0-1> Chance to take a feat instead of an ASI (default from BuildHints.json)
  -s, --seed <text>       Seed for reproducible results
  -n, --count <n>         Generate several companions
      --keep-tokens       Keep [MON], [STR ATK], [DEX 1D8] tokens instead of resolving them
  -f, --format <fmt>      json (default), text, or both
  -o, --out <file>        Write JSON to a file instead of stdout
      --list              List available races, classes, subclasses and builds
  -h, --help              Show this help`;

function parseArgs(argv) {
	const opts = { format: 'json', count: 1 };
	const alias = { l: 'level', c: 'class', r: 'race', s: 'seed', n: 'count', f: 'format', o: 'out', h: 'help' };
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
		class: opts.class, subclass: opts.subclass, race: opts.race, raceVariant: opts.variant, build: opts.build,
		background: opts.background, alignment: opts.alignment, stats: opts.stats, seed: opts.seed,
		featChance: opts['feat-chance'], keepTokens: !!opts['keep-tokens'],
		count: Number(opts.count) || 1, format: opts.format, out: opts.out, list: opts.list, help: opts.help,
	};
}

function listOptions(d) {
	const lines = [];
	lines.push('Races: ' + d.races.map((r) => r.name + (r.variants ? ` (${r.variants.map((v) => v.key.split('-')[1]).join('/')})` : '')).join(', '));
	for (const c of d.classes) {
		const subs = d.subclasses.filter((s) => s.class === c.key).map((s) => s.name);
		const builds = (d.hints.classes[c.key] || { builds: [] }).builds.map((b) => b.name);
		lines.push(`${c.name}: subclasses [${subs.join(', ')}] from level ${c.subclassLevel}; builds [${builds.join(', ')}]`);
	}
	lines.push('Backgrounds: ' + d.backgrounds.map((b) => b.name).join(', '));
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
	const data = loadData();
	if (args.list) return console.log(listOptions(data));
	if (!args.level) {
		console.error('Please give a level, e.g. --level 5\n\n' + HELP);
		process.exit(1);
	}
	const results = [];
	try {
		for (let i = 0; i < args.count; i++) {
			const seed = args.seed != null ? (args.count > 1 ? `${args.seed}-${i + 1}` : args.seed) : undefined;
			results.push(generateCompanion({ ...args, seed }, data));
		}
	} catch (e) {
		console.error(e.message);
		process.exit(1);
	}
	const json = JSON.stringify(results.length === 1 ? results[0] : results, null, 4);
	if (args.out) {
		fs.writeFileSync(args.out, json + '\n');
		console.error(`Wrote ${results.length} companion(s) to ${args.out}`);
	}
	if (args.format === 'text' || args.format === 'both') console.log(results.map(renderText).join('\n\n' + '='.repeat(60) + '\n\n'));
	if (!args.out && (args.format === 'json' || args.format === 'both')) console.log(json);
}

if (require.main === module) main();
module.exports = {
	generateCompanion, loadData, renderText, thirdPerson, prose, Rng, parseArgs, CompanionBuilder,
	ABILITIES, ABILITY_FULL, SPELL_LEVELS, findEntry, mod, signed, titleCase, ordinal, avgDice, listJoin, spellLevelNumber, readJson,
};
