/**
 * Generate a consistent color for a given string (e.g., server name).
 * Uses a simple hash function to deterministically assign colors.
 */
export const generateColorForString = (str: string): string => {
	// Predefined palette of nice colors that work well on dark backgrounds
	const colors = [
		'#4f80ff', // Blue
		'#ff6b6b', // Red
		'#51cf66', // Green
		'#ffd43b', // Yellow
		'#ff922b', // Orange
		'#ae3ec9', // Purple
		'#20c997', // Teal
		'#fa5252', // Pink-red
		'#339af0', // Light blue
		'#51cf66', // Light green
		'#ffd43b', // Light yellow
		'#ff922b', // Light orange
		'#845ef7', // Indigo
		'#f06595', // Pink
		'#22b8cf', // Cyan
		'#ffa94d'  // Amber
	];

	// Simple hash function
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = str.charCodeAt(i) + ((hash << 5) - hash);
	}
	
	// Use absolute value and modulo to get index
	const index = Math.abs(hash) % colors.length;
	return colors[index];
};

