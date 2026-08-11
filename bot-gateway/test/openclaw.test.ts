import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type {
	PluginHookInboundClaimContext,
	PluginHookInboundClaimEvent
} from 'openclaw/plugin-sdk/plugin-entry';

import { EventValidationError, validateEvent } from '../src/event.js';
import { PendingMessageCache } from '../src/openclaw/cache.js';
import {
	mapOpenClawChannel,
	mapOpenClawConnectionId,
	normalizeBeforeAgentReply,
	normalizeInboundClaim,
	normalizeMessageHook,
	normalizeReplyDispatch,
	type MessageHookLike
} from '../src/openclaw/normalize.js';
import { inboundEvent, testConfig } from './helpers.js';

// Shape emitted by OpenClaw 2026.7.1-2's typed inbound_claim mapper for the
// @tencent-connect/openclaw-qqbot 2.0.0 group target qqbot:group:<openid>.
const QQ_GROUP_CLAIM = {
	content: '群里的问题',
	timestamp: 1_786_285_200_000,
	channel: 'qqbot',
	accountId: 'default',
	conversationId: 'group:group-openid-42',
	senderId: 'member-openid-7',
	senderName: '群成员',
	messageId: 'qq-message-1001',
	sessionKey: 'agent:default:qqbot:group:group-openid-42',
	runId: 'run-qq-1001',
	isGroup: true,
	wasMentioned: false,
	metadata: {
		from: 'qqbot:group:group-openid-42',
		to: 'qqbot:group:group-openid-42',
		provider: 'qqbot',
		surface: 'qqbot',
		originatingChannel: 'qqbot',
		originatingTo: 'qqbot:group:group-openid-42',
		groupId: 'qqbot:group:group-openid-42'
	}
} satisfies PluginHookInboundClaimEvent;

const QQ_GROUP_CONTEXT = {
	channelId: 'qqbot',
	accountId: 'default',
	conversationId: 'group:group-openid-42',
	senderId: 'member-openid-7',
	messageId: 'qq-message-1001',
	sessionKey: 'agent:default:qqbot:group:group-openid-42',
	runId: 'run-qq-1001'
} satisfies PluginHookInboundClaimContext;

// @tencent-weixin/openclaw-weixin 2.4.6 uses a real login account id rather
// than requiring OpenClaw's literal "default" account id.
const WECHAT_PRIVATE_CLAIM = {
	content: '微信私聊消息',
	timestamp: 1_786_285_201_000,
	channel: 'openclaw-weixin',
	accountId: 'wx-live-account-7',
	conversationId: 'user-88@im.wechat',
	senderId: 'user-88@im.wechat',
	messageId: 'weixin-message-2001',
	sessionKey: 'agent:default:openclaw-weixin:user-88@im.wechat',
	runId: 'run-weixin-2001',
	isGroup: false,
	metadata: {
		from: 'user-88@im.wechat',
		to: 'user-88@im.wechat',
		provider: 'openclaw-weixin',
		surface: 'openclaw-weixin',
		originatingChannel: 'openclaw-weixin',
		originatingTo: 'user-88@im.wechat'
	}
} satisfies PluginHookInboundClaimEvent;

const WECHAT_PRIVATE_CONTEXT = {
	channelId: 'openclaw-weixin',
	accountId: 'wx-live-account-7',
	conversationId: 'user-88@im.wechat',
	senderId: 'user-88@im.wechat',
	messageId: 'weixin-message-2001',
	sessionKey: 'agent:default:openclaw-weixin:user-88@im.wechat',
	runId: 'run-weixin-2001'
} satisfies PluginHookInboundClaimContext;

test('OpenClaw channel aliases normalize to the unified channel values', () => {
	assert.equal(mapOpenClawChannel('openclaw-weixin'), 'wechat');
	assert.equal(mapOpenClawChannel('qqbot'), 'qq');
	assert.throws(() => mapOpenClawChannel('telegram'));
});

test('official accounts use defaults when no isolated connection id is configured', () => {
	assert.equal(mapOpenClawConnectionId('wechat'), 'wechat-default');
	assert.equal(mapOpenClawConnectionId('qq'), 'qq-default');
});

test('isolated OpenClaw hosts preserve their authoritative RyanAI connection id', (t) => {
	const previous = process.env.BOT_GATEWAY_OPENCLAW_CONNECTION_ID;
	t.after(() => {
		if (previous === undefined) delete process.env.BOT_GATEWAY_OPENCLAW_CONNECTION_ID;
		else process.env.BOT_GATEWAY_OPENCLAW_CONNECTION_ID = previous;
	});

	process.env.BOT_GATEWAY_OPENCLAW_CONNECTION_ID =
		'bot-wechat-7eb5523c-7ab2-4c58-82dc-129600bada86';
	assert.equal(
		mapOpenClawConnectionId('wechat'),
		'bot-wechat-7eb5523c-7ab2-4c58-82dc-129600bada86'
	);

	process.env.BOT_GATEWAY_OPENCLAW_CONNECTION_ID =
		'bot-qq-7eb5523c-7ab2-4c58-82dc-129600bada86';
	assert.equal(
		mapOpenClawConnectionId('qq'),
		'bot-qq-7eb5523c-7ab2-4c58-82dc-129600bada86'
	);
});

test('typed inbound_claim preserves QQ group and mention facts before whitelist checks', async () => {
	const normalized = await normalizeInboundClaim(
		{
			...QQ_GROUP_CLAIM,
			// First-class typed facts must win over optional metadata extensions.
			metadata: { ...QQ_GROUP_CLAIM.metadata, isGroup: false, wasMentioned: true }
		},
		QQ_GROUP_CONTEXT,
		testConfig('unused')
	);

	assert.equal(normalized.channel, 'qq');
	assert.equal(normalized.connectionId, 'qq-default');
	assert.equal(normalized.conversation.type, 'group');
	assert.equal(normalized.conversation.id, 'group:group-openid-42');
	assert.equal(normalized.sender.id, 'member-openid-7');
	assert.equal(normalized.message.mentionsBot, false);

	const mentioned = await normalizeInboundClaim(
		{ ...QQ_GROUP_CLAIM, messageId: 'qq-message-1002', wasMentioned: true },
		{ ...QQ_GROUP_CONTEXT, messageId: 'qq-message-1002' },
		testConfig('unused')
	);
	assert.equal(mentioned.message.mentionsBot, true);
});

test('global reply_dispatch normalizes ordinary QQ group turns before model resolution', async () => {
	const normalized = await normalizeReplyDispatch(
		{
			ctx: {
				Provider: 'qqbot',
				Surface: 'qqbot',
				AccountId: 'default',
				ChatType: 'group',
				QQGroupOpenid: 'group-openid-42',
				SenderId: 'member-openid-7',
				SenderName: '群成员',
				RawBody: '普通群消息',
				MessageSid: 'qq-message-reply-dispatch-1',
				Timestamp: 1_786_285_200_000
			}
		},
		testConfig('unused')
	);

	assert.equal(normalized.channel, 'qq');
	assert.equal(normalized.connectionId, 'qq-default');
	assert.equal(normalized.conversation.type, 'group');
	assert.equal(normalized.conversation.id, 'group-openid-42');
	assert.equal(normalized.sender.id, 'member-openid-7');
	assert.equal(normalized.message.mentionsBot, true);
});

test('global reply_dispatch hashes official QQ message ids with unsupported punctuation', async () => {
	const officialId =
		'ROBOT1.0_zV-VTDQEqwsknqVuqde01yLgOsrRfyg-FHU8tVRvECETboV7o0V9pt83vhnx.t7luWZIUQq2KSh4TpFW61yjLr3ngGb.Wl-sLP-ZQpRmBmM!';
	const input = {
		ctx: {
			Provider: 'qqbot',
			Surface: 'qqbot',
			AccountId: 'default',
			ChatType: 'private',
			SenderId: 'member-openid-7',
			RawBody: '真实 QQ 私聊消息',
			MessageSid: officialId,
			Timestamp: 1_786_285_200_000
		}
	};
	const config = testConfig('unused');
	const first = await normalizeReplyDispatch(input, config);
	const second = await normalizeReplyDispatch(input, config);

	assert.notEqual(first.eventId, officialId);
	assert.match(first.eventId, /^openclaw-[a-f0-9]{64}$/);
	assert.equal(second.eventId, first.eventId);
	assert.doesNotThrow(() => validateEvent(first, config, first.occurredAt));
});

test('typed WeChat claim with a real non-default bot account still maps to wechat-default', async () => {
	const normalized = await normalizeInboundClaim(
		WECHAT_PRIVATE_CLAIM,
		WECHAT_PRIVATE_CONTEXT,
		testConfig('unused')
	);

	assert.equal(normalized.channel, 'wechat');
	assert.equal(normalized.connectionId, 'wechat-default');
	assert.equal(normalized.conversation.type, 'private');
	assert.equal(normalized.message.mentionsBot, true);
});

test('typed inbound_claim reads trusted standard mediaPath and rejects an untrusted path', async (t) => {
	const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'ryanai-openclaw-claim-'));
	t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
	const trustedRoot = path.join(fixtureRoot, 'trusted');
	const outsideRoot = path.join(fixtureRoot, 'outside');
	await Promise.all([
		mkdir(trustedRoot, { recursive: true }),
		mkdir(outsideRoot, { recursive: true })
	]);
	const trustedFile = path.join(trustedRoot, 'photo.bin');
	const untrustedFile = path.join(outsideRoot, 'secret.bin');
	await Promise.all([
		writeFile(trustedFile, Buffer.from([1, 2, 3, 4])),
		writeFile(untrustedFile, Buffer.from([9, 8, 7]))
	]);
	const config = testConfig(fixtureRoot, { attachmentRoots: [trustedRoot] });

	const normalized = await normalizeInboundClaim(
		{
			...WECHAT_PRIVATE_CLAIM,
			messageId: 'weixin-message-media-1',
			metadata: { ...WECHAT_PRIVATE_CLAIM.metadata, mediaPath: trustedFile }
		},
		{ ...WECHAT_PRIVATE_CONTEXT, messageId: 'weixin-message-media-1' },
		config
	);
	assert.equal(normalized.attachments.length, 1);
	assert.equal(normalized.attachments[0]?.fileName, 'photo.bin');
	assert.equal(normalized.attachments[0]?.contentType, 'application/octet-stream');
	assert.deepEqual(normalized.attachments[0]?.bytes, Buffer.from([1, 2, 3, 4]));

	await assert.rejects(
		normalizeInboundClaim(
			{
				...WECHAT_PRIVATE_CLAIM,
				messageId: 'weixin-message-media-2',
				metadata: { ...WECHAT_PRIVATE_CLAIM.metadata, mediaPath: untrustedFile }
			},
			{ ...WECHAT_PRIVATE_CONTEXT, messageId: 'weixin-message-media-2' },
			config
		),
		(error: unknown) =>
			error instanceof EventValidationError && error.code === 'untrusted_attachment_path'
	);
});

test('typed WeChat image wildcard is replaced with the concrete MIME from file bytes', async (t) => {
	const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'ryanai-openclaw-wechat-image-'));
	t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
	const imagePath = path.join(fixtureRoot, 'downloaded-image.png');
	const png = Buffer.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d
	]);
	await writeFile(imagePath, png);

	const normalized = await normalizeInboundClaim(
		{
			...WECHAT_PRIVATE_CLAIM,
			content: '',
			messageId: 'weixin-message-image-wildcard',
			metadata: {
				...WECHAT_PRIVATE_CLAIM.metadata,
				mediaPath: imagePath,
				mediaType: 'image/*'
			}
		},
		{ ...WECHAT_PRIVATE_CONTEXT, messageId: 'weixin-message-image-wildcard' },
		testConfig(fixtureRoot, { attachmentRoots: [fixtureRoot] })
	);

	assert.equal(normalized.attachments.length, 1);
	assert.equal(normalized.attachments[0]?.contentType, 'image/png');
	assert.deepEqual(normalized.attachments[0]?.bytes, png);
	assert.doesNotThrow(() => validateEvent(normalized, testConfig(fixtureRoot), normalized.occurredAt));
});

test('OpenClaw ordinary files infer concrete document types and preserve unknown binaries', async (t) => {
	const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'ryanai-openclaw-files-'));
	t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
	const pdfPath = path.join(fixtureRoot, 'report.pdf');
	const docxPath = path.join(fixtureRoot, 'minutes.docx');
	const binaryPath = path.join(fixtureRoot, 'archive.bin');
	await Promise.all([
		writeFile(pdfPath, Buffer.from('%PDF-1.7\nfixture')),
		writeFile(docxPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])),
		writeFile(binaryPath, Buffer.from([0, 1, 2, 3]))
	]);

	const normalized = await normalizeMessageHook(
		{
			...WECHAT_PRIVATE_CLAIM,
			content: '请处理这些文件',
			messageId: 'weixin-message-files',
			mediaPaths: [pdfPath, docxPath, binaryPath],
			mediaTypes: ['application/octet-stream', 'application/*']
		},
		WECHAT_PRIVATE_CONTEXT,
		testConfig(fixtureRoot, { attachmentRoots: [fixtureRoot] })
	);

	assert.deepEqual(
		normalized.attachments.map(({ fileName, contentType }) => ({ fileName, contentType })),
		[
			{ fileName: 'report.pdf', contentType: 'application/pdf' },
			{
				fileName: 'minutes.docx',
				contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
			},
			{ fileName: 'archive.bin', contentType: 'application/octet-stream' }
		]
	);
	assert.doesNotThrow(() => validateEvent(normalized, testConfig(fixtureRoot), normalized.occurredAt));
});

test('message_received fallback recognizes QQ group targets and standard media arrays', async (t) => {
	const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'ryanai-openclaw-message-'));
	t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
	const imagePath = path.join(fixtureRoot, 'image.png');
	const filePath = path.join(fixtureRoot, 'notes.txt');
	await Promise.all([
		writeFile(imagePath, Buffer.from('png')),
		writeFile(filePath, Buffer.from('notes'))
	]);

	// Exact lower-camel media metadata produced by OpenClaw's
	// toPluginMessageReceivedEvent mapper from QQ's MediaPath(s)/MediaType(s).
	const event = {
		from: 'qqbot:group:group-openid-42',
		content: '带附件的群消息',
		timestamp: 1_786_285_202_000,
		messageId: 'qq-message-media-1',
		senderId: 'member-openid-7',
		sessionKey: 'agent:default:qqbot:group:group-openid-42',
		runId: 'run-qq-media-1',
		metadata: {
			to: 'qqbot:group:group-openid-42',
			provider: 'qqbot',
			surface: 'qqbot',
			originatingChannel: 'qqbot',
			originatingTo: 'qqbot:group:group-openid-42',
			mediaPath: imagePath,
			mediaType: 'image/png',
			mediaPaths: [imagePath, filePath],
			mediaTypes: ['image/png', 'text/plain']
		}
	} satisfies MessageHookLike;
	const normalized = await normalizeMessageHook(
		event,
		{
			channelId: 'opaque-conversation-target',
			accountId: 'default',
			conversationId: 'qqbot:group:group-openid-42',
			senderId: 'member-openid-7',
			runId: 'run-qq-media-1'
		},
		testConfig(fixtureRoot, { attachmentRoots: [fixtureRoot] })
	);

	assert.equal(normalized.channel, 'qq');
	assert.equal(normalized.conversation.type, 'group');
	assert.equal(normalized.message.mentionsBot, false);
	assert.deepEqual(
		normalized.attachments.map(({ fileName, contentType }) => ({ fileName, contentType })),
		[
			{ fileName: 'image.png', contentType: 'image/png' },
			{ fileName: 'notes.txt', contentType: 'text/plain' }
		]
	);
});

test('before_agent_reply fallback uses messageProvider instead of the conversation channel', () => {
	const event = normalizeBeforeAgentReply('hello', {
		runId: 'run-fallback',
		messageProvider: 'qqbot',
		channelId: 'opaque-conversation-target',
		channel: 'qqbot:group:group-openid-42',
		accountId: 'default',
		senderId: 'member-openid-7',
		channelContext: {
			sender: { id: 'member-openid-7' },
			chat: { type: 'group', id: 'group-openid-42', isGroup: true, wasMentioned: true }
		}
	});
	assert.equal(event.eventId, 'run-fallback');
	assert.equal(event.channel, 'qq');
	assert.equal(event.connectionId, 'qq-default');
	assert.equal(event.conversation.type, 'group');
	assert.equal(event.conversation.id, 'group-openid-42');
	assert.equal(event.sender.id, 'member-openid-7');
	assert.equal(event.message.mentionsBot, true);
});

test('pending message cache correlates message_received with before_agent_reply', () => {
	const cache = new PendingMessageCache(1_000);
	const event = inboundEvent();
	cache.put({ runId: 'run-1', sessionKey: 'session-1' }, event, 100);
	assert.equal(cache.take({ runId: 'run-1' }, 200), event);
	assert.equal(cache.take({ sessionKey: 'session-1' }, 200), undefined);
});

test('typed inbound_claim rejects dynamic RyanAI connection ids', async () => {
	await assert.rejects(
		normalizeInboundClaim(
			{
				...WECHAT_PRIVATE_CLAIM,
				messageId: 'weixin-message-dynamic-connection',
				metadata: {
					...WECHAT_PRIVATE_CLAIM.metadata,
					ryanai: { connection_id: 'wechat-secondary' }
				}
			},
			{ ...WECHAT_PRIVATE_CONTEXT, messageId: 'weixin-message-dynamic-connection' },
			testConfig('unused')
		),
		(error: unknown) =>
			error instanceof EventValidationError && error.code === 'unsupported_openclaw_connection'
	);
});

test('typed inbound_claim fails closed when a second WeChat account is observed', async () => {
	await assert.rejects(
		normalizeInboundClaim(
			{
				...WECHAT_PRIVATE_CLAIM,
				accountId: 'wx-second-account',
				messageId: 'weixin-message-second-account'
			},
			{
				...WECHAT_PRIVATE_CONTEXT,
				accountId: 'wx-second-account',
				messageId: 'weixin-message-second-account'
			},
			testConfig('unused')
		),
		(error: unknown) =>
			error instanceof EventValidationError && error.code === 'multiple_openclaw_accounts'
	);
});
