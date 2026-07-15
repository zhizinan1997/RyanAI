<script lang="ts">
	import { getContext } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';
	import Info from '$lib/components/icons/Info.svelte';
	import { getAIErrorDescription, normalizeAIError } from '$lib/utils/chatError';

	const i18n: Writable<i18nType> = getContext('i18n');
	export let content: unknown = '';

	$: error = normalizeAIError(content);
	$: description = $i18n.t(getAIErrorDescription(error.category));
</script>

<div
	role="alert"
	class="my-2 max-w-2xl rounded-xl border border-gray-200/80 bg-gray-50/80 px-3.5 py-3 dark:border-gray-800 dark:bg-gray-900/50"
>
	<div class="flex min-w-0 gap-2.5">
		<div
			class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-600 dark:bg-red-400/10 dark:text-red-400"
		>
			<Info className="size-3.5" strokeWidth="2" />
		</div>

		<div class="min-w-0 flex-1">
			<div class="text-sm font-medium text-gray-900 dark:text-gray-100">
				{$i18n.t('AI response failed')}
			</div>
			<div class="mt-0.5 text-sm leading-5 text-gray-600 dark:text-gray-300">{description}</div>

			{#if error.incident_id || error.admin_notification === 'submitted' || error.admin_notification === 'failed'}
				<div
					class="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-gray-400 dark:text-gray-500"
				>
					{#if error.incident_id}
						<span class="font-mono">{$i18n.t('Incident ID')} {error.incident_id}</span>
					{/if}

					{#if error.admin_notification === 'submitted'}
						<span>
							{$i18n.t(
								error.notification_suppressed
									? 'A similar error has already been reported to the administrator.'
									: 'The administrator has been notified.'
							)}
						</span>
					{:else if error.admin_notification === 'failed'}
						<span class="text-red-500 dark:text-red-400">
							{$i18n.t('Failed to notify the administrator.')}
						</span>
					{/if}
				</div>
			{/if}

			{#if error.content}
				<details class="group mt-2 text-xs text-gray-400 dark:text-gray-500">
					<summary
						class="w-fit cursor-pointer select-none rounded outline-none transition-colors hover:text-gray-600 focus-visible:ring-2 focus-visible:ring-gray-400/40 dark:hover:text-gray-300"
					>
						{$i18n.t('Error details')}
					</summary>
					<div
						class="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/[0.035] px-2.5 py-2 font-mono text-[11px] leading-4 text-gray-500 dark:bg-white/[0.04] dark:text-gray-400"
					>
						{error.content}
					</div>
				</details>
			{/if}
		</div>
	</div>
</div>
