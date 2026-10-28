/** Parse API/cache dates without inventing a watch time for missing or malformed values. */
export function historyDateToUnix(value: unknown): number | undefined {
	let milliseconds: number;
	if (value instanceof Date) {
		milliseconds = value.getTime();
	} else if (typeof value === 'string' && value.trim()) {
		milliseconds = Date.parse(value);
	} else if (typeof value === 'number' && Number.isFinite(value)) {
		milliseconds = value >= 1e10 ? value : value * 1000;
	} else {
		return undefined;
	}
	return Number.isFinite(milliseconds) ? Math.trunc(milliseconds / 1000) : undefined;
}

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
