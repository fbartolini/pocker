import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAggregatedApps } from '$lib/server/aggregator';
import { resolveVersionFromDigest } from '$lib/server/metadata';
import { parseImageReference } from '$lib/server/image';

export const GET: RequestHandler = async () => {
	try {
		const payload = await getAggregatedApps();
		const versionMap: Record<string, string | null> = {};

		// Collect all containers that need version resolution
		const versionPromises: Array<Promise<void>> = [];

		for (const app of payload.apps) {
			for (const container of app.containers) {
				// Only resolve if we have a digest
				if (container.imageDigest) {
					// Use the app's image reference (which includes registry info)
					const ref = parseImageReference(app.image);
					const currentVersion = container.version;
					
					// Check if current version is a digest or non-semantic tag (like "latest", "nightly")
					// Also resolve if version is missing or if it's a non-semantic label
					const isDigest = currentVersion ? /^[a-f0-9]{12,}$/i.test(currentVersion) : false;
					const isSemanticVersion = currentVersion ? /^v?\d+\.\d+\.\d+/.test(currentVersion) : false;
					const isNonSemantic = !currentVersion || currentVersion === 'latest' || currentVersion === 'nightly' || isDigest || !isSemanticVersion;
					
					// Resolve if version is non-semantic or missing
					// This ensures we get semantic versions even if labels have "nightly" etc.
					if (isNonSemantic) {
						const containerKey = `${container.sourceId}:${container.containerId}`;
						versionPromises.push(
							resolveVersionFromDigest(ref, container.imageDigest).then((resolvedVersion) => {
								if (resolvedVersion) {
									versionMap[containerKey] = resolvedVersion;
								}
							}).catch((error) => {
								// Log error for debugging but don't fail
								console.warn(`[versions] Failed to resolve version for ${containerKey}:`, error);
							})
						);
					}
				}
			}
		}

		// Resolve all versions in parallel (with reasonable timeout)
		await Promise.race([
			Promise.all(versionPromises),
			new Promise((resolve) => setTimeout(resolve, 30000)) // 30 second timeout
		]);

		return json({ versions: versionMap });
	} catch (error) {
		console.error('[versions] Error resolving versions:', error);
		return json({ versions: {} }, { status: 500 });
	}
};

