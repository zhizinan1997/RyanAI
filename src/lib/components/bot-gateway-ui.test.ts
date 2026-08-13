import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const componentSource = (relativePath: string) =>
	readFileSync(new URL(relativePath, import.meta.url), 'utf8');

describe('bot gateway UI refresh behavior', () => {
	it('keeps a successful user unbind visible when the follow-up refresh fails', () => {
		const source = componentSource('./chat/Settings/BotBindings.svelte');
		const unbind = source.slice(
			source.indexOf('const unbind = async'),
			source.indexOf('\n\tonMount(load)')
		);
		const logout = unbind.indexOf('await logoutBotGatewayUserConnection');
		const localRemoval = unbind.indexOf(
			'connections = connections.filter((item) => item.channel !== channel)'
		);
		const success = unbind.indexOf("toast.success($i18n.t('{{bot}} bot unbound and disconnected.'");
		const refresh = unbind.indexOf(
			'connections = await getBotGatewayUserConnections(localStorage.token)',
			localRemoval + 1
		);

		expect(logout).toBeGreaterThanOrEqual(0);
		expect(localRemoval).toBeGreaterThan(logout);
		expect(success).toBeGreaterThan(localRemoval);
		expect(refresh).toBeGreaterThan(success);
		expect(unbind.slice(refresh)).toContain('Keep the confirmed local removal');
	});

	it('refreshes admin connection rows alongside operations polling', () => {
		const source = componentSource('./admin/Settings/Integrations.svelte');
		const polling = source.slice(
			source.indexOf('operationsPoll = setInterval'),
			source.indexOf('\n\t});', source.indexOf('operationsPoll = setInterval')) + 5
		);

		expect(polling).toContain('void loadOperations()');
		expect(polling).toContain('void loadBotConnections()');
		expect(source).toContain('if (botConnectionsLoading) return;');
	});
});
