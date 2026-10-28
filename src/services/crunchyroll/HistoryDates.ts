export { historyDateToUnix } from '@common/HistoryDate';

/** Old cached Date objects may have lost their prototype/value during serialization. */
export function hasCorruptHistoryDates(items: unknown[]): boolean {
	return items.some((item) => {
		if (!item || typeof item !== 'object') return true;
		const row = item as {
			date_played?: unknown;
			panel?: { episode_metadata?: { episode_air_date?: unknown } };
		};
		return [row.date_played, row.panel?.episode_metadata?.episode_air_date].some(
			(value) => value !== null && typeof value === 'object' && !(value instanceof Date)
		);
	});
}
