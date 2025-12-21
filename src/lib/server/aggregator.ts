import type Docker from 'dockerode';

import type { AggregatedApp, AppsResponse, ServerInstance, ServerStats } from '$lib/types';
import { getServerSettings, type SourceConfig } from './config';
import { getDockerClient, listContainers, withTimeout } from './docker-client';
import { getContainerName, extractMemoryTotal } from './docker-utils';
import { friendlyImageName, getImageBase, parseImageReference } from './image';
import { resolveDescription, resolveIcon } from './metadata';
import { compareVersions, isSemanticVersion } from '$lib/utils/version';
import { generateColorForString } from '$lib/utils/colors';

const settings = getServerSettings();

type ContainerPort = NonNullable<Docker.ContainerInfo['Ports']>[number];

type WorkingApp = {
	app: AggregatedApp;
	labels: Record<string, string>;
	iconHint?: string | null;
	descriptionHint?: string | null;
};

const safeLabels = (labels?: Record<string, string>): Record<string, string> => {
	return labels ? { ...labels } : {};
};

const sanitizeUrl = (value?: string | null): string | null => {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (!['http:', 'https:'].includes(url.protocol)) return null;
		return url.toString();
	} catch {
		return null;
	}
};

const buildPortUrl = (port: ContainerPort, sourceEndpoint?: string): string | null => {
	const resolvedPort = port.PublicPort ?? port.PrivatePort;
	if (!resolvedPort) return null;
	
	try {
		// Determine the hostname/IP to use
		let hostname: string;
		if (port.IP && port.IP !== '0.0.0.0' && port.IP !== '::') {
			// Use the IP from the port if it's a valid, specific IP address
			hostname = port.IP;
		} else {
			// If port is bound to 0.0.0.0 (all interfaces), try to get hostname from source endpoint
			// Otherwise default to localhost
			if (sourceEndpoint) {
				try {
					const endpointUrl = new URL(sourceEndpoint);
					hostname = endpointUrl.hostname;
					// Still default to localhost if endpoint hostname is invalid
					if (hostname === '0.0.0.0' || hostname === '::' || !hostname) {
						hostname = 'localhost';
					}
				} catch {
					hostname = 'localhost';
				}
			} else {
				hostname = 'localhost';
			}
		}
		
		// Determine protocol - default to http, but use https for common secure ports
		const protocol = resolvedPort === 443 || resolvedPort === 8443 ? 'https' : 'http';
		
		return `${protocol}://${hostname}:${resolvedPort}`;
	} catch {
		return null;
	}
};

const buildContainerUrl = (
	baseUrl: string | null,
	container: Docker.ContainerInfo,
	labels: Record<string, string>
): string | null => {
	if (!baseUrl) return null;

	try {
		const base = new URL(baseUrl);
		const fullPath = base.pathname + base.hash;

		// Check if this is a Portainer URL (contains #!/ or /docker/)
		if (fullPath.includes('#!/') || fullPath.includes('/docker/')) {
			// Extract the endpoint ID from the URL (usually after #!/)
			// Format: #!/{endpointId}/docker/...
			const endpointMatch = fullPath.match(/#!\/?(\d+)/);
			const endpointId = endpointMatch ? endpointMatch[1] : '1';

			// Construct container-specific URL
			// Format: {origin}/#!/{endpointId}/docker/containers/{containerId}
			// Remove any existing path/hash and construct clean URL
			const containerUrl = `${base.origin}/#!/${endpointId}/docker/containers/${container.Id}`;
			return containerUrl;
		}

		// For other UI types, return the base URL as-is
		return baseUrl;
	} catch {
		return baseUrl;
	}
};

const toServerInstance = (
	source: SourceConfig,
	container: Docker.ContainerInfo
): ServerInstance => {
	const labels = safeLabels(container.Labels);
	const baseUiUrl = sanitizeUrl(source.uiBase);
	
	// Priority: explicit label URL > container-specific URL from base > base URL > port-based URL
	let preferredUrl: string | null = null;
	
	// First, check for explicit container URL label
	const explicitUrl = sanitizeUrl(labels['homelab.url'] ?? labels['app.homepage']);
	if (explicitUrl) {
		preferredUrl = explicitUrl;
	} else if (baseUiUrl) {
		// Build container-specific URL from base (e.g., Portainer container link)
		preferredUrl = buildContainerUrl(baseUiUrl, container, labels);
	}

	// Build port URLs - use source endpoint to determine hostname if available
	const sourceEndpoint = source.endpoint || source.socketPath ? undefined : undefined;
	const ports =
		container.Ports?.filter((port): port is ContainerPort => Boolean(port))
			?.map((port) => ({
				private: port.PrivatePort,
				public: port.PublicPort,
				type: port.Type,
				url: buildPortUrl(port, source.endpoint)
			}))
			// Filter out duplicate ports (same public port and type)
			.filter((port, index, self) => 
				index === self.findIndex(p => p.public === port.public && p.type === port.type)
			) ?? [];

	// Use source color if defined, otherwise generate one based on source name
	const color = source.color ?? generateColorForString(source.name);

	// Extract exit code from Status field (e.g., "Exited (1) 2 hours ago" -> 1)
	// Status format: "Exited (code) time ago" or "Up time"
	let exitCode: number | null = null;
	if (container.State === 'exited' && container.Status) {
		const match = container.Status.match(/Exited \((\d+)\)/);
		if (match) {
			exitCode = parseInt(match[1], 10);
		}
	}

	// Extract image digest for version detection
	// Priority: digest from Image string (@sha256:...) > ImageID
	let imageDigest: string | null = null;
	if (container.Image && container.Image.includes('@sha256:')) {
		const digestMatch = container.Image.match(/@(sha256:[a-f0-9]+)/);
		if (digestMatch) {
			imageDigest = digestMatch[1];
		}
	} else if (container.ImageID && container.ImageID.startsWith('sha256:')) {
		imageDigest = container.ImageID;
	}

	return {
		sourceId: source.name,
		sourceLabel: source.displayName,
		containerId: container.Id,
		containerName: getContainerName(container),
		state: container.State ?? 'unknown',
		exitCode,
		version: labels['org.opencontainers.image.version'],
		imageDigest,
		uiUrl: preferredUrl,
		ports,
		color
	};
};

const resolveAppId = (labels: Record<string, string>, imageBase: string, fallback: string): string => {
	// Priority: homelab.app label (explicit override) > image base (groups by image, not compose service)
	// This ensures containers with the same image are grouped together regardless of compose project
	if (labels['homelab.app']) {
		return labels['homelab.app'];
	}
	// getImageBase already normalizes (lowercase, removes docker.io), but ensure it's a string and trim
	const normalizedBase = String(imageBase || '').trim();
	
	// Always use normalized image base if available (this groups by image, not compose service)
	// This ensures syncthing/syncthing and syncthing/syncthing:latest both become "syncthing/syncthing"
	if (normalizedBase) {
		return normalizedBase;
	}
	
	// Fallback to compose service name only if imageBase is somehow empty
	return (
		labels['com.docker.compose.service'] ??
		labels['com.docker.swarm.service.name'] ??
		fallback
	);
};

const collectTags = (labels: Record<string, string>): string[] => {
	const tagSet = new Set<string>();
	['com.docker.compose.project', 'com.docker.stack.namespace', 'homepage.group', 'homelab.group']
		.map((key) => labels[key])
		.forEach((value) => {
			if (value) {
				value
					.split(',')
					.map((token) => token.trim())
					.filter(Boolean)
					.forEach((token) => tagSet.add(token));
			}
		});
	return Array.from(tagSet);
};

const upsertWorkingApp = (
	map: Map<string, WorkingApp>,
	appId: string,
	payload: {
		appName: string;
		displayName: string;
		image: string;
		labels: Record<string, string>;
		iconHint?: string | null;
		descriptionHint?: string | null;
		instance: ServerInstance;
		version?: string | null;
		tags: string[];
	}
) => {
	if (!map.has(appId)) {
		map.set(appId, {
			app: {
				id: appId,
				name: payload.appName,
				displayName: payload.displayName,
				image: payload.image,
				versions: payload.version ? [payload.version] : [],
				icon: null,
				description: null,
				tags: payload.tags,
				containers: [payload.instance]
			},
			labels: { ...payload.labels },
			iconHint: payload.iconHint,
			descriptionHint: payload.descriptionHint
		});
		return;
	}

	const existing = map.get(appId)!;
	existing.app.containers.push(payload.instance);
	if (payload.version && !existing.app.versions.includes(payload.version)) {
		existing.app.versions.push(payload.version);
	}
	payload.tags.forEach((tag) => {
		if (!existing.app.tags.includes(tag)) {
			existing.app.tags.push(tag);
		}
	});
	if (!existing.iconHint && payload.iconHint) {
		existing.iconHint = payload.iconHint;
	}
	if (!existing.descriptionHint && payload.descriptionHint) {
		existing.descriptionHint = payload.descriptionHint;
	}
};

const fetchContainersForSource = async (source: SourceConfig) => {
	return listContainers(source, settings.dockerApiTimeoutMs);
};

const fetchSystemInfoForSource = async (source: SourceConfig) => {
	try {
		const docker = getDockerClient(source);
		const info = await withTimeout(
			docker.info(),
			settings.dockerApiTimeoutMs,
			`Docker API timeout for ${source.name} (info)`
		);
		
		// Log the raw Docker info response to understand the structure
		// This helps us parse it correctly - enable with METADATA_DEBUG=true
		const debug = process.env.METADATA_DEBUG === 'true';
		if (debug) {
			console.log(`[aggregator] Raw Docker info for ${source.name}:`, JSON.stringify({
				MemoryTotal: info.MemoryTotal,
				MemTotal: info.MemTotal,
				MemAvailable: info.MemAvailable,
				MemFree: info.MemFree,
				Driver: info.Driver,
				DriverStatus: info.DriverStatus,
				ServerVersion: info.ServerVersion
			}, null, 2));
		}
		
		// Extract memory information
		// Docker API returns:
		// - MemoryTotal: Total memory in bytes (number) - Docker daemon's view
		// - MemTotal: Total memory - appears to be in BYTES (not KB as /proc/meminfo would suggest)
		// - MemAvailable: Available memory - appears to be in BYTES
		// - MemFree: Free memory - appears to be in BYTES
		// Note: Despite the name suggesting /proc/meminfo values (which are in KB),
		// Docker's API actually returns these in bytes for consistency
		let memoryTotal = 0;
		let memoryUsed = 0;
		let memoryAvailable = 0;
		
		// Use shared utility for basic memory extraction
		memoryTotal = extractMemoryTotal(info);
		
		// Handle string format if Docker returns MemoryTotal as string (for aggregator's more complex parsing)
		if (memoryTotal === 0 && info.MemoryTotal !== undefined && info.MemoryTotal !== null && typeof info.MemoryTotal === 'string' && info.MemoryTotal.trim()) {
			// Parse string format if Docker returns it as string
			const match = info.MemoryTotal.match(/([\d.]+)\s*(TiB|GiB|MiB|KiB|B|TB|GB|MB|KB)?/i);
			if (match) {
				const value = parseFloat(match[1]);
				const unit = (match[2] || '').toLowerCase();
				if (unit.includes('tib') || unit.includes('tb')) {
					memoryTotal = value * 1024 * 1024 * 1024 * 1024;
				} else if (unit.includes('gib') || unit.includes('gb')) {
					memoryTotal = value * 1024 * 1024 * 1024;
				} else if (unit.includes('mib') || unit.includes('mb')) {
					memoryTotal = value * 1024 * 1024;
				} else if (unit.includes('kib') || unit.includes('kb')) {
					memoryTotal = value * 1024;
				} else {
					// No unit - assume bytes
					memoryTotal = value;
				}
			}
		}
		
		// Calculate used/available memory
		// Docker API returns these in bytes (not KB)
		if (memoryTotal > 0) {
			// MemAvailable is preferred (more accurate, includes cache/buffers that can be freed)
			if (info.MemAvailable !== undefined && info.MemAvailable !== null && typeof info.MemAvailable === 'number' && info.MemAvailable > 0) {
				memoryAvailable = info.MemAvailable; // Already in bytes
				memoryUsed = memoryTotal - memoryAvailable;
			}
			// Fallback to MemFree (less accurate, doesn't account for cache)
			else if (info.MemFree !== undefined && info.MemFree !== null && typeof info.MemFree === 'number' && info.MemFree > 0) {
				memoryAvailable = info.MemFree; // Already in bytes
				memoryUsed = memoryTotal - memoryAvailable;
			}
			// If neither is available, we'll calculate from container stats (done later)
		}
		
		if (debug) {
			console.log(`[aggregator] System info for ${source.name}:`, {
				memory: memoryTotal > 0 ? {
					total: `${(memoryTotal / 1024 / 1024 / 1024).toFixed(2)} GB`,
					used: memoryUsed > 0 ? `${(memoryUsed / 1024 / 1024 / 1024).toFixed(2)} GB` : 'unknown',
					available: memoryAvailable > 0 ? `${(memoryAvailable / 1024 / 1024 / 1024).toFixed(2)} GB` : 'unknown'
				} : 'unknown',
				cpuCount: info.NCPU,
				totalImages: info.Images,
				operatingSystem: info.OperatingSystem,
				kernelVersion: info.KernelVersion,
				architecture: info.Architecture,
				storageDriver: info.Driver,
				dockerVersion: info.ServerVersion
			});
		}
		
		// Extract storage information
		// Priority 1: Use /system/df endpoint (requires SYSTEM=1 in socket proxy)
		// This is much faster and more accurate than parsing DriverStatus
		let storageTotal = 0;
		let storageUsed = 0;
		let storageAvailable = 0;
		let dockerStorageImages = 0;
		let dockerStorageContainers = 0;
		let dockerStorageVolumes = 0;
		
		try {
			// Try to get storage info from /system/df endpoint
			// This endpoint requires SYSTEM=1 in docker-socket-proxy
			// Use docker.df() if available, otherwise fall back to manual dial
			let dfResponse: any;
			if (typeof (docker as any).df === 'function') {
				dfResponse = await withTimeout(
					(docker as any).df(),
					settings.dockerApiTimeoutMs,
					`Docker API timeout for ${source.name} (df)`
				);
			} else {
				dfResponse = await withTimeout(
					new Promise<any>((resolve, reject) => {
						docker.modem.dial(
							{
								path: '/system/df',
								method: 'GET',
								statusCodes: {
									200: true,
									400: true,
									500: true
								}
							},
							(err: Error | null, data: any) => {
								if (err) reject(err);
								else resolve(data);
							}
						);
					}),
					settings.dockerApiTimeoutMs,
					`Docker API timeout for ${source.name} (df)`
				);
			}
			
			if (dfResponse && typeof dfResponse === 'object') {
				if (debug) {
					console.log(`[aggregator] /system/df response for ${source.name}:`, JSON.stringify(dfResponse, null, 2).substring(0, 500));
				}
				
				// Extract Docker storage breakdown
				if (dfResponse.ImageUsage && dfResponse.ImageUsage.TotalSize) {
					dockerStorageImages = dfResponse.ImageUsage.TotalSize;
				} else if (dfResponse.LayersSize) {
					dockerStorageImages = dfResponse.LayersSize;
				}
				
				if (dfResponse.ContainerUsage && dfResponse.ContainerUsage.TotalSize) {
					dockerStorageContainers = dfResponse.ContainerUsage.TotalSize;
				}
				
				if (dfResponse.VolumeUsage && dfResponse.VolumeUsage.TotalSize) {
					dockerStorageVolumes = dfResponse.VolumeUsage.TotalSize;
				}
				
				// Sum up all Docker storage usage for total disk storage calculation
				let totalDockerStorage = dockerStorageImages + dockerStorageContainers + dockerStorageVolumes;
				
				// Also check BuildCache if available
				if (dfResponse.BuildCache && Array.isArray(dfResponse.BuildCache)) {
					dfResponse.BuildCache.forEach((cache: any) => {
						if (cache.Size) totalDockerStorage += cache.Size;
					});
				}
				
				if (totalDockerStorage > 0) {
					storageUsed = totalDockerStorage;
					// Note: /system/df doesn't provide total disk space, only Docker usage
					// We'll use this as used storage, but won't have total/available
					if (debug) {
						console.log(`[aggregator] Storage from /system/df for ${source.name}:`, {
							used: `${(storageUsed / 1024 / 1024 / 1024).toFixed(2)} GB`,
							images: `${(dockerStorageImages / 1024 / 1024 / 1024).toFixed(2)} GB`,
							containers: `${(dockerStorageContainers / 1024 / 1024 / 1024).toFixed(2)} GB`,
							volumes: `${(dockerStorageVolumes / 1024 / 1024 / 1024).toFixed(2)} GB`,
							note: 'Total disk space not available from /system/df'
						});
					}
				}
			}
		} catch (error) {
			// /system/df endpoint not available (SYSTEM=1 not enabled or not supported)
			// Fall back to parsing DriverStatus
			if (debug) {
				console.log(`[aggregator] /system/df not available for ${source.name}, falling back to DriverStatus`);
			}
			
			// Helper function to parse size strings from DriverStatus
			const parseSize = (sizeStr: string): number => {
				if (!sizeStr || typeof sizeStr !== 'string') return 0;
				const match = sizeStr.match(/([\d.]+)\s*(TB|GB|MB|KB|B|TiB|GiB|MiB|KiB)?/i);
				if (match) {
					const num = parseFloat(match[1]);
					if (isNaN(num)) return 0;
					const unit = (match[2] || '').toLowerCase();
					// Convert to bytes based on unit
					if (unit.includes('tb') || unit.includes('tib')) {
						return num * 1024 * 1024 * 1024 * 1024;
					} else if (unit.includes('gb') || unit.includes('gib')) {
						return num * 1024 * 1024 * 1024;
					} else if (unit.includes('mb') || unit.includes('mib')) {
						return num * 1024 * 1024;
					} else if (unit.includes('kb') || unit.includes('kib')) {
						return num * 1024;
					}
					// No unit specified - assume bytes
					return num;
				}
				return 0;
			};
			
			// Check DriverStatus array for storage information
			if (info.DriverStatus && Array.isArray(info.DriverStatus)) {
				for (const status of info.DriverStatus) {
					if (Array.isArray(status) && status.length >= 2) {
						const key = String(status[0]).toLowerCase();
						const value = String(status[1]);
						
						// Look for storage-related fields (Data Space Used, Data Space Total, etc.)
						if (key.includes('data space')) {
							// Format can be "123.45 GB / 500 GB" or separate "Data Space Used" and "Data Space Total"
							if (value.includes('/')) {
								// Combined format: "used / total"
								const parts = value.split('/').map(s => s.trim());
								if (parts.length === 2) {
									const used = parseSize(parts[0]);
									const total = parseSize(parts[1]);
									if (total > 0) {
										storageUsed = used;
										storageTotal = total;
										storageAvailable = total - used;
									}
								}
							} else if (key.includes('used')) {
								storageUsed = parseSize(value);
							} else if (key.includes('total')) {
								storageTotal = parseSize(value);
							}
						}
					}
				}
				
				// Calculate missing values if we have partial info
				if (storageTotal > 0 && storageUsed > 0 && storageAvailable === 0) {
					storageAvailable = storageTotal - storageUsed;
				} else if (storageTotal > 0 && storageAvailable > 0 && storageUsed === 0) {
					storageUsed = storageTotal - storageAvailable;
				}
			}
			
			// Try PoolBlocksize for devicemapper (if overlay2 didn't work)
			if (storageTotal === 0 && info.Driver === 'devicemapper') {
				if (info.PoolBlocksize && info.PoolBlocksUsed && info.PoolBlocksTotal) {
					const blockSize = Number(info.PoolBlocksize) || 0;
					const blocksUsed = Number(info.PoolBlocksUsed) || 0;
					const blocksTotal = Number(info.PoolBlocksTotal) || 0;
					
					if (blockSize > 0 && blocksTotal > 0) {
						storageTotal = blockSize * blocksTotal;
						storageUsed = blockSize * blocksUsed;
						storageAvailable = storageTotal - storageUsed;
					}
				}
			}
		}
		
		return {
			memory: memoryTotal > 0 ? {
				total: memoryTotal,
				used: memoryUsed,
				available: memoryAvailable
			} : undefined,
			storage: storageTotal > 0 ? {
				total: storageTotal,
				used: storageUsed,
				available: storageAvailable
			} : undefined,
			dockerVersion: info.ServerVersion || undefined,
			cpuCount: info.NCPU || undefined,
			totalImages: info.Images || undefined,
			operatingSystem: info.OperatingSystem || undefined,
			kernelVersion: info.KernelVersion || undefined,
			architecture: info.Architecture || undefined,
			storageDriver: info.Driver || undefined,
			dockerStorage: (dockerStorageImages > 0 || dockerStorageContainers > 0 || dockerStorageVolumes > 0) ? {
				images: dockerStorageImages,
				containers: dockerStorageContainers,
				volumes: dockerStorageVolumes,
				total: dockerStorageImages + dockerStorageContainers + dockerStorageVolumes
			} : undefined
		};
	} catch (error) {
		console.warn(`[aggregator] Unable to fetch system info for ${source.name}:`, error);
		return { 
			memory: undefined, 
			storage: undefined, 
			dockerVersion: undefined,
			cpuCount: undefined,
			totalImages: undefined,
			operatingSystem: undefined,
			kernelVersion: undefined,
			architecture: undefined,
			storageDriver: undefined,
			dockerStorage: undefined
		};
	}
};


export const getAggregatedApps = async (): Promise<AppsResponse> => {
	const warnings: AppsResponse['warnings'] = [];

	const containerMatrix = await Promise.all(
		settings.dockerSources.map(async (source) => {
			try {
				const containers = await fetchContainersForSource(source);
				return { source, containers };
			} catch (error) {
				console.warn(`[aggregator] Unable to reach ${source.name}:`, error);
				warnings.push({
					source: source.name,
					message: error instanceof Error ? error.message : 'Unknown error'
				});
				return { source, containers: [] };
			}
		})
	);

	// Fetch system info for each source in parallel
	const systemInfoMatrix = await Promise.all(
		settings.dockerSources.map(async (source) => {
			try {
				const systemInfo = await fetchSystemInfoForSource(source);
				return { source, systemInfo };
			} catch (error) {
				console.warn(`[aggregator] Unable to fetch system info for ${source.name}:`, error);
				return { 
					source, 
					systemInfo: {
						memory: undefined,
						storage: undefined,
						dockerVersion: undefined,
						cpuCount: undefined,
						totalImages: undefined,
						operatingSystem: undefined,
						kernelVersion: undefined,
						architecture: undefined,
						storageDriver: undefined,
						dockerStorage: undefined
					}
				};
			}
		})
	);
	
	// Create a map for quick lookup
	const systemInfoMap = new Map<string, typeof systemInfoMatrix[0]['systemInfo']>();
	systemInfoMatrix.forEach(({ source, systemInfo }) => {
		systemInfoMap.set(source.name, systemInfo);
	});
	
	// Note: Container memory stats calculation is now done asynchronously via /api/stats
	// This keeps the main endpoint fast - we only return what's available from docker.info()

	const workingApps = new Map<string, WorkingApp>();

	for (const { source, containers } of containerMatrix) {
		for (const container of containers) {
			const labels = safeLabels(container.Labels);
			const ref = parseImageReference(container.Image);
			const imageBase = getImageBase(ref);
			const appName = labels['homelab.name'] ?? friendlyImageName(ref);
			const displayName = labels['homelab.display'] ?? appName;
			const appId = resolveAppId(labels, imageBase, appName);
			
			// Extract version synchronously (async resolution happens later via /api/versions)
			// Priority: explicit version label > tag (if not "latest"/"nightly") > tag/digest fallback
			// Semantic versions from registries are resolved asynchronously to avoid blocking
			let version: string | null = null;
			const versionLabel = labels['org.opencontainers.image.version'];
			const imageDigest = container.ImageID?.startsWith('sha256:') 
				? container.ImageID 
				: (container.Image.includes('@sha256:') 
					? container.Image.match(/@(sha256:[a-f0-9]+)/)?.[1] 
					: null);
			
			// Use synchronous sources only - async resolution happens via /api/versions endpoint
			if (versionLabel && isSemanticVersion(versionLabel)) {
				// Use label if it's already a semantic version
				version = versionLabel;
			} else if (ref.tag && ref.tag !== 'latest' && ref.tag !== 'nightly') {
				// Use the tag if it's not "latest" or "nightly"
				version = ref.tag;
			} else if (versionLabel) {
				// Use label even if not semantic (e.g., "nightly") as temporary version
				version = versionLabel;
			} else if (ref.tag) {
				// For "latest" or "nightly" tags, use the tag itself as temporary version
				version = ref.tag;
			} else if (imageDigest) {
				// Last resort: Use shortened digest (first 12 chars) as temporary version identifier
				// This will be replaced by semantic version from async resolution if available
				version = imageDigest.replace('sha256:', '').slice(0, 12);
			}
			const descriptionHint = labels['homelab.description'];
			const iconHint = labels['homelab.icon'];

			upsertWorkingApp(workingApps, appId, {
				appName,
				displayName,
				image: container.Image,
				labels,
				iconHint,
				descriptionHint,
				instance: toServerInstance(source, container),
				version: version ?? null,
				tags: collectTags(labels)
			});
		}
	}

	const appList = await Promise.all(
		Array.from(workingApps.values()).map(async (entry) => {
			const contextLabels = entry.labels;
			entry.app.versions.sort(compareVersions);
			entry.app.latestVersion = entry.app.versions.at(-1) ?? null;
			
			// Resolve icon with error handling - don't let failures block the app
			try {
				entry.app.icon = await resolveIcon({
					image: entry.app.image,
					labels: contextLabels,
					iconHint: entry.iconHint ?? undefined
				});
			} catch (error) {
				console.warn(`[aggregator] Failed to resolve icon for ${entry.app.image}:`, error);
				entry.app.icon = null;
			}
			
			// Resolve description with error handling - don't let failures block the app
			try {
				entry.app.description =
					entry.descriptionHint ??
					(await resolveDescription({
						image: entry.app.image,
						labels: contextLabels,
						descriptionHint: entry.descriptionHint
					}));
			} catch (error) {
				console.warn(`[aggregator] Failed to resolve description for ${entry.app.image}:`, error);
				entry.app.description = entry.descriptionHint ?? null;
			}
			
			entry.app.containers.sort((a, b) => a.sourceLabel.localeCompare(b.sourceLabel));
			return entry.app;
		})
	);

	appList.sort((a, b) => a.displayName.localeCompare(b.displayName));

	const uniqueServers = new Set<string>();
	appList.forEach((app) => app.containers.forEach((inst) => uniqueServers.add(inst.sourceLabel)));

	// Calculate server statistics
	const serverStatsMap = new Map<string, ServerStats>();

	let totalContainers = 0;

	for (const app of appList) {
		for (const container of app.containers) {
			totalContainers++;
			
			const systemInfo = systemInfoMap.get(container.sourceId);
			const existing = serverStatsMap.get(container.sourceLabel) ?? {
				sourceId: container.sourceId,
				sourceLabel: container.sourceLabel,
				color: container.color,
				total: 0,
				running: 0,
				stopped: 0,
				crashed: 0,
				outdated: 0,
				dockerVersion: systemInfo?.dockerVersion,
				cpuCount: systemInfo?.cpuCount,
				totalImages: systemInfo?.totalImages,
				operatingSystem: systemInfo?.operatingSystem,
				kernelVersion: systemInfo?.kernelVersion,
				architecture: systemInfo?.architecture,
				storageDriver: systemInfo?.storageDriver,
				memory: systemInfo?.memory,
				storage: systemInfo?.storage,
				dockerStorage: systemInfo?.dockerStorage
			};

			existing.total++;
			
			if (container.state === 'running') {
				existing.running++;
			} else {
				existing.stopped++;
				if (container.exitCode !== null && container.exitCode !== 0) {
					existing.crashed++;
				}
			}

			// Check if outdated
			if (app.latestVersion && container.version) {
				if (compareVersions(container.version, app.latestVersion) < 0) {
					existing.outdated++;
				}
			}

			serverStatsMap.set(container.sourceLabel, existing);
		}
	}

	const serverStats = Array.from(serverStatsMap.values()).sort((a, b) => 
		a.sourceLabel.localeCompare(b.sourceLabel)
	);

	return {
		generatedAt: new Date().toISOString(),
		apps: appList,
		appFilters: Array.from(new Set(appList.map((app) => app.displayName))).sort(),
		serverFilters: Array.from(uniqueServers).sort(),
		warnings,
		showComposeTags: settings.showComposeTags,
		serverStats,
		totalContainers
	};
};

