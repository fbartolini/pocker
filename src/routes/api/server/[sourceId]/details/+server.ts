import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDockerClient } from '$lib/server/docker-client';
import { getServerSettings } from '$lib/server/config';

export const GET: RequestHandler = async ({ params }) => {
	try {
		const { sourceId } = params;
		const settings = getServerSettings();
		
		// Find the source by name
		const source = settings.dockerSources.find(s => s.name === sourceId);
		if (!source) {
			return json({ error: 'Source not found' }, { status: 404 });
		}
		
		const docker = getDockerClient(source);
		const containers = await docker.listContainers({ all: true });
		const runningContainers = containers.filter((c) => c.State === 'running');
		
		// Get container memory usage for top containers
		const containerMemoryPromises = runningContainers.slice(0, 10).map(async (container) => {
			try {
				const containerObj = docker.getContainer(container.Id);
				const statsPromise = containerObj.stats({ stream: false });
				const timeoutPromise = new Promise<never>((_, reject) => {
					setTimeout(() => reject(new Error('Timeout')), 3000);
				});
				
				const stats = await Promise.race([statsPromise, timeoutPromise]) as any;
				
				let memoryUsage = 0;
				if (stats.memory_stats?.usage && stats.memory_stats?.stats) {
					const stats_obj = stats.memory_stats.stats;
					const activeAnon = stats_obj.active_anon || 0;
					const inactiveAnon = stats_obj.inactive_anon || 0;
					const kernelStack = stats_obj.kernel_stack || 0;
					const slab = stats_obj.slab || 0;
					const rss = activeAnon + inactiveAnon + kernelStack + slab;
					if (rss > 0) {
						memoryUsage = rss;
					} else {
						memoryUsage = stats.memory_stats.usage;
					}
				}
				
				return {
					name: container.Names?.[0]?.replace(/^\//, '') || container.Id.slice(0, 12),
					memory: memoryUsage
				};
			} catch (error) {
				return null;
			}
		});
		
		const containerMemories = (await Promise.all(containerMemoryPromises))
			.filter((c): c is { name: string; memory: number } => c !== null && c.memory > 0)
			.sort((a, b) => b.memory - a.memory)
			.slice(0, 5); // Top 5 by memory
		
		// Get system info
		const info = await docker.info();
		const memoryTotal =
			(info.MemTotal && typeof info.MemTotal === 'number' && info.MemTotal > 0
				? info.MemTotal
				: info.MemoryTotal && typeof info.MemoryTotal === 'number' && info.MemoryTotal > 0
					? info.MemoryTotal
					: 0) || 0;
		
		return json({
			topContainers: containerMemories,
			memoryTotal,
			totalContainers: containers.length,
			runningContainers: runningContainers.length
		});
	} catch (error) {
		console.warn(`[server-details] Error fetching details for ${params.sourceId}:`, error);
		return json({ error: 'Failed to fetch details' }, { status: 500 });
	}
};

