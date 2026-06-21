<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';
	import DOMPurify from 'dompurify';
	import { marked } from 'marked';

	import { getNotifications } from '$lib/apis/configs';
	import type { Notification } from '$lib/types';
	import { notifications } from '$lib/stores';

	import AppNotification from '$lib/components/icons/AppNotification.svelte';
	import Dropdown from '$lib/components/common/Dropdown.svelte';
	import Modal from '$lib/components/common/Modal.svelte';
	import Pagination from '$lib/components/common/Pagination.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';

	const i18n: Writable<i18nType> = getContext('i18n');

	const READ_KEY = 'readNotificationIds';
	const IGNORED_KEY = 'ignoredNotificationIds';
	const limit = 5;

	let show = false;
	let showDetail = false;
	let mounted = false;
	let loading = false;
	let page = 1;
	let previousPage = page;
	let total = 0;
	let items: Notification[] = [];
	let selectedNotification: Notification | null = null;
	let readIds: string[] = [];
	let ignoredIds: string[] = [];

	const classNames: Record<string, string> = {
		info: 'bg-blue-500/20 text-blue-700 dark:text-blue-200',
		success: 'bg-green-500/20 text-green-700 dark:text-green-200',
		warning: 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-200',
		error: 'bg-red-500/20 text-red-700 dark:text-red-200'
	};

	const getStoredIds = (key: string): string[] => {
		try {
			return JSON.parse(localStorage.getItem(key) ?? '[]');
		} catch {
			return [];
		}
	};

	const setStoredIds = (key: string, ids: string[]) => {
		localStorage.setItem(key, JSON.stringify(Array.from(new Set(ids))));
	};

	const loadLocalState = () => {
		readIds = getStoredIds(READ_KEY);
		ignoredIds = getStoredIds(IGNORED_KEY);
	};

	const refreshSummary = async () => {
		const res = await getNotifications(localStorage.token, 1, 100, true);
		notifications.set(res.items);
	};

	const refreshList = async () => {
		loading = true;
		const res = await getNotifications(localStorage.token, page, limit, true).catch((error) => {
			console.error('Failed to load notifications:', error);
			return null;
		});
		if (res) {
			items = res.items;
			total = res.total;
			page = res.page;
			previousPage = res.page;
		}
		loading = false;
	};

	const refreshNotifications = async () => {
		await Promise.all([refreshList(), refreshSummary().catch((error) => console.error(error))]);
	};

	const typeLabel = (type: string) => {
		if (type?.toLowerCase() === 'success') return $i18n.t('Success');
		if (type?.toLowerCase() === 'warning') return $i18n.t('Warning');
		if (type?.toLowerCase() === 'error') return $i18n.t('Error');
		return $i18n.t('Info');
	};

	const formatDate = (timestamp?: number | null) => {
		if (!timestamp) return '';
		return new Intl.DateTimeFormat(undefined, {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit'
		}).format(new Date(timestamp * 1000));
	};

	const markIgnored = (notification: Notification) => {
		if (!notification.dismissible) return;
		ignoredIds = [notification.id, ...ignoredIds];
		setStoredIds(IGNORED_KEY, ignoredIds);
	};

	const markRead = (notification: Notification) => {
		readIds = [notification.id, ...readIds];
		setStoredIds(READ_KEY, readIds);
	};

	const openDetail = (notification: Notification) => {
		selectedNotification = notification;
		showDetail = true;
	};

	$: unreadCount = ($notifications ?? []).filter(
		(notification) =>
			notification.active &&
			!readIds.includes(notification.id) &&
			!ignoredIds.includes(notification.id)
	).length;

	$: if (mounted && page !== previousPage) {
		previousPage = page;
		refreshList();
	}

	onMount(async () => {
		mounted = true;
		loadLocalState();
		if (($notifications ?? []).length === 0) {
			await refreshSummary().catch((error) => console.error(error));
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
			refreshNotifications();
		}
	}}
>
	<Tooltip content={$i18n.t('Notifications')}>
		<button
			class="relative flex cursor-pointer px-2 py-2 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-850 transition"
			aria-label={$i18n.t('Notifications')}
			type="button"
		>
			<div class=" m-auto self-center">
				<AppNotification className=" size-5" strokeWidth="1.5" />
			</div>
			{#if unreadCount > 0}
				<div
					class="absolute right-1 top-1 min-w-4 h-4 px-1 rounded-full bg-red-500 text-white text-[10px] leading-4 text-center font-medium"
				>
					{unreadCount > 99 ? '99+' : unreadCount}
				</div>
			{/if}
		</button>
	</Tooltip>

	<div slot="content" class="flex flex-col gap-2">
		<div class="px-2 py-1 text-xs font-semibold text-gray-900 dark:text-gray-100">
			{$i18n.t('Notifications')}
		</div>

		{#if loading}
			<div class="px-2 py-6 text-center text-xs text-gray-500">{$i18n.t('Loading...')}</div>
		{:else if items.length === 0}
			<div class="px-2 py-6 text-center text-xs text-gray-500">{$i18n.t('No notifications')}</div>
		{:else}
			<div class="flex flex-col gap-1 max-h-[360px] overflow-y-auto">
				{#each items as notification (notification.id)}
					<div class="rounded-lg px-2 py-2 hover:bg-gray-50 dark:hover:bg-gray-850 transition">
						<div class="flex items-start justify-between gap-2">
							<div class="min-w-0">
								<div class="flex items-center gap-1.5">
									<div
										class="shrink-0 text-[10px] font-semibold uppercase rounded-sm px-1.5 {classNames[
											notification.type
										] ?? classNames.info}"
									>
										{typeLabel(notification.type)}
									</div>
									{#if !notification.active}
										<div
											class="shrink-0 text-[10px] font-medium rounded-sm px-1.5 bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
										>
											{$i18n.t('Archived')}
										</div>
									{/if}
								</div>
								<div class="mt-1 text-xs font-medium text-gray-900 dark:text-gray-100 line-clamp-1">
									{notification.title || notification.content}
								</div>
								<div class="mt-0.5 text-[11px] text-gray-500">
									{formatDate(notification.published_at ?? notification.updated_at)}
								</div>
							</div>
						</div>

						<div class="mt-2 flex items-center gap-2">
							<button
								type="button"
								class="text-xs font-medium underline text-gray-700 dark:text-gray-200"
								on:click={() => openDetail(notification)}
							>
								{$i18n.t('View details')}
							</button>
							<button
								type="button"
								class="text-xs font-medium underline disabled:no-underline disabled:text-gray-400 text-gray-700 dark:text-gray-200"
								disabled={!notification.dismissible || ignoredIds.includes(notification.id)}
								on:click={() => markIgnored(notification)}
							>
								{ignoredIds.includes(notification.id)
									? $i18n.t('Ignored')
									: $i18n.t('Ignore reminder')}
							</button>
						</div>
					</div>
				{/each}
			</div>

			{#if total > limit}
				<Pagination bind:page count={total} perPage={limit} />
			{/if}
		{/if}
	</div>
</Dropdown>

{#if selectedNotification}
	<Modal bind:show={showDetail} size="sm">
		<div class="p-5">
			<div class="flex items-center gap-2">
				<div
					class="text-[10px] font-semibold uppercase rounded-sm px-1.5 {classNames[
						selectedNotification.type
					] ?? classNames.info}"
				>
					{typeLabel(selectedNotification.type)}
				</div>
				<div class="text-xs text-gray-500">
					{formatDate(selectedNotification.published_at ?? selectedNotification.updated_at)}
				</div>
			</div>

			<div class="mt-3 text-base font-semibold text-gray-900 dark:text-gray-100">
				{selectedNotification.title || $i18n.t('Notification details')}
			</div>

			<div class="mt-3 max-h-[50vh] overflow-y-auto text-sm text-gray-700 dark:text-gray-200">
				{@html DOMPurify.sanitize(marked.parse((selectedNotification.content ?? '').replace(/\n/g, '<br>')))}
			</div>

			<div class="mt-5 flex justify-end">
				<button
					type="button"
					class="px-4 py-2 text-sm font-medium rounded-full bg-black text-white dark:bg-white dark:text-black"
					on:click={() => {
						if (selectedNotification) {
							markRead(selectedNotification);
						}
						showDetail = false;
					}}
				>
					{$i18n.t('I have read')}
				</button>
			</div>
		</div>
	</Modal>
{/if}
