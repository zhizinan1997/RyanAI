import type {
	AdapterHealth,
	ConnectionSnapshot,
	GatewayReply,
	MockEventInput,
	QrCodeSnapshot,
	DiscoveredGroup
} from '../types.js';

export interface LoginInput {
	credentials?: Record<string, unknown>;
}

export interface CreateConnectionInput {
	channel: 'wechat' | 'qq';
	ownerUserId: string;
	id?: string;
	enabled?: boolean;
	accountLabel?: string;
}

export interface ChannelAdapter {
	readonly mode: 'mock' | 'openclaw';
	start(): Promise<void>;
	stop(): Promise<void>;
	health(): AdapterHealth;
	listConnections(): Promise<ConnectionSnapshot[]>;
	createConnection(input: CreateConnectionInput): Promise<ConnectionSnapshot>;
	deleteConnection(connectionId: string): Promise<void>;
	patchConnection(connectionId: string, enabled: boolean): Promise<ConnectionSnapshot>;
	login(connectionId: string, input: LoginInput): Promise<ConnectionSnapshot>;
	reconnect(connectionId: string): Promise<ConnectionSnapshot>;
	logout(connectionId: string): Promise<ConnectionSnapshot>;
	getQrCode(connectionId: string): Promise<QrCodeSnapshot>;
	discoverGroups(connectionId: string): Promise<DiscoveredGroup[]>;
}

export interface MockInjectableAdapter extends ChannelAdapter {
	readonly mode: 'mock';
	inject(input: MockEventInput): Promise<GatewayReply>;
}

export class AdapterError extends Error {
	constructor(
		readonly code: string,
		readonly statusCode = 503
	) {
		super(code);
		this.name = 'AdapterError';
	}
}
