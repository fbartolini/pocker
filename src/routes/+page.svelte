<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import type { AggregatedApp, AppsResponse } from '$lib/types';
	import { compareVersions, formatVersionLabel, isVersionDigest } from '$lib/utils/version';
	import { formatBytes, formatPercent } from '$lib/utils/format';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import ContainerStatsTooltip from '$lib/components/ContainerStatsTooltip.svelte';
	import ServerStatsTooltip from '$lib/components/ServerStatsTooltip.svelte';
	import ResourceBar from '$lib/components/ResourceBar.svelte';

	export let data: { initialData: AppsResponse; embed: boolean; maxWidth: string | null };

	let snapshot: AppsResponse = data.initialData;
	let filteredApps: AggregatedApp[] = snapshot.apps;
	let selectedApp = 'all';
	let selectedServer = 'all';
	let showIssuesOnly = false;
	let isRefreshing = false;
	let errorMessage = '';
	let embedMode = data.embed;
	let pageMaxWidth = data.maxWidth;
	let showComposeTags = snapshot.showComposeTags ?? false;
	let hoverTimeout: ReturnType<typeof setTimeout> | null = null;
	let hoveredAppId: string | null = null;
	let statsFetched = false; // Track if we've fetched stats to avoid duplicate calls
	let versionsFetched = false; // Track if we've fetched versions to avoid duplicate calls
	let hoveredContainer: { sourceId: string; containerId: string; containerName: string; element: HTMLElement | null } | null = null;
	let containerStats: Record<string, any> = {}; // Cache of container stats
	let containerStatsTimeout: ReturnType<typeof setTimeout> | null = null;
	let hideTooltipTimeout: ReturnType<typeof setTimeout> | null = null;
	let hoveredServer: { sourceLabel: string; element: HTMLElement | null } | null = null; // Track which server is being hovered
	let serverDetails: Record<string, { topContainers: Array<{ name: string; memory: number }>; memoryTotal: number }> = {};

	$: embedMode = data.embed;
	$: pageMaxWidth = data.maxWidth;
	$: showComposeTags = snapshot.showComposeTags ?? false;
	$: if (browser) {
		document.body.dataset.embed = embedMode ? 'true' : 'false';
	}
	
	// Fetch memory stats and versions asynchronously after initial load (only once)
	onMount(() => {
		if (snapshot.serverStats && snapshot.serverStats.length > 0 && !statsFetched) {
			fetchMemoryStats();
		}
		if (snapshot.apps && snapshot.apps.length > 0 && !versionsFetched) {
			fetchVersions();
		}
	});

	const fetchMemoryStats = async () => {
		if (statsFetched) return; // Don't fetch multiple times
		statsFetched = true;
		
		try {
			const response = await fetch('/api/stats');
			if (!response.ok) {
				return; // Silently fail - stats are optional
			}
			const data = await response.json();
			const memoryStats = data.memoryStats || {};
			
			// Update serverStats with memory usage from container stats
			if (snapshot.serverStats) {
				snapshot.serverStats = snapshot.serverStats.map((stats) => {
					const sourceStats = memoryStats[stats.sourceId];
					if (sourceStats && stats.memory) {
						return {
							...stats,
							memory: {
								...stats.memory,
								used: sourceStats.used,
								available: sourceStats.available
							}
						};
					}
					return stats;
				});
			}
		} catch (error) {
			// Silently fail - stats are optional
		}
	};

	const fetchVersions = async () => {
		if (versionsFetched) return; // Don't fetch multiple times
		versionsFetched = true;
		
		try {
			const response = await fetch('/api/versions');
			if (!response.ok) {
				return; // Silently fail - versions are optional
			}
			const data = await response.json();
			const versions = data.versions || {};
			
			// Update container versions and recalculate app versions
			if (snapshot.apps) {
				snapshot.apps = snapshot.apps.map((app) => {
					let versionsUpdated = false;
					const updatedContainers = app.containers.map((container) => {
						const containerKey = `${container.sourceId}:${container.containerId}`;
						const resolvedVersion = versions[containerKey];
						if (resolvedVersion && resolvedVersion !== container.version) {
							versionsUpdated = true;
							return {
								...container,
								version: resolvedVersion
							};
						}
						return container;
					});
					
					if (versionsUpdated) {
						// Recalculate versions array and latestVersion
						const allVersions = new Set<string>();
						updatedContainers.forEach((c) => {
							if (c.version) allVersions.add(c.version);
						});
						const versionsArray = Array.from(allVersions).sort((a, b) => compareVersions(a, b));
						const latestVersion = versionsArray.length > 0 ? versionsArray[versionsArray.length - 1] : null;
						
						return {
							...app,
							containers: updatedContainers,
							versions: versionsArray,
							latestVersion
						};
					}
					
					return app;
				});
			}
		} catch (error) {
			// Silently fail - versions are optional
		}
	};

	const handleTitleHover = (appId: string, description: string | null) => {
		if (!description) return;
		
		hoveredAppId = appId;
		hoverTimeout = setTimeout(() => {
			if (hoveredAppId === appId) {
				// Show tooltip
				const tooltip = document.getElementById(`tooltip-${appId}`);
				if (tooltip) {
					tooltip.style.display = 'block';
				}
			}
		}, 1500); // 1.5 second delay
	};

	const handleTitleLeave = (appId: string) => {
		hoveredAppId = null;
		if (hoverTimeout) {
			clearTimeout(hoverTimeout);
			hoverTimeout = null;
		}
		const tooltip = document.getElementById(`tooltip-${appId}`);
		if (tooltip) {
			tooltip.style.display = 'none';
		}
	};

	const handleContainerHover = async (sourceId: string, containerId: string, containerName: string, event: MouseEvent) => {
		// Clear any existing timeout
		if (containerStatsTimeout) {
			clearTimeout(containerStatsTimeout);
		}

		// Only fetch stats for running containers
		const container = snapshot.apps
			.flatMap(app => app.containers)
			.find(c => c.sourceId === sourceId && c.containerId === containerId);

		if (!container || container.state !== 'running') {
			return;
		}

		const targetElement = (event.currentTarget as HTMLElement);
		hoveredContainer = { sourceId, containerId, containerName, element: targetElement };

		// Debounce: wait 500ms before fetching
		containerStatsTimeout = setTimeout(async () => {
			// Check cache first (cache for 2 seconds)
			const cacheKey = `${sourceId}-${containerId}`;
			const cached = containerStats[cacheKey];
			if (cached && Date.now() - cached.timestamp < 2000) {
				// Trigger reactivity to show tooltip
				containerStats = { ...containerStats };
				return; // Use cached data
			}
			
			try {
				const response = await fetch(`/api/container/${sourceId}/${containerId}/stats`);
				if (response.ok) {
					const stats = await response.json();
					containerStats[cacheKey] = {
						...stats,
						timestamp: Date.now()
					};
					// Trigger reactivity to show tooltip
					containerStats = { ...containerStats };
				}
			} catch (error) {
				// Silently fail
			}
		}, 500);
	};


	const handleContainerLeave = () => {
		// Add a small delay before hiding to allow mouse to move to tooltip
		if (hideTooltipTimeout) {
			clearTimeout(hideTooltipTimeout);
		}
		hideTooltipTimeout = setTimeout(() => {
			hoveredContainer = null;
			hideTooltipTimeout = null;
		}, 100); // 100ms delay to allow moving to tooltip
	};
	
	const handleTooltipEnter = () => {
		// Cancel hide timeout when mouse enters tooltip
		if (hideTooltipTimeout) {
			clearTimeout(hideTooltipTimeout);
			hideTooltipTimeout = null;
		}
	};
	
	const handleTooltipLeave = () => {
		// Hide tooltip when mouse leaves it
		hoveredContainer = null;
	};

	const handleServerHover = async (sourceLabel: string, event: MouseEvent) => {
		const targetElement = (event.currentTarget as HTMLElement);
		hoveredServer = { sourceLabel, element: targetElement };
		
		// Find the sourceId for this server
		const serverStat = snapshot.serverStats?.find(s => s.sourceLabel === sourceLabel);
		if (serverStat && !serverDetails[serverStat.sourceId]) {
			// Fetch detailed server info
			try {
				const response = await fetch(`/api/server/${serverStat.sourceId}/details`);
				if (response.ok) {
					const details = await response.json();
					serverDetails[serverStat.sourceId] = details;
					serverDetails = { ...serverDetails }; // Trigger reactivity
				}
			} catch (error) {
				// Silently fail
			}
		}
	};

	const handleServerLeave = () => {
		hoveredServer = null;
	};

	const fetchApps = async () => {
		isRefreshing = true;
		errorMessage = '';
		statsFetched = false; // Reset flag on refresh
		try {
			const response = await fetch('/api/apps');
			if (!response.ok) {
				throw new Error('Failed to refresh data');
			}
			snapshot = await response.json();
			
			// Fetch memory stats asynchronously (this can be slow)
			fetchMemoryStats();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unknown error';
		} finally {
			isRefreshing = false;
		}
	};

	const chipUrl = (app: AggregatedApp, index: number) => {
		const instance = app.containers[index];
		return instance.uiUrl ?? instance.ports.find((port) => port.url)?.url ?? null;
	};

	// Check if an app has issues (outdated versions or crashed containers)
	const hasIssues = (app: AggregatedApp): boolean => {
		return app.containers.some((container) => {
			// Check for crashed containers
			if (container.state !== 'running' && container.exitCode !== null && container.exitCode !== 0) {
				return true;
			}
			// Check for outdated versions
			if (app.latestVersion && container.version) {
				return compareVersions(container.version, app.latestVersion) < 0;
			}
			return false;
		});
	};

	$: filteredApps = snapshot.apps.filter((app) => {
		const matchesApp = selectedApp === 'all' || app.displayName === selectedApp;
		const matchesServer =
			selectedServer === 'all' ||
			app.containers.some((instance) => instance.sourceLabel === selectedServer);
		const matchesIssues = !showIssuesOnly || hasIssues(app);
		return matchesApp && matchesServer && matchesIssues;
	});
</script>

<div
	class="page"
	class:embed={embedMode}
	style:max-width={pageMaxWidth ?? 'none'}
	style:margin={pageMaxWidth ? '0 auto' : '0'}
>
		{#if !embedMode}
		<header class="toolbar">
			<div class="filters">
				<label>
					<!-- App -->
					<select bind:value={selectedApp}>
						<option value="all">All apps</option>
						{#each snapshot.appFilters as option}
							<option value={option}>{option}</option>
						{/each}
					</select>
				</label>
				<label>
					<!-- Server -->
					<select bind:value={selectedServer}>
						<option value="all">All servers</option>
						{#each snapshot.serverFilters as option}
							<option value={option}>{option}</option>
						{/each}
					</select>
				</label>
				<label class="checkbox-label">
					<input type="checkbox" bind:checked={showIssuesOnly} />
					issues only
				</label>
			</div>
			<div class="actions">
				<div class="stats-summary">
					<strong>{snapshot.totalContainers ?? 0}</strong> container{snapshot.totalContainers !== 1 ? 's' : ''}
				</div>
				<button class="refresh" on:click={fetchApps} disabled={isRefreshing}>
					{#if isRefreshing}
						Refreshing…
					{:else}
						Refresh
					{/if}
				</button>
				<small>Updated {new Date(snapshot.generatedAt).toLocaleString()}</small>
			</div>
		</header>
		{/if}

	{#if errorMessage}
		<p class="error">{errorMessage}</p>
	{/if}

	{#if snapshot.warnings.length && !embedMode}
		<section class="warnings">
			{#each snapshot.warnings as warning}
				<div class="warning">
					<strong>{warning.source}</strong>
					<span>{warning.message}</span>
				</div>
			{/each}
		</section>
	{/if}

	<section class="grid">
		{#if filteredApps.length === 0}
			<p class="empty">No containers match the current filters.</p>
		{:else}
			{#each filteredApps as app}
				<article class="card">
					<header>
						<div class="title">
							{#if app.icon}
								<img src={app.icon} alt={`${app.displayName} icon`} />
							{/if}
							<div class="title-content">
								<h2
									class:has-description={!!app.description}
									on:mouseenter={() => handleTitleHover(app.id, app.description ?? null)}
									on:mouseleave={() => handleTitleLeave(app.id)}
								>
									{app.displayName}
								</h2>
								<p class="subtitle">{app.image}</p>
								{#if app.description}
									<div id="tooltip-{app.id}" class="tooltip" role="tooltip">
										{app.description}
									</div>
								{/if}
							</div>
						</div>
						{#if app.latestVersion}
							<div class="versions">
								<span class="tag version">{formatVersionLabel(app.latestVersion)}</span>
							</div>
						{/if}
					</header>
					{#if showComposeTags && app.tags.length}
						<div class="tags">
							{#each app.tags as tag}
								<span class="tag">{tag}</span>
							{/each}
						</div>
					{/if}

					<div class="chips">
						{#each app.containers as server, index}
							{@const destination = chipUrl(app, index)}
							{@const hasVersionDiff = app.versions.length > 1 && server.version && server.version !== app.latestVersion}
							{@const isOutdated =
								app.latestVersion &&
								server.version &&
								compareVersions(server.version, app.latestVersion) < 0}
							{@const showVersion = hasVersionDiff && !isVersionDigest(server.version)}
							{@const isDigestVersion = isVersionDigest(server.version)}
							{@const isRunning = server.state === 'running'}
							{@const isCrashed = !isRunning && server.exitCode !== null && server.exitCode !== 0}
							{@const cacheKey = `${server.sourceId}-${server.containerId}`}
							{@const stats = containerStats[cacheKey]}
							{@const isHovered = hoveredContainer?.sourceId === server.sourceId && hoveredContainer?.containerId === server.containerId}
							{@const versionTooltip = isDigestVersion && server.version ? `Image digest: ${server.version}` : null}
							<div class="chip-wrapper">
								<button
									type="button"
									class="tag chip"
									class:outdated={isOutdated || (hasVersionDiff && isDigestVersion)}
									class:version-diff={hasVersionDiff && !isOutdated}
									class:stopped={!isRunning && !isCrashed}
									class:crashed={isCrashed}
									disabled={!destination}
									style:border-color={server.color}
									on:click={() => {
										if (destination) window.open(destination, '_blank', 'noopener');
									}}
									on:mouseenter={(e) => handleContainerHover(server.sourceId, server.containerId, server.containerName, e)}
									on:mouseleave={handleContainerLeave}
									title={versionTooltip || (destination ? 'Open service' : 'No exposed endpoint detected')}
								>
									<span class="chip-status" class:running={isRunning} class:stopped={!isRunning && !isCrashed} class:crashed={isCrashed}></span>
									<span class="chip-name">{server.sourceLabel}</span>
									{#if showVersion && server.version}
										<span class="chip-version">{formatVersionLabel(server.version)}</span>
									{/if}
									{#if hasVersionDiff && isDigestVersion}
										<span class="chip-version-indicator" title={versionTooltip || ''}>⚠</span>
									{/if}
								</button>
								{#if isHovered && isRunning && stats && hoveredContainer?.element}
									<div 
										on:mouseenter={handleTooltipEnter}
										on:mouseleave={handleTooltipLeave}
									>
										<Tooltip target={hoveredContainer.element}>
											<ContainerStatsTooltip containerName={server.containerName} {stats} ports={server.ports} />
										</Tooltip>
									</div>
								{/if}
							</div>
						{/each}
					</div>
				</article>
			{/each}
		{/if}
	</section>

	{#if !embedMode && snapshot.serverStats && snapshot.serverStats.length > 0}
		<section class="server-stats">
			<h3>Server Statistics</h3>
			<div class="stats-grid">
				{#each snapshot.serverStats as stats}
					<div class="stat-card">
						<div class="stat-header">
							<div class="stat-server-wrapper">
								<span 
									class="stat-server" 
									style:border-color={stats.color ?? 'rgba(79, 128, 255, 0.25)'}
									on:mouseenter={(e) => handleServerHover(stats.sourceLabel, e)}
									on:mouseleave={handleServerLeave}
								>{stats.sourceLabel}</span>
								{#if hoveredServer?.sourceLabel === stats.sourceLabel && hoveredServer?.element}
									{@const details = serverDetails[stats.sourceId]}
									<Tooltip target={hoveredServer.element}>
										<ServerStatsTooltip {stats} {details} />
									</Tooltip>
								{/if}
							</div>
							{#if stats.dockerVersion}
								<span class="stat-version">Docker {stats.dockerVersion}</span>
							{/if}
						</div>
						<div class="stat-body">
							<div class="stat-row">
								<span class="stat-label">Total:</span>
								<span class="stat-value">{stats.total}</span>
							</div>
							<div class="stat-row">
								<span class="stat-label">Running:</span>
								<span class="stat-value success">{stats.running}</span>
							</div>
							<div class="stat-row">
								<span class="stat-label">Stopped:</span>
								<span class="stat-value">{stats.stopped}</span>
							</div>
							{#if stats.crashed > 0}
								<div class="stat-row">
									<span class="stat-label">Crashed:</span>
									<span class="stat-value crashed-count">{stats.crashed}</span>
								</div>
							{/if}
							{#if stats.outdated > 0}
								<div class="stat-row">
									<span class="stat-label">Outdated:</span>
									<span class="stat-value warning">{stats.outdated}</span>
								</div>
							{/if}
						</div>
						{#if stats.memory || stats.storage}
							<div class="stat-resources">
								{#if stats.memory}
									<ResourceBar label="Memory" used={stats.memory.used} total={stats.memory.total} type="memory" />
								{/if}
								{#if stats.storage}
									<ResourceBar label="Storage" used={stats.storage.used} total={stats.storage.total} type="storage" />
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</section>
	{/if}
</div>

<style>
	:global(body) {
		margin: 0;
		font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		background: #070b16;
		color: #e1e7ff;
	}

	.page {
		padding: 1.5rem;
		width: 100%;
		box-sizing: border-box;
	}

	.page.embed {
		padding: 0.75rem;
	}

	:global(body[data-embed='true']) {
		background: transparent;
	}

	.toolbar {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: flex-end;
		gap: 1rem;
		margin-bottom: 1.5rem;
	}

	.filters {
		display: flex;
		gap: 1rem;
	}

	label {
		display: flex;
		flex-direction: column;
		font-size: 0.85rem;
		gap: 0.25rem;
	}

	select {
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		background: #101a33;
		border: 1px solid #22315a;
		color: inherit;
	}

	.actions {
		display: flex;
		gap: 0.75rem;
		align-items: center;
	}

	.refresh {
		padding: 0.6rem 1.25rem;
		border-radius: 999px;
		border: none;
		background: #4f80ff;
		color: #fff;
		cursor: pointer;
	}

	.refresh:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.error {
		color: #ff9f9f;
		background: rgba(255, 159, 159, 0.12);
		border: 1px solid rgba(255, 159, 159, 0.3);
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
	}

	.warnings {
		background: rgba(255, 194, 115, 0.08);
		border: 1px solid rgba(255, 194, 115, 0.3);
		border-radius: 1rem;
		padding: 1rem;
		margin: 1.25rem 0;
	}

	.warning {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		font-size: 0.9rem;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
		gap: 1.25rem;
		width: 100%;
		box-sizing: border-box;
	}

	.card {
		background: rgba(16, 25, 46, 0.85);
		border: 1px solid rgba(79, 128, 255, 0.15);
		border-radius: 1rem;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		box-shadow: 0 20px 40px rgba(5, 6, 24, 0.7);
	}

	.card header {
		display: flex;
		justify-content: space-between;
		gap: 0.5rem;
		align-items: flex-start;
	}

	.title {
		display: flex;
		gap: 0.75rem;
		flex: 1;
		min-width: 0;
	}

	.title img {
		width: auto;
		height: 2rem; /* Match title + subtitle height */
		max-height: 2rem;
		border-radius: 10px;
		object-fit: contain;
		align-self: flex-start;
	}

	.title-content {
		position: relative;
		flex: 1;
		min-width: 0;
	}

	h2 {
		margin: 0;
		font-size: 1.1rem;
		cursor: default;
		line-height: 1.2;
	}

	h2.has-description {
		cursor: help;
	}

	.tooltip {
		display: none;
		position: absolute;
		top: 100%;
		left: 0;
		margin-top: 0.5rem;
		padding: 0.75rem 1rem;
		background: rgba(16, 25, 46, 0.98);
		border: 1px solid rgba(79, 128, 255, 0.3);
		border-radius: 0.5rem;
		color: #b0bbd8;
		font-size: 0.85rem;
		line-height: 1.5;
		max-width: 320px;
		z-index: 1000;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
		pointer-events: none;
		word-wrap: break-word;
	}

	.subtitle {
		margin: 0;
		font-size: 0.7rem;
		color: #7f8bad;
		word-break: break-all;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: min(65vw, 240px);
		display: block;
		line-height: 1.2;
	}

	.versions {
		display: flex;
		gap: 0.25rem;
		flex-wrap: wrap;
		justify-content: flex-end;
		align-items: flex-start;
		flex-shrink: 0;
	}

	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	.tag {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.32rem 0.8rem;
		background: rgba(255, 255, 255, 0.08);
		border-radius: 999px;
		font-size: 0.75rem;
		color: #c8d2fb;
		text-transform: lowercase;
		letter-spacing: 0.03em;
		border: 1px solid transparent;
	}

	.tag.version {
		background: rgba(79, 128, 255, 0.2);
		border-color: rgba(79, 128, 255, 0.45);
		font-weight: 600;
		text-transform: none;
		padding: 0.25rem 0.7rem;
		letter-spacing: 0.03em;
		font-size: 0.75rem;
		line-height: 1.2;
		height: fit-content;
		align-self: flex-start;
	}


	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}

	.tag.chip {
		border: none;
		background: rgba(79, 128, 255, 0.12);
		border: 1px solid rgba(79, 128, 255, 0.25);
		cursor: pointer;
		text-transform: none;
		padding: 0.2rem 0.6rem;
		min-height: auto;
		height: auto;
		line-height: 1.3;
		font-size: 0.72rem;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}

	.tag.chip.stopped {
		opacity: 0.7;
	}

	.tag.chip.crashed {
		border-color: rgba(255, 71, 87, 0.6);
		background: rgba(255, 71, 87, 0.2);
	}

	.tag.chip:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.tag.chip.outdated {
		border-color: rgba(255, 99, 132, 0.65);
		background: rgba(255, 99, 132, 0.12);
		color: #ffdbe4;
	}

	.chip-status {
		display: inline-block;
		width: 0.35rem;
		height: 0.35rem;
		border-radius: 50%;
		margin-right: 0.25rem;
		flex-shrink: 0;
	}

	.chip-status.running {
		background-color: #51cf66;
		box-shadow: 0 0 0 2px rgba(81, 207, 102, 0.4), 0 0 4px rgba(81, 207, 102, 0.6);
		opacity: 1;
	}

	.chip-status.stopped {
		background-color: #868e96;
		opacity: 0.6;
	}

	.chip-status.crashed {
		background-color: #ff4757;
		box-shadow: 0 0 0 2px rgba(255, 71, 87, 0.4), 0 0 4px rgba(255, 71, 87, 0.6);
		opacity: 1;
	}

	.chip-name {
		text-transform: none;
	}

	.chip-version {
		font-weight: 700;
		color: #ff9b9b;
		text-transform: none;
		font-size: 0.72rem;
	}

	.chip-version-indicator {
		font-size: 0.7rem;
		color: #ffd43b;
		margin-left: 0.2rem;
		line-height: 1;
	}

	.tag.chip.version-diff {
		border-color: rgba(255, 212, 59, 0.5);
		background: rgba(255, 212, 59, 0.1);
	}

	.chip-wrapper {
		position: relative;
		display: inline-block;
	}



	.empty {
		color: #8ea1d8;
		font-size: 0.95rem;
	}

	.checkbox-label {
		display: inline-flex;
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		user-select: none;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.checkbox-label input[type="checkbox"] {
		cursor: pointer;
		width: 1.1rem;
		height: 1.1rem;
		accent-color: #4f80ff;
	}

	.stats-summary {
		font-size: 0.9rem;
		color: #c8d2fb;
		margin-right: 0.5rem;
	}

	.stats-summary strong {
		color: #e1e7ff;
		font-weight: 600;
	}

	.server-stats {
		margin-top: 2rem;
		padding-top: 1.5rem;
		border-top: 1px solid rgba(79, 128, 255, 0.15);
	}

	.server-stats h3 {
		margin: 0 0 1rem 0;
		font-size: 1.1rem;
		color: #e1e7ff;
		font-weight: 600;
	}

	.stats-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 1rem;
	}

	.stat-card {
		background: rgba(16, 25, 46, 0.85);
		border: 1px solid rgba(79, 128, 255, 0.15);
		border-radius: 0.75rem;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.stat-header {
		border-bottom: 1px solid rgba(79, 128, 255, 0.1);
		padding-bottom: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.stat-server-wrapper {
		position: relative;
		display: inline-block;
	}

	.stat-server {
		display: inline-block;
		padding: 0.25rem 0.6rem;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 600;
		background: rgba(79, 128, 255, 0.12);
		border: 1px solid rgba(79, 128, 255, 0.25);
		color: #c8d2fb;
		cursor: pointer;
		transition: background-color 0.2s;
	}

	.stat-server:hover {
		background-color: rgba(79, 128, 255, 0.2);
	}



	.stat-body {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.stat-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 0.85rem;
	}

	.stat-label {
		color: #7f8bad;
	}

	.stat-value {
		color: #e1e7ff;
		font-weight: 600;
	}

	.stat-value.success {
		color: #51cf66;
	}

	.stat-value.crashed-count {
		color: #ff4757;
	}

	.stat-value.warning {
		color: #ffd43b;
	}

	.stat-version {
		font-size: 0.7rem;
		color: #7f8bad;
		margin-top: 0.25rem;
		display: block;
	}

	.stat-resources {
		margin-top: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid rgba(79, 128, 255, 0.1);
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

</style>
