/* NPC page: fetches one random NPC from /api/npc and renders it with statblock.js. */
'use strict';

const form = document.getElementById('controls');
const wrapper = document.getElementById('stat-block-wrapper');
const statusLine = document.getElementById('status');
const metaLine = document.getElementById('meta');
const spellbookPanel = document.getElementById('spellbook');

async function generate() {
	const query = new URLSearchParams([...new FormData(form)].filter(([, v]) => v !== ''));
	statusLine.textContent = 'Rolling…';
	form.generate.disabled = true;
	try {
		const res = await fetch(`/api/npc?${query}`);
		const body = await res.json();
		if (!res.ok) throw new Error(body.error || res.statusText);
		wrapper.innerHTML = renderNpc(body);
		metaLine.innerHTML = renderMeta(body);
		spellbookPanel.innerHTML = renderSpellbook(body.Spellbook, body.Spellcasting);
		spellbookPanel.hidden = !spellbookPanel.innerHTML;
		statusLine.textContent = '';
	} catch (e) {
		statusLine.textContent = `Couldn't generate an NPC: ${e.message}`;
	} finally {
		form.generate.disabled = false;
	}
}

async function loadOptions() {
	for (let i = 1; i <= 20; i++) form.level.add(new Option(String(i), String(i)));
	const { types, rarities } = await (await fetch('/api/options')).json();
	for (const t of types) form.type.add(new Option(t, t.toLowerCase()));
	for (const r of rarities) form.rarity.add(new Option(r[0].toUpperCase() + r.slice(1), r, false, r === 'uncommon'));
}

form.addEventListener('submit', (e) => {
	e.preventDefault();
	generate();
});
loadOptions().catch((e) => { statusLine.textContent = `Couldn't reach the server: ${e.message}`; });
