import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type {
	PluginHookInboundClaimContext,
	PluginHookInboundClaimEvent
} from 'openclaw/plugin-sdk/plugin-entry';

import type { GatewayConfig } from '../config.js';
import { EventValidationError } from '../event.js';
import type { Channel, GatewayInboundEvent, InboundAttachment } from '../types.js';

type UnknownRecord = Record<string, unknown>;

/**
 * Structural union of OpenClaw 2026.7.1-2's message_received and
 * inbound_claim events. inbound_claim carries the authoritative group and
 * mention facts; message_received carries the full standard media metadata.
 */
export interface MessageHookLike {
	content: string;
	from?: string;
	body?: string;
	bodyForAgent?: string;
	transcript?: string;
	timestamp?: number;
	threadId?: string | number;
	messageId?: string;
	senderId?: string;
	senderName?: string;
	senderUsername?: string;
	sessionKey?: string;
	runId?: string;
	channel?: string;
	accountId?: string;
	conversationId?: string;
	parentConversationId?: string;
	isGroup?: boolean;
	wasMentioned?: boolean;
	mediaPath?: string;
	mediaPaths?: string[];
	mediaType?: string;
	mediaTypes?: string[];
	metadata?: UnknownRecord;
}

/**
 * Relevant fields shared by message-hook contexts and the agent context used
 * by before_agent_reply in OpenClaw 2026.7.1-2.
 */
export interface AgentContextLike {
	runId?: string;
	sessionKey?: string;
	channelId?: string;
	accountId?: string;
	conversationId?: string;
	chatId?: string;
	senderId?: string;
	/** Conversation target in an agent hook; this is not the provider id. */
	channel?: string;
	/** Provider/plugin id in an agent hook, for example qqbot. */
	messageProvider?: string;
	channelContext?: {
		sender?: UnknownRecord;
		chat?: UnknownRecord;
	};
}

/** Fixed OpenClaw 2026.7.1-2 fields exposed by the global reply_dispatch hook. */
export interface FinalizedMessageContextLike {
	Body?: string;
	RawBody?: string;
	BodyForCommands?: string;
	From?: string;
	To?: string;
	SessionKey?: string;
	AccountId?: string;
	MessageSid?: string;
	MessageSidFull?: string;
	MessageSidFirst?: string;
	MessageSidLast?: string;
	MediaPath?: string;
	MediaPaths?: string[];
	MediaType?: string;
	MediaTypes?: string[];
	ChatType?: string;
	ConversationLabel?: string;
	GroupSubject?: string;
	SenderId?: string;
	SenderName?: string;
	SenderUsername?: string;
	Timestamp?: number;
	Provider?: string;
	Surface?: string;
	WasMentioned?: boolean;
	ExplicitlyMentionedBot?: boolean;
	GroupRequireMention?: boolean;
	OriginatingChannel?: string;
	OriginatingTo?: string;
	NativeChannelId?: string;
	NativeDirectUserId?: string;
	ChatId?: string;
	ChannelContext?: {
		sender?: UnknownRecord;
		chat?: UnknownRecord;
	};
	[key: string]: unknown;
}

export interface ReplyDispatchHookLike {
	ctx: FinalizedMessageContextLike;
	runId?: string;
	sessionKey?: string;
	originatingChannel?: string;
	originatingTo?: string;
	originatingAccountId?: string;
}

interface AttachmentCandidate {
	localPath: string;
	id?: string;
	fileName?: string;
	contentType?: string;
}

// A process hosts at most one official account for each RyanAI connection.
// A second account must not be silently merged into the same backend identity.
const observedOpenClawAccounts = new Map<Channel, string>();

function record(value: unknown): UnknownRecord {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as UnknownRecord)
		: {};
}

function text(value: unknown): string | undefined {
	if (typeof value === 'string' && value.trim()) return value.trim();
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return undefined;
}

function boolean(...values: unknown[]): boolean | undefined {
	for (const value of values) {
		if (typeof value === 'boolean') return value;
	}
	return undefined;
}

function textArray(value: unknown): Array<string | undefined> {
	return Array.isArray(value) ? value.map((entry) => text(entry)) : [];
}

export function mapOpenClawChannel(value: string | undefined): Channel {
	const normalized = (value || '').trim().toLowerCase();
	if (normalized.includes('weixin') || normalized.includes('wechat')) return 'wechat';
	if (normalized === 'qq' || normalized.includes('qqbot') || normalized.includes('openclaw-qq')) {
		return 'qq';
	}
	throw new EventValidationError('unsupported_openclaw_channel', 'Unsupported OpenClaw channel');
}

function resolveOpenClawChannel(candidates: readonly unknown[]): Channel {
	for (const candidate of candidates) {
		const value = text(candidate);
		if (!value) continue;
		try {
			return mapOpenClawChannel(value);
		} catch (error) {
			if (
				!(error instanceof EventValidationError) ||
				error.code !== 'unsupported_openclaw_channel'
			) {
				throw error;
			}
		}
	}
	throw new EventValidationError('unsupported_openclaw_channel', 'Unsupported OpenClaw channel');
}

/** Resolve the connection that owns this OpenClaw host's account. */
export function mapOpenClawConnectionId(channel: Channel): string {
	const configured = process.env.BOT_GATEWAY_OPENCLAW_CONNECTION_ID?.trim();
	if (configured && configured.startsWith(`${channel}-`)) return configured;
	return `${channel}-default`;
}

function assertSingleOpenClawAccount(
	channel: Channel,
	event: MessageHookLike,
	ctx: AgentContextLike,
	metadata: UnknownRecord,
	bridge: UnknownRecord
): void {
	const accountIds = [
		text(event.accountId),
		text(ctx.accountId),
		text(metadata.accountId),
		text(bridge.account_id)
	].filter((value): value is string => Boolean(value));
	const distinct = new Set(accountIds);
	if (distinct.size > 1) {
		throw new EventValidationError(
			'multiple_openclaw_accounts',
			'Conflicting OpenClaw account ids are not supported'
		);
	}
	const accountId = accountIds[0];
	if (!accountId) return;
	const observed = observedOpenClawAccounts.get(channel);
	if (observed && observed !== accountId) {
		throw new EventValidationError(
			'multiple_openclaw_accounts',
			`Multiple OpenClaw ${channel} accounts are not supported`
		);
	}
	observedOpenClawAccounts.set(channel, accountId);
}

function resolveConnectionId(channel: Channel, bridge: UnknownRecord): string {
	const connectionId = mapOpenClawConnectionId(channel);
	const requested = text(bridge.connection_id);
	if (requested && requested !== connectionId) {
		throw new EventValidationError(
			'unsupported_openclaw_connection',
			'OpenClaw event connection does not belong to this host'
		);
	}
	return connectionId;
}

function trustedPath(candidate: string, roots: readonly string[]): Promise<string> {
	return realpath(candidate).then(async (resolved) => {
		for (const root of roots) {
			let resolvedRoot: string;
			try {
				resolvedRoot = await realpath(root);
			} catch {
				continue;
			}
			const relative = path.relative(resolvedRoot, resolved);
			if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return resolved;
			if (relative === '') return resolved;
		}
		throw new EventValidationError('untrusted_attachment_path', 'Attachment path is not trusted');
	});
}

function appendAttachmentCandidate(
	candidates: AttachmentCandidate[],
	candidate: AttachmentCandidate
): void {
	const existing = candidates.find((entry) => entry.localPath === candidate.localPath);
	if (!existing) {
		candidates.push(candidate);
		return;
	}
	existing.id ||= candidate.id;
	existing.fileName ||= candidate.fileName;
	existing.contentType ||= candidate.contentType;
}

function appendStandardMedia(source: UnknownRecord, candidates: AttachmentCandidate[]): void {
	const paths = textArray(source.mediaPaths);
	const types = textArray(source.mediaTypes);
	for (let index = 0; index < paths.length; index += 1) {
		const localPath = paths[index];
		if (!localPath) continue;
		appendAttachmentCandidate(candidates, {
			localPath,
			...(types[index] ? { contentType: types[index] } : {})
		});
	}

	const localPath = text(source.mediaPath);
	if (localPath) {
		appendAttachmentCandidate(candidates, {
			localPath,
			...(text(source.mediaType) ? { contentType: text(source.mediaType) } : {})
		});
	}
}

function collectAttachmentCandidates(
	event: MessageHookLike,
	metadata: UnknownRecord,
	bridge: UnknownRecord
): AttachmentCandidate[] {
	const candidates: AttachmentCandidate[] = [];

	// These lower-camel-case fields are emitted by OpenClaw's fixed-version
	// message-hook mapper from MsgContext.MediaPath(s)/MediaType(s).
	appendStandardMedia(record(event), candidates);
	appendStandardMedia(metadata, candidates);

	// Keep the original bridge extension compatible, but standard OpenClaw
	// fields above are sufficient on their own.
	const legacyAttachments = Array.isArray(bridge.attachments) ? bridge.attachments : [];
	for (const item of legacyAttachments) {
		const value = record(item);
		const localPath = text(value.path);
		if (!localPath) {
			throw new EventValidationError(
				'attachment_path_required',
				'OpenClaw attachment path is required'
			);
		}
		appendAttachmentCandidate(candidates, {
			localPath,
			...(text(value.id) ? { id: text(value.id) } : {}),
			...(text(value.file_name) ? { fileName: text(value.file_name) } : {}),
			...(text(value.content_type) ? { contentType: text(value.content_type) } : {})
		});
	}

	return candidates;
}

async function loadAttachments(
	event: MessageHookLike,
	metadata: UnknownRecord,
	bridge: UnknownRecord,
	config: GatewayConfig
): Promise<InboundAttachment[]> {
	const candidates = collectAttachmentCandidates(event, metadata, bridge);
	const attachments: InboundAttachment[] = [];
	const resolvedPaths = new Set<string>();
	let total = 0;

	for (const candidate of candidates) {
		const resolved = await trustedPath(candidate.localPath, config.attachmentRoots);
		if (resolvedPaths.has(resolved)) continue;
		resolvedPaths.add(resolved);

		const fileStat = await stat(resolved);
		if (!fileStat.isFile() || fileStat.size > config.maxAttachmentBytes) {
			throw new EventValidationError(
				'attachment_too_large',
				'OpenClaw attachment is invalid or too large'
			);
		}
		total += fileStat.size;
		if (total > config.maxTotalAttachmentBytes) {
			throw new EventValidationError('attachments_too_large', 'OpenClaw attachments are too large');
		}
		attachments.push({
			id: candidate.id || `attachment-${attachments.length + 1}`,
			fileName: candidate.fileName || path.basename(resolved),
			contentType: candidate.contentType || 'application/octet-stream',
			bytes: await readFile(resolved)
		});
	}
	return attachments;
}

function stableEventId(parts: readonly (string | number | undefined)[]): string {
	return `openclaw-${createHash('sha256')
		.update(parts.map((part) => String(part ?? '')).join('\u0000'))
		.digest('hex')}`;
}

function channelContextFacts(ctx: AgentContextLike): {
	sender: UnknownRecord;
	chat: UnknownRecord;
} {
	return {
		sender: record(ctx.channelContext?.sender),
		chat: record(ctx.channelContext?.chat)
	};
}

function isGroupKind(value: unknown): boolean {
	const normalized = text(value)?.toLowerCase();
	return normalized === 'group' || normalized === 'room' || normalized === 'guild';
}

function hasGroupTarget(values: readonly unknown[]): boolean {
	return values.some((value) => {
		const normalized = text(value)?.toLowerCase();
		if (!normalized) return false;
		return (
			/(?:^|:)group(?::|$)/.test(normalized) ||
			/(?:^|:)guild(?::|$)/.test(normalized) ||
			normalized.startsWith('group/') ||
			normalized.startsWith('guild/')
		);
	});
}

function resolveGroupFact(
	event: MessageHookLike,
	ctx: AgentContextLike,
	metadata: UnknownRecord,
	bridge: UnknownRecord,
	facts: ReturnType<typeof channelContextFacts>,
	conversationId: string
): boolean {
	const explicit = boolean(
		event.isGroup,
		metadata.isGroup,
		metadata.is_group,
		facts.chat.isGroup,
		bridge.is_group
	);
	if (explicit !== undefined) return explicit;

	if (
		isGroupKind(metadata.chatType) ||
		isGroupKind(metadata.conversationType) ||
		isGroupKind(facts.chat.type) ||
		isGroupKind(bridge.conversation_type)
	) {
		return true;
	}

	if (text(metadata.groupId) || text(metadata.guildId) || text(metadata.channelName)) return true;
	return hasGroupTarget([
		conversationId,
		event.conversationId,
		event.from,
		metadata.from,
		metadata.to,
		metadata.originatingTo,
		ctx.conversationId,
		ctx.channel,
		ctx.chatId
	]);
}

function resolveMentionFact(
	event: MessageHookLike,
	metadata: UnknownRecord,
	bridge: UnknownRecord,
	facts: ReturnType<typeof channelContextFacts>
): boolean {
	return (
		boolean(
			event.wasMentioned,
			metadata.wasMentioned,
			metadata.mentionsBot,
			metadata.mentions_bot,
			facts.chat.wasMentioned,
			bridge.mentions_bot
		) === true
	);
}

export async function normalizeMessageHook(
	event: MessageHookLike,
	ctx: AgentContextLike,
	config: GatewayConfig
): Promise<GatewayInboundEvent> {
	const metadata = record(event.metadata);
	const bridge = record(metadata.ryanai);
	const facts = channelContextFacts(ctx);
	const channel = resolveOpenClawChannel([
		event.channel,
		metadata.originatingChannel,
		metadata.provider,
		metadata.surface,
		ctx.messageProvider,
		ctx.channelId,
		bridge.channel,
		metadata.channel_id
	]);
	assertSingleOpenClawAccount(channel, event, ctx, metadata, bridge);

	const conversationId =
		text(event.conversationId) ||
		text(ctx.conversationId) ||
		text(facts.chat.id) ||
		text(metadata.originatingTo) ||
		text(metadata.to) ||
		text(ctx.channel) ||
		text(ctx.chatId) ||
		text(event.from) ||
		text(metadata.from);
	if (!conversationId) {
		throw new EventValidationError('missing_openclaw_context', 'OpenClaw conversation is missing');
	}

	const isGroup = resolveGroupFact(event, ctx, metadata, bridge, facts, conversationId);
	const senderId =
		text(event.senderId) ||
		text(ctx.senderId) ||
		text(metadata.senderId) ||
		text(facts.sender.id) ||
		(!isGroup ? text(event.from) || text(metadata.from) : undefined);
	if (!senderId) {
		throw new EventValidationError('missing_openclaw_context', 'OpenClaw sender is missing');
	}

	const occurredAt = event.timestamp || Date.now();
	const eventId =
		event.messageId ||
		text(metadata.messageId) ||
		text(metadata.message_id) ||
		ctx.runId ||
		event.runId ||
		stableEventId([
			channel,
			event.accountId || ctx.accountId,
			conversationId,
			senderId,
			occurredAt,
			event.content
		]);
	const conversationName =
		text(bridge.conversation_name) || text(metadata.channelName) || text(facts.chat.name);
	const senderName =
		text(event.senderName) ||
		text(bridge.sender_name) ||
		text(metadata.senderName) ||
		text(facts.sender.name);

	return {
		eventId,
		occurredAt,
		channel,
		connectionId: resolveConnectionId(channel, bridge),
		conversation: {
			type: isGroup ? 'group' : 'private',
			id: conversationId,
			...(conversationName ? { name: conversationName } : {})
		},
		sender: {
			id: senderId,
			...(senderName ? { name: senderName } : {})
		},
		message: {
			text: event.content || '',
			// Unknown mention state must stay false in groups so the whitelist and
			// mention gates cannot be bypassed by a lossy hook payload.
			mentionsBot: !isGroup || resolveMentionFact(event, metadata, bridge, facts)
		},
		attachments: await loadAttachments(event, metadata, bridge, config)
	};
}

/**
 * Preferred normalization entry point for the typed OpenClaw inbound_claim
 * hook. Its channel and group facts are authoritative and are validated
 * before the compatibility normalizer considers any metadata fallbacks.
 */
export async function normalizeInboundClaim(
	event: PluginHookInboundClaimEvent,
	ctx: PluginHookInboundClaimContext,
	config: GatewayConfig
): Promise<GatewayInboundEvent> {
	mapOpenClawChannel(event.channel);
	if (typeof event.isGroup !== 'boolean') {
		throw new EventValidationError(
			'invalid_openclaw_claim',
			'OpenClaw inbound_claim isGroup must be a boolean'
		);
	}
	return normalizeMessageHook(event, ctx, config);
}

/**
 * Normalize the fixed-version global reply_dispatch hook. Unlike
 * inbound_claim this hook runs for ordinary, unbound channel conversations
 * and still executes before OpenClaw resolves or invokes any model.
 */
export async function normalizeReplyDispatch(
	event: ReplyDispatchHookLike,
	config: GatewayConfig
): Promise<GatewayInboundEvent> {
	const source = event.ctx;
	const channel = resolveOpenClawChannel([
		source.Provider,
		source.Surface,
		source.OriginatingChannel,
		event.originatingChannel
	]);
	const channelFacts = {
		sender: record(source.ChannelContext?.sender),
		chat: record(source.ChannelContext?.chat)
	};
	const isGroup =
		isGroupKind(source.ChatType) ||
		boolean(channelFacts.chat.isGroup) === true ||
		Boolean(text(source.QQGroupOpenid));
	const senderId =
		text(source.SenderId) ||
		text(channelFacts.sender.id) ||
		text(source.NativeDirectUserId) ||
		(!isGroup ? text(source.From) : undefined);
	if (!senderId) {
		throw new EventValidationError('missing_openclaw_context', 'OpenClaw sender is missing');
	}
	const conversationId = isGroup
		? text(source.QQGroupOpenid) ||
			text(source.NativeChannelId) ||
			text(source.ChatId) ||
			text(source.OriginatingTo) ||
			text(event.originatingTo) ||
			text(source.To) ||
			text(source.From)
		: senderId ||
			text(source.NativeDirectUserId) ||
			text(source.ChatId) ||
			text(source.OriginatingTo) ||
			text(event.originatingTo) ||
			text(source.From);
	if (!conversationId) {
		throw new EventValidationError('missing_openclaw_context', 'OpenClaw conversation is missing');
	}
	const explicitMention = boolean(
		source.WasMentioned,
		source.ExplicitlyMentionedBot,
		channelFacts.chat.wasMentioned
	);
	// QQ's pinned plugin applies its mention gate before dispatch. With the
	// generated defaultRequireMention=true config, a group turn reaching this
	// global hook is therefore an authoritative mention even though QQ 2.0.0
	// does not copy WasMentioned onto FinalizedMsgContext.
	const wasMentioned =
		!isGroup ||
		explicitMention === true ||
		(channel === 'qq' && source.GroupRequireMention !== false);
	const rawContent =
		[source.RawBody, source.BodyForCommands, source.Body].find(
			(value): value is string => typeof value === 'string'
		) ?? '';
	let timestamp = typeof source.Timestamp === 'number' ? source.Timestamp : Date.now();
	if (timestamp > 0 && timestamp < 10_000_000_000) timestamp *= 1_000;

	return normalizeMessageHook(
		{
			content: rawContent,
			timestamp,
			messageId:
				text(source.MessageSidFull) ||
				text(source.MessageSid) ||
				text(source.MessageSidFirst) ||
				text(source.MessageSidLast),
			senderId,
			senderName: text(source.SenderName),
			senderUsername: text(source.SenderUsername),
			sessionKey: text(source.SessionKey) || event.sessionKey,
			runId: event.runId,
			channel,
			accountId: text(source.AccountId) || event.originatingAccountId,
			conversationId,
			isGroup,
			wasMentioned,
			mediaPath: text(source.MediaPath),
			mediaPaths: Array.isArray(source.MediaPaths) ? source.MediaPaths : undefined,
			mediaType: text(source.MediaType),
			mediaTypes: Array.isArray(source.MediaTypes) ? source.MediaTypes : undefined,
			metadata: {
				chatType: source.ChatType,
				originatingTo: source.OriginatingTo || event.originatingTo,
				channelName: source.GroupSubject || source.ConversationLabel,
				mentionsBot: wasMentioned
			}
		},
		{
			runId: event.runId,
			sessionKey: text(source.SessionKey) || event.sessionKey,
			channelId: channel,
			accountId: text(source.AccountId) || event.originatingAccountId,
			conversationId,
			senderId,
			channelContext: source.ChannelContext
		},
		config
	);
}

export function normalizeBeforeAgentReply(
	cleanedBody: string,
	ctx: AgentContextLike
): GatewayInboundEvent {
	const facts = channelContextFacts(ctx);
	// In an agent hook channel/channelId are conversation targets. The provider
	// is messageProvider, so it must be considered first.
	const channel = resolveOpenClawChannel([ctx.messageProvider, ctx.channelId]);
	const conversationId =
		text(ctx.conversationId) || text(facts.chat.id) || text(ctx.channel) || text(ctx.chatId);
	if (!conversationId) {
		throw new EventValidationError('missing_openclaw_context', 'OpenClaw conversation is missing');
	}

	const explicitGroup = boolean(facts.chat.isGroup);
	const isGroup =
		explicitGroup ??
		(isGroupKind(facts.chat.type) ||
			hasGroupTarget([conversationId, ctx.channel, ctx.channelId, ctx.sessionKey]));
	const senderId = text(ctx.senderId) || text(facts.sender.id);
	if (!senderId) {
		throw new EventValidationError('missing_openclaw_context', 'OpenClaw sender is missing');
	}

	return {
		eventId:
			ctx.runId || stableEventId([channel, ctx.accountId, conversationId, senderId, cleanedBody]),
		occurredAt: Date.now(),
		channel,
		connectionId: mapOpenClawConnectionId(channel),
		conversation: { type: isGroup ? 'group' : 'private', id: conversationId },
		sender: { id: senderId },
		message: {
			text: cleanedBody,
			mentionsBot: !isGroup || boolean(facts.chat.wasMentioned) === true
		},
		attachments: []
	};
}
