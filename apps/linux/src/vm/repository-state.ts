import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ConnectedRepository {
  id: string;
  url: string;
  name: string;
  enabled: boolean;
  syncedAt: number | null;
  commit: string | null;
  error: string | null;
}
export interface RepositoryState {
  repositories: ConnectedRepository[];
  selections: Record<string, string>;
}

export const repositoryStatePath = (state: string) => join(state, "repositories.json");

export async function loadRepositoryState(state: string): Promise<RepositoryState> {
  try {
    const value = JSON.parse(await readFile(repositoryStatePath(state), "utf8")) as Partial<RepositoryState>;
    return { repositories: Array.isArray(value.repositories) ? value.repositories : [], selections: value.selections && typeof value.selections === "object" ? value.selections : {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { repositories: [], selections: {} };
    throw error;
  }
}

export async function saveRepositoryState(state: string, value: RepositoryState) {
  const path = repositoryStatePath(state), temporary = `${path}.${crypto.randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
