<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	import { getMyUsageSummary } from '$lib/apis/credit';

	import ChartBar from '$lib/components/icons/ChartBar.svelte';
	import Dropdown from '$lib/components/common/Dropdown.svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';

	const i18n: Writable<i18nType> = getContext('i18n');

	type UsagePeriodKey = 'day' | 'week' | 'month';

	type UsagePeriod = {
		start_time: number;
		end_time: number;
		input_tokens: number;
		output_tokens: number;
		total_tokens: number;
		conversation_count: number;
		credit_used: number;
	};

	type UsageSummary = {
		credit: number;
		periods: Record<UsagePeriodKey, UsagePeriod>;
	};

	const periodOptions: Array<{ key: UsagePeriodKey; label: string }> = [
		{ key: 'day', label: 'Today' },
		{ key: 'week', label: 'This week' },
		{ key: 'month', label: 'This month' }
	];

	let show = false;
	let loading = false;
	let error = '';
	let summary: UsageSummary | null = null;
	let selectedPeriod: UsagePeriodKey = 'day';

	const numberFormatter = new Intl.NumberFormat(undefined, {
		maximumFractionDigits: 0
	});

	const creditFormatter = new Intl.NumberFormat(undefined, {
		maximumFractionDigits: 6
	});

	const loadUsageSummary = async () => {
		if (!localStorage.token) return;

		loading = true;
		error = '';

		const res = await getMyUsageSummary(localStorage.token).catch((err) => {
			console.error('Failed to load usage summary:', err);
			error = `${err}`;
			return null;
		});

		if (res) {
			summary = res;
		}

		loading = false;
	};

	const formatNumber = (value?: number | null) => numberFormatter.format(value ?? 0);
	const formatCredit = (value?: number | null) => creditFormatter.format(value ?? 0);

	$: currentPeriod = summary?.periods?.[selectedPeriod] ?? null;
	$: isEmpty =
		currentPeriod &&
		currentPeriod.total_tokens === 0 &&
		currentPeriod.conversation_count === 0 &&
		currentPeriod.credit_used === 0;

	onMount(() => {
		if (show) {
			loadUsageSummary();
		}
	});
</script>

<Dropdown
	bind:show
	align="end"
	side="bottom"
	sideOffset={6}
	contentClass="w-[min(360px,calc(100vw-2rem))] rounded-xl border border-gray-100 dark:border-gray-850 bg-white dark:bg-gray-900 shadow-xl p-2"
	onOpenChange={(state) => {
		if (state) {
			loadUsageSummary();
		}
	}}
>
	<Tooltip content={$i18n.t('Usage')}>
		<button
			class="relative flex cursor-pointer items-center gap-1.5 rounded-xl border border-gray-100 bg-white/80 px-2.5 py-2 text-gray-700 shadow-xs transition hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-900/70 dark:text-gray-200 dark:hover:bg-gray-850"
			aria-label={$i18n.t('Usage')}
			type="button"
		>
			<ChartBar className="size-4.5 shrink-0" strokeWidth="1.5" />
			<span class="text-xs font-medium leading-none">{$i18n.t('Usage')}</span>
		</button>
	</Tooltip>

	<div slot="content" class="flex flex-col gap-2">
		<div class="px-2 py-1">
			<div class="flex items-center gap-2 text-xs font-semibold text-gray-900 dark:text-gray-100">
				{$i18n.t('Usage')}
				{#if loading}
					<Spinner className="size-3 text-gray-400" />
				{/if}
			</div>
			<div class="mt-0.5 text-[11px] text-gray-500">
				{$i18n.t('Credit')}: {formatCredit(summary?.credit)}
			</div>
		</div>

		<div class="mx-2 grid grid-cols-3 rounded-lg bg-gray-50 p-1 text-xs dark:bg-gray-850">
			{#each periodOptions as option}
				<button
					type="button"
					class="rounded-md px-2 py-1.5 font-medium transition {selectedPeriod === option.key
						? 'bg-white text-gray-900 shadow-xs dark:bg-gray-800 dark:text-gray-50'
						: 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'}"
					on:click={() => {
						selectedPeriod = option.key;
					}}
				>
					{$i18n.t(option.label)}
				</button>
			{/each}
		</div>

		{#if error}
			<div class="px-2 py-6 text-center text-xs text-red-500">
				{error}
			</div>
		{:else if loading && !summary}
			<div class="px-2 py-6">
				<Spinner className="mx-auto size-5" />
			</div>
		{:else if currentPeriod}
			{#if isEmpty}
				<div class="px-2 pt-1 text-center text-[11px] text-gray-500">
					{$i18n.t('No usage yet')}
				</div>
			{/if}

			<div class="grid grid-cols-2 gap-2 px-2 pb-1 pt-1">
				<div class="rounded-lg border border-gray-100 p-2 dark:border-gray-850">
					<div class="text-[11px] text-gray-500">{$i18n.t('Tokens')}</div>
					<div class="mt-1 text-base font-semibold tabular-nums text-gray-900 dark:text-gray-100">
						{formatNumber(currentPeriod.total_tokens)}
					</div>
				</div>

				<div class="rounded-lg border border-gray-100 p-2 dark:border-gray-850">
					<div class="text-[11px] text-gray-500">{$i18n.t('Conversations')}</div>
					<div class="mt-1 text-base font-semibold tabular-nums text-gray-900 dark:text-gray-100">
						{formatNumber(currentPeriod.conversation_count)}
					</div>
				</div>

				<div class="rounded-lg border border-gray-100 p-2 dark:border-gray-850">
					<div class="text-[11px] text-gray-500">{$i18n.t('Input tokens')}</div>
					<div class="mt-1 text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
						{formatNumber(currentPeriod.input_tokens)}
					</div>
				</div>

				<div class="rounded-lg border border-gray-100 p-2 dark:border-gray-850">
					<div class="text-[11px] text-gray-500">{$i18n.t('Output tokens')}</div>
					<div class="mt-1 text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
						{formatNumber(currentPeriod.output_tokens)}
					</div>
				</div>

				<div class="col-span-2 rounded-lg border border-gray-100 p-2 dark:border-gray-850">
					<div class="text-[11px] text-gray-500">{$i18n.t('Credit used')}</div>
					<div class="mt-1 text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
						{formatCredit(currentPeriod.credit_used)}
					</div>
				</div>
			</div>
		{/if}
	</div>
</Dropdown>
