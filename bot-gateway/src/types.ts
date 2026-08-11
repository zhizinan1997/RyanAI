export type Channel = 'wechat' | 'qq';
export type ConversationType = 'private' | 'group';

export interface InboundAttachment {
	id: string;
	fileName: string;
	contentType: string;
	bytes: Buffer;
}

export interface GatewayInboundEvent {
	eventId: string;
	occurredAt: number;
	channel: Channel;
	connectionId: string;
	conversation: {
		type: ConversationType;
		id: string;
		name?: string;
	};
	sender: {
		id: string;
		name?: string;
	};
	message: {
		text: string;
		mentionsBot: boolean;
	};
	attachments: InboundAttachment[];
}

export interface WireAttachmentDescriptor {
	field_name: string;
	id: string;
	file_name: string;
	content_type: string;
	size: number;
	sha256: string;
}

export interface RyanAiWireEvent {
	version: '1.0';
	event_id: string;
	occurred_at: string;
	channel: Channel;
	connection_id: string;
	conversation: {
		type: ConversationType;
		id: string;
		name?: string;
	};
	sender: {
		id: string;
		name?: string;
	};
	message: {
		text: string;
		mentions_bot: boolean;
	};
	attachments: WireAttachmentDescriptor[];
}

export interface GatewayReply {
	handled: true;
	eventId: string;
	chunks: string[];
	isError: boolean;
	replayed: boolean;
	reason: 'ryanai' | 'ignored' | 'safe-error' | 'replay';
}

export type ConnectionStatus =
	| 'disabled'
	| 'logged_out'
	| 'awaiting_scan'
	| 'connected'
	| 'degraded'
	| 'unavailable';

export interface ConnectionSnapshot {
	id: string;
	channel: Channel;
	ownerUserId?: string;
	trustedOwnerExternalId?: string;
	enabled: boolean;
	status: ConnectionStatus;
	accountLabel?: string;
	updatedAt: string;
	detail?: string;
}

export interface QrCodeSnapshot {
	connectionId: string;
	dataUrl: string;
	expiresAt: string;
	mock?: boolean;
}

export interface DiscoveredGroup {
	channel: Channel;
	connectionId: string;
	groupId: string;
	enabled: boolean;
	name?: string;
	lastSeenAt: string;
}

export interface AdapterHealth {
	mode: 'mock' | 'openclaw';
	ready: boolean;
	detail?: string;
}

export interface MockAttachmentInput {
	id?: string;
	file_name: string;
	content_type?: string;
	base64: string;
}

export interface MockEventInput {
	event_id: string;
	occurred_at?: string | number;
	channel: Channel;
	connection_id?: string;
	conversation: {
		type: ConversationType;
		id: string;
		name?: string;
	};
	sender: {
		id: string;
		name?: string;
	};
	message: {
		text?: string;
		mentions_bot?: boolean;
	};
	attachments?: MockAttachmentInput[];
}
