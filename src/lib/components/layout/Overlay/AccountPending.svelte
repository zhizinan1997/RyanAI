<script lang="ts">
	import DOMPurify from 'dompurify';
	import { marked } from 'marked';

	import { toast } from 'svelte-sonner';
	import {
		getAdminDetails,
		getLogoutRedirectUrl,
		resendSignupVerification,
		userSignOut,
		verifySignupEmail
	} from '$lib/apis/auths';
	import { onMount, getContext } from 'svelte';
	import type { Readable } from 'svelte/store';
	import type { i18n as I18n } from 'i18next';
	import { config, user, WEBUI_NAME } from '$lib/stores';
	import { WEBUI_BASE_URL } from '$lib/constants';

	const i18n = getContext<Readable<I18n>>('i18n');

	let adminDetails: { name: string; email: string } | null = null;

	$: title = ($config?.ui?.pending_user_overlay_title ?? '').trim();
	$: content = ($config?.ui?.pending_user_overlay_content ?? '').trim();

	const signOut = async () => {
		const res = await userSignOut().catch((err) => {
			console.error(err);
			return null;
		});
		localStorage.removeItem('token');
		location.href = getLogoutRedirectUrl(res?.redirect_url);
	};

	let verificationCode = '';
	let verifying = false;
	let resending = false;

	const verifyEmail = async () => {
		const code = verificationCode.trim();
		if (!/^\d{6}$/.test(code)) {
			toast.error($i18n.t('Please enter a valid 6-digit verification code.'));
			return;
		}
		if (!$user?.email) {
			toast.error($i18n.t('Unable to determine the email address for this account.'));
			return;
		}

		verifying = true;
		try {
			const sessionUser = await verifySignupEmail($user.email, code);
			if (sessionUser?.token) {
				localStorage.token = sessionUser.token;
				await user.set(sessionUser);
				toast.success($i18n.t('Your account has been activated.'));
				location.href = '/';
			}
		} catch (error) {
			const message =
				typeof error === 'string' ? error : $i18n.t('Invalid or expired verification code.');
			toast.error($i18n.t(message));
		} finally {
			verifying = false;
		}
	};

	const resendCode = async () => {
		if (!$user?.email || resending) return;
		resending = true;
		try {
			await resendSignupVerification(localStorage.token);
			toast.success($i18n.t('A new verification code has been sent.'));
		} catch (error) {
			const message =
				typeof error === 'string' ? error : $i18n.t('Unable to send a new verification code.');
			toast.error($i18n.t(message));
		} finally {
			resending = false;
		}
	};

	onMount(async () => {
		adminDetails = await getAdminDetails(localStorage.token).catch((err) => {
			console.error(err);
			return null;
		});
	});
</script>

<div
	class="fixed inset-0 z-999 overflow-y-auto bg-base-0 text-base-1000 dark:bg-base-1000 dark:text-base-0"
>
	<div class="w-full absolute top-0 left-0 right-0 h-8 drag-region"></div>
	<main
		id="main-content"
		tabindex="-1"
		class="min-h-dvh w-full p-6 flex flex-col items-center justify-center text-center"
	>
		<div class="my-auto w-full sm:max-w-xl py-20 sm:pb-10 sm:pt-0 dark:text-base-100">
			<h1 class="text-xl font-normal whitespace-pre-wrap">
				{title || $i18n.t('Account Activation Pending')}
				{#if !title && $config?.features?.enable_signup_verify}<br />{$i18n.t(
						'Verify your email to continue'
					)}{/if}
			</h1>

			<div
				class="mt-3 text-xs leading-5 text-balance text-base-500 dark:text-base-400 [&_a]:underline"
			>
				{#if content}
					{@html DOMPurify.sanitize(marked.parse(content.replace(/\n/g, '<br>')) as string)}
				{:else if $config?.features?.enable_signup_verify}
					{$i18n.t('Please enter the 6-digit verification code sent to your email.')}
				{:else}
					{$i18n.t('Your account status is currently pending activation.')}
					{$i18n.t(
						'To access the WebUI, please reach out to the administrator. Admins can manage user statuses from the Admin Panel.'
					)}
				{/if}
			</div>

			{#if $config?.features?.enable_signup_verify}
				<form class="mt-5" on:submit|preventDefault={verifyEmail}>
					<label class="block text-sm font-medium text-center dark:text-gray-100" for="signup-code">
						{$i18n.t('Verification Code')}
					</label>
					{#if $user?.email}
						<div class="mt-1 text-xs text-center text-gray-500 dark:text-gray-400">
							{$i18n.t('The verification code was sent to {{email}}', { email: $user.email })}
						</div>
					{/if}
					<input
						id="signup-code"
						class="mt-3 w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-center text-2xl font-semibold tracking-[0.45em] text-gray-900 outline-hidden focus:border-gray-400 dark:border-gray-700 dark:bg-gray-850 dark:text-white"
						type="text"
						inputmode="numeric"
						autocomplete="one-time-code"
						maxlength="6"
						placeholder="000000"
						bind:value={verificationCode}
						on:input={() => {
							verificationCode = verificationCode.replace(/\D/g, '').slice(0, 6);
						}}
					/>
					<button
						class="mt-3 w-full rounded-xl bg-gray-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
						type="submit"
						disabled={verifying || verificationCode.length !== 6}
					>
						{verifying ? $i18n.t('Verifying...') : $i18n.t('Verify and Activate')}
					</button>
					<button
						type="button"
						class="mt-2 w-full text-xs text-gray-500 underline transition hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-60 dark:text-gray-400 dark:hover:text-gray-200"
						disabled={resending}
						on:click={resendCode}
					>
						{resending ? $i18n.t('Sending...') : $i18n.t('Resend verification code')}
					</button>
				</form>
			{/if}

			{#if adminDetails}
				<p class="mt-1 text-xs leading-5 text-base-500 dark:text-base-400">
					{$i18n.t('Admin')}: {adminDetails.name} ·
					<a
						class="underline hover:text-base-1000 dark:hover:text-base-0 transition"
						href="mailto:{adminDetails.email}">{adminDetails.email}</a
					>
				</p>
			{/if}

			<div class="mt-6 flex justify-center gap-1">
				<button
					class="flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-base-900 px-2.5 text-xs font-normal text-base-0 transition hover:bg-base-1000 dark:bg-base-100 dark:text-base-900 dark:hover:bg-base-0"
					on:click={() => (location.href = '/')}
				>
					{$i18n.t('Check Again')}
				</button>
				<button
					class="flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-normal text-base-600 transition hover:bg-base-100 hover:text-base-900 dark:text-base-400 dark:hover:bg-base-850 dark:hover:text-base-0"
					on:click={signOut}
				>
					{$i18n.t('Sign Out')}
				</button>
			</div>
		</div>
	</main>

	<div class="fixed top-0 left-0 m-10 z-50">
		<img
			crossorigin="anonymous"
			src="{WEBUI_BASE_URL}/static/favicon.png"
			class="w-6 rounded-full"
			alt="{$WEBUI_NAME} logo"
		/>
	</div>
</div>
