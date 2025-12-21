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
 * @param source - Docker source configuration
 * @param timeoutMs - Timeout in milliseconds (can be overridden by source.timeoutMs)
 */
export const listContainers = async (source: SourceConfig, timeoutMs: number): Promise<Docker.ContainerInfo[]> => {
	// Use source-specific timeout if provided (useful for VPN/remote connections)
	const effectiveTimeout = source.timeoutMs ?? timeoutMs;
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
			effectiveTimeout,
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
		
		// Detect the actual error type - don't just say "timeout" if it's a connection error
		let actualErrorType = 'unknown';
		let userFriendlyMessage = errorMessage;
		
		if (error instanceof Error) {
			// Check for specific Node.js error codes (these are more reliable than message parsing)
			const errorCode = (error as any).code;
			
			if (errorCode === 'ECONNREFUSED') {
				actualErrorType = 'connection_refused';
				userFriendlyMessage = `Connection refused to ${source.endpoint || source.socketPath} - the Docker API may not be accessible from this container's network. Check network connectivity and firewall rules.`;
			} else if (errorCode === 'ETIMEDOUT' || errorCode === 'ESOCKETTIMEDOUT') {
				actualErrorType = 'connection_timeout';
				userFriendlyMessage = `Connection timeout to ${source.endpoint || source.socketPath} - check network connectivity from container. The endpoint may be unreachable from the container's network namespace.`;
			} else if (errorCode === 'ENOTFOUND' || errorCode === 'EAI_AGAIN') {
				actualErrorType = 'dns_error';
				userFriendlyMessage = `DNS resolution failed for ${source.endpoint} - hostname cannot be resolved from container. Check DNS configuration and hostname/IP address.`;
			} else if (errorCode === 'ECONNRESET') {
				actualErrorType = 'connection_reset';
				userFriendlyMessage = `Connection reset by ${source.endpoint || source.socketPath}`;
			} else if (errorMessage.includes('timeout') && duration >= effectiveTimeout * 0.9) {
				// Only call it a timeout if we actually waited most of the timeout period
				actualErrorType = 'request_timeout';
				userFriendlyMessage = `Request timed out after ${duration}ms - endpoint may be slow or unreachable from container network`;
			} else if (errorMessage.includes('timeout')) {
				// If error says timeout but we didn't wait long, it's likely a connection issue
				actualErrorType = 'connection_issue';
				userFriendlyMessage = `Connection issue to ${source.endpoint || source.socketPath} (reported as timeout but likely network/DNS issue from container)`;
			}
		}
		
		// Enhanced error logging
		const errorDetails: any = {
			error: errorMessage,
			errorCode: (error as any).code,
			errorType: actualErrorType,
			endpoint: endpointInfo,
			expectedUrl: expectedUrl || 'N/A (socket)',
			timeout: `${effectiveTimeout}ms`,
			duration: `${duration}ms`
		};
		
		if (errorStack && debug) {
			errorDetails.stack = errorStack;
		}
		
		console.error(`[docker-client] Failed to list containers for "${source.name}":`, errorDetails);
		
		// Throw a more descriptive error that will be shown to the user
		const improvedError = new Error(userFriendlyMessage);
		(improvedError as any).code = (error as any).code;
		(improvedError as any).originalError = error;
		(improvedError as any).errorType = actualErrorType;
		throw improvedError;
	}
};

