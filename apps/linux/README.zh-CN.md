# OpenOx Linux 主机

[English](README.md)

把 Ox 装在一台常开的 Linux 机器上（比如 NVIDIA DGX Spark），就能用手机或任何浏览器随时使用。主机会在这台机器上保存对话、记忆和文件；已连接的客户端也会接收你打开的内容，并可能缓存。Ox 可以用机器上的本地模型，也可以用你添加了密钥的任意 AI 服务商，两者也能同时使用。

V1 优先使用局域网。原生 App 可通过邀请验证本地主机；独立浏览器使用主机本机地址，或已有的可信 HTTPS 入口。家外访问由你按需配置，本地初次设置不需要注册第三方账号。

## 准备

- 一台带 systemd 的 Linux 机器（例如 Ubuntu 24.04 或 DGX OS），装好 `git`、`curl`、`unzip`，加密局域网连接还需要 OpenSSL。要读 PDF、扫描件和 Office 文件，再装上 `poppler-utils`、`tesseract-ocr` 和 `libreoffice`。
- 要用本地模型，机器得有适配的模型包（目前只有 DGX Spark），并装好 Docker 和 NVIDIA Container Toolkit。没有的话，准备一个 AI 服务商的 API 密钥就行。
- 只有选择可选的 Tailscale 家外访问时，才需要你自己的 Tailscale 账号和手机上的 Tailscale App；Host 协议不依赖这一家服务商。

## 安装

1. 安装主机。它以用户服务的形式运行在 `127.0.0.1:9876`，以后想更新，再运行一次这个脚本即可。最后一条命令让你退出登录后主机仍然在线。

   ```bash
   git clone https://github.com/ppanwin10/openox-spark.git ~/openox
   ~/openox/apps/linux/deploy/install.sh
   sudo loginctl enable-linger "$USER"
   ```

2. 添加本地模型。`list` 列出适合这台机器的模型包；`install` 会下载推理引擎和模型（约占 50 GB 磁盘），逐个校验文件，启动模型并把它加到主机里。推理引擎是 NVIDIA 的 vLLM 容器，适用 NVIDIA 软件许可协议；模型采用 Apache 2.0 许可。没有受支持的 GPU 就跳过这一步，配对后在 **设置 → 模型** 里添加 AI 服务商的密钥。

   ```bash
   ~/openox/apps/linux/packs/pack.sh list
   ~/openox/apps/linux/packs/pack.sh install spark-qwen3.6-35b
   ```

3. 可选：加上语音输入、朗读和图片生成。需要 NVIDIA GPU（已在 DGX Spark 上测试），会下载约 45 GB 的模型，均采用 Apache 2.0 许可。

   ```bash
   ~/openox/apps/linux/deploy/media.sh --download
   ```

4. 明确开启局域网入口。在主机的网络设置中找到已分配的私有 IPv4 地址，不要填写公网、回环或全部接口地址。旧安装不会自动扩大监听范围。使用上面的默认安装时，运行：

   ```bash
   systemctl --user edit openox-host.service
   ```

   填入下面的覆盖配置，把 `192.168.1.50` 换成实际地址。如果修改过路径、端口或数据目录，请保留自己的参数。

   ```ini
   [Service]
   ExecStart=
   ExecStart=%h/.bun/bin/bun %h/openox/apps/linux/src/main.ts serve --listen 127.0.0.1 --port 9876 --local-network 192.168.1.50
   ```

   ```bash
   systemctl --user daemon-reload
   systemctl --user restart openox-host.service
   ```

   这会在指定私有接口上增加 HTTPS 入口，原本的本机入口仍可用。独立的前台或开发主机也可使用 `openox-host serve --local-network <private-ip> --data <dedicated-directory>`，但要选未占用的端口。

5. 在主机上生成配对邀请：

   ```bash
   openox-host pair
   ```

   在当前原生 App 中打开 **设置 → 主机与连接 → 连接主机**，扫描或粘贴邀请。附近发现只提供地址，私有主机的身份由邀请来验证。进入主机工作区后再点 **连接** 完成配对。不要跳过浏览器的证书警告：普通网页无法替 Safari 建立这种私有信任。

   安装脚本会把 `openox-host` 放在 `~/.local/bin`。如果这个目录不在 `PATH` 里，请运行 `~/.local/bin/openox-host pair`。

## Mac 上的 Safari 局域网工程测试

上面的安装脚本只适用于 Linux。Apple Silicon Mac 可由工程侧运行 `bun apps/linux/scripts/package-mac-host.ts --out <仓库外目录>` 生成私有测试 ZIP。包里自带 Bun、工作区依赖、共享协议与服务文件，以及带许可证的图表渲染器；不会安装全局运行时或自动启动。

测试域名和独立可信证书由工程侧准备，域名指向 Mac 当前的私网 IP。用户不需要购买域名、安装根证书或跳过证书警告。本机仅所有者可读的 `~/Library/Application Support/OpenOx Mac LAN Test/identity/` 保存 `host.json`（`hostname`、`address`、`port`）、`server.key` 和 `fullchain.pem`，这些文件都不放进 ZIP。身份材料缺失、过期、不匹配，或网卡、DNS 不符时会明确停止，不会偷偷更换连接方式。

在已准备好的这台 Mac 上解压，运行 **Start.command**，会打开实时 Host 管理台。管理台仅监听本机回环地址，通过仅所有者可访问的本地通道、短时一次性授权和 HttpOnly 本机会话访问，不是无需授权的本地或局域网管理接口。相同包的 Host 已运行时，再次运行 Start 只打开管理页，不会重启。列表显示所有已授权客户端、最近活动和实际网页会话，已配对不代表设备当前在线。点击「添加配对」显示限时二维码，手机接入同一个可互通的局域网，用相机扫码后在 Safari 确认连接；也可确认后撤销指定配对，或打开已有共享工作区，不需要注册账号。

**Pair.command** 打开新配对面板，**Stop.command** 只停止已核实归属的测试进程，保留资料。升级正在运行的旧包时，先明确运行旧包自己的 Stop；新包不会接管其他目录的进程。运行记录只保存控制地址和套接字路径，不保存管理员或 Host 会话凭据。回复明确标注为脚本测试，不是真实 AI 推理；不需要 Spark、MyGPT、Tailscale 或中继。这不是已签名、公证的消费者安装器，也不代表完整 macOS 功能验收；真机测试和证书自动管理仍需另外完成。

可运行 `bun .agents/skills/test/protocol/client-host/pairing/archive.ts --archive <zip> --out <仓库外目录>` 重复隔离验收；旧脚本路径保留为转发入口。它检查真实可信 HTTPS、独立配对、文件与重启后的状态、进程归属，以及桌面和手机布局截图，不依赖全局运行时或源码目录。明确启动 Apple 的驱动并授权 Safari 自动化后，可加 `--safari-driver http://127.0.0.1:<端口>` 检查原生 Mac Safari 中二维码是否完整可见；脚本不会修改浏览器设置。浏览器手机布局模拟不能代替 iOS 模拟器或真机验收。功能与用例门禁见 `plans/feature-acceptance.md`。

本机管理台只保留设备列表与详情两区。「打开工作区」会通过短时、一次性授权接续管理台的权限，并复用已有浏览器授权，不会生成或替换手机配对码。新的远端浏览器仍需正常配对；系统不会因为请求来自本地地址就放行。归档验收加 `--workspace-pages` 可检查桌面／窄屏全部页面、浏览器复用与断开后重新进入，以及手机邀请是否保留；这不授权外部账号登录、真实模型调用或操作用户资料。

## 可选的家外访问

网页会常驻显示当前工作区与主机，和模型选择分开。**工作区** 是已有 Profile 的界面名称，不是新建的个人账户；配对到这台 Linux 主机的设备共用资料和权限。浏览器的一个标签页打开一台主机的工作区；原生 App 可以保存多台主机，但一次只进入一个。两台主机即使用同名模型，工具、技能、记忆和设置也可能不同。

**主机与连接** 把浏览器正在使用的地址和主机可选的局域网、家外入口分开显示。没有记录额外家外入口，不代表当前 HTTPS 连接有问题。网页里的入口记录由主机共享；原生 App 所选的连接方式只保存在该客户端。切换不会取消主机任务，也不会搬移资料。网页内打开其他主机时，会提醒未发送的文字或附件选择，并在上传、提交尚未完成时阻止离开；这不覆盖浏览器的其他跳转或原生外壳的主机选择器。客户端可能保留缓存和下载；配置的模型或工具服务也可能在主机以外处理内容。

没有配置家外通道时，V1 只保证局域网使用。**主机与连接** 管理运行助理的主机，与 **模型** 中的推理服务地址分开；这里显示数据位置，并提供检测、重新配对和移除操作。选择外部主机后，原生外壳打开的是它真实的 Web 工作区，不会悄悄改用手机，也不会搬移数据。旧版仅用于探测的选择需要重新明确选择一次。

如果采用 Tailscale 私网，请自行配置主机和手机：

```bash
~/openox/apps/linux/deploy/tailscale.sh --hostname openox --tag tag:openox
```

按脚本提示配置访问规则与 HTTPS，再登录手机上的 Tailscale App。也可使用已有的可信 HTTPS 入口。在所选主机的连接详情中保存地址，再明确选择使用它。保存地址不会安装、注册、启动或关闭 Tailscale 或隧道，也没有单独的 P2P 开关。

原生 App 按主机和地址隔离持久网页数据，各地址分别配对。移除连接只清除客户端缓存，不删除主机文件。独立浏览器仍遵循自身的 Cookie 规则，不要把互不信任的主机放在同一主机名的不同端口上。

备份主机数据时，请保留仅所有者可读的 `connection-tls/` 身份目录。文件不完整或无效时，程序不会自动换一套身份；叶证书续期和地址更新发生在启动时。更换私有 CA 或常用地址后，需要重新生成邀请和配对。

## 其他 HTTPS 访问方式

如果你自行管理连接通道，也可以让 Host 自己处理 TLS。为已有服务的 `serve` 启动命令同时加上证书和私钥参数，或单独以前台方式运行；不要在同一端口再启动一份主机。

```bash
openox-host serve --tls-cert /path/to/fullchain.pem --tls-key /path/to/privkey.pem
openox-host pair --url https://host.example.com
```

证书必须受客户端信任，私钥留在 Host 上。监听地址默认仍是 `127.0.0.1`，访问通道需要另外配置。如果要求应用流量一直加密到 Host，中继就应原样转发字节，而不是先解密再转发。不要关闭证书校验，也不要为了测试把共用开发主机开放到公网。

开启 TLS 不会自动打通外网，也不等于已经有面向用户的托管连接服务。域名与证书配置、设备归属与找回，以及真实外网验收，都还需要单独完成。

开发者可以运行可选的本机中继检查：

```bash
bun apps/linux/scripts/connectivity-check.ts --frp-dir /path/to/verified-frp-0.72.0 --out /outside/the/checkout
```

需要 frp 0.72.0、OpenSSL 和已安装的 Google Chrome，测试使用独立 Host 和脚本模型。这不是蜂窝网络或实体 iPhone 验收。

指定私有接口上的 TLS、邀请、重启、撤销和清理检查：

```bash
bun apps/linux/scripts/local-connections-check.ts --address <assigned-private-ip> --out /outside/the/checkout
```

## 日常使用

- 在 **设置 → 设备与安全** 里配对更多设备；在 **设置 → 模型** 里选择模型或添加 AI 服务商密钥。
- 用 `pack.sh status|stop|start spark-qwen3.6-35b` 管理本地模型。停止后会释放内存，重启机器后也保持停止。
- 查看主机日志：`journalctl --user -u openox-host`。

全部选项见[安装指南](../../.agents/skills/setup/SKILL.md)（英文）。
