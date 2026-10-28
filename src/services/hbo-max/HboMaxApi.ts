import { RequestError } from '@common/RequestError';
import { Requests, RequestDetails } from '@common/Requests';
import { ServiceApi, ServiceApiSession } from '@apis/ServiceApi';
import { EpisodeItem, ScrobbleItem, ScrobbleItemValues } from '@models/Item';
import { historyDateToUnix } from '@common/HistoryDate';
import { Cache, CacheItem } from '@common/Cache';
import { HboMaxService } from '@/hbo-max/HboMaxService';

export interface HbomaxSession extends ServiceApiSession {
	profileName: string;
}

export interface HbomaxHistoryItem {
	id: string;
	showName?: string;
	attributes: {
		seasonNumber: number;
		episodeNumber: number;
		name: string;
		videoType: string;
		airDate: string;
		firstAvailableDate: string;
		viewingHistory: {
			viewed: boolean;
			completed?: boolean;
			lastReportedTimestamp?: string;
		};
	};
	relationships: { show: { data: { id: string; type: string } } };
}

export interface HbomaxProfileData {
	data: { attributes: { profileName: string } };
}

export interface HbomaxRouting {
	homeMarket: string;
	env: string;
	tenant: string;
	domain: string;
}

export interface CachedRouting {
	routing?: HbomaxRouting;
	timestamp: number;
}

// Adapted from upstream PR #463; pagination state is local to each show.
class _HbomaxApi extends ServiceApi {
	public session: HbomaxSession | null = null;
	public hasReachedHistoryEnd = false;
	public showNameMap: Record<string, string> = {};
	public isActivated = false;
	private readonly deviceId = crypto.randomUUID();
	private readonly clientSessionId = crypto.randomUUID();

	private API_URL = 'https://default.any-any.prd.api.hbomax.com';
	private PROFILE_URL = `${this.API_URL}/users/me/profiles/selected`;
	private ALLSHOWS_URL =
		`${this.API_URL}/cms/routes/my-stuff?include=default&decorators=viewingHistory,isFavorite,contentAction,badges&page[items.size]=100`;

	constructor() {
		super(HboMaxService.id);
	}

	private async send(request: RequestDetails): Promise<string> {
		try {
			return await Requests.send({
				...request,
				credentials: 'include',
				headers: {
					'Content-Type': 'application/json',
					'x-disco-client': 'WEB:10.15.7:hbomax:7.14.0',
					'x-device-info': `hbomax/7.14.0 (desktop/desktop; macOS/10.15.7; ${this.deviceId}/${this.clientSessionId})`,
					'x-disco-params': 'realm=bolt,bid=beam,features=ar',
					...request.headers,
				},
			});
		} catch (err) {
			if (err instanceof RequestError) {
				let detail = '';
				try {
					const response = JSON.parse(err.text ?? '{}') as {
						errors?: { code?: string; detail?: string }[];
					};
					detail =
						response.errors?.map((error) => `${error.code}: ${error.detail}`).join('; ') ?? '';
				} catch (_err) {
					/* Non-JSON responses are not logged. */
				}
				console.warn(`HBO Max ${new URL(request.url).pathname}: ${err.status} ${detail}`);
			}
			throw err;
		}
	}

	/* ---------------- API ROUTING ---------------- */

	private async initApiUrl(): Promise<void> {
		const env = 'prd';
		const domain = 'api.hbomax.com';
		const cacheKey = 'servicesData';
		const ttl = 7 * 24 * 60 * 60 * 1000;

		const cacheItem: CacheItem<'servicesData'> | undefined = await Cache.get(cacheKey);
		const cached = cacheItem?.get(this.id) as CachedRouting | undefined;

		if (cached?.routing && Date.now() - cached.timestamp < ttl) {
			this.applyRouting(cached.routing);
			return;
		}

		const bootstrapUrl = `https://default.any-any.${env}.${domain}/session-context/headwaiter/v1/bootstrap`;

		const responseText = await this.send({
			url: bootstrapUrl,
			method: 'POST',
			headers: {
				'x-disco-client': 'WEB:10.15.7:hbomax:7.14.0',
				'x-disco-params': 'realm=bolt,bid=beam,features=ar',
			},
			body: '{}',
		});

		const bootstrap = JSON.parse(responseText) as { routing?: HbomaxRouting };
		if (!bootstrap.routing) throw new Error('Invalid bootstrap');

		this.applyRouting(bootstrap.routing);
		cacheItem?.set(this.id, { routing: bootstrap.routing, timestamp: Date.now() });
		if (cacheItem) await Cache.set({ servicesData: cacheItem });
	}

	private applyRouting(routing: HbomaxRouting): void {
		if (
			!['api.hbomax.com', 'api.max.com'].includes(routing.domain) ||
			![routing.tenant, routing.homeMarket, routing.env].every((part) => /^[a-z0-9-]+$/i.test(part))
		) {
			throw new Error('Invalid HBO Max routing');
		}
		this.API_URL = `https://default.any-${routing.homeMarket}.${routing.env}.${routing.domain}`;
		this.PROFILE_URL = `https://default.${routing.tenant}-${routing.homeMarket}.${routing.env}.${routing.domain}/users/me/profiles/selected`;
		this.ALLSHOWS_URL = `${this.API_URL}/cms/routes/my-stuff?include=default&decorators=viewingHistory,isFavorite,contentAction,badges&page[items.size]=100`;
	}

	/* ---------------- SESSION ---------------- */

	async activate(): Promise<void> {
		try {
			await this.initApiUrl();
			const response = await this.send({ url: this.PROFILE_URL, method: 'GET' });
			const profileData = JSON.parse(response) as HbomaxProfileData;

			const profileName = profileData.data?.attributes?.profileName;
			if (!profileName) throw new Error('No selected HBO Max profile');
			this.session = { profileName };
			this.isActivated = true;
		} catch (err) {
			// Avoid logging request headers or response bodies containing account data.
			const status =
				err && typeof err === 'object' && 'status' in err ? err.status : 'invalid response';
			console.warn('HBO Max activation failed:', status);
			this.isActivated = false;
			this.session = null;
		}
	}

	protected isHistoryCacheValid(): boolean {
		// This endpoint returns the complete available set on every load.
		return false;
	}

	async checkLogin(): Promise<boolean> {
		if (!this.isActivated) await this.activate();
		return !!this.session?.profileName;
	}

	/* ---------------- SHOW LIST ---------------- */

	private async fetchSeriesShowIds(cancelKey: string): Promise<string[]> {
		const responseText = await this.send({ url: this.ALLSHOWS_URL, method: 'GET', cancelKey });

		const allShowsResponse = JSON.parse(responseText) as {
			included?: Array<{ id: string; attributes?: { showType?: string; name?: string } }>;
		};

		const showIds =
			allShowsResponse.included
				?.filter((item) => item.attributes?.showType === 'SERIES')
				.map((item) => {
					if (item.attributes?.name) {
						this.showNameMap[item.id] = item.attributes.name;
					}
					return item.id;
				}) ?? [];

		return showIds;
	}

	/* ---------------- HISTORY PAGING ---------------- */

	async loadHistoryForShow(showId: string, cancelKey = 'default'): Promise<HbomaxHistoryItem[]> {
		const items: HbomaxHistoryItem[] = [];
		let page = 1;
		let totalPages = 1;
		do {
			const params = new URLSearchParams({
				decorators: 'viewingHistory',
				'filter[videoType]': 'EPISODE',
				'filter[show.id]': showId,
				'page[size]': '20',
				'page[number]': String(page),
			});
			const response = JSON.parse(
				await this.send({
					url: `${this.API_URL}/content/videos?${params}`,
					method: 'GET',
					cancelKey,
				})
			) as { data: HbomaxHistoryItem[]; meta?: { totalPages?: number } };
			if (!Array.isArray(response.data)) throw new Error('Invalid HBO Max history response');
			totalPages = response.meta?.totalPages ?? 1;
			if (!Number.isInteger(totalPages) || totalPages < 0)
				throw new Error('Invalid HBO Max page count');
			// The current HBO response can omit the show relationship. The request
			// is scoped to one show, so retain that identity for cache conversion.
			items.push(
				...response.data.map((item) => ({
					...item,
					relationships: { ...item.relationships, show: { data: { id: showId, type: 'show' } } },
				}))
			);
			page++;
		} while (page <= totalPages);
		return items;
	}

	/* ---------------- LOAD ALL HISTORY ---------------- */

	async loadHistoryItems(cancelKey = 'default'): Promise<HbomaxHistoryItem[]> {
		if (!this.isActivated) await this.activate();
		if (!this.session) throw new Error('Invalid API session');

		this.hasReachedHistoryEnd = false;
		const showIds = [...new Set(await this.fetchSeriesShowIds(cancelKey))];

		const allHistoryItems: HbomaxHistoryItem[] = [];
		const concurrency = 5;

		for (let i = 0; i < showIds.length; i += concurrency) {
			const batch = showIds.slice(i, i + concurrency);

			const results = await Promise.all(batch.map((id) => this.loadHistoryForShow(id, cancelKey)));

			for (const items of results) {
				allHistoryItems.push(...items);
			}
		}

		const viewedEpisodes = allHistoryItems.filter(
			(i) => i.attributes.videoType === 'EPISODE' && i.attributes.viewingHistory?.viewed
		);

		viewedEpisodes.sort(
			(a, b) =>
				(historyDateToUnix(b.attributes.viewingHistory?.lastReportedTimestamp) ?? 0) -
				(historyDateToUnix(a.attributes.viewingHistory?.lastReportedTimestamp) ?? 0)
		);
		this.hasReachedHistoryEnd = true;

		return viewedEpisodes.map((item) => ({
			...item,
			showName: this.showNameMap[item.relationships.show.data.id],
		}));
	}

	/* ---------------- CONVERT ---------------- */

	async convertHistoryItems(historyItems: HbomaxHistoryItem[]): Promise<ScrobbleItem[]> {
		const items: ScrobbleItem[] = [];

		for (const ep of historyItems) {
			const showId = ep.relationships.show.data.id ?? '';
			const showName = ep.showName ?? this.showNameMap[showId] ?? '';

			const watchedAt = historyDateToUnix(ep.attributes.viewingHistory?.lastReportedTimestamp);
			const releasedAt = historyDateToUnix(
				ep.attributes.airDate ?? ep.attributes.firstAvailableDate
			);

			items.push(
				new EpisodeItem({
					serviceId: this.id,
					id: ep.id,
					title: ep.attributes.name,
					season: ep.attributes.seasonNumber,
					number: ep.attributes.episodeNumber,
					year: releasedAt === undefined ? undefined : new Date(releasedAt * 1000).getUTCFullYear(),
					watchedAt,
					progress: ep.attributes.viewingHistory?.completed ? 100 : 0,
					show: {
						serviceId: this.id,
						id: showId,
						title: showName,
					},
				})
			);
		}

		return items;
	}

	updateItemFromHistory(item: ScrobbleItemValues, historyItem: HbomaxHistoryItem): void {
		item.watchedAt = historyDateToUnix(
			historyItem.attributes.viewingHistory?.lastReportedTimestamp
		);

		item.progress = historyItem.attributes.viewingHistory?.completed ? 100 : 0;
	}

	isNewHistoryItem(historyItem: HbomaxHistoryItem, lastSync: number): boolean {
		const watchedAt = historyDateToUnix(
			historyItem.attributes.viewingHistory?.lastReportedTimestamp
		);
		return watchedAt === undefined || watchedAt > lastSync;
	}

	getHistoryItemId(historyItem: HbomaxHistoryItem): string {
		return historyItem.id;
	}

	async getItem(_id: string): Promise<ScrobbleItem | null> {
		// Playback metadata is read from the player DOM, including movies.
		return null;
	}
}

export const HboMaxApi = new _HbomaxApi();
