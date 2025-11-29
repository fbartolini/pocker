<script lang="ts">
	import { onMount } from 'svelte';
	
	export let target: HTMLElement | null = null;
	export let position: 'above' | 'below' = 'above';
	export let offset = 8;
	
	let tooltip: HTMLElement;
	let isAbove = true;
	let isBelow = false;
	
	function updatePosition() {
		if (!tooltip || !target) return;
		
		const targetRect = target.getBoundingClientRect();
		const tooltipRect = tooltip.getBoundingClientRect();
		
		let left = targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2);
		let top = position === 'above' 
			? targetRect.top - tooltipRect.height - offset
			: targetRect.bottom + offset;
		
		// Adjust for left edge
		if (left < 8) {
			left = 8;
		}
		
		// Adjust for right edge
		if (left + tooltipRect.width > window.innerWidth - 8) {
			left = window.innerWidth - tooltipRect.width - 8;
		}
		
		// Adjust for top edge - flip to below if needed
		if (top < 8) {
			top = targetRect.bottom + offset;
			isAbove = false;
			isBelow = true;
		} else {
			isAbove = true;
			isBelow = false;
		}
		
		tooltip.style.left = `${left}px`;
		tooltip.style.top = `${top}px`;
	}
	
	onMount(() => {
		if (tooltip && target) {
			updatePosition();
		}
	});
	
	$: if (tooltip && target) {
		updatePosition();
	}
</script>

<div 
	bind:this={tooltip}
	class="tooltip"
	class:above={isAbove}
	class:below={isBelow}
	style="position: fixed; z-index: 1000; pointer-events: none;"
>
	<slot />
</div>

<style>
	.tooltip {
		background: rgba(16, 25, 46, 0.98);
		border: 1px solid rgba(79, 128, 255, 0.3);
		border-radius: 0.5rem;
		padding: 0.6rem 0.75rem;
		min-width: 180px;
		max-width: 300px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
		backdrop-filter: blur(8px);
		font-size: 0.7rem;
		color: #e1e7ff;
	}
	
	.tooltip::after {
		content: '';
		position: absolute;
		left: 50%;
		transform: translateX(-50%);
		border: 6px solid transparent;
	}
	
	.tooltip.above::after {
		top: 100%;
		border-top-color: rgba(79, 128, 255, 0.3);
	}
	
	.tooltip.below::after {
		bottom: 100%;
		border-bottom-color: rgba(79, 128, 255, 0.3);
	}
	
	/* Content styles */
	:global(.stats-header) {
		font-weight: 600;
		color: #e1e7ff;
		margin-bottom: 0.4rem;
		padding-bottom: 0.4rem;
		border-bottom: 1px solid rgba(79, 128, 255, 0.2);
		font-size: 0.75rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	
	:global(.stats-row) {
		display: flex;
		justify-content: space-between;
		gap: 0.75rem;
		align-items: baseline;
		margin-bottom: 0.2rem;
	}
	
	:global(.stats-label) {
		color: #b0bbd8;
		flex-shrink: 0;
		margin-right: 0.5rem;
	}
	
	:global(.stats-value) {
		font-weight: 500;
		color: #e1e7ff;
		text-align: right;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	
	:global(.stats-divider) {
		height: 1px;
		background: rgba(79, 128, 255, 0.2);
		margin: 0.4rem 0;
	}
</style>

