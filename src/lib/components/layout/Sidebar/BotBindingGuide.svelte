<script lang="ts">
	import { getContext, onMount, tick } from 'svelte';

	import { showSettings, mobile, showSidebar } from '$lib/stores';

	import XMarkIcon from './icons/XMark.svelte';

	const i18n = getContext('i18n');

	const dismissedKey = 'ryanai.bot-binding-guide.dismissed.v1';

	let show = false;

	// Moves the node to <body>. The sidebar is `inert` + `pointer-events-none` while collapsed (and it has
	// transforms), so a popup rendered inside it can neither be clicked nor stay fixed to the viewport.
	const portal = (node: HTMLElement) => {
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			}
		};
	};

	const dismiss = () => {
		show = false;
		try {
			localStorage.setItem(dismissedKey, '1');
		} catch (e) {}
	};

	const openSettings = async () => {
		dismiss();
		await showSettings.set('bot_bindings');
		if ($mobile) {
			await tick();
			showSidebar.set(false);
		}
	};

	onMount(() => {
		let dismissed = false;
		try {
			dismissed = !!localStorage.getItem(dismissedKey);
		} catch (e) {}
		if (!dismissed) {
			const timer = window.setTimeout(() => (show = true), 900);
			return () => window.clearTimeout(timer);
		}
	});
</script>

{#if show}
	<div
		use:portal
		class="fixed bottom-16 left-3 z-[9999] mb-2 w-[min(20rem,calc(100vw-1.5rem))] rounded-xl border border-blue-100 bg-white p-4 text-left shadow-2xl dark:border-blue-900/50 dark:bg-gray-900 sm:left-4"
		role="dialog"
		aria-label={$i18n.t('Connect Ryan AI to WeChat and QQ')}
	>
		<button
			class="absolute right-2 top-2 flex size-6 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/10 dark:hover:text-gray-200"
			type="button"
			aria-label={$i18n.t('Close')}
			on:click={dismiss}
		>
			<XMarkIcon className="size-3.5" />
		</button>
		<div class="pr-5 text-sm font-medium text-gray-900 dark:text-white">{$i18n.t('Chat with Ryan AI on WeChat and QQ')}</div>
		<p class="mt-2 text-xs leading-5 text-gray-500 dark:text-gray-400">{$i18n.t('Bind a WeChat or QQ bot in Settings to chat with Ryan AI from your messaging apps.')}</p>
		<button
			type="button"
			class="mt-3 w-full rounded-lg bg-gray-900 px-3 py-2 text-xs font-medium text-white transition hover:bg-black dark:bg-white dark:text-black dark:hover:bg-gray-100"
			on:click={openSettings}
		>
			{$i18n.t('Go to WeChat / QQ binding')}
		</button>
	</div>
{/if}
