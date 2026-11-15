/**
 * respond.ts — bantu kecil untuk membaca badan permintaan dan mengirim
 * jawaban HTTP dari semua permukaan forge.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Galat badan permintaan yang terlalu besar. */
export class BodyTooLargeError extends Error {
  constructor() {
    super('badan permintaan melebihi batas');
    this.name = 'BodyTooLargeError';
  }
}

/** Baca seluruh badan permintaan sebagai Buffer; menolak bila melebihi batas. */
export function readBody(request: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    request.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > limit) {
        failed = true;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    request.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

/** Kirim jawaban JSON dengan content-type yang benar. */
export function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    ...extraHeaders,
  });
  response.end(body);
}

/** Kirim jawaban byte mentah dengan content-type yang diminta. */
export function sendBytes(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    ...extraHeaders,
  });
  response.end(body);
}

/** Jawaban galat JSON standar: {"message": ...}. */
export function sendError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { message });
}

/** Kirim jawaban 204 tanpa badan. */
export function sendNoContent(response: ServerResponse): void {
  response.writeHead(204);
  response.end();
}
