export type SourceWarning = {
	source: string;
	message: string;
};

export type ExposedPort = {
	private: number;
	public?: number;
	type?: string;
	url?: string | null;
};

export type ServerInstance = {
	sourceId: string;
	sourceLabel: string;
	containerId: string;
	containerName: string;
	state: string;
	exitCode?: number | null; // Exit code for stopped containers (null if running or unknown)
	version?: string | null;
	uiUrl?: string | null;
	ports: ExposedPort[];
	color?: string; // Hex color code for UI display
};

export type AggregatedApp = {
	id: string;
	name: string;
	image: string;
	displayName: string;
	latestVersion?: string | null;
	icon?: string | null;
	description?: string | null;
	versions: string[];
	tags: string[];
	containers: ServerInstance[];
};

export type ServerStats = {
	sourceId: string;
	sourceLabel: string;
	color?: string; // Server color for UI display
	total: number;
	running: number;
	stopped: number;
	crashed: number;
	outdated: number;
	dockerVersion?: string;
	memory?: {
		total: number; // Total memory in bytes
		used: number; // Used memory in bytes
		available: number; // Available memory in bytes
	};
	storage?: {
		total: number; // Total storage in bytes
		used: number; // Used storage in bytes
		available: number; // Available storage in bytes
	};
};

export type AppsResponse = {
	generatedAt: string;
	apps: AggregatedApp[];
	appFilters: string[];
	serverFilters: string[];
	warnings: SourceWarning[];
	showComposeTags?: boolean;
	serverStats?: ServerStats[];
	totalContainers?: number;
};

