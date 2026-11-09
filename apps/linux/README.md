# OpenOx Linux Host

[中文](README.zh-CN.md)

Run Ox on an always-on Linux machine, such as an NVIDIA DGX Spark, and use it from your phone or any browser. Your conversations, memory and files stay on that machine. Ox can use a local model on it, any AI provider you add a key for, or both.

## What you need

- A Linux machine with systemd, such as Ubuntu 24.04 or DGX OS, with `git`, `curl` and `unzip`. To read PDFs, scans and Office files, also install `poppler-utils`, `tesseract-ocr` and `libreoffice`.
- For a local model, a machine that a model pack supports (today, the DGX Spark) with Docker and the NVIDIA Container Toolkit. Otherwise, an API key from an AI provider.
- A Tailscale account, with the Tailscale app on your phone, to reach the Host away from home.

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

4. Reach the Host from your phone. The script runs Tailscale without root and lets devices in your tailnet open the Host over HTTPS. Before you open the login link, add the access rule it prints to your tailnet policy; if it asks, turn on HTTPS certificates in the Tailscale admin console.

   ```bash
   ~/openox/apps/linux/deploy/tailscale.sh --hostname openox --tag tag:openox
   ```

5. Pair your phone. Sign in to the Tailscale app with the same account, scan the QR code the script printed with the camera, and tap **Connect**. For a new code:

   ```bash
   openox-host pair
   ```

   The installer puts `openox-host` in `~/.local/bin`. If that folder isn't on your `PATH`, run `~/.local/bin/openox-host pair`.

## Afterwards

- Pair more devices in **Settings → Devices and security**, and choose models or add provider keys in **Settings → Models**.
- `pack.sh status|stop|start spark-qwen3.6-35b` manages the local model. A stopped model frees its memory and stays stopped after a reboot.
- The Host's log: `journalctl --user -u openox-host`.

The [setup guide](../../.agents/skills/setup/SKILL.md) lists every option.
