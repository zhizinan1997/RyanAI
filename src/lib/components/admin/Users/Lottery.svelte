<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';
	import { toast } from 'svelte-sonner';

	import Switch from '$lib/components/common/Switch.svelte';
	import Pagination from '$lib/components/common/Pagination.svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';

	import {
		getLotteryAdminConfig,
		setLotteryAdminConfig,
		getLotteryDraws
	} from '$lib/apis/lottery';
	import { TAROT_BY_CODE } from '$lib/components/lottery/tarotCards';

	const i18n: Writable<i18nType> = getContext('i18n');

	type RewardTier = {
		amount: number;
		weight: number;
	};

	type LotteryDraw = {
		name?: string;
		email?: string;
		draw_date?: string;
		reward?: number;
		created_at?: number;
		type?: 'tarot' | 'checkin';
		cards?: Array<{ code: string; reversed?: boolean }>;
	};

	let loaded = false;
	let saving = false;

	let config = {
		ENABLE_TAROT_LOTTERY: false,
		ENABLE_DAILY_CHECKIN: false,
		LOTTERY_TIMEZONE: 'Asia/Shanghai',
		ENABLE_DAILY_CREDIT_RESET: false,
		DAILY_RESET_CREDIT: '3'
	};
	let tiers: RewardTier[] = [{ amount: 3, weight: 45 }];

	// 历史
	let draws: LotteryDraw[] = [];
	let total = 0;
	let page = 1;
	let keyword = '';

	$: totalWeight = tiers.reduce((s, t) => s + (Number(t.weight) || 0), 0);

	const loadConfig = async () => {
		const c = await getLotteryAdminConfig(localStorage.token).catch((e) => {
			toast.error(`${e}`);
			return null;
		});
		if (c) {
			config = {
				ENABLE_TAROT_LOTTERY: !!c.ENABLE_TAROT_LOTTERY,
				ENABLE_DAILY_CHECKIN: !!c.ENABLE_DAILY_CHECKIN,
				LOTTERY_TIMEZONE: c.LOTTERY_TIMEZONE || 'Asia/Shanghai',
				ENABLE_DAILY_CREDIT_RESET: !!c.ENABLE_DAILY_CREDIT_RESET,
				DAILY_RESET_CREDIT: `${c.DAILY_RESET_CREDIT ?? '3'}`
			};
			try {
				const arr = JSON.parse(c.TAROT_REWARD_CONFIG || '[]');
				if (Array.isArray(arr) && arr.length) {
					tiers = arr.map((x) => ({ amount: Number(x.amount), weight: Number(x.weight) }));
				}
			} catch (e) {
				// keep default tiers
			}
		}
	};

	const loadDraws = async () => {
		const res = await getLotteryDraws(localStorage.token, page, keyword).catch(() => null);
		if (res) {
			draws = res.items || [];
			total = res.total || 0;
		}
	};

	const addTier = () => {
		tiers = [...tiers, { amount: 1, weight: 1 }];
	};
	const removeTier = (i: number) => {
		tiers = tiers.filter((_, idx) => idx !== i);
	};

	const save = async () => {
		const clean = tiers
			.map((t) => ({ amount: Number(t.amount), weight: Number(t.weight) }))
			.filter((t) => !isNaN(t.amount) && !isNaN(t.weight) && t.weight >= 0);
		if (!clean.length || clean.reduce((s, t) => s + t.weight, 0) <= 0) {
			toast.error($i18n.t('Please configure at least one reward tier with weight greater than 0'));
			return;
		}
		saving = true;
		const res = await setLotteryAdminConfig(localStorage.token, {
			ENABLE_TAROT_LOTTERY: config.ENABLE_TAROT_LOTTERY,
			ENABLE_DAILY_CHECKIN: config.ENABLE_DAILY_CHECKIN,
			TAROT_REWARD_CONFIG: JSON.stringify(clean),
			LOTTERY_TIMEZONE: config.LOTTERY_TIMEZONE,
			ENABLE_DAILY_CREDIT_RESET: config.ENABLE_DAILY_CREDIT_RESET,
			DAILY_RESET_CREDIT: `${config.DAILY_RESET_CREDIT}`
		}).catch((e) => {
			toast.error(`${e}`);
			return null;
		});
		saving = false;
		if (res) toast.success($i18n.t('Saved'));
	};

	const cardNames = (draw: LotteryDraw) =>
		draw?.type === 'checkin' || !(draw?.cards || []).length
			? $i18n.t('Daily Check-in')
			: (draw.cards || [])
			.map((c: { code: string; reversed?: boolean }) => (TAROT_BY_CODE[c.code]?.cn ?? c.code) + (c.reversed ? `(${$i18n.t('Reversed')})` : ''))
			.join(' · ');
	const fmtTime = (ts?: number) => (ts ? new Date(ts * 1000).toLocaleString() : '');

	$: if (loaded) {
		page;
		loadDraws();
	}

	onMount(async () => {
		await loadConfig();
		loaded = true;
	});
</script>

{#if !loaded}
	<div class="flex h-full items-center justify-center">
		<Spinner />
	</div>
{:else}
	<div class="flex flex-col gap-5 pb-8">
		<!-- ─────────── 塔罗抽奖配置 ─────────── -->
		<div>
			<div class="mb-2 text-lg font-medium">{$i18n.t('Tarot Lottery')}</div>

			<div class="flex justify-between items-center py-1">
				<div>
					<div class="text-sm font-medium">{$i18n.t('Enable Daily Check-in')}</div>
					<div class="text-xs text-gray-400">
						{$i18n.t('Daily check-in and tarot lottery cannot both be enabled.')}
					</div>
				</div>
				<Switch
					bind:state={config.ENABLE_DAILY_CHECKIN}
					on:change={() => {
						if (config.ENABLE_DAILY_CHECKIN) config.ENABLE_TAROT_LOTTERY = false;
					}}
				/>
			</div>

			<div class="flex justify-between items-center py-1">
				<div class="text-sm font-medium">{$i18n.t('Enable Tarot Lottery')}</div>
				<Switch
					bind:state={config.ENABLE_TAROT_LOTTERY}
					on:change={() => {
						if (config.ENABLE_TAROT_LOTTERY) config.ENABLE_DAILY_CHECKIN = false;
					}}
				/>
			</div>

			<div class="mt-3">
				<div class="flex justify-between items-center mb-1">
					<div class="text-sm font-medium">{$i18n.t('Reward Tiers & Weights')}</div>
					<button
						class="text-xs px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-gray-850 hover:bg-gray-200 dark:hover:bg-gray-800 transition"
						type="button"
						on:click={addTier}
					>
						+ {$i18n.t('Add Tier')}
					</button>
				</div>
				<div class="text-xs text-gray-400 mb-2">
					{$i18n.t(
						'Each draw or check-in awards one tier by weighted random. Probability = weight / total weight.'
					)}
				</div>

				<div class="flex text-xs text-gray-400 px-1 mb-1">
					<div class="w-1/3">{$i18n.t('Credit Amount')}</div>
					<div class="w-1/3">{$i18n.t('Weight')}</div>
					<div class="w-1/4">{$i18n.t('Probability')}</div>
					<div class="w-12"></div>
				</div>

				{#each tiers as tier, i}
					<div class="flex items-center gap-2 mb-1.5">
						<input
							class="w-1/3 rounded-lg py-1.5 px-3 text-sm bg-gray-50 dark:bg-gray-850 outline-hidden"
							type="number"
							step="0.0001"
							min="0"
							bind:value={tier.amount}
						/>
						<input
							class="w-1/3 rounded-lg py-1.5 px-3 text-sm bg-gray-50 dark:bg-gray-850 outline-hidden"
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
							on:click={() => removeTier(i)}
							disabled={tiers.length <= 1}
						>
							{$i18n.t('Delete')}
						</button>
					</div>
				{/each}
			</div>
		</div>

		<hr class="border-gray-100 dark:border-gray-850" />

		<!-- ─────────── 每日积分清零 ─────────── -->
		<div>
			<div class="mb-2 text-lg font-medium">{$i18n.t('Daily Credit Reset')}</div>

			<div class="flex justify-between items-center py-1">
				<div class="text-sm font-medium">{$i18n.t('Enable Daily Credit Reset')}</div>
				<Switch bind:state={config.ENABLE_DAILY_CREDIT_RESET} />
			</div>
			<div class="text-xs text-gray-400 mb-2">
				{$i18n.t('At 00:00 of the configured timezone, every user credit is reset to the value below.')}
			</div>

			<div class="flex gap-3">
				<div class="w-1/2">
					<div class="text-xs font-medium mb-1">{$i18n.t('Daily Reset Credit')}</div>
					<input
						class="w-full rounded-lg py-2 px-3 text-sm bg-gray-50 dark:bg-gray-850 outline-hidden"
						type="number"
						step="0.0001"
						min="0"
						bind:value={config.DAILY_RESET_CREDIT}
					/>
				</div>
				<div class="w-1/2">
					<div class="text-xs font-medium mb-1">{$i18n.t('Reset Timezone')}</div>
					<input
						class="w-full rounded-lg py-2 px-3 text-sm bg-gray-50 dark:bg-gray-850 outline-hidden"
						type="text"
						placeholder="Asia/Shanghai"
						bind:value={config.LOTTERY_TIMEZONE}
					/>
				</div>
			</div>
		</div>

		<div class="flex justify-end">
			<button
				class="px-4 py-2 rounded-full bg-black hover:bg-gray-900 text-white dark:bg-white dark:text-black dark:hover:bg-gray-100 text-sm font-medium transition flex items-center gap-2 disabled:opacity-50"
				type="button"
				on:click={save}
				disabled={saving}
			>
				{#if saving}<Spinner className="size-4" />{/if}
				{$i18n.t('Save')}
			</button>
		</div>

		<hr class="border-gray-100 dark:border-gray-850" />

		<!-- ─────────── 抽卡 / 赠分历史 ─────────── -->
		<div>
			<div class="flex justify-between items-center mb-2">
				<div class="text-lg font-medium">{$i18n.t('Draw History')}</div>
				<input
					class="w-56 rounded-lg py-1.5 px-3 text-sm bg-gray-50 dark:bg-gray-850 outline-hidden"
					placeholder={$i18n.t('Search by user id')}
					bind:value={keyword}
					on:keydown={(e) => {
						if (e.key === 'Enter') {
							page = 1;
							loadDraws();
						}
					}}
				/>
			</div>

			<div class="overflow-x-auto">
				<table class="w-full text-sm text-left">
					<thead class="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-850">
						<tr>
							<th class="py-2 pr-3">{$i18n.t('User')}</th>
							<th class="py-2 pr-3">{$i18n.t('Date')}</th>
							<th class="py-2 pr-3">{$i18n.t('Cards')}</th>
							<th class="py-2 pr-3">{$i18n.t('Reward')}</th>
							<th class="py-2 pr-3">{$i18n.t('Time')}</th>
						</tr>
					</thead>
					<tbody>
						{#each draws as d}
							<tr class="border-b border-gray-50 dark:border-gray-850/50">
								<td class="py-2 pr-3">
									<div>{d.name}</div>
									{#if d.email}<div class="text-xs text-gray-400">{d.email}</div>{/if}
								</td>
								<td class="py-2 pr-3 whitespace-nowrap">{d.draw_date}</td>
								<td class="py-2 pr-3">{cardNames(d)}</td>
								<td class="py-2 pr-3 font-medium text-amber-600 dark:text-amber-400">+{d.reward}</td>
								<td class="py-2 pr-3 whitespace-nowrap text-xs text-gray-400">{fmtTime(d.created_at)}</td>
							</tr>
						{/each}
						{#if draws.length === 0}
							<tr><td colspan="5" class="py-6 text-center text-gray-400">{$i18n.t('No records')}</td></tr>
						{/if}
					</tbody>
				</table>
			</div>

			{#if total > 30}
				<div class="mt-3">
					<Pagination bind:page count={total} perPage={30} />
				</div>
			{/if}
		</div>
	</div>
{/if}
