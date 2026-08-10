import path from 'node:path';

import type { GatewayConfig } from './config.js';
import type {
	Channel,
	GatewayInboundEvent,
	InboundAttachment,
	MockAttachmentInput,
	MockEventInput
} from './types.js';

export class EventValidationError extends Error {
	constructor(
		readonly code: string,
		message: string
	) {
		super(message);
		this.name = 'EventValidationError';
	}
}

function requiredString(value: unknown, field: string, maxLength = 512): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new EventValidationError('invalid_event', `${field} is required`);
	}
	const normalized = value.trim();
	if (normalized.length > maxLength || /[\u0000-\u001F\u007F]/.test(normalized)) {
		throw new EventValidationError('invalid_event', `${field} is invalid`);
	}
	return normalized;
}

function optionalString(value: unknown, field: string, maxLength = 512): string | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	return requiredString(value, field, maxLength);
}

function safeFileName(value: string): string {
	const base = path.basename(value.replaceAll('\\', '/')).replace(/[\u0000-\u001F\u007F]/g, '_');
	const shortened = Array.from(base).slice(0, 180).join('');
	return shortened || 'attachment.bin';
}

function parseBase64Attachment(input: MockAttachmentInput, index: number): InboundAttachment {
	const encoded = requiredString(input.base64, `attachments[${index}].base64`, 400_000_000).replace(
		/\s/g,
		''
	);
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
		throw new EventValidationError(
			'invalid_attachment',
			`attachments[${index}] is not valid base64`
		);
	}
	const bytes = Buffer.from(encoded, 'base64');
	return {
		id: optionalString(input.id, `attachments[${index}].id`) || `attachment-${index + 1}`,
		fileName: safeFileName(requiredString(input.file_name, `attachments[${index}].file_name`)),
		contentType:
			optionalString(input.content_type, `attachments[${index}].content_type`, 200) ||
			'application/octet-stream',
		bytes
	};
}

function parseOccurredAt(value: string | number | undefined): number {
	if (value === undefined) return Date.now();
	const parsed = typeof value === 'number' ? value : Date.parse(value);
	if (!Number.isFinite(parsed)) {
		throw new EventValidationError('invalid_event', 'occurred_at is invalid');
	}
	return parsed;
}

export function parseMockEvent(input: unknown): GatewayInboundEvent {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new EventValidationError('invalid_event', 'Request body must be an object');
	}
	const value = input as Partial<MockEventInput>;
	if (value.channel !== 'wechat' && value.channel !== 'qq') {
		throw new EventValidationError('invalid_event', 'channel must be wechat or qq');
	}
	if (!value.conversation || !value.sender || !value.message) {
		throw new EventValidationError(
			'invalid_event',
			'conversation, sender and message are required'
		);
	}
	if (value.conversation.type !== 'private' && value.conversation.type !== 'group') {
		throw new EventValidationError('invalid_event', 'conversation.type must be private or group');
	}

	return {
		eventId: requiredString(value.event_id, 'event_id', 256),
		occurredAt: parseOccurredAt(value.occurred_at),
		channel: value.channel,
		connectionId:
			optionalString(value.connection_id, 'connection_id') || `${value.channel}-default`,
		conversation: {
			type: value.conversation.type,
			id: requiredString(value.conversation.id, 'conversation.id'),
			name: optionalString(value.conversation.name, 'conversation.name')
		},
		sender: {
			id: requiredString(value.sender.id, 'sender.id'),
			name: optionalString(value.sender.name, 'sender.name')
		},
		message: {
			text: typeof value.message.text === 'string' ? value.message.text : '',
			mentionsBot: value.message.mentions_bot === true
		},
		attachments: (value.attachments || []).map(parseBase64Attachment)
	};
}

export function validateEvent(
	input: GatewayInboundEvent,
	config: GatewayConfig,
	now = Date.now()
): GatewayInboundEvent {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(input.eventId)) {
		throw new EventValidationError('invalid_event_id', 'eventId contains unsupported characters');
	}
	if (input.channel !== 'wechat' && input.channel !== 'qq') {
		throw new EventValidationError('invalid_channel', 'Unsupported channel');
	}
	if (!Number.isFinite(input.occurredAt)) {
		throw new EventValidationError('invalid_timestamp', 'Event timestamp is invalid');
	}
	if (input.occurredAt < now - config.maxEventAgeMs || input.occurredAt > now + 120_000) {
		throw new EventValidationError('stale_event', 'Event timestamp is outside the accepted window');
	}

	const connectionId = requiredString(input.connectionId, 'connectionId');
	const conversationId = requiredString(input.conversation.id, 'conversation.id');
	const senderId = requiredString(input.sender.id, 'sender.id');
	if (input.conversation.type !== 'private' && input.conversation.type !== 'group') {
		throw new EventValidationError('invalid_conversation', 'Unsupported conversation type');
	}
	if (Array.from(input.message.text).length > config.maxInputTextChars) {
		throw new EventValidationError('text_too_large', 'Message text is too large');
	}
	if (!input.message.text.trim() && input.attachments.length === 0) {
		throw new EventValidationError('empty_message', 'Message has no text or attachments');
	}

	let totalBytes = 0;
	const attachments = input.attachments.map((attachment, index) => {
		if (!Buffer.isBuffer(attachment.bytes)) {
			throw new EventValidationError('invalid_attachment', `Attachment ${index} has no bytes`);
		}
		if (attachment.bytes.length > config.maxAttachmentBytes) {
			throw new EventValidationError('attachment_too_large', `Attachment ${index} is too large`);
		}
		totalBytes += attachment.bytes.length;
		if (totalBytes > config.maxTotalAttachmentBytes) {
			throw new EventValidationError('attachments_too_large', 'Total attachment size is too large');
		}
		const contentType = requiredString(
			attachment.contentType,
			`attachment[${index}].contentType`,
			200
		);
		if (!/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:;[\x20-\x7E]*)?$/.test(contentType)) {
			throw new EventValidationError(
				'invalid_attachment',
				`Attachment ${index} content type is invalid`
			);
		}
		return {
			id: requiredString(attachment.id, `attachment[${index}].id`),
			fileName: safeFileName(requiredString(attachment.fileName, `attachment[${index}].fileName`)),
			contentType,
			bytes: attachment.bytes
		};
	});

	return {
		...input,
		connectionId,
		conversation: {
			...input.conversation,
			id: conversationId,
			name: optionalString(input.conversation.name, 'conversation.name')
		},
		sender: {
			...input.sender,
			id: senderId,
			name: optionalString(input.sender.name, 'sender.name')
		},
		attachments
	};
}

export function connectionIdFor(channel: Channel): string {
	return `${channel}-default`;
}
