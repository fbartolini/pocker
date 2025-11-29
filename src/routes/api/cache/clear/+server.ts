import { json, type RequestHandler } from '@sveltejs/kit';
import { clearVersionCache } from '$lib/server/metadata';

export const POST: RequestHandler = async () => {
	try {
		clearVersionCache();
		return json({ success: true, message: 'Version cache cleared' });
	} catch (error) {
		console.error('[cache] Error clearing cache:', error);
		return json({ success: false, error: 'Failed to clear cache' }, { status: 500 });
	}
};

