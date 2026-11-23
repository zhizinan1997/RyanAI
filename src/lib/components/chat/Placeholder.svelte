<script lang="ts">
	import type { TerminalContext } from '$lib/types';
	import type { Writable } from 'svelte/store';
	import { toast } from 'svelte-sonner';
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';

	import { onMount, getContext, tick, createEventDispatcher } from 'svelte';
	import { blur, fade } from 'svelte/transition';

	const dispatch = createEventDispatcher();

	import { updateFolderById } from '$lib/apis/folders';

	import { config, user, selectedFolder } from '$lib/stores';
	import { sanitizeResponseContent, extractCurlyBraceWords } from '$lib/utils';
	import {
		resolveLocalizedModelDescription,
		resolveLocalizedModelName,
		resolveLocalizedModelPromptSuggestions,
		resolveLocalizedPromptSuggestions
	} from '$lib/utils/localizedContent';
	import { WEBUI_API_BASE_URL, WEBUI_BASE_URL } from '$lib/constants';

	import Suggestions from './Suggestions.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import EyeSlash from '$lib/components/icons/EyeSlash.svelte';
	import MessageInput from './MessageInput.svelte';
	import FolderPlaceholder from './Placeholder/FolderPlaceholder.svelte';
	import { getChatContext } from '$lib/components/chat/context';

	const { models: _models, temporary } = getChatContext();

	const i18n: any = getContext('i18n');

	export let createMessagePair: Function;
	export let stopResponse: Function;

	export let autoScroll = false;
	export let callActive = false;
	export let callEnabled = true;

	export let atSelectedModel: Model | undefined;
	export let selectedModels: [''];
	export let onModelSelect: (models: string[]) => void = () => {};
	export let chatFiles: any[] = [];
	export let params: Record<string, any> = {};
	export let onParamChange: (key: string, value: unknown) => void = () => {};

	export let history;
	export let chatId = '';
	export let folderTabActions: import('svelte').Snippet | undefined = undefined;

	export let prompt = '';
	export let files = [];
	export let terminalContext: TerminalContext | null = null;
	export let selectedTerminalId: Pick<Writable<string | null>, 'subscribe' | 'set'>;
	export let terminalSkills: Writable<any[]>;
	export let messageInput = null;

	export let selectedToolIds = [];
	export let selectedSkillIds = [];
	export let selectedFilterIds = [];
	export let pendingOAuthTools = [];

	export let showCommands = false;

	export let imageGenerationEnabled = false;
	export let selectedImageModelId = '';
	export let videoGenerationEnabled = false;
	export let selectedVideoModelId = '';
	export let codeInterpreterEnabled = false;
	export let webSearchEnabled = false;
	export let toolApprovalMode = 'full';
	export let onToolApprovalModeChange: Function = () => {};
	export let oauthRedirectHandler: Function = () => {};

	export let onUpload: Function = (e) => {};
	export let onUpdate: (data?: { file?: any }) => void = () => {};
	export let onSelect = (e) => {};
	export let onTemporaryChange: ((value: boolean) => void) | null = null;
	export let onChange = (e) => {};
	export let onWebSearchToggle: Function = () => {};
	export let messageQueue: { id: string; prompt: string; files: any[] }[] = [];
	export let onQueueSendNow: (id: string) => void = () => {};
	export let onQueueEdit: (id: string) => void = () => {};
	export let onQueueDelete: (id: string) => void = () => {};
	export let askUser = {
		show: false,
		questions: [],
		allowOther: true,
		timeoutMs: null,
		onConfirm: (_value: any) => {},
		onCancel: () => {}
	};

	export let dragged = false;

	// Height of the floating folder composer, so lists can scroll clear of it.
	let composerHeight = 0;
	// The composer only belongs with the folder's chats, not its automations.
	let folderSection: 'chats' | 'automations' | 'knowledge' = 'chats';

	let models = [];
	export let selectedModelIdx = 0;
	let selectedModel;
	let selectedModelName = '';
	let selectedModelDescription = '';
	let selectedSuggestionPrompts = [];

	$: models = selectedModels.map((id) => $_models.find((m) => m.id === id));
	$: selectedModel = atSelectedModel ?? models[selectedModelIdx];
	$: selectedModelName = resolveLocalizedModelName(selectedModel, $i18n.language);
	$: selectedModelDescription =
		$config?.license_metadata?.chat_placeholder_description ||
		resolveLocalizedModelDescription(selectedModel, $i18n.language);
	$: selectedSuggestionPrompts =
		resolveLocalizedModelPromptSuggestions(atSelectedModel, $i18n.language) ??
		resolveLocalizedModelPromptSuggestions(models[selectedModelIdx], $i18n.language) ??
		resolveLocalizedPromptSuggestions(
			$config?.default_prompt_suggestions,
			$config?.default_prompt_suggestions_i18n ?? {},
			$i18n.language,
			(key) => $i18n.t(key)
		);

	// True when viewing a shared folder the current user doesn't own AND lacks write access
	$: folderReadOnly =
		$selectedFolder != null &&
		$user?.role !== 'admin' &&
		$selectedFolder.user_id !== $user?.id &&
		!$selectedFolder.write_access;
</script>

{#snippet composer(placeholder = '')}
	<MessageInput
		{selectedTerminalId}
		{terminalSkills}
		{chatId}
		{onTemporaryChange}
		bind:terminalContext
		{callActive}
		{callEnabled}
		bind:this={messageInput}
		{history}
		bind:selectedModels
		{onModelSelect}
		bind:chatFiles
		bind:params
		{onParamChange}
		bind:files
		bind:prompt
		bind:autoScroll
		bind:selectedToolIds
		bind:selectedSkillIds
		bind:selectedFilterIds
		bind:imageGenerationEnabled
		bind:selectedImageModelId
		bind:videoGenerationEnabled
		bind:selectedVideoModelId
		bind:codeInterpreterEnabled
		bind:webSearchEnabled
		bind:atSelectedModel
		bind:showCommands
		bind:dragged
		{pendingOAuthTools}
		{oauthRedirectHandler}
		{toolApprovalMode}
		{onToolApprovalModeChange}
		{stopResponse}
		{createMessagePair}
		{placeholder}
		{onChange}
		{onUpload}
		{onUpdate}
		{messageQueue}
		{onQueueSendNow}
		{onQueueEdit}
		{onQueueDelete}
		{askUser}
		{onWebSearchToggle}
		on:chatVariables
		on:submit={(e) => {
			dispatch('submit', e.detail);
		}}
	/>
{/snippet}

<div
	class="placeholder-root relative isolate w-full {$selectedFolder
		? 'flex h-full min-h-0 flex-col overflow-hidden'
		: 'm-auto max-w-[58rem] px-1 md:@3xl:px-20 translate-y-6 py-24'} text-center"
>
	{#if !$selectedFolder}
		<div class="zero-state-glow" aria-hidden="true"></div>
	{/if}

	<!-- In a folder, temporary mode shows on the composer alone. -->
	{#if $temporary && !$selectedFolder}
		<Tooltip
			content={$i18n.t("This chat won't appear in history and your messages will not be saved.")}
			className="w-full flex justify-center mb-0.5"
			placement="top"
		>
			<div class="flex items-center gap-1.5 text-gray-500 text-xs my-1 w-fit">
				<EyeSlash strokeWidth="2" className="size-3.5" />{$i18n.t('Temporary Chat')}
			</div>
		</Tooltip>
	{/if}

	{#if $selectedFolder}
		<div
			class="relative min-h-0 w-full flex-1"
			style="--folder-composer-space: {folderReadOnly || folderSection !== 'chats'
				? 0
				: composerHeight}px"
		>
			<FolderPlaceholder
				folder={$selectedFolder}
				readOnly={folderReadOnly}
				bind:folderTabActions
				bind:folderSection
				onNewChat={() => messageInput?.focus()}
			/>

			{#if !folderReadOnly}
				<!-- Same mount as the in-chat composer, floating over the list and board. -->
				<div
					class="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-white from-40% to-transparent pt-8 pb-2 text-left dark:from-gray-900 {dragged
						? 'z-0'
						: 'z-10'}"
					class:hidden={folderSection !== 'chats'}
					bind:clientHeight={composerHeight}
				>
					<div class="pointer-events-auto">
						{@render composer()}
					</div>
				</div>
			{/if}
		</div>
	{:else}
		<div
			class="w-full shrink-0 text-3xl text-gray-800 dark:text-gray-100 text-center flex items-center gap-4"
		>
			<div class="w-full flex flex-col justify-center items-center">
				<div class="flex flex-row justify-center gap-2.5 @sm:gap-3 w-fit px-5 max-w-xl">
					<div class="flex shrink-0 justify-center">
						<div class="flex -space-x-4 mb-0.5" in:fade={{ duration: 100 }}>
							{#each models as model, modelIdx}
								<Tooltip
									content={(models[modelIdx]?.info?.meta?.tags ?? [])
										.map((tag) => tag.name.toUpperCase())
										.join(', ')}
									placement="top"
								>
									<button
										aria-hidden={models.length <= 1}
										tabindex={models.length > 1 ? 0 : -1}
										aria-label={$i18n.t('Get information on {{name}} in the UI', {
											name: models[modelIdx]?.name
										})}
										on:click={() => {
											selectedModelIdx = modelIdx;
										}}
									>
										<img
											src={`${WEBUI_API_BASE_URL}/models/model/profile/image?id=${model?.id}&lang=${$i18n.language}`}
											class=" size-9 @sm:size-10 rounded-2xl"
											aria-hidden="true"
											draggable="false"
											on:error={(e) => {
												// LICENSE covers this Open WebUI fallback logo.
												// Do not alter, remove, obscure, or replace it except as LICENSE permits:
												// https://docs.openwebui.com/license.
												e.currentTarget.src = '/favicon.png';
											}}
										/>
									</button>
								</Tooltip>
							{/each}
						</div>
					</div>

					<h2
						class=" text-2xl @sm:text-2xl line-clamp-1 flex items-center"
						in:fade={{ duration: 100 }}
					>
						{#if selectedModelName}
							<Tooltip
								as="span"
								content={selectedModelName}
								placement="top"
								className=" flex items-center "
							>
								<span class="line-clamp-1">
									{selectedModelName}
								</span>
							</Tooltip>
						{:else}
							{$i18n.t('Hello, {{name}}', { name: $user?.name })}
						{/if}
					</h2>
				</div>

				<div class="flex mt-1 mb-2">
					<div in:fade={{ duration: 100, delay: 50 }}>
						{#if selectedModelDescription}
							<Tooltip
								className=" w-fit"
								content={DOMPurify.sanitize(
									marked.parse(
										sanitizeResponseContent(selectedModelDescription).replaceAll('\n', '<br>')
									)
								)}
								allowHTML={true}
								placement="top"
							>
								<div
									class="mt-0.5 px-2 text-sm font-normal text-gray-500 dark:text-gray-400 line-clamp-2 max-w-xl markdown"
								>
									{@html DOMPurify.sanitize(
										marked.parse(
											sanitizeResponseContent(selectedModelDescription).replaceAll('\n', '<br>')
										)
									)}
								</div>
							</Tooltip>

							{#if models[selectedModelIdx]?.info?.meta?.user && (!models[selectedModelIdx]?.info?.meta?.user.community || $config?.features.enable_community_sharing)}
								<div class="mt-0.5 text-sm font-normal text-gray-400 dark:text-gray-500">
									{$i18n.t('By')}
									{#if models[selectedModelIdx]?.info?.meta?.user.community}
										<a
											href="https://openwebui.com/m/{models[selectedModelIdx]?.info?.meta?.user
												.username}"
											>{models[selectedModelIdx]?.info?.meta?.user.name
												? models[selectedModelIdx]?.info?.meta?.user.name
												: `@${models[selectedModelIdx]?.info?.meta?.user.username}`}</a
										>
									{:else}
										{models[selectedModelIdx]?.info?.meta?.user.name}
									{/if}
								</div>
							{/if}
						{/if}
					</div>
				</div>
			</div>
		</div>

		<div
			class="relative text-base font-normal mx-auto @md:max-w-3xl py-3 w-full {atSelectedModel
				? 'mt-2'
				: ''}"
		>
			<!-- Soft halo, like the denser fade around the in-chat composer, so it doesn't float on a vivid background. -->
			<div
				aria-hidden="true"
				class="pointer-events-none absolute -inset-x-8 -inset-y-3 rounded-[3rem] bg-white/40 blur-2xl dark:bg-gray-900/40"
			></div>
			<div class="relative">
				{@render composer($i18n.t('How can I help you today?'))}
			</div>
		</div>

		<div class="mx-auto max-w-2xl mt-2" in:fade={{ duration: 200, delay: 200 }}>
			<div class="mx-5">
				<Suggestions suggestionPrompts={selectedSuggestionPrompts} inputValue={prompt} {onSelect} />
			</div>
		</div>
	{/if}
</div>

<style>
	.zero-state-glow {
		--zero-state-glow-blur: 56px;

		position: absolute;
		left: 50%;
		top: 50%;
		width: min(1040px, 92vw);
		height: 560px;
		transform: translate(-50%, -50%);
		pointer-events: none;
		z-index: -1;
		filter: blur(var(--zero-state-glow-blur)) hue-rotate(0deg) saturate(1);
		opacity: 0.72;
		animation: zero-state-glow-color-shift 42s ease-in-out infinite;
	}

	.zero-state-glow::before,
	.zero-state-glow::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: 999px;
	}

	.zero-state-glow::before {
		background: radial-gradient(
			ellipse at 50% 50%,
			rgba(112, 188, 255, 0.92) 0%,
			rgba(165, 216, 255, 0.66) 34%,
			rgba(211, 239, 255, 0.34) 56%,
			rgba(255, 255, 255, 0) 78%
		);
	}

	.zero-state-glow::after {
		inset: -18% -14%;
		background:
			radial-gradient(ellipse at 36% 40%, rgba(255, 160, 214, 0.18), transparent 46%),
			radial-gradient(ellipse at 68% 48%, rgba(119, 155, 255, 0.18), transparent 52%);
		mix-blend-mode: multiply;
	}

	:global(.dark) .zero-state-glow {
		opacity: 0.5;
	}

	:global(.dark) .zero-state-glow::before {
		background: radial-gradient(
			ellipse at 50% 50%,
			rgba(87, 171, 255, 0.76) 0%,
			rgba(88, 143, 255, 0.48) 34%,
			rgba(70, 104, 190, 0.22) 56%,
			rgba(0, 0, 0, 0) 78%
		);
	}

	:global(.dark) .zero-state-glow::after {
		background:
			radial-gradient(ellipse at 36% 40%, rgba(255, 119, 211, 0.16), transparent 46%),
			radial-gradient(ellipse at 68% 48%, rgba(101, 124, 255, 0.18), transparent 52%);
		mix-blend-mode: screen;
	}

	@keyframes zero-state-glow-color-shift {
		0%,
		100% {
			filter: blur(var(--zero-state-glow-blur)) hue-rotate(0deg) saturate(1);
		}
		25% {
			filter: blur(var(--zero-state-glow-blur)) hue-rotate(42deg) saturate(1.04);
		}
		50% {
			filter: blur(var(--zero-state-glow-blur)) hue-rotate(96deg) saturate(1.06);
		}
		75% {
			filter: blur(var(--zero-state-glow-blur)) hue-rotate(168deg) saturate(1.03);
		}
	}

	@media (max-width: 768px) {
		.zero-state-glow {
			width: 94vw;
			height: 420px;
			top: 48%;
			--zero-state-glow-blur: 42px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.zero-state-glow {
			animation: none;
			filter: blur(var(--zero-state-glow-blur));
		}
	}

	/* Home page input: elevated card above the glow so its edge stays visible */
	.placeholder-root :global(#message-input-container) {
		background-color: rgba(255, 255, 255, 0.8);
		border-color: rgba(209, 213, 219, 0.9);
		box-shadow: 0 12px 32px rgba(15, 23, 42, 0.1);
	}

	:global(.dark) .placeholder-root :global(#message-input-container) {
		background-color: rgba(24, 24, 27, 0.8);
		border-color: rgba(82, 82, 91, 0.85);
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
	}
</style>
