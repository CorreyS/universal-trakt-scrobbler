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
