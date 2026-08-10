<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { user } from '$lib/stores';
	import { getSessionUser } from '$lib/apis/auths';

	const i18n = getContext('i18n');
	let credit = 0;

	const doInit = async () => {
		const sessionUser = await getSessionUser(localStorage.token);
		await user.set(sessionUser);
		credit = $user?.credit ? $user.credit : 0;
	};

	onMount(doInit);
</script>

<div class="flex flex-col h-full text-sm">
	<div class="mb-1 text-base font-medium">{$i18n.t('Credit')}</div>
	<div class="flex items-center">
		<div>{credit}</div>
		<button class="ml-1" on:click={doInit} aria-label={$i18n.t('Refresh')}>
			<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="16" height="16">
				<path d="M832 512a32 32 0 0 0-32 32c0 158.784-129.216 288-288 288s-288-129.216-288-288 129.216-288 288-288c66.208 0 129.536 22.752 180.608 64H608a32 32 0 0 0 0 64h160a32 32 0 0 0 32-32V192a32 32 0 0 0-64 0v80.96A350.464 350.464 0 0 0 512 192C317.92 192 160 349.92 160 544s157.92 352 352 352 352-157.92 352-352a32 32 0 0 0-32-32" fill="currentColor" />
			</svg>
		</button>
	</div>
</div>
