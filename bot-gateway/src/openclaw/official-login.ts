import type { GatewayConfig } from '../config.js';
import { Logger, safeErrorFields } from '../logger.js';
import type { QrCodeSnapshot } from '../types.js';
import { withOpenClawEnv } from './env-mutex.js';

const WEIXIN_LOGIN_MODULE = '@tencent-weixin/openclaw-weixin/dist/src/auth/login-qr.js';
const WEIXIN_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const QR_TTL_MS = 5 * 60_000;

export interface WeixinLoginCredential {
	accountId: string;
	botToken: string;
	baseUrl?: string;
	userId?: string;
}

export interface QqLoginCredential {
	appId: string;
	appSecret: string;
	userOpenid?: string;
}

export interface PendingOfficialLogin<T> {
	qrCode: QrCodeSnapshot;
	completion: Promise<T>;
	cancel(): void;
}

interface WeixinLoginModule {
	DEFAULT_ILINK_BOT_TYPE: string;
	startWeixinLoginWithQr(options: {
		force?: boolean;
		apiBaseUrl: string;
		botType: string;
	}): Promise<{ qrcodeUrl?: string; message: string; sessionKey: string }>;
	waitForWeixinLogin(options: {
		sessionKey: string;
		apiBaseUrl: string;
		timeoutMs: number;
		botType: string;
	}): Promise<{
		connected: boolean;
		alreadyConnected?: boolean;
		botToken?: string;
		accountId?: string;
		baseUrl?: string;
		userId?: string;
		message: string;
	}>;
}

export async function startWeixinOfficialLogin(
	config: GatewayConfig,
	logger: Logger,
	existingCredential?: WeixinLoginCredential,
	connectionId = 'wechat-default'
): Promise<PendingOfficialLogin<WeixinLoginCredential>> {
	let login!: WeixinLoginModule;
	const started = await withOpenClawEnv(
		{ OPENCLAW_STATE_DIR: config.openClawStateDir },
		async () => {
			login = (await import(WEIXIN_LOGIN_MODULE)) as WeixinLoginModule;
			return login.startWeixinLoginWithQr({
				force: true,
				apiBaseUrl: WEIXIN_DEFAULT_BASE_URL,
				botType: login.DEFAULT_ILINK_BOT_TYPE
			});
		}
	);
	if (!started.qrcodeUrl) throw new Error('weixin_qr_unavailable');

	let cancelled = false;
	const completion = login
		.waitForWeixinLogin({
			sessionKey: started.sessionKey,
			apiBaseUrl: WEIXIN_DEFAULT_BASE_URL,
			timeoutMs: QR_TTL_MS,
			botType: login.DEFAULT_ILINK_BOT_TYPE
		})
		.then((result) => {
			// The pinned package cannot abort its poll, so a cancelled flow can still
			// resolve minutes later. Drop that credential here so no caller can revive
			// a connection the operator already logged out or deleted.
			if (cancelled) throw new Error('weixin_login_cancelled');
			if (result.alreadyConnected && existingCredential) {
				return existingCredential;
			}
			if (!result.connected || !result.accountId || !result.botToken) {
				throw new Error(
					result.alreadyConnected ? 'weixin_already_connected' : 'weixin_login_failed'
				);
			}
			return {
				accountId: result.accountId,
				botToken: result.botToken,
				...(result.baseUrl ? { baseUrl: result.baseUrl } : {}),
				...(result.userId ? { userId: result.userId } : {})
			};
		})
		.catch((error) => {
			logger.warn('Weixin QR login did not complete', safeErrorFields(error));
			throw error;
		});

	return {
		qrCode: {
			connectionId,
			dataUrl: started.qrcodeUrl,
			expiresAt: new Date(Date.now() + QR_TTL_MS).toISOString()
		},
		completion,
		// The pinned package does not expose cancellation. Its internal session is
		// bounded by the same five-minute TTL and contains no durable credential, so
		// cancelling only has to guarantee the late result is discarded.
		cancel: () => {
			cancelled = true;
		}
	};
}

export async function startQqOfficialLogin(
	logger: Logger,
	connectionId = 'qq-default'
): Promise<PendingOfficialLogin<QqLoginCredential>> {
	const moduleSpecifier = '@tencent-connect/qqbot-connector';
	const connector = (await import(moduleSpecifier)) as {
		startQrConnect(
			callbacks: {
				onQrDisplayed(url: string): void;
				onSuccess(
					credentials: Array<{
						appId: string;
						appSecret: string;
						userOpenid?: string;
					}>
				): void;
				onFailure(error: Error): void;
			},
			options: { displayQrCodeToConsole: boolean; source: string }
		): () => void;
	};

	let resolveQr!: (value: string) => void;
	let rejectQr!: (error: Error) => void;
	const qrReady = new Promise<string>((resolve, reject) => {
		resolveQr = resolve;
		rejectQr = reject;
	});
	let resolveCredential!: (value: QqLoginCredential) => void;
	let rejectCredential!: (error: Error) => void;
	const credentialReady = new Promise<QqLoginCredential>((resolve, reject) => {
		resolveCredential = resolve;
		rejectCredential = reject;
	});
	let settled = false;
	let dispose: () => void = () => undefined;
	try {
		dispose = connector.startQrConnect(
			{
				onQrDisplayed(url) {
					resolveQr(url);
				},
				onSuccess(credentials) {
					if (settled) return;
					settled = true;
					if (credentials.length !== 1) {
						rejectCredential(new Error('qq_login_requires_exactly_one_bot'));
						return;
					}
					const credential = credentials[0]!;
					resolveCredential({
						appId: credential.appId,
						appSecret: credential.appSecret,
						...(credential.userOpenid ? { userOpenid: credential.userOpenid } : {})
					});
				},
				onFailure(error) {
					if (settled) return;
					settled = true;
					rejectQr(error);
					rejectCredential(error);
				}
			},
			{ displayQrCodeToConsole: false, source: 'ryanai' }
		);
	} catch (error) {
		const normalized = error instanceof Error ? error : new Error(String(error));
		rejectQr(normalized);
		rejectCredential(normalized);
	}

	let qrTimer: NodeJS.Timeout | undefined;
	const qrTimeout = new Promise<never>((_resolve, reject) => {
		qrTimer = setTimeout(() => {
			if (!settled) {
				settled = true;
				dispose();
				rejectCredential(new Error('qq_qr_timeout'));
			}
			reject(new Error('qq_qr_timeout'));
		}, 30_000);
		qrTimer.unref();
	});
	let qrDataUrl: string;
	try {
		qrDataUrl = await Promise.race([
			qrReady,
			credentialReady.then(
				() =>
					'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
			),
			qrTimeout
		]);
	} finally {
		if (qrTimer) clearTimeout(qrTimer);
	}
	let completionTimer: NodeJS.Timeout | undefined;
	const completion = Promise.race([
		credentialReady,
		new Promise<never>((_resolve, reject) => {
			completionTimer = setTimeout(() => {
				if (!settled) {
					settled = true;
					dispose();
				}
				reject(new Error('qq_login_timeout'));
			}, QR_TTL_MS);
			completionTimer.unref();
		})
	])
		.finally(() => {
			if (completionTimer) clearTimeout(completionTimer);
		})
		.catch((error) => {
			logger.warn('QQ QR login did not complete', safeErrorFields(error));
			throw error;
		});

	return {
		qrCode: {
			connectionId,
			dataUrl: qrDataUrl,
			expiresAt: new Date(Date.now() + QR_TTL_MS).toISOString()
		},
		completion,
		cancel: () => {
			if (settled) return;
			settled = true;
			dispose();
			rejectCredential(new Error('qq_login_cancelled'));
		}
	};
}
