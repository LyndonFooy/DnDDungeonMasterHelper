#!/usr/bin/env node
/*
 * NPC statblock web app.
 *
 * Serves App/public/ and a small JSON API over the NPC generator (Generators/NpcGenerator/generateNpc.js). No dependencies.
 *
 *   node App/server.js            # http://localhost:3000
 *   PORT=8080 node App/server.js
 *
 *   GET /api/options                            NPC types and item rarities for the page's drop-downs
 *   GET /api/npc?level=5&type=warrior&items=2   a random NPC (every parameter optional; level defaults to 1–20),
 *                                               plus a Spellbook of its spells' full details (App/spellbook.js)
 *   GET /api/encounter?count=4&levels=20&items=3&faction=bandits
 *                                               a group of NPCs (App/encounter.js): count enemies whose levels sum to
 *                                               `levels`, sharing `items` magic items, each with an Initiative roll.
 *                                               `faction` limits their types and races. Every parameter optional
 *                                               (random, or no faction, when left out).
 *   GET /api/factions                           the factions in Data/Factions/ ({ key, name, description } each)
 *   GET /api/environments                       the environments in Data/Environments/ ({ key, name } each)
 *   GET /api/environment?env=desert&roll=twist  a rolled environment (App/environment.js): situation, twist, location
 *                                               and any nested tables they unlock. `roll` rerolls just that one.
 *
 * Pages: / (index), /npc.html (single NPC), /encounter.html (random encounter with initiative tracker).
 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { generateNpc, loadNpcData } = require('../Generators/NpcGenerator/generateNpc.js');
const { RARITIES } = require('../Generators/NpcGenerator/magicItems.js');
const { buildSpellbook } = require('./spellbook.js');
const { buildEncounter } = require('./encounter.js');
const { loadEnvironments, rollEnvironment } = require('./environment.js');
const { loadFactions } = require('./faction.js');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

const data = loadNpcData();
const environments = loadEnvironments();
const factions = loadFactions(data);

function sendJson(res, status, body) {
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
	res.end(JSON.stringify(body));
}

function npcFromQuery(q) {
	const level = q.get('level') ? Number(q.get('level')) : 1 + Math.floor(Math.random() * 20);
	if (!Number.isInteger(level) || level < 1 || level > 20) throw new Error('level must be 1–20');
	const npc = generateNpc({
		level,
		type: q.get('type') || undefined,
		magicItems: Number(q.get('items')) || 0,
		maxRarity: q.get('rarity') || undefined,
		seed: q.get('seed') || undefined,
	}, data);
	return { ...npc, Spellbook: buildSpellbook(npc) };
}

function encounterFromQuery(q) {
	const int = (name) => (q.get(name) ? Number(q.get(name)) : undefined);
	const factionKey = q.get('faction');
	const faction = factionKey ? factions.find((f) => f.key === factionKey) : undefined;
	if (factionKey && !faction) throw new Error(`unknown faction "${factionKey}"`);
	return buildEncounter({ count: int('count'), levels: int('levels'), items: int('items'), faction }, data,
		(npc) => ({ ...npc, Spellbook: buildSpellbook(npc) }));
}

function serveStatic(res, urlPath) {
	const file = path.normalize(path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath));
	if (!file.startsWith(PUBLIC + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
	fs.readFile(file, (err, body) => {
		if (err) return sendJson(res, 404, { error: 'Not found' });
		res.writeHead(200, { 'Content-Type': `${MIME[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` });
		res.end(body);
	});
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, 'http://localhost');
	if (url.pathname === '/api/options') {
		return sendJson(res, 200, { types: data.npcTypes.map((t) => t.name), rarities: RARITIES });
	}
	if (url.pathname === '/api/npc') {
		try {
			return sendJson(res, 200, npcFromQuery(url.searchParams));
		} catch (e) {
			return sendJson(res, 400, { error: e.message });
		}
	}
	if (url.pathname === '/api/encounter') {
		try {
			return sendJson(res, 200, encounterFromQuery(url.searchParams));
		} catch (e) {
			return sendJson(res, 400, { error: e.message });
		}
	}
	if (url.pathname === '/api/factions') {
		return sendJson(res, 200, factions.map(({ key, name, description }) => ({ key, name, description })));
	}
	if (url.pathname === '/api/environments') {
		return sendJson(res, 200, environments.map(({ key, name }) => ({ key, name })));
	}
	if (url.pathname === '/api/environment') {
		const key = url.searchParams.get('env');
		const env = environments.find((e) => e.key === key);
		if (!env) return sendJson(res, 400, { error: `unknown environment "${key}"` });
		try {
			return sendJson(res, 200, rollEnvironment(env, { only: url.searchParams.get('roll') || undefined }));
		} catch (e) {
			return sendJson(res, 400, { error: e.message });
		}
	}
	serveStatic(res, decodeURIComponent(url.pathname));
});

server.listen(PORT, () => console.log(`Random encounter generator running at http://localhost:${PORT}`));
