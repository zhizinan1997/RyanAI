<script lang="ts">
	import Switch from '$lib/components/common/Switch.svelte';
	import Textarea from '$lib/components/common/Textarea.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import EllipsisVertical from '$lib/components/icons/EllipsisVertical.svelte';
	import XMark from '$lib/components/icons/XMark.svelte';
	import type { Notification } from '$lib/types';
	import Sortable from 'sortablejs';
	import { getContext } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';
	const i18n: Writable<i18nType> = getContext('i18n');

	export let notifications: Notification[] = [];

	let sortable = null;
	let notificationListElement = null;

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
	{#each notifications as notification, notificationIdx (notification.id)}
		<div class=" flex justify-between items-start -ml-1" id="notification-item-{notification.id}">
			<EllipsisVertical className="size-4 cursor-move item-handle" />

			<div class="flex flex-col flex-1 gap-2">
				<div class="flex flex-row flex-1 gap-2 items-center">
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

					<Tooltip content={$i18n.t('Published')} className="flex h-fit items-center">
						<Switch bind:state={notification.active} />
					</Tooltip>

					<Tooltip content={$i18n.t('Remember Dismissal')} className="flex h-fit items-center">
						<Switch bind:state={notification.dismissible} />
					</Tooltip>
				</div>

				<Textarea
					className="mr-2 text-xs w-full bg-transparent outline-hidden resize-none"
					placeholder={$i18n.t('Content')}
					bind:value={notification.content}
					maxSize={100}
				/>
			</div>

			<button
				class="pr-3"
				type="button"
				on:click={() => {
					notifications[notificationIdx].active = false;
					notifications = notifications;
				}}
				aria-label={$i18n.t('Unpublish')}
			>
				<XMark className={'size-4'} />
			</button>
		</div>
	{/each}
</div>
