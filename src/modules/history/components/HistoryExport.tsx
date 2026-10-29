import { _CrunchyrollApi } from '@/crunchyroll/CrunchyrollApi';
import { _HbomaxApi } from '@/hbo-max/HboMaxApi';
import { Cache } from '@common/Cache';
import {
	Button,
	Dialog,
	DialogTitle,
	DialogContent,
	DialogActions,
	Typography,
} from '@mui/material';
import { useState } from 'react';

const cell = (value: unknown): string => {
	let text = value == null ? '' : String(value);
	if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
	return `"${text.replace(/"/g, '""')}"`;
};

export const HistoryExport = (): JSX.Element => {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState(
		'Export all available Crunchyroll and HBO episode history. HBO includes shows in My Stuff only. Cached matches are included without making Trakt requests.'
	);
	const [download, setDownload] = useState('');
	const run = async () => {
		setBusy(true);
		if (download) URL.revokeObjectURL(download);
		setDownload('');
		const rows: unknown[][] = [
			[
				'service',
				'profile',
				'source_id',
				'source_show',
				'source_title',
				'source_season',
				'source_episode',
				'watched_at_utc',
				'source_completed',
				'mapped_type',
				'mapped_show',
				'mapped_title',
				'mapped_season',
				'mapped_episode',
				'trakt_id',
				'tmdb_id',
				'trakt_show_id',
				'tmdb_show_id',
				'match_status',
				'scope',
			],
		];
		try {
			const caches = await Cache.get(['itemsToTraktItems', 'traktItems']);
			const apis = [new _CrunchyrollApi(false), new _HbomaxApi(false)] as const;
			for (const api of apis) {
				const cursors = new Set<string>();
				let count = 0;
				while (!api.hasReachedHistoryEnd) {
					setStatus(`Loading ${api.id}: ${count} rows (${rows.length - 1} total)…`);
					if (api instanceof _CrunchyrollApi) {
						const cursor = api.nextHistoryUrl;
						if (cursors.has(cursor)) throw new Error('Repeated history page');
						cursors.add(cursor);
					}
					const raw = await api.loadHistoryItems('csv-export');
					for (const entry of raw) {
						const isCr = 'panel' in entry;
						const items = isCr
							? await apis[0].convertHistoryItems([entry])
							: await apis[1].convertHistoryItems([entry]);
						const item = items[0];
						if (!item) throw new Error('Could not convert history row');
						const key = caches.itemsToTraktItems.get(item.getDatabaseId());
						const match = key ? caches.traktItems.get(key) : undefined;
						const ep = match?.type === 'episode' ? match : undefined;
						rows.push([
							api.id,
							api.session?.profileName,
							entry.id,
							isCr ? entry.panel.episode_metadata.series_title : entry.showName,
							isCr ? entry.panel.title : entry.attributes.name,
							isCr ? entry.panel.episode_metadata.season_number : entry.attributes.seasonNumber,
							isCr ? entry.panel.episode_metadata.episode_number : entry.attributes.episodeNumber,
							item.watchedAt == null ? '' : new Date(item.watchedAt * 1000).toISOString(),
							isCr ? entry.fully_watched : entry.attributes.viewingHistory.completed,
							match?.type,
							ep?.show.title,
							match?.title,
							ep?.season,
							ep?.number,
							match?.id,
							match?.tmdbId,
							ep?.show.id,
							ep?.show.tmdbId,
							match ? 'cached_match_needs_review' : 'unmatched',
							isCr ? 'available_watch_history' : 'my_stuff_shows_only',
						]);
						count++;
					}
					if (!api.hasReachedHistoryEnd) await new Promise((resolve) => setTimeout(resolve, 500));
				}
			}
			const csv = `\uFEFF${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
			setDownload(URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })));
			setStatus(
				`Ready: ${rows.length - 1} history rows. Both source scans finished. HBO is limited to My Stuff shows. No watched status was changed.`
			);
		} catch {
			setStatus(
				'Export stopped because a source request failed. No incomplete file was downloaded. Retry after the service loads.'
			);
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<Button color="inherit" onClick={() => setOpen(true)}>
				Export CSV
			</Button>
			<Dialog
				open={open}
				onClose={() => {
					if (!busy) setOpen(false);
				}}
			>
				<DialogTitle>Export episode history</DialogTitle>
				<DialogContent>
					<Typography>{status}</Typography>
				</DialogContent>
				<DialogActions>
					<Button disabled={busy} onClick={() => setOpen(false)}>
						Close
					</Button>
					<Button disabled={busy} onClick={() => void run()}>
						Load both histories
					</Button>
					{download && (
						<Button component="a" href={download} download="hbo-crunchyroll-history.csv">
							Download CSV
						</Button>
					)}
				</DialogActions>
			</Dialog>
		</>
	);
};
