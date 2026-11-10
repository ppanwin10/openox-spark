# OpenOx Linux 主机

[English](README.md)

把 Ox 装在一台常开的 Linux 机器上（比如 NVIDIA DGX Spark），就能用手机或任何浏览器随时使用。主机会在这台机器上保存对话、记忆和文件；已连接的客户端也会接收你打开的内容，并可能缓存。Ox 可以用机器上的本地模型，也可以用你添加了密钥的任意 AI 服务商，两者也能同时使用。

## 准备

- 一台带 systemd 的 Linux 机器（例如 Ubuntu 24.04 或 DGX OS），装好 `git`、`curl` 和 `unzip`。要读 PDF、扫描件和 Office 文件，再装上 `poppler-utils`、`tesseract-ocr` 和 `libreoffice`。
- 要用本地模型，机器得有适配的模型包（目前只有 DGX Spark），并装好 Docker 和 NVIDIA Container Toolkit。没有的话，准备一个 AI 服务商的 API 密钥就行。
- 如果采用下面的 Tailscale 私网方案，需要一个 Tailscale 账号，并在手机上安装 Tailscale App。Host 协议本身不要求 Tailscale；其他 HTTPS 访问方式也能沿用设备配对。

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

4. 按这套私网方案让手机连上主机。这个脚本以非 root 方式运行 Tailscale，让你 tailnet 里的设备通过 HTTPS 访问主机。打开登录链接之前，先把脚本打印的访问规则加进 tailnet 策略；如果提示开启 HTTPS 证书，到 Tailscale 管理后台打开即可。

   ```bash
   ~/openox/apps/linux/deploy/tailscale.sh --hostname openox --tag tag:openox
   ```

5. 配对手机。手机上的 Tailscale App 用同一个账号登录，然后用相机扫描脚本打印的二维码，点 **连接**。需要新的配对码时运行：

   ```bash
   openox-host pair
   ```

   安装脚本会把 `openox-host` 放在 `~/.local/bin`。如果这个目录不在 `PATH` 里，请运行 `~/.local/bin/openox-host pair`。

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

## 日常使用

- 在 **设置 → 设备与安全** 里配对更多设备；在 **设置 → 模型** 里选择模型或添加 AI 服务商密钥。
- 用 `pack.sh status|stop|start spark-qwen3.6-35b` 管理本地模型。停止后会释放内存，重启机器后也保持停止。
- 查看主机日志：`journalctl --user -u openox-host`。

全部选项见[安装指南](../../.agents/skills/setup/SKILL.md)（英文）。
