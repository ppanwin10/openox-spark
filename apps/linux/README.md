# OpenOx Linux Host

[中文](README.zh-CN.md)

Run Ox on an always-on Linux machine, such as an NVIDIA DGX Spark, and use it from your phone or any browser. The Host stores your conversations, memory and files on that machine; connected clients also receive, and may cache, content you open. Ox can use a local model on it, any AI provider you add a key for, or both.

V1 is local-first. The native app can verify a private LAN Host from its invitation; standalone browsers use the Host's loopback address or an already trusted HTTPS entry. Outside access is optional and self-managed, not an account required for local setup.

## What you need

- A Linux machine with systemd, such as Ubuntu 24.04 or DGX OS, with `git`, `curl`, `unzip` and OpenSSL for encrypted LAN access. To read PDFs, scans and Office files, also install `poppler-utils`, `tesseract-ocr` and `libreoffice`.
- For a local model, a machine that a model pack supports (today, the DGX Spark) with Docker and the NVIDIA Container Toolkit. Otherwise, an API key from an AI provider.
- Only for optional Tailscale outside access: your own Tailscale account and the Tailscale app on the phone. The Host protocol does not require that provider.

## Set up

1. Install the Host. It runs as a user service on `127.0.0.1:9876`; run the script again to update it. The last command keeps the Host running after you log out.

   ```bash
   git clone https://github.com/ppanwin10/openox-spark.git ~/openox
   ~/openox/apps/linux/deploy/install.sh
   sudo loginctl enable-linger "$USER"
   ```

2. Add a local model. `list` shows which packs fit this machine. `install` downloads the engine and the model (about 50 GB of disk), checks every file, starts the model and adds it to the Host. The engine is NVIDIA's vLLM container, under the NVIDIA Software License Agreement; the model is under Apache 2.0. Without a supported GPU, skip this step and add a provider key in **Settings → Models** after pairing.

   ```bash
   ~/openox/apps/linux/packs/pack.sh list
   ~/openox/apps/linux/packs/pack.sh install spark-qwen3.6-35b
   ```

3. Optionally, add dictation, read aloud and image generation. This needs an NVIDIA GPU (tested on the DGX Spark) and downloads about 45 GB of models, all under Apache 2.0.

   ```bash
   ~/openox/apps/linux/deploy/media.sh --download
   ```

4. Enable local-network access explicitly. Choose the Host's assigned private IPv4 address from its network settings; do not use a public, loopback or all-interface address. Existing installations stay loopback-only unless you opt in. For the default installation above, run:

   ```bash
   systemctl --user edit openox-host.service
   ```

   Add this drop-in, replacing `192.168.1.50` with that address. Keep your own paths, port and `--data` argument if you customized them.

   ```ini
   [Service]
   ExecStart=
   ExecStart=%h/.bun/bin/bun %h/openox/apps/linux/src/main.ts serve --listen 127.0.0.1 --port 9876 --local-network 192.168.1.50
   ```

   ```bash
   systemctl --user daemon-reload
   systemctl --user restart openox-host.service
   ```

   This adds HTTPS on that private interface and retains loopback access. For a separate foreground/development Host, use `openox-host serve --local-network <private-ip> --data <dedicated-directory>` instead, on an unused port.

5. On the Host, create an invitation:

   ```bash
   openox-host pair
   ```

   In the current native app, open **Settings → Host and connections → Connect a Host** and scan or paste it. Nearby discovery only finds addresses; the invitation verifies the private Host CA. Tap **Connect** in the Host workspace to pair. Do not ignore a browser certificate warning: Safari cannot establish this private trust from an ordinary web page.

   The installer puts `openox-host` in `~/.local/bin`. If that folder isn't on your `PATH`, run `~/.local/bin/openox-host pair`.

## Optional outside access

Without a configured outside route, V1 only promises local-network use. **Host and connections** separates Agent Host access from the inference endpoints in **Models**, shows where data lives and lets you test, re-pair or remove a connection. Choosing an external Host opens its real web workspace in the native shell. It never silently uses the phone's Host or migrates data. Old reachability-only selections need an explicit fresh selection.

For Tailscale private access, configure the Host and phone yourself:

```bash
~/openox/apps/linux/deploy/tailscale.sh --hostname openox --tag tag:openox
```

Follow its access-policy and HTTPS instructions, then sign in to the phone's Tailscale app. Alternatively, supply an existing trusted HTTPS entry. Save that address in the selected Host's connection details and choose it explicitly. Saving an address does not install, enroll, start or stop Tailscale or a tunnel; no separate P2P switch is offered.

Each native Host/address has isolated persistent website data and needs its own pairing. Removing a connection clears its client cache, not Host files. Standalone browser switches use normal browser cookie rules: do not run mutually untrusted Hosts under one hostname on different ports.

Keep the Host's owner-only `connection-tls/` identity with its data backups. It is not replaced when files are incomplete or invalid. Leaf renewal/address updates happen at startup; changing the private CA or primary address requires a fresh invitation and pairing.

## Other HTTPS connections

For an independently managed connection, the Host can terminate TLS itself. Add both certificate flags to the existing service's `serve` command, or run a separate foreground instance; do not start a second Host on the same port.

```bash
openox-host serve --tls-cert /path/to/fullchain.pem --tls-key /path/to/privkey.pem
openox-host pair --url https://host.example.com
```

Supply a certificate trusted by your clients and keep its private key on the Host. The listener still defaults to `127.0.0.1`; configure your access route separately. Use byte-transparent forwarding if application TLS must terminate at the Host, rather than at a relay. Do not disable certificate checks or expose a shared development Host to the public internet.

TLS does not create outside access or provide a hosted consumer connection service. Domain/certificate provisioning, device ownership/recovery and real external-network acceptance remain separate work.

Developers can run the optional loopback carrier check with:

```bash
bun apps/linux/scripts/connectivity-check.ts --frp-dir /path/to/verified-frp-0.72.0 --out /outside/the/checkout
```

It needs frp 0.72.0, OpenSSL and an installed Google Chrome, and uses an isolated Host and scripted model. It is not a cellular-network or physical-iPhone test.

For the assigned-private-interface TLS, invitation, restart, revocation and cleanup packet:

```bash
bun apps/linux/scripts/local-connections-check.ts --address <assigned-private-ip> --out /outside/the/checkout
```

## Afterwards

- Pair more devices in **Settings → Devices and security**, and choose models or add provider keys in **Settings → Models**.
- `pack.sh status|stop|start spark-qwen3.6-35b` manages the local model. A stopped model frees its memory and stays stopped after a reboot.
- The Host's log: `journalctl --user -u openox-host`.

The [setup guide](../../.agents/skills/setup/SKILL.md) lists every option.
