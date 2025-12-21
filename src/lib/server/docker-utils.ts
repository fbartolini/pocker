import type Docker from 'dockerode';

import type { SourceConfig } from './config';
import { getDockerClient, withTimeout } from './docker-client';
import { getServerSettings } from './config';

// Type for Docker info response - minimal interface based on what we use
interface DockerInfo {
	MemTotal?: number | null;
	MemoryTotal?: number | string | null;
	MemAvailable?: number | null;
	MemFree?: number | null;
	ServerVersion?: string;
	NCPU?: number;
	Images?: number;
	OperatingSystem?: string;
	KernelVersion?: string;
	Architecture?: string;
	Driver?: string;
	DriverStatus?: Array<[string, string]>;
	PoolBlocksize?: number;
	PoolBlocksUsed?: number;
	PoolBlocksTotal?: number;
}

/**
 * Extracts container name from container info
 */
export const getContainerName = (container: Docker.ContainerInfo): string => {
	return container.Names?.[0]?.replace(/^\//, '') ?? container.Id.slice(0, 12);
};

/**
 * Calculates memory usage from container stats
 * Returns RSS (Resident Set Size) if available, otherwise falls back to usage
 */
export const calculateMemoryUsage = (stats: any): number => {
	if (!stats.memory_stats?.usage) {
		return 0;
	}

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
	}

	// Fallback to max_usage if available, otherwise usage
	return stats.memory_stats.max_usage || stats.memory_stats.usage;
};

/**
 * Extracts total memory from Docker info response
 */
export const extractMemoryTotal = (info: DockerInfo): number => {
	// Priority 1: MemTotal (in bytes)
	if (info.MemTotal !== undefined && info.MemTotal !== null && typeof info.MemTotal === 'number' && info.MemTotal > 0) {
		return info.MemTotal;
	}
	
	// Priority 2: MemoryTotal (bytes, Docker daemon's view)
	if (info.MemoryTotal !== undefined && info.MemoryTotal !== null) {
		if (typeof info.MemoryTotal === 'number' && info.MemoryTotal > 0) {
			return info.MemoryTotal;
		}
	}
	
	return 0;
};

/**
 * Fetches container stats with timeout
 */
export const getContainerStats = async (
	source: SourceConfig,
	containerId: string,
	timeoutMs: number
): Promise<any> => {
	const docker = getDockerClient(source);
	const container = docker.getContainer(containerId);
	
	return withTimeout(
		container.stats({ stream: false }),
		timeoutMs,
		`Docker API timeout for ${source.name} (container stats)`
	);
};

/**
 * Fetches Docker system info with timeout
 */
export const getDockerInfo = async (
	source: SourceConfig,
	timeoutMs: number
): Promise<DockerInfo> => {
	const docker = getDockerClient(source);
	return withTimeout(
		docker.info(),
		timeoutMs,
		`Docker API timeout for ${source.name} (info)`
	);
};

/**
 * Finds a source by name
 */
export const findSource = (sourceId: string): SourceConfig | null => {
	const settings = getServerSettings();
	return settings.dockerSources.find(s => s.name === sourceId) ?? null;
};

