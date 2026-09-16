<script lang="ts">
	import Info from '$lib/components/icons/Info.svelte';
	import { normalizeAIError } from '$lib/utils/chatError';

	export let content: unknown = '';

	$: payload = normalizeAIError(content);
	$: message = payload.content || 'Error submitting message';
	$: hasTechnicalDetail =
		typeof payload.technical_detail === 'string' &&
		payload.technical_detail.trim() !== '' &&
		payload.technical_detail.trim() !== message.trim();
</script>

<div
	class="my-1.5 flex w-full items-start gap-2 rounded-2xl bg-black/[0.03] px-3 py-2 text-gray-500 dark:bg-white/[0.04] dark:text-gray-400"
>
	<Info className="mt-0.5 size-4 shrink-0 text-gray-400 dark:text-gray-500" strokeWidth="1.8" />

	<div class="min-w-0 flex-1 break-words text-[0.8125rem] leading-5">
		<div>{message}</div>

		{#if hasTechnicalDetail}
			<details class="mt-1">
				<summary class="cursor-pointer select-none text-[0.75rem] text-gray-400 dark:text-gray-500">
					技术详情
				</summary>
				<pre
					class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/[0.03] px-2 py-1.5 font-mono text-[0.6875rem] leading-4 text-gray-400 dark:bg-white/[0.03] dark:text-gray-500"
					>{payload.technical_detail}</pre>
			</details>
		{/if}

		{#if payload.incident_id}
			<div class="mt-1 text-[0.6875rem] text-gray-400 dark:text-gray-500">
				异常编号：{payload.incident_id}
			</div>
		{/if}
	</div>
</div>
