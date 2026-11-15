/**
 * app.ts — server HTTP forge: memisahkan permukaan (healthz, git, REST v3,
 * GraphQL, MCP), memeriksa token bearer untuk API, membaca badan, dan
 * memasang X-GitHub-Request-Id pada setiap jawaban.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './forge.ts';
import { handleGit, isGitRoute } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { BodyTooLargeError, readBody, sendError, sendJson } from './respond.ts';

export interface AppOptions {
  /** Token bearer yang diharapkan; null berarti autentikasi dimatikan (pengembangan lokal). */
  readonly token: string | null;
}

/** Pecah pathname menjadi segmen yang didekode satu per satu; null bila encoding buruk. */
function splitSegments(pathname: string): string[] | null {
  const raw = pathname.split('/').filter((part) => part !== '');
  const segments: string[] = [];
  for (const part of raw) {
    try {
      segments.push(decodeURIComponent(part));
    } catch {
      return null;
    }
  }
  return segments;
}

async function handleRequest(forge: Forge, options: AppOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  response.setHeader('X-GitHub-Request-Id', forge.nextRequestId());
  let url: URL;
  try {
    url = new URL(request.url ?? '/', 'http://localhost');
  } catch {
    sendError(response, 400, 'URL tidak sah');
    return;
  }
  const segments = splitSegments(url.pathname);
  if (segments === null) {
    sendError(response, 400, 'path tidak sah');
    return;
  }
  const method = request.method ?? 'GET';

  // healthz: tanpa token, sesuai kontrak lifecycle.
  if (segments.length === 1 && segments[0] === 'healthz') {
    if (method !== 'GET') {
      sendError(response, 404, 'Not Found');
      return;
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  const isApi = segments[0] === 'api';
  const isMcp = segments.length === 1 && segments[0] === 'mcp';
  const isGit = isGitRoute(segments);

  // Autentikasi untuk semua permukaan API; git dan healthz dikecualikan.
  if ((isApi || isMcp) && options.token !== null && options.token !== '') {
    const authorization = request.headers.authorization ?? '';
    if (authorization !== `Bearer ${options.token}`) {
      sendError(response, 401, 'Unauthorized');
      return;
    }
  }

  let body: Buffer;
  try {
    body = await readBody(request);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendError(response, 413, 'badan permintaan terlalu besar');
      return;
    }
    sendError(response, 400, 'gagal membaca badan permintaan');
    return;
  }

  try {
    if (isApi && segments[1] === 'v3') {
      const parsed = parseJsonBody(body);
      handleRest(forge, request, response, segments.slice(2), {
        query: url.searchParams,
        rawPath: url.pathname,
        body: parsed,
      });
      return;
    }
    if (isApi && segments[1] === 'graphql' && segments.length === 2) {
      const parsed = parseJsonBody(body);
      handleGraphQL(forge, request, response, url.searchParams, parsed);
      return;
    }
    if (isMcp) {
      handleMcp(forge, request, response, body.toString('utf8'));
      return;
    }
    if (isGit) {
      handleGit(forge, request, response, segments, url.searchParams, body);
      return;
    }
  } catch (err) {
    console.error('galat handler:', err instanceof Error ? err.message : String(err));
    if (!response.writableEnded) sendError(response, 500, 'galat internal');
    return;
  }
  if (!response.writableEnded) sendError(response, 404, 'Not Found');
}

/** Urai badan JSON: {} bila kosong, null bila tidak sah, nilai bila sah. */
function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Bangun server HTTP forge. Port dipilih pemanggil (ephemeral saat grading). */
export function createApp(forge: Forge, options: AppOptions): Server {
  const server = createServer((request, response) => {
    void handleRequest(forge, options, request, response).catch((err: unknown) => {
      console.error('galat tak tertangani:', err instanceof Error ? err.message : String(err));
      if (!response.writableEnded) {
        try {
          sendError(response, 500, 'galat internal');
        } catch {
          // Soket sudah tertutup; tidak ada lagi yang bisa dilakukan.
        }
      }
    });
  });
  return server;
}
