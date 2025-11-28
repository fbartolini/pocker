import { parse } from 'node-html-parser';

import { getServerSettings } from './config';
import {
	deriveDockerHubSlug,
	getImageBase,
	getServiceNameCandidates,
	parseImageReference,
	type ImageReference
} from './image';

const settings = getServerSettings();

const logDebug = (...args: unknown[]) => {
	if (settings.metadataDebug) {
		console.debug('[metadata]', ...args);
	}
};

type CacheEntry<T> = {
	value: T;
	expires: number;
};

type HubMetadata = {
	icon?: string | null;
	description?: string | null;
};

const hubCache = new Map<string, CacheEntry<HubMetadata>>();
const repoCache = new Map<string, CacheEntry<HubMetadata>>();
const productCache = new Map<string, CacheEntry<HubMetadata>>();
const cdnIconCache = new Map<string, CacheEntry<string | null>>();

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

const sanitizeDescription = (value?: string | null): string | null => {
	if (!value) return null;
	return value.trim().substring(0, 600);
};

/**
 * Check if an icon URL exists by making a HEAD request.
 * Returns the URL if it exists, null otherwise.
 */
const checkIconExists = async (url: string): Promise<string | null> => {
	const cacheKey = `cdn:${url}`;
	const cached = cdnIconCache.get(cacheKey);
	if (cached) {
		if (cached.expires > Date.now()) {
			return cached.value;
		}
		cdnIconCache.delete(cacheKey);
	}

	try {
		const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
		const exists = response.ok;
		const result = exists ? url : null;
		if (settings.metadataDebug) {
			logDebug(exists ? 'CDN icon found' : 'CDN icon 404', url);
		}
		// Use shorter TTL for CDN icons (24 hours) since they can be updated frequently
		const cdnIconTtl = Math.min(settings.iconTtlMs, 86400000); // Max 24 hours
		cdnIconCache.set(cacheKey, {
			value: result,
			expires: Date.now() + cdnIconTtl
		});
		return result;
	} catch (error) {
		if (settings.metadataDebug) {
			logDebug('CDN icon check failed', url, error instanceof Error ? error.message : 'Unknown error');
		}
		cdnIconCache.set(cacheKey, {
			value: null,
			expires: Date.now() + 3600000 // Cache failures for 1 hour
		});
		return null;
	}
};

/**
 * Generate icon name variations to try.
 * Examples: "portainer-ce" -> ["portainer-ce", "portainer"]
 *           "nginx-proxy-manager" -> ["nginx-proxy-manager", "nginxproxymanager", "nginx"]
 */
const getIconNameVariations = (name: string): string[] => {
	const lower = name.toLowerCase();
	const variations: string[] = [lower]; // Try as-is first

	// Try without hyphens/underscores
	const noSeparators = lower.replace(/[-_]/g, '');
	if (noSeparators !== lower) {
		variations.push(noSeparators);
	}

	// Try base name without common suffixes
	const baseName = lower.replace(/-ce$|-ee$|-agent$|-latest$|-docker$/, '');
	if (baseName !== lower && !variations.includes(baseName)) {
		variations.push(baseName);
	}

	// Try without any non-alphanumeric (last resort)
	const alphanumeric = lower.replace(/[^a-z0-9]/g, '');
	if (alphanumeric !== lower && !variations.includes(alphanumeric)) {
		variations.push(alphanumeric);
	}

	return [...new Set(variations)]; // Remove duplicates
};

/**
 * Try to find an icon from selfh.st/icons CDN.
 * The repo has both SVG and PNG formats. We check SVG first (more common), then PNG.
 * Returns the icon URL if found, null otherwise.
 */
const fetchSelfhstIcon = async (ref: ImageReference): Promise<string | null> => {
	const candidates = getServiceNameCandidates(ref);
	if (settings.metadataDebug) {
		logDebug('trying selfh.st candidates', ref.repository, candidates);
	}
	for (const name of candidates) {
		const variations = getIconNameVariations(name);
		if (settings.metadataDebug) {
			logDebug('trying selfh.st variations', name, variations);
		}
		for (const variant of variations) {
			if (!variant) continue;

			// Try SVG first (more common in the repo)
			// Use @main to ensure we get the latest version from the main branch
			const svgUrl = `https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/${variant}.svg`;
			const svgFound = await checkIconExists(svgUrl);
			if (svgFound) {
				logDebug('icon from selfh.st (SVG)', ref.repository, svgFound);
				return svgFound;
			}

			// Fallback to PNG
			const pngUrl = `https://cdn.jsdelivr.net/gh/selfhst/icons@main/png/${variant}.png`;
			const pngFound = await checkIconExists(pngUrl);
			if (pngFound) {
				logDebug('icon from selfh.st (PNG)', ref.repository, pngFound);
				return pngFound;
			}
		}
	}
	return null;
};

/**
 * Try to find an icon from HypoLuxa/dashboard-icons CDN.
 * Returns the icon URL if found, null otherwise.
 */
const fetchHypoLuxaIcon = async (ref: ImageReference): Promise<string | null> => {
	const candidates = getServiceNameCandidates(ref);
	if (settings.metadataDebug) {
		logDebug('trying HypoLuxa candidates', ref.repository, candidates);
	}
	for (const name of candidates) {
		const variations = getIconNameVariations(name);
		if (settings.metadataDebug) {
			logDebug('trying HypoLuxa variations', name, variations);
		}
		for (const variant of variations) {
			if (!variant) continue;

			// Use @main to ensure we get the latest version from the main branch
			const url = `https://cdn.jsdelivr.net/gh/HypoLuxa/dashboard-icons@main/svg/${variant}.svg`;
			const found = await checkIconExists(url);
			if (found) {
				logDebug('icon from HypoLuxa', ref.repository, found);
				return found;
			}
		}
	}
	return null;
};

const fetchDockerHubMetadata = async (ref: ImageReference): Promise<HubMetadata | null> => {
	if (!settings.dockerHubEnabled) return null;

	const slug = deriveDockerHubSlug(ref);
	if (!slug) return null;

	const cached = hubCache.get(slug);
	if (cached && cached.expires > Date.now()) {
		return cached.value;
	}

	try {
		const response = await fetch(`https://hub.docker.com${slug}`);
		if (response.status === 404) {
			return null;
		}

		if (!response.ok) {
			throw new Error(`Docker Hub responded with ${response.status}`);
		}

		const html = await response.text();
		const root = parse(html);
		const icon = root.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? null;
		const description =
			root.querySelector('meta[property="og:description"]')?.getAttribute('content') ?? null;
		const result: HubMetadata = {
			icon: sanitizeUrl(icon),
			description: sanitizeDescription(description)
		};

		const ttl = Math.max(settings.descriptionTtlMs, settings.iconTtlMs);
		hubCache.set(slug, { value: result, expires: Date.now() + ttl });
		return result;
	} catch (error) {
		console.warn(`[metadata] Failed to fetch Docker Hub metadata for ${slug}:`, error);
		return null;
	}
};

const fetchRepositoryMetadata = async (ref: ImageReference): Promise<HubMetadata | null> => {
	if (!settings.dockerHubEnabled) return null;
	const namespaceSegments = ref.repository.split('/');
	const repo = namespaceSegments.pop()!;
	const namespace = namespaceSegments.pop() ?? 'library';
	const cacheKey = `${namespace}/${repo}`;

	const cached = repoCache.get(cacheKey);
	if (cached && cached.expires > Date.now()) {
		logDebug('cache hit', cacheKey, cached.value);
		return cached.value;
	}

	try {
		const response = await fetch(`https://hub.docker.com/v2/repositories/${namespace}/${repo}/`);
		if (response.status === 404) {
			logDebug('repository 404', cacheKey);
			return null;
		}
		if (!response.ok) {
			throw new Error(`Docker Hub repository responded with ${response.status}`);
		}

		const payload = (await response.json()) as {
			description?: string;
			short_description?: string;
			full_description?: string;
			logo_url?: string;
		};

		const result: HubMetadata = {
			icon: sanitizeUrl(payload.logo_url),
			description: sanitizeDescription(
				payload.short_description ?? payload.description ?? payload.full_description ?? null
			)
		};

		repoCache.set(cacheKey, { value: result, expires: Date.now() + settings.iconTtlMs });
		logDebug('repository data', cacheKey, result);
		return result;
	} catch (error) {
		console.warn(`[metadata] Docker Hub repository lookup failed for ${cacheKey}:`, error);
		return null;
	}
};

const fetchProductMetadata = async (ref: ImageReference): Promise<HubMetadata | null> => {
	if (!settings.dockerHubEnabled) return null;
	const cacheKey = `product:${ref.repository}`;
	const cached = productCache.get(cacheKey);
	if (cached && cached.expires > Date.now()) {
		logDebug('product cache hit', cacheKey, cached.value);
		return cached.value;
	}

	const slugCandidates = [
		ref.repository,
		ref.repository.replace(/^library\//, ''),
		ref.repository.replace(/\//g, '-')
	].filter(Boolean);

	try {
		const params = new URLSearchParams({
			page_size: '16',
			query: slugCandidates[0] ?? ref.repository,
			type: 'image'
		});
		const response = await fetch(`https://hub.docker.com/api/content/v1/products/search?${params}`);
		if (!response.ok) {
			throw new Error(`Docker Hub products search responded with ${response.status}`);
		}

		const payload = (await response.json()) as {
			summaries?: Array<{
				slug?: string;
				short_description?: string;
				logo_url?: string;
			}>;
		};

		const match =
			payload.summaries?.find((summary) => {
				const lower = summary.slug?.toLowerCase();
				return lower ? slugCandidates.some((candidate) => candidate.toLowerCase() === lower) : false;
			}) ?? payload.summaries?.[0];

		if (!match) {
			logDebug('product metadata: no match', ref.repository);
			return null;
		}

		const result: HubMetadata = {
			icon: sanitizeUrl(match.logo_url),
			description: sanitizeDescription(match.short_description ?? null)
		};

		productCache.set(cacheKey, { value: result, expires: Date.now() + settings.iconTtlMs });
		logDebug('product metadata', cacheKey, result);
		return result;
	} catch (error) {
		console.warn(`[metadata] Docker Hub product lookup failed for ${ref.repository}:`, error);
		return null;
	}
};

export type MetadataContext = {
	image: string;
	labels: Record<string, string | undefined>;
	descriptionHint?: string | null;
	iconHint?: string | null;
};

export const resolveIcon = async (context: MetadataContext): Promise<string | null> => {
	const labelIcon =
		context.iconHint ??
		context.labels['homelab.icon'] ??
		context.labels['app.icon'] ??
		context.labels['icon'];

	const sanitizedLabelIcon = sanitizeUrl(labelIcon);
	if (sanitizedLabelIcon) return sanitizedLabelIcon;

	// PRIORITY 1: Check icon map first - if match found, return immediately and skip ALL other lookups
	const iconMapSize = Object.keys(settings.iconMap).length;
	
	if (iconMapSize > 0) {
		// Try exact match first (full image string with tag/digest)
		const exactMatch = settings.iconMap[context.image];
		if (exactMatch) {
			const sanitized = sanitizeUrl(exactMatch);
			if (sanitized) {
				logDebug('icon map match (exact)', context.image, sanitized);
				return sanitized;
			}
		}
		
		// Try base match (repository without tag/digest, e.g., "plexinc/pms-docker")
		const ref = parseImageReference(context.image);
		const base = getImageBase(ref);
		const baseMatch = settings.iconMap[base];
		if (baseMatch) {
			const sanitized = sanitizeUrl(baseMatch);
			if (sanitized) {
				logDebug('icon map match (base)', base, sanitized);
				return sanitized;
			}
		}
	}
	
	// Only reached if icon map had no match - parse image reference for fallback lookups
	const ref = parseImageReference(context.image);

	// Try CDN icon libraries (selfh.st/icons and HypoLuxa/dashboard-icons)
	// These are more reliable than Docker Hub's API
	const selfhstIcon = await fetchSelfhstIcon(ref);
	if (selfhstIcon) return selfhstIcon;

	const hypoLuxaIcon = await fetchHypoLuxaIcon(ref);
	if (hypoLuxaIcon) return hypoLuxaIcon;

	// Fall back to Docker Hub APIs (less reliable but may have some icons)
	const repoMeta = await fetchRepositoryMetadata(ref);
	if (repoMeta?.icon) {
		logDebug('icon from repository metadata', ref.repository, repoMeta.icon);
		return repoMeta.icon;
	}

	const productMeta = await fetchProductMetadata(ref);
	if (productMeta?.icon) {
		logDebug('icon from product metadata', ref.repository, productMeta.icon);
		return productMeta.icon;
	}

	const hubMeta = await fetchDockerHubMetadata(ref);
	if (hubMeta?.icon) {
		logDebug('icon from product page metadata', ref.repository, hubMeta.icon);
		return hubMeta.icon;
	}

	logDebug('icon not found', ref.repository);
	return null;
};

export const resolveDescription = async (context: MetadataContext): Promise<string | null> => {
	const labelDescription =
		context.descriptionHint ??
		context.labels['org.opencontainers.image.description'] ??
		context.labels['description'];

	if (labelDescription) {
		return sanitizeDescription(labelDescription);
	}

	const ref = parseImageReference(context.image);

	const repoMeta = await fetchRepositoryMetadata(ref);
	if (repoMeta?.description) {
		return repoMeta.description;
	}

	const productMeta = await fetchProductMetadata(ref);
	if (productMeta?.description) {
		return productMeta.description;
	}

	const hubMeta = await fetchDockerHubMetadata(ref);
	if (hubMeta?.description) {
		return hubMeta.description;
	}

	if (settings.metadataDebug) {
		logDebug('description not found', ref.repository);
	}

	return null;
};

