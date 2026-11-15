/**
 * forge.ts — status bersama untuk semua permukaan (git, REST, GraphQL, MCP):
 * repositori, objek git, ref, issue, pull request, label, dan komentar.
 *
 * Semua waktu berasal dari MAKEFUN_TRIAL_NOW ditambah penghitung monoton,
 * sehingga balasan identik antar putaran ulang (replay) dengan urutan
 * permintaan yang sama. Tidak ada keacakan tanpa benih dan tidak ada jam
 * dinding di nilai apa pun yang dikirim keluar.
 */

import {
  EMPTY_TREE_OID,
  GitError,
  ZERO_OID,
  buildCommit,
  collectClosure,
  countLines,
  diffFlats,
  flattenTree,
  hashObject,
  identLine,
  isAncestor,
  listAncestry,
  mergeBase,
  mergeFlats,
  parseCommit,
  parseIdent,
  parseTag,
  parseTree,
  treeFromFlat,
  updateTree,
  type DiffEntry,
  type FlatEntry,
  type GitObject,
  type GitObjectType,
} from './gitobj.ts';

export { EMPTY_TREE_OID, GitError, ZERO_OID };

export interface Repo {
  readonly id: number;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  /** Bertambah setiap kali ref berubah; dipakai untuk menginvalidasi cache fetch. */
  generation: number;
  /** Objek git milik repo ini, diindeks id SHA-1. */
  readonly objects: Map<string, GitObject>;
  /** Ref lengkap -> id commit/tag. */
  readonly refs: Map<string, string>;
  readonly issues: Issue[];
  readonly issuesByNumber: Map<number, Issue>;
  readonly pulls: PullRequest[];
  readonly pullsByNumber: Map<number, PullRequest>;
  readonly labels: Map<string, Label>;
  /** Penghitung nomor bersama issue/PR, mulai dari 1 (perilaku GitHub). */
  nextNumber: number;
  nextCommentId: number;
}

export interface Label {
  readonly name: string;
  color: string;
}

export interface Comment {
  readonly id: number;
  body: string;
  readonly createdAt: string;
  updatedAt: string;
}

export type IssueState = 'open' | 'closed';

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: IssueState;
  readonly labels: string[];
  readonly comments: Comment[];
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: IssueState;
  merged: boolean;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly baseSha: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly comments: Comment[];
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface CommitInfo {
  readonly sha: string;
  readonly tree: string;
  readonly parents: string[];
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorDate: string;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly committerDate: string;
  readonly message: string;
}

/** Detik dasar dari MAKEFUN_TRIAL_NOW (epoch ms/detik atau ISO); cadangan tetap. */
function trialBaseSeconds(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    if (Number.isFinite(value)) return value > 1e12 ? Math.trunc(value / 1000) : Math.trunc(value);
  }
  if (raw !== '') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.trunc(parsed / 1000);
  }
  return 1735689600;
}

export class Forge {
  /** Login pemilik token, dipelajari dari permintaan pertama yang menamai owner repo yang ada. */
  owner: string | null = null;
  private readonly reposByName = new Map<string, Repo>();
  private readonly reposById = new Map<number, Repo>();
  private nextRepoId = 1;
  private nextItemId = 1;
  private requestCounter = 0;
  private readonly baseSec: number;
  private timeCounter = 0;

  constructor() {
    this.baseSec = trialBaseSeconds();
  }

  // -- waktu dan id permintaan (deterministik) -------------------------------

  /** Detik monoton untuk stempel baru: dasar + penghitung. */
  tickSeconds(): number {
    const value = this.baseSec + this.timeCounter;
    this.timeCounter += 1;
    return value;
  }

  nowIso(): string {
    return new Date(this.tickSeconds() * 1000).toISOString();
  }

  nextRequestId(): string {
    this.requestCounter += 1;
    return `req-${this.requestCounter}`;
  }

  /** Identitas penulis/commit untuk commit yang dibangun server. */
  serverIdentity(): { name: string; email: string } {
    if (this.owner !== null) return { name: this.owner, email: `${this.owner}@example.invalid` };
    return { name: 'forge', email: 'forge@example.invalid' };
  }

  // -- repositori ------------------------------------------------------------

  /** Pelajari owner dari permintaan repo yang berhasil; yang pertama menang. */
  learnOwner(owner: string): void {
    if (this.owner === null && owner !== '') this.owner = owner;
  }

  /**
   * Cari repo berdasarkan owner+nama. Bila repo ada dan owner belum dipelajari,
   * owner dipelajari dari panggilan ini. Owner lain setelahnya -> null (404).
   */
  resolveRepo(owner: string, name: string): Repo | null {
    const repo = this.reposByName.get(name);
    if (repo === undefined) return null;
    if (this.owner === null) this.owner = owner;
    if (owner !== this.owner) return null;
    return repo;
  }

  getRepoByName(name: string): Repo | null {
    return this.reposByName.get(name) ?? null;
  }

  getRepoById(id: number): Repo | null {
    return this.reposById.get(id) ?? null;
  }

  listRepos(): Repo[] {
    return [...this.reposByName.values()];
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | 'exists' {
    if (this.reposByName.has(name)) return 'exists';
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      generation: 0,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      issuesByNumber: new Map(),
      pulls: [],
      pullsByNumber: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    this.reposByName.set(name, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    const repo = this.reposByName.get(name);
    if (repo === undefined) return false;
    this.reposByName.delete(name);
    this.reposById.delete(repo.id);
    return true;
  }

  // -- objek dan ref -----------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.generation += 1;
    repo.updatedAt = this.nowIso();
  }

  deleteRef(repo: Repo, ref: string): boolean {
    const existed = repo.refs.delete(ref);
    if (existed) {
      repo.generation += 1;
      repo.updatedAt = this.nowIso();
    }
    return existed;
  }

  headTip(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  /** Semua ref yang tercatat, diurutkan seperti git mengiklankannya. */
  listRefs(repo: Repo): Array<{ ref: string; oid: string }> {
    return [...repo.refs.entries()]
      .map(([ref, oid]) => ({ ref, oid }))
      .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, oid] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha: oid });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Selesaikan nama ref: nama cabang, ref lengkap, atau id commit/tag. */
  resolveRevision(repo: Repo, revision: string): string | null {
    const direct = repo.refs.get(revision);
    if (direct !== undefined) return direct;
    const branch = repo.refs.get(`refs/heads/${revision}`);
    if (branch !== undefined) return branch;
    const tag = repo.refs.get(`refs/tags/${revision}`);
    if (tag !== undefined) return tag;
    const object = repo.objects.get(revision);
    if (object !== undefined && (object.type === 'commit' || object.type === 'tag')) return revision;
    return null;
  }

  // -- commit ------------------------------------------------------------------

  /** Commit baru yang dibangun server dengan identitas dan waktu deterministik. */
  createCommit(
    repo: Repo,
    fields: { tree: string; parents: readonly string[]; message: string },
  ): string {
    const identity = this.serverIdentity();
    const epoch = this.tickSeconds();
    const line = identLine(identity.name, identity.email, epoch);
    const data = buildCommit({
      tree: fields.tree,
      parents: fields.parents,
      authorLine: line,
      committerLine: line,
      message: fields.message,
    });
    return this.putObject(repo, 'commit', data);
  }

  commitInfo(repo: Repo, sha: string): CommitInfo | null {
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') return null;
    const view = parseCommit(object.data);
    const author = parseIdent(view.author);
    const committer = parseIdent(view.committer);
    return {
      sha,
      tree: view.tree,
      parents: view.parents,
      authorName: author.name,
      authorEmail: author.email,
      authorDate: author.date,
      committerName: committer.name,
      committerEmail: committer.email,
      committerDate: committer.date,
      message: view.message,
    };
  }

  /** Daftar commit dari ujung, terbaru dulu, beserta info terurai. */
  listCommitInfos(repo: Repo, tip: string): CommitInfo[] {
    const out: CommitInfo[] = [];
    for (const sha of listAncestry(this.lookup(repo), tip)) {
      const info = this.commitInfo(repo, sha);
      if (info !== null) out.push(info);
    }
    return out;
  }

  /** Id commit dari revisi apa pun (kupasan tag bila perlu); null bila tidak ada. */
  revisionCommit(repo: Repo, revision: string): string | null {
    const oid = this.resolveRevision(repo, revision);
    if (oid === null) return null;
    const object = repo.objects.get(oid);
    if (object === undefined) return null;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') {
      let current = parseTag(object.data).object;
      const seen = new Set<string>();
      while (!seen.has(current)) {
        seen.add(current);
        const target = repo.objects.get(current);
        if (target === undefined) return null;
        if (target.type === 'commit') return current;
        if (target.type !== 'tag') return null;
        current = parseTag(target.data).object;
      }
    }
    return null;
  }

  // -- isi berkas (contents API) ----------------------------------------------

  /**
   * Baca path pada commit: berkas -> {kind:'file', ...}, direktori -> entri
   * anak langsung, tidak ada -> null. Path kosong berarti akar repo.
   */
  readPath(
    repo: Repo,
    commitOid: string,
    path: string,
  ):
    | { kind: 'file'; oid: string; data: Buffer; mode: string }
    | { kind: 'dir'; entries: Array<{ name: string; path: string; oid: string; type: 'file' | 'dir' }> }
    | null {
    const info = this.commitInfo(repo, commitOid);
    if (info === null) return null;
    const segments = path === '' ? [] : path.split('/').filter((part) => part !== '');
    let treeOid = info.tree;
    for (let i = 0; i < segments.length; i += 1) {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return null;
      const wanted = segments[i] as string;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === wanted);
      if (entry === undefined) return null;
      const isLast = i === segments.length - 1;
      if (entry.mode === '40000') {
        if (isLast) {
          const dir = repo.objects.get(entry.oid);
          if (dir === undefined || dir.type !== 'tree') return null;
          return { kind: 'dir', entries: dirEntries(parseTree(dir.data), path) };
        }
        treeOid = entry.oid;
      } else {
        if (!isLast) return null;
        const blob = repo.objects.get(entry.oid);
        if (blob === undefined || blob.type !== 'blob') return null;
        return { kind: 'file', oid: entry.oid, data: blob.data, mode: entry.mode };
      }
    }
    const root = repo.objects.get(treeOid);
    if (root === undefined || root.type !== 'tree') return null;
    return { kind: 'dir', entries: dirEntries(parseTree(root.data), '') };
  }

  /**
   * Tulis berkas pada cabang: buat blob, tree baru, dan commit baru. Bila
   * cabang belum ada, ia dibuat dari ujung cabang default (atau sebagai akar
   * bila repo belum lahir). Mengembalikan commit dan id blob baru.
   */
  writePath(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string; created: boolean } {
    const ref = `refs/heads/${branch}`;
    const existingTip = repo.refs.get(ref);
    const created = existingTip === undefined;
    let baseTree: string | null = null;
    const parents: string[] = [];
    if (existingTip !== undefined) {
      const info = this.commitInfo(repo, existingTip);
      if (info !== null) {
        baseTree = info.tree;
        parents.push(existingTip);
      }
    } else {
      const head = this.headTip(repo);
      if (head !== null) {
        const info = this.commitInfo(repo, head);
        if (info !== null) {
          baseTree = info.tree;
          parents.push(head);
        }
      }
    }
    const blobSha = this.putObject(repo, 'blob', content);
    const segments = path.split('/').filter((part) => part !== '');
    const newTree = updateTree(this.lookup(repo), (type, data) => this.putObject(repo, type, data), baseTree, segments, blobSha);
    const treeOid = newTree ?? this.putObject(repo, 'tree', Buffer.alloc(0));
    const commitSha = this.createCommit(repo, { tree: treeOid, parents, message });
    repo.refs.set(ref, commitSha);
    repo.generation += 1;
    repo.updatedAt = this.nowIso();
    return { commitSha, blobSha, created };
  }

  /**
   * Hapus berkas pada cabang. Mengembalikan commit baru, atau null bila
   * berkasnya tidak ada di ujung cabang.
   */
  deletePath(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return null;
    const info = this.commitInfo(repo, tip);
    if (info === null) return null;
    const segments = path.split('/').filter((part) => part !== '');
    const flat = flattenTree(this.lookup(repo), info.tree);
    if (!flat.has(path)) return null;
    const newTree = updateTree(this.lookup(repo), (type, data) => this.putObject(repo, type, data), info.tree, segments, null);
    const treeOid = newTree ?? this.putObject(repo, 'tree', Buffer.alloc(0));
    const commitSha = this.createCommit(repo, { tree: treeOid, parents: [tip], message });
    repo.refs.set(ref, commitSha);
    repo.generation += 1;
    repo.updatedAt = this.nowIso();
    return { commitSha };
  }

  /** Id blob pada path di ujung cabang, atau null bila tidak ada/tidak berkas. */
  blobAt(repo: Repo, branch: string, path: string): string | null {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return null;
    const found = this.readPath(repo, tip, path);
    if (found === null || found.kind !== 'file') return null;
    return found.oid;
  }

  // -- label, issue, PR, komentar ----------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing !== undefined) {
      existing.color = color;
      return existing;
    }
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue {
    const now = this.nowIso();
    const issue: Issue = {
      id: this.nextItemId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labelNames],
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    this.nextItemId += 1;
    repo.nextNumber += 1;
    repo.issues.push(issue);
    repo.issuesByNumber.set(issue.number, issue);
    return issue;
  }

  createPullRequest(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
  ): PullRequest | 'unknown-branch' | 'duplicate' {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined || baseSha === undefined) return 'unknown-branch';
    for (const existing of repo.pulls) {
      if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) return 'duplicate';
    }
    const now = this.nowIso();
    const pr: PullRequest = {
      id: this.nextItemId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      headRef,
      baseRef,
      headSha,
      baseSha,
      mergedAt: null,
      mergeCommitSha: null,
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    this.nextItemId += 1;
    repo.nextNumber += 1;
    repo.pulls.push(pr);
    repo.pullsByNumber.set(pr.number, pr);
    return pr;
  }

  addComment(target: Issue | PullRequest, body: string, repo: Repo): Comment {
    const now = this.nowIso();
    const comment: Comment = { id: repo.nextCommentId, body, createdAt: now, updatedAt: now };
    repo.nextCommentId += 1;
    target.comments.push(comment);
    target.updatedAt = now;
    return comment;
  }

  // -- diff dan merge PR --------------------------------------------------------

  /** Flat map tree dari commit; peta kosong bila commit tidak ada. */
  flatAt(repo: Repo, commitOid: string): Map<string, FlatEntry> {
    const info = this.commitInfo(repo, commitOid);
    if (info === null) return new Map();
    return flattenTree(this.lookup(repo), info.tree);
  }

  /** Merge-base antara ujung head dan base saat ini (bukan sha saat dibuat). */
  prMergeBase(repo: Repo, pr: PullRequest): string | null {
    const head = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
    const base = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
    return mergeBase(this.lookup(repo), head, base);
  }

  /** Entri diff PR: head saat ini terhadap merge-base. */
  prDiff(repo: Repo, pr: PullRequest): DiffEntry[] {
    const base = this.prMergeBase(repo, pr);
    const baseFlat = base === null ? new Map<string, FlatEntry>() : this.flatAt(repo, base);
    const head = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
    return diffFlats(baseFlat, this.flatAt(repo, head));
  }

  /** Baris yang ditambah/dihapus untuk satu entri diff (hitungan kasar per blob). */
  diffLineCounts(repo: Repo, entry: DiffEntry): { additions: number; deletions: number } {
    const lines = (oid: string | null): number => {
      if (oid === null) return 0;
      const object = repo.objects.get(oid);
      return object === undefined ? 0 : countLines(object.data);
    };
    if (entry.status === 'added') return { additions: lines(entry.newOid), deletions: 0 };
    if (entry.status === 'deleted') return { additions: 0, deletions: lines(entry.oldOid) };
    return { additions: lines(entry.newOid), deletions: lines(entry.oldOid) };
  }

  /** Konflik merge saat ini antara head dan base terhadap merge-base. */
  prConflicts(repo: Repo, pr: PullRequest): string[] {
    const base = this.prMergeBase(repo, pr);
    const baseFlat = base === null ? new Map<string, FlatEntry>() : this.flatAt(repo, base);
    const head = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
    const { conflicts } = mergeFlats(baseFlat, this.flatAt(repo, baseTip), this.flatAt(repo, head));
    return conflicts;
  }

  isMergeable(repo: Repo, pr: PullRequest): boolean {
    if (pr.state !== 'open') return false;
    return this.prConflicts(repo, pr).length === 0;
  }

  /**
   * Gabungkan PR. 'squash' (bawaan) dan 'rebase' memakai satu commit dengan
   * parent tunggal; 'merge' memakai commit merge dua parent. Mengembalikan
   * sha commit merge, atau status konflik/tidak-bisa.
   */
  mergePullRequest(
    repo: Repo,
    pr: PullRequest,
    method: string,
    messageOverride?: string,
  ): { ok: true; sha: string } | { ok: false; reason: 'conflict' | 'closed' | 'missing-branch' } {
    if (pr.state !== 'open') return { ok: false, reason: 'closed' };
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return { ok: false, reason: 'missing-branch' };
    const base = mergeBase(this.lookup(repo), headTip, baseTip);
    const baseFlat = base === null ? new Map<string, FlatEntry>() : this.flatAt(repo, base);
    const { merged, conflicts } = mergeFlats(baseFlat, this.flatAt(repo, baseTip), this.flatAt(repo, headTip));
    if (conflicts.length > 0) return { ok: false, reason: 'conflict' };
    const treeOid = treeFromFlat((type, data) => this.putObject(repo, type, data), merged);
    const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
    const message = messageOverride ?? (method === 'merge' ? `Merge pull request #${pr.number} from ${pr.headRef}` : pr.title);
    const sha = this.createCommit(repo, { tree: treeOid, parents, message });
    repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
    repo.generation += 1;
    const now = this.nowIso();
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = now;
    pr.mergeCommitSha = sha;
    pr.closedAt = now;
    pr.updatedAt = now;
    repo.updatedAt = now;
    return { ok: true, sha };
  }

  /** Benar bila `descendant` adalah turunan dari `ancestor` (atau sama). */
  isDescendant(repo: Repo, ancestor: string, descendant: string): boolean {
    return isAncestor(this.lookup(repo), ancestor, descendant);
  }

  /** Closure objek dari akar-akar; dipakai health check internal saja. */
  closure(repo: Repo, roots: Iterable<string>): Set<string> {
    return collectClosure(this.lookup(repo), roots, { allowMissing: true });
  }
}

/** Bantu: entri direktori untuk jawaban contents API. */
function dirEntries(
  entries: ReadonlyArray<{ mode: string; name: string; oid: string }>,
  basePath: string,
): Array<{ name: string; path: string; oid: string; type: 'file' | 'dir' }> {
  return entries.map((entry) => ({
    name: entry.name,
    path: basePath === '' ? entry.name : `${basePath}/${entry.name}`,
    oid: entry.oid,
    type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
  }));
}
