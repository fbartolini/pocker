<script lang="ts">
	import { formatBytes } from '$lib/utils/format';
	
	export let containerName: string;
	export let stats: {
		memory?: { usage: number; limit: number; percent: number };
		cpu?: { percent: number };
		network?: { rx_bytes: number; tx_bytes: number };
		pids?: number;
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

