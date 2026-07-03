<script lang="ts">
	import { config, user, models as _models, temporaryChatEnabled } from '$lib/stores';
	import { onMount, getContext } from 'svelte';
	import { getGreetingLine } from '$lib/utils/greeting';

	import { fade } from 'svelte/transition';

	import Suggestions from './Suggestions.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import EyeSlash from '$lib/components/icons/EyeSlash.svelte';

	const i18n = getContext('i18n');

	export let modelIds = [];
	export let models = [];
	export let atSelectedModel;

	export let onSelect = (e) => {};

	let mounted = false;
	let selectedModelIdx = 0;
	let greetingNow = new Date();
	$: greetingName = $user?.name || 'Ryan';
	$: greetingLine = getGreetingLine(greetingName, greetingNow);

	$: if (modelIds.length > 0) {
		selectedModelIdx = models.length - 1;
	}

	$: models = modelIds.map((id) => $_models.find((m) => m.id === id));

	onMount(() => {
		mounted = true;

		const greetingTimer = window.setInterval(() => {
			greetingNow = new Date();
		}, 60 * 1000);

		return () => {
			window.clearInterval(greetingTimer);
		};
	});
</script>

{#key mounted}
	<div class="m-auto w-full max-w-6xl px-8 lg:px-20">
		{#if $temporaryChatEnabled}
			<Tooltip
				content={$i18n.t("This chat won't appear in history and your messages will not be saved.")}
				className="w-full flex justify-start mb-0.5"
				placement="top"
			>
				<div class="flex items-center gap-2 text-gray-500 text-lg mt-2 w-fit">
					<EyeSlash strokeWidth="2.5" className="size-5" />{$i18n.t('Temporary Chat')}
				</div>
			</Tooltip>
		{/if}

		<div
			class=" mt-2 mb-4 text-3xl text-gray-800 dark:text-gray-100 text-left flex items-center gap-4 font-primary"
		>
			<div>
				<div class="line-clamp-2 leading-snug" in:fade={{ duration: 200 }}>
					{greetingLine}
				</div>
			</div>
		</div>

		<div class=" w-full font-primary" in:fade={{ duration: 200, delay: 300 }}>
			<Suggestions
				className="grid grid-cols-2"
				suggestionPrompts={atSelectedModel?.info?.meta?.suggestion_prompts ??
					models[selectedModelIdx]?.info?.meta?.suggestion_prompts ??
					$config?.default_prompt_suggestions ??
					[]}
				{onSelect}
			/>
		</div>
	</div>
{/key}
