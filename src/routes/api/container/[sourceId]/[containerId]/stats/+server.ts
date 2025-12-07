import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDockerClient } from '$lib/server/docker-client';
import { getServerSettings } from '$lib/server/config';

export const GET: RequestHandler = async ({ params }) => {
	try {
		const { sourceId, containerId } = params;
		const settings = getServerSettings();
		
		// Find the source by name
		const source = settings.dockerSources.find(s => s.name === sourceId);
		if (!source) {
			return json({ error: 'Source not found' }, { status: 404 });
		}
		
		const docker = getDockerClient(source);
		const container = docker.getContainer(containerId);
		
		// Fetch container stats with timeout
		const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> => {
			return Promise.race([
				promise,
				new Promise<never>((_, reject) => {
					setTimeout(() => reject(new Error(`${errorMessage} (timeout after ${timeoutMs}ms)`)), timeoutMs);
				})
			]);
		};
		
		const stats = await withTimeout(
			container.stats({ stream: false }),
			settings.dockerApiTimeoutMs,
			`Docker API timeout for ${source.name} (container stats)`
		) as any;
		
		// Extract relevant stats
		const result: {
			memory?: { usage: number; limit: number; percent: number };
			cpu?: { percent: number };
			network?: { rx_bytes: number; tx_bytes: number };
			pids?: number;
		} = {};
		
		// Memory stats
		if (stats.memory_stats) {
			const usage = stats.memory_stats.usage || 0;
			const limit = stats.memory_stats.limit || 0;
			
			// Calculate RSS if available
			let memoryUsage = usage;
			if (stats.memory_stats.stats) {
				const stats_obj = stats.memory_stats.stats;
				const activeAnon = stats_obj.active_anon || 0;
				const inactiveAnon = stats_obj.inactive_anon || 0;
				const kernelStack = stats_obj.kernel_stack || 0;
				const slab = stats_obj.slab || 0;
				const rss = activeAnon + inactiveAnon + kernelStack + slab;
				if (rss > 0) {
					memoryUsage = rss;
				}
			}
			
			result.memory = {
				usage: memoryUsage,
				limit: limit,
				percent: limit > 0 ? (memoryUsage / limit) * 100 : 0
			};
		}
		
		// CPU stats
		if (stats.cpu_stats && stats.precpu_stats) {
			const cpuUsage = stats.cpu_stats.cpu_usage;
			const precpuUsage = stats.precpu_stats.cpu_usage;
			
			if (cpuUsage && precpuUsage && 
				typeof cpuUsage.total_usage === 'number' && 
				typeof precpuUsage.total_usage === 'number' &&
				typeof stats.cpu_stats.system_cpu_usage === 'number' &&
				typeof stats.precpu_stats.system_cpu_usage === 'number') {
				
				const cpuDelta = cpuUsage.total_usage - precpuUsage.total_usage;
				const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
				const numCpus = stats.cpu_stats.online_cpus || (cpuUsage.percpu_usage && cpuUsage.percpu_usage.length) || 1;
				
				// CPU percentage calculation: (cpuDelta / systemDelta) * numCpus * 100
				// Handle idle containers (cpuDelta can be 0) and edge cases
				if (systemDelta > 0 && cpuDelta >= 0 && numCpus > 0) {
					const cpuPercent = (cpuDelta / systemDelta) * numCpus * 100;
					// Clamp to reasonable range (0-1000% to handle multi-core systems)
					result.cpu = {
						percent: Math.min(Math.max(cpuPercent, 0), 1000)
					};
				} else if (cpuDelta === 0 || systemDelta <= 0) {
					// Container is idle or system delta is invalid - show 0%
					result.cpu = { percent: 0 };
				}
			} else {
				// Missing required fields - show 0%
				result.cpu = { percent: 0 };
			}
		} else {
			// No CPU stats available - show 0%
			result.cpu = { percent: 0 };
		}
		
		// Network stats
		if (stats.networks) {
			let rxBytes = 0;
			let txBytes = 0;
			Object.values(stats.networks).forEach((net: any) => {
				rxBytes += net.rx_bytes || 0;
				txBytes += net.tx_bytes || 0;
			});
			result.network = {
				rx_bytes: rxBytes,
				tx_bytes: txBytes
			};
		}
		
		// PIDs
		if (stats.pids_stats) {
			result.pids = stats.pids_stats.current || 0;
		}
		
		return json(result);
	} catch (error) {
		console.warn(`[container-stats] Error fetching stats for ${params.containerId}:`, error);
		return json({ error: 'Failed to fetch stats' }, { status: 500 });
	}
};

