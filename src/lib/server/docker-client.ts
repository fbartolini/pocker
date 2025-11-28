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
		clients.set(source.name, new Docker(buildOptions(source)));
	}

	return clients.get(source.name)!;
};

