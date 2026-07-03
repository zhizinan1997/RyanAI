<script lang="ts">
	import { getContext, createEventDispatcher, onMount } from 'svelte';
	import { fade } from 'svelte/transition';

	const dispatch = createEventDispatcher();

	import { getChatList } from '$lib/apis/chats';

	import {
		config,
		user,
		models as _models,
		temporaryChatEnabled,
		selectedFolder,
		chats,
		currentChatPage,
		chatId
	} from '$lib/stores';
	import { getGreetingLine, getRandomGreetingEmoji } from '$lib/utils/greeting';

	import Suggestions from './Suggestions.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import EyeSlash from '$lib/components/icons/EyeSlash.svelte';
	import MessageInput from './MessageInput.svelte';
	import FolderPlaceholder from './Placeholder/FolderPlaceholder.svelte';
	import FolderTitle from './Placeholder/FolderTitle.svelte';

	const i18n = getContext('i18n');

	export let createMessagePair: Function;
	export let stopResponse: Function;

	export let autoScroll = false;

	export let atSelectedModel: any;
	export let selectedModels: [''];

	export let history;

	export let prompt = '';
	export let files = [];
	export let params = {};
	export let messageInput = null;

	export let selectedToolIds = [];
	export let selectedSkillIds = [];
	export let selectedFilterIds = [];
	export let pendingOAuthTools = [];

	export let showCommands = false;

	export let imageGenerationEnabled = false;
	export let codeInterpreterEnabled = false;
	export let webSearchEnabled = false;

	export let onUpload: Function = (e) => {};
	export let onSelect = (e) => {};
	export let onChange = (e) => {};

	export let toolServers = [];

	export let dragged = false;

	let models = [];
	let selectedModelIdx = 0;
	let greetingNow = new Date();
	let greetingChatId = $chatId;
	let greetingEmoji = getRandomGreetingEmoji();
	$: greetingName = $user?.name || 'Ryan';
	$: greetingLine = getGreetingLine(greetingName, greetingNow, greetingEmoji);

	$: if ($chatId !== greetingChatId) {
		greetingChatId = $chatId;
		greetingEmoji = getRandomGreetingEmoji();
	}

	onMount(() => {
		greetingNow = new Date();

		const greetingTimer = window.setInterval(() => {
			greetingNow = new Date();
		}, 60 * 1000);

		return () => {
			window.clearInterval(greetingTimer);
		};
	});

	$: if (selectedModels.length > 0) {
		selectedModelIdx = models.length - 1;
	}

	$: models = selectedModels.map((id) => $_models.find((m) => m.id === id));
</script>

<div
	class="relative isolate m-auto w-full max-w-6xl px-2 @2xl:px-20 translate-y-6 py-24 text-center"
>
	{#if !$selectedFolder}
		<div class="zero-state-glow" aria-hidden="true"></div>
	{/if}

	{#if $temporaryChatEnabled}
		<Tooltip
			content={$i18n.t("This chat won't appear in history and your messages will not be saved.")}
			className="w-full flex justify-center mb-0.5"
			placement="top"
		>
			<div class="flex items-center gap-2 text-gray-500 text-base my-2 w-fit">
				<EyeSlash strokeWidth="2.5" className="size-4" />{$i18n.t('Temporary Chat')}
			</div>
		</Tooltip>
	{/if}

	<div
		class="w-full text-3xl text-gray-800 dark:text-gray-100 text-center flex items-center gap-4 font-primary"
	>
		<div class="w-full flex flex-col justify-center items-center">
			{#if $selectedFolder}
				<FolderTitle
					folder={$selectedFolder}
					onUpdate={async (folder) => {
						await chats.set(await getChatList(localStorage.token, $currentChatPage));
						currentChatPage.set(1);
					}}
					onDelete={async () => {
						await chats.set(await getChatList(localStorage.token, $currentChatPage));
						currentChatPage.set(1);

						selectedFolder.set(null);
					}}
				/>
			{:else}
				<div
					class="w-full max-w-3xl px-5 text-center text-3xl @sm:text-3xl leading-snug"
					in:fade={{ duration: 100 }}
				>
					{greetingLine}
				</div>
			{/if}

			<div class="text-base font-normal @md:max-w-3xl w-full py-3 {atSelectedModel ? 'mt-2' : ''}">
				<MessageInput
					bind:this={messageInput}
					{history}
					{selectedModels}
					bind:files
					bind:prompt
					bind:params
					bind:autoScroll
					bind:selectedToolIds
					bind:selectedSkillIds
					bind:selectedFilterIds
					bind:imageGenerationEnabled
					bind:codeInterpreterEnabled
					bind:webSearchEnabled
					bind:atSelectedModel
					bind:showCommands
					bind:dragged
					{pendingOAuthTools}
					{toolServers}
					{stopResponse}
					{createMessagePair}
					placeholder={$i18n.t('How can I help you today?')}
					{onChange}
					{onUpload}
					on:submit={(e) => {
						dispatch('submit', e.detail);
					}}
				/>
			</div>
		</div>
	</div>

	{#if $selectedFolder}
		<div
			class="mx-auto px-4 md:max-w-3xl md:px-6 font-primary min-h-62"
			in:fade={{ duration: 200, delay: 200 }}
		>
			<FolderPlaceholder folder={$selectedFolder} />
		</div>
	{:else}
		<div class="mx-auto max-w-2xl font-primary mt-2" in:fade={{ duration: 200, delay: 200 }}>
			<div class="mx-5">
				<Suggestions
					suggestionPrompts={atSelectedModel?.info?.meta?.suggestion_prompts ??
						models[selectedModelIdx]?.info?.meta?.suggestion_prompts ??
						$config?.default_prompt_suggestions ??
						[]}
					inputValue={prompt}
					{onSelect}
				/>
			</div>
		</div>
	{/if}
</div>

<style>
	.zero-state-glow {
		position: absolute;
		left: 50%;
		top: 50%;
		width: min(1040px, 92vw);
		height: 560px;
		transform: translate(-50%, -50%);
		pointer-events: none;
		z-index: -1;
		filter: blur(56px);
		opacity: 0.72;
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

	@media (max-width: 768px) {
		.zero-state-glow {
			width: 94vw;
			height: 420px;
			top: 48%;
			filter: blur(42px);
		}
	}
</style>
