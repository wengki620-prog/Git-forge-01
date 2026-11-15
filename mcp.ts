/**
 * mcp.ts — Model Context Protocol di /mcp: JSON-RPC 2.0 lewat Streamable
 * HTTP. Mendukung era modern (server/discover, tanpa handshake) dan era
 * lama (initialize + notifications/initialized) sebagai cadangan.
 *
 * Tepat enam tool kanonis ditawarkan, dengan skema properti kanonis dan
 * `required` minimal, agar pemetaan argumen suite selalu 1:1. Daftar tool
 * dibangun sekali sebagai konstanta beku sehingga dua panggilan tools/list
 * menjawab identik byte demi byte.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, type Repo } from './forge.ts';
import { pullJson, repoJson } from './rest.ts';
import { sendJson } from './respond.ts';

const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const SERVER_INFO = { name: 'git-forge', version: '1.0.0' };

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<{
    type: 'object';
    properties: Readonly<Record<string, Readonly<{ type: string; description?: string }>>>;
    required: readonly string[];
  }>;
}

/** Enam tool kanonis; urutan dan isinya tetap untuk semua panggilan. */
const TOOLS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Buat repositori baru milik pengguna.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'Nama repositori.' }),
        description: Object.freeze({ type: 'string', description: 'Deskripsi repositori.' }),
        private: Object.freeze({ type: 'boolean', description: 'Apakah repositori privat.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Baca satu repositori berdasarkan owner dan nama.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Login pemilik repositori.' }),
        repo: Object.freeze({ type: 'string', description: 'Nama repositori.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Buat issue baru di sebuah repositori.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Login pemilik repositori.' }),
        repo: Object.freeze({ type: 'string', description: 'Nama repositori.' }),
        title: Object.freeze({ type: 'string', description: 'Judul issue.' }),
        body: Object.freeze({ type: 'string', description: 'Isi issue.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'Daftar issue sebuah repositori.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Login pemilik repositori.' }),
        repo: Object.freeze({ type: 'string', description: 'Nama repositori.' }),
        state: Object.freeze({ type: 'string', description: 'Filter status: open, closed, atau all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Buat pull request baru di sebuah repositori.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Login pemilik repositori.' }),
        repo: Object.freeze({ type: 'string', description: 'Nama repositori.' }),
        title: Object.freeze({ type: 'string', description: 'Judul pull request.' }),
        head: Object.freeze({ type: 'string', description: 'Nama cabang head.' }),
        base: Object.freeze({ type: 'string', description: 'Nama cabang base.' }),
        body: Object.freeze({ type: 'string', description: 'Isi pull request.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Gabungkan pull request dengan squash merge.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Login pemilik repositori.' }),
        repo: Object.freeze({ type: 'string', description: 'Nama repositori.' }),
        pull_number: Object.freeze({ type: 'number', description: 'Nomor pull request.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: JsonRpcId;
  readonly method?: unknown;
  readonly params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendResult(response: ServerResponse, id: JsonRpcId, result: unknown): void {
  sendJson(response, 200, { jsonrpc: '2.0', id, result });
}

function sendRpcError(response: ServerResponse, id: JsonRpcId, code: number, message: string, httpStatus = 200): void {
  sendJson(response, httpStatus, { jsonrpc: '2.0', id, error: { code, message } });
}

/** Hasil tool: teks JSON sekaligus structuredContent untuk kedua pembaca suite. */
function toolResult(payload: unknown): Record<string, unknown> {
  const text = JSON.stringify(payload);
  return {
    content: [{ type: 'text', text }],
    structuredContent: payload,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function missingArgs(args: Record<string, unknown>, required: readonly string[]): string | null {
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null || value === '') return key;
  }
  return null;
}

function resolveRepoArg(forge: Forge, args: Record<string, unknown>): Repo | null {
  const owner = args.owner;
  const repo = args.repo;
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  return forge.resolveRepo(owner, repo);
}

function issuePayload(forge: Forge, repo: Repo, issue: ReturnType<Forge['createIssue']>): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I${repo.id}:${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? { name: label.name, color: label.color } : { name, color: 'ededed' };
    }),
    user: { login: forge.owner ?? '' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
  };
}

/** Jalankan satu tool; mengembalikan hasil atau {rpcError} untuk galat JSON-RPC. */
function callTool(
  forge: Forge,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> | { rpcError: { code: number; message: string } } {
  const definition = TOOLS.find((tool) => tool.name === name);
  if (definition === undefined) {
    return { rpcError: { code: -32602, message: `Tool ${name} tidak dikenal` } };
  }
  const missing = missingArgs(args, definition.inputSchema.required);
  if (missing !== null) {
    return { rpcError: { code: -32602, message: `Argumen ${missing} wajib diisi` } };
  }

  if (name === 'create_repo') {
    const repoName = args.name as string;
    if (repoName.includes('/') || repoName.trim() === '') return toolError('nama repositori tidak sah');
    const created = forge.createRepo(
      repoName,
      typeof args.description === 'string' ? args.description : '',
      args.private === true,
    );
    if (created === 'exists') return toolError('Repository already exists');
    const payload = repoJson(forge, created) as Record<string, unknown>;
    if (forge.owner === null) delete payload.full_name;
    return toolResult(payload);
  }

  if (name === 'get_repo') {
    const repo = resolveRepoArg(forge, args);
    if (repo === null) return toolError('repositori tidak ditemukan');
    return toolResult(repoJson(forge, repo));
  }

  if (name === 'create_issue') {
    const repo = resolveRepoArg(forge, args);
    if (repo === null) return toolError('repositori tidak ditemukan');
    const title = args.title as string;
    const issue = forge.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
    return toolResult(issuePayload(forge, repo, issue));
  }

  if (name === 'list_issues') {
    const repo = resolveRepoArg(forge, args);
    if (repo === null) return toolError('repositori tidak ditemukan');
    const state = typeof args.state === 'string' ? args.state : 'open';
    let items = [...repo.issues];
    if (state === 'open') items = items.filter((issue) => issue.state === 'open');
    else if (state === 'closed') items = items.filter((issue) => issue.state === 'closed');
    items.sort((a, b) => b.number - a.number);
    return toolResult(items.map((issue) => issuePayload(forge, repo, issue)));
  }

  if (name === 'create_pull_request') {
    const repo = resolveRepoArg(forge, args);
    if (repo === null) return toolError('repositori tidak ditemukan');
    const title = args.title as string;
    const head = stripOwnerPrefix(args.head as string);
    const base = stripOwnerPrefix(args.base as string);
    const created = forge.createPullRequest(repo, title, typeof args.body === 'string' ? args.body : '', head, base);
    if (created === 'unknown-branch') return toolError('cabang head atau base tidak ada');
    if (created === 'duplicate') return toolError('A pull request already exists for these branches');
    return toolResult(pullJson(forge, repo, created));
  }

  if (name === 'merge_pull_request') {
    const repo = resolveRepoArg(forge, args);
    if (repo === null) return toolError('repositori tidak ditemukan');
    const rawNumber = args.pull_number;
    const number = typeof rawNumber === 'number' ? rawNumber : Number(rawNumber);
    if (!Number.isInteger(number) || number < 1) return toolError('pull_number tidak sah');
    const pr = repo.pullsByNumber.get(number);
    if (pr === undefined) return toolError('pull request tidak ditemukan');
    const result = forge.mergePullRequest(repo, pr, 'squash');
    if (!result.ok) {
      if (result.reason === 'conflict') return toolError('Merge conflict: perubahan kedua cabang bertabrakan');
      return toolError('pull request tidak dapat digabung');
    }
    return toolResult(pullJson(forge, repo, pr));
  }

  return { rpcError: { code: -32602, message: `Tool ${name} tidak dikenal` } };
}

function stripOwnerPrefix(ref: string): string {
  const colon = ref.lastIndexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

/**
 * Handler /mcp. `bodyText` adalah badan mentah (untuk galat parse yang tepat);
 * autentikasi sudah diperiksa terpusat oleh app.ts sebelum pemanggilan ini.
 */
export function handleMcp(
  forge: Forge,
  request: IncomingMessage,
  response: ServerResponse,
  bodyText: string,
): void {
  if (request.method !== 'POST') {
    sendJson(response, 405, { message: 'Method Not Allowed' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    sendRpcError(response, null, -32700, 'Parse error: badan bukan JSON yang sah', 400);
    return;
  }
  if (!isRecord(parsed)) {
    sendRpcError(response, null, -32600, 'Invalid Request: badan harus berupa objek JSON-RPC', 400);
    return;
  }
  const rpc = parsed as JsonRpcRequest;
  const hasId = rpc.id !== undefined;
  const id: JsonRpcId = hasId ? (rpc.id as JsonRpcId) : null;

  // Notifikasi (tanpa id) dijawab 202 dengan badan kosong.
  if (!hasId) {
    response.writeHead(202);
    response.end();
    return;
  }
  if (typeof rpc.method !== 'string') {
    sendRpcError(response, id, -32600, 'Invalid Request: method wajib berupa string');
    return;
  }

  const params = isRecord(rpc.params) ? rpc.params : {};

  if (rpc.method === 'server/discover') {
    const result = {
      supportedVersions: [...PROTOCOL_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { ...SERVER_INFO },
      _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
    };
    sendResult(response, id, result);
    return;
  }

  if (rpc.method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    const version = requested !== null && PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-11-25';
    sendResult(response, id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { ...SERVER_INFO },
    });
    return;
  }

  if (rpc.method === 'ping') {
    sendResult(response, id, {});
    return;
  }

  if (rpc.method === 'tools/list') {
    sendResult(response, id, { tools: TOOLS });
    return;
  }

  if (rpc.method === 'tools/call') {
    const toolName = params.name;
    if (typeof toolName !== 'string') {
      sendRpcError(response, id, -32602, 'tools/call membutuhkan name');
      return;
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    const outcome = callTool(forge, toolName, args);
    if ('rpcError' in outcome) {
      sendRpcError(response, id, outcome.rpcError.code, outcome.rpcError.message);
      return;
    }
    sendResult(response, id, outcome);
    return;
  }

  if (rpc.method.startsWith('notifications/')) {
    response.writeHead(202);
    response.end();
    return;
  }

  sendRpcError(response, id, -32601, `Method ${rpc.method} tidak ditemukan`);
}
