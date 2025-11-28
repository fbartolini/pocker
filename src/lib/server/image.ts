export type ImageReference = {
	registry?: string;
	repository: string;
	tag?: string;
	digest?: string;
};

export const parseImageReference = (input: string): ImageReference => {
	const [referencePart, digest] = input.split('@');
	const lastSlash = referencePart.lastIndexOf('/');
	const lastColon = referencePart.lastIndexOf(':');

	let tag: string | undefined;
	let path = referencePart;

	if (lastColon > lastSlash) {
		tag = referencePart.slice(lastColon + 1);
		path = referencePart.slice(0, lastColon);
	}

	const segments = path.split('/');
	let registry: string | undefined;

	if (
		segments.length > 1 &&
		(segments[0].includes('.') || segments[0].includes(':') || segments[0] === 'localhost')
	) {
		registry = segments.shift();
	}

	const repository = segments.join('/');

	return {
		registry: registry === 'docker.io' ? undefined : registry,
		repository,
		tag,
		digest
	};
};

export const getImageBase = (ref: ImageReference): string => {
	// Normalize: remove docker.io/index.docker.io (they're the default registry)
	// and return just the repository path, lowercased for consistency
	const repo = ref.repository.toLowerCase().trim();
	if (ref.registry) {
		const reg = ref.registry.toLowerCase().trim();
		// Skip default registries
		if (reg === 'docker.io' || reg === 'index.docker.io') {
			return repo;
		}
		return `${reg}/${repo}`;
	}
	return repo;
};

export const deriveDockerHubSlug = (ref: ImageReference): string | null => {
	if (ref.registry && ref.registry !== 'index.docker.io') {
		return null;
	}

	const parts = ref.repository.split('/');

	if (parts.length === 1 || parts[0] === 'library') {
		return `/_/${parts[parts.length - 1]}`;
	}

	const namespace = parts.shift();
	const repo = parts.join('/');

	return namespace ? `/r/${namespace}/${repo}` : null;
};

export const friendlyImageName = (ref: ImageReference): string => {
	const parts = ref.repository.split('/');
	return parts[parts.length - 1];
};

/**
 * Extract service name candidates from an image reference for icon lookup.
 * Returns an array of potential names to try, ordered by likelihood.
 * Icon libraries typically use the repository name (last segment), not the namespace.
 * Examples:
 * - louislam/uptime-kuma -> ['uptime-kuma'] (exact match)
 * - portainer/portainer-ce -> ['portainer-ce', 'portainer'] (try full name first, then base)
 * - henrygd/beszel -> ['beszel']
 * - library/redis -> ['redis']
 */
export const getServiceNameCandidates = (ref: ImageReference): string[] => {
	const parts = ref.repository.split('/');
	const repoName = parts[parts.length - 1];
	const namespace = parts.length > 1 ? parts[0] : null;

	// Remove common suffixes like -ce, -ee, -agent
	const baseName = repoName.replace(/-ce$|-ee$|-agent$|-latest$|-docker$/, '');

	const candidates: string[] = [];

	// Always prioritize the repository name first (icon libraries use this)
	candidates.push(repoName);

	// If the repo name has a suffix, also try the base name
	// e.g., portainer-ce -> also try portainer
	if (baseName !== repoName) {
		candidates.push(baseName);
	}

	// For namespaced images where repo name starts with namespace,
	// the namespace might also be a valid icon name
	// e.g., portainer/portainer-ce -> namespace 'portainer' might work
	if (namespace && namespace !== 'library' && repoName.startsWith(namespace)) {
		// Only add namespace if it's different from what we already have
		if (namespace !== repoName && namespace !== baseName) {
			candidates.push(namespace);
		}
	}

	return [...new Set(candidates)]; // Remove duplicates
};

