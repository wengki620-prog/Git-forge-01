/**
 * graphql.ts — GraphQL v4 di /api/graphql: tokenizer, parser dokumen,
 * eksekutor dengan validasi field terhadap skema, introspeksi __type,
 * mutasi, dan batching.
 *
 * Ini pelaksana GraphQL sungguhan, bukan pencocokan string dokumen: field
 * yang tidak dikenal menghasilkan galat GraphQL, dan dokumen apa pun dalam
 * permukaan skema akan dijalankan.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, type Issue, type PullRequest, type Repo } from './forge.ts';
import { sendError, sendJson } from './respond.ts';

// ---------------------------------------------------------------------------
// token
// ---------------------------------------------------------------------------

type TokenKind = 'punct' | 'ellipsis' | 'name' | 'string' | 'int' | 'float' | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly value?: string | number;
}

class GraphQLParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLParseError';
  }
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  const isDigit = (ch: string): boolean => /[0-9]/.test(ch);
  while (at < source.length) {
    const ch = source[at] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      at += 1;
      continue;
    }
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (ch === '.' && source.slice(at, at + 3) === '...') {
      tokens.push({ kind: 'ellipsis', text: '...' });
      at += 3;
      continue;
    }
    if ('{}()[]:!=$'.includes(ch)) {
      tokens.push({ kind: 'punct', text: ch });
      at += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(at, at + 3) === '"""') {
        const end = source.indexOf('"""', at + 3);
        if (end < 0) throw new GraphQLParseError('string blok tidak ditutup');
        tokens.push({ kind: 'string', text: source.slice(at, end + 3), value: source.slice(at + 3, end) });
        at = end + 3;
        continue;
      }
      let index = at + 1;
      let out = '';
      let closed = false;
      while (index < source.length) {
        const c = source[index] as string;
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\n') throw new GraphQLParseError('string melewati baris baru');
        if (c === '\\') {
          const next = source[index + 1] as string;
          if (next === 'u') {
            const hex = source.slice(index + 2, index + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GraphQLParseError('escape \\u bukan hex');
            out += String.fromCharCode(Number.parseInt(hex, 16));
            index += 6;
            continue;
          }
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          const replacement = escapes[next];
          if (replacement === undefined) throw new GraphQLParseError(`escape \\${next} tidak dikenal`);
          out += replacement;
          index += 2;
          continue;
        }
        out += c;
        index += 1;
      }
      if (!closed) throw new GraphQLParseError('string tidak ditutup');
      tokens.push({ kind: 'string', text: source.slice(at, index + 1), value: out });
      at = index + 1;
      continue;
    }
    if (ch === '-' || isDigit(ch)) {
      const match = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(at));
      if (match === null) throw new GraphQLParseError(`angka tidak sah di ${at}`);
      const text = match[0];
      const isFloat = match[1] !== undefined || match[2] !== undefined;
      tokens.push({ kind: isFloat ? 'float' : 'int', text, value: Number(text) });
      at += text.length;
      continue;
    }
    if (isNameStart(ch)) {
      let end = at + 1;
      while (end < source.length && isNameChar(source[end] as string)) end += 1;
      tokens.push({ kind: 'name', text: source.slice(at, end) });
      at = end;
      continue;
    }
    throw new GraphQLParseError(`karakter ${JSON.stringify(ch)} tidak dikenal di ${at}`);
  }
  tokens.push({ kind: 'eof', text: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST dan parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'null' }
  | { readonly kind: 'list'; readonly values: readonly ValueNode[] }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, ValueNode>> };

type SelectionNode =
  | {
      readonly kind: 'field';
      readonly alias: string | null;
      readonly name: string;
      readonly args: Readonly<Record<string, ValueNode>>;
      readonly selectionSet: readonly SelectionNode[] | null;
    }
  | { readonly kind: 'spread'; readonly name: string }
  | {
      readonly kind: 'inline';
      readonly typeCondition: string | null;
      readonly selectionSet: readonly SelectionNode[];
    };

interface VariableDefinition {
  readonly name: string;
  readonly typeText: string;
  readonly defaultValue: ValueNode | null;
}

interface Operation {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: readonly VariableDefinition[];
  readonly selectionSet: readonly SelectionNode[];
}

interface FragmentDefinition {
  readonly name: string;
  readonly typeCondition: string;
  readonly selectionSet: readonly SelectionNode[];
}

interface Document {
  readonly operations: readonly Operation[];
  readonly fragments: ReadonlyMap<string, FragmentDefinition>;
}

class Parser {
  private readonly tokens: Token[];
  private at = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.at] as Token;
  }

  private advance(): Token {
    const token = this.tokens[this.at] as Token;
    if (this.at < this.tokens.length - 1) this.at += 1;
    return token;
  }

  private expectPunct(text: string): void {
    const token = this.advance();
    if (token.kind !== 'punct' || token.text !== text) {
      throw new GraphQLParseError(`mengharap ${JSON.stringify(text)}, dapat ${JSON.stringify(token.text)}`);
    }
  }

  private acceptPunct(text: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.text === text) {
      this.advance();
      return true;
    }
    return false;
  }

  private expectName(text?: string): string {
    const token = this.advance();
    if (token.kind !== 'name' || (text !== undefined && token.text !== text)) {
      throw new GraphQLParseError(`mengharap nama ${text ?? ''}, dapat ${JSON.stringify(token.text)}`);
    }
    return token.text;
  }

  private acceptName(text: string): boolean {
    const token = this.peek();
    if (token.kind === 'name' && token.text === text) {
      this.advance();
      return true;
    }
    return false;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDefinition>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.text === '{') {
        operations.push({
          kind: 'query',
          name: null,
          variables: [],
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind === 'name' && (token.text === 'query' || token.text === 'mutation')) {
        const kind = this.advance().text as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.advance().text;
        const variables = this.parseVariableDefinitions();
        this.parseDirectives();
        operations.push({ kind, name, variables, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.text === 'fragment') {
        this.advance();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(name, { name, typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new GraphQLParseError(`definisi diawali token ${JSON.stringify(token.text)} yang tidak dikenal`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    const definitions: VariableDefinition[] = [];
    if (!this.acceptPunct('(')) return definitions;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const typeText = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.acceptPunct('=')) defaultValue = this.parseValue(true);
      this.parseDirectives();
      definitions.push({ name, typeText, defaultValue });
    }
    return definitions;
  }

  private parseType(): string {
    if (this.acceptPunct('[')) {
      const inner = this.parseType();
      this.expectPunct(']');
      return this.acceptPunct('!') ? `[${inner}]!` : `[${inner}]`;
    }
    const name = this.expectName();
    return this.acceptPunct('!') ? `${name}!` : name;
  }

  private parseDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().text === '@') {
      this.advance();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().text === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      if (this.peek().kind === 'eof') throw new GraphQLParseError('selection set tidak ditutup');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'ellipsis') {
      this.advance();
      if (this.acceptName('on')) {
        const typeCondition = this.expectName();
        this.parseDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.advance().text;
        this.parseDirectives();
        return { kind: 'spread', name };
      }
      this.parseDirectives();
      return { kind: 'inline', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.parseDirectives();
    const selectionSet =
      this.peek().kind === 'punct' && this.peek().text === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    if (!this.acceptPunct('(')) return args;
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue(false);
    }
    return args;
  }

  private parseValue(constValue: boolean): ValueNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.text === '$') {
      if (constValue) throw new GraphQLParseError('variabel tidak boleh di nilai konstan');
      this.advance();
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') {
      this.advance();
      return { kind: 'int', value: token.value as number };
    }
    if (token.kind === 'float') {
      this.advance();
      return { kind: 'float', value: token.value as number };
    }
    if (token.kind === 'string') {
      this.advance();
      return { kind: 'string', value: token.value as string };
    }
    if (token.kind === 'name') {
      this.advance();
      if (token.text === 'true') return { kind: 'boolean', value: true };
      if (token.text === 'false') return { kind: 'boolean', value: false };
      if (token.text === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.text };
    }
    if (token.kind === 'punct' && token.text === '[') {
      this.advance();
      const values: ValueNode[] = [];
      while (!this.acceptPunct(']')) values.push(this.parseValue(constValue));
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.text === '{') {
      this.advance();
      const fields: Record<string, ValueNode> = {};
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue(constValue);
      }
      return { kind: 'object', fields };
    }
    throw new GraphQLParseError(`nilai diawali token ${JSON.stringify(token.text)} yang tidak dikenal`);
  }
}

// ---------------------------------------------------------------------------
// skema: field per tipe dan introspeksi
// ---------------------------------------------------------------------------

const SCHEMA_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  User: ['login'],
  Ref: ['name'],
  IssueConnection: ['nodes', 'pageInfo'],
  PullRequestConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path'],
  PageInfo: ['hasNextPage', 'endCursor'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function introspectionType(name: string): Record<string, unknown> | null {
  const fields = SCHEMA_FIELDS[name];
  if (fields !== undefined) {
    return {
      __typename: '__Type',
      name,
      kind: 'OBJECT',
      fields: fields.map((field) => ({ __typename: '__Field', name: field })),
      enumValues: [],
    };
  }
  const values = ENUM_VALUES[name];
  if (values !== undefined) {
    return {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      fields: [],
      enumValues: values.map((value) => ({ __typename: '__EnumValue', name: value })),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// nilai dan eksekusi
// ---------------------------------------------------------------------------

type GqlObject = Record<string, unknown> & { __typename: string };
type GqlValue = null | string | number | boolean | GqlValue[] | GqlObject;

class GraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
}

interface ExecutionContext {
  readonly forge: Forge;
  readonly document: Document;
  readonly variables: Record<string, unknown>;
  readonly errors: Array<{ message: string }>;
}

function resolveValue(node: ValueNode, context: ExecutionContext, defaults: ReadonlyMap<string, ValueNode>): unknown {
  switch (node.kind) {
    case 'variable': {
      if (node.name in context.variables) return context.variables[node.name];
      const fallback = defaults.get(node.name);
      return fallback === undefined ? null : resolveValue(fallback, context, defaults);
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((child) => resolveValue(child, context, defaults));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node.fields)) out[key] = resolveValue(child, context, defaults);
      return out;
    }
  }
}

function resolveArgs(
  args: Readonly<Record<string, ValueNode>>,
  context: ExecutionContext,
  defaults: ReadonlyMap<string, ValueNode>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(args)) out[key] = resolveValue(node, context, defaults);
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) if (typeof entry === 'string') out.push(entry);
  return out;
}

// -- id global ---------------------------------------------------------------

function repoGlobalId(repo: Repo): string {
  return `R${repo.id}`;
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return `I${repo.id}:${issue.number}`;
}

function pullGlobalId(repo: Repo, pr: PullRequest): string {
  return `P${repo.id}:${pr.number}`;
}

function commentGlobalId(repo: Repo, commentId: number): string {
  return `C${repo.id}:${commentId}`;
}

interface DecodedId {
  readonly kind: 'repo' | 'issue' | 'pull' | 'comment';
  readonly repoId: number;
  readonly number: number;
}

function decodeGlobalId(id: string): DecodedId | null {
  const match = /^([RIPC])(\d+)(?::(\d+))?$/.exec(id);
  if (match === null) return null;
  const repoId = Number(match[2]);
  const number = match[3] === undefined ? 0 : Number(match[3]);
  if (match[1] === 'R') return { kind: 'repo', repoId, number: 0 };
  if (match[1] === 'I') return { kind: 'issue', repoId, number };
  if (match[1] === 'P') return { kind: 'pull', repoId, number };
  return { kind: 'comment', repoId, number };
}

// -- kursor ------------------------------------------------------------------

function encodeCursor(number: number): string {
  return Buffer.from(`c:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^c:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

// -- objek bertipe -------------------------------------------------------------

function userObject(forge: Forge): GqlObject {
  return { __typename: 'User', login: forge.owner ?? '' };
}

function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', repo };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pr: PullRequest): GqlObject {
  return { __typename: 'PullRequest', repo, pr };
}

// -- koneksi -------------------------------------------------------------------

interface Page<T> {
  readonly nodes: T[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

function paginateOrdered<T extends { number: number }>(
  ordered: readonly T[],
  first: unknown,
  after: unknown,
): Page<T> {
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    const marker = decodeCursor(after);
    if (marker !== null) {
      const index = ordered.findIndex((item) => item.number === marker);
      if (index >= 0) start = index + 1;
    }
  }
  const limit = typeof first === 'number' && Number.isInteger(first) && first >= 0 ? first : ordered.length;
  const nodes = ordered.slice(start, start + limit);
  const end = start + nodes.length;
  return {
    nodes,
    hasNextPage: end < ordered.length,
    endCursor: nodes.length === 0 ? null : encodeCursor((nodes[nodes.length - 1] as T).number),
  };
}

function issuesConnection(forge: Forge, repo: Repo, args: Record<string, unknown>): GqlObject {
  const states = asStringList(args.states) ?? ['OPEN'];
  const orderBy = asRecord(args.orderBy);
  const field = typeof orderBy?.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = typeof orderBy?.direction === 'string' ? orderBy.direction : 'ASC';
  let items = repo.issues.filter((issue) => {
    const state = issue.state === 'open' ? 'OPEN' : 'CLOSED';
    return states.includes(state);
  });
  const factor = direction === 'DESC' ? -1 : 1;
  if (field === 'UPDATED_AT') {
    items = [...items].sort(
      (a, b) => factor * (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number),
    );
  } else if (field === 'COMMENTS') {
    items = [...items].sort((a, b) => factor * (a.comments.length - b.comments.length) || a.number - b.number);
  } else {
    items = [...items].sort((a, b) => factor * (a.number - b.number));
  }
  const page = paginateOrdered(items, args.first, args.after);
  return {
    __typename: 'IssueConnection',
    nodes: page.nodes.map((issue) => issueObject(repo, issue)),
    pageInfo: { __typename: 'PageInfo', hasNextPage: page.hasNextPage, endCursor: page.endCursor },
  };
}

function pullsConnection(forge: Forge, repo: Repo, args: Record<string, unknown>): GqlObject {
  const states = asStringList(args.states) ?? ['OPEN'];
  const items = repo.pulls
    .filter((pr) => {
      const state = pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
      return states.includes(state);
    })
    .sort((a, b) => b.number - a.number);
  const page = paginateOrdered(items, args.first, args.after);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.nodes.map((pr) => pullObject(repo, pr)),
    pageInfo: { __typename: 'PageInfo', hasNextPage: page.hasNextPage, endCursor: page.endCursor },
  };
}

function filesConnection(forge: Forge, repo: Repo, pr: PullRequest, args: Record<string, unknown>): GqlObject {
  const diff = forge.prDiff(repo, pr);
  const limit = typeof args.first === 'number' && Number.isInteger(args.first) && args.first >= 0 ? args.first : diff.length;
  const nodes = diff.slice(0, limit).map((entry) => ({ __typename: 'PullRequestChangedFile', path: entry.path }));
  return {
    __typename: 'PullRequestChangedFileConnection',
    nodes,
    pageInfo: { __typename: 'PageInfo', hasNextPage: diff.length > nodes.length, endCursor: null },
  };
}

// -- resolver field --------------------------------------------------------------

function resolveField(
  typeName: string,
  fieldName: string,
  parent: GqlObject,
  args: Record<string, unknown>,
  context: ExecutionContext,
): GqlValue {
  const forge = context.forge;
  if (fieldName === '__typename') return typeName;

  if (typeName === 'Query') {
    if (fieldName === 'viewer') return userObject(forge);
    if (fieldName === 'repository') {
      const owner = args.owner;
      const name = args.name;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = forge.resolveRepo(owner, name);
      return repo === null ? null : repoObject(repo);
    }
    if (fieldName === 'node') {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      const repo = forge.getRepoById(decoded.repoId);
      if (repo === null) return null;
      if (decoded.kind === 'repo') return repoObject(repo);
      if (decoded.kind === 'issue') {
        const issue = repo.issuesByNumber.get(decoded.number);
        return issue === undefined ? null : issueObject(repo, issue);
      }
      if (decoded.kind === 'pull') {
        const pr = repo.pullsByNumber.get(decoded.number);
        return pr === undefined ? null : pullObject(repo, pr);
      }
      return null;
    }
    if (fieldName === '__type') {
      const name = args.name;
      if (typeof name !== 'string') return null;
      const found = introspectionType(name);
      return found === null ? null : (found as GqlObject);
    }
  }

  if (typeName === 'Repository') {
    const repo = parent.repo as Repo;
    switch (fieldName) {
      case 'id': return repoGlobalId(repo);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${forge.owner ?? ''}/${repo.name}`;
      case 'owner': return userObject(forge);
      case 'defaultBranchRef': return { __typename: 'Ref', name: repo.defaultBranch };
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const number = args.number;
        if (typeof number !== 'number') return null;
        const issue = repo.issuesByNumber.get(number);
        return issue === undefined ? null : issueObject(repo, issue);
      }
      case 'issues': return issuesConnection(forge, repo, args);
      case 'pullRequests': return pullsConnection(forge, repo, args);
      case 'pullRequest': {
        const number = args.number;
        if (typeof number !== 'number') return null;
        const pr = repo.pullsByNumber.get(number);
        return pr === undefined ? null : pullObject(repo, pr);
      }
    }
  }

  if (typeName === 'Issue') {
    const repo = parent.repo as Repo;
    const issue = parent.issue as Issue;
    switch (fieldName) {
      case 'id': return issueGlobalId(repo, issue);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body': return issue.body;
    }
  }

  if (typeName === 'PullRequest') {
    const repo = parent.repo as Repo;
    const pr = parent.pr as PullRequest;
    switch (fieldName) {
      case 'id': return pullGlobalId(repo, pr);
      case 'number': return pr.number;
      case 'headRefName': return pr.headRef;
      case 'baseRefName': return pr.baseRef;
      case 'merged': return pr.merged;
      case 'state': return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'mergeable': {
        if (pr.state !== 'open') return 'UNKNOWN';
        return forge.prConflicts(repo, pr).length === 0 ? 'MERGEABLE' : 'CONFLICTING';
      }
      case 'files': return filesConnection(forge, repo, pr, args);
    }
  }

  if (typeName === 'User' && fieldName === 'login') return parent.login as string;
  if (typeName === 'Ref' && fieldName === 'name') return parent.name as string;
  if (typeName === 'PullRequestChangedFile' && fieldName === 'path') return parent.path as string;
  if (typeName === 'IssueComment' && fieldName === 'id') return parent.id as string;
  if (typeName === 'IssueComment' && fieldName === 'body') return parent.body as string;
  if ((typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') && fieldName === 'nodes') {
    return parent.nodes as GqlValue[];
  }
  if ((typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') && fieldName === 'pageInfo') {
    return parent.pageInfo as GqlObject;
  }
  if (typeName === 'PageInfo' && fieldName === 'hasNextPage') return parent.hasNextPage as boolean;
  if (typeName === 'PageInfo' && fieldName === 'endCursor') return parent.endCursor as string | null;
  if (typeName === 'CreateIssuePayload' && fieldName === 'issue') return parent.issue as GqlObject;
  if (typeName === 'CloseIssuePayload' && fieldName === 'issue') return parent.issue as GqlObject;
  if (typeName === 'CreatePullRequestPayload' && fieldName === 'pullRequest') return parent.pullRequest as GqlObject;
  if (typeName === 'MergePullRequestPayload' && fieldName === 'pullRequest') return parent.pullRequest as GqlObject;
  if (typeName === 'AddCommentPayload' && fieldName === 'commentEdge') return parent.commentEdge as GqlObject;
  if (typeName === 'IssueCommentEdge' && fieldName === 'node') return parent.node as GqlObject;
  if (typeName === '__Type' && fieldName === 'name') return parent.name as string;
  if (typeName === '__Type' && fieldName === 'kind') return parent.kind as string;
  if (typeName === '__Type' && fieldName === 'fields') return parent.fields as GqlValue[];
  if (typeName === '__Type' && fieldName === 'enumValues') return parent.enumValues as GqlValue[];
  if (typeName === '__Field' && fieldName === 'name') return parent.name as string;
  if (typeName === '__EnumValue' && fieldName === 'name') return parent.name as string;

  if (typeName === 'Mutation') return resolveMutation(fieldName, args, context);

  throw new GraphQLError(`Cannot query field "${fieldName}" on type "${typeName}".`);
}

function resolveMutation(
  fieldName: string,
  args: Record<string, unknown>,
  context: ExecutionContext,
): GqlValue {
  const forge = context.forge;
  const input = asRecord(args.input);
  if (input === null) throw new GraphQLError(`mutasi ${fieldName} membutuhkan input`);

  if (fieldName === 'createIssue') {
    const repoId = input.repositoryId;
    const title = input.title;
    if (typeof repoId !== 'string' || typeof title !== 'string' || title === '') {
      throw new GraphQLError('createIssue membutuhkan repositoryId dan title');
    }
    const decoded = decodeGlobalId(repoId);
    const repo = decoded !== null && decoded.kind === 'repo' ? forge.getRepoById(decoded.repoId) : null;
    if (repo === null) throw new GraphQLError('repositori tidak ditemukan');
    const issue = forge.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', []);
    return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) };
  }

  if (fieldName === 'closeIssue') {
    const issueId = input.issueId;
    if (typeof issueId !== 'string') throw new GraphQLError('closeIssue membutuhkan issueId');
    const decoded = decodeGlobalId(issueId);
    const repo = decoded !== null ? forge.getRepoById(decoded.repoId) : null;
    const issue = repo !== null && decoded?.kind === 'issue' ? repo.issuesByNumber.get(decoded.number) : undefined;
    if (repo === null || issue === undefined) throw new GraphQLError('issue tidak ditemukan');
    issue.state = 'closed';
    issue.closedAt = forge.nowIso();
    issue.updatedAt = forge.nowIso();
    return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue) };
  }

  if (fieldName === 'createPullRequest') {
    const repoId = input.repositoryId;
    const title = input.title;
    const head = input.headRefName;
    const base = input.baseRefName;
    if (typeof repoId !== 'string' || typeof title !== 'string' || typeof head !== 'string' || typeof base !== 'string') {
      throw new GraphQLError('createPullRequest membutuhkan repositoryId, title, headRefName, dan baseRefName');
    }
    const decoded = decodeGlobalId(repoId);
    const repo = decoded !== null && decoded.kind === 'repo' ? forge.getRepoById(decoded.repoId) : null;
    if (repo === null) throw new GraphQLError('repositori tidak ditemukan');
    const created = forge.createPullRequest(repo, title, typeof input.body === 'string' ? input.body : '', head, base);
    if (created === 'unknown-branch') throw new GraphQLError('cabang head atau base tidak ada');
    if (created === 'duplicate') throw new GraphQLError('pull request untuk cabang ini sudah ada');
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, created) };
  }

  if (fieldName === 'mergePullRequest') {
    const prId = input.pullRequestId;
    if (typeof prId !== 'string') throw new GraphQLError('mergePullRequest membutuhkan pullRequestId');
    const decoded = decodeGlobalId(prId);
    const repo = decoded !== null ? forge.getRepoById(decoded.repoId) : null;
    const pr = repo !== null && decoded?.kind === 'pull' ? repo.pullsByNumber.get(decoded.number) : undefined;
    if (repo === null || pr === undefined) throw new GraphQLError('pull request tidak ditemukan');
    const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
    const result = forge.mergePullRequest(repo, pr, method);
    if (!result.ok) {
      if (result.reason === 'conflict') throw new GraphQLError('merge conflict');
      throw new GraphQLError('pull request tidak dapat digabung');
    }
    return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pr) };
  }

  if (fieldName === 'addComment') {
    const subjectId = input.subjectId;
    const body = input.body;
    if (typeof subjectId !== 'string' || typeof body !== 'string') {
      throw new GraphQLError('addComment membutuhkan subjectId dan body');
    }
    const decoded = decodeGlobalId(subjectId);
    const repo = decoded !== null ? forge.getRepoById(decoded.repoId) : null;
    if (repo === null) throw new GraphQLError('subjek tidak ditemukan');
    const target =
      decoded?.kind === 'issue'
        ? repo.issuesByNumber.get(decoded.number)
        : decoded?.kind === 'pull'
          ? repo.pullsByNumber.get(decoded.number)
          : undefined;
    if (target === undefined) throw new GraphQLError('subjek tidak ditemukan');
    const comment = forge.addComment(target, body, repo);
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'IssueCommentEdge',
        node: { __typename: 'IssueComment', id: commentGlobalId(repo, comment.id), body: comment.body },
      },
    };
  }

  throw new GraphQLError(`Cannot query field "${fieldName}" on type "Mutation".`);
}

// -- eksekusi selection set ----------------------------------------------------

function executeSelectionSet(
  typeName: string,
  parent: GqlObject,
  selections: readonly SelectionNode[],
  context: ExecutionContext,
  defaults: ReadonlyMap<string, ValueNode>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const allowed = SCHEMA_FIELDS[typeName] ?? [];
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = context.document.fragments.get(selection.name);
      if (fragment === undefined) {
        context.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition !== typeName) continue;
      Object.assign(out, executeSelectionSet(typeName, parent, fragment.selectionSet, context, defaults));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      Object.assign(out, executeSelectionSet(typeName, parent, selection.selectionSet, context, defaults));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    if (selection.name !== '__typename' && !allowed.includes(selection.name)) {
      context.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    let value: GqlValue;
    try {
      const args = resolveArgs(selection.args, context, defaults);
      value = resolveField(typeName, selection.name, parent, args, context);
    } catch (err) {
      context.errors.push({ message: err instanceof Error ? err.message : 'galat eksekusi' });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(value, selection.selectionSet, context, defaults);
  }
  return out;
}

function completeValue(
  value: GqlValue,
  selectionSet: readonly SelectionNode[] | null,
  context: ExecutionContext,
  defaults: ReadonlyMap<string, ValueNode>,
): unknown {
  // Null melewati subselection apa adanya: subselection dilewati, bukan galat.
  if (value === null) return null;
  if (typeof value !== 'object') {
    if (selectionSet !== null) {
      context.errors.push({ message: 'field skalar tidak boleh punya subselection' });
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => completeValue(item, selectionSet, context, defaults));
  }
  if (selectionSet === null) {
    context.errors.push({ message: `Field of type "${value.__typename}" must have a selection of subfields.` });
    return null;
  }
  return executeSelectionSet(value.__typename, value, selectionSet, context, defaults);
}

// ---------------------------------------------------------------------------
// handler HTTP
// ---------------------------------------------------------------------------

interface GraphQLRequest {
  readonly query?: unknown;
  readonly variables?: unknown;
  readonly operationName?: unknown;
}

function executeRequest(forge: Forge, requestBody: unknown): Record<string, unknown> {
  const envelope = (data: unknown, errors: Array<{ message: string }> | null): Record<string, unknown> => {
    const out: Record<string, unknown> = { data };
    if (errors !== null && errors.length > 0) out.errors = errors;
    return out;
  };
  const body = asRecord(requestBody);
  if (body === null) return envelope(null, [{ message: 'badan GraphQL harus berupa objek' }]);
  const queryText = body.query;
  if (typeof queryText !== 'string') return envelope(null, [{ message: 'query wajib berupa string' }]);
  let document: Document;
  try {
    document = new Parser(queryText).parseDocument();
  } catch (err) {
    return envelope(null, [{ message: err instanceof Error ? err.message : 'dokumen tidak dapat diurai' }]);
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  let operation: Operation | undefined;
  if (operationName !== null) {
    operation = document.operations.find((candidate) => candidate.name === operationName);
    if (operation === undefined) {
      return envelope(null, [{ message: `Unknown operation named "${operationName}".` }]);
    }
  } else if (document.operations.length === 1) {
    operation = document.operations[0];
  } else {
    return envelope(null, [{ message: 'operationName wajib bila dokumen punya lebih dari satu operasi' }]);
  }
  const variables = asRecord(body.variables) ?? {};
  const defaults = new Map<string, ValueNode>();
  for (const definition of operation.variables) {
    if (definition.defaultValue !== null) defaults.set(definition.name, definition.defaultValue);
  }
  const context: ExecutionContext = { forge, document, variables, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __typename: rootType };
  const data = executeSelectionSet(rootType, root, operation.selectionSet, context, defaults);
  return envelope(data, context.errors.length > 0 ? context.errors : null);
}

export function handleGraphQL(
  forge: Forge,
  request: IncomingMessage,
  response: ServerResponse,
  query: URLSearchParams,
  body: unknown,
): void {
  if (request.method === 'GET') {
    const queryText = query.get('query');
    if (queryText === null) {
      sendError(response, 400, 'query wajib diisi');
      return;
    }
    let variables: unknown = {};
    const variablesText = query.get('variables');
    if (variablesText !== null) {
      try {
        variables = JSON.parse(variablesText) as unknown;
      } catch {
        sendError(response, 400, 'variables bukan JSON yang sah');
        return;
      }
    }
    const operationName = query.get('operationName');
    sendJson(response, 200, executeRequest(forge, { query: queryText, variables, operationName }));
    return;
  }
  if (request.method !== 'POST') {
    sendError(response, 404, 'Not Found');
    return;
  }
  if (body === null) {
    sendJson(response, 400, { errors: [{ message: 'badan JSON tidak sah' }] });
    return;
  }
  if (Array.isArray(body)) {
    sendJson(response, 200, body.map((entry) => executeRequest(forge, entry)));
    return;
  }
  sendJson(response, 200, executeRequest(forge, body));
}
