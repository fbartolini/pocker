<script lang="ts">
	import { browser } from '$app/environment';
	import type { AggregatedApp, AppsResponse } from '$lib/types';
	import { compareVersions, formatVersionLabel } from '$lib/utils/version';

	export let data: { initialData: AppsResponse; embed: boolean; maxWidth: string | null };

	let snapshot: AppsResponse = data.initialData;
	let filteredApps: AggregatedApp[] = snapshot.apps;
	let selectedApp = 'all';
	let selectedServer = 'all';
	let isRefreshing = false;
	let errorMessage = '';
	let embedMode = data.embed;
	let pageMaxWidth = data.maxWidth;
	let showComposeTags = snapshot.showComposeTags ?? false;
	let hoverTimeout: ReturnType<typeof setTimeout> | null = null;
	let hoveredAppId: string | null = null;

	$: embedMode = data.embed;
	$: pageMaxWidth = data.maxWidth;
	$: showComposeTags = snapshot.showComposeTags ?? false;
	$: if (browser) {
		document.body.dataset.embed = embedMode ? 'true' : 'false';
	}

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

	const fetchApps = async () => {
		isRefreshing = true;
		errorMessage = '';
		try {
			const response = await fetch('/api/apps');
			if (!response.ok) {
				throw new Error('Failed to refresh data');
			}
			snapshot = await response.json();
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

	$: filteredApps = snapshot.apps.filter((app) => {
		const matchesApp = selectedApp === 'all' || app.displayName === selectedApp;
		const matchesServer =
			selectedServer === 'all' ||
			app.containers.some((instance) => instance.sourceLabel === selectedServer);
		return matchesApp && matchesServer;
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
					App
					<select bind:value={selectedApp}>
						<option value="all">All apps</option>
						{#each snapshot.appFilters as option}
							<option value={option}>{option}</option>
						{/each}
					</select>
				</label>
				<label>
					Server
					<select bind:value={selectedServer}>
						<option value="all">All servers</option>
						{#each snapshot.serverFilters as option}
							<option value={option}>{option}</option>
						{/each}
					</select>
				</label>
			</div>
			<div class="actions">
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
							{@const isOutdated =
								app.latestVersion &&
								server.version &&
								compareVersions(server.version, app.latestVersion) < 0}
							{@const showVersion = app.versions.length > 1 && isOutdated}
							{@const isRunning = server.state === 'running'}
							<button
								type="button"
								class="tag chip"
								class:outdated={isOutdated}
								class:stopped={!isRunning}
								disabled={!destination}
								style:border-color={server.color}
								on:click={() => {
									if (destination) window.open(destination, '_blank', 'noopener');
								}}
								title={destination ? 'Open service' : 'No exposed endpoint detected'}
							>
								<span class="chip-status" class:running={isRunning} class:stopped={!isRunning}></span>
								<span class="chip-name">{server.sourceLabel}</span>
								{#if showVersion && server.version}
									<span class="chip-version">{formatVersionLabel(server.version)}</span>
								{/if}
							</button>
						{/each}
					</div>
				</article>
			{/each}
		{/if}
	</section>
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
		box-shadow: 0 0 0 2px rgba(81, 207, 102, 0.3);
	}

	.chip-status.stopped {
		background-color: #868e96;
		opacity: 0.6;
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

	.empty {
		color: #8ea1d8;
		font-size: 0.95rem;
	}
</style>
