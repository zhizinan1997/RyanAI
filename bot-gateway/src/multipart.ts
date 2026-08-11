import { randomBytes } from 'node:crypto';

export interface MultipartFile {
	fieldName: string;
	fileName: string;
	contentType: string;
	bytes: Buffer;
}

export interface MultipartBody {
	body: Buffer;
	contentType: string;
}

function quote(value: string): string {
	return value.replace(/["\\\r\n]/g, '_');
}

function multipartFileName(value: string): string {
	return quote(Array.from(value).slice(0, 160).join('') || 'attachment.bin');
}

export function buildMultipartBody(
	eventJson: string,
	files: readonly MultipartFile[]
): MultipartBody {
	const boundary = `ryanai-${randomBytes(18).toString('hex')}`;
	const chunks: Buffer[] = [];
	const append = (value: string | Buffer): void => {
		chunks.push(typeof value === 'string' ? Buffer.from(value, 'utf8') : value);
	};

	append(`--${boundary}\r\n`);
	append('Content-Disposition: form-data; name="event"\r\n');
	append('Content-Type: application/json; charset=utf-8\r\n\r\n');
	append(eventJson);
	append('\r\n');

	for (const file of files) {
		append(`--${boundary}\r\n`);
		append(
			`Content-Disposition: form-data; name="${quote(file.fieldName)}"; filename="${multipartFileName(file.fileName)}"\r\n`
		);
		append(`Content-Type: ${file.contentType.replace(/[\r\n]/g, '')}\r\n`);
		append('Content-Transfer-Encoding: binary\r\n\r\n');
		append(file.bytes);
		append('\r\n');
	}

	append(`--${boundary}--\r\n`);
	return {
		body: Buffer.concat(chunks),
		contentType: `multipart/form-data; boundary=${boundary}`
	};
}
