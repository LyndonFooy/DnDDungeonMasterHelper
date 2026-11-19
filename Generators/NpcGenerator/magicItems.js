'use strict';
/*
 * Magic items for the NPC generator: builds the item pool from Data/MagicItems/MagicItems.json, decides which items fit an
 * NPC's gear, and works out what each item does to the statblock (weapon/armor bonuses, AC, saves, spell bonuses,
 * extra damage, item spells). The NpcBuilder in generateNpc.js calls these with itself as `npc`.
 */

const RARITIES = ['common', 'uncommon', 'rare', 'very rare', 'legendary'];
const SWORDS = new Set(['shortsword', 'longsword', 'greatsword', 'scimitar', 'rapier']);
const AXES = new Set(['handaxe', 'battleaxe', 'greataxe']);
const DAMAGE_TYPES = new Set(['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder']);
// Spell scroll save DC and attack bonus by spell level (DMG)
const SCROLL_DC = [13, 13, 13, 15, 15, 17, 17, 18, 18, 19];

const clean = (s) => String(s).replace(/\s+/g, ' ').trim();
const rarityRank = (r) => RARITIES.indexOf(String(r || '').toLowerCase());

// One entry per buyable item: "Weapon, +1, +2, or +3" becomes "Weapon +1" (uncommon), "Weapon +2" (rare), ...
// Variants inherit the parent's fields; `baseKey` ties them back to the parent so an NPC never gets two of them.
function expandItems(items) {
	const out = [];
	const seen = new Set();
	for (const item of items) {
		const { choices, ...parent } = item;
		const variants = choices ? choices.map((c) => {
			const name = clean(c.name);
			const parentWord = parent.name.split(/[\s,]/)[0].toLowerCase();
			return {
				...parent, ...c, key: `${parent.key}: ${c.key}`, variant: c.key, rarity: c.rarity || parent.rarity,
				name: name.toLowerCase().includes(parentWord) ? name : `${clean(parent.name)} (${name})`,
			};
		}) : [{ ...parent, name: clean(parent.name) }];
		for (const v of variants) {
			v.baseKey = parent.key;
			const k = v.name.toLowerCase();
			if (rarityRank(v.rarity) < 0 || seen.has(k)) continue;
			seen.add(k);
			out.push(v);
		}
	}
	return out;
}

const typeOf = (item) => String(item.type || '').toLowerCase();
const isConsumable = (item) => /^(potion|scroll)/.test(typeOf(item));
const isWeaponItem = (item) => /^weapon\b/.test(typeOf(item));
const isArmorItem = (item) => /^armor\b/.test(typeOf(item));
const isShieldItem = (item) => typeOf(item) === 'shield';
const isStaff = (item) => typeOf(item) === 'staff';
const specOf = (item) => ((/\((.+)\)/.exec(typeOf(item)) || [])[1] || '').trim();
// "+1 weapon" style items whose only effect is the number; they get no description entry of their own.
const isPlainBonus = (item) => /^(weapon|armor|shield|ammunition) \+\d$/i.test(item.name);

function weaponMatches(spec, w) {
	if (!w || !w.damage || !w.damage.dice) return false;
	if (spec === 'any') return true;
	if (spec === 'any ammunition') return !!w.ammunition;
	if (/^any\b/.test(spec)) {
		if (/sword/.test(spec) && SWORDS.has(w.key) && (!/slashing/.test(spec) || w.damage.type === 'slashing')) return true;
		return /axe/.test(spec) && AXES.has(w.key);
	}
	return spec === w.key;
}

// The NPC's weapon slots ('mainWeapon' / 'rangedWeapon') this weapon item could go on.
function weaponSlots(npc, item) {
	const spec = specOf(item);
	return ['mainWeapon', 'rangedWeapon'].filter((slot) => npc[slot] && !npc[slot].magicItem && weaponMatches(spec, npc[slot]));
}

function armorMatches(item, armor) {
	const tokens = specOf(item).split(/,\s*(?:or\s+)?|\s+or\s+/).map((t) => t.trim()).filter(Boolean);
	return tokens.some((t) => t === armor.type || t === armor.key || t === String(armor.name).toLowerCase());
}

// Items that only work without armor: Bracers of Defense (extraAC) and the Robe of the Archmagi (its own AC formula).
const unarmoredOptions = (item) => (isArmorItem(item) ? [] : (item.armorOptions || []).filter((ao) => typeof ao.ac === 'number'));
const needsNoArmor = (item) => unarmoredOptions(item).length > 0 || (item.extraAC || []).some((e) => /not wearing armor/i.test(e.text || ''));

// "Requires attunement by a ..." -> can this NPC attune it?
function prerequisiteFits(npc, item) {
	const p = item.prerequisite;
	if (!p) return true;
	const m = /attunement by an? (.+)$/i.exec(p);
	if (!m) return false; // proficiency with wind instruments, a spellcaster with two 5th-level slots, ...
	let who = m[1].toLowerCase().replace(/\.$/, '');
	// "a good sorcerer, warlock, or wizard" (Robe of the Archmagi)
	const align = /^(good|neutral|evil|lawful|chaotic) (?!alignment)/.exec(who);
	if (align) {
		if (!new RegExp(align[1], 'i').test(npc.alignment)) return false;
		who = who.slice(align[0].length);
	}
	if (/spellcaster/.test(who)) return !!npc.cls.spellcasting;
	if (/good alignment/.test(who)) return /good/i.test(npc.alignment);
	if (/evil alignment/.test(who)) return /evil/i.test(npc.alignment);
	const classKeys = new Set(npc.d.classes.map((c) => c.key));
	const names = who.split(/,\s*(?:or\s+)?|\s+or\s+/).map((s) => s.trim()).filter(Boolean);
	if (names.every((n) => classKeys.has(n))) return !!npc.role && names.some((n) => npc.role.lists.includes(n));
	return npc.raceMatches(who);
}

function fits(npc, item) {
	if (!prerequisiteFits(npc, item)) return false;
	if (isWeaponItem(item)) return weaponSlots(npc, item).length > 0;
	if (isArmorItem(item)) {
		const armor = npc.armorChoice.armor;
		return !!armor && !npc.armorItem && !npc.forceUnarmored && armorMatches(item, armor);
	}
	if (isShieldItem(item)) return !!npc.shield && !npc.shieldItem;
	if (/^scroll/.test(typeOf(item))) return !!scrollSpellPool(npc, item).length;
	if (needsNoArmor(item)) {
		if (npc.armorItem || (npc.shield && !unarmoredOptions(item).length)) return false;
		return unarmoredAC(npc, item) >= npc.armorChoice.ac + (npc.shield ? 2 : 0);
	}
	return true;
}

// AC the NPC would have relying on this item instead of armor.
function unarmoredAC(npc, item) {
	const dex = npc.mods.Dex;
	const bare = Math.max(...npc.armorOptions().filter((o) => !o.armor).map((o) => o.ac), 10 + dex);
	const own = Math.max(bare, ...unarmoredOptions(item).map((ao) => ao.ac + dex));
	const bonus = (item.extraAC || []).reduce((s, e) => s + (e.mod || 0), 0);
	const shield = npc.shield && unarmoredOptions(item).length ? 2 : 0;
	return own + bonus + shield;
}

// --- numbers read from the item text -------------------------------------------------------

const sentences = (item) => String(item.description || '').split(/(?<=\.)\s+/);

function weaponBonus(item) {
	const m = /\+(\d)$/.exec(item.name) || /\+(\d) (?:bonus )?to attack and damage/i.exec(item.description || '') || /this \+(\d) \w+/i.exec(item.description || '');
	return m ? Number(m[1]) : 0;
}

function acBonus(item) {
	const m = /\+(\d)$/.exec(item.name) || /\+(\d) bonus to AC(?! against)/i.exec(item.description || '')
		|| /\+(\d)$/.exec(String(((item.armorOptions || [])[0] || {}).ac || ''));
	return m ? Number(m[1]) : 0;
}

// Static bonuses an item gives while carried. Consumables give none (their effects are temporary).
function itemBonuses(item) {
	const out = { saves: 0, spellAttack: 0, spellDC: 0 };
	if (isConsumable(item)) return out;
	for (const s of sentences(item)) {
		const n = Number((/\+(\d)\b(?!d)/.exec(s) || [])[1]) || 0;
		if (!n) continue;
		if (/\bsav(?:es|ing throws)\b/i.test(s) && !/\bDCs?\b|spell save|against|vs\./i.test(s)) out.saves = Math.max(out.saves, n);
		if (/spell attack/i.test(s)) out.spellAttack = Math.max(out.spellAttack, n);
		if (/(?:saving throw|spell save) DC/i.test(s)) out.spellDC = Math.max(out.spellDC, n);
	}
	const robe = /spell save DC and spell attack bonus increase by (\d)/i.exec(item.description || '');
	if (robe) { out.spellDC = Math.max(out.spellDC, Number(robe[1])); out.spellAttack = Math.max(out.spellAttack, Number(robe[1])); }
	return out;
}

// Extra damage dice on hit: "+2d6 fire damage", "+2d10 radiant damage against fiends and undead", "+1d8 damage to undead".
// Riders that cost a charge, need a command or only apply to a sworn enemy are left to the item's own description.
function weaponRiders(item, w) {
	const riders = [];
	const seen = new Set();
	const scan = (text, needQualifier) => {
		const re = /\+(\d+d\d+)(?: (\w+))? damage(?:\s+(vs\.?|against|to|when)\s+([^.;,]+))?/gi;
		for (let m; (m = re.exec(text));) {
			const before = text.slice(Math.max(0, m.index - 40), m.index);
			if (/charge|coated|once|1×|sworn|\bvs\.? it\b/i.test(before)) continue;
			const typeWord = m[2] && DAMAGE_TYPES.has(m[2].toLowerCase()) ? m[2].toLowerCase() : undefined;
			if (!typeWord && !m[3]) continue;
			if (needQualifier && !m[3]) continue;
			const type = typeWord || w.damage.type;
			const target = m[4] ? m[4].split('(')[0].trim() : '';
			const when = m[3] ? (/^when/i.test(m[3]) ? `when ${target}` : `against ${target}`) : '';
			const key = m[1] + type;
			if (seen.has(key)) continue;
			seen.add(key);
			riders.push({ dice: m[1], type, when });
		}
	};
	scan(String(item.description || ''), false);
	for (const a of item.attacks || []) scan(String(a.description || ''), true);
	return riders;
}

// --- equipping -------------------------------------------------------------------------------

function enchantWeapon(npc, slot, item) {
	const w = { ...npc[slot] };
	w.magicItem = item.name;
	w.magicBonus = weaponBonus(item);
	const attack = (item.attacks || [])[0];
	if (attack && attack.damage && attack.damage.dice) w.damage = { ...w.damage, ...attack.damage };
	if (attack && /finesse/i.test(attack.description || '')) w.finesse = true;
	w.riders = weaponRiders(item, w);
	if (/^ammunition/i.test(item.name) || specOf(item) === 'any ammunition') {
		const ammo = `+${w.magicBonus} ${w.ammunition === 'arrow' ? 'arrows' : w.ammunition + 's'}`;
		w.attackName = `${w.name} (${ammo})`;
		w.ammoLabel = `20 ${ammo}`;
	} else if (/^weapon \+\d$/i.test(item.name)) {
		w.displayName = `+${w.magicBonus} ${w.name}`;
	} else if (isStaff(item) || item.name.toLowerCase().includes(w.name.toLowerCase())) {
		w.displayName = item.name;
	} else {
		w.displayName = `${item.name} (${w.name})`;
	}
	npc[slot] = w;
	item.attachedTo = slot;
}

// Spells a spell scroll of this level could hold: any spell of that level, whoever carries it.
function scrollSpellPool(npc, item) {
	const level = /cantrip/i.test(item.variant || '') ? 0 : parseInt(item.variant, 10);
	if (!Number.isInteger(level) || level > 9) return [];
	return [...npc.d.spells.values()].filter((s) => s.level === level);
}

function equip(npc, item) {
	const it = { ...item, bonuses: itemBonuses(item) };
	if (isWeaponItem(it)) {
		enchantWeapon(npc, npc.rng.pick(weaponSlots(npc, it)), it);
	} else if (isStaff(it) && npc.mainWeapon.key === 'quarterstaff' && !npc.mainWeapon.magicItem) {
		enchantWeapon(npc, 'mainWeapon', it);
	} else if (isArmorItem(it)) {
		it.acBonus = acBonus(it);
		const { label, armor } = npc.armorChoice;
		const name = it.name.toLowerCase();
		npc.armorChoice = {
			...npc.armorChoice,
			label: /^armor \+\d$/i.test(it.name) ? `+${it.acBonus} ${label}` : name.includes(armor.key) ? name : `${name} (${label})`,
		};
		npc.armorItem = it;
		it.attachedTo = 'armor';
	} else if (isShieldItem(it)) {
		it.acBonus = acBonus(it);
		npc.shieldLabel = /^shield \+\d$/i.test(it.name) ? `+${it.acBonus} shield` : it.name.toLowerCase();
		npc.shieldItem = it;
		it.attachedTo = 'shield';
	} else if (/^scroll/.test(typeOf(it))) {
		it.scrollSpell = npc.rng.pick(scrollSpellPool(npc, it));
		it.name = `Spell Scroll (${it.scrollSpell.name})`;
	} else if (needsNoArmor(it)) {
		it.unarmoredOptions = unarmoredOptions(it).map((ao) => ({ ac: ao.ac, label: ao.name.toLowerCase() }));
		npc.forceUnarmored = true;
	}
	if (!isConsumable(it)) for (const l of it.languages || []) npc.languages.add(l);
	npc.magicItems.push(it);
	return it;
}

// Gauntlets of Ogre Power, Belts of Giant Strength, Amulet of Health, Belt of Dwarvenkind ...
function applyScores(npc) {
	for (const it of npc.magicItems) {
		if (isConsumable(it)) continue;
		for (const [ab, v] of Object.entries(it.abilityScoreOverride || {})) npc.scores[ab] = Math.max(npc.scores[ab], v);
		for (const [ab, v] of Object.entries(it.abilityScoreIncrease || {})) npc.scores[ab] = Math.min(20, npc.scores[ab] + v);
	}
}

// --- statblock text ---------------------------------------------------------------------------

function usageText(item) {
	const n = Number(item.usages);
	if (!n) return '';
	const rec = String(item.recovery || '').toLowerCase();
	const add = typeof item.additional === 'string' ? item.additional : '';
	if (/regains/i.test(add)) return `${n} Charges; ${add} at ${rec === 'dawn' ? 'dawn' : rec}`;
	if (/never/.test(rec)) return `${n} Charges`;
	if (/short/.test(rec)) return n === 1 ? 'Recharges after a Short or Long Rest' : `${n}/Short Rest`;
	if (add) return `${n} ${add}/Day`;
	return `${n}/Day`;
}

// "> 1 charge: _charm person, command_" lines for an item that casts spells
function spellLines(item) {
	const lines = [];
	for (const b of item.spellcastingBonus || []) {
		const spells = (b.spells || []).map((s) => s.toLowerCase());
		if (!spells.length) continue;
		let label;
		if (b.frequency) {
			label = b.frequency === 'at will' ? 'At will' : '1/day';
			if (b.name && !/^(at will|once per dawn)$/i.test(b.name) && b.name.toLowerCase() !== item.name.toLowerCase()) label += ` (${b.name.toLowerCase()})`;
		} else {
			const name = String(b.name || 'Spells').replace(/\s*&&\s*/g, ' and ');
			label = name.charAt(0).toUpperCase() + name.slice(1);
		}
		lines.push(`> ${label}: _${spells.join(', ')}_`);
	}
	return lines;
}

module.exports = {
	RARITIES, SCROLL_DC, rarityRank, expandItems, fits, equip, applyScores, usageText, spellLines,
	isConsumable, isPlainBonus, isWeaponItem, isArmorItem, isShieldItem, weaponMatches, itemBonuses, weaponBonus, acBonus, weaponRiders,
};
