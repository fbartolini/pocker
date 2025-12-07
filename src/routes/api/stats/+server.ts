import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDockerClient } from '$lib/server/docker-client';
import { getServerSettings } from '$lib/server/config';

export const GET: RequestHandler = async () => {
	try {
		const settings = getServerSettings();
		const memoryStats: Record<string, { used: number; available: number }> = {};

		// Fetch memory stats for each source in parallel
		await Promise.all(
			settings.dockerSources.map(async (source) => {
				try {
					const docker = getDockerClient(source);
					
					// Helper to add timeout to Docker API calls
					const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> => {
						return Promise.race([
							promise,
							new Promise<never>((_, reject) => {
								setTimeout(() => reject(new Error(`${errorMessage} (timeout after ${timeoutMs}ms)`)), timeoutMs);
							})
						]);
					};
					
					const containers = await withTimeout(
						docker.listContainers({ all: true }),
						settings.dockerApiTimeoutMs,
						`Docker API timeout for ${source.name} (listContainers)`
					);
					const runningContainers = containers.filter((c) => c.State === 'running');

					if (runningContainers.length === 0) {
						return;
					}

					// Fetch stats for all running containers in parallel with timeout
					// Process all containers (no limit) since this is async
					const statsPromises = runningContainers.map(async (container) => {
						try {
							const containerObj = docker.getContainer(container.Id);

							// Use Promise.race with timeout to prevent hanging
							// Since this is async, we can afford a longer timeout (10 seconds)
							const statsPromise = containerObj.stats({ stream: false });
							const timeoutPromise = new Promise<never>((_, reject) => {
								setTimeout(() => reject(new Error('Timeout')), 10000);
							});

							const stats = await Promise.race([statsPromise, timeoutPromise]) as any;

							// Calculate RSS from cgroup stats
							if (stats.memory_stats?.usage) {
								const stats_obj = stats.memory_stats.stats;

								if (stats_obj) {
									// Calculate RSS: active_anon + inactive_anon + kernel_stack + slab
									const activeAnon = stats_obj.active_anon || 0;
									const inactiveAnon = stats_obj.inactive_anon || 0;
									const kernelStack = stats_obj.kernel_stack || 0;
									const slab = stats_obj.slab || 0;

									const rss = activeAnon + inactiveAnon + kernelStack + slab;

									if (rss > 0) {
										return rss;
									} else {
										// Fallback: usage minus file cache
										const fileCache = (stats_obj.active_file || 0) + (stats_obj.inactive_file || 0);
										return Math.max(0, stats.memory_stats.usage - fileCache);
									}
								} else {
									return stats.memory_stats.usage;
								}
							} else if (stats.memory_stats?.max_usage) {
								return stats.memory_stats.max_usage;
							}

							return 0;
						} catch (error) {
							// Timeout or error - skip this container
							return 0;
						}
					});

					const containerMemoryValues = await Promise.all(statsPromises);
					const totalContainerMemory = containerMemoryValues.reduce((sum, val) => sum + val, 0);

					// Get total memory from docker.info() to calculate available
					const info = await withTimeout(
						docker.info(),
						settings.dockerApiTimeoutMs,
						`Docker API timeout for ${source.name} (info)`
					);
					const memoryTotal =
						(info.MemTotal && typeof info.MemTotal === 'number' && info.MemTotal > 0
							? info.MemTotal
							: info.MemoryTotal && typeof info.MemoryTotal === 'number' && info.MemoryTotal > 0
								? info.MemoryTotal
								: 0) || 0;

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

