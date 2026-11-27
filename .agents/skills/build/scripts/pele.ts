import assert from "node:assert/strict";
import { join, relative, resolve } from "node:path";
import { ROOT, run, runCheck } from "../../../lib.ts";

const owner = ".agents/skills/build/renderers/pele";
const resource = "apps/ios/Resources/Pele.bundle/pele.js";
const hash = (bytes: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const read = (path: string) => Bun.file(join(ROOT, path));

export async function check(): Promise<string> {
  const pinned = await read(`${owner}/upstream.json`).json();
  const generated = await read(`${owner}/generated.json`).json();
  assert.equal(generated.upstreamCommit, pinned.commit);
  assert.equal(generated.upstreamBuildInputsSha256, pinned.upstreamBuildInputsSha256);
  assert.equal(generated.browserBuildSha256, pinned.browserBuildSha256);
  assert.equal(generated.resourceSha256, hash(await read(resource).bytes()), "Regenerate Pele through its pinned typed owner");
  assert.deepEqual(generated.files.map((file: { path: string }) => file.path).sort(), pinned.files.map((file: { path: string }) => file.path).sort());
  for (const file of generated.files) {
    assert.ok(pinned.files.some((entry: { path: string }) => entry.path === file.path));
    assert.equal(file.sha256, hash(await read(`${owner}/${file.path}`).bytes()), `Regenerate Pele after changing ${file.path}`);
  }
  return `Pele 1.6.0 pinned typed owner and ${generated.resourceBytes} resource bytes`;
}

if (import.meta.main) {
  const sourceArg = process.argv.find(arg => arg.startsWith("--source="));
  if (!sourceArg) {
    await runCheck(check);
  } else {
    const source = resolve(sourceArg.slice(9));
    const pinned = await read(`${owner}/upstream.json`).json();
    const previous = await read(`${owner}/generated.json`).exists() ? await read(`${owner}/generated.json`).json() : undefined;
    assert.equal((await Bun.file(join(source, "package.json")).json()).version, "1.6.0");
    const overridden = new Map<string, string>(pinned.files.map((file: { path: string; upstreamSha256: string }) => [file.path, file.upstreamSha256]));
    const inputs: [string, string][] = [];
    for (const path of pinned.buildInputPaths) {
      const actual = hash(await Bun.file(join(source, path)).bytes());
      const upstream = overridden.get(path);
      if (upstream) assert.ok(actual === upstream || actual === hash(await read(`${owner}/${path}`).bytes())
        || previous?.upstreamCommit === pinned.commit && previous.files.some((file: { path: string; sha256: string }) => file.path === path && file.sha256 === actual),
      `Unexpected upstream edit: ${path}`);
      inputs.push([path, upstream ?? actual]);
    }
    assert.equal(hash(JSON.stringify(inputs)), pinned.upstreamBuildInputsSha256, "The original canonical build inputs must match the pinned release");
    assert.equal(hash(await Bun.file(join(source, "scripts/browser-build.mjs")).bytes()), pinned.browserBuildSha256);
    const files: { path: string; sha256: string }[] = [];
    for (const file of pinned.files) {
      const bytes = await read(`${owner}/${file.path}`).bytes();
      await Bun.write(relative(process.cwd(), join(source, file.path)), bytes);
      files.push({ path: file.path, sha256: hash(bytes) });
    }
    await run([process.execPath, "--no-env-file", "run", "build"], { cwd: source });
    const bytes = await Bun.file(join(source, "dist/pele.global.js")).bytes();
    await Bun.write(relative(process.cwd(), join(ROOT, resource)), bytes);
    await Bun.write(relative(process.cwd(), join(ROOT, owner, "generated.json")), JSON.stringify({
      upstreamCommit: pinned.commit, upstreamBuildInputsSha256: pinned.upstreamBuildInputsSha256,
      browserBuildSha256: pinned.browserBuildSha256, originalBuildCommand: pinned.originalBuildCommand,
      esbuild: (await Bun.file(join(source, "node_modules/esbuild/package.json")).json()).version,
      typescript: (await Bun.file(join(source, "node_modules/typescript/package.json")).json()).version,
      files, resource, resourceBytes: bytes.length, resourceSha256: hash(bytes),
    }, null, 2) + "\n");
    await runCheck(check);
  }
}
