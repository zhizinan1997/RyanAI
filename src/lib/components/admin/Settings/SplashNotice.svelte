<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { getContext, onMount } from 'svelte';
	import {
		deleteSplashNoticeMedia,
		getAdminConfig,
		updateAdminConfig,
		uploadSplashNoticeMedia
	} from '$lib/apis/auths';
	import Switch from '$lib/components/common/Switch.svelte';
	import Textarea from '$lib/components/common/Textarea.svelte';
	import SplashNoticeOverlay from '$lib/components/layout/Overlay/SplashNotice.svelte';

	const i18n = getContext('i18n');
	const SPLASH_NOTICE_MEDIA_MAX_SIZE_MB = 15;

	export let saveHandler: Function;

	let adminConfig = null;
	let showPreview = false;
	let mediaInputElement: HTMLInputElement;
	let isUploadingMedia = false;

	const submitHandler = async () => {
		await updateAdminConfig(localStorage.token, adminConfig);
	};

	const getLocalizedUploadError = (error: unknown) => {
		if (typeof error !== 'string') {
			return $i18n.t('Failed to upload file.');
		}

		switch (error) {
			case 'No file selected':
				return $i18n.t('No file selected');
			case 'Unsupported image format. Please upload a PNG, JPG, GIF, or WebP file.':
				return $i18n.t('Please upload a PNG, JPG, GIF, or WebP image.');
			case 'Uploaded file is empty':
				return $i18n.t('Uploaded file is empty');
			case 'Image is too large. Please keep it under 15 MB.':
				return $i18n.t('Image is too large. Please keep it under {{SIZE}} MB.', {
					SIZE: SPLASH_NOTICE_MEDIA_MAX_SIZE_MB
				});
			default:
				return error;
		}
	};

	const uploadMedia = async () => {
		const files = mediaInputElement?.files ?? [];
		if (!files.length) {
			return;
		}

		const file = files[0];

		if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) {
			toast.error($i18n.t('Please upload a PNG, JPG, GIF, or WebP image.'));
			mediaInputElement.value = '';
			return;
		}

		if (file.size > SPLASH_NOTICE_MEDIA_MAX_SIZE_MB * 1024 * 1024) {
			toast.error(
				$i18n.t('Image is too large. Please keep it under {{SIZE}} MB.', {
					SIZE: SPLASH_NOTICE_MEDIA_MAX_SIZE_MB
				})
			);
			mediaInputElement.value = '';
			return;
		}

		isUploadingMedia = true;

		try {
			const res = await uploadSplashNoticeMedia(localStorage.token, file);
			adminConfig.SPLASH_NOTICE_MEDIA_URL = res.url;
			toast.success($i18n.t('File uploaded successfully'));
		} catch (error) {
			console.error(error);
			toast.error(getLocalizedUploadError(error));
		} finally {
			isUploadingMedia = false;
			mediaInputElement.value = '';
		}
	};

	const removeMedia = async () => {
		try {
			await deleteSplashNoticeMedia(localStorage.token);
			adminConfig.SPLASH_NOTICE_MEDIA_URL = '';
			toast.success($i18n.t('File removed successfully.'));
		} catch (error) {
			console.error(error);
			toast.error($i18n.t('Failed to remove file.'));
		}
	};

	onMount(async () => {
		adminConfig = await getAdminConfig(localStorage.token);
	});
</script>

<input
	bind:this={mediaInputElement}
	type="file"
	hidden
	accept="image/png,image/jpeg,image/gif,image/webp"
	on:change={uploadMedia}
/>

<form
	class="flex h-full flex-col justify-between space-y-3 text-sm"
	on:submit|preventDefault={async () => {
		await submitHandler();
		saveHandler();
	}}
>
	<div class="h-full space-y-3 overflow-y-scroll scrollbar-hidden">
		{#if adminConfig !== null}
			<div class="mb-3.5">
				<div class="mt-0.5 mb-2.5 text-base font-medium">
					{$i18n.t('Splash Notice')}
				</div>
				<hr class="my-2 border-gray-100/30 dark:border-gray-850/30" />

				<div
					class="mb-4 rounded-[1.8rem] border border-slate-200/80 bg-linear-to-br from-white to-slate-50 px-4 py-4 text-xs leading-6 text-slate-600 shadow-[0_24px_50px_-38px_rgba(15,23,42,0.2)] dark:border-white/10 dark:from-slate-950 dark:to-slate-900 dark:text-slate-300"
				>
					<div>
						{$i18n.t(
							'After enabling, a splash notice appears in the center every time a user opens or refreshes the page.'
						)}
					</div>
					<div class="mt-1.5">
						{$i18n.t(
							'Markdown is supported, making it suitable for announcements, update notes, and event notifications.'
						)}
					</div>
				</div>

				<div class="mb-2.5 flex w-full items-center justify-between pr-2">
					<div class="self-center text-xs font-medium">
						{$i18n.t('Enable Splash Notice')}
					</div>
					<Switch bind:state={adminConfig.ENABLE_SPLASH_NOTICE} />
				</div>

				<div class="mb-2.5">
					<div class="mb-2 self-center text-xs font-medium">
						{$i18n.t('Splash Notice Title')}
					</div>
					<input
						class="w-full rounded-xl bg-gray-50 px-4 py-2 text-sm outline-hidden dark:bg-gray-850 dark:text-gray-300"
						type="text"
						placeholder={$i18n.t('Enter splash notice title')}
						bind:value={adminConfig.SPLASH_NOTICE_TITLE}
					/>
				</div>

				<div class="mb-2.5">
					<div class="mb-2 self-center text-xs font-medium">
						{$i18n.t('Splash Notice Content')}
					</div>
					<Textarea
						placeholder={$i18n.t('Enter splash notice content in Markdown')}
						bind:value={adminConfig.SPLASH_NOTICE_CONTENT}
					/>
				</div>

				<div class="mb-2.5">
					<div class="mb-2 self-center text-xs font-medium">
						{$i18n.t('Splash Notice Visual')}
					</div>

					<div
						class="rounded-[1.6rem] border border-slate-200/80 bg-linear-to-br from-white to-slate-50 p-3 shadow-[0_20px_40px_-32px_rgba(15,23,42,0.18)] dark:border-white/10 dark:from-slate-950 dark:to-slate-900"
					>
						{#if adminConfig.SPLASH_NOTICE_MEDIA_URL}
							<div
								class="overflow-hidden rounded-[1.2rem] border border-slate-200/80 bg-white dark:border-white/10 dark:bg-slate-900"
							>
								<img
									src={adminConfig.SPLASH_NOTICE_MEDIA_URL}
									alt={$i18n.t('Splash Notice Visual')}
									class="aspect-[16/10] w-full object-cover"
								/>
							</div>
						{:else}
							<div
								class="flex aspect-[16/10] items-center justify-center rounded-[1.2rem] border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-400 dark:border-white/10 dark:bg-slate-900/60 dark:text-slate-500"
							>
								{$i18n.t('Upload image or GIF')}
							</div>
						{/if}

						<div class="mt-3 flex flex-wrap gap-2">
							<button
								class="rounded-full border border-sky-200/80 bg-sky-50 px-3.5 py-1.5 text-sm font-medium text-sky-700 transition hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:bg-white/5 dark:text-sky-200 dark:hover:bg-white/10"
								type="button"
								disabled={isUploadingMedia}
								on:click={() => {
									mediaInputElement.click();
								}}
							>
								{#if isUploadingMedia}
									{$i18n.t('Uploading...')}
								{:else}
									{$i18n.t('Upload')}
								{/if}
							</button>

							{#if adminConfig.SPLASH_NOTICE_MEDIA_URL}
								<button
									class="rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50 dark:border-white/10 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
									type="button"
									on:click={removeMedia}
								>
									{$i18n.t('Remove')}
								</button>
							{/if}
						</div>

						<div class="mt-2 text-xs leading-6 text-slate-500 dark:text-slate-400">
							{$i18n.t('Recommended: Use a wide image or GIF for the right-side visual area.')}
						</div>
					</div>
				</div>
			</div>
		{/if}
	</div>

	<div class="flex justify-end gap-2 pt-3 text-sm font-medium">
		<button
			class="rounded-full border border-sky-200/80 bg-white/80 px-3.5 py-1.5 text-sm font-medium text-sky-700 transition hover:bg-sky-50 dark:border-white/10 dark:bg-white/5 dark:text-sky-200 dark:hover:bg-white/10"
			type="button"
			on:click={() => {
				showPreview = true;
			}}
		>
			{$i18n.t('Preview')}
		</button>
		<button
			class="rounded-full bg-black px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-gray-900 dark:bg-white dark:text-black dark:hover:bg-gray-100"
			type="submit"
		>
			{$i18n.t('Save')}
		</button>
	</div>
</form>

{#if adminConfig !== null}
	<SplashNoticeOverlay
		bind:show={showPreview}
		title={adminConfig.SPLASH_NOTICE_TITLE ?? ''}
		content={adminConfig.SPLASH_NOTICE_CONTENT ?? ''}
		mediaUrl={adminConfig.SPLASH_NOTICE_MEDIA_URL ?? ''}
	/>
{/if}
