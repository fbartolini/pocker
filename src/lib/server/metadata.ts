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

// Cache for tag lookups by digest
const tagCache = new Map<string, CacheEntry<string | null>>();

// Export function to clear version cache (useful for testing)
export const clearVersionCache = () => {
	tagCache.clear();
	console.log('[metadata] Version cache cleared');
};

// Check if a tag looks like a semantic version (e.g., 1.0.6, v2.3.4)
const isSemanticVersion = (tag: string): boolean => {
	// Match patterns like: 1.0.6, v1.0.6, 2.3.4-beta, etc.
	return /^v?\d+\.\d+\.\d+/.test(tag);
};

// Resolve version tag from digest by querying Docker Hub or GitHub Container Registry
export const resolveVersionFromDigest = async (
	ref: ImageReference,
	digest: string
): Promise<string | null> => {
	if (!settings.dockerHubEnabled) return null;
	
	// Determine which registry to query
	const isDockerHub = !ref.registry || 
		ref.registry.toLowerCase().trim() === 'docker.io' || 
		ref.registry.toLowerCase().trim() === 'index.docker.io';
	const isGHCR = ref.registry?.toLowerCase().trim() === 'ghcr.io';
	
	if (!isDockerHub && !isGHCR) {
		logDebug('skipping unsupported registry', ref.registry);
		return null;
	}
	
	if (isDockerHub) {
		return resolveVersionFromDigestDockerHub(ref, digest);
	} else if (isGHCR) {
		return resolveVersionFromDigestGHCR(ref, digest);
	}
	
	return null;
};

// Resolve version tag from digest by querying Docker Hub
const resolveVersionFromDigestDockerHub = async (
	ref: ImageReference,
	digest: string
): Promise<string | null> => {
	
	const namespaceSegments = ref.repository.split('/');
	const repo = namespaceSegments.pop()!;
	const namespace = namespaceSegments.pop() ?? 'library';
	const cacheKey = `tag:${namespace}/${repo}:${digest}`;

	const cached = tagCache.get(cacheKey);
	if (cached && cached.expires > Date.now()) {
		logDebug('tag cache hit', cacheKey, cached.value);
		return cached.value;
	}

		try {
		// Query Docker Hub tags API - paginate through to find tags matching the digest
		let page = 1;
		let foundTag: string | null = null;
		const semanticVersions: string[] = [];
		
		// Normalize digest format for comparison (remove "sha256:" prefix if present)
		const normalizedDigest = digest.replace(/^sha256:/, '');
		
		while (page <= 5) { // Limit to 5 pages to avoid infinite loops
			const response = await fetch(
				`https://hub.docker.com/v2/repositories/${namespace}/${repo}/tags?page=${page}&page_size=100`
			);
			
			if (response.status === 404) {
				logDebug('tags 404', `${namespace}/${repo}`);
				break;
			}
			
			if (!response.ok) {
				throw new Error(`Docker Hub tags API responded with ${response.status}`);
			}

			const payload = (await response.json()) as {
				results?: Array<{
					name: string;
					digest?: string;
					images?: Array<{ digest?: string }>;
				}>;
				next?: string | null;
			};

			if (!payload.results || payload.results.length === 0) {
				break;
			}

			// Look for tags matching the digest
			for (const tag of payload.results) {
				// Check if tag's digest matches (could be in tag.digest or tag.images[].digest)
				// Docker Hub API returns digests in format "sha256:..." or just the hash
				const tagDigests = [
					tag.digest,
					...((tag.images as Array<{ digest?: string }>) || []).map(img => img.digest)
				].filter(Boolean) as string[];
				
				const matches = tagDigests.some(td => {
					const normalized = td.replace(/^sha256:/, '');
					return normalized === normalizedDigest;
				});
				
				if (matches) {
					const tagName = tag.name;
					
					// Prefer semantic versions
					if (isSemanticVersion(tagName)) {
						semanticVersions.push(tagName);
					} else if (!foundTag && tagName !== 'latest') {
						// Keep first non-latest tag as fallback
						foundTag = tagName;
					}
				}
			}

			// If no next page, stop
			if (!payload.next) {
				break;
			}

			page++;
		}

		// After collecting all semantic versions, sort them and use the latest one
		if (semanticVersions.length > 0) {
			// Sort semantic versions: remove 'v' prefix and compare as semantic versions
			semanticVersions.sort((a, b) => {
				const aClean = a.replace(/^v/i, '');
				const bClean = b.replace(/^v/i, '');
				const aParts = aClean.split('.').map(Number);
				const bParts = bClean.split('.').map(Number);
				for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
					const aVal = aParts[i] || 0;
					const bVal = bParts[i] || 0;
					if (aVal !== bVal) return bVal - aVal; // Descending order (latest first)
				}
				return 0;
			});
			foundTag = semanticVersions[0];
		}

		// Cache the result permanently (digests are immutable, so the mapping never changes)
		// A digest uniquely identifies an image, so once we know digest X maps to version Y, that's permanent
		// Use a very long TTL (1 year) - effectively permanent but allows cleanup if needed
		const ttl = 365 * 24 * 60 * 60 * 1000; // 1 year
		tagCache.set(cacheKey, { value: foundTag, expires: Date.now() + ttl });
		
		if (foundTag) {
			logDebug('resolved version from digest', `${namespace}/${repo}`, digest, foundTag);
		}
		
		return foundTag;
	} catch (error) {
		console.warn(`[metadata] Failed to resolve version from digest for ${namespace}/${repo}:${digest}:`, error);
		return null;
	}
};

// Resolve version tag from digest by querying GitHub Container Registry
const resolveVersionFromDigestGHCR = async (
	ref: ImageReference,
	digest: string
): Promise<string | null> => {
	// GitHub Container Registry format: ghcr.io/owner/repo or ghcr.io/owner/repo/image
	const namespaceSegments = ref.repository.split('/');
	const owner = namespaceSegments[0];
	const repo = namespaceSegments.length > 1 ? namespaceSegments[1] : namespaceSegments[0];
	const imageName = namespaceSegments.length > 2 ? namespaceSegments.slice(1).join('/') : repo;
	
	const cacheKey = `tag:ghcr.io/${owner}/${imageName}:${digest}`;

	const cached = tagCache.get(cacheKey);
	if (cached && cached.expires > Date.now()) {
		logDebug('tag cache hit (GHCR)', cacheKey, cached.value);
		return cached.value;
	}

	try {
		// Use Docker Registry HTTP API v2 for GHCR (works for public images without auth)
		// First, get a token (optional for public repos, but some endpoints may require it)
		let bearerToken: string | null = null;
		try {
			const tokenResponse = await fetch(
				`https://ghcr.io/token?service=ghcr.io&scope=repository:${owner}/${imageName}:pull`
			);
			if (tokenResponse.ok) {
				const tokenData = (await tokenResponse.json()) as { token?: string };
				bearerToken = tokenData.token || null;
			}
		} catch {
			// Token fetch failed, continue without auth (public repos should work)
		}

		// List all tags
		const headers: HeadersInit = {
			'Accept': 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json'
		};
		if (bearerToken) {
			headers['Authorization'] = `Bearer ${bearerToken}`;
		}

		const tagsResponse = await fetch(
			`https://ghcr.io/v2/${owner}/${imageName}/tags/list`,
			{ headers }
		);

		if (tagsResponse.status === 404) {
			logDebug('GHCR tags 404', `${owner}/${imageName}`);
			return null;
		}

		if (!tagsResponse.ok) {
			throw new Error(`GHCR tags API responded with ${tagsResponse.status}`);
		}

		const tagsData = (await tagsResponse.json()) as {
			tags?: string[];
		};

		if (!tagsData.tags || tagsData.tags.length === 0) {
			return null;
		}

		// Normalize digest format for comparison
		const normalizedDigest = digest.replace(/^sha256:/, '');
		let foundTag: string | null = null;
		const semanticVersions: string[] = [];

		// Check each tag to see if it matches the digest
		// Limit to first 100 tags to avoid too many API calls
		for (const tag of tagsData.tags.slice(0, 100)) {
			try {
				// Get manifest for this tag
				const manifestHeaders: HeadersInit = {
					'Accept': 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
				};
				if (bearerToken) {
					manifestHeaders['Authorization'] = `Bearer ${bearerToken}`;
				}

				const manifestResponse = await fetch(
					`https://ghcr.io/v2/${owner}/${imageName}/manifests/${tag}`,
					{ headers: manifestHeaders }
				);

				if (!manifestResponse.ok) {
					continue;
				}

				const manifest = (await manifestResponse.json()) as {
					config?: { digest?: string };
					digest?: string;
				};

				// Check if the manifest digest or config digest matches
				const manifestDigest = manifest.digest || manifest.config?.digest;
				if (manifestDigest) {
					const normalized = manifestDigest.replace(/^sha256:/, '');
					if (normalized === normalizedDigest) {
						// Prefer semantic versions
						if (isSemanticVersion(tag)) {
							semanticVersions.push(tag);
						} else if (!foundTag && tag !== 'latest') {
							// Keep first non-latest tag as fallback
							foundTag = tag;
						}
					}
				}
			} catch {
				// Skip this tag if manifest fetch fails
				continue;
			}
		}

		// After collecting all semantic versions, sort them and use the latest one
		if (semanticVersions.length > 0) {
			// Sort semantic versions: remove 'v' prefix and compare as semantic versions
			semanticVersions.sort((a, b) => {
				const aClean = a.replace(/^v/i, '');
				const bClean = b.replace(/^v/i, '');
				const aParts = aClean.split('.').map(Number);
				const bParts = bClean.split('.').map(Number);
				for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
					const aVal = aParts[i] || 0;
					const bVal = bParts[i] || 0;
					if (aVal !== bVal) return bVal - aVal; // Descending order (latest first)
				}
				return 0;
			});
			foundTag = semanticVersions[0];
		}

		// Cache the result permanently (digests are immutable)
		const ttl = 365 * 24 * 60 * 60 * 1000; // 1 year
		tagCache.set(cacheKey, { value: foundTag, expires: Date.now() + ttl });
		
		if (foundTag) {
			logDebug('resolved version from digest (GHCR)', `${owner}/${imageName}`, digest, foundTag);
		}
		
		return foundTag;
	} catch (error) {
		console.warn(`[metadata] Failed to resolve version from digest for ghcr.io/${owner}/${imageName}:${digest}:`, error);
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

