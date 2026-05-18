# Getting ~100 TPS from Qwen3.6-27B on RTX 5090 (Windows + WSL2)

## TL;DR

`Qwen3.6-27B-int4-AutoRound` running in vLLM 0.19.2rc1 with Genesis patches on WSL2 achieves **~92–106 TPS** for single-stream 1024-token responses on an RTX 5090. The two dominant levers over mainline vLLM are:

1. **vLLM 0.19.2rc1** (vs mainline `0.1.dev1` nightly) — provides `FULL_AND_PIECEWISE` CUDA graph mode by default
2. **Genesis P8 KV cache patch** — unifies page sizes between attention and Mamba layers, growing the KV cache from 75,200 to 310,400 tokens (4×)

Together these are worth **+40–50 TPS** over a stock mainline configuration.

---

## Target Numbers

| Config | TPS avg | Best run |
|---|---|---|
| Mainline vLLM latest (our `0.1.dev1`) | ~48 | ~52 |
| **vLLM 0.19.2rc1 + Genesis patches (native WSL)** | **~92** | **~106** |
| Docker (CobraPhil recipe) | ~95 | ~102 |
| Bare-metal Ubuntu (no WSL) | ~150–160 (community-reported) | — |

---

## What Actually Gets You to ~100 TPS

### 1. vLLM version: 0.19.2rc1 at commit `07351e088`

Mainline vLLM (`0.1.dev1`) runs at ~48 TPS with this model. vLLM 0.19.2rc1 (the same version the validated Docker recipe was built from) runs at ~92 TPS — same hardware, same flags. The version gap is the single largest lever.

The key feature v0.19.x brings: **`FULL_AND_PIECEWISE` CUDA graph mode by default.** v0.19.x captures CUDA graphs for decode batch sizes [1, 2, 4, 8], eliminating per-step kernel launch overhead. Mainline either skips graph capture (mode `NONE`) or garbles output when `FULL` is used with MTP on Blackwell (sm_120).

### 2. Genesis P8 KV cache patch (4× KV cache size)

Qwen3.6 is a hybrid attention+Mamba model. Without the patch, vLLM uses different page sizes for attention and Mamba KV layers, creating padding waste that limits the KV cache to 75,200 tokens. The Genesis P8 patch (`KV hybrid reporting`) unifies the page sizes, growing the cache to 310,400 tokens.

Verify the patch applied by checking startup logs:
```
INFO  kv_cache_utils.py:1404 GPU KV cache size: 310,400 tokens
INFO  cudagraph_mode: FULL_AND_PIECEWISE
```
If you see `75,200 tokens`, P8 didn't apply and you're at mainline performance.

### 3. `--max-num-batched-tokens 4128` (NOT 16384)

Counterintuitively, raising `--max-num-batched-tokens` to 16384 **regresses to 32 TPS**. In chunked-prefill throughput mode, a large batched-token budget causes the scheduler to wait for fuller batches before dispatching — adding latency that destroys sequential single-request TPS. The working value `4128` was chosen by the CobraPhil recipe and empirically confirmed.

### 4. MTP speculative decoding (`num_speculative_tokens=3`)

Multi-token prediction draft heads on this model accept ~64–70% of drafted tokens (per-position rates ~0.85 / 0.63 / 0.44 for positions 1–3). With n=3, the effective tokens-per-step multiplier is roughly 2.5–3×. Mainline vLLM's broken CUDA graph support for MTP on Blackwell suppresses this benefit; v0.19.x gets it.

### 5. WSL 2.7.x

WSL ≤ 2.4 has a ~50% throughput penalty on this workload (confirmed by community: 85 TPS in WSL 2.4 → 100+ TPS after updating to 2.7.x, same config). Check with `wsl --version`. Update with:
```powershell
wsl --update --pre-release
```

### 6. Key environment variables

These match what the Docker recipe sets:
```bash
export VLLM_USE_FLASHINFER_SAMPLER=1
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True,max_split_size_mb:512
export VLLM_FLOAT32_MATMUL_PRECISION=high
export VLLM_WORKER_MULTIPROC_METHOD=spawn
export NCCL_CUMEM_ENABLE=0
export NCCL_P2P_DISABLE=1
export CUDA_DEVICE_MAX_CONNECTIONS=8
export VLLM_MARLIN_USE_ATOMIC_ADD=1
```

### 7. `--kv-cache-dtype fp8_e4m3` (not TurboQuant)

TurboQuant `tq-t4nc` 3-bit KV cache enables higher TPS on RTX 3090 (67–89 TPS tested by community). However, when combined with MTP speculative decoding, TurboQuant causes output collapse on tool-call prompts. The recipe uses `fp8_e4m3` specifically to avoid this.

---

## Full Launch Configuration

```bash
#!/usr/bin/env bash
source ~/.venvs/vllm/bin/activate

export CUDA_VISIBLE_DEVICES=0
export CUDA_HOME=/usr/local/cuda
export PATH="$CUDA_HOME/bin:$PATH"
export LD_LIBRARY_PATH="$CUDA_HOME/lib64:/usr/lib/wsl/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

export VLLM_WORKER_MULTIPROC_METHOD=spawn
export NCCL_CUMEM_ENABLE=0
export NCCL_P2P_DISABLE=1
export VLLM_MEMORY_PROFILER_ESTIMATE_CUDAGRAPHS=1
export VLLM_NO_USAGE_STATS=1
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True,max_split_size_mb:512
export VLLM_FLOAT32_MATMUL_PRECISION=high
export VLLM_USE_FLASHINFER_SAMPLER=1
export OMP_NUM_THREADS=1
export CUDA_DEVICE_MAX_CONNECTIONS=8
export VLLM_ALLOW_LONG_MAX_MODEL_LEN=1
export VLLM_MARLIN_USE_ATOMIC_ADD=1

# Apply Genesis patches before serving — this is what unlocks the 4x KV cache
python -m vllm._genesis.patches.apply_all

exec vllm serve "/mnt/c/shared-drive/llm_models/Qwen3.6-27B-int4-AutoRound" \
  --served-model-name "qwen3.6-27b-autoround" \
  --quantization auto_round \
  --dtype float16 \
  --tensor-parallel-size 1 \
  --max-model-len 262144 \
  --gpu-memory-utilization 0.94 \
  --max-num-seqs 1 \
  --max-num-batched-tokens 4128 \
  --kv-cache-dtype fp8_e4m3 \
  --trust-remote-code \
  --reasoning-parser qwen3 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder \
  --chat-template "/mnt/c/jason/dev/vllm/qwen3.5-enhanced.jinja" \
  --enable-prefix-caching \
  --enable-chunked-prefill \
  --speculative-config '{"method":"mtp","num_speculative_tokens":3}' \
  --host "0.0.0.0" \
  --port "8080"
```

Do **not** add `--compilation-config.cudagraph_mode` — letting v0.19.x default to `FULL_AND_PIECEWISE` is what you want.

---

## Degraded State: 24 TPS After Long Uptime

### Symptom

After a vLLM process had been running since May 12 (~1 day), TPS dropped to a consistent **24–25 TPS** on all benchmark runs with no warmup improvement. Normal startup behavior shows run 1 at ~72 TPS (warmup) improving to 96–106 TPS by run 3. Stuck at 24 TPS means the warmup/ramp-up is completely absent.

### Diagnosis

- GPU temperature: 47°C (not throttling)
- GPU power: 72W at idle (fine); boosted to 3007 MHz core clock during inference (not P-state throttled)
- Genesis patches: confirmed applied (310,400 token KV cache visible)
- vLLM version: confirmed correct (07351e088)
- WSL version: confirmed 2.7.3

No visible root cause in process state. CUDA graph staleness or memory fragmentation after long uptime is the most likely culprit.

### Fix

Restart vLLM. The service manager (`http://localhost:4000`) manages vLLM as a WSL service and can restart it via:
```
POST http://localhost:4000/api/services/vllm/control
{ "action": "restart" }
```

After restart, TPS returned to normal (87–96 TPS per run).

### Lesson

If TPS is unexpectedly low and no code changes were made, restart vLLM first before investigating further. A process that has been running for 24+ hours can accumulate degraded CUDA graph state that doesn't self-heal.

---

## GPU P-State Variability

### Symptom

The RTX 5090 memory clock transitions between three states:
- **P0**: 14,001 MHz (~1,760 GB/s bandwidth) — active during inference
- **P1**: 7,001 MHz (~880 GB/s) — transitioning down
- **Idle**: 810 MHz — fully idle

When a benchmark starts while the GPU memory is at 810 MHz (idle), the first request begins at low bandwidth and ramps up mid-request. This causes the first run to measure **~40–50 TPS instead of 90+**. Back-to-back requests (GPU stays at 14,001 MHz) give consistent 90+ TPS.

### Benchmark Results Illustrating This

4 back-to-back runs after a fresh restart, each 1024-token response:
```
Run 1: 91.8 TPS  (GPU was at idle 810 MHz → ramped during request)
Run 2: 96.6 TPS  (GPU at 14,001 MHz already)
Run 3: 96.3 TPS
Run 4: 87.5 TPS
Average: 93.1 TPS
```

### Fix (Optional)

Set "Prefer Maximum Performance" in NVIDIA Control Panel → Manage 3D Settings → Power management mode for the RTX 5090. This prevents the GPU from dropping to idle clock between requests.

Alternatively, lock clocks from an elevated PowerShell:
```powershell
nvidia-smi -lgc 3090,3090
nvidia-smi -lmc 14001,14001
```
(Note: `-lmc` requires admin privileges. Cannot be set from within WSL.)

Without this fix, the first request after an idle period measures low (~40–50 TPS) but the model is operating correctly — warm it up with a dummy request before benchmarking.

---

## Benchmark Tool

`tps.ps1` in the vllm project root runs 3 sequential 1024-token requests and reports per-run TPS and TTFT. Invoke with `tps.bat`.

Expected output on a healthy instance (warm GPU):
```
Run 1/3 — TTFT: 1.2s  |  TPS: 72.9  (warmup)
Run 2/3 — TTFT: 1.0s  |  TPS: 98.8
Run 3/3 — TTFT: 0.9s  |  TPS: 106.2
Average: 92.6 TPS
```

---

## Common Pitfalls

| Symptom | Cause / Fix |
|---|---|
| 24–25 TPS, no warmup improvement | Degraded CUDA graph state from long uptime — restart vLLM |
| 32 TPS | `--max-num-batched-tokens 16384` set — change back to `4128` |
| 48–52 TPS | Running mainline vLLM (`0.1.dev1`) — switch to `07351e088` |
| KV cache shows 75,200 tokens | Genesis P8 patch not applied — check `start_vllm.sh` runs `apply_all` before `serve` |
| First request at 40–50 TPS then 90+ after | GPU P-state ramp — normal, fix with NVCP power mode |
| 70–80 TPS | WSL 2.4.x — run `wsl --update --pre-release` |
| `flashinfer JIT requires CUDA >= 12.9` | Install `cuda-nvcc-13-1` from NVIDIA WSL repo |

---

## References

- vLLM source: `github.com/vllm-project/vllm` at commit `07351e088`
- Genesis patches: `github.com/Sandermage/genesis-vllm-patches`
- Docker recipe: `github.com/CobraPhil/qwen36-27b-single-5090`
- Model: `huggingface.co/Lorbus/Qwen3.6-27B-int4-AutoRound`
- Detailed benchmark history: `RESEARCH.md` in the vllm project
- Full setup guide: `100-tps-with-5090-setup.md` in the vllm project
- Reddit thread (community 105 TPS report): `reddit.com/r/LocalLLaMA/comments/1sw21op/`
