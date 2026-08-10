export function chunkText(text: string, maxCodePoints: number): string[] {
	if (!text) return [];
	if (!Number.isSafeInteger(maxCodePoints) || maxCodePoints < 1) {
		throw new Error('maxCodePoints must be a positive integer');
	}

	const points = Array.from(text);
	if (points.length <= maxCodePoints) return [text];

	const chunks: string[] = [];
	let offset = 0;
	const minimumPreferredBreak = Math.floor(maxCodePoints * 0.55);

	while (offset < points.length) {
		const remaining = points.length - offset;
		if (remaining <= maxCodePoints) {
			chunks.push(points.slice(offset).join(''));
			break;
		}

		const window = points.slice(offset, offset + maxCodePoints);
		let cut = -1;
		const joined = window.join('');
		const preferred = ['\n\n', '\n', '。', '！', '？', '!', '?', '；', ';', ' '];
		for (const marker of preferred) {
			const index = joined.lastIndexOf(marker);
			if (index < 0) continue;
			const candidate = Array.from(joined.slice(0, index + marker.length)).length;
			if (candidate >= minimumPreferredBreak) {
				cut = candidate;
				break;
			}
		}
		if (cut < 1) cut = maxCodePoints;
		chunks.push(points.slice(offset, offset + cut).join(''));
		offset += cut;
	}

	return chunks;
}
