# WSL + vllm Accessibility: Lessons Learned

## Setup
- Windows 11, WSL2 Ubuntu
- vllm runs inside WSL on port 8080
- service-manager (Next.js on port 4000) manages vllm as a service with `wsl: true`

## Working Solution (TL;DR)

Use **NAT mode** with a **portproxy** rule created once as admin:

**`~/.wslconfig`:**
```ini
[wsl2]
networkingMode=nat
```

**Create portproxy (run once as admin — survives reboots):**
```powershell
# Get current WSL NAT IP
wsl -e bash -c "hostname -I | awk '{print $1}'"

# Create portproxy (replace 172.23.x.x with actual WSL IP)
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=8080 connectaddress=172.23.x.x connectport=8080
```

This routes Windows `localhost:8080` → WSL's separate NAT IP → vllm. The portproxy rule persists across reboots. The WSL NAT IP is stable between restarts (only changes after `wsl --shutdown`).

**Why not mirrored mode?** In mirrored mode, WSL and Windows share the same IP. Portproxy self-loops. The `wslhost.exe` relay *should* handle localhost forwarding automatically but in practice does not create Windows-side sockets for arbitrary port bindings — the relay socket never appears in `netstat`. NAT mode with explicit portproxy is the reliable path.

---

## Bug 1: `shutdownWsl()` called on every WSL service start

### Symptom
vllm showed as "running" in service-manager but was never actually accessible. Logs showed:
```
[portHelper] shutting down WSL to clear stale mirrored-networking relay sockets
```
...immediately followed by the vllm start command.

### Cause
`serviceService.ts` called `shutdownWsl()` before starting any WSL service, killing the entire WSL VM right before vllm's start command ran. vllm then started loading inside a freshly-booted WSL with no relay state set up.

### Fix
Removed `shutdownWsl()` from `startService`, `restartService`, and `runAutoStart`. WSL services now just use `killPort()` to clear any process already on the port, same as non-WSL services. `shutdownWsl()` is a nuclear option — do not call it in a service start path.

---

## Bug 2: `firewall=false` in `.wslconfig` kills `wslhost.exe`

### Symptom
After adding `firewall=false` to `~/.wslconfig` (attempting to disable the Hyper-V firewall), no WSL services were reachable from Windows at all — not even a simple Python HTTP server on an arbitrary port.

### Cause
`firewall=false` prevents `wslhost.exe` from running. `wslhost.exe` is the Windows-side relay process that bridges WSL listeners to the Windows network stack in mirrored networking mode. Without it:
- No Windows-side relay socket is created when WSL binds a port
- `curl localhost:<port>` → connection refused
- `netstat -ano` shows nothing on that port

This is confirmed: with `firewall=false` absent, two `wslhost.exe` processes appear on WSL start. With `firewall=false` present, they do not.

### Fix
Remove `firewall=false` from `~/.wslconfig`. The correct config for mirrored mode is simply:
```ini
[wsl2]
networkingMode=mirrored
```

### What to do about the Hyper-V firewall instead
If you need specific ports open, add a Hyper-V firewall rule instead of disabling the firewall entirely:
```powershell
New-NetFirewallHyperVRule -Name "Allow-vllm-8080" -DisplayName "Allow vllm port 8080" `
  -Direction Inbound -Protocol TCP -LocalPorts 8080 -Action Allow `
  -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
```

---

## Bug 3: Stale `netsh portproxy` rule self-loops in mirrored mode

### Symptom
Curl to `localhost:8080` timed out (exit 28) instead of connection refused.

### Cause
A leftover `netsh portproxy` rule from a previous NAT-mode session:
```
0.0.0.0:8080 → 192.168.0.157:8080
```
In mirrored mode, WSL and Windows share the same IP (192.168.0.157). Portproxy received an inbound connection on port 8080 and then tried to forward it to 192.168.0.157:8080 — which is portproxy itself. Infinite loop → timeout.

In NAT mode this worked because the WSL IP was separate (e.g., 172.x.x.x), so the portproxy forwarded correctly.

### Fix
Delete stale portproxy rules (requires admin elevation):
```powershell
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=8080
```
service-manager's `deletePortProxyRulesOnPort()` handles this automatically but requires the process to run as admin for the delete to succeed.

---

## Bug 4: `killMatchingProcesses` failing silently

### Symptom
Logs showed repeated:
```
[portHelper] killMatchingProcesses failed: Command failed: powershell -NoProfile -NonInteractive -Command ...
```

### Cause
The PowerShell pipeline (`Get-CimInstance | Where-Object { ... } | ForEach-Object { ... }`) was passed as a `-Command` argument via `execFileAsync`. The curly braces, pipe characters, and `$_` variables caused parsing issues when PowerShell received the string as a single argument without a shell layer.

### Fix
Use `-EncodedCommand` (Base64-encoded UTF-16LE) which bypasses all quoting and shell-interpretation issues:
```typescript
const encoded = Buffer.from(script, 'utf16le').toString('base64')
await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded])
```

---

## mirrored vs NAT Mode Quick Reference

| Feature | NAT mode | Mirrored mode |
|---|---|---|
| WSL IP | Separate (172.x.x.x) | Same as Windows (e.g., 192.168.0.157) |
| Relay process | `wslhost.exe` | `wslhost.exe` (but doesn't create sockets for arbitrary ports) |
| portproxy target | WSL's separate NAT IP ✓ | Do NOT use — self-loops |
| `firewall=false` | Disables HV firewall | Also kills `wslhost.exe` — avoid |
| localhost forwarding | **Works reliably via portproxy** | Unreliable — relay sockets not created |
| **Recommended for vllm** | **Yes** | No |

## Key Diagnostic Commands

```powershell
# Check WSL is actually listening on the port inside WSL
wsl -e bash -c "ss -tlnp | grep 8080"

# Check if Windows has a socket on the port (portproxy or relay)
netstat -ano | findstr ":8080" | findstr "LISTEN"

# Get current WSL NAT IP
wsl -e bash -c "hostname -I | awk '{print $1}'"

# List all portproxy rules
netsh interface portproxy show all

# Delete a portproxy rule (requires admin)
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=8080

# Create portproxy rule (requires admin)
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=8080 connectaddress=<WSL-IP> connectport=8080

# Check if wslhost relay processes are running
Get-Process | Where-Object {$_.Name -like '*wslhost*'}

# Check Hyper-V firewall rules for WSL
Get-NetFirewallHyperVRule -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
```
