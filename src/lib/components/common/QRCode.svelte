<script lang="ts">
	import { onDestroy, onMount } from 'svelte';

	type QRCodeInstance = { clear?: () => void };
	type QRCodeConstructor = new (
		element: HTMLElement,
		options: { text: string; width: number; height: number; correctLevel?: number }
	) => QRCodeInstance;
	type BrowserWindow = Window & { QRCode?: QRCodeConstructor };

	export let value: string | null | undefined = null;
	export let alt = 'QR code';
	export let size = 224;

	let container: HTMLDivElement;
	let mounted = false;
	let generatedValue = '';
	let qrInstance: QRCodeInstance | null = null;
	let renderedImageSource = '';

	const isSvg = (input: string) => input.trimStart().startsWith('<svg');
	const isBase64Image = (input: string) =>
		input.length > 64 && /^[A-Za-z0-9+/]+={0,2}$/.test(input);
	const isImageUrl = (input: string) =>
		/^(?:data:image\/|blob:)/i.test(input) ||
		/^https?:\/\/[^\s]+\.(?:png|jpe?g|gif|webp|svg)(?:[?#].*)?$/i.test(input) ||
		isBase64Image(input);
	const directImageSource = (input: string | null | undefined) => {
		if (!input) return '';
		if (isSvg(input)) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(input)}`;
		if (isBase64Image(input)) return `data:image/png;base64,${input}`;
		return isImageUrl(input) ? input : '';
	};
	const imageSource = (input: string) => {
		return directImageSource(input);
	};

	const clearGeneratedCode = () => {
		qrInstance?.clear?.();
		qrInstance = null;
		generatedValue = '';
		if (container) container.replaceChildren();
	};

	const renderGeneratedCode = () => {
		if (!container || !value || directImageSource(value)) {
			clearGeneratedCode();
			return;
		}
		if (generatedValue === value) return;

		clearGeneratedCode();
		const Constructor = (window as BrowserWindow).QRCode;
		if (!Constructor) return;
		try {
			qrInstance = new Constructor(container, {
				text: value,
				width: size,
				height: size,
				correctLevel: 2
			});
			generatedValue = value;
		} catch {
			clearGeneratedCode();
		}
	};

	$: if (mounted) renderGeneratedCode();
	$: renderedImageSource = directImageSource(value);

	onMount(() => {
		mounted = true;
		renderGeneratedCode();
	});

	onDestroy(clearGeneratedCode);
</script>

{#if renderedImageSource}
	<img
		class="size-full object-contain"
		src={imageSource(value ?? '')}
		{alt}
	/>
{:else}
	<div bind:this={container} class="size-full" role="img" aria-label={alt}></div>
{/if}
