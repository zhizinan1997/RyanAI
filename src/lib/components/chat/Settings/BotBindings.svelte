<script lang="ts">
	import { getContext, onDestroy, onMount } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as I18n } from 'i18next';
	import { toast } from 'svelte-sonner';
	import { models } from '$lib/stores';
	import {
		beginBotGatewayUserLogin,
		getBotGatewayUserConnections,
		getBotGatewayUserLoginState,
		getBotGatewayUserSettings,
		logoutBotGatewayUserConnection,
		setBotGatewayUserQQCredentials,
		updateBotGatewayUserSettings,
		type BotGatewayChannel,
		type BotGatewayLoginSession,
		type BotGatewayUserConnection
	} from '$lib/apis/bot-gateway';
	import Modal from '$lib/components/common/Modal.svelte';
	import QRCode from '$lib/components/common/QRCode.svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import UserSettingSection from './UserSettingSection.svelte';

	const i18n = getContext<Writable<I18n>>('i18n');
	const buttonClass =
		'rounded-lg border border-gray-200/70 px-2.5 py-1.5 text-xs text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5';
	const inputClass =
		'h-8 w-full rounded-lg border border-gray-100/60 bg-gray-50/50 px-2.5 text-xs text-gray-700 outline-hidden focus:border-blue-400 dark:border-white/[0.06] dark:bg-white/[0.03] dark:text-gray-300';

	let connections: BotGatewayUserConnection[] = [];
	let settings: any = null;
	let loading = true;
	let saving = false;
	let qqAppId = '';
	let qqAppSecret = '';
	let showQQ = false;
	let loginSession: BotGatewayLoginSession | null = null;
	let showLogin = false;
	let loginPoll: ReturnType<typeof setInterval> | null = null;
	let loginPollInFlight = false;
	let busyChannel: BotGatewayChannel | null = null;

	$: qqConnection = connections.find((item) => item.channel === 'qq');
	$: wechatConnection = connections.find((item) => item.channel === 'wechat');
	$: availableModels = $models ?? [];

	const statusText = (item?: BotGatewayUserConnection) =>
		item?.status === 'connected' ? $i18n.t('Connected') : item?.configured ? $i18n.t('Configured') : $i18n.t('Not configured');
	const loginFinished = (state?: string) =>
		['connected', 'confirmed', 'success', 'expired', 'error', 'failed', 'cancelled', 'logged_out', 'degraded', 'unavailable'].includes(state ?? '');

	const load = async () => {
		loading = true;
		try {
			[settings, connections] = await Promise.all([
				getBotGatewayUserSettings(localStorage.token),
				getBotGatewayUserConnections(localStorage.token)
			]);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : $i18n.t('Failed to load messaging bot settings.'));
		} finally { loading = false; }
	};

	const saveModel = async () => {
		saving = true;
		try {
			settings = await updateBotGatewayUserSettings(localStorage.token, { default_model_id: settings.default_model_id || null });
			toast.success($i18n.t('Bot model preference saved.'));
		} catch (error) { toast.error(error instanceof Error ? error.message : $i18n.t('Failed to save bot model.')); }
		finally { saving = false; }
	};

	const saveQQ = async () => {
		if (!qqAppId.trim() || !qqAppSecret.trim()) return;
		busyChannel = 'qq';
		try {
			await setBotGatewayUserQQCredentials(localStorage.token, { app_id: qqAppId.trim(), app_secret: qqAppSecret });
			connections = await getBotGatewayUserConnections(localStorage.token);
			qqAppSecret = '';
			showQQ = false;
			toast.success($i18n.t('Your QQ bot credentials were saved.'));
		} catch (error) { toast.error(error instanceof Error ? error.message : $i18n.t('Failed to save QQ credentials.')); }
		finally { busyChannel = null; }
	};

	const stopPolling = () => { if (loginPoll) clearInterval(loginPoll); loginPoll = null; };
	const pollLogin = async () => {
		if (loginPollInFlight || !showLogin) return;
		loginPollInFlight = true;
		try {
			const session = await getBotGatewayUserLoginState(localStorage.token);
			if (!showLogin) return;
			loginSession = session;
			if (loginFinished(loginSession.state)) {
				stopPolling();
				connections = await getBotGatewayUserConnections(localStorage.token);
			}
		} catch { /* keep the QR visible during transient polling errors */ }
		finally { loginPollInFlight = false; }
	};
	const loginWeChat = async () => {
		stopPolling();
		loginSession = null;
		busyChannel = 'wechat';
		showLogin = true;
		// Start polling immediately. The sidecar may have created the QR code
		// before the initial login request finishes.
		loginPoll = setInterval(pollLogin, 1000);
		try {
			loginSession = await beginBotGatewayUserLogin(localStorage.token);
			if (loginFinished(loginSession.state)) stopPolling();
		} catch (error) {
			// A slow initial response must not hide a QR code obtained by polling.
			if (!loginSession?.qr_code) {
				showLogin = false;
				stopPolling();
				toast.error(error instanceof Error ? error.message : $i18n.t('Failed to request WeChat QR code.'));
			}
		} finally { busyChannel = null; }
	};
	const logout = async (channel: BotGatewayChannel) => {
		const botLabel = channel === 'qq' ? 'QQ' : $i18n.t('WeChat');
		if (!window.confirm($i18n.t('Disconnecting will clear the bot credentials. You must bind it again before using it. Continue?'))) return;
		busyChannel = channel;
		try {
			await logoutBotGatewayUserConnection(localStorage.token, channel);
			connections = await getBotGatewayUserConnections(localStorage.token);
			toast.success($i18n.t('{{bot}} bot disconnected. Credentials were cleared.', { bot: botLabel }));
		} catch (error) { toast.error(error instanceof Error ? error.message : $i18n.t('Failed to disconnect bot.')); }
		finally { busyChannel = null; }
	};

	onMount(load);
	$: if (!showLogin) stopPolling();
	onDestroy(stopPolling);
</script>

<Modal bind:show={showQQ} size="sm">
	<form class="flex flex-col gap-4 p-5" on:submit|preventDefault={saveQQ}>
		<div><h3 class="text-base font-medium text-gray-900 dark:text-white">{$i18n.t('Bind your QQ bot')}</h3><p class="mt-1 text-xs text-gray-500 dark:text-gray-400">{$i18n.t('Open the QQ Bot Platform first, create a bot, and copy its AppID and AppSecret here.')}</p></div>
		<label class="text-xs text-gray-600 dark:text-gray-400">AppID<input class={inputClass} bind:value={qqAppId} required autocomplete="off" /></label>
		<label class="text-xs text-gray-600 dark:text-gray-400">AppSecret<input class={inputClass} type="password" bind:value={qqAppSecret} required autocomplete="new-password" /></label>
		<a class="text-xs text-blue-600 hover:underline dark:text-blue-400" href="https://q.qq.com/qqbot/" target="_blank" rel="noreferrer">{$i18n.t('Open QQ Bot Platform to apply for AppID and AppSecret')} ↗</a>
		<div class="flex justify-end gap-2"><button type="button" class={buttonClass} on:click={() => showQQ = false}>{$i18n.t('Cancel')}</button><button type="submit" class="rounded-lg bg-gray-900 px-3 py-1.5 text-xs text-white dark:bg-white dark:text-black" disabled={busyChannel === 'qq'} aria-busy={busyChannel === 'qq'}>{busyChannel === 'qq' ? $i18n.t('Saving…') : $i18n.t('Save')}</button></div>
	</form>
</Modal>

<Modal bind:show={showLogin} size="sm">
	<div class="flex flex-col items-center gap-3 p-5 text-center"><h3 class="text-base font-medium text-gray-900 dark:text-white">{$i18n.t('Bind your WeChat bot')}</h3>
		<p class="max-w-xs text-xs leading-5 text-gray-500 dark:text-gray-400">{$i18n.t('In WeChat, open Settings → Plugins, enable WeChat ClawBot, then scan the QR code below.')}</p>
		{#if loginSession?.qr_code}<div class="size-56 rounded-lg border border-gray-100 bg-white p-2 dark:border-white/10"><QRCode value={loginSession.qr_code} alt={$i18n.t('WeChat login QR code')} size={208} /></div>{:else if loginSession && loginFinished(loginSession.state)}<div class="flex size-56 items-center justify-center rounded-lg border border-gray-100 bg-gray-50 px-5 text-xs text-gray-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-gray-400">{loginSession.message || $i18n.t('WeChat login did not complete.')}</div>{:else}<Spinner className="my-20 size-6" />{/if}
		<p class="text-xs text-gray-500 dark:text-gray-400">{loginSession?.message || $i18n.t('Scan this QR code with the WeChat account that owns your bot.')}</p>
		{#if loginSession?.state === 'connected'}<p class="text-xs text-emerald-600">{$i18n.t('Connected successfully.')}</p>{/if}
	</div>
</Modal>

{#if loading}<div class="flex h-full items-center justify-center"><Spinner className="size-5" /></div>{:else}
	<form id="tab-bot-bindings" class="flex h-full flex-col text-sm" on:submit|preventDefault={saveModel}>
		<h2 class="mb-4 text-sm font-medium text-gray-900 dark:text-white">{$i18n.t('My messaging bots')}</h2>
		<div class="flex-1 min-h-0 overflow-y-auto scrollbar-hover pr-1.5">
			<UserSettingSection title={$i18n.t('Bot default model')} first>
				<p class="text-[0.6875rem] text-gray-400 dark:text-gray-600">{$i18n.t('Messages received by your bots use this model by default. You can switch models with bot commands.')}</p>
				<select class={inputClass} bind:value={settings.default_model_id} disabled={!settings.available}>
					<option value="">{$i18n.t('Use administrator recommendation')}</option>
					{#each availableModels as model}<option value={model.id}>{model.name || model.id}</option>{/each}
				</select>
				<div class="flex justify-end"><button type="submit" class="rounded-lg bg-gray-900 px-3 py-1.5 text-xs text-white dark:bg-white dark:text-black" disabled={saving || !settings.available}>{$i18n.t('Save')}</button></div>
			</UserSettingSection>
			<UserSettingSection title={$i18n.t('Common commands')}>
				<p class="text-[0.6875rem] leading-5 text-gray-400 dark:text-gray-600">{$i18n.t('Open the chat with your connected WeChat or QQ bot and send a command directly. Chinese and English commands are both supported.')}</p>
				<div class="border-y border-gray-100/80 text-xs dark:border-white/[0.06]">
					{#each [
						['/帮助 · /help', $i18n.t('Show command help')],
						['/状态 · /status', $i18n.t('Show bot connection and current model')],
						['/积分 · /points', $i18n.t('Check your current points')],
						['/模型列表 · /models', $i18n.t('List available models')],
						['/模型 [模型ID] · /model [ID]', $i18n.t('View or switch the current model')],
						['/模型 默认 · /model default', $i18n.t('Restore the default model')],
						['/新建 · /new', $i18n.t('Start a new conversation')],
						['/历史 · /history', $i18n.t('List recent bot conversations')],
						['/会话 [ID] · /conversation [ID]', $i18n.t('Continue a selected conversation')],
						['/绑定 [绑定码] · /bind [code]', $i18n.t('Bind a messaging account with a code')],
						['/解绑 · /unbind', $i18n.t('Request to disconnect the current messaging account')],
						['/解绑 确认 · /unbind confirm', $i18n.t('Confirm the disconnect request')]
					] as command}
						<div class="grid grid-cols-1 gap-1 border-b border-gray-100/80 py-2 last:border-b-0 sm:grid-cols-[minmax(13rem,auto)_1fr] sm:items-center sm:gap-4 dark:border-white/[0.06]">
							<code class="break-words text-[0.6875rem] text-gray-700 dark:text-gray-300">{command[0]}</code>
							<span class="text-[0.6875rem] text-gray-500 dark:text-gray-500">{command[1]}</span>
						</div>
					{/each}
				</div>
				<p class="text-[0.6875rem] leading-5 text-gray-500 dark:text-gray-500">{$i18n.t('Example: send /状态 to check the bot, or send /模型 模型ID to switch models. Normal questions, images, and files can be sent without commands.')}</p>
			</UserSettingSection>
			<UserSettingSection title={$i18n.t('Your QQ bot')}>
				<p class="text-[0.6875rem] text-gray-400 dark:text-gray-600">{$i18n.t('Create a bot on the QQ Bot Platform, then enter its AppID and AppSecret to bind it.')}</p>
				<a class="mb-2 inline-block text-[0.6875rem] text-blue-600 hover:underline dark:text-blue-400" href="https://q.qq.com/qqbot/" target="_blank" rel="noreferrer">{$i18n.t('Go to QQ Bot Platform to apply for credentials')} ↗</a>
				<div class="flex items-center justify-between rounded-xl border border-gray-100/80 p-3 dark:border-white/[0.06]"><div><div class="text-xs text-gray-700 dark:text-gray-300">QQ <span class="ml-1 text-[0.6875rem] text-gray-400">{statusText(qqConnection)}</span></div>{#if qqConnection?.account_name}<div class="mt-1 text-[0.6875rem] text-gray-400">{qqConnection.account_name}</div>{/if}</div><div class="flex gap-1.5"><button type="button" class={buttonClass} on:click={() => showQQ = true} disabled={!settings.qq_enabled}>{qqConnection?.configured ? $i18n.t('Replace credentials') : $i18n.t('Bind QQ bot')}</button>{#if qqConnection?.configured}<button type="button" class={buttonClass} on:click={() => logout('qq')} disabled={busyChannel === 'qq'}>{$i18n.t('Disconnect QQ bot')}</button>{/if}</div></div>
			</UserSettingSection>
			<UserSettingSection title={$i18n.t('Your WeChat bot')}>
				<p class="text-[0.6875rem] leading-5 text-gray-400 dark:text-gray-600">{$i18n.t('First open WeChat → Settings → Plugins and enable WeChat ClawBot. Then click the button below and scan the QR code in WeChat.')}</p>
				<div class="flex items-center justify-between rounded-xl border border-gray-100/80 p-3 dark:border-white/[0.06]"><div><div class="text-xs text-gray-700 dark:text-gray-300">{$i18n.t('WeChat')} <span class="ml-1 text-[0.6875rem] text-gray-400">{statusText(wechatConnection)}</span></div>{#if wechatConnection?.account_name}<div class="mt-1 text-[0.6875rem] text-gray-400">{wechatConnection.account_name}</div>{/if}</div><div class="flex gap-1.5"><button type="button" class={buttonClass} on:click={loginWeChat} disabled={!settings.wechat_enabled || busyChannel === 'wechat'}>{$i18n.t('Scan QR to bind')}</button>{#if wechatConnection?.configured}<button type="button" class={buttonClass} on:click={() => logout('wechat')} disabled={busyChannel === 'wechat'}>{$i18n.t('Disconnect WeChat bot')}</button>{/if}</div></div>
			</UserSettingSection>
			{#if !settings.available}<div class="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300">{$i18n.t('Messaging bots are disabled by the administrator.')}</div>{/if}
		</div>
	</form>
{/if}
