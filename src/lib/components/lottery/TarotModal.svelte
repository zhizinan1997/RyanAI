<script lang="ts">
	import { createEventDispatcher, onDestroy, tick } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { user } from '$lib/stores';
	import { getSessionUser } from '$lib/apis/auths';
	import { drawTarot } from '$lib/apis/lottery';
	import { TAROT_BY_CODE, tarotImg, POS } from './tarotCards';

	const dispatch = createEventDispatcher();

	export let show = false;

	// stage: intro | shuffle | spread | picked | reveal | result
	let stage: string = 'intro';
	let light = false;
	let title = '塔罗占卜';
	let prompt = '静心凝神,在心中默想一个问题……';

	const N = 78;
	let fanRot: number[] = [];
	let selected: number[] = []; // 选中的扇形位置(按先后)
	let wheelOpen = false;
	let blooming = false;
	let ready = false;
	let fade = false;
	let stageVisible = true;
	let boardVisible = false;
	let radius = 230;
	const span = 360;

	let cols: { code: string; reversed: boolean; lit: boolean; flipped: boolean; burst: boolean }[] = [];
	let summary = '';
	let reward = 0;
	let rewardShown = 0;
	let coins: { tx: number; ty: number; delay: number }[] = [];
	let drawing = false;

	const pile = Array.from({ length: 7 }, (_, i) => ({
		ox: (i - 3) * 1.5,
		oy: -i * 1.5,
		orot: (i - 3) * 1.2,
		d: i % 2 ? 1 : -1
	}));

	// 背景星点/粒子
	const stars = Array.from({ length: 110 }, () => ({
		x: +(Math.random() * 100).toFixed(2),
		y: +(Math.random() * 100).toFixed(2),
		s: +(Math.random() * 2 + 0.6).toFixed(1),
		d: +(Math.random() * 3 + 2).toFixed(1),
		delay: +(Math.random() * 3).toFixed(1)
	}));
	const motes = Array.from({ length: 18 }, () => ({
		x: +(Math.random() * 100).toFixed(2),
		d: +(Math.random() * 10 + 12).toFixed(1),
		mx: +(Math.random() * 80 - 40).toFixed(0),
		delay: +(Math.random() * 12).toFixed(1)
	}));

	let timers: any[] = [];
	const after = (fn: () => void, ms: number) => {
		const t = setTimeout(fn, ms);
		timers.push(t);
		return t;
	};
	const clearTimers = () => {
		timers.forEach(clearTimeout);
		timers = [];
	};

	const detectTheme = () => {
		try {
			light = !document.documentElement.classList.contains('dark');
		} catch (e) {
			light = false;
		}
	};

	const reset = () => {
		clearTimers();
		stage = 'intro';
		selected = [];
		wheelOpen = blooming = ready = fade = false;
		stageVisible = true;
		boardVisible = false;
		cols = [];
		summary = '';
		reward = 0;
		rewardShown = 0;
		coins = [];
		drawing = false;
		title = '塔罗占卜';
		prompt = '静心凝神,在心中默想一个问题……';
	};

	$: if (show) {
		detectTheme();
		reset();
	}

	const autoRadius = () => {
		const ch = 154;
		const lim = Math.min(window.innerWidth * 0.92, window.innerHeight * 0.78);
		let r = Math.round(lim / 2 - ch / 2 - 10);
		radius = Math.max(115, Math.min(r, 340));
	};

	const startShuffle = () => {
		if (stage !== 'intro') return;
		stage = 'shuffle';
		prompt = '正在洗牌,交付于命运……';
		after(() => spread(), 1500);
	};

	const spread = async () => {
		stage = 'spread';
		// 随机角度起点,使每次牌序不同
		const offset = Math.random() * span;
		fanRot = Array.from({ length: N }, (_, i) => (((span / N) * i + offset) % span) - span / 2);
		autoRadius();
		wheelOpen = false;
		blooming = false;
		ready = false;
		fade = false;
		await tick();
		requestAnimationFrame(() => {
			wheelOpen = true;
			blooming = true;
		});
		after(() => {
			blooming = false;
			ready = true;
		}, 1200);
		title = '抽 取 命 运';
		updatePrompt();
	};

	const updatePrompt = () => {
		if (stage === 'spread' || stage === 'picked') prompt = `凭直觉点选 ${selected.length} / 3 张牌`;
	};

	const pick = (i: number) => {
		if (stage !== 'spread') return;
		const idx = selected.indexOf(i);
		if (idx >= 0) {
			selected = selected.filter((x) => x !== i);
			updatePrompt();
			return;
		}
		if (selected.length >= 3) return;
		selected = [...selected, i];
		updatePrompt();
		if (selected.length === 3) {
			stage = 'picked';
			after(() => doDraw(), 650);
		}
	};

	const doDraw = async () => {
		drawing = true;
		const res = await drawTarot(localStorage.token).catch((err) => {
			toast.error(`${err}`);
			return null;
		});
		drawing = false;
		if (!res) {
			// 已抽过或未开启等
			close();
			return;
		}
		reward = res.reward ?? 0;
		// 服务端返回的 3 张牌映射到 过去/现在/未来
		cols = (res.cards ?? []).slice(0, 3).map((c: any) => ({
			code: c.code,
			reversed: !!c.reversed,
			lit: false,
			flipped: false,
			burst: false
		}));
		reveal();
	};

	const reveal = async () => {
		stage = 'reveal';
		fade = true; // 圆阵中未选中的牌淡出(此时 stagearea 仍可见)
		title = '你的指引';
		prompt = '命运之牌正在揭晓……';
		await tick();
		after(async () => {
			stageVisible = false; // 收起圆阵
			boardVisible = true; // 展开三列
			await tick();
			cols.forEach((_, i) => {
				after(() => {
					cols[i].lit = true;
					cols = cols;
					after(() => {
						cols[i].flipped = true;
						cols[i].burst = true;
						cols = cols;
					}, 260);
				}, i * 560);
			});
			after(() => showResult(), 3 * 560 + 900);
		}, 520);
	};

	const showResult = async () => {
		stage = 'result';
		const names = cols.map((c) => TAROT_BY_CODE[c.code]?.cn ?? '');
		summary = `过去的「${names[0]}」一路指引你走到此刻的「${names[1]}」,而未来正朝向「${names[2]}」展开。顺应这股能量,答案已在你心中。`;
		// 金币粒子
		coins = Array.from({ length: 10 }, (_, i) => {
			const ang = Math.random() * 120 - 60;
			const dist = 60 + Math.random() * 60;
			return {
				tx: Math.sin((ang * Math.PI) / 180) * dist,
				ty: -dist,
				delay: i * 60
			};
		});
		countUp(reward, 900);
		// 刷新用户积分
		const su = await getSessionUser(localStorage.token).catch(() => null);
		if (su) {
			await user.set(su);
		}
	};

	const countUp = (to: number, dur: number) => {
		const start = performance.now();
		const tickFn = (t: number) => {
			const p = Math.min(1, (t - start) / dur);
			rewardShown = Math.round(to * (1 - Math.pow(1 - p, 3)));
			if (p < 1) requestAnimationFrame(tickFn);
		};
		requestAnimationFrame(tickFn);
	};

	const close = () => {
		clearTimers();
		show = false;
		dispatch('close');
	};

	const onResize = () => {
		if (stage === 'spread') autoRadius();
	};

	onDestroy(clearTimers);

	const card = (code: string) => TAROT_BY_CODE[code];
</script>

<svelte:window on:resize={onResize} on:keydown={(e) => e.key === 'Escape' && show && close()} />

{#if show}
	<div class="tarot-overlay" class:light>
		<!-- 背景 -->
		<div class="scene">
			<div class="nebula"></div>
			<div class="moon"></div>
			<div class="stars">
				{#each stars as s}
					<i
						style="left:{s.x}%;top:{s.y}%;width:{s.s}px;height:{s.s}px;--d:{s.d}s;animation-delay:{s.delay}s"
					></i>
				{/each}
			</div>
			<div class="motes">
				{#each motes as m}
					<i style="left:{m.x}%;--d:{m.d}s;--x:{m.mx}px;animation-delay:{m.delay}s"></i>
				{/each}
			</div>
		</div>

		<button class="close" aria-label="关闭" on:click={close}>×</button>

		<div class="head">
			<div class="title">{title}</div>
			<div class="prompt">{prompt}</div>
		</div>

		<!-- 牌堆 / 圆形牌阵 -->
		{#if stageVisible}
			<div class="stagearea">
				{#if stage === 'intro' || stage === 'shuffle'}
					<div class="deck">
						<div class="pile" class:shuffling={stage === 'shuffle'}>
							{#each pile as p}
								<div
									class="pc back"
									style="--ox:{p.ox}px;--oy:{p.oy}px;--orot:{p.orot}deg;--d:{p.d}"
								></div>
							{/each}
						</div>
						{#if stage === 'intro'}
							<button class="startbtn" on:click={startShuffle}>开 始 洗 牌</button>
						{/if}
					</div>
				{/if}

				{#if stage === 'spread' || stage === 'picked' || stage === 'reveal'}
					<div
						class="fan"
						class:open={wheelOpen}
						class:blooming
						class:ready
						class:fade
						style="--R:{radius}px"
					>
						{#each fanRot as rot, i}
							<div
								class="fan-card"
								class:sel={selected.includes(i)}
								style="--rot:{rot};--i:{i}"
								on:click={() => pick(i)}
								role="button"
								tabindex="-1"
							>
								{#if selected.includes(i)}
									<span class="num" style="transform:translateX(-50%) rotate({-rot}deg)"
										>{selected.indexOf(i) + 1}</span
									>
								{/if}
								<span class="back"></span>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}

		<!-- 揭示三列 -->
		{#if boardVisible}
			<div class="board show">
				{#each cols as c, i}
					<div class="col" class:lit={c.lit}>
						<div class="pos">{POS[i]}</div>
						<div class="flip" class:done={c.flipped}>
							<span class="burst" class:go={c.burst}></span>
							<div class="flip-in">
								<div class="face front back"></div>
								<div class="face rear" class:reversed={c.reversed}>
									<img alt={card(c.code)?.cn ?? ''} src={tarotImg(c.code)} />
								</div>
							</div>
						</div>
						{#if stage === 'result'}
							<div class="reading in">
								<div class="rname">
									{card(c.code)?.cn}<span>{card(c.code)?.en}</span>
								</div>
								<span class="rbadge {c.reversed ? 'rev' : 'up'}">{c.reversed ? '逆位' : '正位'}</span>
								<div class="rkw">{c.reversed ? card(c.code)?.r : card(c.code)?.u}</div>
								<div class="rtext">{c.reversed ? card(c.code)?.rm : card(c.code)?.um}</div>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		<!-- 页脚 -->
		{#if stage === 'result'}
			<div class="foot show">
				<div class="summary">{summary}</div>
				<div class="reward">
					<div class="rw">
						<span class="lab">✨ 占卜完成,获得</span><span class="amt">{rewardShown}</span><span
							class="lab">积分 ✨</span
						>
						<span class="coins">
							{#each coins as co}
								<i style="--tx:{co.tx}px;--ty:{co.ty}px;animation-delay:{co.delay}ms">✦</i>
							{/each}
						</span>
					</div>
				</div>
				<div class="actions">
					<button class="btn primary" on:click={close}>收下祝福</button>
				</div>
			</div>
		{/if}
	</div>
{/if}

<style>
	.tarot-overlay {
		--gold: #d4af37;
		--gold-lt: #f0d98c;
		--gold-br: #ffe9a8;
		--card-bg1: #241a52;
		--card-bg2: #1a1140;
		--cw: 90px;
		--ch: 154px;
		--rch: 325px;
		--spd: 1;
		--txt: #e8e0ff;
		--txt2: #c9bcec;
		--scene: radial-gradient(1200px 800px at 50% -10%, #3a1f6e 0%, transparent 55%),
			radial-gradient(900px 700px at 85% 110%, #2a0f4a 0%, transparent 50%),
			radial-gradient(900px 700px at 10% 90%, #14203f 0%, transparent 50%),
			linear-gradient(180deg, #160a2b 0%, #0a0518 100%);
		--overlay: radial-gradient(1000px 700px at 50% 40%, rgba(40, 20, 80, 0.55), rgba(8, 4, 20, 0.9));
		--panel-name: #fff;
		--panel-text: #d7cdf0;
		--panel-bd: rgba(212, 175, 55, 0.32);
		--close-bg: rgba(30, 16, 60, 0.7);
		--face-bg: #0d0820;
		position: fixed;
		inset: 0;
		z-index: 9999;
		height: 100dvh;
		display: flex;
		flex-direction: column;
		align-items: center;
		background: var(--overlay);
		backdrop-filter: blur(7px);
		-webkit-backdrop-filter: blur(7px);
		overflow: hidden;
		padding: clamp(8px, 2vh, 18px) 14px clamp(10px, 2vh, 20px);
		color: var(--txt);
		font-family: 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', -apple-system, sans-serif;
		animation: t-fade 0.4s ease;
	}
	.tarot-overlay.light {
		--txt: #3a2c5e;
		--txt2: #6b5a8e;
		--scene: radial-gradient(1200px 800px at 50% -10%, #fff5e0 0%, transparent 55%),
			radial-gradient(900px 700px at 85% 110%, #efe0ff 0%, transparent 50%),
			radial-gradient(900px 700px at 10% 90%, #e2ecff 0%, transparent 55%),
			linear-gradient(180deg, #fbf4e8 0%, #ece2f5 100%);
		--overlay: radial-gradient(1000px 700px at 50% 40%, rgba(255, 250, 238, 0.85), rgba(236, 226, 245, 0.94));
		--panel-name: #3a2c5e;
		--panel-text: #5b4d7a;
		--panel-bd: rgba(180, 140, 40, 0.38);
		--close-bg: rgba(255, 250, 240, 0.85);
		--face-bg: #1a1230;
	}
	@keyframes t-fade {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	.scene {
		position: absolute;
		inset: 0;
		z-index: 0;
		overflow: hidden;
		background: var(--scene);
	}
	.nebula {
		position: absolute;
		inset: -20%;
		background: radial-gradient(closest-side, rgba(120, 80, 200, 0.22), transparent 70%) 20% 30% / 55% 55% no-repeat,
			radial-gradient(closest-side, rgba(60, 120, 200, 0.18), transparent 70%) 80% 70% / 50% 50% no-repeat,
			radial-gradient(closest-side, rgba(212, 175, 55, 0.1), transparent 70%) 60% 20% / 40% 40% no-repeat;
		filter: blur(8px);
		animation: t-drift 40s ease-in-out infinite alternate;
	}
	@keyframes t-drift {
		from {
			transform: translate(-2%, -1%) scale(1);
		}
		to {
			transform: translate(3%, 2%) scale(1.08);
		}
	}
	.moon {
		position: absolute;
		top: 6%;
		left: 50%;
		width: 110px;
		height: 110px;
		margin-left: -55px;
		border-radius: 50%;
		background: radial-gradient(circle at 38% 35%, #fff7e0, #f3e6b0 45%, #cdbf86 70%, #9b8e5e 100%);
		box-shadow: 0 0 60px 18px rgba(240, 225, 150, 0.32), inset -14px -10px 26px rgba(80, 70, 40, 0.45);
		opacity: 0.85;
	}
	.tarot-overlay.light .moon {
		background: radial-gradient(circle at 38% 35%, #fff, #ffe6a6 45%, #f3c25a 100%);
		box-shadow: 0 0 70px 22px rgba(243, 194, 90, 0.4);
	}
	.stars i {
		position: absolute;
		background: #fff;
		border-radius: 50%;
		opacity: 0.7;
		animation: t-tw var(--d, 3s) ease-in-out infinite alternate;
	}
	.tarot-overlay.light .stars {
		opacity: 0.1;
	}
	@keyframes t-tw {
		from {
			opacity: 0.15;
			transform: scale(0.6);
		}
		to {
			opacity: 0.95;
			transform: scale(1);
		}
	}
	.motes i {
		position: absolute;
		bottom: -10px;
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: radial-gradient(circle, var(--gold-br), rgba(212, 175, 55, 0));
		animation: t-rise var(--d, 16s) linear infinite;
		opacity: 0;
	}
	@keyframes t-rise {
		0% {
			transform: translateY(0) translateX(0);
			opacity: 0;
		}
		10% {
			opacity: 0.9;
		}
		90% {
			opacity: 0.7;
		}
		100% {
			transform: translateY(-104vh) translateX(var(--x, 20px));
			opacity: 0;
		}
	}

	.close {
		position: fixed;
		top: 16px;
		right: 18px;
		z-index: 70;
		width: 42px;
		height: 42px;
		border-radius: 50%;
		cursor: pointer;
		background: var(--close-bg);
		border: 1px solid rgba(212, 175, 55, 0.5);
		color: var(--gold-lt);
		font-size: 22px;
		line-height: 1;
		transition: transform 0.2s, background 0.2s;
	}
	.close:hover {
		transform: rotate(90deg);
		background: rgba(120, 80, 30, 0.25);
	}

	.head {
		text-align: center;
		margin: 2px 0;
		flex: 0 0 auto;
		z-index: 1;
	}
	.title {
		font-size: clamp(20px, 3vh, 26px);
		letter-spacing: 0.16em;
		font-weight: 600;
		background: linear-gradient(90deg, var(--gold-lt), #fff7e6, var(--gold-lt));
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
		text-shadow: 0 0 26px rgba(212, 175, 55, 0.3);
	}
	.tarot-overlay.light .title {
		background: linear-gradient(90deg, #b8860b, #8a5a10, #b8860b);
		-webkit-background-clip: text;
		background-clip: text;
		text-shadow: 0 0 16px rgba(184, 134, 11, 0.18);
	}
	.prompt {
		font-size: clamp(12.5px, 1.7vh, 14.5px);
		color: var(--txt2);
		letter-spacing: 0.06em;
		margin-top: 6px;
	}

	.stagearea {
		position: relative;
		width: 100%;
		max-width: 1080px;
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 0;
		z-index: 1;
	}

	.deck {
		position: relative;
		width: var(--cw);
		height: var(--ch);
	}
	.pile {
		position: absolute;
		inset: 0;
	}
	.pc {
		position: absolute;
		inset: 0;
		transform: translate(var(--ox), var(--oy)) rotate(var(--orot));
	}
	.pile.shuffling .pc {
		animation: t-riffle calc(0.75s / var(--spd)) ease-in-out 2;
	}
	@keyframes t-riffle {
		0%,
		100% {
			transform: translate(var(--ox), var(--oy)) rotate(var(--orot));
		}
		25% {
			transform: translateX(calc(var(--d) * 72px)) translateY(-12px) rotate(calc(var(--d) * 14deg));
		}
		50% {
			transform: translate(var(--ox), var(--oy)) rotate(var(--orot));
		}
		75% {
			transform: translateX(calc(var(--d) * -58px)) translateY(-8px) rotate(calc(var(--d) * -12deg));
		}
	}
	.startbtn {
		position: absolute;
		left: 50%;
		bottom: -86px;
		transform: translateX(-50%);
		white-space: nowrap;
		padding: 13px 34px;
		border-radius: 30px;
		cursor: pointer;
		font-size: 15px;
		letter-spacing: 0.12em;
		color: #1a0f30;
		font-weight: 700;
		background: linear-gradient(180deg, var(--gold-br), var(--gold));
		border: 0;
		box-shadow: 0 6px 22px rgba(212, 175, 55, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.3) inset;
		transition: transform 0.2s, box-shadow 0.2s;
	}
	.startbtn:hover {
		transform: translateX(-50%) translateY(-3px);
		box-shadow: 0 10px 30px rgba(212, 175, 55, 0.6);
	}

	.back {
		width: 100%;
		height: 100%;
		border-radius: 9px;
		position: relative;
		overflow: hidden;
		display: block;
		background: radial-gradient(circle at 50% 50%, rgba(212, 175, 55, 0.16), transparent 62%),
			repeating-linear-gradient(45deg, var(--card-bg1) 0 7px, var(--card-bg2) 7px 14px);
		border: 2px solid rgba(212, 175, 55, 0.72);
		box-shadow: inset 0 0 0 3px rgba(212, 175, 55, 0.16), inset 0 0 18px rgba(0, 0, 0, 0.55),
			0 6px 16px rgba(0, 0, 0, 0.45);
	}
	.back::before {
		content: '';
		position: absolute;
		inset: 7px;
		border: 1px solid rgba(212, 175, 55, 0.42);
		border-radius: 6px;
	}
	.back::after {
		content: '';
		position: absolute;
		inset: 0;
		background-position: center;
		background-repeat: no-repeat;
		background-size: 64% 64%;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cg fill='none' stroke='%23d4af37' stroke-width='1.3'%3E%3Ccircle cx='50' cy='50' r='34'/%3E%3Ccircle cx='50' cy='50' r='25'/%3E%3Cpath d='M50 7 L57 43 L93 50 L57 57 L50 93 L43 57 L7 50 L43 43 Z' fill='%23d4af37' fill-opacity='.22'/%3E%3Cpath d='M50 18 L54 46 L82 50 L54 54 L50 82 L46 54 L18 50 L46 46 Z' fill='%23d4af37' fill-opacity='.32'/%3E%3Ccircle cx='50' cy='50' r='7' fill='%23d4af37' fill-opacity='.6'/%3E%3C/g%3E%3C/svg%3E");
	}

	.fan {
		position: absolute;
		left: 50%;
		top: 50%;
		width: 0;
		height: 0;
		--R: 230px;
	}
	.fan-card {
		position: absolute;
		left: 0;
		top: 0;
		width: var(--cw);
		height: var(--ch);
		margin-left: calc(var(--cw) / -2);
		margin-top: calc(var(--ch) / -2);
		transform-origin: center center;
		cursor: pointer;
		backface-visibility: hidden;
		transform: rotate(calc(var(--rot) * 1deg)) translateY(0) scale(0.3);
		opacity: 0;
		transition: transform 0.6s cubic-bezier(0.22, 0.61, 0.36, 1), opacity 0.45s;
	}
	.fan.open .fan-card {
		transform: rotate(calc(var(--rot) * 1deg)) translateY(calc(var(--R) * -1));
		opacity: 1;
	}
	.fan.blooming .fan-card {
		transition-delay: calc(var(--i) * 6ms);
	}
	.fan.ready .fan-card {
		transition: transform 0.2s ease, opacity 0.3s;
		transition-delay: 0s;
	}
	.fan.open .fan-card:hover {
		transform: rotate(calc(var(--rot) * 1deg)) translateY(calc((var(--R) + 30px) * -1)) scale(1.14);
		z-index: 1500;
		will-change: transform;
	}
	.fan.open .fan-card:hover :global(.back) {
		box-shadow: inset 0 0 0 3px rgba(255, 233, 168, 0.55), 0 14px 30px rgba(0, 0, 0, 0.6),
			0 0 28px rgba(212, 175, 55, 0.8);
	}
	.fan.open .fan-card.sel {
		transform: rotate(calc(var(--rot) * 1deg)) translateY(calc((var(--R) + 46px) * -1)) scale(1.18);
		z-index: 1400;
	}
	.fan.open .fan-card.sel :global(.back) {
		box-shadow: inset 0 0 0 3px var(--gold-br), 0 0 32px rgba(255, 233, 168, 0.9), 0 14px 32px rgba(0, 0, 0, 0.6);
	}
	.fan-card .num {
		position: absolute;
		top: -13px;
		left: 50%;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		background: linear-gradient(180deg, var(--gold-br), var(--gold));
		color: #1a0f30;
		font-size: 14px;
		font-weight: 800;
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: 0 0 12px rgba(255, 233, 168, 0.85);
		z-index: 5;
	}
	.fan.fade .fan-card:not(.sel) {
		opacity: 0;
		transform: rotate(calc(var(--rot) * 1deg)) translateY(calc(var(--R) * -1)) scale(0.6);
		transition: all 0.5s ease;
	}

	.board {
		display: none;
		flex: 1 1 auto;
		width: 100%;
		max-width: 1080px;
		align-items: center;
		justify-content: center;
		gap: clamp(10px, 3vw, 40px);
		overflow: hidden;
		min-height: 0;
		z-index: 1;
	}
	.board.show {
		display: flex;
	}
	.col {
		display: flex;
		flex-direction: column;
		align-items: center;
		flex: 1 1 0;
		min-width: 0;
		max-width: 330px;
	}
	.col .pos {
		font-size: clamp(13px, 1.7vh, 15px);
		letter-spacing: 0.2em;
		color: var(--gold-lt);
		margin-bottom: clamp(6px, 1.2vh, 12px);
		opacity: 0;
		transform: translateY(8px);
		transition: all 0.5s;
	}
	.col.lit .pos {
		opacity: 1;
		transform: translateY(0);
	}
	.flip {
		position: relative;
		aspect-ratio: 90 / 154;
		height: min(var(--rch), 34vh);
		width: auto;
		max-width: 100%;
		perspective: 1300px;
	}
	.flip-in {
		position: relative;
		width: 100%;
		height: 100%;
		transform-style: preserve-3d;
		transition: transform calc(0.95s / var(--spd)) cubic-bezier(0.5, 0.05, 0.2, 1);
	}
	.flip.done .flip-in {
		transform: rotateY(180deg);
	}
	.face {
		position: absolute;
		inset: 0;
		backface-visibility: hidden;
		-webkit-backface-visibility: hidden;
		border-radius: 9px;
	}
	.face.rear {
		transform: rotateY(180deg);
		overflow: hidden;
		border: 2px solid rgba(212, 175, 55, 0.75);
		box-shadow: 0 0 26px rgba(212, 175, 55, 0.4), 0 10px 28px rgba(0, 0, 0, 0.45);
		background: var(--face-bg);
	}
	.face.rear img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
		border-radius: 7px;
	}
	.face.rear.reversed img {
		transform: rotate(180deg);
	}
	.col.lit .flip {
		animation: t-rise-in 0.6s ease;
	}
	@keyframes t-rise-in {
		from {
			opacity: 0;
			transform: translateY(30px) scale(0.85);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
	.burst {
		position: absolute;
		inset: -30px;
		border-radius: 50%;
		pointer-events: none;
		opacity: 0;
		background: radial-gradient(circle, rgba(255, 233, 168, 0.8), rgba(212, 175, 55, 0) 65%);
	}
	.burst.go {
		animation: t-burst 0.8s ease-out;
	}
	@keyframes t-burst {
		0% {
			opacity: 0;
			transform: scale(0.3);
		}
		30% {
			opacity: 1;
		}
		100% {
			opacity: 0;
			transform: scale(1.6);
		}
	}
	.reading {
		width: 100%;
		margin-top: clamp(8px, 1.6vh, 16px);
		text-align: center;
		opacity: 0;
		transform: translateY(14px);
	}
	.reading.in {
		animation: t-up 0.55s ease forwards;
	}
	@keyframes t-up {
		to {
			opacity: 1;
			transform: none;
		}
	}
	.reading .rname {
		font-size: clamp(16px, 2.1vh, 21px);
		font-weight: 700;
		color: var(--panel-name);
	}
	.reading .rname span {
		font-size: 11px;
		font-weight: 400;
		color: var(--txt2);
		margin-left: 5px;
	}
	.reading .rbadge {
		display: inline-block;
		font-size: 11px;
		padding: 1px 9px;
		border-radius: 12px;
		margin: 5px 0 7px;
		letter-spacing: 0.1em;
	}
	.rbadge.up {
		background: rgba(80, 200, 140, 0.18);
		color: #3fa777;
		border: 1px solid rgba(80, 200, 140, 0.45);
	}
	.rbadge.rev {
		background: rgba(220, 120, 120, 0.16);
		color: #c6595a;
		border: 1px solid rgba(220, 120, 120, 0.45);
	}
	.reading .rkw {
		font-size: clamp(12px, 1.6vh, 14px);
		color: var(--gold);
		letter-spacing: 0.03em;
		margin-bottom: 5px;
		font-weight: 600;
	}
	.reading .rtext {
		font-size: clamp(11.5px, 1.55vh, 13.5px);
		line-height: 1.65;
		color: var(--panel-text);
	}

	.foot {
		display: none;
		flex-direction: column;
		align-items: center;
		width: 100%;
		max-width: 760px;
		flex: 0 0 auto;
		padding-top: clamp(6px, 1.4vh, 14px);
		z-index: 1;
	}
	.foot.show {
		display: flex;
		animation: t-fade 0.5s ease;
	}
	.summary {
		text-align: center;
		font-size: clamp(12px, 1.6vh, 14.5px);
		line-height: 1.7;
		color: var(--panel-text);
		padding: clamp(8px, 1.4vh, 14px) 10px;
		border-top: 1px solid var(--panel-bd);
		width: 100%;
	}
	.reward {
		margin: clamp(8px, 1.4vh, 16px) 0 4px;
		text-align: center;
		position: relative;
	}
	.reward .rw {
		display: inline-block;
		padding: clamp(9px, 1.5vh, 15px) clamp(24px, 4vw, 40px);
		border-radius: 40px;
		position: relative;
		background: linear-gradient(180deg, rgba(212, 175, 55, 0.2), rgba(212, 175, 55, 0.06));
		border: 1px solid rgba(212, 175, 55, 0.5);
		box-shadow: 0 0 30px rgba(212, 175, 55, 0.3);
		overflow: hidden;
	}
	.reward .rw::after {
		content: '';
		position: absolute;
		top: 0;
		left: -60%;
		width: 40%;
		height: 100%;
		background: linear-gradient(100deg, transparent, rgba(255, 255, 255, 0.4), transparent);
		animation: t-sweep 2.4s ease-in-out infinite;
	}
	@keyframes t-sweep {
		0% {
			left: -60%;
		}
		60%,
		100% {
			left: 130%;
		}
	}
	.reward .rw .lab {
		font-size: clamp(12px, 1.6vh, 14px);
		color: var(--txt);
		letter-spacing: 0.08em;
	}
	.reward .rw .amt {
		font-size: clamp(24px, 3.6vh, 34px);
		font-weight: 800;
		margin: 0 6px;
		background: linear-gradient(180deg, var(--gold-br), var(--gold));
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}
	.reward .coins i {
		position: absolute;
		left: 50%;
		top: 50%;
		font-size: 18px;
		opacity: 0;
		color: #ffe9a8;
		animation: t-coin 1.3s cubic-bezier(0.2, 0.6, 0.3, 1) forwards;
	}
	@keyframes t-coin {
		0% {
			transform: translate(-50%, -50%) scale(0.4);
			opacity: 0;
		}
		20% {
			opacity: 1;
		}
		100% {
			transform: translate(calc(-50% + var(--tx)), calc(-50% + var(--ty))) scale(1.1);
			opacity: 0;
		}
	}
	.actions {
		display: flex;
		gap: 14px;
		justify-content: center;
		margin-top: clamp(10px, 1.8vh, 22px);
	}
	.btn {
		padding: clamp(8px, 1.4vh, 11px) clamp(20px, 3vw, 30px);
		border-radius: 26px;
		cursor: pointer;
		font-size: clamp(12.5px, 1.6vh, 14px);
		letter-spacing: 0.08em;
		border: 0;
		background: linear-gradient(180deg, var(--gold-br), var(--gold));
		color: #1a0f30;
		font-weight: 700;
		transition: transform 0.2s;
	}
	.btn:hover {
		transform: translateY(-2px);
	}
</style>
