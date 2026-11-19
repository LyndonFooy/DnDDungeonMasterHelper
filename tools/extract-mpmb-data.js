#!/usr/bin/env node
/*
 * Converts the list data embedded in MPMB's Character Record Sheet into JSON documents.
 *
 * Step 1 (Python, needs pypdf): pull the document-level JavaScript out of the PDF
 *     python tools/extract_pdf_js.py "DataInspo/MPMB's Character Record Sheet ....pdf" build/mpmb-js
 * Step 2 (this script): evaluate the list scripts in a sandbox and write normalized JSON
 *     node tools/extract-mpmb-data.js build/mpmb-js Data
 *
 * The MPMB objects contain Acrobat-specific functions (calcChanges, eval, prereqeval, ...).
 * Those are dropped; where a function only carries data (usagescalc, prerequisites in option
 * names) the data is parsed into plain fields instead.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ABILITIES = ['Str', 'Dex', 'Con', 'Int', 'Wis', 'Cha'];
const ABILITY_NAMES = { strength: 'Str', dexterity: 'Dex', constitution: 'Con', intelligence: 'Int', wisdom: 'Wis', charisma: 'Cha' };
const SIZES = ['Gargantuan', 'Huge', 'Large', 'Medium', 'Small', 'Tiny'];
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, any: 1 };
const SPELL_LEVEL_NAMES = ['Cantrip', '1st-level', '2nd-level', '3rd-level', '4th-level', '5th-level', '6th-level', '7th-level', '8th-level', '9th-level'];
const LIST_FILES = ['Lists.js', 'ListsSources.js', 'ListsClasses.js', 'ListsRaces.js', 'ListsBackgrounds.js', 'ListsFeats.js',
	'ListsGear.js', 'ListsSpells.js', 'ListsCompanions.js', 'ListsCreatures.js', 'ListsMagicItems.js'];

// ---------------------------------------------------------------------------------------------
// Sandbox loading
// ---------------------------------------------------------------------------------------------

// Stands in for any Acrobat API or sheet function the list files touch at load time.
const STUB = new Proxy(function () {}, {
	get: (t, k) => (k === Symbol.toPrimitive ? () => '' : STUB),
	apply: () => STUB,
});

// Also used to move runtime-sandbox data into this realm: the sheet's setPrototypes() replaces
// Array.prototype.find (and friends) inside the sandbox with string-like versions.
function deepCopy(o) {
	if (typeof o !== 'object' || o === null || Object.prototype.toString.call(o) === '[object RegExp]') return o;
	if (Array.isArray(o)) return Array.from(o, deepCopy); // Array.from (not o.map) so the copy is a host-realm array
	const r = {};
	for (const k in o) r[k] = deepCopy(o[k]);
	return r;
}

function loadMpmb(jsDir) {
	const ctx = {
		desc: (arr, joinStr) => {
			joinStr = joinStr || '\n   ';
			return Array.isArray(arr) ? joinStr + arr.join(joinStr) : joinStr + arr;
		},
		toUni: (s) => String(s),
		What: () => '',
		newObj: (o) => (typeof o === 'string' ? o : deepCopy(o)),
		tDoc: STUB,
		app: STUB,
	};
	vm.createContext(ctx);
	for (const file of LIST_FILES) {
		const src = fs.readFileSync(path.join(jsDir, file), 'utf8');
		for (let attempt = 0; ; attempt++) {
			try {
				vm.runInContext(src, ctx, { filename: file });
				break;
			} catch (e) {
				const missing = /^(\w+) is not defined/.exec(e.message);
				if (!missing || attempt > 100) throw new Error(`${file}: ${e.message}`);
				ctx[missing[1]] = STUB;
			}
		}
	}
	return ctx;
}

// Acrobat runs SpiderMonkey-era JavaScript; these shims give the sandbox the two behaviours the
// sheet and its add-ons rely on: toSource() and ES3-style replace callbacks ("" for unmatched groups).
const ACROBAT_SHIMS = `(function () {
	function src(v, seen) {
		if (v === null) return "null";
		if (v === undefined) return "undefined";
		var t = typeof v;
		if (t === "function") return "(" + Function.prototype.toString.call(v) + ")";
		if (t === "string") return JSON.stringify(v);
		if (t === "number" || t === "boolean") return String(v);
		if (v instanceof RegExp) return String(v);
		if (v instanceof String || v instanceof Number || v instanceof Boolean) return src(v.valueOf(), seen);
		if (seen.indexOf(v) !== -1) return "{}";
		seen.push(v);
		var out = Array.isArray(v)
			? "[" + v.map(function (x) { return src(x, seen); }).join(", ") + "]"
			: "({" + Object.keys(v).map(function (k) { return JSON.stringify(k) + ":" + src(v[k], seen); }).join(", ") + "})";
		seen.pop();
		return out;
	}
	Object.defineProperty(Object.prototype, "toSource", { value: function () { return src(this, []); }, enumerable: false, writable: true, configurable: true });
	var replace = String.prototype.replace;
	String.prototype.replace = function (pattern, fn) {
		if (typeof fn !== "function") return replace.call(this, pattern, fn);
		return replace.call(this, pattern, function () {
			var args = [];
			for (var i = 0; i < arguments.length; i++) args.push(arguments[i] === undefined ? "" : arguments[i]);
			return fn.apply(this, args);
		});
	};
})();`;
const NEW_OBJ = 'newObj = function cl(o) { if (typeof o !== "object" || o === null || o instanceof RegExp) return o; if (Array.isArray(o)) return o.map(cl); var r = {}; for (var k in o) r[k] = cl(o[k]); return r; };';

// Recreates the sheet's runtime state the way Acrobat does: base lists, InitiateLists(), then every
// imported add-on script run through the sheet's own import helpers (AddSubClass, AddFeatureChoice, ...).
// The resulting FeatsList, ClassList, RaceList, ... include all add-on content.
function loadRuntime(jsDir, addonScripts) {
	const files = ['Functions0.js', ...LIST_FILES, 'ListsPsionics.js', 'FunctionsImport.js'];
	const stubs = new Set();
	for (let attempt = 0; attempt < 100; attempt++) {
		const ctx = { What: () => '', app: STUB, console: { println() {} }, getField: () => STUB, event: {} };
		// Reads of Acrobat document properties fall back to stubs; writes (InitiateLists) land on the global.
		ctx.tDoc = new Proxy(ctx, { get: (t, k) => (k in t ? t[k] : STUB), set: (t, k, v) => { t[k] = v; return true; } });
		for (const s of stubs) ctx[s] = STUB;
		vm.createContext(ctx);
		const run = (code, name) => vm.runInContext(code, ctx, { filename: name });
		try {
			run(ACROBAT_SHIMS, 'acrobat-shims');
			for (const file of files) {
				if (!fs.existsSync(path.join(jsDir, file))) continue;
				run(fs.readFileSync(path.join(jsDir, file), 'utf8').replace(/^var tDoc = this;/m, ''), file);
				if (file === 'Functions0.js') run(NEW_OBJ, 'newObj');
			}
			run('setPrototypes(); InitiateLists(); sheetVersion = 13002000;', 'init');
			for (const [name, code] of Object.entries(addonScripts || {})) run(code, name);
			return ctx;
		} catch (e) {
			const missing = /^(\w+) is not defined/.exec((e && e.message) || '');
			if (!missing) throw new Error(`Running the sheet runtime failed: ${(e && e.message) || e}`);
			stubs.add(missing[1]);
		}
	}
	throw new Error('Running the sheet runtime failed: too many missing globals');
}

// The imported add-ons are stored in the sheet as a toSource() object literal: { fileName: scriptText }.
function readStoredField(pdfDir, field) {
	const file = path.join(pdfDir, 'fields', `${field}.txt`);
	if (!fs.existsSync(file)) return undefined;
	return vm.runInNewContext(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------------------------

const isRegExp = (v) => Object.prototype.toString.call(v) === '[object RegExp]';
const isFn = (v) => typeof v === 'function';

function sourceString(source) {
	if (!Array.isArray(source) || !source.length) return undefined;
	const pick = source.find((s) => s[0] === 'SRD') || source[0];
	return pick[1] ? `${pick[0]} ${pick[1]}` : String(pick[0]);
}

function cleanText(s) {
	if (s === undefined || s === null || isFn(s)) return undefined;
	if (Array.isArray(s)) s = s.join('\n');
	return String(s).split(/\n\s*/).map((l) => l.trim()).filter(Boolean).join('\n');
}

// MPMB writes terse lines without end punctuation; turn them into sentences.
function linesToProse(text) {
	if (!text) return text;
	return text.split('\n').map((l) => l.trim()).filter(Boolean)
		.map((l) => (/[.!?:;,]$/.test(l) ? l : l + '.')).join(' ');
}

function abilityFromIndex(i) {
	return typeof i === 'number' && i >= 1 && i <= 6 ? ABILITIES[i - 1] : undefined;
}

function scoresToObject(scores) {
	const out = {};
	if (!Array.isArray(scores)) return out;
	ABILITIES.forEach((a, i) => { if (scores[i]) out[a] = scores[i]; });
	return out;
}

// Removes undefined values, empty arrays and empty objects so the JSON stays tidy.
function prune(o) {
	if (Array.isArray(o)) return o.map(prune).filter((v) => v !== undefined);
	if (typeof o !== 'object' || o === null) return o;
	const r = {};
	for (const [k, v] of Object.entries(o)) {
		const p = prune(v);
		if (p === undefined || isFn(p)) continue;
		if (Array.isArray(p) && !p.length) continue;
		if (typeof p === 'object' && !Array.isArray(p) && p !== null && !Object.keys(p).length) continue;
		r[k] = p;
	}
	return r;
}

// Copies plain data (no functions / regexps) for keys we don't specifically normalize.
function plain(v) {
	if (isFn(v) || isRegExp(v)) return undefined;
	if (Array.isArray(v)) return v.map(plain).filter((x) => x !== undefined);
	if (typeof v === 'object' && v !== null) {
		const r = {};
		for (const [k, x] of Object.entries(v)) {
			const p = plain(x);
			if (p !== undefined) r[k] = p;
		}
		return r;
	}
	return v;
}

function parseSkillChoice(txt) {
	if (!txt) return undefined;
	let m = /Choose (\w+) from (.+)$/i.exec(txt);
	if (m) {
		const from = m[2].replace(/\.$/, '').split(/,\s*(?:and |or )?|\s+(?:and|or)\s+/).map((s) => s.trim()).filter(Boolean);
		return { count: NUMBER_WORDS[m[1].toLowerCase()] || Number(m[1]) || 1, from };
	}
	m = /Choose any (\w+) skills?/i.exec(txt);
	if (m) return { count: NUMBER_WORDS[m[1].toLowerCase()] || 1, from: 'any' };
	return { text: txt };
}

function normalizeActions(action) {
	if (!action) return undefined;
	const list = Array.isArray(action[0]) ? action : [action];
	return list.map(([type, note]) => prune({ type, note: note ? String(note).trim() : undefined }));
}

// "event.value = Math.max(1, What('Cha Mod'));"  ->  { ability: "Cha", min: 1 }
function parseUsagesCalc(calc) {
	if (typeof calc !== 'string') return undefined;
	const ab = /What\('(\w+) Mod'\)/.exec(calc);
	if (!ab) return undefined;
	const min = /Math\.max\((\d+)/.exec(calc);
	const plus = /(\d+)\s*\+\s*What/.exec(calc);
	return prune({ ability: ab[1], plus: plus ? Number(plus[1]) : undefined, min: min ? Number(min[1]) : undefined });
}

// "(prereq: level 9 warlock, Pact of the Blade)" -> { level: 9, features: ["Pact of the Blade"] }
function parsePrereq(choiceName) {
	const m = /\(prereq:\s*([^)]+)\)/i.exec(choiceName);
	if (!m) return undefined;
	const out = { text: m[1] };
	for (const part of m[1].split(/,\s*/)) {
		let p;
		if ((p = /level (\d+)/i.exec(part))) out.level = Number(p[1]);
		else if ((p = /^(.+) cantrip$/i.exec(part))) (out.spells = out.spells || []).push(p[1]);
		else (out.features = out.features || []).push(part);
	}
	return out;
}

function normalizeSpellcastingBonus(sb) {
	if (!sb) return undefined;
	return (Array.isArray(sb) ? sb : [sb]).map((b) => prune({
		name: b.name,
		class: b.class,
		spells: b.spells,
		spellLevels: b.level,
		times: b.times,
		frequency: b.firstCol === 'atwill' ? 'at will' : b.firstCol === 'oncelr' ? '1/long rest' : b.firstCol === 'oncesr' ? '1/short rest' : undefined,
	}));
}

function mechanicsNotes(calcChanges) {
	if (!calcChanges || typeof calcChanges !== 'object') return undefined;
	const notes = [];
	for (const v of Object.values(calcChanges)) {
		if (Array.isArray(v) && typeof v[1] === 'string' && v[1].trim() && !notes.includes(v[1].trim())) notes.push(v[1].trim());
	}
	return notes;
}

// ---------------------------------------------------------------------------------------------
// Features (class, subclass, race) and their choice options
// ---------------------------------------------------------------------------------------------

const FEATURE_SKIP = new Set(['regExpSearch', 'eval', 'removeeval', 'changeeval', 'prereqeval', 'spellChanges', 'spellFirstColTitle',
	'choicesNotInMenu', 'selectNow', 'calcChanges', 'source', 'name', 'minlevel', 'description', 'descriptionFull', 'additional', 'usages',
	'usagescalc', 'recovery', 'action', 'dmgres', 'savetxt', 'armorOptions', 'speed', 'vision', 'scores', 'scoresMaximum', 'saves',
	'skillstxt', 'skills', 'spellcastingBonus', 'spellcastingExtra', 'extraLimitedFeatures', 'choices', 'extrachoices', 'extraname',
	'extraTimes', 'autoSelectExtrachoices', 'choiceDependencies', 'dependentChoices', 'prerequisite', 'submenu', 'limfeaname',
	'languageProfs', 'armorProfs', 'weaponProfs', 'toolProfs', 'advantages', 'addMod', 'weaponOptions', 'weaponsAdd', 'armorAdd']);

function normalizeFeatureBody(f, key) {
	const body = {
		key,
		name: f.name,
		limitedFeatureName: f.limfeaname,
		source: sourceString(f.source),
		level: f.minlevel,
		description: cleanText(f.description),
		descriptionFull: cleanText(f.descriptionFull),
		additional: Array.isArray(f.additional) ? f.additional.map(String) : f.additional,
		usages: f.usages,
		usagesFormula: parseUsagesCalc(f.usagescalc),
		recovery: f.recovery,
		actions: normalizeActions(f.action),
		damageResistances: Array.isArray(f.dmgres) ? f.dmgres.map((d) => (Array.isArray(d) ? d[1] || d[0] : d)) : undefined,
		saveNotes: f.savetxt ? prune({ text: f.savetxt.text, immune: f.savetxt.immune, advantageVs: f.savetxt.adv_vs }) : undefined,
		armorOptions: Array.isArray(f.armorOptions) ? f.armorOptions.map((a) => prune({ name: a.name, ac: a.ac, dex: a.dex })) : undefined,
		speed: plain(f.speed),
		senses: Array.isArray(f.vision) ? f.vision.map((v) => ({ name: v[0], range: v[1] })) : undefined,
		abilityScoreIncrease: Array.isArray(f.scores) ? scoresToObject(f.scores) : undefined,
		abilityScoreMaximum: Array.isArray(f.scoresMaximum) ? scoresToObject(f.scoresMaximum) : undefined,
		savingThrows: f.saves,
		skills: f.skills,
		skillChoice: parseSkillChoice(typeof f.skillstxt === 'string' ? f.skillstxt : f.skillstxt && f.skillstxt.primary),
		languages: f.languageProfs,
		armorProficiencies: f.armorProfs,
		weaponProficiencies: f.weaponProfs,
		toolProficiencies: plain(f.toolProfs),
		advantages: plain(f.advantages),
		spellcastingBonus: normalizeSpellcastingBonus(f.spellcastingBonus),
		spellcastingExtra: f.spellcastingExtra,
		extraLimitedFeatures: Array.isArray(f.extraLimitedFeatures)
			? f.extraLimitedFeatures.map((e) => prune({ name: e.name, usages: e.usages, recovery: e.recovery }))
			: undefined,
		prerequisite: f.prerequisite,
		submenu: f.submenu,
		dependentChoices: f.dependentChoices,
		mechanicsNotes: mechanicsNotes(f.calcChanges),
	};
	return body;
}

function normalizeOption(f, choiceName, key) {
	const opt = normalizeFeatureBody(f, key);
	opt.name = f.name || choiceName.replace(/\s*\(prereq:[^)]*\)/i, '');
	opt.prerequisites = parsePrereq(choiceName);
	return opt;
}

function normalizeFeature(f, key, warnings, owner) {
	const out = normalizeFeatureBody(f, key);
	if (Array.isArray(f.choices)) {
		out.choices = f.choices.map((c) => {
			const k = c.toLowerCase();
			if (!f[k]) warnings.push(`${owner}/${key}: missing option object for choice "${c}"`);
			return normalizeOption(f[k] || { name: c }, c, k);
		});
	}
	if (Array.isArray(f.extrachoices)) {
		out.extraChoices = {
			name: f.extraname,
			timesPerLevel: Array.isArray(f.extraTimes) ? f.extraTimes : undefined,
			times: !Array.isArray(f.extraTimes) ? f.extraTimes : undefined,
			autoSelect: Array.isArray(f.autoSelectExtrachoices)
				? f.autoSelectExtrachoices.map((a) => prune({ option: a.extrachoice, level: a.minlevel }))
				: undefined,
			options: f.extrachoices.map((c) => {
				const k = c.toLowerCase();
				if (!f[k]) warnings.push(`${owner}/${key}: missing option object for extra choice "${c}"`);
				return normalizeOption(f[k] || { name: c }, c, k);
			}),
		};
	}
	// Options that are granted automatically (Monk's Flurry of Blows, Ranger's Travel Benefits, ...).
	// Their objects usually live on the same feature but outside any extrachoices list.
	const autoKeys = new Set();
	if (Array.isArray(f.autoSelectExtrachoices)) {
		out.autoChoices = f.autoSelectExtrachoices.map((a) => {
			const k = a.extrachoice;
			autoKeys.add(k);
			const obj = f[k];
			if (!obj) return prune({ option: k, level: a.minlevel });
			return prune({ ...normalizeOption(obj, obj.name || k, k), level: a.minlevel || f.minlevel });
		});
		if (out.extraChoices) delete out.extraChoices.autoSelect;
	}
	if (Array.isArray(f.choiceDependencies)) {
		out.choiceDependencies = f.choiceDependencies.map((d) => prune({ feature: d.feature, choiceAttribute: d.choiceAttribute }));
	}
	// Keep any other plain-data keys MPMB added that we haven't mapped (future-proofing).
	for (const [k, v] of Object.entries(f)) {
		if (FEATURE_SKIP.has(k) || out[k] !== undefined || autoKeys.has(k)) continue;
		if (Array.isArray(f.choices) && f.choices.some((c) => c.toLowerCase() === k)) continue;
		if (Array.isArray(f.extrachoices) && f.extrachoices.some((c) => c.toLowerCase() === k)) continue;
		const p = plain(v);
		if (p !== undefined) out[k] = p;
	}
	return prune(out);
}

// ---------------------------------------------------------------------------------------------
// Classes & subclasses
// ---------------------------------------------------------------------------------------------

function normalizeClass(key, c, subList, warnings) {
	const asiLevels = [];
	(c.improvements || []).forEach((n, i) => { if (i > 0 && n > c.improvements[i - 1]) asiLevels.push(i + 1); });
	const subKeys = (c.subclasses && c.subclasses[1]) || [];
	const subLevels = subKeys.flatMap((sk) => Object.values((subList[sk] || {}).features || {}).map((f) => f.minlevel));
	const armor = (c.armorProfs && c.armorProfs.primary) || [false, false, false, false];
	const weapons = (c.weaponProfs && c.weaponProfs.primary) || [false, false];

	let spellcasting;
	if (c.spellcastingFactor) {
		const factor = c.spellcastingFactor;
		const known = c.spellcastingKnown || {};
		const progression = factor === 1 ? 'full' : factor === 2 ? 'half' : factor === 3 ? 'third' : /warlock/.test(factor) ? 'pact' : String(factor);
		spellcasting = prune({
			ability: abilityFromIndex(c.abilitySave),
			progression,
			factor: typeof factor === 'number' ? factor : 1,
			cantripsKnown: known.cantrips,
			spellsKnown: Array.isArray(known.spells) ? known.spells : undefined,
			preparation: known.spells === 'list' ? 'prepared' : known.spells === 'book' ? 'spellbook' : 'known',
			// Prepared casters prepare (ability modifier + class level / factor) spells, minimum 1.
			preparedFormula: known.prepared ? { ability: abilityFromIndex(c.abilitySave), levelDivisor: typeof factor === 'number' ? factor : 1, min: 1 } : undefined,
			spellList: plain(c.spellcastingList),
		});
	}

	return prune({
		key,
		name: c.name,
		source: sourceString(c.source),
		primaryAbility: c.primaryAbility,
		multiclassPrerequisite: c.prereqs,
		hitDie: c.die,
		savingThrows: c.saves,
		saveDCAbility: abilityFromIndex(c.abilitySave),
		skillChoice: parseSkillChoice(c.skillstxt && c.skillstxt.primary),
		armorProficiencies: ['light', 'medium', 'heavy', 'shields'].filter((_, i) => armor[i]),
		weaponProficiencies: prune({ simple: !!weapons[0], martial: !!weapons[1], specific: Array.isArray(weapons[2]) ? weapons[2] : undefined }),
		toolProficiencies: c.toolProfs && c.toolProfs.primary
			? c.toolProfs.primary.map((t) => (Array.isArray(t) ? (typeof t[1] === 'number' ? { choose: t[1], from: t[0] } : t[0]) : t))
			: undefined,
		asiLevels,
		attacksPerLevel: c.attacks,
		subclassTitle: c.subclasses && c.subclasses[0],
		subclassLevel: subLevels.length ? Math.min(...subLevels) : undefined,
		subclasses: subKeys,
		spellcasting,
		startingEquipment: cleanText(c.equipment),
		features: Object.entries(c.features || {})
			.map(([fk, f]) => normalizeFeature(f, fk, warnings, key))
			.sort((a, b) => (a.level || 0) - (b.level || 0)),
	});
}

function normalizeSubclass(key, s, warnings) {
	return prune({
		key,
		class: key.split('-')[0],
		name: s.subname,
		fullName: s.fullname,
		source: sourceString(s.source),
		saveDCAbility: abilityFromIndex(s.abilitySave),
		spellcastingExtra: s.spellcastingExtra,
		features: Object.entries(s.features || {})
			.map(([fk, f]) => normalizeFeature(f, fk, warnings, key))
			.sort((a, b) => (a.level || 0) - (b.level || 0)),
	});
}

// ---------------------------------------------------------------------------------------------
// Races
// ---------------------------------------------------------------------------------------------

// Race trait text: first line is a header ("Hill Dwarf (+2 Constitution, +1 Wisdom)"),
// followed by "Name: description" paragraphs; other lines continue the previous trait.
function parseRaceTraits(text) {
	if (!text) return { header: undefined, traits: [] };
	const lines = String(text).split('\n');
	const header = lines.shift().trim();
	const traits = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		const m = /^([A-Z][A-Za-z' -]{1,40}):\s*(.*)$/.exec(line);
		if (m) traits.push({ name: m[1].trim(), desc: m[2].trim() });
		else if (traits.length) traits[traits.length - 1].desc = (traits[traits.length - 1].desc + ' ' + line.replace(/^-\s*/, '')).trim();
	}
	return { header, traits };
}

function normalizeWeaponOption(w) {
	return prune({
		name: w.name,
		ability: abilityFromIndex(w.ability),
		type: w.type,
		damage: normalizeDamage(w.damage),
		range: w.range,
		description: w.description,
		savingThrow: w.dc ? true : undefined,
	});
}

function normalizeRace(key, r, subList, warnings) {
	const { header, traits } = parseRaceTraits(r.trait);
	const scoreChoice = /\+(\d) to (\w+) other ability scores/i.exec(r.scorestxt || header || '');
	const languages = (r.languageProfs || []).filter((l) => typeof l === 'string');
	const extraLanguages = (r.languageProfs || []).filter((l) => typeof l === 'number').reduce((a, b) => a + b, 0);
	const variants = Object.entries(subList)
		.filter(([sk]) => sk.startsWith(key + '-'))
		.map(([sk, v]) => {
			const vt = parseRaceTraits(v.trait);
			return prune({
				key: sk,
				name: v.name,
				traitHeader: vt.header,
				traits: vt.traits,
				damageResistances: v.dmgres,
				abilityScoreIncrease: Array.isArray(v.scores) ? scoresToObject(v.scores) : undefined,
			});
		});

	return prune({
		key,
		name: r.name,
		sortName: r.sortname,
		plural: r.plural,
		source: sourceString(r.source),
		size: SIZES[r.size],
		speed: Object.fromEntries(Object.entries(r.speed || {}).map(([mode, s]) => [mode, typeof s === 'object' ? s.spd : s])),
		abilityScoreIncrease: scoresToObject(r.scores),
		abilityScoreChoice: scoreChoice ? { count: NUMBER_WORDS[scoreChoice[2].toLowerCase()] || 1, amount: Number(scoreChoice[1]) } : undefined,
		languages,
		extraLanguages: extraLanguages || undefined,
		senses: Array.isArray(r.vision) ? r.vision.map((v) => ({ name: v[0], range: v[1] })) : undefined,
		damageResistances: r.dmgres,
		saveNotes: r.savetxt ? prune({ text: r.savetxt.text, immune: r.savetxt.immune, advantageVs: r.savetxt.adv_vs }) : undefined,
		skills: r.skills,
		skillChoice: parseSkillChoice(r.skillstxt),
		weaponProficiencies: Array.isArray(r.weaponProfs) ? prune({ simple: !!r.weaponProfs[0], martial: !!r.weaponProfs[1], specific: r.weaponProfs[2] || undefined }) : undefined,
		armorProficiencies: Array.isArray(r.armorProfs) ? ['light', 'medium', 'heavy', 'shields'].filter((_, i) => r.armorProfs[i]) : undefined,
		toolProficiencies: Array.isArray(r.toolProfs) ? r.toolProfs.map((t) => (Array.isArray(t) ? (typeof t[1] === 'number' ? { choose: t[1], from: t[0] } : t[0]) : t)) : undefined,
		spellcastingAbility: abilityFromIndex(r.spellcastingAbility),
		spellcastingBonus: normalizeSpellcastingBonus(r.spellcastingBonus),
		traitHeader: header,
		traits,
		features: Object.entries(r.features || {}).map(([fk, f]) => normalizeFeature(f, fk, warnings, key)),
		attacks: Array.isArray(r.weaponOptions) ? r.weaponOptions.map(normalizeWeaponOption) : undefined,
		age: r.age && r.age.trim(),
		height: r.height && r.height.trim(),
		weight: r.weight && r.weight.trim(),
		variants,
	});
}

// ---------------------------------------------------------------------------------------------
// Backgrounds, feats
// ---------------------------------------------------------------------------------------------

function normalizeBackground(key, b, featureList) {
	const feat = featureList[(b.feature || '').toLowerCase()];
	const pairs = (arr) => (arr || []).map((i) => (Array.isArray(i) ? { name: i[0], desc: i[1] } : { desc: i }));
	return prune({
		key,
		name: b.name,
		source: sourceString(b.source),
		skills: b.skills,
		skillChoice: parseSkillChoice(b.skillstxt),
		languages: b.languageProfs,
		toolProficiencies: plain(b.toolProfs),
		gold: b.gold,
		equipment: [...(b.equipleft || []), ...(b.equipright || [])].map((e) => prune({ name: e[0], amount: e[1] === '' ? undefined : e[1], weight: e[2] === '' ? undefined : e[2] })),
		feature: feat ? prune({ name: b.feature, description: cleanText(feat.description), source: sourceString(feat.source) }) : b.feature,
		personalityTraits: b.trait,
		ideals: pairs(b.ideal),
		bonds: b.bond,
		flaws: b.flaw,
		extra: plain(b.extra),
	});
}

const ABILITY_FULL_TO_ABBR = { Strength: 'Str', Dexterity: 'Dex', Constitution: 'Con', Intelligence: 'Int', Wisdom: 'Wis', Charisma: 'Cha' };

// "4th level, Strength 13 or higher" -> { level: 4, abilityScores: { anyOf: ['Str'], minimum: 13 } }.
// Whatever isn't recognised is kept in `other`, so callers know the prerequisite isn't fully machine-checkable.
function parseFeatPrerequisite(text) {
	if (!text) return undefined;
	const out = { text };
	let rest = text;
	const take = (re, fn) => {
		rest = rest.replace(re, (...m) => { fn(m); return ' '; });
	};
	take(/(\d+)(?:st|nd|rd|th)[- ]level/i, (m) => { out.level = Number(m[1]); });
	take(/((?:Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)(?: or (?:Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma))*) (\d+) or higher/,
		(m) => { out.abilityScores = { anyOf: m[1].split(' or ').map((a) => ABILITY_FULL_TO_ABBR[a]), minimum: Number(m[2]) }; });
	take(/^Being an? (.+)$/, (m) => {
		out.races = m[1].split(/,\s*(?:or\s+)?|\s+or\s+/).map((r) => r.replace(/^an? /, '').trim()).filter(Boolean);
	});
	take(/(?:the ability to cast at least one spell|Spellcasting(?: or Pact Magic)? feature)/i, () => { out.spellcasting = true; });
	take(/Proficiency with (?:an? )?([^,;]+)/i, (m) => { out.proficiency = m[1].trim(); });
	take(/((?:\w+, )*\w+,? or \w+|\w+) Class\b/, (m) => { out.classes = m[1].split(/,\s*(?:or\s+)?|\s+or\s+/).filter(Boolean); });
	take(/Any Non-(Good|Evil) Alignment/i, (m) => { out.alignment = `non-${m[1].toLowerCase()}`; });
	take(/(\w+) Campaign/, (m) => { out.campaign = m[1]; });
	take(/([A-Z][^,;]*?) feat\b/g, (m) => { (out.feats = out.feats || []).push(m[1].trim()); });
	const other = rest.replace(/[,;]|\bplus\b/g, ' ').replace(/\s+/g, ' ').trim();
	if (other) out.other = other;
	return out;
}

// Sheet-UI or automation-only properties on feats.
const FEAT_UI_KEYS = ['calculate', 'selfChoosing', 'toNotesPage', 'spellChanges', 'allowUpCasting', 'bonusClassExtrachoices',
	'commoneval', 'commonremoveeval', 'knightlySuperiority', 'weaponOptions', 'spellcastingAbility', 'extraAC', 'scorestxt',
	'prerequisite', 'prereqeval', 'carryingCapacity'];

function normalizeFeat(key, f, warnings = [], sources = {}, hiddenSources = []) {
	const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !FEAT_UI_KEYS.includes(k)));
	const cleaned = strip(f);
	for (const c of f.choices || []) if (f[c.toLowerCase()]) cleaned[c.toLowerCase()] = strip(f[c.toLowerCase()]);
	const out = normalizeFeature(cleaned, key, warnings, 'feats');
	delete out.level;
	const srcList = (f.source || []).map(([abbr, page]) => prune({
		key: abbr,
		name: sources[abbr] && sources[abbr].name,
		abbreviation: sources[abbr] && sources[abbr].abbreviation,
		group: sources[abbr] && sources[abbr].group,
		page: page || undefined,
	}));
	// The sheet ignores source keys it doesn't define (e.g. "UA", "WGtE"), so only judge by defined ones
	const defined = srcList.some((s) => s.name) ? srcList.filter((s) => s.name) : srcList;
	return prune({
		...out,
		prerequisite: f.prerequisite,
		prerequisites: parseFeatPrerequisite(f.prerequisite),
		abilityScoreText: f.scorestxt,
		extraAC: Array.isArray(f.extraAC) ? f.extraAC.map((a) => prune({ name: a.name, mod: a.mod, text: a.text })) : undefined,
		attacks: Array.isArray(f.weaponOptions) ? f.weaponOptions.map(normalizeWeaponOption) : undefined,
		spellcastingAbility: abilityFromIndex(f.spellcastingAbility),
		sources: srcList,
		sourceName: (defined[0] || {}).name,
		unearthedArcana: defined.length && defined.every((s) => s.group === 'Unearthed Arcana') ? true : undefined,
		// The sheet's source settings hide these (it's how the drop-down got down to 105 feats)
		hiddenInSheet: defined.length && defined.every((s) => hiddenSources.includes(s.key)) ? true : undefined,
	});
}

// ---------------------------------------------------------------------------------------------
// Equipment
// ---------------------------------------------------------------------------------------------

// MPMB damage arrays: [1, 8, "slashing"], ["C", 10, "fire"] (cantrip die), [1, "", "piercing"] (flat 1)
function normalizeDamage(d) {
	if (!Array.isArray(d)) return undefined;
	const [count, die, type] = d;
	if (count === 'C' || /^C/.test(String(count))) {
		return prune({ dice: `1d${die}`, die: Number(die), type, scalesWithCantripDie: true, perBeam: /×/.test(String(count)) || undefined });
	}
	if (typeof count === 'number' && die === '') return { flat: count, type };
	if (typeof count === 'number') return { dice: `${count}d${die}`, count, die: Number(die), type };
	return prune({ special: String(count), type });
}

function normalizeArmor(key, a) {
	return prune({
		key,
		name: a.name,
		inventoryName: a.invName,
		source: sourceString(a.source),
		type: a.type || (a.list === 'magic' ? 'magic' : 'none'),
		ac: a.ac,
		addDexModifier: a.type === 'heavy' ? false : true,
		maxDexModifier: a.type === 'medium' ? 2 : undefined,
		strengthRequirement: a.strReq || undefined,
		stealthDisadvantage: a.stealthdis || undefined,
		weight: a.weight,
	});
}

function normalizeWeapon(key, w) {
	const desc = (w.description || '').trim();
	const props = desc.toLowerCase();
	const versatile = /versatile \((\d+d\d+)\)/i.exec(desc);
	const thrown = /(\d+)\/(\d+)/.exec(w.range || '');
	const save = /\b(Str|Dex|Con|Int|Wis|Cha) save\b/.exec(desc);
	const isSpell = /spell/i.test(w.list || '') || w.type === 'Cantrip';
	return prune({
		key,
		name: w.name,
		alternateNames: w.nameAlt,
		source: sourceString(w.source),
		category: w.type,
		list: w.list,
		ability: isSpell && w.ability > 2 ? 'spellcasting' : abilityFromIndex(w.ability),
		damage: normalizeDamage(w.damage),
		range: w.range,
		reach: /\breach\b/.test(props) ? 10 : (/^melee/i.test(w.range || '') ? 5 : undefined),
		rangeNormal: thrown ? Number(thrown[1]) : undefined,
		rangeLong: thrown ? Number(thrown[2]) : undefined,
		properties: desc ? desc.split(/;\s*/)[0].split(/,\s*/).filter(Boolean) : undefined,
		description: desc || undefined,
		finesse: /\bfinesse\b/.test(props) || undefined,
		light: /\blight\b/.test(props) || undefined,
		heavy: /\bheavy\b/.test(props) || undefined,
		twoHanded: /two-handed(?! when)/.test(props) || undefined,
		thrown: /\bthrown\b/.test(props) || undefined,
		loading: /\bloading\b/.test(props) || undefined,
		versatileDamage: versatile ? versatile[1] : undefined,
		ammunition: w.ammo,
		savingThrow: w.dc ? (save ? save[1] : true) : undefined,
		monkWeapon: w.monkweapon || undefined,
		addAbilityToDamage: w.abilitytodamage,
		isNotWeapon: w.isNotWeapon || undefined,
		weight: w.weight,
		special: w.special || undefined,
	});
}

function costFromInfo(info) {
	const m = /\[([\d,.]+)\s*(cp|sp|ep|gp|pp)\]/.exec(info || '');
	return m ? { amount: Number(m[1].replace(/,/g, '')), unit: m[2] } : undefined;
}

function normalizeGear(key, g) {
	return prune({ key, name: g.name, cost: costFromInfo(g.infoname), amount: g.amount === '' ? undefined : g.amount, weight: g.weight, type: g.type });
}

function normalizePack(key, p) {
	return prune({
		key,
		name: p.name,
		source: sourceString(p.source),
		cost: costFromInfo(p.infoname),
		items: (p.items || []).map((i) => prune({ name: i[0], amount: i[1] === '' ? undefined : i[1], weight: i[2] === '' ? undefined : i[2] })),
	});
}

function normalizeAmmo(key, a) {
	return prune({ key, name: a.name, source: sourceString(a.source), weight: a.weight, icon: a.icon, inventoryName: a.invName, alternateNames: a.alternatives });
}

// ---------------------------------------------------------------------------------------------
// Spells (formatted like Data/Spells/SpellsAll.json)
// ---------------------------------------------------------------------------------------------

const CASTING_TIMES = { a: 'action', bns: 'bonus action', rea: 'reaction', min: 'minute', h: 'hour' };

function expandCastingTime(t) {
	if (!t) return undefined;
	const m = /^(\d+)\s*(a|bns|rea|min|h)\b(.*)$/.exec(t);
	if (!m) return t;
	const unit = CASTING_TIMES[m[2]];
	const n = Number(m[1]);
	return `${n} ${unit}${n > 1 && (unit === 'minute' || unit === 'hour') ? 's' : ''}${m[3]}`;
}

function htmlParagraphs(text) {
	if (!text) return undefined;
	return text.split(/\n\s*/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${p}</p>`).join('');
}

function normalizeSpell(key, s, schools, atHigherLevels) {
	let full = s.descriptionFull || '';
	let higher;
	const marker = atHigherLevels && full.indexOf(atHigherLevels);
	if (atHigherLevels && marker > -1) {
		higher = full.slice(marker + atHigherLevels.length);
		full = full.slice(0, marker);
	}
	const duration = String(s.duration || '');
	return prune({
		name: s.name,
		desc: htmlParagraphs(full),
		higher_level: htmlParagraphs(higher),
		short: s.description,
		page: sourceString(s.source),
		range: s.range,
		components: (s.components || '').replace(/,/g, ', ').replace(/†/g, ''),
		material: s.compMaterial,
		ritual: s.ritual ? 'yes' : 'no',
		duration: duration.replace(/^Conc,\s*/i, 'Up to '),
		concentration: /^Conc/i.test(duration) ? 'yes' : 'no',
		casting_time: expandCastingTime(s.time),
		level: SPELL_LEVEL_NAMES[s.level],
		school: (schools[s.school] || s.school || '').replace(/^\w/, (ch) => ch.toUpperCase()),
		class: (s.classes || []).map((c) => c.charAt(0).toUpperCase() + c.slice(1)).join(', '),
		save: s.save,
	});
}

// ---------------------------------------------------------------------------------------------
// Creatures & companion templates
// ---------------------------------------------------------------------------------------------

const toMon = (s) => (typeof s === 'string' ? s.replace(/\[THIS\]/g, '[MON]') : s);
const namedList = (arr) => (Array.isArray(arr) ? arr.map((t) => prune({ name: t.name, desc: toMon(cleanText(t.description)) })) : undefined);

function normalizeCreature(key, c) {
	return prune({
		key,
		name: c.name,
		alternateNames: c.nameAlt,
		source: sourceString(c.source),
		size: SIZES[c.size],
		type: c.type,
		subtype: c.subtype,
		alignment: c.alignment,
		ac: c.ac,
		hp: c.hp,
		hitDice: Array.isArray(c.hd) ? `${c.hd[0]}d${c.hd[1]}` : c.hd,
		speed: c.speed,
		scores: Object.fromEntries(ABILITIES.map((a, i) => [a, (c.scores || [])[i]])),
		savingThrows: Array.isArray(c.saves) ? Object.fromEntries(ABILITIES.map((a, i) => [a, c.saves[i]]).filter(([, v]) => v !== '' && v !== undefined)) : undefined,
		skills: plain(c.skills),
		damageVulnerabilities: c.damage_vulnerabilities,
		damageResistances: c.damage_resistances,
		damageImmunities: c.damage_immunities,
		conditionImmunities: c.condition_immunities,
		senses: c.senses,
		passivePerception: c.passivePerception,
		languages: c.languages,
		challengeRating: c.challengeRating,
		proficiencyBonus: c.proficiencyBonus,
		attacksPerAction: c.attacksAction,
		attacks: Array.isArray(c.attacks) ? c.attacks.map((a) => prune({
			name: a.name,
			ability: abilityFromIndex(a.ability),
			damage: normalizeDamage(a.damage),
			range: a.range,
			description: toMon(a.description),
			modifiers: plain(a.modifiers),
			savingThrow: a.dc || undefined,
		})) : undefined,
		traits: namedList(c.traits),
		actions: namedList(c.actions),
		features: namedList(c.features),
		companionTypes: Array.isArray(c.companion) ? c.companion : c.companion ? [c.companion] : undefined,
		wildShape: c.wildshapeString,
		variant: plain(c.variant),
	});
}

function normalizeCompanionType(key, c) {
	const aa = c.attributesAdd || {};
	return prune({
		key,
		name: c.name,
		menuName: c.nameMenu,
		origin: c.nameOrigin,
		source: sourceString(c.source),
		masterActions: normalizeActions(c.action),
		masterNotes: Array.isArray(c.notes) ? c.notes.map((n) => linesToProse(cleanText(`${n.name}${n.joinString || ' '}${n.description}`))) : undefined,
		header: aa.header,
		addedFeatures: namedList(aa.features),
		addedTraits: namedList(aa.traits),
		addedActions: namedList(aa.actions),
		addedLanguages: aa.languages,
		addedSenses: aa.senses,
		addedDamageResistances: aa.damage_resistances,
		addedConditionImmunities: aa.condition_immunities,
	});
}

// ---------------------------------------------------------------------------------------------
// Magic items
// ---------------------------------------------------------------------------------------------

// Sheet-UI properties with no meaning outside MPMB's dialogs.
const MAGIC_ITEM_UI_KEYS = ['chooseGear', 'nameTest', 'allowDuplicates', 'toNotesPage', 'spellChanges', 'spellFirstColTitle',
	'creaturesAdd', 'creatureOptions', 'calculate', 'selfChoosing', 'applyStatBonus', 'extraTooltip', 'shieldAdd',
	'choicesNotInMenu', 'notLegalAL', 'magicItemTable', 'rarity', 'attunement', 'weight', 'type', 'nameAlt',
	'descriptionLong', 'fixedDC', 'extraAC', 'weaponOptions', 'spellcastingAbility', 'scoresOverride'];

function itemExtras(item) {
	return {
		type: item.type,
		rarity: item.rarity,
		attunement: item.attunement === true ? true : typeof item.attunement === 'string' ? item.attunement : undefined,
		dmgTable: item.magicItemTable,
		weight: item.weight,
		alternateNames: item.nameAlt,
		descriptionLong: cleanText(item.descriptionLong),
		fixedDC: item.fixedDC,
		extraAC: Array.isArray(item.extraAC) ? item.extraAC.map((a) => prune({ name: a.name, mod: a.mod, magic: a.magic, text: a.text })) : undefined,
		attacks: Array.isArray(item.weaponOptions) ? item.weaponOptions.map(normalizeWeaponOption) : undefined,
		spellcastingAbility: abilityFromIndex(item.spellcastingAbility),
		abilityScoreOverride: Array.isArray(item.scoresOverride) ? scoresToObject(item.scoresOverride) : undefined,
	};
}

function normalizeMagicItem(key, item, warnings) {
	const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !MAGIC_ITEM_UI_KEYS.includes(k)));
	const choiceKeys = (item.choices || []).map((c) => c.toLowerCase());
	const cleaned = strip(item);
	for (const k of choiceKeys) if (item[k]) cleaned[k] = strip(item[k]);
	const out = normalizeFeature(cleaned, key, warnings, 'magic-items');
	delete out.level;
	// Variant-specific rarity/table (e.g. "+1 Weapon (uncommon)") lives on each choice object
	for (const opt of out.choices || []) Object.assign(opt, prune(itemExtras(item[opt.key] || {})));
	return prune({ ...out, ...itemExtras(item), choices: out.choices });
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Small rules lists from Lists.js / AbilityScores.js
// ---------------------------------------------------------------------------------------------

function abilityScoreRules(m, jsDir) {
	const out = { abilities: AbilityScores_list(m) };
	const file = path.join(jsDir, 'AbilityScores.js');
	if (!fs.existsSync(file)) return out;
	const src = fs.readFileSync(file, 'utf8');
	const arr = /standard array is:\s*([\d,\s and]+)\./i.exec(src);
	if (arr) out.standardArray = arr[1].split(/,\s*(?:and\s+)?|\s+and\s+/).map(Number).filter(Boolean);
	const pb = /Point Buy is (\d+) points and you can't have a Score Base over (\d+)/i.exec(src);
	const fn = /function ASCalcPointBuy\([\s\S]*?\n\}/.exec(src);
	if (pb && fn) {
		// Run the sheet's own cost function rather than re-typing the table
		const ctx = {};
		vm.createContext(ctx);
		vm.runInContext(fn[0], ctx);
		const costs = {};
		for (let score = 8; score <= Number(pb[2]); score++) costs[score] = Number(ctx.ASCalcPointBuy(String(score)));
		out.pointBuy = { budget: Number(pb[1]), minScore: 8, maxScore: Number(pb[2]), costs };
	}
	return out;
}

function AbilityScores_list(m) {
	const a = m.AbilityScores || {};
	return (a.abbreviations || ABILITIES).map((abbr, i) => ({ abbreviation: abbr, name: (a.names || [])[i] }));
}

function licenses(m) {
	const toEntry = (arr) => {
		if (!Array.isArray(arr) || !arr.length) return undefined;
		return { name: String(arr[0]).trim(), text: arr.slice(1).map((l) => String(l).trim()).filter(Boolean) };
	};
	return [toEntry(m.licenseOGL), toEntry(m.licenseGPLV3)].filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Player Reference page (pdf/player-reference.txt)
// ---------------------------------------------------------------------------------------------

// Section headings follow their entries in the page's text order (except Area of Effect, at the top).
const REFERENCE_SECTIONS = [
	{ key: 'Environment', heading: /^ENVIRONMENT$/ },
	{ key: 'Attack Action', heading: /^ATTACK ACTION$/ },
	{ key: 'Conditions', heading: /^CONDITIONS$/ },
	{ key: 'Exhaustion', heading: /^EXHAUSTION\b/ },
	{ key: 'Travel Pace', heading: /^TRAVEL PACE\b/ },
	{ key: 'Cover', heading: /^COVER\b/ },
	{ key: 'Light & Vision', heading: /^LIGHT & VISION$/ },
	{ key: 'Combat Actions', heading: /^COMBAT ACTIONS$/ },
	{ key: 'Movement', heading: /^MOVEMENT\b/ },
];
const SOURCE_RE = /\((PHB|DMG) (\d+)\)/;
const TITLE_RE = /^([A-Z][A-Z0-9 /&'’\-]*[A-Z])((?:\s*\([^)]*\))*)\s*$/;

const sentenceCase = (s) => s.charAt(0) + s.slice(1).toLowerCase().replace(/\b(dex|str|con|int|wis|cha)\b/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
const joinLines = (lines) => lines.reduce((acc, l) => (acc && /[a-z]-$/.test(acc) ? acc + l : acc ? `${acc} ${l}` : l), '').replace(/\s+/g, ' ').trim();

function parseTitledEntries(lines) {
	const entries = [];
	for (const line of lines) {
		const m = TITLE_RE.exec(line);
		if (m && !/^(LEVEL|PACE) /.test(line)) {
			const parens = [...m[2].matchAll(/\(([^)]*)\)/g)].map((p) => p[1]);
			const source = parens.find((p) => /^(PHB|DMG) \d+$/.test(p));
			entries.push({ head: prune({ name: sentenceCase(m[1].trim()), timing: parens.filter((p) => p !== source).join('; ') || undefined, source }), body: [] });
		} else if (entries.length) {
			entries[entries.length - 1].body.push(line);
		}
	}
	return entries.map(({ head, body }) => ({ ...head, description: joinLines(body) }));
}

function parsePlayerReference(text) {
	const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
	const out = {};
	// Area of Effect: shape labels before the "PLAYER REFERENCE" title
	const top = lines.indexOf('PLAYER REFERENCE');
	const shapes = lines.slice(0, Math.max(top, 0)).join(' ').match(/\b(CUBE|SPHERE|CYLINDER|LINE|CONE)\b/g) || [];
	out['Area of Effect'] = { shapes: [...new Set(shapes)].map(sentenceCase), note: /Point of Origin/.test(lines.slice(0, top).join(' ')) ? 'Diagram shows each shape\'s point of origin.' : undefined };

	let buffer = [];
	for (let i = top + 1; i < lines.length; i++) {
		const line = lines[i];
		const section = REFERENCE_SECTIONS.find((s) => s.heading.test(line.replace(SOURCE_RE, '').trim()));
		if (!section) { buffer.push(line); continue; }
		let src = SOURCE_RE.exec(line);
		if (!src && SOURCE_RE.test(lines[i + 1] || '') && /^\(/.test(lines[i + 1])) src = SOURCE_RE.exec(lines[++i]);
		out[section.key] = { source: src ? `${src[1]} ${src[2]}` : undefined, lines: buffer };
		buffer = [];
	}

	const result = { 'Area of Effect': prune(out['Area of Effect']) };
	for (const { key } of REFERENCE_SECTIONS) {
		const s = out[key];
		if (!s) continue;
		const body = s.lines;
		let data;
		if (key === 'Exhaustion') {
			data = { levels: body.map((l) => /^(\d)\s+(.+)$/.exec(l)).filter(Boolean).map((m) => ({ level: Number(m[1]), effect: m[2].trim() })), cumulative: /cumulative/i.test(body.join(' ')) };
		} else if (key === 'Travel Pace') {
			data = { paces: body.map((l) => /^(Fast|Normal|Slow) (\d+) feet (\d+) miles (\d+) miles (.+)$/.exec(l)).filter(Boolean)
				.map((m) => ({ pace: m[1], perMinuteFeet: Number(m[2]), perHourMiles: Number(m[3]), perDayMiles: Number(m[4]), effect: /^[–—-]+$/.test(m[5].trim()) ? null : m[5].trim() })) };
		} else if (key === 'Cover') {
			data = { degrees: body.map((l) => /^(HALF|3\/4|TOTAL) (.+)$/.exec(l)).filter(Boolean).map((m) => ({ cover: m[1] === '3/4' ? 'Three-quarters' : sentenceCase(m[1]), effect: m[2].trim() })) };
		} else if (key === 'Light & Vision') {
			const rows = [];
			for (const l of body) {
				const m = /^([A-Z][A-Z ]+?)(?: \(([^)]+)\))? ([A-Z][a-z].*)$/.exec(l);
				if (m) rows.push(prune({ name: sentenceCase(m[1]), condition: m[2], effect: m[3].trim() }));
				else if (rows.length) rows[rows.length - 1].effect = joinLines([rows[rows.length - 1].effect, l]);
			}
			data = { entries: rows };
		} else {
			data = { entries: parseTitledEntries(body) };
		}
		result[key] = prune({ source: s.source, ...data });
	}
	return result;
}

// ---------------------------------------------------------------------------------------------
// Drop-down name catalogs (pdf/option-lists.json)
// ---------------------------------------------------------------------------------------------

// The sheet was saved with every sourcebook loaded, so its drop-downs list far more names than the
// SRD scripts contain. These catalogs are names only; `detailedIn` points to full data when we have it.
const CATALOGS = [
	{ file: 'MagicItems', field: /^Extra\.Magic Item/, detailed: 'MagicItems/MagicItems.json' },
	{ file: 'CompanionCreatures', field: /^Comp\.Race$/, detailed: 'Creatures/Creatures.json' },
	{ file: 'WildShapes', field: /^Wildshape\.Race/, detailed: 'Creatures/Creatures.json' },
	{ file: 'Races', tooltip: /^Race\b/, detailed: 'Races/Races.json' },
	{ file: 'Backgrounds', tooltip: /^Background\b/, detailed: 'Backgrounds/Backgrounds.json' },
	{ file: 'BackgroundFeatures', tooltip: /background feature/i, detailed: 'Backgrounds/Backgrounds.json' },
	{ file: 'Feats', field: /^Feat Name/, detailed: 'Feats/Feats.json' },
	{ file: 'Weapons', field: /^Attack\.\d+\.Weapon Selection$/, detailed: 'Equipment/Weapons.json' },
	{ file: 'Ammunition', tooltip: /ammunition/i, detailed: 'Equipment/Ammunition.json' },
	{ file: 'Armor', tooltip: /^Armor AC/, detailed: 'Equipment/Armor.json' },
	{ file: 'Factions', field: /^Background_Faction\.Text$/, detailed: 'Rules/Factions.json' },
	{ file: 'CreatureTypes', field: /MonsterType$/ },
	{ file: 'Sizes', field: /Desc\.Size$/ },
	{ file: 'LimitedFeatureRecovery', field: /^Limited Feature Recovery/ },
	{ file: 'CompanionPageTypes', field: /^Comp\.Type$/ },
];

function catalogNames(detailedData) {
	const names = new Set();
	const add = (s) => s && names.add(String(s).toLowerCase().replace(/\s+/g, ' ').trim());
	for (const e of detailedData) {
		add(e.name); add(e.sortName); add(e.inventoryName); add(e.fullName);
		[].concat(e.alternateNames || []).forEach(add);
		if (e.feature && e.feature.name) add(e.feature.name);
		(e.choices || []).forEach((c) => add(c.name));
		(e.variants || []).forEach((v) => add(v.name));
	}
	return names;
}

function buildCatalogs(optionLists, outRoot) {
	const out = {};
	for (const spec of CATALOGS) {
		const list = optionLists
			.filter((l) => (spec.field && l.fields.some((f) => spec.field.test(f)))
				|| (spec.tooltip && spec.tooltip.test((l.tooltip || '').normalize('NFKC').trim())))
			.sort((a, b) => b.options.length - a.options.length)[0];
		if (!list) continue;
		let known = new Set();
		if (spec.detailed && fs.existsSync(path.join(outRoot, spec.detailed))) {
			known = catalogNames(JSON.parse(fs.readFileSync(path.join(outRoot, spec.detailed), 'utf8')));
		}
		const seen = new Set();
		out[spec.file] = list.options.map((o) => o.trim()).filter((o) => o && !seen.has(o) && seen.add(o))
			.map((name) => prune({ name, detailedIn: known.has(name.toLowerCase()) ? spec.detailed : undefined }));
	}
	return out;
}

function writeJson(root, rel, data) {
	const file = path.join(root, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data, null, 4) + '\n');
	const count = Array.isArray(data) ? data.length : Object.keys(data).length;
	console.log(`${String(count).padStart(5)}  ${rel}`);
}

function main() {
	const [inDir, outRoot = 'Data'] = process.argv.slice(2);
	if (!inDir) {
		console.error('Usage: node tools/extract-mpmb-data.js <folder written by tools/extract_pdf.py> [output root]');
		process.exit(1);
	}
	// Accept either the extract_pdf.py output folder (js/ + pdf/) or a bare folder of .js files
	const jsDir = fs.existsSync(path.join(inDir, 'js')) ? path.join(inDir, 'js') : inDir;
	const pdfDir = path.join(inDir, 'pdf');
	const m = loadMpmb(jsDir);
	const warnings = [];
	const map = (obj, fn) => Object.entries(obj || {}).map(([k, v]) => fn(k, v));

	writeJson(outRoot, 'Classes/Classes.json', map(m.Base_ClassList, (k, c) => normalizeClass(k, c, m.Base_ClassSubList, warnings)));
	writeJson(outRoot, 'Classes/Subclasses.json', map(m.Base_ClassSubList, (k, s) => normalizeSubclass(k, s, warnings)));
	writeJson(outRoot, 'Classes/FightingStyles.json', map(m.FightingStyles, (k, f) => {
		const o = normalizeFeatureBody(f, k);
		o.extraAC = f.extraAC ? prune({ mod: f.extraAC.mod, text: f.extraAC.text }) : undefined;
		return prune(o);
	}));
	writeJson(outRoot, 'Races/Races.json', map(m.Base_RaceList, (k, r) => normalizeRace(k, r, m.Base_RaceSubList, warnings)));
	writeJson(outRoot, 'Backgrounds/Backgrounds.json', map(m.Base_BackgroundList, (k, b) => normalizeBackground(k, b, m.Base_BackgroundFeatureList || {})));
	// Feats come from the sheet's runtime state, which includes the add-on scripts stored in the PDF
	// (the SRD scripts alone only define Grappler).
	const addons = readStoredField(pdfDir, 'User_Imported_Files.Stringified') || {};
	const sheetSources = readStoredField(pdfDir, 'CurrentSources.Stringified') || {};
	const rt = Object.keys(addons).length ? loadRuntime(jsDir, addons) : m;
	const featsList = deepCopy(rt.FeatsList || m.Base_FeatsList);
	const sourceList = deepCopy(rt.SourceList || m.Base_SourceList);
	writeJson(outRoot, 'Feats/Feats.json', map(featsList, (k, f) => normalizeFeat(k, f, warnings, sourceList, sheetSources.globalExcl || []))
		.sort((a, b) => a.name.localeCompare(b.name)));

	writeJson(outRoot, 'Equipment/Armor.json', map(m.Base_ArmourList, normalizeArmor));
	writeJson(outRoot, 'Equipment/Weapons.json', map(m.Base_WeaponsList, normalizeWeapon));
	writeJson(outRoot, 'Equipment/Ammunition.json', map(m.Base_AmmoList, normalizeAmmo));
	writeJson(outRoot, 'Equipment/EquipmentPacks.json', map(m.Base_PacksList, normalizePack));
	writeJson(outRoot, 'Equipment/AdventuringGear.json', map(m.Base_GearList, normalizeGear));
	writeJson(outRoot, 'Equipment/Tools.json', map(m.Base_ToolsList, normalizeGear));

	const schools = m.Base_spellSchoolList || {};
	writeJson(outRoot, 'Spells/SpellsSRD.json', map(m.Base_SpellsList, (k, s) => normalizeSpell(k, s, schools, m.AtHigherLevels)));
	const slotRow = (row) => Object.fromEntries(row.map((n, i) => [SPELL_LEVEL_NAMES[i + 1], n]));
	writeJson(outRoot, 'Spells/SpellSlotTables.json', {
		full: m.defaultSpellTable.map((row, lvl) => ({ casterLevel: lvl, ...slotRow(row) })),
		pact: m.warlockSpellTable.map((row, lvl) => ({ warlockLevel: lvl, ...slotRow(row) })),
	});

	writeJson(outRoot, 'Creatures/Creatures.json', map(m.Base_CreatureList, normalizeCreature));
	writeJson(outRoot, 'Companions/CompanionTypes.json', map(m.Base_CompanionList, normalizeCompanionType));
	writeJson(outRoot, 'MagicItems/MagicItems.json', map(m.Base_MagicItemsList, (k, i) => normalizeMagicItem(k, i, warnings)));
	writeJson(outRoot, 'MagicItems/TreasureCheckpoints.json', map(m.TreasureCheckpointsTable, (table, t) => ({ table, tier: t.tier, points: t.points })));

	const sk = m.SkillsList;
	writeJson(outRoot, 'Rules/Skills.json', sk.names
		.map((name, i) => ({ name, ability: sk.abilityScores[i], abbreviation: sk.abbreviations[i] }))
		.filter((s) => ABILITIES.includes(s.ability) && s.name !== 'Initiative'));
	writeJson(outRoot, 'Rules/Alignments.json', [...m.Alignments].filter(Boolean));
	writeJson(outRoot, 'Rules/DamageTypes.json', Object.keys(m.DamageTypes));
	writeJson(outRoot, 'Rules/Levels.json', m.levels.map((lvl, i) => ({
		level: lvl,
		experiencePoints: Number(m.ExperiencePointsList[i]) || 0,
		proficiencyBonus: m.ProficiencyBonusList[i],
		cantripDice: m.cantripDie[i],
	})));
	writeJson(outRoot, 'Rules/Sources.json', map(m.Base_SourceList, (k, s) => prune({ key: k, name: s.name, abbreviation: s.abbreviation, url: s.url, date: s.date })));
	writeJson(outRoot, 'Rules/AbilityScores.json', abilityScoreRules(m, jsDir));
	writeJson(outRoot, 'Rules/Lifestyles.json', m.Lifestyles.types
		.map((t, i) => ({ name: titleCaseWord(t), dailyCost: m.Lifestyles.expenses[i] === '—' ? null : m.Lifestyles.expenses[i] }))
		.filter((l) => l.name));
	writeJson(outRoot, 'Rules/Factions.json', map(m.factions, (k, f) => prune({ key: k, name: f.name, setting: f.type, ranks: f.ranks })));
	writeJson(outRoot, 'Rules/UnitConversions.json', {
		note: 'Multiply imperial values by these factors: mass lb->kg, length ft->m, lengthInch in->cm, volume cu ft->m3, surface sq ft->m2, distance mi->km, liquid gal->L, liquidQuart qt->L',
		rounded: plain(m.UnitsList.metric),
		exact: plain(m.UnitsList.metricExact),
	});
	writeJson(outRoot, 'Rules/Licenses.json', licenses(m));
	writeJson(outRoot, 'Classes/GenericClassFeatures.json', map(m.GenericClassFeatures, (k, f) => normalizeFeature(f, k, warnings, 'generic')));
	writeJson(outRoot, 'Spells/SpellSchools.json', map(m.Base_spellSchoolList, (abbr, name) => ({ abbreviation: abbr, name: titleCaseWord(name) })));
	writeJson(outRoot, 'Spells/SpellLevels.json', [...m.Base_spellLevelList]);
	writeJson(outRoot, 'Spells/SpellPoints.json', {
		note: 'Spell points variant (DMG): total spell points by spellcaster level',
		levels: m.SpellPointsTable.map((points, lvl) => ({ casterLevel: lvl, spellPoints: points })).slice(1),
	});

	// Data from the PDF itself (written by tools/extract_pdf.py)
	const refFile = path.join(pdfDir, 'player-reference.txt');
	if (fs.existsSync(refFile)) {
		const ref = parsePlayerReference(fs.readFileSync(refFile, 'utf8'));
		writeJson(outRoot, 'Rules/PlayerReference.json', ref);
		writeJson(outRoot, 'Rules/Conditions.json', {
			source: ref.Conditions && ref.Conditions.source,
			conditions: ref.Conditions ? ref.Conditions.entries.map(({ name, description }) => ({ name, description })) : [],
			exhaustion: ref.Exhaustion,
		});
	} else {
		console.warn(`(no ${refFile}; run tools/extract_pdf.py to include the Player Reference page)`);
	}
	const optFile = path.join(pdfDir, 'option-lists.json');
	if (fs.existsSync(optFile)) {
		const catalogs = buildCatalogs(JSON.parse(fs.readFileSync(optFile, 'utf8')), outRoot);
		for (const [name, list] of Object.entries(catalogs)) writeJson(outRoot, `Catalog/${name}.json`, list);
	} else {
		console.warn(`(no ${optFile}; run tools/extract_pdf.py to include the drop-down name catalogs)`);
	}

	if (warnings.length) console.warn('\nWarnings:\n  ' + warnings.join('\n  '));
}

if (require.main === module) main();
function titleCaseWord(s) {
	return String(s || '').replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

module.exports = { loadMpmb, loadRuntime, parseFeatPrerequisite, parsePlayerReference, buildCatalogs, linesToProse, parseRaceTraits, parsePrereq, parseSkillChoice, parseUsagesCalc, normalizeDamage, expandCastingTime };
