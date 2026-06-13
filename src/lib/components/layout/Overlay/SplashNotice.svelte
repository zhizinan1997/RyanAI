<script lang="ts">
	import DOMPurify from 'dompurify';
	import { marked } from 'marked';
	import { getContext } from 'svelte';
	import Modal from '$lib/components/common/Modal.svelte';

	export let show = false;
	export let title = '';
	export let content = '';
	export let mediaUrl = '';

	const i18n = getContext('i18n');

	$: sanitizedTitle = (title ?? '').trim();
	$: sanitizedMediaUrl =
		(mediaUrl ?? '').startsWith('/') ||
		(mediaUrl ?? '').startsWith('data:image/') ||
		(mediaUrl ?? '').startsWith('http://') ||
		(mediaUrl ?? '').startsWith('https://')
			? (mediaUrl ?? '').trim()
			: '';
	$: parsedContent = DOMPurify.sanitize(
		marked.parse(content ?? '', {
			async: false,
			breaks: true,
			gfm: true
		}) as string
	);
</script>

<Modal
	size="xl"
	bind:show
	backdropToneClassName="bg-white/8 dark:bg-slate-950/14"
	backdropClassName="backdrop-blur-[16px] saturate-[1.04]"
	containerClassName="p-4 sm:p-8"
	className="overflow-hidden rounded-[2rem] border border-white/75 bg-white/90 shadow-[0_50px_140px_-42px_rgba(15,23,42,0.26)] dark:border-white/10 dark:bg-slate-950/82"
>
	<div class="splash-shell relative overflow-hidden">
		<button
			type="button"
			class="absolute right-4 top-4 z-20 inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/70 bg-white/28 text-slate-400 shadow-[0_10px_30px_-18px_rgba(15,23,42,0.45)] backdrop-blur-xl transition hover:bg-white/52 hover:text-slate-700 dark:border-white/10 dark:bg-white/6 dark:text-slate-300 dark:hover:bg-white/12 dark:hover:text-white"
			aria-label={$i18n.t('Close')}
			on:click={() => {
				show = false;
			}}
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 20 20"
				fill="currentColor"
				class="h-4 w-4"
			>
				<path
					d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 1 0-1.06-1.06L10 8.94 6.28 5.22Z"
				/>
			</svg>
		</button>

		<div class="grid lg:grid-cols-10">
			<div
				class="splash-pane splash-copy lg:col-span-4 flex min-h-[28rem] flex-col bg-white/92 p-6 sm:p-8 dark:bg-slate-950/38"
			>
				<div class="mt-3">
					<div
						class="text-[1.95rem] font-semibold leading-[1.12] tracking-[-0.035em] text-slate-900 dark:text-slate-50"
					>
						{sanitizedTitle !== '' ? sanitizedTitle : $i18n.t('Splash Notice')}
					</div>
				</div>

				<div
					class="splash-markdown mt-6 flex-1 text-[0.97rem] leading-7 text-slate-600 dark:text-slate-200"
				>
					{@html parsedContent}
				</div>

				<button
					type="button"
					class="mt-8 inline-flex w-full items-center justify-center rounded-xl bg-[#3b82f6] px-5 py-3 text-sm font-semibold text-white shadow-[0_20px_44px_-20px_rgba(59,130,246,0.78)] transition hover:-translate-y-0.5 hover:bg-[#2f78ee] active:translate-y-[1px] sm:w-auto sm:min-w-[10rem] dark:bg-[#4b8dff] dark:hover:bg-[#5a97ff]"
					on:click={() => {
						show = false;
					}}
				>
					{$i18n.t('Experience Now')}
				</button>
			</div>

			<div
				class="splash-pane splash-visual lg:col-span-6 relative min-h-[18rem] overflow-hidden bg-linear-to-br from-[#edf4ff] via-[#f6f8ff] to-white dark:from-slate-900 dark:via-slate-900 dark:to-slate-950"
			>
				<div
					class="absolute inset-0 bg-[radial-gradient(circle_at_24%_22%,rgba(59,130,246,0.16),transparent_26%),radial-gradient(circle_at_76%_22%,rgba(125,211,252,0.14),transparent_22%),linear-gradient(180deg,rgba(255,255,255,0.52),rgba(255,255,255,0.08))] dark:bg-[radial-gradient(circle_at_24%_22%,rgba(59,130,246,0.12),transparent_26%),radial-gradient(circle_at_76%_22%,rgba(96,165,250,0.1),transparent_22%),linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.01))]"
				></div>
				<div
					class="absolute inset-y-0 left-0 hidden w-px bg-white/70 lg:block dark:bg-white/8"
				></div>

				{#if sanitizedMediaUrl !== ''}
					<div class="absolute inset-0">
						<img
							src={sanitizedMediaUrl}
							alt={$i18n.t('Splash Notice Visual')}
							class="h-full w-full object-cover"
						/>
					</div>
				{:else}
					<div class="absolute inset-0 flex items-center justify-center p-6">
						<div
							class="flex h-full w-full items-center justify-center rounded-[1.45rem] border border-white/70 bg-white/50 text-sm text-slate-400 backdrop-blur-xl dark:border-white/10 dark:bg-white/5 dark:text-slate-500"
						>
							{$i18n.t('Upload image or GIF')}
						</div>
					</div>
				{/if}
			</div>
		</div>
	</div>
</Modal>

<style>
	.splash-shell {
		animation: splash-card-enter 280ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	.splash-pane {
		opacity: 0;
		transform: translateY(12px);
		animation: splash-fade-up 360ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
	}

	.splash-copy {
		animation-delay: 40ms;
	}

	.splash-visual {
		animation-delay: 90ms;
	}

	@media (max-width: 980px) {
		.splash-visual {
			display: none;
		}

		.splash-copy {
			min-height: auto;
		}
	}

	.splash-markdown :global(h1),
	.splash-markdown :global(h2),
	.splash-markdown :global(h3) {
		color: inherit;
		font-weight: 600;
		letter-spacing: -0.02em;
		line-height: 1.22;
		margin: 0 0 0.75rem 0;
	}

	.splash-markdown :global(h1) {
		font-size: 1.18rem;
	}

	.splash-markdown :global(h2) {
		font-size: 1.05rem;
	}

	.splash-markdown :global(h3) {
		font-size: 0.98rem;
	}

	.splash-markdown :global(p) {
		margin: 0.55rem 0;
	}

	.splash-markdown :global(p:first-child) {
		margin-top: 0;
		font-size: 0.98rem;
		line-height: 1.85;
		color: rgba(15, 23, 42, 0.86);
	}

	.splash-markdown :global(ul),
	.splash-markdown :global(ol) {
		margin: 0.8rem 0;
		padding-left: 1.2rem;
	}

	.splash-markdown :global(li) {
		margin: 0.34rem 0;
	}

	.splash-markdown :global(a) {
		color: #2563eb;
		text-decoration: none;
		font-weight: 600;
	}

	.splash-markdown :global(a:hover) {
		text-decoration: underline;
	}

	.splash-markdown :global(blockquote) {
		margin: 0.9rem 0;
		padding: 0.9rem 1rem;
		border-left: 3px solid rgba(59, 130, 246, 0.45);
		background: rgba(255, 255, 255, 0.58);
		border-radius: 0.95rem;
		color: rgba(30, 41, 59, 0.9);
	}

	.splash-markdown :global(code) {
		padding: 0.14rem 0.4rem;
		border-radius: 0.5rem;
		background: rgba(15, 23, 42, 0.08);
		font-size: 0.9em;
	}

	.splash-markdown :global(pre) {
		margin: 0.9rem 0;
		padding: 0.95rem 1rem;
		border-radius: 0.95rem;
		background: rgba(15, 23, 42, 0.82);
		color: #e2e8f0;
		overflow-x: auto;
	}

	.splash-markdown :global(pre code) {
		padding: 0;
		background: transparent;
	}

	.splash-markdown :global(hr) {
		margin: 0.9rem 0;
		border: 0;
		height: 1px;
		background: linear-gradient(90deg, transparent, rgba(148, 163, 184, 0.42), transparent);
	}

	.splash-markdown :global(strong) {
		font-weight: 700;
		color: rgba(15, 23, 42, 0.96);
	}

	.splash-markdown :global(table) {
		width: 100%;
		margin: 0.9rem 0;
		border-collapse: separate;
		border-spacing: 0;
		overflow: hidden;
		border-radius: 0.9rem;
		background: rgba(255, 255, 255, 0.42);
	}

	.splash-markdown :global(th),
	.splash-markdown :global(td) {
		padding: 0.78rem 0.9rem;
		text-align: left;
		border-bottom: 1px solid rgba(148, 163, 184, 0.16);
	}

	.splash-markdown :global(th) {
		font-size: 0.78rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: rgba(51, 65, 85, 0.78);
		background: rgba(255, 255, 255, 0.32);
	}

	:global(.dark) .splash-markdown :global(blockquote) {
		background: rgba(255, 255, 255, 0.04);
		color: rgba(226, 232, 240, 0.92);
	}

	:global(.dark) .splash-markdown :global(code) {
		background: rgba(255, 255, 255, 0.08);
	}

	:global(.dark) .splash-markdown :global(p:first-child) {
		color: rgba(248, 250, 252, 0.92);
	}

	:global(.dark) .splash-markdown :global(strong) {
		color: rgba(255, 255, 255, 0.96);
	}

	:global(.dark) .splash-markdown :global(table) {
		background: rgba(255, 255, 255, 0.03);
	}

	:global(.dark) .splash-markdown :global(th) {
		color: rgba(226, 232, 240, 0.78);
		background: rgba(255, 255, 255, 0.02);
	}

	@keyframes splash-card-enter {
		from {
			opacity: 0;
			transform: translateY(14px) scale(0.985);
		}

		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	@keyframes splash-fade-up {
		from {
			opacity: 0;
			transform: translateY(12px);
		}

		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
