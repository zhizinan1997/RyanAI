<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { user } from '$lib/stores';
	import { getLotteryConfig } from '$lib/apis/lottery';
	import TarotModal from './TarotModal.svelte';

	let enabled = false;
	let drawnToday = true;
	let showModal = false;
	let interval: any;

	const refresh = async () => {
		if (!$user || !localStorage?.token) {
			enabled = false;
			return;
		}
		const cfg = await getLotteryConfig(localStorage.token).catch(() => null);
		if (cfg) {
			enabled = !!cfg.enabled;
			drawnToday = !!cfg.drawn_today;
		} else {
			enabled = false;
		}
	};

	const onClose = () => refresh(); // 抽完刷新 => 当日已抽则隐藏
	const onVis = () => {
		if (document.visibilityState === 'visible') refresh(); // 跨天回来自动恢复
	};

	onMount(() => {
		refresh();
		interval = setInterval(refresh, 10 * 60 * 1000); // 兜底:每 10 分钟刷新(跨 0 点自动重新出现)
		document.addEventListener('visibilitychange', onVis);
	});
	onDestroy(() => {
		clearInterval(interval);
		document.removeEventListener('visibilitychange', onVis);
	});

	$: visible = enabled && !drawnToday && !!$user;
</script>

{#if visible}
	<button
		class="tarot-fab"
		on:click={() => (showModal = true)}
		aria-label="每日塔罗占卜"
		title="每日塔罗 · 点击占卜"
	>
		<span class="fab-halo"></span>
		<span class="fab-card"></span>
		<span class="fab-spark">✦</span>
	</button>
{/if}

<TarotModal bind:show={showModal} on:close={onClose} />

<style>
	.tarot-fab {
		position: fixed;
		right: 20px;
		bottom: 20px;
		z-index: 40;
		width: 48px;
		height: 76px;
		padding: 0;
		border: 0;
		background: none;
		cursor: pointer;
		animation: fab-bob 3.4s ease-in-out infinite;
	}
	@keyframes fab-bob {
		0%,
		100% {
			transform: translateY(0) rotate(-4deg);
		}
		50% {
			transform: translateY(-10px) rotate(4deg);
		}
	}
	.fab-card {
		position: absolute;
		inset: 0;
		border-radius: 8px;
		overflow: hidden;
		transition: transform 0.25s;
		background: radial-gradient(circle at 50% 50%, rgba(212, 175, 55, 0.18), transparent 62%),
			repeating-linear-gradient(45deg, #241a52 0 6px, #1a1140 6px 12px);
		border: 2px solid rgba(212, 175, 55, 0.78);
		box-shadow: inset 0 0 0 2px rgba(212, 175, 55, 0.18), 0 6px 16px rgba(0, 0, 0, 0.4);
	}
	.fab-card::after {
		content: '';
		position: absolute;
		inset: 0;
		background-position: center;
		background-repeat: no-repeat;
		background-size: 70% 70%;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cg fill='none' stroke='%23d4af37' stroke-width='2'%3E%3Ccircle cx='50' cy='50' r='32'/%3E%3Cpath d='M50 10 L57 43 L90 50 L57 57 L50 90 L43 57 L10 50 L43 43 Z' fill='%23d4af37' fill-opacity='.28'/%3E%3Ccircle cx='50' cy='50' r='7' fill='%23d4af37' fill-opacity='.6'/%3E%3C/g%3E%3C/svg%3E");
	}
	.tarot-fab:hover .fab-card {
		transform: scale(1.08);
	}
	.fab-halo {
		position: absolute;
		inset: -16px;
		border-radius: 50%;
		z-index: -1;
		background: radial-gradient(circle, rgba(212, 175, 55, 0.45), rgba(212, 175, 55, 0) 68%);
		animation: fab-breath 3s ease-in-out infinite;
	}
	@keyframes fab-breath {
		0%,
		100% {
			opacity: 0.45;
			transform: scale(0.9);
		}
		50% {
			opacity: 0.95;
			transform: scale(1.18);
		}
	}
	.fab-spark {
		position: absolute;
		top: -6px;
		right: -4px;
		font-size: 12px;
		color: #ffe9a8;
		text-shadow: 0 0 8px rgba(255, 233, 168, 0.9);
		animation: fab-tw 1.8s ease-in-out infinite;
	}
	@keyframes fab-tw {
		0%,
		100% {
			opacity: 0.3;
			transform: scale(0.7);
		}
		50% {
			opacity: 1;
			transform: scale(1.1);
		}
	}
	/* 手机端:上移到输入框上方,避免遮挡发送按钮 */
	@media (max-width: 768px) {
		.tarot-fab {
			right: 12px;
			bottom: 92px;
			width: 42px;
			height: 66px;
		}
	}
</style>
