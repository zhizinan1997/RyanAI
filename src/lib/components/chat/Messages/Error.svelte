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

<div class="flex my-2 gap-2.5 border px-4 py-3 border-red-600/10 bg-red-600/10 rounded-lg">
	<div class=" self-start mt-0.5">
		<Info className="size-5 text-red-700 dark:text-red-400" />
	</div>

	<div class="self-center text-sm min-w-0 space-y-2">
		<div class="font-semibold">{$i18n.t('AI response failed')}</div>
		<div>{description}</div>

		{#if error.content}
			<div class="text-xs opacity-80 break-words">
				<span class="font-medium">{$i18n.t('Error details')}:</span>
				{error.content}
			</div>
		{/if}

		{#if error.admin_notification === 'submitted'}
			<div class="text-xs opacity-80">
				{$i18n.t(
					'Your prompt content was not sent to the administrator. Only redacted system error information was submitted.'
				)}
			</div>
		{:else if error.admin_notification === 'disabled'}
			<div class="text-xs opacity-80">
				{$i18n.t(
					'Your prompt content was not sent to the administrator. Error notifications are currently disabled.'
				)}
			</div>
		{:else if error.admin_notification === 'failed'}
			<div class="text-xs opacity-80">
				{$i18n.t(
					'Your prompt content was not sent to the administrator, and the error notification could not be submitted.'
				)}
			</div>
		{/if}

		{#if error.incident_id}
			<div class="text-xs opacity-80">
				<span class="font-medium">{$i18n.t('Incident ID')}:</span>
				{error.incident_id}
			</div>
		{/if}
	</div>
</div>
