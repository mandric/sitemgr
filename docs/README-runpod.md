# sitemgr — RunPod Dev Environment

Remote dev environment for [sitemgr](https://github.com/mandric/sitemgr).  
Uses a RunPod CPU pod + network volume + `scripts/lib.sh` for automated setup.

**Model:** one pod = one developer + Claude Code sub-agents working in parallel.  
Terminate the pod when done, restart when needed — bootstrap is fully automated.

---

## Prerequisites

- RunPod account with credits
- Claude Max subscription (for Remote Control)
- SSH key pair

---

## 1. Create a Network Volume

In RunPod → Storage → New Network Volume:
- Name: `sitemgr`
- Size: 20GB
- Region: pick one close to you

Persists across pod restarts:

```
/workspace/
├── sitemgr/          ← repo + node_modules
├── .ollama/          ← Ollama model cache (~1.7GB, slow to re-download)
└── (supabase data)   ← local DB state
```

---

## 2. Deploy a Pod

Pods → Deploy → CPU tab:
- **Hardware**: 4 vCPUs / 16GB RAM (~$0.16/hr)
- **Container Disk**: 20GB (Ollama binary alone is ~5GB)
- **Network Volume**: select `sitemgr`, mount at `/workspace`
- **Expose ports**: `22` (SSH) + optionally `3000`, `54321`, `54323` for public access
- **Environment variables**:
  - `PUBLIC_KEY` — paste your `~/.ssh/id_ed25519.pub`

> No GPU needed. Claude Code inference runs on Anthropic's servers.

---

## 3. Bootstrap (once per pod, as root)

```bash
# From your local machine — copy lib.sh to the pod
scp scripts/lib.sh root@<pod-host>:/tmp/

# SSH in as root
ssh root@<pod-host> -p <port>

source /tmp/lib.sh
server_bootstrap
```

`server_bootstrap` does everything in one command:
1. Starts Docker
2. Clones repo to `/workspace/sitemgr`
3. Runs `npm install`
4. Installs Supabase CLI + starts Supabase
5. Starts Ollama + pulls model in background

First run takes a few minutes (Docker images + Ollama model). Subsequent
runs are fast — each step is a no-op if already done.

---

## 4. Generate .env.local

```bash
cd /workspace/sitemgr/web
npm run setup:env    # reads from running Supabase, writes .env.local
```

---

## 5. Start Developing

```bash
# Start Claude Code in a tmux session
new_session main

# Attach to the session
attach_session main

# Detach (session keeps running): Ctrl+B, D

# Check what's running
service_status
```

On your phone: Claude app → Code tab → scan QR code.

Claude Code's `/deep-plan` and `/deep-implement` spawn parallel sub-agents
internally — no separate user accounts needed.

---

## Access Local Services

Services run inside the pod. Access them via SSH tunnel:

```bash
ssh -L 3000:localhost:3000 \
    -L 54321:localhost:54321 \
    -L 54323:localhost:54323 \
    root@<pod-host> -p <port>
```

Then open in your browser:
- Next.js dev server: http://localhost:3000
- Supabase Studio: http://localhost:54323

Add a local alias:
```bash
# ~/.bashrc or ~/.zshrc
alias sitemgr-ssh='ssh -L 3000:localhost:3000 \
    -L 54321:localhost:54321 \
    -L 54323:localhost:54323 \
    root@<pod-host> -p <port>'
```

> **Sharing a preview:** expose port 3000 publicly in RunPod pod settings
> to get a shareable URL for the Next.js dev server.

---

## Daily Workflow

```bash
# Morning — restart pod, re-bootstrap (fast, everything cached)
ssh root@<pod-host> -p <port>
source /workspace/sitemgr/scripts/lib.sh
server_bootstrap
attach_session main   # back to where you left off

# Evening — terminate pod to stop paying
# Network volume keeps repo, node_modules, Ollama model, Supabase data
```

---

## Cost

| State | Cost |
|---|---|
| Pod running (4vCPU/16GB) | ~$0.16/hr |
| Pod stopped/terminated | $0 compute |
| Network volume (20GB) | ~$1/month |

---

## Helper Reference

```
server_bootstrap              full setup — run after every pod start
service_status                show service health
runpod_setup_supabase         (re)start Supabase
runpod_setup_ollama           (re)start Ollama
start_docker                  (re)start Docker daemon

new_session <n> [branch]      start tmux session with Claude Code
attach_session <n>            attach to session
list_sessions                 list sessions + orchestrator info
kill_session <n>              kill a session

SITEMGR_ORCHESTRATOR=claude|claude-api|opencode|aider|custom
```

---

## Troubleshooting

**Services down after pod restart:**
```bash
source /workspace/sitemgr/scripts/lib.sh
server_bootstrap
```

**Ollama model still pulling:**
```bash
tail -f /tmp/ollama-pull.log
```

**Supabase slow to start (first run):**
```bash
tail -f /tmp/supabase.log
docker ps   # watch containers come up
```

**Claude Code auth (first time):**
```bash
claude   # follow /login prompt
# Max subscription uses OAuth — no ANTHROPIC_API_KEY needed
```
