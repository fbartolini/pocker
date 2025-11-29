/**
 * Format bytes to human-readable format
 */
export const formatBytes = (bytes: number, decimals: number = 1): string => {
	if (bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${(bytes / Math.pow(k, i)).toFixed(decimals)} ${sizes[i]}`;
};

/**
 * Format percentage
 */
export const formatPercent = (used: number, total: number, decimals: number = 1): string => {
	if (total === 0) return '0%';
	return `${((used / total) * 100).toFixed(decimals)}%`;
};

