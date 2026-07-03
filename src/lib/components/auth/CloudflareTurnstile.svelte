<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';

	export let siteKey = '';
	export let token = '';

	type TurnstileApi = {
		render: (container: HTMLElement, options: Record<string, unknown>) => string;
		reset: (widgetId: string) => void;
		remove: (widgetId: string) => void;
	};

	const getTurnstile = () => (window as Window & { turnstile?: TurnstileApi }).turnstile;

	let containerEl: HTMLDivElement;
	let widgetId: string | null = null;

	const scriptId = 'cloudflare-turnstile-script';

	const loadTurnstileScript = () => {
		if (getTurnstile()) {
			return Promise.resolve();
		}

		const existingScript = document.getElementById(scriptId);
		if (existingScript) {
			return new Promise<void>((resolve, reject) => {
				existingScript.addEventListener('load', () => resolve(), { once: true });
				existingScript.addEventListener('error', () => reject(), { once: true });
			});
		}

		return new Promise<void>((resolve, reject) => {
			const script = document.createElement('script');
			script.id = scriptId;
			script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
			script.async = true;
			script.defer = true;
			script.addEventListener('load', () => resolve(), { once: true });
			script.addEventListener('error', () => reject(), { once: true });
			document.head.appendChild(script);
		});
	};

	const renderTurnstile = async () => {
		const turnstile = getTurnstile();
		if (!siteKey || !containerEl || widgetId || !turnstile) return;

		await tick();
		const isDarkMode = document.documentElement.classList.contains('dark');

		widgetId = turnstile.render(containerEl, {
			sitekey: siteKey,
			theme: isDarkMode ? 'dark' : 'light',
			callback: (value: string) => {
				token = value;
			},
			'expired-callback': () => {
				token = '';
			},
			'error-callback': () => {
				token = '';
			}
		});
	};

	export function reset() {
		token = '';
		const turnstile = getTurnstile();
		if (turnstile && widgetId) {
			turnstile.reset(widgetId);
		}
	}

	onMount(async () => {
		await loadTurnstileScript();
		await renderTurnstile();
	});

	onDestroy(() => {
		const turnstile = getTurnstile();
		if (turnstile && widgetId) {
			turnstile.remove(widgetId);
		}
	});
</script>

<div class="flex justify-center">
	<div bind:this={containerEl}></div>
</div>
