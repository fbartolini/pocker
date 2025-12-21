import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listContainers } from '$lib/server/docker-client';
import { getServerSettings } from '$lib/server/config';
import { findSource, getContainerName, getContainerStats, getDockerInfo, calculateMemoryUsage, extractMemoryTotal } from '$lib/server/docker-utils';

export const GET: RequestHandler = async ({ params }) => {
	try {
		const { sourceId } = params;
		const settings = getServerSettings();
		
		const source = findSource(sourceId);
		if (!source) {
			return json({ error: 'Source not found' }, { status: 404 });
		}
		
		const containers = await listContainers(source, settings.dockerApiTimeoutMs);
		const runningContainers = containers.filter((c) => c.State === 'running');
		
		// Get container memory usage for all running containers
		const containerMemoryPromises = runningContainers.map(async (container) => {
			try {
				// Use shorter timeout for individual container stats (3 seconds)
				const stats = await getContainerStats(source, container.Id, 3000) as any;
				
				const memoryUsage = calculateMemoryUsage(stats);
				
				return {
					name: getContainerName(container),
					memory: memoryUsage
				};
			} catch (error) {
				return null;
			}
		});
		
		const allContainerMemories = (await Promise.all(containerMemoryPromises))
			.filter((c): c is { name: string; memory: number } => c !== null && c.memory > 0)
			.sort((a, b) => b.memory - a.memory);
		
		// Top 5 for tooltip display
		const topContainers = allContainerMemories.slice(0, 5);
		
		// Get system info
		const info = await getDockerInfo(source, settings.dockerApiTimeoutMs);
		const memoryTotal = extractMemoryTotal(info);
		
		return json({
			topContainers,
			allContainers: allContainerMemories, // All containers for pie chart
			memoryTotal,
			totalContainers: containers.length,
			runningContainers: runningContainers.length
		});
	} catch (error) {
		console.warn(`[server-details] Error fetching details for ${params.sourceId}:`, error);
		return json({ error: 'Failed to fetch details' }, { status: 500 });
	}
};

