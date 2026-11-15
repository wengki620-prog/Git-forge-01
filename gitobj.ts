/**
 * gitobj.ts — fondasi git untuk forge: objek SHA-1, tree/commit/tag, pkt-line,
 * packfile (baca/tulis, termasuk delta), traversal, diff, dan merge tiga arah.
 *
 * Semua fungsi di sini murni (tanpa status global) dan hanya memakai pustaka
 * standar Node. Format yang dipakai adalah format publik git (pkt-line,
 * packfile v2, delta) yang ditulis ulang dari spesifikasinya.
 */

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** Id objek nol: nilai old/new untuk ref yang belum lahir atau dihapus. */
export const ZERO_OID = '0'.repeat(40);

/** Id pohon kosong git: SHA-1 dari objek tree tanpa entri. */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Batas pkt-line git (LARGE_PACKET_MAX), termasuk 4 byte panjang. */
export const PKT_LINE_MAX = 65520;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Galat protokol/penyimpanan git dengan kode mesin yang stabil. */
export class GitError extends Error {
  readonly code: string;

  constructor(message: string, code = 'git') {
    super(message);
    this.name = 'GitError';
    this.code = code;
  }
}

const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

/** SHA-1 git atas `<type> <panjang>\0` + isi objek. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// tree
// ---------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Urai objek tree menjadi entri-entri, sesuai urutan tersimpannya. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) throw new GitError('entri tree tanpa pemisah mode', 'tree');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new GitError('entri tree tanpa ujung nama', 'tree');
    if (nul + 21 > data.length) throw new GitError('entri tree dengan id terpotong', 'tree');
    const mode = data.subarray(at, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new GitError(`mode tree ${JSON.stringify(mode)} bukan oktal`, 'tree');
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

/** Urutan git: byte nama, direktori dibandingkan seolah berakhiran '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Bangun objek tree dari entri; entri diurutkan seperti git mengurutkannya. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isOid(entry.oid)) throw new GitError(`entri tree ${entry.name} punya id buruk`, 'tree');
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// commit dan tag
// ---------------------------------------------------------------------------

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Urai objek commit; pesan diambil apa adanya (verbatim). */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line === '' || line.startsWith(' ')) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new GitError('commit tanpa header tree yang sah', 'commit');
  for (const parent of parents) {
    if (!isOid(parent)) throw new GitError('commit dengan id parent yang buruk', 'commit');
  }
  return { tree, parents, author, committer, message };
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Urai objek tag beranotasi. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new GitError(`header tag ${JSON.stringify(line)} tanpa nilai`, 'tag');
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isOid(object)) throw new GitError('tag tanpa header object yang sah', 'tag');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new GitError(`tag dengan tipe ${JSON.stringify(type)}`, 'tag');
  }
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Bangun byte objek commit; pesan disimpan apa adanya. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  authorLine: string;
  committerLine: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.authorLine}`, `committer ${fields.committerLine}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Baris identitas `Nama <email> detik zona` untuk commit/tag. */
export function identLine(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${Math.trunc(epochSec)} +0000`;
}

/** Urai baris identitas menjadi nama, email, dan waktu ISO. */
export function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (match === null) return { name: line, email: '', date: '' };
  const epochSec = Number(match[3]);
  return {
    name: match[1] ?? '',
    email: match[2] ?? '',
    date: new Date(epochSec * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export type Pkt =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'end' };

/** Kodekan satu paket data: 4 hex panjang lalu muatan. */
export function encodePkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) {
    throw new GitError(`muatan pkt-line ${data.length} byte melebihi batas`, 'pktline');
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Kodekan urutan campuran paket data dan paket kontrol. */
export function encodePkts(items: ReadonlyArray<string | Buffer | 'flush' | 'delim' | 'end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else if (item === 'end') parts.push(Buffer.from('0002', 'ascii'));
    else parts.push(encodePkt(item));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Pembaca pkt-line berbasis kursor atas satu buffer utuh. `next()` mengembalikan
 * paket berikut atau null di ujung buffer; `offset` menandai byte yang belum
 * dibaca (dipakai receive-pack: sisa setelah flush adalah packfile).
 */
export class PktReader {
  readonly buffer: Buffer;
  offset = 0;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  next(): Pkt | null {
    if (this.remaining === 0) return null;
    if (this.remaining < 4) throw new GitError('pkt-line terpotong: kurang dari 4 byte', 'pktline');
    const head = this.buffer.subarray(this.offset, this.offset + 4).toString('ascii');
    if (!HEX4.test(head)) throw new GitError(`panjang pkt-line bukan hex: ${JSON.stringify(head)}`, 'pktline');
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      this.offset += 4;
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.offset += 4;
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.offset += 4;
      return { kind: 'end' };
    }
    if (length === 3) throw new GitError('panjang pkt-line 0003 tidak sah', 'pktline');
    if (length > PKT_LINE_MAX) throw new GitError(`pkt-line ${length} byte melebihi batas`, 'pktline');
    if (this.remaining < length) throw new GitError('pkt-line terpotong di tengah muatan', 'pktline');
    const payload = this.buffer.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return { kind: 'data', payload };
  }

  /** Semua paket sampai ujung buffer; menolak sisa byte yang tak terbingkai. */
  all(): Pkt[] {
    const packets: Pkt[] = [];
    for (;;) {
      const packet = this.next();
      if (packet === null) break;
      packets.push(packet);
    }
    return packets;
  }
}

/** Teks setiap paket data, paket kontrol dibuang, newline akhir dipangkas. */
export function pktLines(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// packfile: tulis
// ---------------------------------------------------------------------------

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rest = Math.floor(size / 16);
  let first = (code << 4) | (size & 0x0f);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Bangun packfile versi 2 tanpa delta dari objek-objek biasa. Trailer adalah
 * SHA-1 atas semua byte sebelumnya. Pack kosong (0 objek) sah: 32 byte.
 */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------
// packfile: baca (termasuk delta)
// ---------------------------------------------------------------------------

function readPackSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new GitError('entri pack tanpa header ukuran', 'pack');
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new GitError('varint ukuran pack terpotong', 'pack');
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new GitError('varint ukuran pack terlalu panjang', 'pack');
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new GitError('ofs-delta tanpa offset basis', 'pack');
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new GitError('offset basis ofs-delta terpotong', 'pack');
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate satu aliran zlib di `offset`; kembalikan byte dan offset sesudahnya. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new GitError(`aliran zlib di ${offset} gagal inflate: ${(err as Error).message}`, 'pack');
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new GitError(`aliran zlib di ${offset} tidak memakai byte`, 'pack');
  return { data: result.buffer, next: offset + written };
}

/** Terapkan delta git (aliran instruksi salin/sisip) ke byte basis. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= delta.length) throw new GitError('varint ukuran delta terpotong', 'delta');
      const byte = delta[at] as number;
      at += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new GitError('varint ukuran delta terlalu panjang', 'delta');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new GitError(`delta mengharap basis ${sourceSize} byte, dapat ${base.length}`, 'delta');
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (at < delta.length) {
    const op = delta[at] as number;
    at += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (at >= delta.length) throw new GitError('offset salin delta terpotong', 'delta');
          copyOffset += (delta[at] as number) * 2 ** shift;
          at += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (at >= delta.length) throw new GitError('ukuran salin delta terpotong', 'delta');
          copySize += (delta[at] as number) * 2 ** shift;
          at += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new GitError('salinan delta keluar dari basis', 'delta');
      if (written + copySize > targetSize) throw new GitError('delta menulis melewati ukuran target', 'delta');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (at + literal > delta.length) throw new GitError('sisipan delta terpotong', 'delta');
      if (written + literal > targetSize) throw new GitError('delta menulis melewati ukuran target', 'delta');
      delta.copy(out, written, at, at + literal);
      at += literal;
      written += literal;
    } else {
      throw new GitError('opcode delta 0 tidak sah', 'delta');
    }
  }
  if (written !== targetSize) throw new GitError(`delta menghasilkan ${written} dari ${targetSize} byte`, 'delta');
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: GitObjectType;
  resolved?: Buffer;
  oid?: string;
}

/**
 * Baca packfile (versi 2/3) dan uraikan semua objek, termasuk OFS_DELTA dan
 * REF_DELTA. `resolveBase` memasok basis yang pack tipis tinggalkan di luar.
 * Checksum trailer diverifikasi; ketidakcocokan adalah galat.
 */
export function readPack(pack: Buffer, resolveBase?: ObjectLookup): Map<string, GitObject> {
  if (pack.length === 0) return new Map();
  if (pack.length < 32) throw new GitError(`pack ${pack.length} byte terlalu pendek`, 'pack');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new GitError('pack tidak diawali PACK', 'pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new GitError(`versi pack ${version} tidak didukung`, 'pack');
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new GitError('checksum trailer pack tidak cocok', 'pack');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new GitError(`ofs-delta di ${entryOffset} menamai offset basis ${base.baseOffset} yang tidak sah`, 'pack');
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new GitError('id basis ref-delta terpotong', 'pack');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new GitError(`entri pack ${index} punya kode tipe ${typeCode} yang tidak dikenal`, 'pack');
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new GitError(`entri pack di ${entryOffset} menyatakan ${header.size} byte tapi inflate menjadi ${inflated.data.length}`, 'pack');
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new GitError(`pack punya ${trailerStart - offset} byte liar sebelum trailer`, 'pack');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();

  const resolve = (entry: RawPackEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new GitError(`siklus delta di offset pack ${entry.offset}`, 'pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new GitError(`basis ofs-delta di offset ${entry.baseOffset} tidak ada di pack`, 'pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (external === undefined) throw new GitError(`basis ref-delta ${wanted} tidak ada di pack maupun di store`, 'pack');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------
// traversal
// ---------------------------------------------------------------------------

/** Semua objek yang terjangkau dari `roots`; melempar bila ada yang hilang (kecuali allowMissing). */
export function collectClosure(
  lookup: ObjectLookup,
  roots: Iterable<string>,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) {
      if (options.allowMissing === true) continue;
      throw new GitError(`objek ${oid} hilang dari store`, 'missing');
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Kupas rantai tag sampai commit; null bila hilang atau bukan commit/tag. */
export function peelToCommit(lookup: ObjectLookup, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = lookup(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
}

/** Kupas satu tag ke targetnya (atau dirinya sendiri bila bukan tag). */
export function peelOne(lookup: ObjectLookup, oid: string): string {
  const object = lookup(oid);
  if (object !== undefined && object.type === 'tag') return parseTag(object.data).object;
  return oid;
}

function commitParentsOf(lookup: ObjectLookup, oid: string): string[] {
  const object = lookup(oid);
  if (object === undefined || object.type !== 'commit') return [];
  return parseCommit(object.data).parents;
}

function commitTreeOf(lookup: ObjectLookup, oid: string): string | null {
  const object = lookup(oid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Benar bila `ancestor` adalah leluhur dari (atau sama dengan) `descendant`. */
export function isAncestor(lookup: ObjectLookup, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    for (const parent of commitParentsOf(lookup, oid)) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** Leluhur bersama terdekat dua commit (BFS dari kedua sisi); null bila tidak ada. */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  const distA = new Map<string, number>();
  const queueA: string[] = [a];
  distA.set(a, 0);
  while (queueA.length > 0) {
    const oid = queueA.shift() as string;
    const depth = distA.get(oid) as number;
    for (const parent of commitParentsOf(lookup, oid)) {
      if (!distA.has(parent)) {
        distA.set(parent, depth + 1);
        queueA.push(parent);
      }
    }
  }
  const seenB = new Set<string>([b]);
  const queueB: string[] = [b];
  while (queueB.length > 0) {
    const oid = queueB.shift() as string;
    if (distA.has(oid)) return oid;
    for (const parent of commitParentsOf(lookup, oid)) {
      if (!seenB.has(parent)) {
        seenB.add(parent);
        queueB.push(parent);
      }
    }
  }
  return null;
}

/**
 * Daftar commit dari `tip` mengikuti parent, yang terbaru dulu (preorder,
 * commit sebelum parent-nya, tanpa duplikat). Untuk riwayat linear ini persis
 * urutan rantai; untuk merge, urutan kunjungan BFS per generasi.
 */
export function listAncestry(lookup: ObjectLookup, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return order;
}

// ---------------------------------------------------------------------------
// tree sebagai peta path
// ---------------------------------------------------------------------------

export interface FlatEntry {
  readonly oid: string;
  readonly mode: string;
}

/** Ratakan tree menjadi peta path lengkap -> entri (rekursif, tanpa gitlink). */
export function flattenTree(lookup: ObjectLookup, treeOid: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/**
 * Tree baru dengan `segments` diatur ke `blobOid` (atau dihapus bila null),
 * berdasar tree lama. Subtree yang kosong diprune. Mengembalikan id tree baru,
 * atau null bila tree hasil kosong total (pemanggil memakai pohon kosong).
 */
export function updateTree(
  lookup: ObjectLookup,
  put: (type: GitObjectType, data: Buffer) => string,
  baseTreeOid: string | null,
  segments: readonly string[],
  blobOid: string | null,
): string | null {
  const head = segments[0] as string;
  const rest = segments.slice(1);
  const entries: TreeEntry[] = [];
  if (baseTreeOid !== null) {
    const object = lookup(baseTreeOid);
    if (object !== undefined && object.type === 'tree') entries.push(...parseTree(object.data));
  }
  const kept = entries.filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    if (blobOid !== null) kept.push({ mode: '100644', name: head, oid: blobOid });
  } else {
    const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
    const child = updateTree(lookup, put, existing?.oid ?? null, rest, blobOid);
    if (child !== null) kept.push({ mode: '40000', name: head, oid: child });
  }
  if (kept.length === 0) return null;
  return put('tree', buildTree(kept));
}

/** Bangun tree dari peta path lengkap (dipakai hasil merge). */
export function treeFromFlat(
  put: (type: GitObjectType, data: Buffer) => string,
  flat: ReadonlyMap<string, FlatEntry>,
): string {
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push({ mode: entry.mode, name: parts[parts.length - 1] as string, oid: entry.oid });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------------------
// diff dan merge
// ---------------------------------------------------------------------------

export type DiffStatus = 'added' | 'modified' | 'deleted';

export interface DiffEntry {
  readonly path: string;
  readonly status: DiffStatus;
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

/** Bandingkan dua tree rata: entri yang ditambah, diubah, atau dihapus. */
export function diffFlats(a: ReadonlyMap<string, FlatEntry>, b: ReadonlyMap<string, FlatEntry>): DiffEntry[] {
  const paths = new Set<string>([...a.keys(), ...b.keys()]);
  const out: DiffEntry[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = a.get(path);
    const newEntry = b.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      out.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      out.push({ path, status: 'deleted', oldOid: oldEntry.oid, newOid: null });
    } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      out.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
    }
  }
  return out;
}

/** Hitung baris teks (byte \n), untuk additions/deletions. */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.length;
}

/**
 * Merge tiga arah di tingkat path: perubahan dari `theirs` terhadap `base`
 * diterapkan ke `ours`. Konflik bila kedua sisi mengubah path yang sama
 * menjadi blob yang berbeda.
 */
export function mergeFlats(
  base: ReadonlyMap<string, FlatEntry>,
  ours: ReadonlyMap<string, FlatEntry>,
  theirs: ReadonlyMap<string, FlatEntry>,
): { merged: Map<string, FlatEntry>; conflicts: string[] } {
  const merged = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const bOid = b?.oid ?? null;
    const oOid = o?.oid ?? null;
    const tOid = t?.oid ?? null;
    if (oOid === tOid) {
      if (o !== undefined) merged.set(path, o);
    } else if (oOid === bOid) {
      if (t !== undefined) merged.set(path, t);
    } else if (tOid === bOid) {
      if (o !== undefined) merged.set(path, o);
    } else {
      conflicts.push(path);
      if (o !== undefined) merged.set(path, o);
    }
  }
  return { merged, conflicts };
}

// ---------------------------------------------------------------------------
// pemilihan objek untuk fetch (v2 dan v0)
// ---------------------------------------------------------------------------

export interface FetchSelection {
  /** Objek yang harus dikirim (id -> objek), dalam urutan pengiriman. */
  readonly objects: GitObject[];
  /** Batas shallow baru yang harus dilaporkan klien. */
  readonly shallow: string[];
  /** Batas shallow lama yang kini tidak shallow lagi. */
  readonly unshallow: string[];
  /** Have pertama yang merupakan leluhur dari want (untuk ACK), atau null. */
  readonly ack: string | null;
}

/**
 * Pilih objek untuk satu fetch. `wants` adalah commit/tag yang diminta,
 * `haves` yang sudah dimiliki klien, `shallow` batas shallow klien saat ini,
 * dan `depth` batas kedalaman (bila ada). Aturan pengecualian: closure dari
 * haves, tetapi traversal tidak menyeberangi commit yang ada di `shallow`
 * (klien memegang commit itu tapi bukan leluhurnya).
 */
export function selectFetchObjects(
  lookup: ObjectLookup,
  request: { wants: readonly string[]; haves: readonly string[]; shallow: readonly string[]; depth?: number },
): FetchSelection {
  const priorShallow = new Set(request.shallow);
  const depthLimit = request.depth !== undefined && request.depth >= 1 ? request.depth : null;

  // 1. Benih traversal: kupas tag, kumpulkan objek tag dan benih non-commit.
  const tagObjects: GitObject[] = [];
  const seedCommits: string[] = [];
  const directRoots: string[] = [];
  for (const want of new Set(request.wants)) {
    const object = lookup(want);
    if (object === undefined) throw new GitError(`want ${want} tidak ada di store`, 'fetch');
    if (object.type === 'tag') {
      let current = want;
      const chain = new Set<string>();
      for (;;) {
        if (chain.has(current)) break;
        chain.add(current);
        const tagObject = lookup(current);
        if (tagObject === undefined || tagObject.type !== 'tag') break;
        tagObjects.push(tagObject);
        current = parseTag(tagObject.data).object;
      }
      const target = lookup(current);
      if (target === undefined) throw new GitError(`target tag ${current} tidak ada di store`, 'fetch');
      if (target.type === 'commit') seedCommits.push(current);
      else directRoots.push(current);
    } else if (object.type === 'commit') {
      seedCommits.push(want);
    } else {
      directRoots.push(want);
    }
  }

  // 2. Traversal commit berbatas kedalaman (BFS: kedalaman terpendek menang).
  const visited = new Map<string, number>();
  const boundary = new Set<string>();
  const visitOrder: string[] = [];
  const queue: Array<{ oid: string; depth: number }> = seedCommits.map((oid) => ({ oid, depth: 1 }));
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (visited.has(oid)) continue;
    visited.set(oid, depth);
    visitOrder.push(oid);
    const parents = commitParentsOf(lookup, oid);
    if (depthLimit !== null && depth >= depthLimit) {
      if (parents.length > 0) boundary.add(oid);
      continue;
    }
    for (const parent of parents) {
      if (!visited.has(parent)) queue.push({ oid: parent, depth: depth + 1 });
    }
  }

  // 3. Himpunan pengecualian dari haves (traversal berhenti di batas shallow lama).
  const excluded = new Set<string>();
  const excludedCommits = new Set<string>();
  const expandHave = (have: string): void => {
    const peeled = peelToCommit(lookup, have);
    const stack: string[] = peeled !== null ? [peeled] : [];
    if (peeled === null) {
      // Have bukan commit: kecualikan closure-nya saja.
      for (const oid of collectClosure(lookup, [have], { allowMissing: true })) excluded.add(oid);
      return;
    }
    // Bila have adalah tag, tag-nya sendiri juga sudah dimiliki klien.
    if (have !== peeled) excluded.add(have);
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (excludedCommits.has(oid)) continue;
      excludedCommits.add(oid);
      excluded.add(oid);
      const tree = commitTreeOf(lookup, oid);
      if (tree !== null) {
        for (const reachable of collectClosure(lookup, [tree], { allowMissing: true })) excluded.add(reachable);
      }
      if (priorShallow.has(oid)) continue;
      for (const parent of commitParentsOf(lookup, oid)) stack.push(parent);
    }
  };
  for (const have of new Set(request.haves)) expandHave(have);

  // 4. Himpunan kirim: commit terjangkau + closure tree-nya + tag + akar langsung, minus pengecualian.
  const send = new Map<string, GitObject>();
  for (const oid of visitOrder) {
    const commit = lookup(oid);
    if (commit !== undefined && !excluded.has(oid)) send.set(oid, commit);
    const tree = commitTreeOf(lookup, oid);
    if (tree !== null) {
      for (const reachable of collectClosure(lookup, [tree], { allowMissing: true })) {
        if (excluded.has(reachable)) continue;
        const object = lookup(reachable);
        if (object !== undefined) send.set(reachable, object);
      }
    }
  }
  for (const tagObject of tagObjects) {
    const oid = hashObject('tag', tagObject.data);
    if (!excluded.has(oid)) send.set(oid, tagObject);
  }
  for (const root of directRoots) {
    for (const reachable of collectClosure(lookup, [root], { allowMissing: true })) {
      if (excluded.has(reachable)) continue;
      const object = lookup(reachable);
      if (object !== undefined) send.set(reachable, object);
    }
  }

  // Urutan pengiriman deterministik: commit sesuai urutan kunjungan, sisanya urut id.
  const ordered: GitObject[] = [];
  const seenOrdered = new Set<string>();
  for (const oid of visitOrder) {
    const object = send.get(oid);
    if (object !== undefined) {
      ordered.push(object);
      seenOrdered.add(oid);
    }
  }
  const rest = [...send.entries()]
    .filter(([oid]) => !seenOrdered.has(oid))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [, object] of rest) ordered.push(object);

  // 5. shallow-info: batas baru dan batas lama yang terbuka.
  const shallow = depthLimit === null ? [] : [...boundary].sort();
  const unshallow: string[] = [];
  for (const old of priorShallow) {
    if (!visited.has(old) || boundary.has(old)) continue;
    const parents = commitParentsOf(lookup, old);
    const allKnown = parents.every((parent) => visited.has(parent) || excludedCommits.has(parent));
    if (allKnown) unshallow.push(old);
  }
  unshallow.sort();

  // 6. ACK: have pertama yang merupakan leluhur dari want mana pun.
  let ack: string | null = null;
  if (request.haves.length > 0 && seedCommits.length > 0) {
    const ancestors = new Set<string>();
    const stack = [...seedCommits];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (ancestors.has(oid)) continue;
      ancestors.add(oid);
      for (const parent of commitParentsOf(lookup, oid)) stack.push(parent);
    }
    for (const have of request.haves) {
      const peeled = peelToCommit(lookup, have);
      if (peeled !== null && ancestors.has(peeled)) {
        ack = have;
        break;
      }
      if (ancestors.has(have)) {
        ack = have;
        break;
      }
    }
  }

  return { objects: ordered, shallow, unshallow, ack };
}
