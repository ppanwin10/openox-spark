import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dir, "../../..");
const { values } = parseArgs({ options: { out: { type: "string" } } });
assert(values.out, "Use --out <outside-checkout-directory>");
assert(process.platform === "darwin" && process.arch === "arm64", "Build this test bundle on its Apple Silicon target");
const out = resolve(values.out), inside = relative(root, out);
assert(inside && (inside.startsWith(`..${sep}`) || isAbsolute(inside)), "Keep generated archives outside the checkout");
await mkdir(out, { recursive: true, mode: 0o700 });
const resolvedOut = relative(await realpath(root), await realpath(out));
assert(resolvedOut && (resolvedOut.startsWith(`..${sep}`) || isAbsolute(resolvedOut)), "The archive output resolves inside the checkout");
const work = await mkdtemp(join(tmpdir(), "openox-mac-package-"));
const name = "OpenOx-Mac-LAN-Test-arm64", bundle = join(work, name), source = join(bundle, "runtime");
async function run(args: string[], cwd = root) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(code, 0, `${args[0]} failed: ${error}`);
  return output;
}
try {
  await mkdir(source, { recursive: true });
  const prefixes = ["apps/linux/src/", "apps/linux/web/", "apps/cli/src/", "packages/agent/", "packages/protocol/", "packages/services/",
    "apps/shared/", "apps/ios/Resources/Pele.bundle/"];
  const exact = ["package.json", "bun.lock", "LICENSE", "apps/linux/package.json", "apps/cli/package.json", "apps/cli/LICENSE",
    "apps/linux/scripts/mac-local-host.ts", "apps/linux/scripts/mac-host-console.ts"];
  const tracked = (await run(["git", "ls-files", "-z"])).split("\0").filter(Boolean);
  const paths = [...new Set([...tracked.filter(path => exact.includes(path) || prefixes.some(prefix => path.startsWith(prefix))), ...exact])];
  for (const path of paths) {
    assert(!isAbsolute(path) && !path.split("/").includes(".."));
    const from = join(root, path);
    assert((await lstat(from)).isFile(), `Only regular tracked runtime files can be packaged: ${path}`);
    const to = join(source, path);
    await mkdir(resolve(to, ".."), { recursive: true });
    await copyFile(from, to);
  }
  for (const workspace of ["", "apps/linux", "apps/cli", "packages/agent", "packages/protocol", "packages/services"]) {
    const path = join(workspace, "node_modules");
    await run(["/bin/cp", "-RP", join(root, path), join(source, path)]);
  }
  await mkdir(join(bundle, "bin"));
  await copyFile(process.execPath, join(bundle, "bin/bun"));
  await chmod(join(bundle, "bin/bun"), 0o755);
  await run([join(bundle, "bin/bun"), "--no-env-file", "-e",
    'const result=await Bun.build({entrypoints:["./apps/linux/web/index.html","./apps/linux/web/host-console.html"],target:"browser",minify:true});if(!result.success)throw new AggregateError(result.logs,"Packaged web resources are incomplete");'], source);
  const bunLicense = await run([process.execPath, "--license"]);
  await writeFile(join(bundle, "BUN-LICENSE.txt"), bunLicense);
  for (const [file, command] of [["Start.command", "start"], ["Pair.command", "pair"], ["Stop.command", "stop"]] as const) {
    await writeFile(join(bundle, file), `#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(/bin/pwd -P)"
export OPENOX_MEDIA_URL=http://127.0.0.1:9
exec "$HERE/bin/bun" --no-env-file "$HERE/runtime/apps/linux/scripts/mac-local-host.ts" ${command} --data "$HOME/Library/Application Support/OpenOx Mac LAN Test"
`, { mode: 0o755 });
  }
  await writeFile(join(bundle, "README.txt"), `Mac 局域网 Host 测试包（Apple Silicon）

仅用于当前这台 Mac 的工程测试，不是正式签名/公证安装器。
运行时与依赖已附带；不会安装全局 Bun、开启自动启动或更改系统证书。
工程侧准备的独立证书保存在本机资料目录，不在 ZIP 里，也不使用生产私钥。

1. 解压，双击 Start.command 打开本机 Host 管理台。相同包的 Host 已运行时只打开管理页，不会重启。
2. 管理台显示所有配对记录、最近活动和实际网页会话；已配对不代表设备当前在线。
3. 点击「配对新设备」生成二维码。手机接入同一个可互通的局域网，用相机扫码，在 Safari 中点连接。
4. 可以确认后撤销任意配对。本机管理台点击「打开工作区」会接续已有授权，不再要求配对码，也不会替换手机邀请。
5. Pair.command 打开新配对面板；Stop.command 只停止已核实归属的测试 Host，不删除资料。
6. 升级旧包时先运行旧包自己的 Stop.command，再运行新包。新包不会接管或停止另一目录里的运行进程。

本机管理页仅监听 127.0.0.1，由仅所有者可访问的本地控制通道授权，不是局域网公开管理接口。
重新打开管理页请运行 Start.command，不要分享本机授权链接。添加新码会替换尚未使用的旧码。
这是脚本回复测试，不是 AI 推理，不调用 Spark/MyGPT，也不验证模型质量。

资料与身份：~/Library/Application Support/OpenOx Mac LAN Test
主机只绑定工程配置的私有网卡地址，不开放公网，不配置 Tailscale 或中继。
需让 Mac 保持唤醒。切换 Wi-Fi/IP、证书到期或证书准备未完成时会明确停止，请联系工程侧更新。
此包不覆盖 PDF/OCR、浏览器工具、真实模型或完整 macOS 产品兼容性验收。
若系统阻止未公证的测试启动器，不要关闭 Gatekeeper 或其他系统安全设置。
`);
  const files: string[] = [];
  const canonicalBundle = await realpath(bundle);
  async function inspect(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), relativePath = relative(bundle, path);
      assert(![".env", "auth.json", "credentials.json", "devices.json", "server.key", "account.key", "fullchain.pem", "run.json", "Connect phone.html", "Host console.html"].includes(entry.name),
        `Forbidden private artifact: ${relativePath}`);
      if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        assert(!isAbsolute(target), `Absolute dependency link: ${relativePath}`);
        const destination = await realpath(path), difference = relative(canonicalBundle, destination);
        assert(difference && !difference.startsWith(`..${sep}`) && !isAbsolute(difference), `Dependency escapes archive: ${relativePath}`);
      } else if (entry.isDirectory()) await inspect(path);
      else files.push(relativePath);
    }
  }
  await inspect(bundle);
  const version = (await run(["git", "rev-parse", "HEAD"])).trim();
  const changed = !!(await run(["git", "status", "--porcelain"])).trim();
  await writeFile(join(bundle, "BUILD.json"), JSON.stringify({ source: version, uncommittedChanges: changed, platform: "darwin-arm64",
    bun: Bun.version, runtimeFiles: files.length, bundledIdentityOrCredentials: false, engineeringTestOnly: true }, null, 2));
  const archive = join(out, `${name}.zip`);
  await run(["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", bundle, archive], work);
  const sha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
  await writeFile(join(out, "SHA256SUMS"), `${sha256}  ${basename(archive)}\n`);
  console.log(JSON.stringify({ archive, sha256, source: version, uncommittedChanges: changed, runtimeFiles: files.length }));
} finally {
  await rm(work, { recursive: true, force: true });
}
