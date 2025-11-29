<script lang="ts">
	import { formatBytes } from '$lib/utils/format';
	import type { ExposedPort } from '$lib/types';
	
	export let containerName: string;
	export let stats: {
		memory?: { usage: number; limit: number; percent: number };
		cpu?: { percent: number };
		network?: { rx_bytes: number; tx_bytes: number };
		pids?: number;
	};
	export let ports: ExposedPort[] = [];
	
	const handlePortClick = (url: string, event: MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
		window.open(url, '_blank', 'noopener,noreferrer');
	};
</script>

<div class="stats-header">{containerName}</div>
{#if stats.memory}
	<div class="stats-row">
		<span class="stats-label">Memory:</span>
		<span class="stats-value">{formatBytes(stats.memory.usage, 1)} / {formatBytes(stats.memory.limit, 1)} ({stats.memory.percent.toFixed(0)}%)</span>
	</div>
{/if}
{#if stats.cpu !== undefined}
	<div class="stats-row">
		<span class="stats-label">CPU:</span>
		<span class="stats-value">{stats.cpu.percent.toFixed(1)}%</span>
	</div>
{/if}
{#if stats.network}
	<div class="stats-row">
		<span class="stats-label">Network:</span>
		<span class="stats-value">↓ {formatBytes(stats.network.rx_bytes, 1)} ↑ {formatBytes(stats.network.tx_bytes, 1)}</span>
	</div>
{/if}
{#if stats.pids !== undefined}
	<div class="stats-row">
		<span class="stats-label">PIDs:</span>
		<span class="stats-value">{stats.pids}</span>
	</div>
{/if}
{#if ports.length > 0}
	<div class="stats-row ports">
		<span class="stats-label">Ports:</span>
		<div class="ports-list">
			{#each ports as port}
				{#if port.url}
					<a 
						href={port.url} 
						class="port-link"
						on:click={(e) => handlePortClick(port.url!, e)}
						on:mouseenter|stopPropagation
						on:mouseleave|stopPropagation
						target="_blank"
						rel="noopener noreferrer"
					>
						{port.public || port.private}:{port.type || 'tcp'}
					</a>
				{:else if port.public}
					<span class="port-text">
						{port.public}:{port.type || 'tcp'}
					</span>
				{/if}
			{/each}
		</div>
	</div>
{/if}

<style>
	:global(.stats-row.ports) {
		flex-direction: column;
		align-items: flex-start;
		gap: 0.25rem;
	}

	.ports-list {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}

	.port-link {
		color: #4f80ff;
		text-decoration: none;
		cursor: pointer;
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		background: rgba(79, 128, 255, 0.1);
		transition: background 0.2s;
		font-size: 0.75rem;
		white-space: nowrap;
	}

	.port-link:hover {
		background: rgba(79, 128, 255, 0.2);
		text-decoration: underline;
	}

	.port-text {
		color: #8ea1d8;
		font-size: 0.75rem;
		padding: 0.125rem 0.375rem;
		white-space: nowrap;
	}
</style>

