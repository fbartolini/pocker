import type Docker from 'dockerode';

import type { AggregatedApp, AppsResponse, ServerInstance } from '$lib/types';
import { getServerSettings, type SourceConfig } from './config';
import { getDockerClient } from './docker-client';
import { friendlyImageName, getImageBase, parseImageReference } from './image';
import { resolveDescription, resolveIcon } from './metadata';
import { compareVersions } from '$lib/utils/version';
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

const buildPortUrl = (baseUrl: string | null, port: ContainerPort): string | null => {
	if (!baseUrl) return null;
	const resolvedPort = port.PublicPort ?? port.PrivatePort;
	if (!resolvedPort) return null;
	try {
		const url = new URL(baseUrl);
		url.port = String(resolvedPort);
		return url.toString();
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

	const ports =
		container.Ports?.filter((port): port is ContainerPort => Boolean(port))?.map((port) => ({
			private: port.PrivatePort,
			public: port.PublicPort,
			type: port.Type,
			url: buildPortUrl(baseUiUrl, port)
		})) ?? [];

	// Use source color if defined, otherwise generate one based on source name
	const color = source.color ?? generateColorForString(source.name);

	return {
		sourceId: source.name,
		sourceLabel: source.displayName,
		containerId: container.Id,
		containerName: container.Names?.[0]?.replace(/^\//, '') ?? container.Id.slice(0, 12),
		state: container.State ?? 'unknown',
		version: labels['org.opencontainers.image.version'],
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
	const docker = getDockerClient(source);
	return docker.listContainers({ all: true });
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

	const workingApps = new Map<string, WorkingApp>();

	for (const { source, containers } of containerMatrix) {
		for (const container of containers) {
			const labels = safeLabels(container.Labels);
			const ref = parseImageReference(container.Image);
			const imageBase = getImageBase(ref);
			const appName = labels['homelab.name'] ?? friendlyImageName(ref);
			const displayName = labels['homelab.display'] ?? appName;
			const appId = resolveAppId(labels, imageBase, appName);
			
			const version =
				labels['org.opencontainers.image.version'] ??
				ref.tag ??
				(container.Image.includes('@sha') ? container.Image.split('@')[1]?.slice(0, 12) : undefined);
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
			entry.app.icon = await resolveIcon({
				image: entry.app.image,
				labels: contextLabels,
				iconHint: entry.iconHint ?? undefined
			});
			entry.app.description =
				entry.descriptionHint ??
				(await resolveDescription({
					image: entry.app.image,
					labels: contextLabels,
					descriptionHint: entry.descriptionHint
				}));
			entry.app.containers.sort((a, b) => a.sourceLabel.localeCompare(b.sourceLabel));
			return entry.app;
		})
	);

	appList.sort((a, b) => a.displayName.localeCompare(b.displayName));

	const uniqueServers = new Set<string>();
	appList.forEach((app) => app.containers.forEach((inst) => uniqueServers.add(inst.sourceLabel)));

	return {
		generatedAt: new Date().toISOString(),
		apps: appList,
		appFilters: Array.from(new Set(appList.map((app) => app.displayName))).sort(),
		serverFilters: Array.from(uniqueServers).sort(),
		warnings
	};
};

