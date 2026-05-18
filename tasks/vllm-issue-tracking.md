# vllm Accessibility Issue Tracking

## Problem
vllm runs in WSL on port 8080 and shows as "running" in service-manager, but is completely inaccessible from Windows (`localhost:8080` and `192.168.0.157:8080` both fail with connection refused).

## Environment
- WSL2 in **mirrored networking mode** (`networkingMode=mirrored` in `~/.wslconfig`)
- WSL shares Windows IP: `192.168.0.157` (eth0)
- WSL also has VPN interface: eth1 `10.6.18.87` (PIA VPN) with full-tunnel routes (`0.0.0.0/1` and `128.0.0.0/1` via eth1)
- `~/.wslconfig` currently has `firewall=false` added

## Root Cause Hypothesis
The WSL localhost relay (managed by `WSLService`) is not creating Windows-side proxy sockets for WSL listeners. This is confirmed: starting a fresh Python HTTP server in WSL on port 19876 binds correctly inside WSL but `netstat -ano` on Windows shows nothing on that port.

**The VPN is NOT the cause** — it has been running alongside WSL for weeks without issue.

**Primary suspect: `firewall=false` in `~/.wslconfig`** — this was added during this debugging session. The WSL localhost relay may depend on the Hyper-V firewall infrastructure being present to function. Removing `firewall=false` and using an explicit inbound allow rule for port 8080 instead may restore relay functionality.

## What Was Tried

### Fixes Attempted
1. **Deleted stale `netsh portproxy` rule** (from a previous NAT-mode session) — rule was forwarding `0.0.0.0:8080 → 192.168.0.157:8080` which caused a self-loop in mirrored mode. Deleted via admin netsh command.
2. **Added `firewall=false` to `~/.wslconfig`** — disables WSL Hyper-V firewall so WSL services don't need per-port allow rules.
3. **Ran `wsl --shutdown`** — to reload `.wslconfig` and reset relay state. Did not fix relay.
4. **Tried portproxy in mirrored mode** — self-loops because WSL and Windows share the same IP. Not viable.

### Diagnostics Run
- `Get-NetFirewallHyperVRule`: Only 4 rules (ICMP + mDNS allow). Port 8080 NOT in allow list.
- `Get-NetFirewallProfile -PolicyStore HyperVFirewall`: Fails with "network path not found" — possibly `firewall=false` is taking effect.
- Windows `netstat -ano | grep :8080`: Empty — relay not creating Windows-side socket.
- WSL `ss -tlnp | grep 8080`: vllm IS bound to `0.0.0.0:8080` inside WSL.
- Test with Python HTTP server on port 19876: Binds in WSL, NOT visible from Windows, curl returns exit 7 (connection refused).
- 53 node.exe processes running on Windows — system in heavy use, possible resource contention.

### Code Changes Made (unrelated to this specific issue)
- `ensureWslPortProxy()` added to `portHelper.ts` — detects mirrored mode and logs remediation instead of creating self-looping portproxy.
- `isWslMirroredNetworking()` added — compares WSL eth0 IP against Windows ipconfig output.

## Root Cause Found

Two bugs in service-manager code:

### Bug 1: `shutdownWsl()` called on every WSL service start (FIXED)
`serviceService.ts` called `shutdownWsl()` before starting any WSL service. This killed the entire WSL VM right before vllm could bind its port. After shutdown, vllm would start loading the model but the WSL relay was never set up properly.

Fix: removed `shutdownWsl()` from `startService`, `restartService`, and `runAutoStart`. WSL services now just use `killPort()` like non-WSL services.

### Bug 2: `firewall=false` in `.wslconfig` kills `wslhost.exe` relay (FIXED)
`firewall=false` in `.wslconfig` prevents `wslhost.exe` from running. `wslhost.exe` is the Windows-side relay process that creates proxy sockets for WSL listeners. Without it, no Windows process can reach WSL services.

Fix: removed `firewall=false` from `~/.wslconfig`. Current config:
```ini
[wsl2]
networkingMode=mirrored
```

### Bug 3: `killMatchingProcesses` failing with exit code error (FIXED)
Was passing complex PowerShell pipeline as a `-Command` argument via `execFileAsync`, causing quoting/parsing errors. Fixed by using `-EncodedCommand` (Base64-encoded UTF-16LE) which avoids all quoting issues.

## Current State
- All three bugs fixed and tests pass (87 tests)
- `.wslconfig` has only `networkingMode=mirrored` (no `firewall=false`)
- vllm should be accessible once it finishes loading the model
