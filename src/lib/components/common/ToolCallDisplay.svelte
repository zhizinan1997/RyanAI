<script lang="ts">
	import { decode } from 'html-entities';
	import { v4 as uuidv4 } from 'uuid';

	import { getContext } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as I18nType } from 'i18next';
	const i18n = getContext<Writable<I18nType>>('i18n');

	import { slide } from 'svelte/transition';
	import { quintOut } from 'svelte/easing';

	import ChevronUp from '../icons/ChevronUp.svelte';
	import ChevronDown from '../icons/ChevronDown.svelte';
	import Spinner from './Spinner.svelte';
	import Markdown from '../chat/Messages/Markdown.svelte';
	import WrenchSolid from '../icons/WrenchSolid.svelte';
	import CheckCircle from '../icons/CheckCircle.svelte';
	import Image from './Image.svelte';
	import FullHeightIframe from './FullHeightIframe.svelte';
	import { settings } from '$lib/stores';

	export let id: string = '';
	export let attributes: {
		type?: string;
		id?: string;
		name?: string;
		arguments?: string;
		result?: string;
		files?: string;
		embeds?: string;
		done?: string;
	} = {};

	export let open = false;
	export let grouped = false;
	export let className = '';

	const RESULT_PREVIEW_LIMIT = 10000;
	const TOOL_NAME_LABELS: Record<string, string> = {
		add_memory: 'Add Memory',
		update_memory: 'Update Memory',
		replace_memory_content: 'Replace Memory Content',
		delete_memory: 'Delete Memory',
		list_memories: 'List Memories',
		search_memories: 'Search Memories',
		list_memory_paths: 'List Memory Paths',
		read_memory_path: 'Read Memory Path'
	};
	const TOOL_FIELD_LABELS: Record<string, string> = {
		action: 'Action',
		content: 'Content',
		count: 'Count',
		created_at: 'Created At',
		error: 'Error',
		id: 'ID',
		include_children: 'Include Children',
		memory_id: 'Memory ID',
		message: 'Message',
		operations: 'Operations',
		path: 'Path',
		query: 'Query',
		status: 'Status',
		type: 'Type',
		updated_at: 'Updated At'
	};
	const TOOL_VALUE_LABELS: Record<string, string> = {
		add: 'Add',
		all: 'All',
		context: 'Context',
		move: 'Move',
		remove: 'Remove',
		replace: 'Replace',
		success: 'Success',
		user: 'User'
	};
	let expandedResult = false;

	$: if (!open) expandedResult = false;
	export let buttonClassName =
		'w-fit text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition';

	const componentId = id || uuidv4();

	function parseJSONString(str: string) {
		// Iteratively unwrap nested JSON-encoded strings. Same result as the previous
		// recursive form, but without the stack-overflow-and-recover path it hit on
		// scalar values (e.g. JSON.parse('5') -> 5 -> infinite self-recursion).
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let value: any = str;
		while (typeof value === 'string') {
			try {
				value = JSON.parse(value);
			} catch {
				break;
			}
		}
		return value;
	}

	function formatJSONString(str: string) {
		try {
			const parsed = parseJSONString(str);
			if (typeof parsed === 'object') {
				return JSON.stringify(parsed, null, 2);
			} else {
				return String(parsed);
			}
		} catch (e) {
			return str;
		}
	}

	function parseArguments(str: string): Record<string, unknown> | null {
		try {
			const parsed = parseJSONString(str);
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
			return null;
		} catch {
			return null;
		}
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	function getToolFieldLabel(key: string) {
		return $i18n.t(TOOL_FIELD_LABELS[key] ?? key);
	}

	function localizeToolValue(value: unknown): unknown {
		if (Array.isArray(value)) {
			return value.map((item) => localizeToolValue(item));
		}

		if (isRecord(value)) {
			return Object.fromEntries(
				Object.entries(value).map(([key, nestedValue]) => [
					getToolFieldLabel(key),
					localizeToolValue(nestedValue)
				])
			);
		}

		if (typeof value === 'string') {
			const valueLabel = TOOL_VALUE_LABELS[value];
			return valueLabel ? $i18n.t(valueLabel) : value;
		}

		if (typeof value === 'boolean') {
			return $i18n.t(value ? 'Yes' : 'No');
		}

		return value;
	}

	function formatToolValue(value: unknown) {
		const localizedValue = localizeToolValue(value);

		if (isRecord(localizedValue) || Array.isArray(localizedValue)) {
			return JSON.stringify(localizedValue);
		}

		if (localizedValue === null || localizedValue === undefined) {
			return '';
		}

		return String(localizedValue);
	}

	export let resultContent: string = '';

	$: result = resultContent || decode(attributes?.result ?? '');
	$: files = parseJSONString(decode(attributes?.files ?? ''));
	$: embeds = parseJSONString(decode(attributes?.embeds ?? ''));
	$: args =
		open || (Array.isArray(embeds) && embeds.length > 0) ? decode(attributes?.arguments ?? '') : '';
	$: isDone = attributes?.done === 'true';
	$: isExecuting = attributes?.done && attributes?.done !== 'true';

	$: parsedArgs = parseArguments(args);
	$: parsedResult = parseJSONString(result);
	$: toolDisplayName = $i18n.t(TOOL_NAME_LABELS[attributes?.name ?? ''] ?? attributes?.name ?? '');
</script>

<div {id} class={className}>
	{#if !grouped && embeds && Array.isArray(embeds) && embeds.length > 0}
		<!-- Embed Mode: Show iframes without collapsible behavior -->
		<div class="py-1 w-full cursor-pointer">
			<div class="w-full text-xs text-gray-500">
				{toolDisplayName}
			</div>
			{#each embeds as embed, idx}
				<div class="my-2" id={`${componentId}-tool-call-embed-${idx}`}>
					<FullHeightIframe
						src={embed}
						{args}
						allowScripts={true}
						allowForms={$settings?.iframeSandboxAllowForms ?? false}
						allowSameOrigin={$settings?.iframeSandboxAllowSameOrigin ?? false}
						allowPopups={true}
					/>
				</div>
			{/each}
		</div>
	{:else}
		<!-- Tool call display -->
		<!-- svelte-ignore a11y-no-static-element-interactions -->
		<div
			class="{buttonClassName} cursor-pointer"
			on:pointerup={() => {
				open = !open;
			}}
		>
			<div
				class="w-full max-w-full font-medium flex items-center gap-1.5 {isExecuting
					? 'shimmer'
					: ''}"
			>
				<!-- Status icon -->
				{#if isExecuting}
					<div>
						<Spinner className="size-4" />
					</div>
				{:else if isDone}
					<div class="text-emerald-500 dark:text-emerald-400">
						<CheckCircle className="size-4" strokeWidth="2" />
					</div>
				{:else}
					<div class="text-gray-400 dark:text-gray-500">
						<WrenchSolid className="size-3.5" />
					</div>
				{/if}

				<!-- Label -->
				<div class="flex-1 line-clamp-1">
					<!-- Short label (below md) -->
					<span class="@md:hidden text-black dark:text-white">{toolDisplayName}</span>
					<!-- Full label (md and above) -->
					<span class="hidden @md:inline font-normal">
						{#if isDone}
							<Markdown
								id={`${componentId}-tool-call-title`}
								content={$i18n.t('View Result from **{{NAME}}**', {
									NAME: toolDisplayName
								})}
							/>
						{:else}
							<Markdown
								id={`${componentId}-tool-call-executing`}
								content={$i18n.t('Executing **{{NAME}}**...', {
									NAME: toolDisplayName
								})}
							/>
						{/if}
					</span>
				</div>

				<!-- Chevron -->
				<div class="flex shrink-0 self-center translate-y-[1px]">
					{#if open}
						<ChevronUp strokeWidth="3.5" className="size-3.5" />
					{:else}
						<ChevronDown strokeWidth="3.5" className="size-3.5" />
					{/if}
				</div>
			</div>
		</div>

		{#if open}
			<div transition:slide={{ duration: 300, easing: quintOut, axis: 'y' }}>
				<div class="border border-gray-50 dark:border-gray-850/30 rounded-2xl my-1.5 p-3 space-y-3">
					<!-- Input -->
					{#if args}
						<div>
							<div
								class="text-[10px] uppercase tracking-wider font-medium text-gray-400 dark:text-gray-500 mb-1.5 px-1"
							>
								{$i18n.t('Input')}
							</div>

							{#if parsedArgs}
								<div class="px-1 space-y-0.5">
									{#each Object.entries(parsedArgs) as [key, value]}
										<div class="flex gap-2 text-xs py-0.5">
											<span class="font-medium text-gray-600 dark:text-gray-400 shrink-0"
												>{getToolFieldLabel(key)}</span
											>
											<span class="text-gray-800 dark:text-gray-200 break-all"
												>{formatToolValue(value)}</span
											>
										</div>
									{/each}
								</div>
							{:else}
								<div class="tool-call-body w-full max-w-none!">
									<pre
										class="text-xs text-gray-600 dark:text-gray-300 whitespace-pre font-mono bg-gray-50 dark:bg-gray-900 rounded-lg p-2.5 overflow-x-auto">{formatJSONString(
											args
										)}</pre>
								</div>
							{/if}
						</div>
					{/if}

					<!-- Output -->
					{#if isDone && result}
						<div>
							<div
								class="text-[10px] uppercase tracking-wider font-medium text-gray-400 dark:text-gray-500 mb-1.5 px-1"
							>
								{$i18n.t('Output')}
							</div>
							<div class="w-full max-w-none!">
								{#if typeof parsedResult === 'object' && parsedResult !== null}
									<pre
										class="text-xs text-gray-600 dark:text-gray-300 whitespace-pre font-mono bg-gray-50 dark:bg-gray-900 rounded-lg p-2.5 overflow-x-auto">{JSON.stringify(
											localizeToolValue(parsedResult),
											null,
											2
										)}</pre>
								{:else}
									{@const resultStr = String(parsedResult)}
									{@const isTruncated = resultStr.length > RESULT_PREVIEW_LIMIT && !expandedResult}
									<pre
										class="text-xs text-gray-600 dark:text-gray-300 whitespace-pre-wrap break-words font-mono">{isTruncated
											? resultStr.slice(0, RESULT_PREVIEW_LIMIT)
											: resultStr}</pre>
									{#if isTruncated}
										<button
											class="mt-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition"
											on:click|stopPropagation={() => {
												expandedResult = true;
											}}
										>
											{$i18n.t('Show all ({{COUNT}} characters)', {
												COUNT: resultStr.length.toLocaleString()
											})}
										</button>
									{/if}
								{/if}
							</div>
						</div>
					{/if}
				</div>
			</div>
		{/if}
	{/if}

	<!-- Files display (images etc.) when done -->
	{#if isDone}
		{#if typeof files === 'object'}
			{#each files ?? [] as file, idx}
				{#if typeof file === 'string'}
					{#if file.startsWith('data:image/')}
						<Image id={`${componentId}-tool-call-result-${idx}`} src={file} alt="Image" />
					{/if}
				{:else if typeof file === 'object'}
					{#if (file.type === 'image' || (file?.content_type ?? '').startsWith('image/')) && file.url}
						<Image id={`${componentId}-tool-call-result-${idx}`} src={file.url} alt="Image" />
					{/if}
				{/if}
			{/each}
		{/if}
	{/if}
</div>
