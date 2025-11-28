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

export type AppsResponse = {
	generatedAt: string;
	apps: AggregatedApp[];
	appFilters: string[];
	serverFilters: string[];
	warnings: SourceWarning[];
	showComposeTags?: boolean;
};

