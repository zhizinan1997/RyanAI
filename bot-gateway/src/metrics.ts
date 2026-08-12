function labels(values: Record<string, string>): string {
	const entries = Object.entries(values);
	if (!entries.length) return '';
	return `{${entries.map(([key, value]) => `${key}="${value.replace(/[\\"\n]/g, '\\$&')}"`).join(',')}}`;
}

export class GatewayMetrics {
	private readonly counters = new Map<string, number>();
	private readonly gauges = new Map<string, number>();
	private readonly durationTotals = new Map<string, { count: number; sum: number }>();

	inc(name: string, labelValues: Record<string, string> = {}, value = 1): void {
		const key = `${name}${labels(labelValues)}`;
		this.counters.set(key, (this.counters.get(key) ?? 0) + value);
	}

	set(name: string, value: number, labelValues: Record<string, string> = {}): void {
		this.gauges.set(`${name}${labels(labelValues)}`, value);
	}

	observe(name: string, seconds: number, labelValues: Record<string, string> = {}): void {
		const key = `${name}${labels(labelValues)}`;
		const current = this.durationTotals.get(key) ?? { count: 0, sum: 0 };
		current.count += 1;
		current.sum += seconds;
		this.durationTotals.set(key, current);
	}

	render(): string {
		const lines: string[] = [];
		for (const [key, value] of [...this.counters].sort()) lines.push(`${key} ${value}`);
		for (const [key, value] of [...this.gauges].sort()) lines.push(`${key} ${value}`);
		for (const [key, value] of [...this.durationTotals].sort()) {
			lines.push(`${key}_count ${value.count}`);
			lines.push(`${key}_sum ${value.sum}`);
		}
		return `${lines.join('\n')}\n`;
	}
}
