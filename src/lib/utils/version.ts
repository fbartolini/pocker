const LATEST_TOKEN = 'latest';

const normalize = (value?: string | null): string | null => {
	if (!value) return null;
	return value.trim();
};

const isLatest = (value?: string | null) => {
	return normalize(value)?.toLowerCase() === LATEST_TOKEN;
};

const segmentify = (value: string): (number | string)[] => {
	const cleaned = value.replace(/^v/i, '');
	const base = cleaned.split(/[+\-]/)[0];
	return base
		.split(/[._]/)
		.filter(Boolean)
		.map((segment) => {
			const numeric = Number(segment);
			return Number.isNaN(numeric) ? segment.toLowerCase() : numeric;
		});
};

// Check if a version string is a digest (hex string, typically 12+ chars)
const isDigest = (value: string): boolean => {
	// Digest format: hex string (12+ characters), typically from SHA256
	return /^[a-f0-9]{12,}$/i.test(value);
};

export const compareVersions = (a?: string | null, b?: string | null): number => {
	const left = normalize(a);
	const right = normalize(b);

	if (!left && !right) return 0;
	if (!left) return -1;
	if (!right) return 1;
	if (left === right) return 0;

	const leftIsLatest = isLatest(left);
	const rightIsLatest = isLatest(right);
	if (leftIsLatest && !rightIsLatest) return 1;
	if (rightIsLatest && !leftIsLatest) return -1;

	// If both are digests, compare as strings (lexicographically)
	// This allows detecting different versions of "latest" images
	const leftIsDigest = left ? isDigest(left) : false;
	const rightIsDigest = right ? isDigest(right) : false;
	if (leftIsDigest && rightIsDigest) {
		return left < right ? -1 : left > right ? 1 : 0;
	}
	// If one is a digest and the other isn't, treat digest as "newer" (arbitrary but consistent)
	if (leftIsDigest && !rightIsDigest) return 1;
	if (rightIsDigest && !leftIsDigest) return -1;

	const leftSegments = segmentify(left);
	const rightSegments = segmentify(right);
	const maxLength = Math.max(leftSegments.length, rightSegments.length);

	for (let i = 0; i < maxLength; i += 1) {
		const leftSegment = leftSegments[i];
		const rightSegment = rightSegments[i];

		if (leftSegment === undefined) return -1;
		if (rightSegment === undefined) return 1;
		if (leftSegment === rightSegment) continue;

		if (typeof leftSegment === 'number' && typeof rightSegment === 'number') {
			return leftSegment - rightSegment;
		}

		const leftString = String(leftSegment);
		const rightString = String(rightSegment);
		if (leftString < rightString) return -1;
		if (leftString > rightString) return 1;
	}

	return 0;
};

export const formatVersionLabel = (value?: string | null): string | null => {
	const normalized = normalize(value);
	if (!normalized) return null;
	if (isLatest(normalized)) return LATEST_TOKEN;
	
	// If it's a digest (hex string), show as "latest" with a note that it's a digest
	// The actual digest will be shown in tooltip
	if (isDigest(normalized)) {
		return LATEST_TOKEN;
	}

	const base = normalized.split(/[+\-]/)[0];
	const parts = base.split('.');
	if (parts.length <= 3) {
		return base.replace(/^v/i, '');
	}

	return parts.slice(0, 3).join('.').replace(/^v/i, '');
};

// Check if a version is a digest (for UI purposes)
export const isVersionDigest = (value?: string | null): boolean => {
	const normalized = normalize(value);
	return normalized ? isDigest(normalized) : false;
};

