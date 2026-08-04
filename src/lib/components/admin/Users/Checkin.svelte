<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';
	import { toast } from 'svelte-sonner';

	import Switch from '$lib/components/common/Switch.svelte';
	import Pagination from '$lib/components/common/Pagination.svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';

	import {
		getCheckinAdminConfig,
		setCheckinAdminConfig,
		getCheckinRecords
	} from '$lib/apis/checkin';

	const i18n: Writable<i18nType> = getContext('i18n');

	type RewardTier = {
		amount: number;
		weight: number;
	};

	type CheckinRecord = {
		name?: string;
		email?: string;
		checkin_date?: string;
		reward?: number;
		created_at?: number;
	};

	let loaded = false;
	let saving = false;
	let config = {
		ENABLE_DAILY_CHECKIN: false,
		CHECKIN_TIMEZONE: 'Asia/Shanghai',
		ENABLE_DAILY_CREDIT_RESET: false,
		DAILY_RESET_CREDIT: '3'
	};
	let tiers: RewardTier[] = [{ amount: 3, weight: 45 }];
	let records: CheckinRecord[] = [];
	let total = 0;
	let page = 1;
	let keyword = '';

	$: totalWeight = tiers.reduce((sum, tier) => sum + (Number(tier.weight) || 0), 0);

	const loadConfig = async () => {
		const result = await getCheckinAdminConfig(localStorage.token).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (!result) return;

		config = {
			ENABLE_DAILY_CHECKIN: !!result.ENABLE_DAILY_CHECKIN,
			CHECKIN_TIMEZONE: result.CHECKIN_TIMEZONE || 'Asia/Shanghai',
			ENABLE_DAILY_CREDIT_RESET: !!result.ENABLE_DAILY_CREDIT_RESET,
			DAILY_RESET_CREDIT: `${result.DAILY_RESET_CREDIT ?? '3'}`
		};
		try {
			const parsed = JSON.parse(result.DAILY_CHECKIN_REWARD_CONFIG || '[]');
			if (Array.isArray(parsed) && parsed.length) {
				tiers = parsed.map((tier) => ({
					amount: Number(tier.amount),
					weight: Number(tier.weight)
				}));
			}
		} catch {
			// Keep the default tier when stored configuration is invalid.
		}
	};

	const loadRecords = async () => {
		const result = await getCheckinRecords(localStorage.token, page, keyword).catch(() => null);
		if (result) {
			records = result.items || [];
			total = result.total || 0;
		}
	};

	const addTier = () => {
		tiers = [...tiers, { amount: 1, weight: 1 }];
	};

	const removeTier = (index: number) => {
		tiers = tiers.filter((_, tierIndex) => tierIndex !== index);
	};

	const save = async () => {
		const clean = tiers
			.map((tier) => ({ amount: Number(tier.amount), weight: Number(tier.weight) }))
			.filter((tier) => !isNaN(tier.amount) && !isNaN(tier.weight) && tier.weight >= 0);
		if (!clean.length || clean.reduce((sum, tier) => sum + tier.weight, 0) <= 0) {
			toast.error($i18n.t('Please configure at least one reward tier with weight greater than 0'));
			return;
		}

		saving = true;
		const result = await setCheckinAdminConfig(localStorage.token, {
			ENABLE_DAILY_CHECKIN: config.ENABLE_DAILY_CHECKIN,
			DAILY_CHECKIN_REWARD_CONFIG: JSON.stringify(clean),
			CHECKIN_TIMEZONE: config.CHECKIN_TIMEZONE,
			ENABLE_DAILY_CREDIT_RESET: config.ENABLE_DAILY_CREDIT_RESET,
			DAILY_RESET_CREDIT: `${config.DAILY_RESET_CREDIT}`
		}).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		saving = false;
		if (result) toast.success($i18n.t('Saved'));
	};

	const formatTime = (timestamp?: number) =>
		timestamp ? new Date(timestamp * 1000).toLocaleString() : '';

	$: if (loaded) {
		page;
		loadRecords();
	}

	onMount(async () => {
		await loadConfig();
		loaded = true;
	});
</script>

{#if !loaded}
	<div class="flex h-full items-center justify-center"><Spinner /></div>
{:else}
	<div class="flex flex-col gap-5 pb-8">
		<div>
			<div class="mb-2 text-lg font-medium">{$i18n.t('Daily Check-in')}</div>
			<div class="flex items-center justify-between py-1">
				<div class="text-sm font-medium">{$i18n.t('Enable Daily Check-in')}</div>
				<Switch bind:state={config.ENABLE_DAILY_CHECKIN} />
			</div>
			<div class="mt-3 text-sm font-medium">{$i18n.t('Reward Tiers & Weights')}</div>
			<div class="mt-1 text-xs text-gray-400">
				{$i18n.t(
					'Each check-in awards one tier by weighted random. Probability = weight / total weight.'
				)}
			</div>
			<div class="mt-3 flex px-1 text-xs text-gray-400">
				<div class="w-1/3">{$i18n.t('Credit Amount')}</div>
				<div class="w-1/3">{$i18n.t('Weight')}</div>
				<div class="w-1/4">{$i18n.t('Probability')}</div>
				<div class="w-12"></div>
			</div>
			{#each tiers as tier, index}
				<div class="mb-1.5 flex items-center gap-2">
					<input
						class="w-1/3 rounded-lg bg-gray-50 px-3 py-1.5 text-sm outline-hidden dark:bg-gray-850"
						type="number"
						step="0.0001"
						min="0"
						bind:value={tier.amount}
					/>
					<input
						class="w-1/3 rounded-lg bg-gray-50 px-3 py-1.5 text-sm outline-hidden dark:bg-gray-850"
						type="number"
						step="0.1"
						min="0"
						bind:value={tier.weight}
					/>
					<div class="w-1/4 text-sm text-gray-500 dark:text-gray-400">
						{totalWeight > 0 ? ((Number(tier.weight) / totalWeight) * 100).toFixed(1) : '0.0'}%
					</div>
					<button
						class="w-12 text-xs text-red-500 hover:text-red-600"
						type="button"
						on:click={() => removeTier(index)}
						disabled={tiers.length <= 1}
					>
						{$i18n.t('Delete')}
					</button>
				</div>
			{/each}
			<button
				class="mt-1 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-gray-100"
				type="button"
				on:click={addTier}
			>
				+ {$i18n.t('Add Tier')}
			</button>
		</div>

		<hr class="border-gray-100 dark:border-gray-850" />

		<div>
			<div class="mb-2 text-lg font-medium">{$i18n.t('Daily Credit Reset')}</div>
			<div class="flex items-center justify-between py-1">
				<div class="text-sm font-medium">{$i18n.t('Enable Daily Credit Reset')}</div>
				<Switch bind:state={config.ENABLE_DAILY_CREDIT_RESET} />
			</div>
			<div class="mb-2 text-xs text-gray-400">
				{$i18n.t(
					'At 00:00 of the configured timezone, every user credit is reset to the value below.'
				)}
			</div>
			<div class="flex gap-3">
				<div class="w-1/2">
					<div class="mb-1 text-xs font-medium">{$i18n.t('Daily Reset Credit')}</div>
					<input
						class="w-full rounded-lg bg-gray-50 px-3 py-2 text-sm outline-hidden dark:bg-gray-850"
						type="number"
						step="0.0001"
						min="0"
						bind:value={config.DAILY_RESET_CREDIT}
					/>
				</div>
				<div class="w-1/2">
					<div class="mb-1 text-xs font-medium">{$i18n.t('Reset Timezone')}</div>
					<input
						class="w-full rounded-lg bg-gray-50 px-3 py-2 text-sm outline-hidden dark:bg-gray-850"
						type="text"
						placeholder="Asia/Shanghai"
						bind:value={config.CHECKIN_TIMEZONE}
					/>
				</div>
			</div>
		</div>

		<div class="flex justify-end">
			<button
				class="flex items-center gap-2 rounded-full bg-black px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-900 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-gray-100"
				type="button"
				on:click={save}
				disabled={saving}
			>
				{#if saving}<Spinner className="size-4" />{/if}
				{$i18n.t('Save')}
			</button>
		</div>

		<hr class="border-gray-100 dark:border-gray-850" />

		<div>
			<div class="mb-2 flex items-center justify-between">
				<div class="text-lg font-medium">{$i18n.t('Daily Check-in')}</div>
				<input
					class="w-56 rounded-lg bg-gray-50 px-3 py-1.5 text-sm outline-hidden dark:bg-gray-850"
					placeholder={$i18n.t('Search by user id')}
					bind:value={keyword}
					on:keydown={(event) => {
						if (event.key === 'Enter') {
							page = 1;
							loadRecords();
						}
					}}
				/>
			</div>
			<div class="overflow-x-auto">
				<table class="w-full text-left text-sm">
					<thead
						class="border-b border-gray-100 text-xs text-gray-500 dark:border-gray-850 dark:text-gray-400"
					>
						<tr>
							<th class="py-2 pr-3">{$i18n.t('User')}</th>
							<th class="py-2 pr-3">{$i18n.t('Date')}</th>
							<th class="py-2 pr-3">{$i18n.t('Reward')}</th>
							<th class="py-2 pr-3">{$i18n.t('Time')}</th>
						</tr>
					</thead>
					<tbody>
						{#each records as record}
							<tr class="border-b border-gray-50 dark:border-gray-850/50">
								<td class="py-2 pr-3">
									<div>{record.name}</div>
									{#if record.email}<div class="text-xs text-gray-400">{record.email}</div>{/if}
								</td>
								<td class="whitespace-nowrap py-2 pr-3">{record.checkin_date}</td>
								<td class="py-2 pr-3 font-medium text-amber-600 dark:text-amber-400"
									>+{record.reward}</td
								>
								<td class="whitespace-nowrap py-2 pr-3 text-xs text-gray-400"
									>{formatTime(record.created_at)}</td
								>
							</tr>
						{/each}
						{#if records.length === 0}
							<tr
								><td colspan="4" class="py-6 text-center text-gray-400">{$i18n.t('No records')}</td
								></tr
							>
						{/if}
					</tbody>
				</table>
			</div>
			{#if total > 30}
				<div class="mt-3"><Pagination bind:page count={total} perPage={30} /></div>
			{/if}
		</div>
	</div>
{/if}
