<script lang="ts">
	import { formatBytes, formatPercent } from '$lib/utils/format';
	
	export let label: string;
	export let used: number;
	export let total: number;
	export let type: 'memory' | 'storage' = 'memory';
	
	$: percent = total > 0 ? (used / total) * 100 : 0;
	$: percentText = formatPercent(used, total);
</script>

<div class="resource-item">
	<div class="resource-header">
		<span class="resource-label">{label}</span>
		<span class="resource-percent">{percentText}</span>
	</div>
	<div class="resource-bar">
		<div 
			class="resource-bar-fill {type}"
			style="width: {percent}%"
		></div>
	</div>
	<div class="resource-details">
		<span>{formatBytes(used)}</span> / <span>{formatBytes(total)}</span>
	</div>
</div>

<style>
	.resource-item {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.resource-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 0.75rem;
	}

	.resource-label {
		color: #c8d2fb;
		font-weight: 500;
	}

	.resource-percent {
		color: #8ea1d8;
		font-size: 0.7rem;
	}

	.resource-bar {
		height: 6px;
		background: rgba(255, 255, 255, 0.1);
		border-radius: 3px;
		overflow: hidden;
	}

	.resource-bar-fill {
		height: 100%;
		border-radius: 3px;
		transition: width 0.3s ease;
	}

	.resource-bar-fill.memory {
		background: linear-gradient(90deg, #4f80ff 0%, #6b9fff 100%);
	}

	.resource-bar-fill.storage {
		background: linear-gradient(90deg, #7c3aed 0%, #a855f7 100%);
	}

	.resource-details {
		display: flex;
		justify-content: space-between;
		font-size: 0.7rem;
		color: #8ea1d8;
		gap: 0.25rem;
	}
</style>

