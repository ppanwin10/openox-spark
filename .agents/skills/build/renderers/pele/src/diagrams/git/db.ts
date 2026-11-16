import { PeleError } from '../../errors.js';
import type { Config } from '../../preprocess.js';
import type { CommitTypeName, GitGraphAst, StatementAst } from './parser.js';

export const commitType = { NORMAL: 0, REVERSE: 1, HIGHLIGHT: 2, MERGE: 3, CHERRY_PICK: 4 } as const;

export type GitDirection = 'LR' | 'TB' | 'BT';

export interface GitCommit {
  id: string;
  message: string;
  seq: number;
  type: number;
  tags: string[];
  parents: string[];
  branch: string;
  customType?: number;
  customId?: boolean;
}

export interface GitModel {
  type: 'gitGraph';
  title: string | undefined;
  accTitle: string | undefined;
  accDescr: string | undefined;
  direction: GitDirection;
  commits: Map<string, GitCommit>;
  branches: Map<string, string | null>;
  lanes: string[];
  currentBranch: string;
  head: GitCommit | null;
  warnings: string[];
}

export interface CommitDB {
  msg: string;
  id: string | undefined;
  type: number;
  tags?: string[];
}

export interface BranchDB {
  name: string;
  order: number | undefined;
}

export interface MergeDB {
  branch: string;
  id: string;
  type?: number;
  tags?: string[];
}

export interface CherryPickDB {
  id: string | undefined;
  targetId: string;
  parent: string | undefined;
  tags?: string[];
}

export interface GitDbParseProvider {
  setDirection(dir: GitDirection): void;
  commit(commit: CommitDB): void;
  branch(branch: BranchDB): void;
  merge(merge: MergeDB): void;
  cherryPick(cherryPick: CherryPickDB): void;
  checkout(branch: string): void;
}

function fail(message: string): never {
  throw new PeleError(message, 'semantic', { type: 'gitGraph' });
}

function checkedOrder(value: number): number {
  if (!Number.isFinite(value)) {
    fail('Branch order must be finite.');
  }
  return value;
}

function typeCode(name: CommitTypeName): number {
  return name === 'REVERSE' ? commitType.REVERSE : name === 'HIGHLIGHT' ? commitType.HIGHLIGHT : commitType.NORMAL;
}

export function populate(ast: GitGraphAst, db: GitDbParseProvider): void {
  if (ast.dir) db.setDirection(ast.dir);
  for (const statement of ast.statements) parseStatement(statement, db);
}

export function parseStatement(statement: StatementAst, db: GitDbParseProvider): void {
  switch (statement.$type) {
    case 'Commit':
      db.commit({
        id: statement.id,
        msg: statement.message ?? '',
        type: statement.type !== undefined ? typeCode(statement.type) : commitType.NORMAL,
        tags: statement.tags ?? undefined,
      });
      break;
    case 'Branch':
      db.branch({ name: statement.name, order: statement.order ?? 0 });
      break;
    case 'Merge':
      db.merge({
        branch: statement.branch,
        id: statement.id ?? '',
        type: statement.type !== undefined ? typeCode(statement.type) : undefined,
        tags: statement.tags ?? undefined,
      });
      break;
    case 'Checkout':
      db.checkout(statement.branch);
      break;
    case 'CherryPicking':
      db.cherryPick({
        id: statement.id,
        targetId: '',
        tags: statement.tags?.length === 0 ? undefined : statement.tags,
        parent: statement.parent,
      });
      break;
  }
}

export function buildGit(ast: GitGraphAst, config: Config, title: string | undefined): GitModel {
  const git = config.gitGraph as Config | undefined;
  const mainName = typeof git?.mainBranchName === 'string' ? git.mainBranchName : 'main';
  const mainOrder = typeof git?.mainBranchOrder === 'number' ? checkedOrder(git.mainBranchOrder) : 0;

  const commits = new Map<string, GitCommit>();
  const branches = new Map<string, string | null>([[mainName, null]]);
  const orders = new Map<string, number | undefined>([[mainName, mainOrder]]);
  const warnings: string[] = [];
  let head: GitCommit | null = null;
  let current = mainName;
  let direction: GitDirection = 'LR';
  let seq = 0;

  const nextId = (): string => {
    for (let salt = seq + 1; ; salt += 0x9e3779b1) {
      const id = `${seq}-${(Math.imul(salt, 0x9e3779b1) >>> 0).toString(16).padStart(8, '0').slice(0, 7)}`;
      if (!commits.has(id)) return id;
    }
  };

  const add = (commit: GitCommit): void => {
    head = commit;
    commits.set(commit.id, commit);
    branches.set(current, commit.id);
  };

  const checkout = (branch: string): void => {
    if (!branches.has(branch)) {
      fail(`Trying to checkout branch which is not yet created. (Help try using "branch ${branch}")`);
    }
    current = branch;
    const id = branches.get(branch);
    head = id ? (commits.get(id) ?? null) : null;
  };

  populate(ast, {
    setDirection(dir) {
      direction = dir;
    },

    commit({ msg, id, type, tags }) {
      const commit: GitCommit = {
        id: id ? id : nextId(),
        message: msg,
        seq: seq++,
        type: type ?? commitType.NORMAL,
        tags: tags ? [...tags] : [],
        parents: head === null ? [] : [head.id],
        branch: current,
      };
      if (commits.has(commit.id)) warnings.push(`Commit ID ${commit.id} already exists`);
      add(commit);
    },

    branch({ name, order }) {
      if (branches.has(name)) {
        fail(
          `Trying to create an existing branch. (Help: Either use a new name if you want create a new branch or try using "checkout ${name}")`
        );
      }
      const value = order === undefined ? undefined : checkedOrder(order);
      branches.set(name, head !== null ? head.id : null);
      orders.set(name, value);
      checkout(name);
    },

    merge({ branch: other, id: customId, type, tags }) {
      const currentHead = branches.get(current);
      const otherHead = branches.get(other);
      const currentCommit = currentHead ? commits.get(currentHead) : undefined;
      const otherCommit = otherHead ? commits.get(otherHead) : undefined;
      if (currentCommit && otherCommit && currentCommit.branch === other) {
        fail(`Cannot merge branch '${other}' into itself.`);
      }
      if (current === other) fail('Incorrect usage of "merge". Cannot merge a branch to itself');
      if (currentCommit === undefined) fail(`Incorrect usage of "merge". Current branch (${current})has no commits`);
      if (!branches.has(other)) fail(`Incorrect usage of "merge". Branch to be merged (${other}) does not exist`);
      if (otherCommit === undefined) fail(`Incorrect usage of "merge". Branch to be merged (${other}) has no commits`);
      if (currentCommit === otherCommit) fail('Incorrect usage of "merge". Both branches have same head');
      if (customId && commits.has(customId)) {
        fail(`Incorrect usage of "merge". Commit with id:${customId} already exists, use different custom id`);
      }
      add({
        id: customId || nextId(),
        message: `merged branch ${other} into ${current}`,
        seq: seq++,
        parents: head === null ? [] : [head.id, otherHead ? otherHead : ''],
        branch: current,
        type: commitType.MERGE,
        customType: type,
        customId: customId ? true : false,
        tags: tags ? [...tags] : [],
      });
    },

    cherryPick({ id: sourceId, targetId, tags, parent }) {
      const source = sourceId ? commits.get(sourceId) : undefined;
      if (source === undefined) fail('Incorrect usage of "cherryPick". Source commit id should exist and provided');
      if (parent && !source.parents.includes(parent)) {
        fail('Invalid operation: The specified parent commit is not an immediate parent of the cherry-picked commit.');
      }
      if (source.type === commitType.MERGE && !parent) {
        fail(
          'Incorrect usage of cherry-pick: If the source commit is a merge commit, an immediate parent commit must be specified.'
        );
      }
      if (targetId && commits.has(targetId)) return;
      if (source.branch === current) fail('Incorrect usage of "cherryPick". Source commit is already on current branch');
      const currentHead = branches.get(current);
      if (!currentHead || !commits.has(currentHead)) {
        fail(`Incorrect usage of "cherry-pick". Current branch (${current})has no commits`);
      }
      add({
        id: nextId(),
        message: `cherry-picked ${source.message} into ${current}`,
        seq: seq++,
        parents: head === null ? [] : [head.id, source.id],
        branch: current,
        type: commitType.CHERRY_PICK,
        tags: tags
          ? tags.filter(Boolean)
          : [`cherry-pick:${source.id}${source.type === commitType.MERGE ? `|parent:${parent}` : ''}`],
      });
    },

    checkout,
  });

  const lanes = [...orders]
    .map(([name, order], i) => ({ name, order: order ?? parseFloat(`0.${i}`) }))
    .sort((a, b) => a.order - b.order)
    .map((branch) => branch.name);

  return {
    type: 'gitGraph',
    title: ast.title || title,
    accTitle: ast.accTitle ? ast.accTitle.replace(/^\s+/g, '') : undefined,
    accDescr: ast.accDescr ? ast.accDescr.replace(/\n\s+/g, '\n') : undefined,
    direction,
    commits,
    branches,
    lanes,
    currentBranch: current,
    head,
    warnings,
  };
}
