<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { user } from '$lib/stores';
	import { listCreditLog } from '$lib/apis/credit';
	import { toast } from 'svelte-sonner';
	import { getSessionUser } from '$lib/apis/auths';
	import Spinner from '$lib/components/common/Spinner.svelte';

	const i18n = getContext('i18n');

	type Model = {
		id: string;
		name: string;
	};
	type APIParams = {
		model: Model;
	};
	type Usage = {
		total_price: number;
		prompt_unit_price: number;
		completion_unit_price: number;
		call_price: number;
		request_unit_price?: number;
		completion_tokens: number;
		prompt_tokens: number;
	};
	type LogDetail = {
		desc: string;
		api_params: APIParams;
		usage: Usage;
	};
	type Log = {
		id: string;
		credit: string;
		detail: LogDetail;
		created_at: number;
	};
	let page = 1;
	let hasMore = true;
	let logs: Array<Log> = [];
	const loadLogs = async (append: boolean) => {
		const data = await listCreditLog(localStorage.token, page).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (!data) return;
		if (data.length === 0) {
			hasMore = false;
		}
		if (append) {
			logs = [...logs, ...data];
		} else {
			logs = data;
		}
	};
	const nextLogs = async () => {
		page++;
		await loadLogs(true);
	};

	let credit = 0;
	const formatDate = (t: number): string => {
		return new Date(t * 1000).toLocaleString();
	};

	const formatDesc = (log: Log): string => {
		const usage = log?.detail?.usage ?? {};
		if (usage && Object.keys(usage).length > 0) {
			if (usage.total_price !== undefined && usage.total_price !== null) {
				return `-${Math.round(usage.total_price * 1e6) / 1e6}`;
			}
			if (usage.call_price) {
				return `-${usage.call_price}`;
			}
			if (usage.request_unit_price) {
				return `-${usage.request_unit_price / 1e6}`;
			}
			if (usage.prompt_unit_price || usage.completion_unit_price) {
				return `-${Math.round(usage.prompt_tokens * usage.prompt_unit_price + usage.completion_tokens * usage.completion_unit_price) / 1e6}`;
			}
		}
		return log?.detail?.desc;
	};

	const doInit = async () => {
		const sessionUser = await getSessionUser(localStorage.token).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (sessionUser) {
			await user.set(sessionUser);
		}

		credit = $user?.credit ? $user.credit : 0;

		page = 1;
		hasMore = true;
		await loadLogs(false);
	};

	onMount(doInit);
</script>

<div class="flex flex-col h-full text-sm">
	<div class="mb-1 text-base font-medium">{$i18n.t('Credit')}</div>
	<div class="flex items-center">
		<div>{credit}</div>
		<button class="ml-1" on:click={doInit} aria-label={$i18n.t('Refresh')}>
			<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="16" height="16">
				<path d="M832 512a32 32 0 0 0-32 32c0 158.784-129.216 288-288 288s-288-129.216-288-288 129.216-288 288-288c66.208 0 129.536 22.752 180.608 64H608a32 32 0 0 0 0 64h160a32 32 0 0 0 32-32V192a32 32 0 0 0-64 0v80.96A350.464 350.464 0 0 0 512 192C317.92 192 160 349.92 160 544s157.92 352 352 352 352-157.92 352-352a32 32 0 0 0-32-32" fill="currentColor" />
			</svg>
		</button>
	</div>

	<hr class="border-gray-100 dark:border-gray-700/10 my-2.5 w-full" />

	<div class="pt-0.5">
		<div class="flex flex-col w-full">
			<div class="mb-1 text-base font-medium">{$i18n.t('Credit Log')}</div>
			<div
				class="overflow-y-scroll max-h-[14rem] flex flex-col scrollbar-hidden relative whitespace-nowrap overflow-x-auto max-w-full rounded-sm"
			>
				{#if logs.length === 0 && hasMore}
					<div class="my-10">
						<Spinner className="size-5" />
					</div>
				{:else if logs.length > 0}
					<table
						class="w-full text-sm text-left text-gray-500 dark:text-gray-400 table-fixed max-w-full rounded-sm"
					>
						<thead
							class="text-xs text-gray-700 uppercase bg-gray-50 dark:bg-gray-850 dark:text-gray-400 -translate-y-0.5"
						>
							<tr>
								<th scope="col" class="px-3 py-1.5 select-none w-3">
									{$i18n.t('Date')}
								</th>
								<th scope="col" class="px-3 py-1.5 select-none w-3">
									{$i18n.t('Credit')}
								</th>
								<th scope="col" class="px-3 py-1.5 select-none w-3">
									{$i18n.t('Model')}
								</th>
								<th scope="col" class="px-3 py-1.5 select-none w-3">
									{$i18n.t('Description')}
								</th>
							</tr>
						</thead>
						<tbody>
							{#each logs as log}
								<tr class="bg-white dark:bg-gray-900 dark:border-gray-850 text-xs group">
									<td
										class="px-3 py-1.5 text-left font-medium text-gray-900 dark:text-white w-fit"
									>
										<div class="line-clamp-1">
											{formatDate(log.created_at)}
										</div>
									</td>
									<td
										class="px-3 py-1.5 text-left font-medium text-gray-900 dark:text-white w-fit"
									>
										<div class="line-clamp-1">
											{parseFloat(log.credit).toFixed(6)}
										</div>
									</td>
									<td
										class="px-3 py-1.5 text-left font-medium text-gray-900 dark:text-white w-fit"
									>
										<div class="truncate">
											{log.detail?.api_params?.model?.name ||
												log.detail?.api_params?.model?.id ||
												'- -'}
										</div>
									</td>
									<td
										class="px-3 py-1.5 text-left font-medium text-gray-900 dark:text-white w-fit"
									>
										<div class="line-clamp-1">
											{formatDesc(log)}
										</div>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
					{#if hasMore}
						<button
							class="text-xs mt-2"
							type="button"
							on:click={() => {
								nextLogs();
							}}
						>
							{$i18n.t('Load More')}
						</button>
					{/if}
				{:else}
					<div>{$i18n.t('No Log')}</div>
				{/if}
			</div>
		</div>
	</div>
</div>
