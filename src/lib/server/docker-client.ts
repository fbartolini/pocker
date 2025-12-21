import fs from 'node:fs';
import path from 'node:path';
import Docker from 'dockerode';

import type { SourceConfig } from './config';

const clients = new Map<string, Docker>();

const resolvePath = (filePath?: string): string | null => {
	if (!filePath) return null;
	if (path.isAbsolute(filePath)) return filePath;
	return path.join(process.cwd(), filePath);
};

const readIfExists = (filePath?: string): Buffer | undefined => {
	const resolved = resolvePath(filePath);
	if (!resolved) return undefined;
	try {
		return fs.readFileSync(resolved);
	} catch (error) {
		console.warn(`[docker-client] Unable to read TLS file ${resolved}:`, error);
		return undefined;
	}
};

const buildOptions = (source: SourceConfig): Docker.DockerOptions => {
	if (source.socketPath) {
		return { socketPath: source.socketPath };
	}

	if (source.endpoint) {
		const endpointUrl = new URL(source.endpoint);
		const rawProtocol = endpointUrl.protocol.replace(':', '');
		const normalizedProtocol = rawProtocol === 'tcp' ? 'http' : rawProtocol;
		const protocol =
			normalizedProtocol === 'http' ||
			normalizedProtocol === 'https' ||
			normalizedProtocol === 'ssh'
				? (normalizedProtocol as 'http' | 'https' | 'ssh')
				: undefined;

		const port =
			endpointUrl.port ||
			(protocol === 'https' ? '443' : protocol === 'http' ? '80' : undefined);

		const headers: Record<string, string> = {};
		const basicAuth =
			source.auth?.username || endpointUrl.username
				? `${source.auth?.username ?? endpointUrl.username}:${source.auth?.password ?? endpointUrl.password}`
				: undefined;

		if (basicAuth) {
			headers.Authorization = `Basic ${Buffer.from(basicAuth).toString('base64')}`;
		}

		const options: Docker.DockerOptions & { rejectUnauthorized?: boolean } = {
			protocol,
			host: endpointUrl.hostname,
			port: port ? Number(port) : undefined,
			headers: Object.keys(headers).length ? headers : undefined,
			ca: readIfExists(source.tls?.caPath),
			cert: readIfExists(source.tls?.certPath),
			key: readIfExists(source.tls?.keyPath)
		};

		if (protocol === 'https') {
			options.rejectUnauthorized = source.tls?.rejectUnauthorized ?? true;
		}

		return options;
	}

	throw new Error(`Source "${source.name}" does not define a valid Docker endpoint`);
};

export const getDockerClient = (source: SourceConfig): Docker => {
	if (!clients.has(source.name)) {
		const options = buildOptions(source);
		
		// Debug logging for client creation
		const debug = process.env.METADATA_DEBUG === 'true';
		if (debug) {
			console.log(`[docker-client] Creating Docker client for "${source.name}":`, {
				protocol: options.protocol,
				host: options.host,
				port: options.port,
				socketPath: options.socketPath,
				hasAuth: !!(source.auth?.username || source.auth?.password),
				hasTLS: !!(options.ca || options.cert || options.key)
			});
		}
		
		clients.set(source.name, new Docker(options));
	}

	return clients.get(source.name)!;
};

/**
 * Wraps a promise with a timeout to prevent hanging on unreachable Docker sources
 */
export const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> => {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`${errorMessage} (timeout after ${timeoutMs}ms)`)), timeoutMs);
		})
	]);
};

/**
 * Lists all containers for a source with timeout handling
 */
export const listContainers = async (source: SourceConfig, timeoutMs: number): Promise<Docker.ContainerInfo[]> => {
	const docker = getDockerClient(source);
	
	// Build debug info about the endpoint being used
	const debug = process.env.METADATA_DEBUG === 'true';
	let endpointInfo = '';
	let expectedUrl = '';
	if (source.socketPath) {
		endpointInfo = `socket: ${source.socketPath}`;
	} else if (source.endpoint) {
		const endpointUrl = new URL(source.endpoint);
		const protocol = endpointUrl.protocol.replace(':', '');
		const port = endpointUrl.port || (protocol === 'https' ? '443' : '80');
		// Dockerode uses versioned API: /v1.41/containers/json (or detected version)
		expectedUrl = `${protocol}://${endpointUrl.hostname}:${port}/v1.41/containers/json?all=true`;
		endpointInfo = `endpoint: ${source.endpoint}`;
		if (source.auth?.username) {
			endpointInfo += ` (with auth: ${source.auth.username})`;
		}
	}
	
	if (debug) {
		console.log(`[docker-client] Listing containers for "${source.name}":`, {
			endpoint: endpointInfo,
			expectedUrl: expectedUrl || 'N/A (socket)',
			timeout: `${timeoutMs}ms`
		});
	}
	
	const startTime = Date.now();
	try {
		// Create the promise first to catch any immediate errors
		const listPromise = docker.listContainers({ all: true });
		
		const result = await withTimeout(
			listPromise,
			timeoutMs,
			`Docker API timeout for ${source.name} (listContainers)`
		);
		
		const duration = Date.now() - startTime;
		if (debug) {
			console.log(`[docker-client] Successfully listed ${result.length} containers for "${source.name}" in ${duration}ms`);
		}
		
		return result;
	} catch (error) {
		const duration = Date.now() - startTime;
		const errorMessage = error instanceof Error ? error.message : String(error);
		const errorStack = error instanceof Error ? error.stack : undefined;
		
		// Enhanced error logging
		const errorDetails: any = {
			error: errorMessage,
			endpoint: endpointInfo,
			expectedUrl: expectedUrl || 'N/A (socket)',
			timeout: `${timeoutMs}ms`,
			duration: `${duration}ms`
		};
		
		// Check if it's a specific error type
		if (error instanceof Error) {
			if (error.message.includes('ECONNREFUSED')) {
				errorDetails.suggestion = 'Connection refused - check if the Docker API is running and accessible';
			} else if (error.message.includes('ETIMEDOUT')) {
				errorDetails.suggestion = 'Connection timeout - check network connectivity and firewall rules';
			} else if (error.message.includes('ENOTFOUND')) {
				errorDetails.suggestion = 'Host not found - check DNS resolution and hostname';
			} else if (error.message.includes('timeout')) {
				errorDetails.suggestion = `Request timed out after ${duration}ms - the endpoint may be slow or unreachable from the server`;
			}
		}
		
		if (errorStack && debug) {
			errorDetails.stack = errorStack;
		}
		
		console.error(`[docker-client] Failed to list containers for "${source.name}":`, errorDetails);
		throw error;
	}
};

