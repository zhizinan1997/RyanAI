<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { getContext, onDestroy, onMount } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	import { models, terminalServers } from '$lib/stores';
	import { getTerminalServers } from '$lib/apis/terminal';
	import { WEBUI_API_BASE_URL } from '$lib/constants';
	import {
		beginBotGatewayLogin,
		blockAdminBotGatewayBinding,
		discoverBotGatewayGroups,
		getAdminBotGatewayBindings,
		getBotGatewayConnections,
		getBotGatewayGroups,
		getBotGatewayLoginState,
		getBotGatewayAdminSettings,
		getBotGatewayAuditRecords,
		logoutBotGateway,
		reconnectBotGateway,
		setQQBotCredentials,
		unblockAdminBotGatewayBinding,
		updateBotGatewayConnection,
		updateBotGatewayAdminSettings,
		updateBotGatewayGroup,
		type BotGatewayBinding,
		type BotGatewayChannel,
		type BotGatewayConnection,
		type BotGatewayGroup,
		type BotGatewayLoginSession,
		type BotGatewayAdminSettings,
		type BotGatewayAuditRecord
	} from '$lib/apis/bot-gateway';
	import {
		getTerminalServerConnections,
		getToolServerConnections,
		setTerminalServerConnections,
		setToolServerConnections
	} from '$lib/apis/configs';

	import AddTerminalServerModal from '$lib/components/AddTerminalServerModal.svelte';
	import AddToolServerModal from '$lib/components/AddToolServerModal.svelte';
	import Connection from '$lib/components/chat/Settings/Tools/Connection.svelte';
	import ConfirmDialog from '$lib/components/common/ConfirmDialog.svelte';
	import Modal from '$lib/components/common/Modal.svelte';
	import QRCode from '$lib/components/common/QRCode.svelte';
	import SensitiveInput from '$lib/components/common/SensitiveInput.svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import Switch from '$lib/components/common/Switch.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import Cloud from '$lib/components/icons/Cloud.svelte';
	import Cog6 from '$lib/components/icons/Cog6.svelte';
	import Plus from '$lib/components/icons/Plus.svelte';
	import AdminSettingSection from './AdminSettingSection.svelte';
	import ExternalKnowledge from './ExternalKnowledge.svelte';

	const i18n = getContext<Writable<i18nType>>('i18n');

	export let saveSettings: Function;

	type ToolServerConnection = any;
	type TerminalConnection = {
		id?: string;
		url?: string;
		name?: string;
		key?: string;
		enabled?: boolean;
		[key: string]: any;
	};

	const botChannels: { channel: BotGatewayChannel; title: string; description: string }[] = [
		{
			channel: 'wechat',
			title: 'WeChat',
			description: 'Forward personal WeChat messages into the Ryan AI conversation pipeline.'
		},
		{
			channel: 'qq',
			title: 'QQ',
			description: 'Forward personal QQ messages into the Ryan AI conversation pipeline.'
		}
	];

	const inputClass =
		'h-7 w-full rounded-lg border border-gray-100/50 bg-gray-50/40 px-2 text-xs text-gray-700 outline-hidden transition-colors placeholder:text-gray-300 focus:border-blue-400 dark:border-white/[0.04] dark:bg-white/[0.03] dark:text-gray-300 dark:placeholder:text-gray-700 dark:focus:border-blue-500';
	const secondaryButtonClass =
		'rounded-lg border border-gray-200/70 px-2.5 py-1.5 text-xs text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5';

	let servers: ToolServerConnection[] | null = null;
	let showConnectionModal = false;

	let terminalConnections: TerminalConnection[] = [];
	let showAddTerminalModal = false;
	let editTerminalIdx: number | null = null;

	let botConnections: BotGatewayConnection[] | null = null;
	let botLoadError = false;
	let botBusy: Record<string, boolean> = {};
	let userBotQuery = '';
	let adminBindings: BotGatewayBinding[] | null = null;
	let adminBindingsLoading = false;
	let adminBindingsLoadError = false;
	let bindingQuery = '';
	let bindingAction: { binding: BotGatewayBinding; action: 'block' | 'unblock' } | null = null;
	let showBindingActionConfirm = false;

	let showQQCredentialsModal = false;
	let qqAppId = '';
	let qqAppSecret = '';
	let qqCredentialsConnectionId: string | null = null;

	let showLoginModal = false;
	let loginChannel: BotGatewayChannel = 'wechat';
	let loginSession: BotGatewayLoginSession | null = null;
	let loginLoading = false;
	let loginPoll: ReturnType<typeof setInterval> | null = null;
	let loginPollInFlight = false;
	let loginGeneration = 0;
	let loginConnectionId: string | null = null;

	let showGroupsModal = false;
	let groupsConnection: BotGatewayConnection | null = null;
	let botGroups: BotGatewayGroup[] | null = null;
	let groupQuery = '';
	let groupsLoading = false;

	let showLogoutConfirm = false;
	let logoutConnection: BotGatewayConnection | null = null;
	let userBotSettings: BotGatewayAdminSettings | null = null;
	let botAudit: BotGatewayAuditRecord[] = [];
	let botPolicyBusy = false;
	let auditQuery = '';

	$: filteredAudit = botAudit.filter((record) =>
		`${record.action} ${record.channel ?? ''} ${record.user_id ?? ''} ${record.account_id ?? ''}`
			.toLocaleLowerCase()
			.includes(auditQuery.trim().toLocaleLowerCase())
	);

	$: filteredGroups = (botGroups ?? []).filter((group) =>
		`${group.name} ${group.id}`.toLocaleLowerCase().includes(groupQuery.trim().toLocaleLowerCase())
	);
	$: filteredBindings = (adminBindings ?? []).filter((binding) =>
		`${binding.display_name ?? ''} ${binding.user_name ?? ''} ${binding.user_username ?? ''} ${binding.user_email ?? ''} ${binding.external_user_id} ${binding.user_id} ${binding.channel}`
			.toLocaleLowerCase()
			.includes(bindingQuery.trim().toLocaleLowerCase())
	);
	$: userBotConnections = (botConnections ?? []).filter(
		(connection) => connection.owner_user_id && connection.credentials_configured
	);
	$: filteredUserBotConnections = userBotConnections.filter((connection) =>
		`${connection.owner_name ?? ''} ${connection.owner_username ?? ''} ${connection.owner_email ?? ''} ${connection.owner_user_id ?? ''} ${connection.account_name ?? ''} ${connection.account_id ?? ''} ${connection.channel}`
			.toLocaleLowerCase()
			.includes(userBotQuery.trim().toLocaleLowerCase())
	);
	$: if (!showLoginModal && (loginPoll || loginSession || loginLoading || loginConnectionId)) {
		resetLoginState();
	}
	$: if (!showQQCredentialsModal && (qqAppId || qqAppSecret || qqCredentialsConnectionId)) {
		clearQQCredentials();
	}

	const getConnection = (channel: BotGatewayChannel) =>
		botConnections?.find((connection) => connection.channel === channel) ?? null;

	const channelTitle = (channel: BotGatewayChannel) =>
		$i18n.t(channel === 'wechat' ? 'WeChat' : 'QQ');
	const auditActionTitle = (action?: string) =>
		$i18n.t(
			(
				{
					credentials_saved: 'Credentials saved',
					login_started: 'Login started',
					auto_bound: 'Automatically bound',
					logged_out: 'Logged out'
				} as Record<string, string>
			)[action ?? ''] ??
				action ??
				'—'
		);
	const loginSucceeded = (state?: string) =>
		['connected', 'confirmed', 'success'].includes(state ?? '');
	const loginFinished = (state?: string) =>
		loginSucceeded(state) ||
		['expired', 'error', 'failed', 'cancelled', 'logged_out', 'degraded', 'unavailable'].includes(
			state ?? ''
		);

	const statusLabel = (status?: string) => {
		switch (status) {
			case 'connected':
				return $i18n.t('Connected');
			case 'connecting':
			case 'pending':
			case 'awaiting_scan':
				return $i18n.t('Connecting');
			case 'error':
				return $i18n.t('Error');
			default:
				return $i18n.t('Disconnected');
		}
	};

	const statusClass = (status?: string) => {
		switch (status) {
			case 'connected':
				return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300';
			case 'connecting':
			case 'pending':
				return 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300';
			case 'error':
				return 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300';
			default:
				return 'bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-400';
		}
	};

	const setBusy = (key: string, value: boolean) => {
		botBusy = { ...botBusy, [key]: value };
	};

	const loadBotConnections = async (notify = false) => {
		try {
			botConnections = await getBotGatewayConnections(localStorage.token);
			botLoadError = false;
		} catch (error) {
			botConnections = [];
			botLoadError = true;
			if (notify) toast.error($i18n.t('Failed to load messaging bot connections.'));
		}
	};

	const loadAdminBindings = async (notify = false) => {
		if (adminBindingsLoading) return;
		adminBindingsLoading = true;
		try {
			adminBindings = await getAdminBotGatewayBindings(localStorage.token);
			adminBindingsLoadError = false;
		} catch (error) {
			adminBindings ??= [];
			adminBindingsLoadError = true;
			if (notify) {
				toast.error(
					error instanceof Error ? error.message : $i18n.t('Failed to load bot bindings.')
				);
			}
		} finally {
			adminBindingsLoading = false;
		}
	};

	const loadUserBotPolicy = async () => {
		try {
			[userBotSettings, botAudit] = await Promise.all([
				getBotGatewayAdminSettings(localStorage.token),
				getBotGatewayAuditRecords(localStorage.token)
			]);
		} catch (error) {
			if (botLoadError) return;
			toast.error(error instanceof Error ? error.message : $i18n.t('Failed to load bot policy.'));
		}
	};

	const updateUserBotPolicy = async (patch: Partial<BotGatewayAdminSettings>) => {
		if (!userBotSettings || botPolicyBusy) return;
		botPolicyBusy = true;
		try {
			userBotSettings = await updateBotGatewayAdminSettings(localStorage.token, patch);
			toast.success($i18n.t('Bot policy saved.'));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : $i18n.t('Failed to save bot policy.'));
		} finally {
			botPolicyBusy = false;
		}
	};

	const toggleBotConnection = async (connection: BotGatewayConnection, enabled: boolean) => {
		const key = `toggle:${connection.channel}`;
		if (botBusy[key]) return;
		setBusy(key, true);
		try {
			await updateBotGatewayConnection(localStorage.token, connection.id, { enabled });
			await loadBotConnections();
			toast.success(enabled ? $i18n.t('Bot enabled.') : $i18n.t('Bot disabled.'));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : $i18n.t('Failed to update bot.'));
		} finally {
			setBusy(key, false);
		}
	};

	function clearQQCredentials() {
		qqAppId = '';
		qqAppSecret = '';
		qqCredentialsConnectionId = null;
	}

	const openQQCredentials = (connection: BotGatewayConnection) => {
		clearQQCredentials();
		qqCredentialsConnectionId = connection.id;
		showQQCredentialsModal = true;
	};

	const saveQQCredentials = async () => {
		if (!qqCredentialsConnectionId || !qqAppId.trim() || !qqAppSecret) return;
		const connectionId = qqCredentialsConnectionId;

		setBusy('qq:credentials', true);
		try {
			await setQQBotCredentials(localStorage.token, connectionId, {
				app_id: qqAppId.trim(),
				app_secret: qqAppSecret
			});
			showQQCredentialsModal = false;
			clearQQCredentials();
			await loadBotConnections();
			toast.success($i18n.t('QQ credentials saved. The secret will not be shown again.'));
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : $i18n.t('Failed to save QQ credentials.')
			);
		} finally {
			qqAppSecret = '';
			setBusy('qq:credentials', false);
		}
	};

	function stopLoginPolling() {
		if (loginPoll) {
			clearInterval(loginPoll);
			loginPoll = null;
		}
	}

	function resetLoginState() {
		loginGeneration += 1;
		stopLoginPolling();
		loginPollInFlight = false;
		loginConnectionId = null;
		loginSession = null;
		loginLoading = false;
	}

	const pollLoginState = async () => {
		if (loginPollInFlight || !showLoginModal || !loginConnectionId) return;
		const generation = loginGeneration;
		const connectionId = loginConnectionId;
		loginPollInFlight = true;
		try {
			const session = await getBotGatewayLoginState(localStorage.token, connectionId);
			if (generation !== loginGeneration || !showLoginModal) return;
			loginSession = session;
			if (loginSucceeded(session.state)) {
				stopLoginPolling();
				await loadBotConnections();
				toast.success(
					$i18n.t('{{channel}} bot connected.', { channel: channelTitle(loginChannel) })
				);
			} else if (loginFinished(session.state)) {
				stopLoginPolling();
			}
		} catch {
			// A temporary polling failure should not discard the QR code already shown.
		} finally {
			if (generation === loginGeneration) loginPollInFlight = false;
		}
	};

	const openLogin = async (connection: BotGatewayConnection) => {
		resetLoginState();
		const generation = loginGeneration;
		loginChannel = connection.channel;
		loginConnectionId = connection.id;
		loginLoading = true;
		showLoginModal = true;
		// Poll immediately because the sidecar can expose the QR code before
		// the initial login request returns to the browser.
		loginPoll = setInterval(pollLoginState, 1000);
		try {
			const session = await beginBotGatewayLogin(localStorage.token, connection.id);
			if (generation !== loginGeneration || !showLoginModal) return;
			loginSession = session;
			if (loginSucceeded(session.state)) {
				stopLoginPolling();
				await loadBotConnections();
				toast.success(
					$i18n.t('{{channel}} bot connected.', { channel: channelTitle(connection.channel) })
				);
			} else if (loginFinished(session.state)) {
				stopLoginPolling();
			}
		} catch (error) {
			if (generation === loginGeneration) {
				if (!loginSession?.qr_code) {
					showLoginModal = false;
					stopLoginPolling();
					toast.error(
						error instanceof Error ? error.message : $i18n.t('Failed to start QR login.')
					);
				}
			}
		} finally {
			if (generation === loginGeneration) loginLoading = false;
		}
	};

	const reconnect = async (connection: BotGatewayConnection) => {
		const key = `reconnect:${connection.channel}`;
		setBusy(key, true);
		try {
			await reconnectBotGateway(localStorage.token, connection.id);
			await loadBotConnections();
			toast.success($i18n.t('Reconnect requested.'));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : $i18n.t('Failed to reconnect bot.'));
		} finally {
			setBusy(key, false);
		}
	};

	const requestLogout = (connection: BotGatewayConnection) => {
		logoutConnection = connection;
		showLogoutConfirm = true;
	};

	const confirmLogout = async () => {
		if (!logoutConnection) return;
		const connection = logoutConnection;
		setBusy(`logout:${connection.channel}`, true);
		try {
			await logoutBotGateway(localStorage.token, connection.id);
			await loadBotConnections();
			toast.success($i18n.t('Bot logged out.'));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : $i18n.t('Failed to log out bot.'));
		} finally {
			logoutConnection = null;
			setBusy(`logout:${connection.channel}`, false);
		}
	};

	const loadGroups = async (connection: BotGatewayConnection) => {
		groupsLoading = true;
		try {
			botGroups = await getBotGatewayGroups(localStorage.token, connection.id);
		} catch (error) {
			botGroups = [];
			toast.error(error instanceof Error ? error.message : $i18n.t('Failed to load groups.'));
		} finally {
			groupsLoading = false;
		}
	};

	const openGroups = async (connection: BotGatewayConnection) => {
		groupsConnection = connection;
		groupQuery = '';
		botGroups = null;
		showGroupsModal = true;
		await loadGroups(connection);
	};

	const discoverGroups = async () => {
		if (!groupsConnection) return;
		groupsLoading = true;
		try {
			botGroups = await discoverBotGatewayGroups(localStorage.token, groupsConnection.id);
			toast.success($i18n.t('Group discovery refreshed.'));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : $i18n.t('Failed to discover groups.'));
		} finally {
			groupsLoading = false;
		}
	};

	const toggleGroup = async (group: BotGatewayGroup, allowed: boolean) => {
		if (!groupsConnection) return;
		const key = `group:${group.id}`;
		setBusy(key, true);
		try {
			const updated = await updateBotGatewayGroup(
				localStorage.token,
				groupsConnection.id,
				group.id,
				{ allowed }
			);
			botGroups = (botGroups ?? []).map((item) => (item.id === group.id ? updated : item));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : $i18n.t('Failed to update group.'));
		} finally {
			setBusy(key, false);
		}
	};

	const requestBindingAction = (binding: BotGatewayBinding, action: 'block' | 'unblock') => {
		bindingAction = { binding, action };
		showBindingActionConfirm = true;
	};

	const confirmBindingAction = async () => {
		if (!bindingAction) return;
		const { binding, action } = bindingAction;
		const key = `binding:${binding.id}`;
		setBusy(key, true);
		try {
			if (action === 'block') {
				await blockAdminBotGatewayBinding(localStorage.token, binding.id);
				toast.success($i18n.t('Messaging identity blocked.'));
			} else {
				await unblockAdminBotGatewayBinding(localStorage.token, binding.id);
				toast.success($i18n.t('Messaging identity unblocked. The user must bind it again.'));
			}
			await loadAdminBindings();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : $i18n.t('Failed to update bot binding.')
			);
		} finally {
			bindingAction = null;
			setBusy(key, false);
		}
	};

	const addConnectionHandler = async (server: ToolServerConnection) => {
		servers = [...(servers ?? []), server];
		await updateHandler();
	};

	const updateHandler = async () => {
		const res = await setToolServerConnections(localStorage.token, {
			TOOL_SERVER_CONNECTIONS: servers
		}).catch(() => {
			toast.error($i18n.t('Failed to save connections'));
			return null;
		});

		if (res) toast.success($i18n.t('Connections saved successfully'));
	};

	const saveTerminalServers = async () => {
		const res = await setTerminalServerConnections(localStorage.token, {
			TERMINAL_SERVER_CONNECTIONS: terminalConnections
		}).catch(() => {
			toast.error($i18n.t('Failed to save terminal servers'));
			return null;
		});

		if (res) {
			toast.success($i18n.t('Terminal servers saved'));
			const existingDirectTerminals = (($terminalServers ?? []) as TerminalConnection[]).filter(
				(terminal) => !terminal.id
			);
			const systemTerminals = await getTerminalServers(localStorage.token);
			const systemEntries = systemTerminals.map((terminal) => ({
				id: terminal.id,
				url: `${WEBUI_API_BASE_URL}/terminals/${terminal.id}`,
				name: terminal.name,
				key: localStorage.token
			}));
			terminalServers.set([...existingDirectTerminals, ...systemEntries] as any);
		}
	};

	const addTerminalConnection = (server: TerminalConnection) => {
		terminalConnections = [
			...terminalConnections,
			{ ...server, id: server.id ?? crypto.randomUUID() }
		];
		saveTerminalServers();
	};

	const updateTerminalConnection = (idx: number, updated: TerminalConnection) => {
		terminalConnections = terminalConnections.map((connection, connectionIdx) =>
			connectionIdx === idx
				? { ...connection, ...updated, id: updated.id ?? connection.id }
				: connection
		);
		saveTerminalServers();
	};

	const removeTerminalConnection = (idx: number) => {
		terminalConnections = terminalConnections.filter((_, connectionIdx) => connectionIdx !== idx);
		saveTerminalServers();
	};

	onMount(async () => {
		const [toolResult, terminalResult] = await Promise.all([
			getToolServerConnections(localStorage.token).catch(() => null),
			getTerminalServerConnections(localStorage.token).catch(() => null),
			loadBotConnections(),
			loadAdminBindings(),
			loadUserBotPolicy()
		]);

		servers = (toolResult?.TOOL_SERVER_CONNECTIONS ?? []) as ToolServerConnection[];
		terminalConnections = (terminalResult?.TERMINAL_SERVER_CONNECTIONS ??
			[]) as TerminalConnection[];
	});

	onDestroy(() => {
		resetLoginState();
		clearQQCredentials();
	});
</script>

<AddToolServerModal bind:show={showConnectionModal} onSubmit={addConnectionHandler} />

<AddTerminalServerModal
	bind:show={showAddTerminalModal}
	edit={editTerminalIdx !== null}
	connection={editTerminalIdx !== null ? terminalConnections[editTerminalIdx] : null}
	onSubmit={(c: TerminalConnection) => {
		if (editTerminalIdx !== null) {
			updateTerminalConnection(editTerminalIdx, c);
			editTerminalIdx = null;
		} else {
			addTerminalConnection(c);
		}
	}}
	onDelete={() => {
		if (editTerminalIdx !== null) {
			removeTerminalConnection(editTerminalIdx);
			editTerminalIdx = null;
		}
	}}
/>

<Modal bind:show={showQQCredentialsModal} size="sm">
	<form class="flex flex-col gap-4 p-5" on:submit|preventDefault={saveQQCredentials}>
		<div>
			<h3 class="text-base font-medium text-gray-900 dark:text-white">
				{$i18n.t('Configure QQ bot')}
			</h3>
			<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
				{$i18n.t(
					'AppSecret is submitted once over the authenticated API and is never loaded back into this page.'
				)}
			</p>
		</div>

		<label class="flex flex-col gap-1.5 text-xs text-gray-600 dark:text-gray-300">
			<span>{$i18n.t('AppID')}</span>
			<input
				class={inputClass}
				type="text"
				name="qq-app-id"
				autocomplete="off"
				bind:value={qqAppId}
				placeholder={$i18n.t('Enter QQ Bot AppID')}
				required
			/>
		</label>

		<label class="flex flex-col gap-1.5 text-xs text-gray-600 dark:text-gray-300">
			<span>{$i18n.t('AppSecret')}</span>
			<SensitiveInput
				variant="settings"
				type="password"
				name="qq-app-secret"
				autocomplete="new-password"
				bind:value={qqAppSecret}
				placeholder={$i18n.t('Enter QQ Bot AppSecret')}
			/>
		</label>

		<div class="flex justify-end gap-2 pt-1">
			<button
				type="button"
				class={secondaryButtonClass}
				on:click={() => {
					showQQCredentialsModal = false;
					clearQQCredentials();
				}}
			>
				{$i18n.t('Cancel')}
			</button>
			<button
				type="submit"
				disabled={!qqAppId.trim() || !qqAppSecret || botBusy['qq:credentials']}
				class="rounded-full bg-gray-900 px-3.5 py-1.5 text-xs text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-black dark:hover:bg-gray-100"
			>
				{botBusy['qq:credentials'] ? $i18n.t('Saving…') : $i18n.t('Submit once')}
			</button>
		</div>
	</form>
</Modal>

<Modal bind:show={showLoginModal} size="sm">
	<div class="flex flex-col items-center gap-4 p-5 text-center">
		<div class="w-full text-left">
			<h3 class="text-base font-medium text-gray-900 dark:text-white">
				{$i18n.t('{{channel}} QR login', { channel: channelTitle(loginChannel) })}
			</h3>
			<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
				{$i18n.t('Scan with the matching personal account to connect this message gateway.')}
			</p>
		</div>

		{#if loginLoading}
			<div class="flex h-56 items-center justify-center">
				<Spinner className="size-6" />
			</div>
		{:else if loginSucceeded(loginSession?.state)}
			<div
				class="flex h-40 w-full items-center justify-center rounded-2xl bg-emerald-50 text-sm text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
			>
				{$i18n.t('Connected successfully.')}
			</div>
		{:else if loginSession?.qr_code}
			<div
				class="size-56 rounded-2xl border border-gray-100 bg-white p-3 shadow-sm dark:border-white/10"
			>
				<QRCode
					value={loginSession.qr_code}
					alt={$i18n.t('{{channel}} login QR code', { channel: channelTitle(loginChannel) })}
					size={208}
				/>
			</div>
		{:else}
			<div
				class="flex h-40 w-full items-center justify-center rounded-2xl bg-gray-50 px-6 text-sm text-gray-500 dark:bg-white/[0.03] dark:text-gray-400"
			>
				{loginSession?.message || $i18n.t('No QR code is available. Refresh to try again.')}
			</div>
		{/if}

		<div class="text-xs text-gray-500 dark:text-gray-400">
			{statusLabel(loginSession?.state)}
			{#if loginSession?.message}
				<span class="ml-1">· {loginSession.message}</span>
			{/if}
		</div>

		<div class="flex w-full justify-end gap-2">
			<button type="button" class={secondaryButtonClass} on:click={() => (showLoginModal = false)}>
				{$i18n.t('Close')}
			</button>
			<button
				type="button"
				class={secondaryButtonClass}
				disabled={loginLoading || !loginConnectionId}
				on:click={() => {
					const connection = botConnections?.find((item) => item.id === loginConnectionId);
					if (connection) openLogin(connection);
				}}
			>
				{$i18n.t('Refresh QR code')}
			</button>
		</div>
	</div>
</Modal>

<Modal bind:show={showGroupsModal} size="md">
	<div class="flex max-h-[75vh] flex-col p-5">
		<div class="flex items-start justify-between gap-4">
			<div>
				<h3 class="text-base font-medium text-gray-900 dark:text-white">
					{$i18n.t('{{channel}} group allowlist', {
						channel: channelTitle(groupsConnection?.channel ?? 'wechat')
					})}
				</h3>
				<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
					{$i18n.t('Only allowlisted groups can invoke Ryan AI by mentioning the bot.')}
				</p>
			</div>
			<button
				type="button"
				class={secondaryButtonClass}
				disabled={groupsLoading}
				on:click={discoverGroups}
			>
				{groupsLoading ? $i18n.t('Refreshing…') : $i18n.t('Discover groups')}
			</button>
		</div>

		<input
			class="mt-4 {inputClass}"
			type="search"
			bind:value={groupQuery}
			placeholder={$i18n.t('Search discovered groups')}
			aria-label={$i18n.t('Search discovered groups')}
		/>

		<div class="mt-3 min-h-32 flex-1 overflow-y-auto scrollbar-hover">
			{#if botGroups === null || groupsLoading}
				<div class="flex h-32 items-center justify-center">
					<Spinner className="size-5" />
				</div>
			{:else if filteredGroups.length > 0}
				<div class="flex flex-col divide-y divide-gray-100 dark:divide-white/5">
					{#each filteredGroups as group (group.id)}
						<div
							class="flex items-center justify-between gap-4 py-2.5 {botBusy[`group:${group.id}`]
								? 'opacity-50'
								: ''}"
						>
							<div class="min-w-0">
								<div class="truncate text-xs text-gray-700 dark:text-gray-300">{group.name}</div>
								<div class="truncate font-mono text-[0.6875rem] text-gray-400 dark:text-gray-600">
									{group.id}
									{#if group.member_count !== null}
										· {$i18n.t('{{count}} members', { count: group.member_count })}
									{/if}
								</div>
							</div>
							<Switch
								state={group.allowed}
								ariaLabel={$i18n.t('Allow {{group}}', { group: group.name })}
								on:change={(event: CustomEvent<boolean>) => toggleGroup(group, event.detail)}
							/>
						</div>
					{/each}
				</div>
			{:else}
				<div class="flex h-32 items-center justify-center text-xs text-gray-400 dark:text-gray-600">
					{groupQuery
						? $i18n.t('No groups match your search.')
						: $i18n.t('No groups discovered yet.')}
				</div>
			{/if}
		</div>

		<div class="flex justify-end pt-4">
			<button type="button" class={secondaryButtonClass} on:click={() => (showGroupsModal = false)}>
				{$i18n.t('Done')}
			</button>
		</div>
	</div>
</Modal>

<ConfirmDialog
	bind:show={showLogoutConfirm}
	title={$i18n.t('Log out messaging bot?')}
	message={$i18n.t(
		'The saved channel session will be removed and the bot will stop receiving messages.'
	)}
	confirmLabel={$i18n.t('Log out')}
	on:confirm={confirmLogout}
/>

<ConfirmDialog
	bind:show={showBindingActionConfirm}
	title={bindingAction?.action === 'unblock'
		? $i18n.t('Unblock messaging identity?')
		: $i18n.t('Block messaging identity?')}
	message={bindingAction?.action === 'unblock'
		? $i18n.t('The identity may bind again, but its previous binding will not be restored.')
		: $i18n.t(
				'This identity will immediately lose access and cannot bind again until an administrator unblocks it.'
			)}
	confirmLabel={bindingAction?.action === 'unblock' ? $i18n.t('Unblock') : $i18n.t('Block')}
	on:confirm={confirmBindingAction}
/>

<form
	class="flex h-full flex-col justify-between text-sm"
	on:submit|preventDefault={() => {
		updateHandler();
	}}
>
	<h2 class="text-sm font-medium text-gray-900 dark:text-white mb-4">{$i18n.t('Integrations')}</h2>

	<div class="flex-1 min-h-0 overflow-y-auto scrollbar-hover pr-1.5">
		{#if servers !== null}
			<AdminSettingSection title={$i18n.t('Messaging bots')} first>
				<div class="flex flex-col gap-2.5">
					<div class="text-[0.6875rem] text-gray-400 dark:text-gray-600">
						{$i18n.t(
							'Configure policy for user-owned personal WeChat and QQ bots. Credentials and sessions belong to each user.'
						)}
					</div>

					{#if userBotSettings}
						<div
							class="rounded-xl border border-gray-100/80 bg-gray-50/30 p-3 dark:border-white/[0.06] dark:bg-white/[0.02]"
						>
							<div class="flex items-center justify-between gap-3">
								<div>
									<div class="text-xs font-medium text-gray-700 dark:text-gray-300">
										{$i18n.t('Enable messaging bots')}
									</div>
									<div class="mt-0.5 text-[0.6875rem] text-gray-400 dark:text-gray-600">
										{$i18n.t('Allow users to connect and use their own bot accounts.')}
									</div>
								</div>
								<Switch
									state={userBotSettings.enabled}
									ariaLabel={$i18n.t('Enable messaging bots')}
									on:change={(event: CustomEvent<boolean>) =>
										updateUserBotPolicy({ enabled: event.detail })}
								/>
							</div>
							<div class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
								<div
									class="flex items-center justify-between rounded-lg border border-gray-100/70 px-2.5 py-2 dark:border-white/[0.06]"
								>
									<span class="text-xs text-gray-600 dark:text-gray-400">{$i18n.t('QQ')}</span
									><Switch
										state={userBotSettings.qq_enabled}
										ariaLabel={$i18n.t('Enable QQ')}
										on:change={(event: CustomEvent<boolean>) =>
											updateUserBotPolicy({ qq_enabled: event.detail })}
									/>
								</div>
								<div
									class="flex items-center justify-between rounded-lg border border-gray-100/70 px-2.5 py-2 dark:border-white/[0.06]"
								>
									<span class="text-xs text-gray-600 dark:text-gray-400">{$i18n.t('WeChat')}</span
									><Switch
										state={userBotSettings.wechat_enabled}
										ariaLabel={$i18n.t('Enable WeChat')}
										on:change={(event: CustomEvent<boolean>) =>
											updateUserBotPolicy({ wechat_enabled: event.detail })}
									/>
								</div>
							</div>
							<label class="mt-3 block text-xs text-gray-600 dark:text-gray-400"
								>{$i18n.t('Recommended bot model')}
								<select
									class={inputClass}
									value={userBotSettings.recommended_model_id ?? ''}
									on:change={(event) =>
										updateUserBotPolicy({
											recommended_model_id: (event.currentTarget as HTMLSelectElement).value || null
										})}
								>
									<option value="">{$i18n.t('No recommendation')}</option>
									{#each $models ?? [] as model}<option value={model.id}
											>{model.name || model.id}</option
										>{/each}
								</select>
							</label>
						</div>
					{:else if !botLoadError}
						<div class="flex h-16 items-center justify-center"><Spinner className="size-5" /></div>
					{/if}

					<div class="hidden">
						{#if botConnections === null}
							<div class="flex h-24 items-center justify-center">
								<Spinner className="size-5" />
							</div>
						{:else}
							{#if botLoadError}
								<div
									class="flex items-center justify-between gap-3 rounded-xl border border-amber-200/70 bg-amber-50/60 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300"
								>
									<span>{$i18n.t('Bot Gateway API is unavailable.')}</span>
									<button
										type="button"
										class="underline underline-offset-2"
										on:click={() => loadBotConnections(true)}
									>
										{$i18n.t('Retry')}
									</button>
								</div>
							{/if}

							<div class="grid grid-cols-1 gap-2.5 xl:grid-cols-2">
								{#each botChannels as definition (definition.channel)}
									{@const connection = getConnection(definition.channel)}
									<div
										class="rounded-xl border border-gray-100/80 bg-gray-50/30 p-3 dark:border-white/[0.06] dark:bg-white/[0.02]"
									>
										<div class="flex items-start justify-between gap-3">
											<div class="flex min-w-0 items-center gap-2.5">
												<div
													class="flex size-8 shrink-0 items-center justify-center rounded-xl {definition.channel ===
													'wechat'
														? 'bg-emerald-500 text-white'
														: 'bg-blue-500 text-white'} text-sm font-semibold"
												>
													{definition.channel === 'wechat' ? '微' : 'Q'}
												</div>
												<div class="min-w-0">
													<div class="flex items-center gap-1.5">
														<div
															class="truncate text-xs font-medium text-gray-800 dark:text-gray-200"
														>
															{$i18n.t(definition.title)}
														</div>
														<span
															class="rounded-full px-1.5 py-0.5 text-[0.625rem] {statusClass(
																connection?.status
															)}"
														>
															{statusLabel(connection?.status)}
														</span>
													</div>
													<div class="truncate text-[0.6875rem] text-gray-400 dark:text-gray-600">
														{connection?.account_name ||
															connection?.account_id ||
															$i18n.t('No account connected')}
													</div>
												</div>
											</div>

											{#if connection}
												<div class={botBusy[`toggle:${definition.channel}`] ? 'opacity-50' : ''}>
													<Switch
														state={connection.enabled}
														ariaLabel={$i18n.t('Enable {{channel}} bot', {
															channel: $i18n.t(definition.title)
														})}
														on:change={(event: CustomEvent<boolean>) =>
															toggleBotConnection(connection, event.detail)}
													/>
												</div>
											{/if}
										</div>

										<p
											class="mt-2 text-[0.6875rem] leading-relaxed text-gray-400 dark:text-gray-600"
										>
											{$i18n.t(definition.description)}
										</p>

										{#if definition.channel === 'qq'}
											<div class="mt-2 text-[0.6875rem] text-gray-500 dark:text-gray-500">
												{connection?.credentials_configured
													? $i18n.t('App credentials configured')
													: $i18n.t('App credentials required')}
											</div>
										{/if}

										{#if connection?.last_error}
											<div
												class="mt-2 line-clamp-2 rounded-lg bg-red-50 px-2 py-1.5 text-[0.6875rem] text-red-600 dark:bg-red-950/20 dark:text-red-300"
											>
												{connection.last_error}
											</div>
										{/if}

										<div class="mt-3 flex flex-wrap gap-1.5">
											{#if definition.channel === 'qq'}
												<button
													type="button"
													class={secondaryButtonClass}
													disabled={!connection}
													on:click={() => connection && openQQCredentials(connection)}
												>
													{connection?.credentials_configured
														? $i18n.t('Replace credentials')
														: $i18n.t('Configure credentials')}
												</button>
											{/if}

											<button
												type="button"
												class={secondaryButtonClass}
												disabled={!connection}
												on:click={() => connection && openLogin(connection)}
											>
												{connection?.status === 'connected'
													? $i18n.t('Log in again')
													: $i18n.t('QR login')}
											</button>

											<button
												type="button"
												class={secondaryButtonClass}
												disabled={!connection || botBusy[`reconnect:${definition.channel}`]}
												on:click={() => connection && reconnect(connection)}
											>
												{$i18n.t('Reconnect')}
											</button>

											<button
												type="button"
												class={secondaryButtonClass}
												disabled={!connection}
												on:click={() => connection && openGroups(connection)}
											>
												{$i18n.t('Group allowlist')}
											</button>

											<button
												type="button"
												class="{secondaryButtonClass} hover:border-red-200 hover:text-red-600 dark:hover:border-red-900 dark:hover:text-red-300"
												disabled={!connection || botBusy[`logout:${definition.channel}`]}
												on:click={() => connection && requestLogout(connection)}
											>
												{$i18n.t('Log out')}
											</button>
										</div>
									</div>
								{/each}
							</div>
						{/if}
					</div>

					<div class="mt-1 border-t border-gray-100/80 pt-3 dark:border-white/[0.06]">
						<div class="flex items-center justify-between gap-3">
							<div>
								<div class="text-xs font-medium text-gray-700 dark:text-gray-300">
									{$i18n.t('User bot connections')}
								</div>
								<div class="mt-0.5 text-[0.6875rem] text-gray-400 dark:text-gray-600">
									{$i18n.t(
										'Bot accounts appear here as soon as a user saves credentials or completes login.'
									)}
								</div>
							</div>
							<button
								type="button"
								class={secondaryButtonClass}
								on:click={() => loadBotConnections(true)}
							>
								{$i18n.t('Refresh')}
							</button>
						</div>

						<input
							class="mt-3 {inputClass}"
							type="search"
							bind:value={userBotQuery}
							placeholder={$i18n.t('Search by user or bot account')}
							aria-label={$i18n.t('Search user bot connections')}
						/>

						{#if botConnections === null}
							<div class="flex h-20 items-center justify-center">
								<Spinner className="size-5" />
							</div>
						{:else if filteredUserBotConnections.length > 0}
							<div
								class="mt-2 max-h-56 overflow-y-auto rounded-xl border border-gray-100/80 px-3 scrollbar-hover dark:border-white/[0.06]"
							>
								{#each filteredUserBotConnections as connection (connection.id)}
									<div
										class="flex items-center justify-between gap-3 border-b border-gray-100 py-2.5 last:border-b-0 dark:border-white/[0.05]"
									>
										<div class="min-w-0">
											<div class="truncate text-xs text-gray-700 dark:text-gray-300">
												{connection.owner_name ||
													connection.owner_username ||
													connection.owner_email ||
													connection.owner_user_id}
											</div>
											<div class="truncate text-[0.6875rem] text-gray-400 dark:text-gray-600">
												{#if connection.owner_username || connection.owner_email}
													{connection.owner_username || connection.owner_email} ·
												{/if}
												{channelTitle(connection.channel)} · {connection.account_name ||
													connection.account_id ||
													$i18n.t('Account pending')}
											</div>
										</div>
										<div class="flex shrink-0 items-center gap-1.5">
											<span
												class="rounded-full bg-blue-50 px-1.5 py-0.5 text-[0.625rem] text-blue-700 dark:bg-blue-950/30 dark:text-blue-300"
											>
												{$i18n.t('Bound')}
											</span>
											<span
												class="rounded-full px-1.5 py-0.5 text-[0.625rem] {statusClass(
													connection.status
												)}"
											>
												{statusLabel(connection.status)}
											</span>
										</div>
									</div>
								{/each}
							</div>
						{:else}
							<div class="py-4 text-xs text-gray-400 dark:text-gray-600">
								{userBotQuery
									? $i18n.t('No user bot connections match your search.')
									: $i18n.t('No user bot connections found.')}
							</div>
						{/if}
					</div>

					<div class="mt-1 border-t border-gray-100/80 pt-3 dark:border-white/[0.06]">
						<div class="flex items-center justify-between gap-3">
							<div>
								<div class="text-xs font-medium text-gray-700 dark:text-gray-300">
									{$i18n.t('User bindings')}
								</div>
								<div class="mt-0.5 text-[0.6875rem] text-gray-400 dark:text-gray-600">
									{$i18n.t('Review, block, or unblock external messaging identities.')}
								</div>
							</div>
							<button
								type="button"
								class={secondaryButtonClass}
								disabled={adminBindingsLoading}
								on:click={() => loadAdminBindings(true)}
							>
								{adminBindingsLoading ? $i18n.t('Refreshing…') : $i18n.t('Refresh')}
							</button>
						</div>

						<input
							class="mt-3 {inputClass}"
							type="search"
							bind:value={bindingQuery}
							placeholder={$i18n.t('Search by account or Ryan AI user ID')}
							aria-label={$i18n.t('Search bot bindings')}
						/>

						{#if adminBindingsLoadError}
							<div
								class="mt-2 rounded-lg border border-amber-200/70 bg-amber-50/60 px-3 py-2 text-[0.6875rem] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300"
							>
								{$i18n.t('Bot bindings could not be loaded. Retry when the gateway is enabled.')}
							</div>
						{/if}

						{#if adminBindings === null}
							<div class="flex h-20 items-center justify-center">
								<Spinner className="size-5" />
							</div>
						{:else if filteredBindings.length > 0}
							<div
								class="mt-2 max-h-56 overflow-y-auto rounded-xl border border-gray-100/80 px-3 scrollbar-hover dark:border-white/[0.06]"
							>
								{#each filteredBindings as binding (binding.id)}
									<div
										class="flex items-center justify-between gap-3 border-b border-gray-100 py-2.5 last:border-b-0 dark:border-white/[0.05]"
									>
										<div class="min-w-0">
											<div class="flex items-center gap-1.5">
												<div class="truncate text-xs text-gray-700 dark:text-gray-300">
													{binding.user_name ||
														binding.user_username ||
														binding.user_email ||
														binding.user_id}
												</div>
												<span
													class="rounded-full px-1.5 py-0.5 text-[0.625rem] {binding.blocked
														? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
														: binding.enabled
															? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
															: 'bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-400'}"
												>
													{binding.blocked
														? $i18n.t('Blocked')
														: binding.enabled
															? $i18n.t('Active')
															: $i18n.t('Inactive')}
												</span>
											</div>
											<div
												class="truncate font-mono text-[0.6875rem] text-gray-400 dark:text-gray-600"
											>
												{#if binding.user_username || binding.user_email}
													{$i18n.t('Ryan AI account')}: {binding.user_username ||
														binding.user_email} · {$i18n.t('Nickname')}: {binding.user_name ||
														'—'}<br />
												{/if}
												{channelTitle(binding.channel)} · {binding.external_user_id} · {$i18n.t(
													'User ID'
												)}: {binding.user_id}
											</div>
										</div>
										<button
											type="button"
											class="shrink-0 text-xs {binding.blocked
												? 'text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300'
												: 'text-gray-500 hover:text-red-600 dark:text-gray-500 dark:hover:text-red-300'}"
											disabled={botBusy[`binding:${binding.id}`]}
											on:click={() =>
												requestBindingAction(binding, binding.blocked ? 'unblock' : 'block')}
										>
											{binding.blocked ? $i18n.t('Unblock') : $i18n.t('Block')}
										</button>
									</div>
								{/each}
							</div>
						{:else}
							<div class="py-4 text-xs text-gray-400 dark:text-gray-600">
								{bindingQuery
									? $i18n.t('No bot bindings match your search.')
									: $i18n.t('No bot bindings found.')}
							</div>
						{/if}
					</div>
				</div>
			</AdminSettingSection>

			<AdminSettingSection title={$i18n.t('Binding audit history')}>
				<div class="flex items-center justify-between gap-3">
					<div class="text-[0.6875rem] text-gray-400 dark:text-gray-600">
						{$i18n.t('Review user-owned bot connection and binding events.')}
					</div>
					<button type="button" class={secondaryButtonClass} on:click={loadUserBotPolicy}
						>{$i18n.t('Refresh')}</button
					>
				</div>
				<input
					class="mt-2 {inputClass}"
					type="search"
					bind:value={auditQuery}
					placeholder={$i18n.t('Search audit history')}
				/>
				<div
					class="mt-2 max-h-48 overflow-y-auto rounded-xl border border-gray-100/80 px-3 dark:border-white/[0.06]"
				>
					{#each filteredAudit as record (record.id)}
						<div
							class="border-b border-gray-100 py-2 text-[0.6875rem] last:border-b-0 dark:border-white/[0.05]"
						>
							<div class="flex justify-between gap-2">
								<span class="font-medium text-gray-700 dark:text-gray-300"
									>{auditActionTitle(record.action)}</span
								><span class="text-gray-400"
									>{record.channel ? channelTitle(record.channel) : '—'}</span
								>
							</div>
							<div class="mt-0.5 font-mono text-gray-400 dark:text-gray-600">
								{record.user_id ?? '—'} · {record.account_id ?? '—'}
							</div>
						</div>
					{:else}<div class="py-4 text-xs text-gray-400 dark:text-gray-600">
							{$i18n.t('No audit records found.')}
						</div>{/each}
				</div>
			</AdminSettingSection>

			<AdminSettingSection title={$i18n.t('Tools')}>
				<div>
					<div class="mb-2 flex items-center justify-between">
						<div class="text-xs text-gray-600 dark:text-gray-400">
							{$i18n.t('External Tool Servers')}
						</div>

						<Tooltip content={$i18n.t(`Add Connection`)}>
							<button
								class="flex size-6 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-black/5 hover:text-gray-900 dark:text-gray-600 dark:hover:bg-white/5 dark:hover:text-white"
								on:click={() => {
									showConnectionModal = true;
								}}
								type="button"
							>
								<Plus />
							</button>
						</Tooltip>
					</div>

					<div class="flex flex-col gap-1">
						{#each servers ?? [] as server, idx}
							<Connection
								bind:connection={server}
								onSubmit={() => {
									updateHandler();
								}}
								onDelete={() => {
									servers = (servers ?? []).filter((_, i) => i !== idx);
									updateHandler();
								}}
							/>
						{/each}
					</div>

					{#if (servers ?? []).length === 0}
						<div class="text-[0.6875rem] text-gray-400 dark:text-gray-600">
							{$i18n.t('No tool server connections configured.')}
						</div>
					{/if}

					<div class="mt-1 text-[0.6875rem] text-gray-400 dark:text-gray-600">
						{$i18n.t('Connect to your own OpenAPI compatible external tool servers.')}
					</div>
				</div>
			</AdminSettingSection>

			<AdminSettingSection title={$i18n.t('Terminal')}>
				<div>
					<div class="mb-2 flex items-center justify-between">
						<div class="text-xs text-gray-600 dark:text-gray-400">{$i18n.t('Open Terminal')}</div>

						<Tooltip content={$i18n.t('Add Connection')}>
							<button
								class="flex size-6 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-black/5 hover:text-gray-900 dark:text-gray-600 dark:hover:bg-white/5 dark:hover:text-white"
								on:click={() => {
									editTerminalIdx = null;
									showAddTerminalModal = true;
								}}
								type="button"
							>
								<Plus />
							</button>
						</Tooltip>
					</div>

					<div class="flex flex-col gap-1.5">
						{#each terminalConnections as connection, idx}
							<div class="flex w-full gap-2 items-center">
								<Tooltip className="w-full relative" content={''} placement="top-start">
									<div class="flex w-full">
										<div
											class="flex-1 relative flex gap-1.5 items-center {connection?.enabled ===
											false
												? 'opacity-50'
												: ''}"
										>
											<Tooltip content={$i18n.t('Terminal')}>
												<Cloud className="size-4" strokeWidth="1.5" />
											</Tooltip>

											<div
												class="outline-hidden w-full bg-transparent text-xs text-gray-700 dark:text-gray-300"
											>
												{connection.name || connection.url || $i18n.t('New Terminal')}
											</div>
										</div>
									</div>
								</Tooltip>

								<div class="flex gap-1 items-center">
									<Tooltip content={$i18n.t('Configure')}>
										<button
											class="self-center p-1 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 rounded-lg transition"
											on:click={() => {
												editTerminalIdx = idx;
												showAddTerminalModal = true;
											}}
											type="button"
										>
											<Cog6 />
										</button>
									</Tooltip>

									<Tooltip
										content={connection?.enabled !== false
											? $i18n.t('Enabled')
											: $i18n.t('Disabled')}
									>
										<Switch
											state={connection?.enabled !== false}
											on:change={() => {
												terminalConnections = terminalConnections.map((c, i) =>
													i === idx ? { ...c, enabled: !(c?.enabled !== false) } : c
												);
												saveTerminalServers();
											}}
										/>
									</Tooltip>
								</div>
							</div>
						{/each}
					</div>

					{#if terminalConnections.length === 0}
						<div class="text-[0.6875rem] text-gray-400 dark:text-gray-600">
							{$i18n.t('No terminal connections configured.')}
						</div>
					{/if}

					<div class="mt-1 text-[0.6875rem] text-gray-400 dark:text-gray-600">
						{$i18n.t(
							'Connect to Open Terminal instances. Admins and users granted access can use file browsing and terminal tools through these servers.'
						)}
					</div>
					<a
						class="mt-0.5 block text-[0.6875rem] text-gray-500 underline hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-300"
						href="https://github.com/open-webui/open-terminal"
						target="_blank">{$i18n.t('Learn more about Open Terminal')} ↗</a
					>
				</div>
			</AdminSettingSection>

			<AdminSettingSection title={$i18n.t('Knowledge')}>
				<ExternalKnowledge />
			</AdminSettingSection>
		{:else}
			<div class="flex h-full justify-center">
				<div class="my-auto">
					<Spinner className="size-6" />
				</div>
			</div>
		{/if}
	</div>

	<div class="flex justify-end pt-6 text-sm font-normal">
		<button
			class="px-3.5 py-1.5 text-sm font-normal bg-black hover:bg-gray-900 text-white dark:bg-white dark:text-black dark:hover:bg-gray-100 transition rounded-full"
			type="submit"
		>
			{$i18n.t('Save')}
		</button>
	</div>
</form>
