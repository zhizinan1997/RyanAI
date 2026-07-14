<script lang="ts">
	import DOMPurify from 'dompurify';
	import { marked } from 'marked';
	import { toast } from 'svelte-sonner';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	import { getAdminDetails, resendSignupVerification, verifySignupEmail } from '$lib/apis/auths';
	import { onMount, getContext } from 'svelte';
	import { config, user } from '$lib/stores';

	const i18n: Writable<i18nType> = getContext('i18n');

	let adminDetails: { name: string; email: string } | null = null;
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

<div class="fixed w-full h-full flex z-999">
	<div
		class="absolute w-full h-full backdrop-blur-lg bg-white/10 dark:bg-gray-900/50 flex justify-center"
	>
		<div class="m-auto pb-10 flex flex-col justify-center">
			<div class="max-w-md">
				<div
					class="text-center dark:text-white text-2xl font-medium z-50"
					style="white-space: pre-wrap;"
				>
					{#if ($config?.ui?.pending_user_overlay_title ?? '').trim() !== ''}
						{$config?.ui?.pending_user_overlay_title}
					{:else if $config?.features?.enable_signup_verify}
						{$i18n.t('Account Activation Pending')}<br />
						{$i18n.t('Verify your email to continue')}
					{:else}
						{$i18n.t('Account Activation Pending')}<br />
						{$i18n.t('Contact Admin for WebUI Access')}
					{/if}
				</div>

				<div
					class=" mt-4 text-center text-sm dark:text-gray-200 w-full"
					style="white-space: pre-wrap;"
				>
					{#if ($config?.ui?.pending_user_overlay_content ?? '').trim() !== ''}
						{@html DOMPurify.sanitize(
							marked.parse(($config?.ui?.pending_user_overlay_content ?? '').replace(/\n/g, '<br>'))
						)}
					{:else if $config?.features?.enable_signup_verify}
						{$i18n.t('Please enter the 6-digit verification code sent to your email.')}
					{:else}
						{$i18n.t('Your account status is currently pending activation.')}{'\n'}{$i18n.t(
							'To access the WebUI, please reach out to the administrator. Admins can manage user statuses from the Admin Panel.'
						)}
					{/if}
				</div>

				{#if $config?.features?.enable_signup_verify}
					<form class="mt-5" on:submit|preventDefault={verifyEmail}>
						<label
							class="block text-sm font-medium text-center dark:text-gray-100"
							for="signup-code"
						>
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
					<div class="mt-4 text-sm font-medium text-center">
						<div>{$i18n.t('Admin')}: {adminDetails.name} ({adminDetails.email})</div>
					</div>
				{/if}

				<div class=" mt-6 mx-auto relative group w-fit">
					<button
						class="relative z-20 flex px-5 py-2 rounded-full bg-white border border-gray-100 dark:border-none hover:bg-gray-100 text-gray-700 transition font-medium text-sm"
						on:click={async () => {
							location.href = '/';
						}}
					>
						{$i18n.t('Check Again')}
					</button>

					<button
						class="text-xs text-center w-full mt-2 text-gray-400 underline"
						on:click={async () => {
							localStorage.removeItem('token');
							location.href = '/auth';
						}}>{$i18n.t('Sign Out')}</button
					>
				</div>
			</div>
		</div>
	</div>
</div>
