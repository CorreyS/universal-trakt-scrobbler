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
const dates = loadSource('src/services/crunchyroll/HistoryDates.ts');
/** @param {any} base */
function makeApi(base = undefined) {
	class ServiceApi {
		/** @param {string} id */
		constructor(id) {
			this.id = id;
			this.nextHistoryUrl = '';
		}
	}
	class Item {
		/** @param {Record<string, unknown>} values */
		constructor(values) {
			Object.assign(this, values);
		}
		getDatabaseId() {
			return 'fixture';
		}
		save() {
			return { ...this };
		}
	}
	return loadSource('src/services/crunchyroll/CrunchyrollApi.ts', {
		'@apis/ServiceApi': { ServiceApi: base || ServiceApi },
		'@common/Requests': { Requests: {}, withHeaders: () => ({}) },
		'@models/Item': { EpisodeItem: Item, MovieItem: Item },
		'@/crunchyroll/CrunchyrollService': { CrunchyrollService: { id: 'crunchyroll' } },
		'./HistoryDates': dates,
	}).CrunchyrollApi;
}
/** @param {unknown} date @returns {any} */
function historyItem(date) {
	return {
		id: 'episode-1',
		date_played: date,
		fully_watched: true,
		playhead: 120,
		panel: {
			title: 'Episode title',
			episode_metadata: {
				series_id: 'series',
				series_title: 'Series',
				series_slug_title: 'series',
				season_title: 'Season 1',
				season_slug_title: 'series-season-1',
				season_number: 1,
				episode_number: 1,
				episode_air_date: '2025-01-01T00:00:00Z',
				duration_ms: 1200000,
			},
		},
	};
}

test('accepts fresh, serialized, and numeric dates without changing their instant', () => {
	const iso = '2025-05-25T23:31:18Z';
	const seconds = Date.parse(iso) / 1000;
	for (const date of [iso, new Date(iso), seconds, seconds * 1000]) {
		assert.equal(dates.historyDateToUnix(date), seconds);
	}
});
test('invalid dates remain missing and never become the current time', async () => {
	const api = makeApi();
	for (const date of [
		undefined,
		null,
		{},
		[],
		false,
		'',
		'bad-date',
		NaN,
		Infinity,
		new Date(NaN),
	]) {
		assert.equal(dates.historyDateToUnix(date), undefined);
		const [item] = await api.convertHistoryItems([historyItem(date)]);
		assert.equal(item.watchedAt, undefined);
		assert.equal(api.isNewHistoryItem(historyItem(date), 1), true);
	}
});
test('rejects legacy corrupted cache but accepts JSON-safe cache dates', () => {
	const api = makeApi();
	assert.equal(api.isHistoryCacheValid({ items: [historyItem({})] }), false);
	const row = historyItem('2025-05-25T23:31:18Z');
	assert.equal(api.isHistoryCacheValid({ items: [row] }), true);
	row.panel.episode_metadata.episode_air_date = {};
	assert.equal(api.isHistoryCacheValid({ items: [row] }), false);
});
test('fresh history survives a cache round trip and preserves pagination and watch dates', async () => {
	const api = makeApi();
	const row = historyItem('2025-05-25T23:31:18Z');
	api.checkLogin = async () => true;
	api.session = { accountId: 'fixture', profileName: 'fixture' };
	api.authRequests = {
		send: async () => JSON.stringify({ items: [row], next_page: '/next-page' }),
	};
	const rows = await api.loadHistoryItems();
	assert.equal(typeof rows[0].date_played, 'string');
	assert.equal(typeof rows[0].panel.episode_metadata.episode_air_date, 'string');
	assert.equal(api.nextHistoryUrl, 'https://www.crunchyroll.com/next-page');
	const [item] = await api.convertHistoryItems(JSON.parse(JSON.stringify(rows)));
	assert.equal(item.watchedAt, Date.parse(row.date_played) / 1000);
	assert.equal(item.year, 2025);
	assert.equal(item.progress, 100);
	assert.equal(api.isNewHistoryItem(rows[0], item.watchedAt), false);
});
test('only refreshes authentication when absent or expired', async () => {
	const api = makeApi();
	let refreshes = 0;
	api.activate = async () => {
		refreshes++;
		api.isActivated = true;
		api.session = { profileName: 'fixture', tokenExpirationDate: new Date(Date.now() + 60000) };
	};
	await api.checkLogin();
	await api.checkLogin();
	assert.equal(refreshes, 1);
	api.session.tokenExpirationDate = new Date(Date.now() - 1);
	await api.checkLogin();
	assert.equal(refreshes, 2);
});

test('loadHistory refetches damaged cached rows instead of reusing them', async () => {
	const rows = [
		historyItem('2025-05-25T23:31:18Z'),
		{ ...historyItem('2025-05-24T23:31:18Z'), id: 'episode-2' },
	];
	const caches = {
		history: new Map([
			[
				'crunchyroll',
				{
					profileName: 'fixture',
					items: rows.map((row) => ({ ...row, date_played: {} })),
					nextUrl: 'https://www.crunchyroll.com/stale',
				},
			],
		]),
		historyItemsToItems: new Map(),
		items: new Map(),
	};
	const store = {
		data: { hasReachedEnd: false, hasReachedLastSyncDate: false },
		setData: async () => {},
	};
	const { ServiceApi } = loadSource('src/apis/ServiceApi.ts', {
		'@apis/TraktSearch': {},
		'@apis/TraktSync': {},
		'@common/Cache': { Cache: { get: async () => caches, set: async () => {} } },
		'@common/RequestError': { RequestError: Error },
		'@common/Shared': { Shared: { errors: { validate: () => false } } },
		'@models/Item': { createScrobbleItem: (/** @type {any} */ item) => item },
		'@stores/SyncStore': { getSyncStore: () => store },
	});
	const api = makeApi(ServiceApi);
	api.checkLogin = async () => true;
	api.session = { accountId: 'fixture', profileName: 'fixture' };
	let requests = 0;
	api.authRequests = {
		send: async (/** @type {{url: string}} */ request) => {
			assert.notEqual(request.url, 'https://www.crunchyroll.com/stale');
			return JSON.stringify({
				items: [rows[requests++]],
				...(requests === 1 ? { next_page: '/page-2' } : {}),
			});
		},
	};
	const items = await api.loadHistory(2, 0, '');
	assert.equal(requests, 2);
	assert.deepEqual(
		items.map((/** @type {any} */ item) => item.watchedAt),
		rows.map((row) => Date.parse(row.date_played) / 1000)
	);
	assert.equal(caches.history.get('crunchyroll')?.items[1].date_played, rows[1].date_played);
});
