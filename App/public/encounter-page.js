/*
 * Encounter page: rolls a group of NPCs from /api/encounter and lists them, with any tracked players, as an accordion
 * in initiative order. One entry is open at a time; the open (or last opened) entry is the current turn and its name
 * is highlighted. "Next character" closes it and opens the one below, wrapping to the top and counting rounds.
 *
 * Order: higher initiative first; ties go to players, then to the higher initiative bonus.
 */
'use strict';

const filtersForm = document.getElementById('filters');
const factionSelect = document.getElementById('faction-select');
const statusLine = document.getElementById('status');
const summaryLine = document.getElementById('summary');
const list = document.getElementById('initiative');
const nextButton = document.getElementById('next-turn');
const roundLabel = document.getElementById('round');
const playerDialog = document.getElementById('player-dialog');
const playerForm = document.getElementById('player-form');

let combatants = []; // { id, kind: 'npc' | 'player', name, init: { total, bonus, advantage, rolls }, npc?, el }
let currentId = null;
let round = 0; // 0 until the first turn is opened
let nextId = 1;

const byInitiative = (a, b) => b.init.total - a.init.total
	|| (a.kind === 'player' ? 0 : 1) - (b.kind === 'player' ? 0 : 1)
	|| (b.init.bonus ?? 0) - (a.init.bonus ?? 0);

function initDetail(init) {
	if (!init.rolls) return 'Player initiative';
	const roll = init.advantage ? `d20 with advantage (${init.rolls.join(', ')})` : `d20 (${init.rolls[0]})`;
	return `${roll} ${init.bonus < 0 ? '−' : '+'} ${Math.abs(init.bonus)} = ${init.total}`;
}

// Numbers repeated names ("Human Warrior 1", "Human Warrior 2") so each enemy can be told apart.
function uniqueNames(npcs) {
	const totals = new Map();
	for (const n of npcs) totals.set(n.Name, (totals.get(n.Name) || 0) + 1);
	const seen = new Map();
	return npcs.map((n) => {
		if (totals.get(n.Name) === 1) return n.Name;
		seen.set(n.Name, (seen.get(n.Name) || 0) + 1);
		return `${n.Name} ${seen.get(n.Name)}`;
	});
}

function npcSubtitle(npc) {
	const ac = String(npc.Armor).split(' ')[0];
	const hp = String(npc.HitPoints).split(' ')[0];
	return `Level ${npc.Level} ${npc.Class} · AC ${ac} · HP ${hp}`;
}

function buildEntry(c) {
	const el = document.createElement('details');
	el.className = `turn ${c.kind}`;
	el.dataset.id = c.id;
	const sub = c.kind === 'npc' ? esc(npcSubtitle(c.npc)) : 'Player';
	const adv = c.init.advantage ? '<span class="tag" title="Advantage on initiative">Adv</span>' : '';
	const remove = c.kind === 'player' ? `<button type="button" class="remove-player" title="Stop tracking ${esc(c.name)}" aria-label="Remove ${esc(c.name)}">&times;</button>` : '';
	el.innerHTML = `
		<summary>
			<span class="init-badge" title="${esc(initDetail(c.init))}">${c.init.total}</span>
			<span class="turn-name">${esc(c.name)}</span>
			<span class="turn-sub">${sub}${adv}</span>
			${remove}
		</summary>
		<div class="turn-body">${c.kind === 'npc' ? npcBody(c) : playerBody()}</div>`;
	el.addEventListener('toggle', () => {
		if (!el.open) return;
		setCurrent(c.id);
		for (const other of list.children) if (other !== el) other.open = false;
	});
	const removeButton = el.querySelector('.remove-player');
	if (removeButton) removeButton.addEventListener('click', (e) => { e.preventDefault(); removePlayer(c.id); });
	return el;
}

function npcBody(c) {
	const npc = { ...c.npc, Name: c.name };
	const spellbook = renderSpellbook(npc.Spellbook, npc.Spellcasting);
	return `<div class="turn-statblock">${renderNpc(npc)}</div>
		<p class="meta">Initiative: ${esc(initDetail(c.init))}<br>${renderMeta(npc)}</p>
		${spellbook ? `<section class="spellbook">${spellbook}</section>` : ''}`;
}

// All six saves: the NPC lists proficient ones (or all six when an item adds to every save); the rest are the ability modifier.
function allSaves(npc) {
	const listed = new Map(pairs(npc.SavingThrows || []));
	return ABILITIES.map(([key, label]) => ({
		label,
		value: listed.has(key) ? listed.get(key) : mod(npc.Stats[key]),
		listed: listed.has(key),
	}));
}

// A player's turn: a quick reference of every NPC's defences and reactions, in initiative order.
function playerBody() {
	const npcs = combatants.filter((c) => c.kind === 'npc');
	const intro = '<p class="turn-empty">Player character — run their turn at the table.</p>';
	if (!npcs.length) return intro;
	const head = ABILITIES.map(([, label]) => `<th scope="col" class="num">${label}</th>`).join('');
	const rows = npcs.map((c) => {
		const npc = c.npc;
		const saves = allSaves(npc).map((s) =>
			`<td class="num${s.listed ? ' prof' : ''}"${s.listed ? ' title="Proficient"' : ''}>${signed(s.value)}</td>`).join('');
		const reactions = pairs(npc.Reactions || [])
			.map(([name, text]) => `<span class="reaction" title="${esc(String(text).replace(/_/g, ''))}">${esc(name)}</span>`)
			.join(', ') || '—';
		return `<tr>
			<th scope="row">${esc(c.name)}</th>
			<td class="num">${esc(String(npc.Armor).split(' ')[0])}</td>
			<td class="num">${esc(String(npc.HitPoints).split(' ')[0])}</td>
			${saves}
			<td class="reactions">${reactions}</td>
		</tr>`;
	}).join('');
	return `${intro}
		<div class="npc-table-wrap">
			<table class="npc-table">
				<thead>
					<tr><th scope="col">NPC</th><th scope="col" class="num">AC</th><th scope="col" class="num">Max HP</th>${head}<th scope="col">Reactions</th></tr>
				</thead>
				<tbody>${rows}</tbody>
			</table>
		</div>`;
}

// Re-appends the cached entries in initiative order, so open spellbooks and scroll state survive.
// Player bodies are rebuilt each time, since their NPC table depends on the current encounter.
function renderList() {
	combatants.sort(byInitiative);
	for (const c of combatants) {
		if (c.kind === 'player') c.el.querySelector('.turn-body').innerHTML = playerBody();
		list.appendChild(c.el);
	}
	nextButton.disabled = !combatants.length;
	roundLabel.textContent = round ? `Round ${round}` : '';
	highlight();
}

function highlight() {
	for (const c of combatants) {
		const isCurrent = c.id === currentId;
		c.el.classList.toggle('current', isCurrent);
		c.el.querySelector('summary').setAttribute('aria-current', isCurrent ? 'step' : 'false');
	}
}

function setCurrent(id) {
	currentId = id;
	if (!round) round = 1;
	roundLabel.textContent = `Round ${round}`;
	highlight();
}

function nextTurn() {
	if (!combatants.length) return;
	const i = combatants.findIndex((c) => c.id === currentId);
	const next = i < 0 ? 0 : (i + 1) % combatants.length;
	if (i >= 0 && next === 0) round++;
	for (const c of combatants) c.el.open = false;
	const target = combatants[next];
	target.el.open = true;
	setCurrent(target.id);
	requestAnimationFrame(() => target.el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function addPlayer(name, total) {
	const c = { id: nextId++, kind: 'player', name, init: { total } };
	c.el = buildEntry(c);
	combatants.push(c);
	renderList();
}

function removePlayer(id) {
	const i = combatants.findIndex((c) => c.id === id);
	if (i < 0) return;
	const [gone] = combatants.splice(i, 1);
	gone.el.remove();
	// The turn passes to whoever was below the removed player (not opened, so Next still goes to the one after).
	if (gone.id === currentId) currentId = combatants.length ? combatants[i % combatants.length].id : null;
	renderList();
}

function encounterSummary(body) {
	const items = body.items.carried === body.items.requested
		? `${body.items.carried} magic item${body.items.carried === 1 ? '' : 's'}`
		: `${body.items.carried} of ${body.items.requested} magic items fit`;
	const faction = body.faction ? `${body.faction} · ` : '';
	return `${faction}${body.count} enem${body.count === 1 ? 'y' : 'ies'} · level sum ${body.levels} · ${items}`;
}

async function generate() {
	const query = new URLSearchParams([...new FormData(filtersForm)].filter(([, v]) => v !== ''));
	statusLine.textContent = 'Rolling…';
	filtersForm.generate.disabled = true;
	try {
		const res = await fetch(`/api/encounter?${query}`);
		const body = await res.json();
		if (!res.ok) throw new Error(body.error || res.statusText);
		const names = uniqueNames(body.npcs);
		for (const c of combatants.filter((c) => c.kind === 'npc')) c.el.remove();
		combatants = combatants.filter((c) => c.kind === 'player');
		for (const [i, npc] of body.npcs.entries()) {
			const c = { id: nextId++, kind: 'npc', name: names[i], init: npc.Initiative, npc };
			c.el = buildEntry(c);
			combatants.push(c);
		}
		for (const c of combatants) c.el.open = false;
		currentId = null;
		round = 0;
		renderList();
		summaryLine.textContent = encounterSummary(body);
		statusLine.textContent = '';
	} catch (e) {
		statusLine.textContent = `Couldn't generate an encounter: ${e.message}`;
	} finally {
		filtersForm.generate.disabled = false;
	}
}

filtersForm.addEventListener('submit', (e) => {
	e.preventDefault();
	generate();
});

// Faction drop-down (Data/Factions/). Each option's tooltip is the faction's description. If the list can't load,
// the select stays disabled, so the form sends no faction and the encounter has no limits.
async function loadFactions() {
	try {
		const res = await fetch('/api/factions');
		const factions = await res.json();
		if (!res.ok) throw new Error(factions.error || res.statusText);
		if (!factions.length) return factionSelect.replaceChildren(new Option('None defined', ''));
		factionSelect.replaceChildren(...factions.map((f) => {
			const option = new Option(f.name, f.key);
			option.title = f.description;
			return option;
		}));
		const showDescription = () => { factionSelect.title = factionSelect.selectedOptions[0]?.title || ''; };
		factionSelect.addEventListener('change', showDescription);
		showDescription();
		factionSelect.disabled = false;
	} catch (e) {
		factionSelect.replaceChildren(new Option('Unavailable', ''));
		factionSelect.title = `Couldn't load factions: ${e.message}`;
	}
}
loadFactions();

document.getElementById('track-player').addEventListener('click', () => {
	playerForm.reset();
	playerDialog.showModal();
});
document.getElementById('player-cancel').addEventListener('click', () => playerDialog.close());
playerForm.addEventListener('submit', (e) => {
	e.preventDefault();
	// form.elements, since form.name is the form's own name attribute.
	const { name: nameInput, initiative } = playerForm.elements;
	const name = nameInput.value.trim();
	const total = Number(initiative.value);
	if (!name) return nameInput.reportValidity();
	addPlayer(name, total);
	playerDialog.close();
});

nextButton.addEventListener('click', nextTurn);
renderList();
