<script lang="ts">
	import { generateColorForString } from '$lib/utils/colors';
	import { formatBytes, formatPercent } from '$lib/utils/format';
	
	export let containers: Array<{ name: string; memory: number }>;
	export let memoryTotal: number;
	
	// Generate muted colors that work with dark theme
	const getMutedColor = (index: number, total: number): string => {
		// Use a palette of muted colors that work with the dark theme
		const colors = [
			'#4f80ff', // Primary blue
			'#6b9fff', // Light blue
			'#51cf66', // Green
			'#ffd43b', // Yellow
			'#ff922b', // Orange
			'#845ef7', // Purple
			'#20c997', // Teal
			'#339af0', // Sky blue
			'#f06595', // Pink
			'#22b8cf', // Cyan
			'#ffa94d', // Amber
			'#ae3ec9'  // Violet
		];
		
		// Use color based on index, with some variation
		const baseColor = colors[index % colors.length];
		
		// Make colors more muted for dark theme (reduce saturation slightly)
		return baseColor;
	};
	
	// Calculate pie chart data
	$: pieData = (() => {
		if (!containers || containers.length === 0 || !memoryTotal || memoryTotal === 0) {
			return [];
		}
		
		// Sort by memory descending
		const sorted = [...containers].sort((a, b) => b.memory - a.memory);
		
		// Calculate angles for pie chart (donut style with inner radius)
		let currentAngle = -90; // Start at top
		const segments = sorted.map((container, index) => {
			const percentage = (container.memory / memoryTotal) * 100;
			const angle = (percentage / 100) * 360;
			const startAngle = currentAngle;
			currentAngle += angle;
			
			return {
				name: container.name,
				memory: container.memory,
				percentage,
				startAngle,
				angle,
				color: getMutedColor(index, sorted.length)
			};
		});
		
		return segments;
	})();
	
	// SVG path helper for donut slice (with inner radius)
	const createDonutSlice = (startAngle: number, angle: number, outerRadius: number, innerRadius: number) => {
		const startRad = (startAngle * Math.PI) / 180;
		const endRad = ((startAngle + angle) * Math.PI) / 180;
		
		const x1 = 50 + outerRadius * Math.cos(startRad);
		const y1 = 50 + outerRadius * Math.sin(startRad);
		const x2 = 50 + outerRadius * Math.cos(endRad);
		const y2 = 50 + outerRadius * Math.sin(endRad);
		
		const x3 = 50 + innerRadius * Math.cos(endRad);
		const y3 = 50 + innerRadius * Math.sin(endRad);
		const x4 = 50 + innerRadius * Math.cos(startRad);
		const y4 = 50 + innerRadius * Math.sin(startRad);
		
		const largeArc = angle > 180 ? 1 : 0;
		
		return `M ${x1} ${y1} A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${x4} ${y4} Z`;
	};
	
	let hoveredSegment: typeof pieData[0] | null = null;
</script>

{#if pieData && pieData.length > 0}
	<div class="pie-chart-container">
		<div class="pie-chart-wrapper">
			<svg viewBox="0 0 100 100" class="pie-chart">
				{#each pieData as segment}
					{@const path = createDonutSlice(segment.startAngle, segment.angle, 45, 20)}
					<path
						d={path}
						fill={segment.color}
						opacity={hoveredSegment === segment ? 0.9 : hoveredSegment ? 0.25 : 0.65}
						stroke="rgba(7, 11, 22, 0.6)"
						stroke-width="0.8"
						class="pie-slice"
						on:mouseenter={() => hoveredSegment = segment}
						on:mouseleave={() => hoveredSegment = null}
					/>
				{/each}
				<!-- Center circle for donut style -->
				<circle cx="50" cy="50" r="20" fill="rgba(16, 25, 46, 0.6)" stroke="rgba(79, 128, 255, 0.15)" stroke-width="0.5" />
			</svg>
			{#if hoveredSegment}
				<div class="pie-tooltip">
					<div class="pie-tooltip-name">{hoveredSegment.name}</div>
					<div class="pie-tooltip-memory">{formatBytes(hoveredSegment.memory, 1)}</div>
					<div class="pie-tooltip-percent">{formatPercent(hoveredSegment.memory, memoryTotal)}</div>
				</div>
			{/if}
		</div>
		<div class="pie-legend">
			{#each pieData.slice(0, 5) as segment}
				<div 
					class="legend-item"
					class:hovered={hoveredSegment === segment}
					on:mouseenter={() => hoveredSegment = segment}
					on:mouseleave={() => hoveredSegment = null}
				>
					<span class="legend-color" style:background-color={segment.color}></span>
					<span class="legend-name" title={segment.name}>{segment.name}</span>
					<span class="legend-percent">{formatPercent(segment.memory, memoryTotal)}</span>
				</div>
			{/each}
			{#if pieData.length > 5}
				{@const otherMemory = pieData.slice(5).reduce((sum, s) => sum + s.memory, 0)}
				<div class="legend-item other">
					<span class="legend-color" style:background-color="rgba(127, 141, 173, 0.5)"></span>
					<span class="legend-name">Other ({pieData.length - 5} containers)</span>
					<span class="legend-percent">{formatPercent(otherMemory, memoryTotal)}</span>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.pie-chart-container {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-top: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid rgba(79, 128, 255, 0.1);
	}
	
	.pie-chart-wrapper {
		position: relative;
		display: flex;
		justify-content: center;
		align-items: center;
		height: 140px;
	}
	
	.pie-chart {
		width: 140px;
		height: 140px;
		filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.2));
	}
	
	.pie-slice {
		cursor: pointer;
		transition: opacity 0.2s ease, filter 0.2s ease;
	}
	
	.pie-slice:hover {
		filter: brightness(1.1);
	}
	
	.pie-tooltip {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		background: rgba(16, 25, 46, 0.98);
		border: 1px solid rgba(79, 128, 255, 0.3);
		border-radius: 0.5rem;
		padding: 0.5rem 0.75rem;
		pointer-events: none;
		z-index: 10;
		text-align: center;
		min-width: 120px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
		backdrop-filter: blur(8px);
	}
	
	.pie-tooltip-name {
		font-size: 0.7rem;
		font-weight: 600;
		color: #e1e7ff;
		margin-bottom: 0.25rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	
	.pie-tooltip-memory {
		font-size: 0.65rem;
		color: #c8d2fb;
		margin-bottom: 0.15rem;
	}
	
	.pie-tooltip-percent {
		font-size: 0.65rem;
		color: #7f8bad;
	}
	
	.pie-legend {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		font-size: 0.75rem;
	}
	
	.legend-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0;
		cursor: pointer;
		opacity: 0.75;
		transition: opacity 0.2s ease, transform 0.2s ease;
		border-radius: 0.25rem;
		padding-left: 0.25rem;
		margin-left: -0.25rem;
	}
	
	.legend-item:hover,
	.legend-item.hovered {
		opacity: 1;
		background: rgba(79, 128, 255, 0.08);
		transform: translateX(2px);
	}
	
	.legend-item.other {
		opacity: 0.65;
	}
	
	.legend-color {
		width: 0.65rem;
		height: 0.65rem;
		border-radius: 3px;
		flex-shrink: 0;
		box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.2);
	}
	
	.legend-name {
		flex: 1;
		color: #c8d2fb;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		font-size: 0.72rem;
	}
	
	.legend-percent {
		color: #8ea1d8;
		font-weight: 500;
		font-size: 0.7rem;
		flex-shrink: 0;
	}
</style>

