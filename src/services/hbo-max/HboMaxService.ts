import { Service } from '@models/Service';

export const HboMaxService = new Service({
	id: 'hbo-max',
	name: 'HBO Max',
	homePage: 'https://www.hbomax.com/',
	hostPatterns: ['*://*.hbo.com/*', '*://*.hbomax.com/*', '*://*.max.com/*'],
	hasScrobbler: true,
	hasSync: true,
	hasAutoSync: true,
	limitations: [
		'History sync currently loads episodes from shows listed in My Stuff. Movies and shows absent from that list may not appear.',
	],
});
