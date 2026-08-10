declare module 'openclaw/plugin-sdk/plugin-entry' {
	/** OpenClaw 2026.7.1-2 inbound_claim event contract. */
	export interface PluginHookInboundClaimEvent {
		content: string;
		body?: string;
		bodyForAgent?: string;
		transcript?: string;
		timestamp?: number;
		channel: string;
		accountId?: string;
		conversationId?: string;
		parentConversationId?: string;
		senderId?: string;
		senderName?: string;
		senderUsername?: string;
		replyToId?: string;
		replyToIdFull?: string;
		replyToBody?: string;
		replyToSender?: string;
		replyToIsQuote?: boolean;
		threadId?: string | number;
		messageId?: string;
		sessionKey?: string;
		runId?: string;
		isGroup: boolean;
		commandAuthorized?: boolean;
		senderIsOwner?: boolean;
		wasMentioned?: boolean;
		metadata?: Record<string, unknown>;
	}

	/** OpenClaw 2026.7.1-2 inbound_claim context contract. */
	export interface PluginHookInboundClaimContext {
		channelId: string;
		accountId?: string;
		conversationId?: string;
		sessionKey?: string;
		runId?: string;
		messageId?: string;
		senderId?: string;
		replyToId?: string;
		replyToIdFull?: string;
		replyToBody?: string;
		replyToSender?: string;
		replyToIsQuote?: boolean;
		trace?: unknown;
		traceId?: string;
		spanId?: string;
		parentSpanId?: string;
		callDepth?: number;
		agentId?: string;
		parentConversationId?: string;
		pluginBinding?: unknown;
	}

	export function definePluginEntry<T>(entry: T): T;
}
