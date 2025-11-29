<script lang="ts">
	import { formatBytes, formatPercent } from '$lib/utils/format';
	import type { ServerStats } from '$lib/types';
	
	export let stats: ServerStats;
	export let details: { topContainers: Array<{ name: string; memory: number }>; memoryTotal: number } | undefined;
</script>

<div class="stats-header">{stats.sourceLabel}</div>
{#if stats.dockerVersion}
	<div class="stats-row">
		<span class="stats-label">Docker:</span>
		<span class="stats-value">{stats.dockerVersion}</span>
	</div>
{/if}
{#if stats.cpuCount}
	<div class="stats-row">
		<span class="stats-label">CPUs:</span>
		<span class="stats-value">{stats.cpuCount}</span>
	</div>
{/if}
{#if stats.totalImages !== undefined}
	<div class="stats-row">
		<span class="stats-label">Images:</span>
		<span class="stats-value">{stats.totalImages}</span>
	</div>
{/if}
{#if stats.operatingSystem || stats.kernelVersion}
	<div class="stats-divider"></div>
	{#if stats.operatingSystem}
		<div class="stats-row">
			<span class="stats-label">OS:</span>
			<span class="stats-value">{stats.operatingSystem}</span>
		</div>
	{/if}
	{#if stats.kernelVersion}
		<div class="stats-row">
			<span class="stats-label">Kernel:</span>
			<span class="stats-value">{stats.kernelVersion}</span>
		</div>
	{/if}
	{#if stats.architecture}
		<div class="stats-row">
			<span class="stats-label">Arch:</span>
			<span class="stats-value">{stats.architecture}</span>
		</div>
	{/if}
	{#if stats.storageDriver}
		<div class="stats-row">
			<span class="stats-label">Driver:</span>
			<span class="stats-value">{stats.storageDriver}</span>
		</div>
	{/if}
{/if}
{#if stats.memory}
	<div class="stats-divider"></div>
	<div class="stats-row">
		<span class="stats-label">Memory:</span>
		<span class="stats-value">{formatBytes(stats.memory.used, 1)} / {formatBytes(stats.memory.total, 1)} ({formatPercent(stats.memory.used, stats.memory.total)})</span>
	</div>
	<div class="stats-row">
		<span class="stats-label">Available:</span>
		<span class="stats-value">{formatBytes(stats.memory.available, 1)}</span>
	</div>
{/if}
{#if stats.storage}
	<div class="stats-divider"></div>
	<div class="stats-row">
		<span class="stats-label">Storage:</span>
		<span class="stats-value">{formatBytes(stats.storage.used, 1)} / {formatBytes(stats.storage.total, 1)} ({formatPercent(stats.storage.used, stats.storage.total)})</span>
	</div>
	<div class="stats-row">
		<span class="stats-label">Available:</span>
		<span class="stats-value">{formatBytes(stats.storage.available, 1)}</span>
	</div>
{/if}
										{#if stats.dockerStorage && stats.dockerStorage.total > 0}
											<div class="stats-divider"></div>
											<div class="stats-row">
												<span class="stats-label" style="font-weight: 600;">Docker Storage:</span>
											</div>
											<div class="stats-row" style="padding-left: 0.5rem; font-size: 0.68rem;">
												<span class="stats-label">Images:</span>
												<span class="stats-value">{formatBytes(stats.dockerStorage.images, 1)}</span>
											</div>
											<div class="stats-row" style="padding-left: 0.5rem; font-size: 0.68rem;">
												<span class="stats-label">Containers:</span>
												<span class="stats-value">{formatBytes(stats.dockerStorage.containers, 1)}</span>
											</div>
											<div class="stats-row" style="padding-left: 0.5rem; font-size: 0.68rem;">
												<span class="stats-label">Volumes:</span>
												<span class="stats-value">{formatBytes(stats.dockerStorage.volumes, 1)}</span>
											</div>
											<div class="stats-row" style="padding-left: 0.5rem; font-size: 0.68rem; font-weight: 600;">
												<span class="stats-label">Total:</span>
												<span class="stats-value">{formatBytes(stats.dockerStorage.total, 1)}</span>
											</div>
										{/if}
										{#if details && details.topContainers && details.topContainers.length > 0}
											<div class="stats-divider"></div>
											<div class="stats-row">
												<span class="stats-label" style="font-weight: 600;">Top Containers (Memory):</span>
											</div>
											{#each details.topContainers as container}
												<div class="stats-row" style="padding-left: 0.5rem; font-size: 0.68rem;">
													<span class="stats-label" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px;">{container.name}:</span>
													<span class="stats-value">{formatBytes(container.memory, 1)}</span>
												</div>
											{/each}
										{/if}

