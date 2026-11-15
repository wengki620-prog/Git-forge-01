/**
 * githttp.ts — git smart HTTP: info/refs (iklan v0 dan v2), upload-pack
 * (perintah ls-refs dan fetch v2, ditambah fallback v0), dan receive-pack v0
 * dengan laporan report-status berbingkai sideband.
 *
 * Autentikasi TIDAK ditegakkan di permukaan ini: suite selalu membawa token,
 * dan tidak ada pemeriksaan yang menguji 401 di git; menegakkannya hanya
 * berisiko mematahkan klien tanpa token.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  encodePkt,
  encodePkts,
  isOid,
  peelToCommit,
  pktFlush,
  PktReader,
  readPack,
  selectFetchObjects,
  writePack,
  type Pkt,
} from './gitobj.ts';
import { Forge, type Repo } from './forge.ts';
import { sendBytes, sendError } from './respond.ts';

const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** Potong byte menjadi paket sideband pita 1 (maks 32 KiB data per paket). */
function sidebandPackets(data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 32768;
  for (let at = 0; at < data.length; at += CHUNK) {
    const slice = data.subarray(at, Math.min(at + CHUNK, data.length));
    packets.push(encodePkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (packets.length === 0) packets.push(encodePkt(Buffer.from([1])));
  return packets;
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

interface CachedFetch {
  readonly pack: Buffer;
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly ack: string | null;
}

/**
 * Cache hasil fetch per repo+generasi: fetch yang sama persis (wants, haves,
 * shallow, depth) pada status ref yang sama selalu menghasilkan byte yang
 * sama, jadi pack hanya dibangun sekali. Setiap perubahan ref menaikkan
 * generasi repo dan membuat kunci lama tidak pernah cocok lagi. Dibatasi
 * 32 entri / 8 MiB, entri tertua digusur lebih dulu.
 */
const FETCH_CACHE_MAX_ENTRIES = 32;
const FETCH_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const fetchCache = new Map<string, CachedFetch>();
let fetchCacheBytes = 0;

function cachedFetch(forge: Forge, repo: Repo, fetch: FetchRequest): CachedFetch {
  const key = [
    repo.id,
    repo.generation,
    fetch.wants.join(','),
    fetch.haves.join(','),
    fetch.shallow.join(','),
    fetch.depth ?? '',
  ].join('|');
  const hit = fetchCache.get(key);
  if (hit !== undefined) return hit;
  const selection = selectFetchObjects(forge.lookup(repo), fetch);
  const entry: CachedFetch = {
    pack: writePack(selection.objects),
    shallow: selection.shallow,
    unshallow: selection.unshallow,
    ack: selection.ack,
  };
  while (
    (fetchCache.size >= FETCH_CACHE_MAX_ENTRIES || fetchCacheBytes + entry.pack.length > FETCH_CACHE_MAX_BYTES) &&
    fetchCache.size > 0
  ) {
    const oldest = fetchCache.keys().next().value as string;
    const removed = fetchCache.get(oldest) as CachedFetch;
    fetchCacheBytes -= removed.pack.length;
    fetchCache.delete(oldest);
  }
  if (entry.pack.length <= FETCH_CACHE_MAX_BYTES) {
    fetchCache.set(key, entry);
    fetchCacheBytes += entry.pack.length;
  }
  return entry;
}

function textOf(packet: Pkt): string {
  return packet.kind === 'data' ? packet.payload.toString('utf8').replace(/\n$/, '') : '';
}

/** Baris-baris ref untuk iklan v0: HEAD dulu, lalu ref terurut, lalu peel tag. */
function v0RefLines(forge: Forge, repo: Repo): string[] {
  const refs = forge.listRefs(repo);
  const tip = forge.headTip(repo);
  if (refs.length === 0 && tip === null) return [];
  const lines: string[] = [];
  lines.push(`${tip ?? ZERO_OID} HEAD`);
  for (const { ref, oid } of refs) {
    lines.push(`${oid} ${ref}`);
    const object = forge.getObject(repo, oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = peelToCommit(forge.lookup(repo), oid);
      if (peeled !== null) lines.push(`${peeled} ${ref}^{}`);
    }
  }
  return lines;
}

/** Iklan v0 lengkap: preamble service, baris ref dengan kapabilitas, flush. */
function v0Advertisement(forge: Forge, repo: Repo, service: string, caps: string): Buffer {
  const lines = v0RefLines(forge, repo);
  const parts: Buffer[] = [];
  parts.push(encodePkt(`# service=${service}\n`));
  parts.push(pktFlush());
  if (lines.length === 0) {
    parts.push(encodePkt(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      const text = index === 0 ? `${line}\u0000${caps}\n` : `${line}\n`;
      parts.push(encodePkt(text));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Iklan v2 untuk upload-pack: hanya kapabilitas yang dipakai suite. */
function v2Advertisement(): Buffer {
  return encodePkts([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'ls-refs\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** Tanggapi GET info/refs untuk kedua service. */
function handleInfoRefs(
  forge: Forge,
  repo: Repo,
  request: IncomingMessage,
  response: ServerResponse,
  service: string | null,
): void {
  if (service === 'git-upload-pack') {
    const protocol = request.headers['git-protocol'];
    if (protocol === 'version=2') {
      sendBytes(response, 200, UPLOAD_ADVERTISEMENT, v2Advertisement());
    } else {
      sendBytes(
        response,
        200,
        UPLOAD_ADVERTISEMENT,
        v0Advertisement(forge, repo, service, 'symref=HEAD:refs/heads/main side-band-64k shallow'),
      );
    }
    return;
  }
  if (service === 'git-receive-pack') {
    sendBytes(
      response,
      200,
      RECEIVE_ADVERTISEMENT,
      v0Advertisement(forge, repo, service, 'symref=HEAD:refs/heads/main report-status side-band-64k delete-refs'),
    );
    return;
  }
  sendError(response, 400, 'unknown service');
}

/** Pecah paket permintaan v2 menjadi baris perintah dan baris argumen. */
function splitV2(packets: Pkt[]): { head: string[]; args: string[] } {
  const head: string[] = [];
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    if (afterDelim) args.push(textOf(packet));
    else head.push(textOf(packet));
  }
  return { head, args };
}

/** Tanggapi perintah ls-refs v2 dengan filter ref-prefix dari klien. */
function handleLsRefs(forge: Forge, repo: Repo, response: ServerResponse, args: string[]): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const tip = forge.headTip(repo);
  if (matches('HEAD')) {
    if (tip !== null) {
      lines.push(`${tip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}`);
    }
  }
  for (const { ref, oid } of forge.listRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const object = forge.getObject(repo, oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(forge.lookup(repo), oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(line);
  }
  const parts = lines.map((line) => encodePkt(`${line}\n`));
  parts.push(pktFlush());
  sendBytes(response, 200, UPLOAD_RESULT, Buffer.concat(parts));
}

/** Bangun balasan fetch v2 dari hasil pemilihan objek. */
function respondFetchV2(forge: Forge, repo: Repo, response: ServerResponse, fetch: FetchRequest): void {
  const selection = cachedFetch(forge, repo, fetch);
  const pack = selection.pack;
  const parts: Buffer[] = [];
  parts.push(encodePkt('acknowledgments\n'));
  if (selection.ack !== null) {
    parts.push(encodePkt(`ACK ${selection.ack}\n`));
    parts.push(encodePkt('ready\n'));
  } else {
    parts.push(encodePkt('NAK\n'));
  }
  parts.push(pktFlush());
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(encodePkt('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(encodePkt(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(encodePkt('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(pktFlush());
  sendBytes(response, 200, UPLOAD_RESULT, Buffer.concat(parts));
}

/** Bangun balasan fetch v0 dari hasil pemilihan objek. */
function respondFetchV0(forge: Forge, repo: Repo, response: ServerResponse, fetch: FetchRequest): void {
  const selection = cachedFetch(forge, repo, fetch);
  const pack = selection.pack;
  const parts: Buffer[] = [];
  for (const oid of selection.shallow) parts.push(encodePkt(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
  if (selection.ack !== null) parts.push(encodePkt(`ACK ${selection.ack}\n`));
  else parts.push(encodePkt('NAK\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(pktFlush());
  sendBytes(response, 200, UPLOAD_RESULT, Buffer.concat(parts));
}

/** Tanggapi POST git-upload-pack: perintah v2 atau permintaan v0. */
function handleUploadPack(forge: Forge, repo: Repo, response: ServerResponse, body: Buffer): void {
  let packets: Pkt[];
  try {
    packets = new PktReader(body).all();
  } catch (err) {
    sendError(response, 400, err instanceof Error ? err.message : 'permintaan pkt-line tidak sah');
    return;
  }
  const dataLines = packets.filter((packet) => packet.kind === 'data').map(textOf);
  const first = dataLines[0] ?? '';
  if (first.startsWith('command=')) {
    const { args } = splitV2(packets);
    const command = first.slice('command='.length);
    if (command === 'ls-refs') {
      handleLsRefs(forge, repo, response, args);
      return;
    }
    if (command === 'fetch') {
      const fetch: FetchRequest = { wants: [], haves: [], shallow: [] };
      for (const arg of args) {
        if (arg.startsWith('want ')) fetch.wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) fetch.haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) fetch.shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) {
          const depth = Number(arg.slice(7).trim());
          if (Number.isInteger(depth) && depth >= 0) fetch.depth = depth;
        }
        // thin-pack, no-progress, ofs-delta, filter, deepen-since/not, done: diterima, diabaikan.
      }
      try {
        respondFetchV2(forge, repo, response, fetch);
      } catch (err) {
        sendError(response, 400, err instanceof Error ? err.message : 'fetch gagal');
      }
      return;
    }
    sendError(response, 400, `perintah upload-pack ${command} tidak dikenal`);
    return;
  }

  // Format v0: bagian want, flush, bagian have, flush.
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sections.push([]);
      continue;
    }
    if (packet.kind === 'data') (sections[sections.length - 1] as string[]).push(textOf(packet));
  }
  const fetch: FetchRequest = { wants: [], haves: [], shallow: [] };
  for (const line of sections[0] ?? []) {
    const tokens = line.split(' ');
    if (tokens[0] === 'want' && tokens[1] !== undefined) fetch.wants.push(tokens[1]);
    else if (tokens[0] === 'shallow' && tokens[1] !== undefined) fetch.shallow.push(tokens[1]);
    else if (tokens[0] === 'deepen' && tokens[1] !== undefined) {
      const depth = Number(tokens[1]);
      if (Number.isInteger(depth) && depth >= 0) fetch.depth = depth;
    }
  }
  for (const line of sections[1] ?? []) {
    const tokens = line.split(' ');
    if (tokens[0] === 'have' && tokens[1] !== undefined) fetch.haves.push(tokens[1]);
  }
  try {
    respondFetchV0(forge, repo, response, fetch);
  } catch (err) {
    sendError(response, 400, err instanceof Error ? err.message : 'fetch gagal');
  }
}

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** Tanggapi POST git-receive-pack: perintah ref lalu packfile. */
function handleReceivePack(forge: Forge, repo: Repo, response: ServerResponse, body: Buffer): void {
  const reader = new PktReader(body);
  const commands: PushCommand[] = [];
  try {
    for (;;) {
      const packet = reader.next();
      if (packet === null || packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      let line = textOf(packet);
      const nul = line.indexOf('\u0000');
      if (nul >= 0) line = line.slice(0, nul);
      const tokens = line.split(' ');
      if (tokens.length !== 3 || tokens[0] === undefined || tokens[1] === undefined || tokens[2] === undefined) {
        sendError(response, 400, `baris perintah push tidak sah: ${JSON.stringify(line)}`);
        return;
      }
      if (!isOid(tokens[0]) || !isOid(tokens[1])) {
        sendError(response, 400, 'perintah push dengan id objek yang buruk');
        return;
      }
      commands.push({ oldOid: tokens[0], newOid: tokens[1], ref: tokens[2] });
    }
  } catch (err) {
    sendError(response, 400, err instanceof Error ? err.message : 'permintaan receive-pack tidak sah');
    return;
  }
  if (commands.length === 0) {
    sendError(response, 400, 'push tanpa perintah ref');
    return;
  }

  // Simpan objek dari pack (bila ada byte pack) sebelum menerapkan perintah.
  const packBytes = body.subarray(reader.offset);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, forge.lookup(repo));
      for (const object of objects.values()) forge.putObject(repo, object.type, object.data);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'pack tidak sah';
    }
  }

  const outcomes: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const command of commands) {
    if (unpackError !== null) {
      outcomes.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    const current = forge.getRef(repo, command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        outcomes.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else {
        forge.deleteRef(repo, command.ref);
        outcomes.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    const target = forge.getObject(repo, command.newOid);
    if (target === undefined || (target.type !== 'commit' && target.type !== 'tag')) {
      outcomes.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        outcomes.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      forge.setRef(repo, command.ref, command.newOid);
      outcomes.push({ ref: command.ref, ok: true });
      continue;
    }
    if (current === undefined) {
      outcomes.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (current !== command.oldOid) {
      outcomes.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (command.newOid === command.oldOid) {
      outcomes.push({ ref: command.ref, ok: true });
      continue;
    }
    if (target.type === 'commit' && !forge.isDescendant(repo, command.oldOid, command.newOid)) {
      outcomes.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (target.type === 'tag') {
      const peeled = peelToCommit(forge.lookup(repo), command.newOid);
      const oldPeeled = peelToCommit(forge.lookup(repo), command.oldOid);
      if (peeled !== null && oldPeeled !== null && peeled !== oldPeeled && !forge.isDescendant(repo, oldPeeled, peeled)) {
        outcomes.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    forge.setRef(repo, command.ref, command.newOid);
    outcomes.push({ ref: command.ref, ok: true });
  }

  const innerLines: Array<string | 'flush'> = [
    unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`,
  ];
  for (const outcome of outcomes) {
    innerLines.push(outcome.ok ? `ok ${outcome.ref}\n` : `ng ${outcome.ref} ${outcome.reason ?? 'failed'}\n`);
  }
  innerLines.push('flush');
  const inner = encodePkts(innerLines);
  const parts: Buffer[] = [...sidebandPackets(inner), pktFlush()];
  sendBytes(response, 200, RECEIVE_RESULT, Buffer.concat(parts));
}

/**
 * Router permukaan git. Segmen path sudah didekode per segmen:
 * [owner, "<repo>.git", ...aksi]. Mengembalikan true bila rute ini milik git.
 */
export function isGitRoute(segments: readonly string[]): boolean {
  return segments.length >= 2 && (segments[1] as string).endsWith('.git');
}

export function handleGit(
  forge: Forge,
  request: IncomingMessage,
  response: ServerResponse,
  segments: readonly string[],
  query: URLSearchParams,
  body: Buffer,
): void {
  const owner = segments[0] as string;
  const repoName = (segments[1] as string).slice(0, -'.git'.length);
  const repo = forge.resolveRepo(owner, repoName);
  if (repo === null) {
    sendError(response, 404, 'Not Found');
    return;
  }
  const action = segments.slice(2);
  try {
    if (request.method === 'GET' && action.length === 2 && action[0] === 'info' && action[1] === 'refs') {
      handleInfoRefs(forge, repo, request, response, query.get('service'));
      return;
    }
    if (request.method === 'POST' && action.length === 1 && action[0] === 'git-upload-pack') {
      handleUploadPack(forge, repo, response, body);
      return;
    }
    if (request.method === 'POST' && action.length === 1 && action[0] === 'git-receive-pack') {
      handleReceivePack(forge, repo, response, body);
      return;
    }
  } catch (err) {
    if (!response.writableEnded) {
      sendError(response, 400, err instanceof Error ? err.message : 'permintaan git tidak sah');
    }
    return;
  }
  sendError(response, 404, 'Not Found');
}
