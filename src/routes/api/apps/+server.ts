import { json, type RequestHandler } from '@sveltejs/kit';

import { getAggregatedApps } from '$lib/server/aggregator';
import { getServerSettings } from '$lib/server/config';

export const GET: RequestHandler = async () => {
	const payload = await getAggregatedApps();
	const settings = getServerSettings();
	return json(
		{
			...payload,
			showComposeTags: settings.showComposeTags
		},
		{
			headers: {
				'cache-control': 'public, max-age=5'
			}
		}
	);
};

