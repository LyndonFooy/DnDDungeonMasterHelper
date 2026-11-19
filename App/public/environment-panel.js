/*
 * Environment panel (left side of the encounter page): pick an environment and roll its situation, twist and location
 * from /api/environment. Those results stay fixed until rerolled (all at once, or one at a time with ↻). Any nested
 * table a result unlocks (Storm Rolls for "Storm Incoming", Obelisk Rolls for "Obelisk of the Lost") is shown whole
 * under it, for rolling during play; its Roll button just highlights a row.
 *
 * Wrapped in a block so its names don't clash with encounter-page.js (classic scripts share one global scope).
 */
'use strict';
{
	const form = document.getElementById('env-form');
	const select = document.getElementById('env-select');
	const rollButton = document.getElementById('env-roll');
	const status = document.getElementById('env-status');
	const output = document.getElementById('env-result');
	const STORE_KEY = 'environment-panel:env';

	let current = null; // { key, name, rolls: [...] } from the API

	const dieLabel = (die) => String(die).replace(/^1d/, 'd');
	const faces = (roll) => (Array.isArray(roll) ? roll : [roll, roll]);
	const faceLabel = (roll) => { const [lo, hi] = faces(roll); return lo === hi ? String(lo) : `${lo}–${hi}`; };

	function remember(key) { try { localStorage.setItem(STORE_KEY, key); } catch { /* storage unavailable */ } }
	function recall() { try { return localStorage.getItem(STORE_KEY); } catch { return null; } }

	async function getJson(url) {
		const res = await fetch(url);
		const body = await res.json();
		if (!res.ok) throw new Error(body.error || res.statusText);
		return body;
	}

	function effectHtml(fx) {
		const bonus = fx.bonus ? ` ${fx.bonus < 0 ? '−' : '+'} ${Math.abs(fx.bonus)}` : '';
		const times = fx.multiplier !== 1 ? ` × ${fx.multiplier}` : '';
		const detail = `${fx.dice}: ${fx.rolls.join(' + ')}${bonus}${times}`;
		return `<li><b>${esc(fx.label)}:</b> ${fx.value}${fx.unit ? ` ${esc(fx.unit)}` : ''}
			<span class="env-fx-roll">(${esc(detail)})</span></li>`;
	}

	function tableHtml(t) {
		const rows = t.entries.map((e) => {
			const [lo, hi] = faces(e.roll);
			return `<tr data-lo="${lo}" data-hi="${hi}">
				<th scope="row">${faceLabel(e.roll)}</th>
				<td><b>${esc(e.name)}</b>${e.description ? ` – ${esc(e.description)}` : ''}</td>
			</tr>`;
		}).join('');
		return `<details class="env-table" open>
			<summary><span class="env-table-name">${esc(t.name)}</span><span class="env-die">${dieLabel(t.die)}</span></summary>
			${t.usage ? `<p class="env-usage">${esc(t.usage)}</p>` : ''}
			<table><tbody>${rows}</tbody></table>
			<div class="env-table-foot">
				<button type="button" class="env-table-roll" data-die="${esc(t.die)}">Roll ${dieLabel(t.die)}</button>
				<span class="env-table-result" aria-live="polite"></span>
			</div>
		</details>`;
	}

	// `shown` holds the nested tables already on the panel, so a table unlocked twice appears once.
	function rollHtml(r, shown) {
		const tables = r.tables.filter((t) => !shown.has(t.key));
		for (const t of tables) shown.add(t.key);
		const effects = r.result.effects.length ? `<ul class="env-effects">${r.result.effects.map(effectHtml).join('')}</ul>` : '';
		return `<section class="env-roll">
			<div class="env-roll-head">
				<span class="env-roll-name">${esc(r.name)}</span>
				<span class="env-die" title="Rolled ${r.roll} on ${esc(r.die)}">${dieLabel(r.die)} · ${r.roll}</span>
				<button type="button" class="env-reroll" data-key="${esc(r.key)}" title="Reroll ${esc(r.name.toLowerCase())}" aria-label="Reroll ${esc(r.name.toLowerCase())}">&#x21bb;</button>
			</div>
			<h3 class="env-result-name">${esc(r.result.name)}</h3>
			${r.result.description ? `<p class="env-desc">${esc(r.result.description)}</p>` : ''}
			${effects}
			${tables.map(tableHtml).join('')}
		</section>`;
	}

	function render() {
		const shown = new Set();
		output.innerHTML = current ? current.rolls.map((r) => rollHtml(r, shown)).join('') : '';
	}

	function setBusy(busy) {
		rollButton.disabled = busy;
		for (const b of output.querySelectorAll('.env-reroll')) b.disabled = busy;
	}

	async function rollAll() {
		const key = select.value;
		status.textContent = 'Rolling…';
		setBusy(true);
		try {
			current = await getJson(`/api/environment?env=${encodeURIComponent(key)}`);
			render();
			status.textContent = '';
		} catch (e) {
			status.textContent = `Couldn't roll the environment: ${e.message}`;
		} finally {
			setBusy(false);
		}
	}

	async function rerollOne(rollKey) {
		if (!current) return;
		setBusy(true);
		try {
			const body = await getJson(`/api/environment?env=${encodeURIComponent(current.key)}&roll=${encodeURIComponent(rollKey)}`);
			const i = current.rolls.findIndex((r) => r.key === rollKey);
			if (i >= 0 && body.rolls[0]) current.rolls[i] = body.rolls[0];
			render();
			status.textContent = '';
		} catch (e) {
			status.textContent = `Couldn't reroll: ${e.message}`;
		} finally {
			setBusy(false);
		}
	}

	// A nested table's Roll button: picks a face and highlights the matching row.
	function rollNested(button) {
		const details = button.closest('.env-table');
		const sides = Number(String(button.dataset.die).replace(/^1d/, ''));
		const face = 1 + Math.floor(Math.random() * sides);
		let hit = null;
		for (const row of details.querySelectorAll('tr')) {
			const on = face >= Number(row.dataset.lo) && face <= Number(row.dataset.hi);
			row.classList.toggle('rolled', on);
			if (on) hit = row;
		}
		details.querySelector('.env-table-result').textContent = `Rolled ${face}${hit ? `: ${hit.querySelector('b').textContent}` : ''}`;
	}

	output.addEventListener('click', (e) => {
		const reroll = e.target.closest('.env-reroll');
		if (reroll) return rerollOne(reroll.dataset.key);
		const nested = e.target.closest('.env-table-roll');
		if (nested) rollNested(nested);
	});

	form.addEventListener('submit', (e) => {
		e.preventDefault();
		rollAll();
	});

	select.addEventListener('change', () => {
		remember(select.value);
		rollAll();
	});

	(async function init() {
		try {
			const envs = await getJson('/api/environments');
			if (!envs.length) throw new Error('no environments in Data/Environments');
			select.innerHTML = envs.map((e) => `<option value="${esc(e.key)}">${esc(e.name)}</option>`).join('');
			const saved = recall();
			if (saved && envs.some((e) => e.key === saved)) select.value = saved;
			select.disabled = false;
			await rollAll();
		} catch (e) {
			select.innerHTML = '<option>Unavailable</option>';
			status.textContent = `Couldn't load environments: ${e.message}`;
		}
	})();
}
