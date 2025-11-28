import type { PageLoad } from './$types';
import type { AppsResponse } from '$lib/types';
import { env as publicEnv } from '$env/dynamic/public';

export const load: PageLoad = async ({ fetch, url }) => {
	const response = await fetch('/api/apps');
	const data: AppsResponse = await response.json();
	const embed = url.searchParams.get('embed') === '1';
	const maxWidth = (publicEnv.PUBLIC_MAX_WIDTH ?? '').trim() || null;

	return {
		initialData: data,
		embed,
		maxWidth
	};
};

