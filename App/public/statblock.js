/*
 * Shared NPC renderers (used by npc-page.js and encounter-page.js), with the markup of DataInspo/StatblockDisplayTemplate:
 * heading, top stats, ability scores and properties plus traits on the left, actions on the right.
 * The NPC's Spellbook (if it has spells) is a nested accordion: spell level, then spell.
 */
'use strict';

const ABILITIES = [['Str', 'STR'], ['Dex', 'DEX'], ['Con', 'CON'], ['Int', 'INT'], ['Wis', 'WIS'], ['Cha', 'CHA']];
const RULE = '<svg height="5" width="100%" class="tapered-rule" preserveAspectRatio="none" viewBox="0 0 400 5"><polyline points="0,0 400,2.5 0,5"></polyline></svg>';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const signed = (n) => (n >= 0 ? `+${n}` : String(n));
const mod = (score) => Math.floor((score - 10) / 2);
// Generator text marks italics as _text_.
const inline = (s) => esc(s).replace(/_([^_]+)_/g, '<i>$1</i>');
const pairs = (arr) => arr.map((o) => Object.entries(o)[0]);
// SpellsAll.json text is HTML; keep only its plain formatting tags (no attributes) and escape everything else.
const spellHtml = (s) => esc(s || '')
	.replace(/&lt;(\/?)(p|b|i|em|strong|ul|ol|li|br)\s*\/?&gt;/gi, '<$1$2>')
	.replace(/&amp;(#?\w+;)/g, '&$1');

function propertyLine(name, value, cls = '') {
	return `<div class="property-line ${cls}"><h4>${esc(name)}</h4> <p>${value}</p></div>`;
}

// One "Name. Text" entry. Extra paragraphs become indented lines; "> " lines are spell lists.
function propertyBlock(name, text) {
	const [first, ...rest] = String(text).split(/\n\n/);
	const extra = rest.map((para) => {
		const lines = para.split('\n');
		if (lines.every((l) => l.startsWith('> '))) {
			return `<ul class="spell-list">${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join('')}</ul>`;
		}
		return `<div class="indent">${inline(para)}</div>`;
	}).join('');
	return `<div class="property-block"><h4>${esc(name)}.</h4> <p>${inline(first)}</p>${extra}</div>`;
}

function blockSection(title, entries) {
	if (!entries || !entries.length) return '';
	return `${title ? `<h3>${esc(title)}</h3>` : ''}${pairs(entries).map(([k, v]) => propertyBlock(k, v)).join('')}`;
}

function speedText(npc) {
	const extra = npc.Speeds ? Object.entries(npc.Speeds).map(([m, v]) => `, ${m} ${v} ft.`).join('') : '';
	return `${npc.Speed} ft.${extra}`;
}

function properties(npc) {
	const list = (arr) => arr.map(esc).join(', ');
	const bonuses = (arr) => pairs(arr).map(([k, v]) => `${esc(k)} ${signed(v)}`).join(', ');
	const rows = [];
	if (npc.SavingThrows.length) rows.push(['Saving Throws', bonuses(npc.SavingThrows)]);
	if (npc.Skills.length) rows.push(['Skills', bonuses(npc.Skills)]);
	if (npc.DamageVulnerabilities.length) rows.push(['Damage Vulnerabilities', list(npc.DamageVulnerabilities)]);
	if (npc.DamageResistances.length) rows.push(['Damage Resistances', list(npc.DamageResistances)]);
	if (npc.DamageImmunities.length) rows.push(['Damage Immunities', list(npc.DamageImmunities)]);
	if (npc.ConditionImmunities.length) rows.push(['Condition Immunities', list(npc.ConditionImmunities)]);
	rows.push(['Senses', list(npc.Senses)]);
	rows.push(['Languages', list(npc.Languages.filter(Boolean)) || '—']);
	if (npc.Tools && npc.Tools.length) rows.push(['Tools', list(npc.Tools)]);
	if (npc.Equipment && npc.Equipment.length) rows.push(['Equipment', list(npc.Equipment)]);
	return rows.map(([k, v], i) => propertyLine(k, v, i === 0 ? 'first' : '')).join('');
}

function renderNpc(npc) {
	const scores = ABILITIES.map(([key, label]) =>
		`<div><h4>${label}</h4><p>${npc.Stats[key]} (${signed(mod(npc.Stats[key]))})</p></div>`).join('');
	const actions = blockSection('Actions', npc.Actions) + blockSection('Bonus Actions', npc.BonusActions) + blockSection('Reactions', npc.Reactions);

	return `
		<div class="stat-block${actions ? '' : ' single'}">
			<hr class="orange-border">
			<div class="section-left">
				<div class="creature-heading">
					<h1>${esc(npc.Name)}</h1>
					<h2>${esc(npc.Size)} humanoid (${esc(npc.Race.toLowerCase())}), ${esc(npc.Alignment.toLowerCase())}</h2>
				</div>
				${RULE}
				<div class="top-stats">
					${propertyLine('Armor Class', esc(npc.Armor), 'first')}
					${propertyLine('Hit Points', esc(npc.HitPoints))}
					${propertyLine('Speed', esc(speedText(npc)), 'last')}
					${RULE}
					<div class="scores">${scores}</div>
					${RULE}
					${properties(npc)}
					${propertyLine('Proficiency Bonus', signed(npc['Proficiency Bonus']), 'last')}
				</div>
				${npc.Abilities.length ? RULE : ''}
				<div class="actions">${blockSection('', npc.Abilities)}</div>
			</div>
			${actions ? `<div class="section-right"><div class="actions">${actions}</div></div>` : ''}
			<hr class="orange-border bottom">
		</div>`;
}

function renderMeta(npc) {
	const parts = [`Level ${npc.Level} ${npc.Class}${npc.Subclass ? ` (${npc.Subclass})` : ''}`];
	if (npc.Build) parts.push(`${npc.Build} build`);
	if (npc.MagicItems && npc.MagicItems.length) parts.push(`Magic items: ${pairs(npc.MagicItems).map(([k, v]) => `${k} (${v})`).join(', ')}`);
	parts.push(`Seed: ${npc.Seed}`);
	const notes = (npc.Notes || []).map((n) => `<br>Note: ${esc(n)}`).join('');
	return parts.map(esc).join(' · ') + notes;
}

// ---- Spellbook ----

function levelTitle(level) {
	if (level === 'Cantrip') return 'Cantrips';
	return /^\d/.test(level) ? `${level.replace('-level', '')} Level` : level;
}

function levelSummary(group) {
	const count = `${group.spells.length} spell${group.spells.length === 1 ? '' : 's'}`;
	return group.level === 'Cantrip' ? `${count} · at will` : count;
}

// One empty circle per spell slot; tick one off when a slot is spent. Inputs inside <summary> don't toggle the <details>.
function slotTracker(group) {
	if (group.level === 'Cantrip' || !group.slots) return '';
	const level = levelTitle(group.level).toLowerCase();
	const boxes = Array.from({ length: group.slots }, (_, i) =>
		`<input type="checkbox" class="slot" title="Spell slot used" aria-label="${esc(level)} slot ${i + 1} used">`).join('');
	return `<span class="slots" title="${group.slots} ${esc(level)} slot${group.slots === 1 ? '' : 's'}">${boxes}</span>`;
}

function spellDetails(spell) {
	if (!spell.desc) return '<p class="spell-missing">No details for this spell in Data/Spells/SpellsAll.json.</p>';
	const components = spell.material ? `${spell.components} (${spell.material.replace(/\.$/, '')})` : spell.components;
	const duration = spell.concentration === 'yes' ? `Concentration, ${spell.duration[0].toLowerCase()}${spell.duration.slice(1)}` : spell.duration;
	const [book, page] = String(spell.page || '').split(' ');
	const rows = [
		['Level', `${spell.level === 'Cantrip' ? `${spell.school} cantrip` : `${spell.level.replace('-', ' ')} ${spell.school.toLowerCase()}`}${spell.ritual === 'yes' ? ' (ritual)' : ''}`],
		['Casting Time', spell.casting_time],
		['Range', spell.range],
		['Components', components],
		['Duration', duration],
		['Classes', spell.class],
		['Cast via', spell.sources.join(', ')],
		['Source', book ? `${book.toUpperCase()}${page ? ` p. ${page}` : ''}` : ''],
	].filter(([, v]) => v);
	const higher = spell.higher_level ? `<div class="spell-higher"><h4>At Higher Levels.</h4> ${spellHtml(spell.higher_level)}</div>` : '';
	return `<div class="spell-props">${rows.map(([k, v]) => propertyLine(k, esc(v))).join('')}</div>
		<div class="spell-desc">${spellHtml(spell.desc)}${higher}</div>`;
}

function spellTags(spell) {
	const tags = [];
	if (spell.concentration === 'yes') tags.push('<span class="tag" title="Concentration">C</span>');
	if (spell.ritual === 'yes') tags.push('<span class="tag" title="Ritual">R</span>');
	const special = spell.sources.filter((s) => s !== 'Spellcasting');
	if (special.length) tags.push(`<span class="tag source">${esc(special.join(', '))}</span>`);
	return tags.join('');
}

// Spell save DC and spell attack bonus from the NPC's Spellcasting (absent for feat-only casters, whose ability is per feat).
function spellStats(sc) {
	if (!sc || sc.SpellSaveDC == null) return '';
	const ability = sc.SpellcastingAbility ? ` (${esc(sc.SpellcastingAbility)})` : '';
	return `<div class="spell-props spell-stats">
		${propertyLine('Spell Save DC', `${sc.SpellSaveDC}${ability}`)}
		${propertyLine('Spell Attack', `${signed(sc.SpellAttackBonus)} to hit`)}
	</div>`;
}

function renderSpellbook(groups, spellcasting) {
	if (!groups || !groups.length) return '';
	const levels = groups.map((group) => `
		<details class="spell-level">
			<summary><span class="level-name">${esc(levelTitle(group.level))}</span><span class="level-count">${esc(levelSummary(group))}</span>${slotTracker(group)}</summary>
			<div class="spell-list-items">${group.spells.map((spell) => `
				<details class="spell">
					<summary><span class="spell-name">${esc(spell.name)}</span><span class="spell-meta">${spell.school ? `<span class="school">${esc(spell.school)}</span>` : ''}${spellTags(spell)}</span></summary>
					<div class="spell-body">${spellDetails(spell)}</div>
				</details>`).join('')}
			</div>
		</details>`).join('');
	return `<hr class="orange-border">
		<h2 class="spellbook-title">Spellbook</h2>
		${RULE}
		${spellStats(spellcasting)}
		${levels}
		<hr class="orange-border bottom">`;
}
