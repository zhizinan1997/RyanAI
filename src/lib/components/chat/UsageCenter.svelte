<script lang="ts">
	import { getContext, onDestroy, onMount } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';
	import { toast } from 'svelte-sonner';

	import { user } from '$lib/stores';
	import { getSessionUser } from '$lib/apis/auths';
	import { getMyUsageSummary } from '$lib/apis/credit';
	import { checkinLottery, getLotteryConfig } from '$lib/apis/lottery';

	import Calendar from '$lib/components/icons/Calendar.svelte';
	import ChartBar from '$lib/components/icons/ChartBar.svelte';
	import CheckCircle from '$lib/components/icons/CheckCircle.svelte';
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
	let checkinEnabled = false;
	let checkedInToday = true;
	let checkinLoading = false;

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

	const loadCheckinConfig = async () => {
		if (!localStorage.token) {
			checkinEnabled = false;
			checkedInToday = true;
			return;
		}

		const cfg = await getLotteryConfig(localStorage.token).catch(() => null);
		if (cfg) {
			checkinEnabled = !!cfg.checkin_enabled;
			checkedInToday = !!cfg.checked_in_today;
		} else {
			checkinEnabled = false;
			checkedInToday = true;
		}
	};

	const checkin = async () => {
		if (checkinLoading || checkedInToday) return;

		checkinLoading = true;
		const res = await checkinLottery(localStorage.token).catch((err) => {
			toast.error(`${err}`);
			return null;
		});
		checkinLoading = false;

		if (!res) {
			await loadCheckinConfig();
			return;
		}

		checkedInToday = true;
		toast.success($i18n.t('Check-in successful, +{{reward}} credit', { reward: res.reward ?? 0 }));
		await loadUsageSummary();

		const sessionUser = await getSessionUser(localStorage.token).catch(() => null);
		if (sessionUser) {
			await user.set(sessionUser);
		}
	};

	const onVisibilityChange = () => {
		if (document.visibilityState === 'visible') {
			loadCheckinConfig();
		}
	};

	const formatNumber = (value?: number | null) => numberFormatter.format(value ?? 0);
	const formatCredit = (value?: number | null) => creditFormatter.format(value ?? 0);

	$: currentPeriod = summary?.periods?.[selectedPeriod] ?? null;
	$: isEmpty =
		currentPeriod &&
		currentPeriod.total_tokens === 0 &&
		currentPeriod.conversation_count === 0 &&
		currentPeriod.credit_used === 0;
	$: showCheckinBadge = checkinEnabled && !checkedInToday;

	onMount(() => {
		loadCheckinConfig();
		document.addEventListener('visibilitychange', onVisibilityChange);
	});

	onDestroy(() => {
		document.removeEventListener('visibilitychange', onVisibilityChange);
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
			loadCheckinConfig();
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
			{#if showCheckinBadge}
				<div
					class="absolute right-1 top-1 min-w-4 h-4 px-1 rounded-full bg-red-500 text-white text-[10px] leading-4 text-center font-medium"
				>
					1
				</div>
			{/if}
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

		{#if checkinEnabled}
			<div class="mx-2 rounded-lg border border-gray-100 p-2 dark:border-gray-850">
				<div class="flex items-center justify-between gap-2">
					<div class="min-w-0">
						<div class="text-xs font-medium text-gray-900 dark:text-gray-100">
							{$i18n.t('Daily Check-in')}
						</div>
						<div class="mt-0.5 text-[11px] text-gray-500">
							{checkedInToday
								? $i18n.t('Checked in today')
								: $i18n.t('Get a weighted random credit reward')}
						</div>
					</div>
					<button
						type="button"
						class="shrink-0 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition {checkedInToday
							? 'bg-gray-100 text-gray-500 dark:bg-gray-850 dark:text-gray-400'
							: 'bg-black text-white hover:bg-gray-900 dark:bg-white dark:text-black dark:hover:bg-gray-100'} disabled:opacity-60"
						disabled={checkinLoading || checkedInToday}
						on:click={checkin}
					>
						{#if checkinLoading}
							<Spinner className="size-3" />
						{:else if checkedInToday}
							<CheckCircle className="size-3.5" strokeWidth="1.8" />
						{:else}
							<Calendar className="size-3.5" strokeWidth="1.8" />
						{/if}
						{checkedInToday ? $i18n.t('Checked in today') : $i18n.t('Check in')}
					</button>
				</div>
			</div>
		{/if}

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
