import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listContainers } from '$lib/server/docker-client';
import { getServerSettings } from '$lib/server/config';
import { getContainerStats, getDockerInfo, calculateMemoryUsage, extractMemoryTotal } from '$lib/server/docker-utils';

export const GET: RequestHandler = async () => {
	try {
		const settings = getServerSettings();
		const memoryStats: Record<string, { used: number; available: number }> = {};

		// Fetch memory stats for each source in parallel
		await Promise.all(
			settings.dockerSources.map(async (source) => {
				try {
					const containers = await listContainers(source, settings.dockerApiTimeoutMs);
					const runningContainers = containers.filter((c) => c.State === 'running');

					if (runningContainers.length === 0) {
						return;
					}

					// Fetch stats for all running containers in parallel with timeout
					// Process all containers (no limit) since this is async
					const statsPromises = runningContainers.map(async (container) => {
						try {
							// Use longer timeout for async processing (10 seconds)
							const stats = await getContainerStats(source, container.Id, 10000) as any;

							return calculateMemoryUsage(stats);
						} catch (error) {
							// Timeout or error - skip this container
							return 0;
						}
					});

					const containerMemoryValues = await Promise.all(statsPromises);
					const totalContainerMemory = containerMemoryValues.reduce((sum, val) => sum + val, 0);

					// Get total memory from docker.info() to calculate available
					const info = await getDockerInfo(source, settings.dockerApiTimeoutMs);
					const memoryTotal = extractMemoryTotal(info);

					if (totalContainerMemory > 0 && memoryTotal > 0) {
						memoryStats[source.name] = {
							used: totalContainerMemory,
							available: memoryTotal - totalContainerMemory
						};
						
						// Debug logging
						const debug = process.env.METADATA_DEBUG === 'true';
						if (debug) {
							console.log(`[stats] Memory calculation for ${source.name}:`, {
								runningContainers: runningContainers.length,
								processed: containerMemoryValues.filter(v => v > 0).length,
								totalContainerMemory: `${(totalContainerMemory / 1024 / 1024 / 1024).toFixed(2)} GB`,
								memoryTotal: `${(memoryTotal / 1024 / 1024 / 1024).toFixed(2)} GB`,
								percentage: `${((totalContainerMemory / memoryTotal) * 100).toFixed(2)}%`
							});
						}
					}
				} catch (error) {
					console.warn(`[stats] Unable to fetch stats for ${source.name}:`, error);
				}
			})
		);

		return json({ memoryStats });
	} catch (error) {
		console.error('[stats] Error fetching container stats:', error);
		return json({ memoryStats: {} }, { status: 500 });
	}
};

