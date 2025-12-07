import fs from 'node:fs';
import path from 'node:path';

import { generateColorForString } from '../utils/colors';

type RawKeyValue = Record<string, string>;

export type SourceConfig = {
	name: string;
	displayName: string;
	endpoint?: string;
	socketPath?: string;
	uiBase?: string;
	color?: string; // Hex color code for UI display (e.g., "#4f80ff")
	auth?: {
		username?: string;
		password?: string;
	};
	tls?: {
		caPath?: string;
		certPath?: string;
		keyPath?: string;
		rejectUnauthorized: boolean;
	};
};

export type ServerSettings = {
	dockerSources: SourceConfig[];
	dockerHubEnabled: boolean;
	descriptionTtlMs: number;
	iconTtlMs: number;
	iconMap: Record<string, string>;
	metadataDebug: boolean;
	publicMaxWidth?: string;
	showComposeTags: boolean;
	dockerHubTimeoutMs: number;
	dockerApiTimeoutMs: number;
};

const SOURCE_DELIMITER = ';';
const FIELD_DELIMITER = '|';
const settingsCache: Partial<ServerSettings> = {};

const coerceBoolean = (value?: string): boolean | undefined => {
	if (value === undefined) return undefined;
	if (['true', '1', 'yes'].includes(value.toLowerCase())) return true;
	if (['false', '0', 'no'].includes(value.toLowerCase())) return false;
	return undefined;
};

const parseKeyValuePairs = (raw: string[]): RawKeyValue => {
	return raw.reduce<RawKeyValue>((acc, segment) => {
		const [key, ...rest] = segment.split('=');
		if (!key?.trim()) return acc;
		acc[key.trim().toLowerCase()] = rest.join('=').trim();
		return acc;
	}, {});
};

const normalizeSocketPath = (value?: string): string | undefined => {
	if (!value) return undefined;
	if (value.startsWith('unix://')) {
		return value.replace('unix://', '');
	}
	return value;
};

	const parseSource = (raw: string): SourceConfig | null => {
		const segments = raw.split(FIELD_DELIMITER).map((seg) => seg.trim()).filter(Boolean);
		if (!segments.length) return null;

		const nameToken = segments.shift()!;
		const keyValues = parseKeyValuePairs(segments);

		const displayName = keyValues.label ?? nameToken;
		const endpoint = keyValues.endpoint;
		const socketPath = normalizeSocketPath(keyValues.socket);

		if (!endpoint && !socketPath) {
			throw new Error(`Source "${nameToken}" must define an endpoint or socket path`);
		}

		const tlsReject = coerceBoolean(keyValues['tlsrejectunauthorized']);

		// Validate color if provided
		let color: string | undefined = keyValues.color;
		if (color) {
			const hexColorRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
			if (!hexColorRegex.test(color)) {
				console.warn(`[config] Invalid color format for source "${nameToken}": ${color}. Ignoring.`);
				color = undefined;
			}
		}

		return {
			name: nameToken,
			displayName,
			endpoint,
			socketPath,
			uiBase: keyValues.ui ?? keyValues.uibase,
			color,
			auth: keyValues.user || keyValues.username || keyValues.password
				? {
						username: keyValues.user ?? keyValues.username,
						password: keyValues.password
				  }
				: undefined,
			tls:
				keyValues.ca || keyValues.cert || keyValues.key || tlsReject !== undefined
					? {
							caPath: keyValues.ca,
							certPath: keyValues.cert,
							keyPath: keyValues.key,
							rejectUnauthorized: tlsReject ?? true
					  }
					: undefined
		};
	};

const parseJsonSource = (obj: any): SourceConfig | null => {
	if (!obj || typeof obj !== 'object') return null;
	
	const name = obj.name || obj.id;
	if (!name || typeof name !== 'string') {
		throw new Error('Source must have a "name" field');
	}

	const endpoint = obj.endpoint;
	const socketPath = normalizeSocketPath(obj.socket || obj.socketPath);
	
		if (!endpoint && !socketPath) {
			throw new Error(`Source "${name}" must define an endpoint or socket path`);
		}

		// Validate color if provided (must be a valid hex color)
		let color: string | undefined = obj.color;
		if (color && typeof color === 'string') {
			// Validate hex color format (#RRGGBB or #RGB)
			const hexColorRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
			if (!hexColorRegex.test(color)) {
				console.warn(`[config] Invalid color format for source "${name}": ${color}. Ignoring.`);
				color = undefined;
			}
		} else {
			color = undefined;
		}

		return {
			name,
			displayName: obj.label || obj.displayName || name,
			endpoint,
			socketPath,
			uiBase: obj.ui || obj.uiBase,
			color,
			auth: obj.user || obj.username || obj.password
				? {
						username: obj.user || obj.username,
						password: obj.password
				  }
				: undefined,
			tls: obj.ca || obj.cert || obj.key || obj.tlsRejectUnauthorized !== undefined
				? {
						caPath: obj.ca,
						certPath: obj.cert,
						keyPath: obj.key,
						rejectUnauthorized: coerceBoolean(String(obj.tlsRejectUnauthorized ?? true)) ?? true
				  }
				: undefined
		};
};

const loadSources = (): SourceConfig[] => {
	const sources: SourceConfig[] = [];

	const configFile = process.env.DOCKER_SOURCES_FILE ?? './config/docker-sources.json';
	const resolved = path.isAbsolute(configFile) ? configFile : path.join(process.cwd(), configFile);
	const hasConfigFile = fs.existsSync(resolved);
	const dockerSocket = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

	// Priority 1: If config file exists, use ONLY what's in it (user has full control)
	if (hasConfigFile) {
		try {
			const content = fs.readFileSync(resolved, 'utf-8');
			const json = JSON.parse(content);
			const jsonArray = Array.isArray(json) ? json : [json];
			
			const configSources = jsonArray
				.map((obj, idx) => {
					try {
						return parseJsonSource(obj);
					} catch (error) {
						console.error(`[config] Failed to parse source ${idx + 1} from ${resolved}:`, error);
						return null;
					}
				})
				.filter((entry): entry is SourceConfig => Boolean(entry));
			
			// Assign unique colors to sources that don't have one
			const assignedColors = new Set<string>();
			configSources.forEach((source) => {
				if (source.color) {
					assignedColors.add(source.color.toLowerCase());
				}
			});
			
			configSources.forEach((source) => {
				if (!source.color) {
					let color = generateColorForString(source.name);
					let attempts = 0;
					// Resolve collisions by trying variations
					while (assignedColors.has(color.toLowerCase()) && attempts < 20) {
						color = generateColorForString(`${source.name}-${attempts}`);
						attempts++;
					}
					source.color = color;
					assignedColors.add(color.toLowerCase());
				}
			});
			
			sources.push(...configSources);
			console.log(`[config] Loaded ${configSources.length} Docker source(s) from ${resolved} (config file mode - full control)`);
			console.log(`[config] Successfully loaded ${sources.length} Docker source(s) total`);
			sources.forEach((source, idx) => {
				console.log(`[config] Source ${idx + 1}: ${source.name} (${source.displayName}) - Color: ${source.color}`);
			});
			return sources;
		} catch (error) {
			console.error(`[config] Failed to read ${resolved}:`, error);
			console.log('[config] Falling back to default socket + environment variable');
		}
	}

	// Priority 2: Default local socket (if not disabled)
	const socketDisabled = coerceBoolean(process.env.DOCKER_SOCKET_DISABLE) === true;
	if (!socketDisabled) {
		const socketPath = normalizeSocketPath(dockerSocket);
		// Check if socket exists or is a unix:// path (don't check existence for unix://)
		if (socketPath && (socketPath.startsWith('/') && fs.existsSync(socketPath) || dockerSocket.startsWith('unix://'))) {
			const localSource: SourceConfig = {
				name: 'local',
				displayName: process.env.DOCKER_SOCKET_LABEL || 'Local',
				socketPath,
				color: generateColorForString('local')
			};
			sources.push(localSource);
			console.log(`[config] Added default local socket: ${socketPath} - Color: ${localSource.color}`);
		}
	}

	// Priority 3: Add sources from DOCKER_SOURCES environment variable (legacy support)
	const raw = process.env.DOCKER_SOURCES?.trim();
	if (raw) {
		console.log('[config] Adding sources from DOCKER_SOURCES environment variable');

		// Try to parse as JSON first (new format)
		if (raw.startsWith('[') || raw.startsWith('{')) {
			try {
				const json = JSON.parse(raw);
				const jsonArray = Array.isArray(json) ? json : [json];
				
				const envSources = jsonArray
					.map((obj, idx) => {
						try {
							return parseJsonSource(obj);
						} catch (error) {
							console.error(`[config] Failed to parse source ${idx + 1} from JSON:`, error);
							return null;
						}
					})
					.filter((entry): entry is SourceConfig => Boolean(entry));
				
				sources.push(...envSources);
				console.log(`[config] Parsed ${envSources.length} Docker source(s) from DOCKER_SOURCES JSON format`);
			} catch (error) {
				console.warn('[config] Failed to parse DOCKER_SOURCES as JSON, falling back to legacy format:', error);
				// Fall through to legacy format parser
			}
		}

		// Legacy format: semicolon/newline-delimited key=value pairs
		// Only parse if we haven't already added sources from JSON
		if (sources.length === (socketDisabled ? 0 : 1)) {
			let legacyRaw = raw;
			// Remove surrounding quotes if present
			legacyRaw = legacyRaw.replace(/^["']+|["']+$/g, '');
			legacyRaw = legacyRaw.replace(/\n["']+|["']+\n/g, '\n');

			const entries = legacyRaw
				.split(/[;\n]/)
				.map((line) => {
					line = line.replace(/^["']+|["']+$/g, '');
					const commentIndex = line.indexOf('#');
					if (commentIndex >= 0) {
						line = line.slice(0, commentIndex);
					}
					return line.trim();
				})
				.filter(Boolean);

			const legacySources = entries
				.map(parseSource)
				.filter((entry): entry is SourceConfig => Boolean(entry));

			// Assign unique colors to legacy sources
			const legacyAssignedColors = new Set<string>();
			sources.forEach((s) => {
				if (s.color) legacyAssignedColors.add(s.color.toLowerCase());
			});
			legacySources.forEach((source) => {
				if (source.color) {
					legacyAssignedColors.add(source.color.toLowerCase());
				}
			});
			
			legacySources.forEach((source) => {
				if (!source.color) {
					let color = generateColorForString(source.name);
					let attempts = 0;
					while (legacyAssignedColors.has(color.toLowerCase()) && attempts < 20) {
						color = generateColorForString(`${source.name}-${attempts}`);
						attempts++;
					}
					source.color = color;
					legacyAssignedColors.add(color.toLowerCase());
				}
			});

			sources.push(...legacySources);
			console.log(`[config] Parsed ${legacySources.length} Docker source(s) from legacy format`);
		}
	}

	// Final pass: ensure ALL sources have unique colors (catch any edge cases)
	const finalColors = new Map<string, string>(); // color -> source name
	sources.forEach((source) => {
		if (!source.color) {
			source.color = generateColorForString(source.name);
		}
		
		const colorKey = source.color.toLowerCase();
		if (finalColors.has(colorKey)) {
			const conflicting = finalColors.get(colorKey);
			console.warn(`[config] Color collision: ${source.name} and ${conflicting} both have ${source.color}. Regenerating for ${source.name}.`);
			
			let attempts = 0;
			let newColor = generateColorForString(`${source.name}-${Date.now()}`);
			while (finalColors.has(newColor.toLowerCase()) && attempts < 30) {
				newColor = generateColorForString(`${source.name}-${attempts}-${Date.now()}`);
				attempts++;
			}
			source.color = newColor;
		}
		finalColors.set(source.color.toLowerCase(), source.name);
	});

	console.log(`[config] Successfully loaded ${sources.length} Docker source(s) total`);
	sources.forEach((source, idx) => {
		console.log(`[config] Source ${idx + 1}: ${source.name} (${source.displayName}) - Color: ${source.color}`);
	});
	
	return sources;
};

const loadIconMap = (): Record<string, string> => {
	const iconMapFile = process.env.ICON_MAP_FILE ?? './config/icon-map.json';
	const resolved = path.isAbsolute(iconMapFile)
		? iconMapFile
		: path.join(process.cwd(), iconMapFile);
	if (!fs.existsSync(resolved)) {
		console.log(`[icon-map] File not found: ${resolved} (skipping icon map)`);
		return {};
	}
	try {
		const content = fs.readFileSync(resolved, 'utf-8');
		const iconMap = JSON.parse(content);
		const keyCount = Object.keys(iconMap).length;
		console.log(`[icon-map] Loaded ${keyCount} icon mapping(s) from ${resolved}`);
		if (keyCount > 0) {
			console.log(`[icon-map] Keys: ${Object.keys(iconMap).join(', ')}`);
		}
		return iconMap;
	} catch (error) {
		console.error(`[icon-map] Failed to read ${resolved}:`, error);
		return {};
	}
};

export const getServerSettings = (): ServerSettings => {
	if (settingsCache.dockerSources) {
		return settingsCache as ServerSettings;
	}

	const dockerSources = loadSources();
	const dockerHubEnabled = coerceBoolean(process.env.ENABLE_DOCKER_HUB_SCRAPE) ?? true;
	const descriptionTtlMs = Number(process.env.DESCRIPTION_CACHE_MS ?? 86_400_000); // 24h
	const iconTtlMs = Number(process.env.ICON_CACHE_MS ?? 604_800_000); // 7 days
	const iconMap = loadIconMap();
	const metadataDebug = coerceBoolean(process.env.METADATA_DEBUG) ?? false;
	const publicMaxWidth = process.env.PUBLIC_MAX_WIDTH?.trim() || undefined;
	const showComposeTags = coerceBoolean(process.env.SHOW_COMPOSE_TAGS) ?? false;
	const dockerHubTimeoutMs = Number(process.env.DOCKER_HUB_TIMEOUT_MS ?? 5_000); // 5 seconds default
	const dockerApiTimeoutMs = Number(process.env.DOCKER_API_TIMEOUT_MS ?? 10_000); // 10 seconds default

	Object.assign(settingsCache, {
		dockerSources,
		dockerHubEnabled,
		descriptionTtlMs,
		iconTtlMs,
		iconMap,
		metadataDebug,
		publicMaxWidth,
		showComposeTags,
		dockerHubTimeoutMs,
		dockerApiTimeoutMs
	});

	return settingsCache as ServerSettings;
};

