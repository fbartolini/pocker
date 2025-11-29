import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAggregatedApps } from '$lib/server/aggregator';
import { resolveVersionFromDigest } from '$lib/server/metadata';
import { parseImageReference } from '$lib/server/image';
import { isSemanticVersion } from '$lib/utils/version';

export const GET: RequestHandler = async () => {
	try {
		const payload = await getAggregatedApps();
		const versionMap: Record<string, string | null> = {};

		// Collect all containers that need version resolution
		const versionPromises: Array<Promise<void>> = [];

		for (const app of payload.apps) {
			for (const container of app.containers) {
				// Only resolve if we have a digest
				// Use imageDigest from the container instance
				if (container.imageDigest) {
					// Use the app's image reference (which includes registry info)
					const ref = parseImageReference(app.image);
					const currentVersion = container.version;
					
					// Check if current version is a digest or non-semantic tag (like "latest", "nightly", "main")
					// Also resolve if version is missing or if it's a non-semantic label
					const isDigest = currentVersion ? /^[a-f0-9]{12,}$/i.test(currentVersion) : false;
					const currentIsSemantic = isSemanticVersion(currentVersion);
					// Also check for date-based versions like "24.04" (year.month) - these are not semantic versions
					const isDateVersion = currentVersion ? /^\d{2}\.\d{2}$/.test(currentVersion) : false;
					const isNonSemantic = !currentVersion || 
						currentVersion === 'latest' || 
						currentVersion === 'nightly' || 
						currentVersion === 'main' ||
						isDigest || 
						isDateVersion ||
						!currentIsSemantic;
					
					// Resolve if version is non-semantic or missing
					// This ensures we get semantic versions even if labels have "nightly", "main", etc.
					if (isNonSemantic) {
						const containerKey = `${container.sourceId}:${container.containerId}`;
						versionPromises.push(
							resolveVersionFromDigest(ref, container.imageDigest).then((resolvedVersion) => {
								if (resolvedVersion) {
									versionMap[containerKey] = resolvedVersion;
								}
							}).catch((error) => {
								// Silently fail - version resolution is optional
								// Only log in debug mode
								if (process.env.METADATA_DEBUG === 'true') {
									console.warn(`[versions] Failed to resolve version for ${containerKey} (${app.image}):`, error);
								}
							})
						);
					}
				}
			}
		}

		// Resolve all versions in parallel with concurrency limit to avoid overwhelming APIs
		// Process in batches of 10 to prevent too many simultaneous requests
		const CONCURRENCY_LIMIT = 10;
		for (let i = 0; i < versionPromises.length; i += CONCURRENCY_LIMIT) {
			const batch = versionPromises.slice(i, i + CONCURRENCY_LIMIT);
			await Promise.race([
				Promise.all(batch),
				new Promise((resolve) => setTimeout(resolve, 20000)) // 20 second timeout per batch
			]);
		}

		return json({ versions: versionMap });
	} catch (error) {
		console.error('[versions] Error resolving versions:', error);
		return json({ versions: {} }, { status: 500 });
	}
};

