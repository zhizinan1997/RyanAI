import { sha256Hex } from '../security/hmac.js';
import { EventValidationError } from '../event.js';
import type { GatewayConfig } from '../config.js';
import type { GatewayInboundEvent } from '../types.js';

type UnknownRecord = Record<string, unknown>;

function object(value: unknown, field: string): UnknownRecord {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new EventValidationError('invalid_bridge_event', `${field} must be an object`);
	}
	return value as UnknownRecord;
}

function string(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new EventValidationError('invalid_bridge_event', `${field} is required`);
	}
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function integer(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new EventValidationError('invalid_bridge_event', `${field} must be an integer`);
	}
	return value as number;
}

export async function parseOpenClawBridgeEvent(
	body: Buffer,
	contentType: string | undefined,
	config: GatewayConfig
): Promise<GatewayInboundEvent> {
	if (!contentType?.toLowerCase().startsWith('multipart/form-data;')) {
		throw new EventValidationError(
			'multipart_required',
			'Bridge event must use multipart/form-data'
		);
	}
	let form: FormData;
	try {
		const request = new Request('http://bot-gateway.internal', {
			method: 'POST',
			headers: { 'content-type': contentType },
			body: Uint8Array.from(body)
		});
		form = await request.formData();
	} catch {
		throw new EventValidationError('invalid_multipart', 'Bridge multipart body is invalid');
	}

	const eventPart = form.get('event');
	if (typeof eventPart !== 'string') {
		throw new EventValidationError('event_part_required', 'Bridge event part is required');
	}

	let raw: UnknownRecord;
	try {
		raw = object(JSON.parse(eventPart), 'event');
	} catch (error) {
		if (error instanceof EventValidationError) throw error;
		throw new EventValidationError('invalid_bridge_event', 'Bridge event JSON is invalid');
	}
	if (raw.version !== '1.0') {
		throw new EventValidationError('invalid_bridge_event', 'Unsupported bridge event version');
	}

	const conversation = object(raw.conversation, 'conversation');
	const sender = object(raw.sender, 'sender');
	const message = object(raw.message, 'message');
	if (raw.channel !== 'wechat' && raw.channel !== 'qq') {
		throw new EventValidationError('invalid_bridge_event', 'Unsupported bridge channel');
	}
	if (conversation.type !== 'private' && conversation.type !== 'group') {
		throw new EventValidationError('invalid_bridge_event', 'Unsupported bridge conversation type');
	}
	const occurredAt = Date.parse(string(raw.occurred_at, 'occurred_at'));
	if (!Number.isFinite(occurredAt)) {
		throw new EventValidationError('invalid_bridge_event', 'Bridge timestamp is invalid');
	}

	const descriptors = Array.isArray(raw.attachments) ? raw.attachments : [];
	if (descriptors.length > 20) {
		throw new EventValidationError('too_many_attachments', 'Too many bridge attachments');
	}
	const expectedFields = new Set(['event']);
	let totalBytes = 0;
	const attachments = [] as GatewayInboundEvent['attachments'];
	for (let index = 0; index < descriptors.length; index += 1) {
		const descriptor = object(descriptors[index], `attachments[${index}]`);
		const fieldName = string(descriptor.field_name, `attachments[${index}].field_name`);
		if (!/^attachment_[0-9]+$/.test(fieldName) || expectedFields.has(fieldName)) {
			throw new EventValidationError('invalid_attachment', 'Bridge attachment field is invalid');
		}
		expectedFields.add(fieldName);
		const part = form.get(fieldName);
		if (!(part instanceof File)) {
			throw new EventValidationError(
				'missing_attachment',
				`Missing bridge attachment ${fieldName}`
			);
		}
		const bytes = Buffer.from(await part.arrayBuffer());
		const declaredSize = integer(descriptor.size, `attachments[${index}].size`);
		if (bytes.length !== declaredSize || bytes.length > config.maxAttachmentBytes) {
			throw new EventValidationError('attachment_size_mismatch', 'Bridge attachment size mismatch');
		}
		totalBytes += bytes.length;
		if (totalBytes > config.maxTotalAttachmentBytes) {
			throw new EventValidationError('attachments_too_large', 'Bridge attachments are too large');
		}
		const declaredHash = string(descriptor.sha256, `attachments[${index}].sha256`).toLowerCase();
		if (!/^[a-f0-9]{64}$/.test(declaredHash) || sha256Hex(bytes) !== declaredHash) {
			throw new EventValidationError('attachment_hash_mismatch', 'Bridge attachment hash mismatch');
		}
		attachments.push({
			id: string(descriptor.id, `attachments[${index}].id`),
			fileName: string(descriptor.file_name, `attachments[${index}].file_name`),
			contentType: string(descriptor.content_type, `attachments[${index}].content_type`),
			bytes
		});
	}

	for (const [fieldName] of form.entries()) {
		if (!expectedFields.has(fieldName)) {
			throw new EventValidationError(
				'unexpected_multipart_field',
				'Unexpected bridge multipart field'
			);
		}
	}

	const accountId = optionalString(raw.account_id);
	const shardId = optionalString(raw.shard_id);
	const nodeId = optionalString(raw.node_id);
	const leaseEpoch = typeof raw.lease_epoch === 'number' ? raw.lease_epoch : undefined;
	const assignmentGeneration = typeof raw.assignment_generation === 'number'
		? raw.assignment_generation : undefined;
	return {
		eventId: string(raw.event_id, 'event_id'),
		occurredAt,
		channel: raw.channel,
		connectionId: string(raw.connection_id, 'connection_id'),
		...(accountId ? { accountKey: accountId } : {}),
		...(shardId ? { shardId } : {}),
		...(nodeId ? { nodeId } : {}),
		...(leaseEpoch !== undefined ? { leaseEpoch } : {}),
		...(assignmentGeneration !== undefined ? { assignmentGeneration } : {}),
		conversation: {
			type: conversation.type,
			id: string(conversation.id, 'conversation.id'),
			...(optionalString(conversation.name) ? { name: optionalString(conversation.name) } : {})
		},
		sender: {
			id: string(sender.id, 'sender.id'),
			...(optionalString(sender.name) ? { name: optionalString(sender.name) } : {})
		},
		message: {
			text: typeof message.text === 'string' ? message.text : '',
			mentionsBot: message.mentions_bot === true
		},
		attachments
	};
}
