const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
/** @param {string} file @param {Record<string, any>} imports @returns {any} */
function loadSource(file, imports = {}) {
	const source = fs.readFileSync(path.join(root, file), 'utf8');
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	});
	const module = { exports: {} };
	new Function('require', 'module', 'exports', outputText)(
		/** @param {string} id */
		(id) => {
			if (!(id in imports)) throw new Error(`Unexpected dependency: ${id}`);
			return imports[id];
		},
		module,
		module.exports
	);
	return module.exports;
}

const dates = loadSource('src/common/HistoryDate.ts');
/** @param {(request: any) => Promise<any>} respond */
function makeApi(respond) {
	class ServiceApi {
		/** @param {string} id */
		constructor(id) {
			this.id = id;
		}
	}
	class Item {
		/** @param {any} values */
		constructor(values) {
			Object.assign(this, values);
		}
	}
	const cache = new Map();
	let saves = 0;
	const api = loadSource('src/services/hbo-max/HboMaxApi.ts', {
		'@apis/ServiceApi': { ServiceApi },
		'@common/Requests': {
			Requests: {
				send: async (/** @type {any} */ request) => JSON.stringify(await respond(request)),
			},
		},
		'@models/Item': { EpisodeItem: Item },
		'@common/HistoryDate': dates,
		'@common/RequestError': { RequestError: class RequestError extends Error {} },
		'@common/Cache': {
			Cache: {
				get: async () => cache,
				set: async () => {
					saves++;
				},
			},
		},
		'@/hbo-max/HboMaxService': { HboMaxService: { id: 'hbo-max' } },
	}).HboMaxApi;
	return { api, cache, saves: () => saves };
}
/** @param {string} show @param {number} page @returns {any} */
function episode(show, page) {
	return {
		id: `${show}-${page}`,
		attributes: {
			seasonNumber: 1,
			episodeNumber: page,
			name: 'Episode',
			videoType: 'EPISODE',
			airDate: '2020-01-01',
			viewingHistory: {
				viewed: true,
				completed: true,
				lastReportedTimestamp: `2026-01-0${page}T00:00:00Z`,
			},
		},
		relationships: { show: { data: { id: show, type: 'show' } } },
	};
}
const routing = { tenant: 'bolt', homeMarket: 'us', env: 'prd', domain: 'api.hbomax.com' };

test('HBO retries failed login and persists new routing', async () => {
	let attempts = 0;
	const { api, cache, saves } = makeApi(async (request) => {
		if (request.method === 'POST') return { routing };
		if (++attempts === 1) throw new Error('Temporary failure');
		return { data: { attributes: { profileName: 'Test Profile' } } };
	});
	assert.equal(await api.checkLogin(), false);
	assert.equal(await api.checkLogin(), true);
	assert.equal(api.session.profileName, 'Test Profile');
	assert.deepEqual(cache.get('hbo-max').routing, routing);
	assert.equal(saves(), 1);
});

test('HBO concurrent shows keep independent pagination and cached titles', async () => {
	/** @type {string[]} */
	const calls = [];
	const { api } = makeApi(async (request) => {
		assert.equal(request.cancelKey, 'history-test');
		const url = new URL(request.url);
		if (url.pathname.includes('my-stuff'))
			return {
				included: ['a', 'b'].map((id) => ({
					id,
					attributes: { showType: 'SERIES', name: `Show ${id}` },
				})),
			};
		assert.equal(url.searchParams.get('page[size]'), '20');
		assert.equal(request.credentials, 'include');
		assert.ok(request.headers['x-device-info']);
		const show = url.searchParams.get('filter[show.id]');
		const page = Number(url.searchParams.get('page[number]'));
		calls.push(`${show}-${page}`);
		// B finishes before A, exposing the original shared-page-state race.
		await new Promise((resolve) => setTimeout(resolve, show === 'a' ? 5 : 0));
		const row = episode(String(show), page);
		delete row.relationships.show;
		return { data: [row], meta: { totalPages: show === 'a' ? 3 : 1 } };
	});
	api.isActivated = true;
	api.session = { profileName: 'Test Profile' };
	const history = await api.loadHistoryItems('history-test');
	assert.deepEqual(calls.sort(), ['a-1', 'a-2', 'a-3', 'b-1']);
	assert.equal(api.hasReachedHistoryEnd, true);
	api.showNameMap = {};
	const converted = await api.convertHistoryItems(JSON.parse(JSON.stringify(history)));
	assert.equal(converted.length, 4);
	assert.equal(converted[0].show.title, 'Show a');
	assert.equal(converted[0].watchedAt, Date.parse('2026-01-03T00:00:00Z') / 1000);
	assert.equal(api.isHistoryCacheValid(), false);
});

test('HBO empty history finishes and failed pages do not mark completion', async () => {
	const empty = makeApi(async () => ({ included: [] })).api;
	empty.isActivated = true;
	empty.session = { profileName: 'Test' };
	assert.deepEqual(await empty.loadHistoryItems(), []);
	assert.equal(empty.hasReachedHistoryEnd, true);
	const broken = makeApi(async (request) => {
		if (request.url.includes('my-stuff'))
			return { included: [{ id: 'a', attributes: { showType: 'SERIES' } }] };
		return { errors: [{ detail: 'Unavailable' }] };
	}).api;
	broken.isActivated = true;
	broken.session = { profileName: 'Test' };
	await assert.rejects(() => broken.loadHistoryItems(), /Invalid HBO Max history/);
	assert.equal(broken.hasReachedHistoryEnd, false);
});

test('HBO never substitutes release dates for missing watch dates', async () => {
	const { api } = makeApi(async () => ({}));
	const row = episode('a', 1);
	delete row.attributes.viewingHistory.lastReportedTimestamp;
	const [item] = await api.convertHistoryItems([row]);
	assert.equal(item.watchedAt, undefined);
	assert.equal(item.year, 2020);
	assert.equal(api.isNewHistoryItem(row, Date.now() / 1000), true);
});
