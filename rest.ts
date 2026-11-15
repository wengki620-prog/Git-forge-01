/**
 * rest.ts — REST API v3 di bawah /api/v3: root, meta, user, repositori,
 * cabang, commit, isi berkas, ref git, label, issue, komentar, dan pull
 * request beserta merge-nya.
 *
 * Setiap jawaban berformat JSON dan membawa X-GitHub-Request-Id (dipasang
 * terpusat oleh app.ts). Autentikasi diperiksa terpusat sebelum router ini
 * dipanggil. Segmen path sudah didekode per segmen oleh app.ts.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, type Comment, type Issue, type Label, type PullRequest, type Repo } from './forge.ts';
import { sendError, sendJson, sendNoContent } from './respond.ts';

export type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Nama label dari entri string atau objek {name}. */
function labelNameOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.name === 'string') return value.name;
  return null;
}

/** Nama cabang dari string atau objek {ref}; awalan "owner:" dibuang. */
function branchNameOf(value: unknown): string | null {
  let raw: string | null = null;
  if (typeof value === 'string') raw = value;
  else if (isRecord(value) && typeof value.ref === 'string') raw = value.ref;
  if (raw === null) return null;
  const colon = raw.lastIndexOf(':');
  return colon >= 0 ? raw.slice(colon + 1) : raw;
}

/** Nama repo yang sah: string tak kosong tanpa '/'. */
function validRepoName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (name === '' || name.includes('/')) return null;
  return name;
}

// ---------------------------------------------------------------------------
// bentuk JSON
// ---------------------------------------------------------------------------

function userJson(forge: Forge): JsonRecord {
  const login = forge.owner ?? '';
  return {
    login,
    id: 1,
    node_id: 'U1',
    type: 'User',
    site_admin: false,
    name: login,
    email: login === '' ? '' : `${login}@example.invalid`,
  };
}

export function repoJson(forge: Forge, repo: Repo): JsonRecord {
  const login = forge.owner ?? '';
  return {
    id: repo.id,
    node_id: `R${repo.id}`,
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: userJson(forge),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
  };
}

function labelJson(label: Label): JsonRecord {
  return { name: label.name, color: label.color, description: '' };
}

function issueJson(forge: Forge, repo: Repo, issue: Issue, asPullRequest = false): JsonRecord {
  const body: JsonRecord = {
    id: issue.id,
    node_id: `I${repo.id}:${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(label) : { name, color: 'ededed', description: '' };
    }),
    user: userJson(forge),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
  };
  if (asPullRequest) body.pull_request = {};
  return body;
}

export function pullJson(forge: Forge, repo: Repo, pr: PullRequest): JsonRecord {
  const headSha = forge.getRef(repo, `refs/heads/${pr.headRef}`) ?? pr.headSha;
  const baseSha = forge.getRef(repo, `refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  const login = forge.owner ?? '';
  return {
    id: pr.id,
    node_id: `P${repo.id}:${pr.number}`,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    user: userJson(forge),
    head: { ref: pr.headRef, sha: headSha, label: `${login}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: baseSha, label: `${login}:${pr.baseRef}` },
    merged: pr.merged,
    mergeable: forge.isMergeable(repo, pr),
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    comments: pr.comments.length,
    draft: false,
  };
}

function commentJson(forge: Forge, repo: Repo, comment: Comment): JsonRecord {
  return {
    id: comment.id,
    node_id: `C${repo.id}:${comment.id}`,
    body: comment.body,
    user: userJson(forge),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function branchJson(name: string, sha: string): JsonRecord {
  return { name, commit: { sha }, protected: false };
}

function commitJson(forge: Forge, info: ReturnType<Forge['commitInfo']>): JsonRecord {
  if (info === null) return {};
  return {
    sha: info.sha,
    commit: {
      message: info.message,
      author: { name: info.authorName, email: info.authorEmail, date: info.authorDate },
      committer: { name: info.committerName, email: info.committerEmail, date: info.committerDate },
      tree: { sha: info.tree },
    },
    parents: info.parents.map((sha) => ({ sha })),
    author: userJson(forge),
    committer: userJson(forge),
  };
}

function refJson(ref: string, oid: string, type: string): JsonRecord {
  return { ref, object: { sha: oid, type }, node_id: `REF${oid.slice(0, 12)}` };
}

// ---------------------------------------------------------------------------
// paginasi
// ---------------------------------------------------------------------------

interface PageResult<T> {
  readonly items: T[];
  readonly linkHeader: string | null;
}

/**
 * Paginasi daftar. Tanpa per_page, semua item dikembalikan tanpa header Link.
 * Dengan per_page, halaman dipotong dan Link absolut same-origin dibangun.
 */
function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
  request: IncomingMessage,
  rawPath: string,
): PageResult<T> {
  const perPageRaw = query.get('per_page');
  if (perPageRaw === null) return { items: [...items], linkHeader: null };
  const parsedPerPage = Number.parseInt(perPageRaw, 10);
  const perPage = Math.min(100, Math.max(1, Number.isInteger(parsedPerPage) ? parsedPerPage : 30));
  const parsedPage = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Math.max(1, Number.isInteger(parsedPage) ? parsedPage : 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const host = request.headers.host ?? 'localhost';
  const build = (targetPage: number): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(targetPage));
    return `http://${host}${rawPath}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${build(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${build(page - 1)}>; rel="prev"`);
  links.push(`<${build(1)}>; rel="first"`);
  links.push(`<${build(totalPages)}>; rel="last"`);
  return { items: slice, linkHeader: links.join(', ') };
}

function sendList<T>(
  response: ServerResponse,
  result: PageResult<T>,
): void {
  const headers: Record<string, string> = {};
  if (result.linkHeader !== null) headers.link = result.linkHeader;
  sendJson(response, 200, result.items, headers);
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

export interface RestContext {
  readonly query: URLSearchParams;
  readonly rawPath: string;
  /** Badan JSON yang sudah diurai ({} bila kosong); null bila JSON tidak sah. */
  readonly body: unknown;
}

export function handleRest(
  forge: Forge,
  request: IncomingMessage,
  response: ServerResponse,
  segments: readonly string[],
  context: RestContext,
): void {
  const method = request.method ?? 'GET';
  const { query } = context;

  if (context.body === null) {
    sendError(response, 400, 'badan JSON tidak sah');
    return;
  }
  const body: JsonRecord = isRecord(context.body) ? context.body : {};

  // -- root dan meta ---------------------------------------------------------
  if (segments.length === 0) {
    if (method !== 'GET') {
      sendError(response, 404, 'Not Found');
      return;
    }
    const host = request.headers.host ?? 'localhost';
    const base = `http://${host}/api/v3`;
    sendJson(
      response,
      200,
      {
        current_user_url: `${base}/user`,
        user_url: `${base}/users/{user}`,
        repos_url: `${base}/user/repos`,
        repository_url: `${base}/repos/{owner}/{repo}`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return;
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') {
      sendError(response, 404, 'Not Found');
      return;
    }
    sendJson(response, 200, { installed_version: '1.0.0' });
    return;
  }

  // -- /user ------------------------------------------------------------------
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET' || forge.owner === null) {
      sendError(response, 404, 'Not Found');
      return;
    }
    const user = userJson(forge);
    user.created_at = '2025-01-01T00:00:00.000Z';
    user.updated_at = '2025-01-01T00:00:00.000Z';
    sendJson(response, 200, user);
    return;
  }
  if (segments[0] === 'user' && segments.length === 2 && segments[1] === 'repos') {
    if (method === 'GET') {
      sendList(response, paginate(forge.listRepos().map((repo) => repoJson(forge, repo)), query, request, context.rawPath));
      return;
    }
    if (method === 'POST') {
      const name = validRepoName(body.name);
      if (name === null) {
        sendError(response, 422, 'nama repositori tidak sah');
        return;
      }
      const description = asString(body.description) ?? '';
      const isPrivate = asBoolean(body.private) ?? false;
      const created = forge.createRepo(name, description, isPrivate);
      if (created === 'exists') {
        sendError(response, 422, 'Repository already exists');
        return;
      }
      sendJson(response, 201, repoJson(forge, created));
      return;
    }
    sendError(response, 404, 'Not Found');
    return;
  }

  // -- /repos/{owner}/{repo}/... ----------------------------------------------
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const repoName = segments[2] as string;
    const repo = forge.resolveRepo(owner, repoName);
    if (repo === null) {
      sendError(response, 404, 'Not Found');
      return;
    }
    const rest = segments.slice(3);
    handleRepoRoute(forge, request, response, repo, rest, method, query, body, context);
    return;
  }

  sendError(response, 404, 'Not Found');
}

function handleRepoRoute(
  forge: Forge,
  request: IncomingMessage,
  response: ServerResponse,
  repo: Repo,
  rest: readonly string[],
  method: string,
  query: URLSearchParams,
  body: JsonRecord,
  context: RestContext,
): void {
  // -- repo itu sendiri -------------------------------------------------------
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(response, 200, repoJson(forge, repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.description === 'string' || body.description === null) {
        repo.description = body.description ?? '';
      }
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      repo.updatedAt = forge.nowIso();
      sendJson(response, 200, repoJson(forge, repo));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.name);
      sendNoContent(response);
      return;
    }
    sendError(response, 404, 'Not Found');
    return;
  }

  const head = rest[0] as string;

  // -- cabang ------------------------------------------------------------------
  if (head === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') {
        sendError(response, 404, 'Not Found');
        return;
      }
      const branches = forge.listBranches(repo).map((branch) => branchJson(branch.name, branch.sha));
      sendList(response, paginate(branches, query, request, context.rawPath));
      return;
    }
    if (method !== 'GET') {
      sendError(response, 404, 'Not Found');
      return;
    }
    const branchName = rest.slice(1).join('/');
    const sha = forge.getRef(repo, `refs/heads/${branchName}`);
    if (sha === undefined) {
      sendError(response, 404, 'Not Found');
      return;
    }
    sendJson(response, 200, branchJson(branchName, sha));
    return;
  }

  // -- commit ------------------------------------------------------------------
  if (head === 'commits') {
    if (rest.length === 1) {
      if (method !== 'GET') {
        sendError(response, 404, 'Not Found');
        return;
      }
      const revision = query.get('sha') ?? repo.defaultBranch;
      const commit = forge.revisionCommit(repo, revision);
      if (commit === null) {
        sendError(response, 404, 'Not Found');
        return;
      }
      const infos = forge.listCommitInfos(repo, commit).map((info) => commitJson(forge, info));
      sendList(response, paginate(infos, query, request, context.rawPath));
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      const info = forge.commitInfo(repo, rest[1] as string);
      if (info === null) {
        sendError(response, 404, 'Not Found');
        return;
      }
      sendJson(response, 200, commitJson(forge, info));
      return;
    }
    sendError(response, 404, 'Not Found');
    return;
  }

  // -- isi berkas ---------------------------------------------------------------
  if (head === 'contents') {
    handleContents(forge, request, response, repo, rest.slice(1).join('/'), method, query, body);
    return;
  }

  // -- ref git -------------------------------------------------------------------
  if (head === 'git' && rest[1] === 'refs') {
    handleGitRefs(forge, response, repo, rest.slice(2).join('/'), method, body);
    return;
  }

  // -- label ----------------------------------------------------------------------
  if (head === 'labels') {
    if (rest.length !== 1) {
      sendError(response, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      sendJson(response, 200, [...repo.labels.values()].map(labelJson));
      return;
    }
    if (method === 'POST') {
      const name = asString(body.name);
      if (name === null || name === '') {
        sendError(response, 422, 'nama label wajib diisi');
        return;
      }
      const color = asString(body.color) ?? 'ededed';
      const label = forge.createLabel(repo, name, color);
      sendJson(response, 201, labelJson(label));
      return;
    }
    sendError(response, 404, 'Not Found');
    return;
  }

  // -- issue -----------------------------------------------------------------------
  if (head === 'issues') {
    handleIssues(forge, request, response, repo, rest.slice(1), method, query, body, context);
    return;
  }

  // -- pull request ------------------------------------------------------------------
  if (head === 'pulls') {
    handlePulls(forge, request, response, repo, rest.slice(1), method, query, body, context);
    return;
  }

  sendError(response, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function badContentPath(path: string): boolean {
  if (path === '') return false;
  return path.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function handleContents(
  forge: Forge,
  request: IncomingMessage,
  response: ServerResponse,
  repo: Repo,
  path: string,
  method: string,
  query: URLSearchParams,
  body: JsonRecord,
): void {
  if (badContentPath(path)) {
    sendError(response, 422, 'path tidak sah');
    return;
  }
  const branch = asString(body.branch) ?? asString(query.get('ref')) ?? repo.defaultBranch;

  if (method === 'GET') {
    const revision = query.get('ref') ?? repo.defaultBranch;
    const commit = forge.revisionCommit(repo, revision);
    if (commit === null) {
      sendError(response, 404, 'Not Found');
      return;
    }
    const found = forge.readPath(repo, commit, path);
    if (found === null) {
      sendError(response, 404, 'Not Found');
      return;
    }
    if (found.kind === 'file') {
      const name = path.split('/').pop() ?? path;
      sendJson(response, 200, {
        type: 'file',
        encoding: 'base64',
        size: found.data.length,
        name,
        path,
        sha: found.oid,
        content: found.data.toString('base64'),
      });
      return;
    }
    const entries = found.entries.map((entry) => {
      const object = forge.getObject(repo, entry.oid);
      return {
        type: entry.type,
        size: entry.type === 'file' && object !== undefined ? object.data.length : 0,
        name: entry.name,
        path: entry.path,
        sha: entry.oid,
      };
    });
    sendJson(response, 200, entries);
    return;
  }

  if (method === 'PUT') {
    const contentText = asString(body.content);
    if (contentText === null) {
      sendError(response, 422, 'content wajib diisi');
      return;
    }
    const message = asString(body.message) ?? `Update ${path}`;
    const sha = asString(body.sha);
    const branchRef = `refs/heads/${branch}`;
    const branchExists = forge.getRef(repo, branchRef) !== undefined;
    // Bila cabang belum ada, ia lahir dari ujung cabang default: periksa sha terhadap sana.
    const checkBranch = branchExists ? branch : repo.defaultBranch;
    const checkTip = forge.getRef(repo, `refs/heads/${checkBranch}`);
    let current: { kind: 'file'; oid: string } | { kind: 'dir' } | null = null;
    if (checkTip !== undefined) {
      const found = forge.readPath(repo, checkTip, path);
      if (found !== null) current = found.kind === 'file' ? { kind: 'file', oid: found.oid } : { kind: 'dir' };
    }
    if (current !== null && current.kind === 'dir') {
      sendError(response, 422, 'path menunjuk direktori');
      return;
    }
    const existed = current !== null;
    if (existed && (sha === null || sha !== current.oid)) {
      sendError(response, 409, 'sha tidak cocok dengan isi saat ini');
      return;
    }
    if (!existed && sha !== null) {
      sendError(response, 409, 'sha diberikan untuk berkas yang belum ada');
      return;
    }
    const content = Buffer.from(contentText.replace(/\s+/g, ''), 'base64');
    const written = forge.writePath(repo, branch, path, content, message);
    const name = path.split('/').pop() ?? path;
    sendJson(response, existed ? 200 : 201, {
      content: {
        type: 'file',
        encoding: 'base64',
        size: content.length,
        name,
        path,
        sha: written.blobSha,
        content: content.toString('base64'),
      },
      commit: { sha: written.commitSha, message },
    });
    return;
  }

  if (method === 'DELETE') {
    const sha = asString(body.sha);
    const message = asString(body.message) ?? `Delete ${path}`;
    const tip = forge.getRef(repo, `refs/heads/${branch}`);
    if (tip === undefined) {
      sendError(response, 404, 'Not Found');
      return;
    }
    const found = forge.readPath(repo, tip, path);
    if (found === null || found.kind !== 'file') {
      sendError(response, 404, 'Not Found');
      return;
    }
    if (sha === null || sha !== found.oid) {
      sendError(response, 409, 'sha tidak cocok dengan isi saat ini');
      return;
    }
    const deleted = forge.deletePath(repo, branch, path, message);
    if (deleted === null) {
      sendError(response, 404, 'Not Found');
      return;
    }
    sendJson(response, 200, { commit: { sha: deleted.commitSha, message }, content: null });
    return;
  }

  sendError(response, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// ref git
// ---------------------------------------------------------------------------

function handleGitRefs(
  forge: Forge,
  response: ServerResponse,
  repo: Repo,
  suffix: string,
  method: string,
  body: JsonRecord,
): void {
  if (method === 'POST' && suffix === '') {
    const ref = asString(body.ref);
    const sha = asString(body.sha);
    if (ref === null || !ref.startsWith('refs/') || sha === null) {
      sendError(response, 422, 'ref dan sha wajib diisi');
      return;
    }
    const object = forge.getObject(repo, sha);
    if (object === undefined || (object.type !== 'commit' && object.type !== 'tag')) {
      sendError(response, 422, 'sha tidak menunjuk objek yang sah');
      return;
    }
    if (forge.getRef(repo, ref) !== undefined) {
      sendError(response, 422, 'Reference already exists');
      return;
    }
    forge.setRef(repo, ref, sha);
    sendJson(response, 201, refJson(ref, sha, object.type));
    return;
  }
  if (method === 'GET') {
    if (suffix === '') {
      const all = forge.listRefs(repo).map(({ ref, oid }) => {
        const object = forge.getObject(repo, oid);
        return refJson(ref, oid, object?.type ?? 'commit');
      });
      sendJson(response, 200, all);
      return;
    }
    const ref = `refs/${suffix}`;
    const exact = forge.getRef(repo, ref);
    if (exact !== undefined) {
      const object = forge.getObject(repo, exact);
      sendJson(response, 200, refJson(ref, exact, object?.type ?? 'commit'));
      return;
    }
    const prefix = `${ref}/`;
    const matches = forge.listRefs(repo).filter(({ ref: candidate }) => candidate.startsWith(prefix));
    if (matches.length === 0) {
      sendError(response, 404, 'Not Found');
      return;
    }
    sendJson(
      response,
      200,
      matches.map(({ ref: candidate, oid }) => {
        const object = forge.getObject(repo, oid);
        return refJson(candidate, oid, object?.type ?? 'commit');
      }),
    );
    return;
  }
  sendError(response, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// issue
// ---------------------------------------------------------------------------

function parseNumber(segment: string | undefined): number | null {
  if (segment === undefined) return null;
  if (!/^\d+$/.test(segment)) return null;
  const value = Number.parseInt(segment, 10);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

function resolveLabels(repo: Repo, raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const entry of raw) {
    const name = labelNameOf(entry);
    if (name === null || !repo.labels.has(name)) return null;
    names.push(name);
  }
  return names;
}

function handleIssues(
  forge: Forge,
  request: IncomingMessage,
  response: ServerResponse,
  repo: Repo,
  rest: readonly string[],
  method: string,
  query: URLSearchParams,
  body: JsonRecord,
  context: RestContext,
): void {
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = asString(body.title);
      if (title === null || title === '') {
        sendError(response, 422, 'title wajib diisi');
        return;
      }
      const labels = resolveLabels(repo, body.labels);
      if (labels === null) {
        sendError(response, 422, 'label tidak dikenal');
        return;
      }
      const created = forge.createIssue(repo, title, asString(body.body) ?? '', labels);
      sendJson(response, 201, issueJson(forge, repo, created));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let items = [...repo.issues];
      if (state === 'open') items = items.filter((issue) => issue.state === 'open');
      else if (state === 'closed') items = items.filter((issue) => issue.state === 'closed');
      const factor = direction === 'asc' ? 1 : -1;
      if (sort === 'updated') {
        items.sort((a, b) => factor * (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number));
      } else if (sort === 'comments') {
        items.sort((a, b) => factor * (a.comments.length - b.comments.length) || a.number - b.number);
      } else {
        items.sort((a, b) => factor * (a.number - b.number));
      }
      sendList(response, paginate(items.map((issue) => issueJson(forge, repo, issue)), query, request, context.rawPath));
      return;
    }
    sendError(response, 404, 'Not Found');
    return;
  }

  const number = parseNumber(rest[0]);
  if (number === null) {
    sendError(response, 404, 'Not Found');
    return;
  }
  const issue = repo.issuesByNumber.get(number);
  const pr = repo.pullsByNumber.get(number);

  if (rest.length === 1) {
    if (method === 'GET') {
      if (issue !== undefined) {
        sendJson(response, 200, issueJson(forge, repo, issue));
        return;
      }
      if (pr !== undefined) {
        sendJson(response, 200, prAsIssueJson(forge, repo, pr));
        return;
      }
      sendError(response, 404, 'Not Found');
      return;
    }
    if (method === 'PATCH') {
      const target = issue ?? pr;
      if (target === undefined) {
        sendError(response, 404, 'Not Found');
        return;
      }
      if (typeof body.title === 'string') target.title = body.title;
      if (typeof body.body === 'string') target.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        target.state = body.state;
        target.closedAt = body.state === 'closed' ? forge.nowIso() : null;
      }
      if (issue !== undefined && body.labels !== undefined) {
        const labels = resolveLabels(repo, body.labels);
        if (labels === null) {
          sendError(response, 422, 'label tidak dikenal');
          return;
        }
        issue.labels.splice(0, issue.labels.length, ...labels);
      }
      target.updatedAt = forge.nowIso();
      sendJson(response, 200, issue !== undefined ? issueJson(forge, repo, issue) : prAsIssueJson(forge, repo, pr as PullRequest));
      return;
    }
    sendError(response, 404, 'Not Found');
    return;
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    const target = issue ?? pr;
    if (target === undefined) {
      sendError(response, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      sendJson(response, 200, target.comments.map((comment) => commentJson(forge, repo, comment)));
      return;
    }
    if (method === 'POST') {
      const text = asString(body.body);
      if (text === null || text === '') {
        sendError(response, 422, 'body komentar wajib diisi');
        return;
      }
      const comment = forge.addComment(target, text, repo);
      sendJson(response, 201, commentJson(forge, repo, comment));
      return;
    }
    sendError(response, 404, 'Not Found');
    return;
  }

  sendError(response, 404, 'Not Found');
}

/** Tampilan PR lewat endpoint issue (GitHub memperlakukan PR sebagai issue). */
function prAsIssueJson(forge: Forge, repo: Repo, pr: PullRequest): JsonRecord {
  return {
    id: pr.id,
    node_id: `P${repo.id}:${pr.number}`,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    labels: [],
    user: userJson(forge),
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    comments: pr.comments.length,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    pull_request: {},
  };
}

// ---------------------------------------------------------------------------
// pull request
// ---------------------------------------------------------------------------

function handlePulls(
  forge: Forge,
  request: IncomingMessage,
  response: ServerResponse,
  repo: Repo,
  rest: readonly string[],
  method: string,
  query: URLSearchParams,
  body: JsonRecord,
  context: RestContext,
): void {
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = asString(body.title);
      const head = branchNameOf(body.head);
      const base = branchNameOf(body.base);
      if (title === null || title === '' || head === null || head === '' || base === null || base === '') {
        sendError(response, 422, 'title, head, dan base wajib diisi');
        return;
      }
      const created = forge.createPullRequest(repo, title, asString(body.body) ?? '', head, base);
      if (created === 'unknown-branch') {
        sendError(response, 422, 'cabang head atau base tidak ada');
        return;
      }
      if (created === 'duplicate') {
        sendError(response, 422, 'A pull request already exists for these branches');
        return;
      }
      sendJson(response, 201, pullJson(forge, repo, created));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let items = [...repo.pulls];
      if (state === 'open') items = items.filter((pr) => pr.state === 'open');
      else if (state === 'closed') items = items.filter((pr) => pr.state === 'closed');
      items.sort((a, b) => b.number - a.number);
      sendList(response, paginate(items.map((pr) => pullJson(forge, repo, pr)), query, request, context.rawPath));
      return;
    }
    sendError(response, 404, 'Not Found');
    return;
  }

  const number = parseNumber(rest[0]);
  if (number === null) {
    sendError(response, 404, 'Not Found');
    return;
  }
  const pr = repo.pullsByNumber.get(number);

  if (rest.length === 1) {
    if (method === 'GET') {
      if (pr === undefined) {
        sendError(response, 404, 'Not Found');
        return;
      }
      sendJson(response, 200, pullJson(forge, repo, pr));
      return;
    }
    if (method === 'PATCH') {
      if (pr === undefined) {
        sendError(response, 404, 'Not Found');
        return;
      }
      if (typeof body.title === 'string') pr.title = body.title;
      if (typeof body.body === 'string') pr.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        pr.state = body.state;
        pr.closedAt = body.state === 'closed' ? forge.nowIso() : null;
      }
      pr.updatedAt = forge.nowIso();
      sendJson(response, 200, pullJson(forge, repo, pr));
      return;
    }
    sendError(response, 404, 'Not Found');
    return;
  }

  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET' || pr === undefined) {
      sendError(response, 404, 'Not Found');
      return;
    }
    const files = forge.prDiff(repo, pr).map((entry) => {
      const counts = forge.diffLineCounts(repo, entry);
      const status = entry.status === 'deleted' ? 'changed' : entry.status;
      return {
        sha: entry.newOid ?? entry.oldOid ?? '',
        filename: entry.path,
        status,
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      };
    });
    sendList(response, paginate(files, query, request, context.rawPath));
    return;
  }

  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') {
      sendError(response, 404, 'Not Found');
      return;
    }
    if (pr === undefined) {
      sendError(response, 404, 'Not Found');
      return;
    }
    const methodName = asString(body.merge_method) ?? 'squash';
    const commitTitle = asString(body.commit_title);
    const commitMessage = asString(body.commit_message);
    const override = commitTitle === null ? undefined : commitMessage === null ? commitTitle : `${commitTitle}\n\n${commitMessage}`;
    const result = forge.mergePullRequest(repo, pr, methodName, override);
    if (!result.ok) {
      if (result.reason === 'conflict') {
        sendError(response, 405, 'Merge conflict: perubahan kedua cabang bertabrakan');
        return;
      }
      if (result.reason === 'closed') {
        sendError(response, 405, 'Pull request sudah ditutup');
        return;
      }
      sendError(response, 409, 'cabang head atau base tidak ada');
      return;
    }
    sendJson(response, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }

  sendError(response, 404, 'Not Found');
}
