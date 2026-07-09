<script lang="ts">
	import Switch from '$lib/components/common/Switch.svelte';
	import Textarea from '$lib/components/common/Textarea.svelte';
	import EllipsisVertical from '$lib/components/icons/EllipsisVertical.svelte';
	import XMark from '$lib/components/icons/XMark.svelte';
	import type { Notification } from '$lib/types';
	import Sortable from 'sortablejs';
	import { getContext } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';
	const i18n: Writable<i18nType> = getContext('i18n');

	export let notifications: Notification[] = [];
	export let deletedNotificationIds: string[] = [];

	let sortable = null;
	let notificationListElement = null;

	const deleteNotificationItem = (notification: Notification) => {
		if (
			!notification.id.startsWith('local-') &&
			!deletedNotificationIds.includes(notification.id)
		) {
			deletedNotificationIds = [...deletedNotificationIds, notification.id];
		}

		notifications = notifications.filter((item) => item.id !== notification.id);
	};

	const positionChangeHandler = () => {
		const notificationIdOrder = Array.from(notificationListElement.children).map((child) =>
			child.id.replace('notification-item-', '')
		);

		notifications = notificationIdOrder.map((id) => {
			const index = notifications.findIndex((notification) => notification.id === id);
			return notifications[index];
		});
	};

	$: if (notifications) {
		init();
	}

	const init = () => {
		if (sortable) {
			sortable.destroy();
		}

		if (notificationListElement) {
			sortable = new Sortable(notificationListElement, {
				animation: 150,
				handle: '.item-handle',
				onUpdate: async () => {
					positionChangeHandler();
				}
			});
		}
	};
</script>

<div
	class=" flex flex-col gap-3 {notifications?.length > 0 ? 'mt-2' : ''}"
	bind:this={notificationListElement}
>
	{#each notifications as notification (notification.id)}
		<div class=" flex justify-between items-start -ml-1" id="notification-item-{notification.id}">
			<EllipsisVertical className="size-4 cursor-move item-handle" />

			<div class="flex flex-col flex-1 gap-2">
				<div class="flex flex-row flex-1 flex-wrap gap-2 items-center">
					<select
						class="w-fit capitalize rounded-xl text-xs bg-transparent outline-hidden pl-1 pr-5"
						bind:value={notification.type}
						required
					>
						<option value="info" class="text-gray-900">{$i18n.t('Info')}</option>
						<option value="warning" class="text-gray-900">{$i18n.t('Warning')}</option>
						<option value="error" class="text-gray-900">{$i18n.t('Error')}</option>
						<option value="success" class="text-gray-900">{$i18n.t('Success')}</option>
					</select>

					<input
						class="min-w-0 flex-1 text-xs bg-transparent outline-hidden"
						placeholder={$i18n.t('Title')}
						bind:value={notification.title}
					/>

					<div
						class="flex h-fit shrink-0 items-center gap-1 text-xs text-gray-600 dark:text-gray-300"
					>
						<span id="notification-published-label-{notification.id}">{$i18n.t('Published')}</span>
						<Switch
							id="notification-published-{notification.id}"
							ariaLabelledbyId="notification-published-label-{notification.id}"
							bind:state={notification.active}
						/>
					</div>

					<div
						class="flex h-fit shrink-0 items-center gap-1 text-xs text-gray-600 dark:text-gray-300"
					>
						<span id="notification-dismissible-label-{notification.id}">
							{$i18n.t('Remember Dismissal')}
						</span>
						<Switch
							id="notification-dismissible-{notification.id}"
							ariaLabelledbyId="notification-dismissible-label-{notification.id}"
							bind:state={notification.dismissible}
						/>
					</div>
				</div>

				<Textarea
					className="mr-2 text-xs w-full bg-transparent outline-hidden resize-none"
					placeholder={$i18n.t('Content')}
					bind:value={notification.content}
					maxSize={100}
				/>
			</div>

			<button
				class="flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white transition"
				type="button"
				on:pointerdown|stopPropagation
				on:click|preventDefault|stopPropagation={() => deleteNotificationItem(notification)}
				aria-label={$i18n.t('Delete')}
			>
				<XMark className={'size-4'} />
				<span>{$i18n.t('Delete')}</span>
			</button>
		</div>
	{/each}
</div>
