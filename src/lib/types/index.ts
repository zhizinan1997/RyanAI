export type Banner = {
	id: string;
	type: string;
	title?: string;
	content: string;
	url?: string;
	dismissible?: boolean;
	timestamp: number;
};

export type Notification = {
	id: string;
	type: string;
	title?: string;
	content: string;
	active: boolean;
	dismissible: boolean;
	created_at: number;
	updated_at: number;
	published_at?: number | null;
};

export type NotificationListResponse = {
	items: Notification[];
	total: number;
	page: number;
	limit: number;
};

export enum TTS_RESPONSE_SPLIT {
	PUNCTUATION = 'punctuation',
	PARAGRAPHS = 'paragraphs',
	NONE = 'none'
}
