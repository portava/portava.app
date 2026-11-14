# Local inference lab — 13 November 2026

The current Mac was used for actual local inference, not mocked provider responses. Hardware: **M4 Pro, 14 CPU cores, 20 GPU cores, 24 GB unified memory**; macOS 26.6.2, arm64. Runtimes and weights live outside the app at `~/.local/share/portava-inference-lab`. No production provider, flag or credential was changed. No iPhone build was run.

**Conclusion: usable for development and evaluation; no replacement has qualified.** This small probe does not establish equivalence to a paid model or production capacity.

## Observed results

| Probe | Result | Decision |
| --- | --- | --- |
| Existing SigLIP CPU worker | 9 runs over two blank images and one public coffee photo; median **7.06 s/image**, model load **54.5 s** | Real inference works. This tiny sample does not measure recognition accuracy |
| Experimental SigLIP Metal path | First GPU pass **16.69 s**; four subsequent passes median **0.692 s**; maximum score difference from CPU **3.1e-12** on the one compared batch | Promising acceleration. Lab-only; does not enable GPU production routing |
| Existing Whisper Turbo CPU path | Public 11 s clip: **130.48 s**, normalized word error rate 0; next 7.24 s synthetic clip timed out after **180 s** | Current CPU path fails the local responsiveness screen; remaining cases were not run |
| Experimental Whisper Turbo Metal path | Model load **14.99 s**; public clip **17.00 s**; synthetic English/Spanish/Vietnamese **7.31 / 7.06 / 6.65 s**, excluding model load | Runs locally, but further quality and load work is required |
| Whisper silence | Generated “Thank you.” for an 8 s all-zero waveform before the guard | Failed abstention; production entry point now detects exact digital silence before model loading and returns no segments |
| Qwen3 4B Instruct, 4-bit, MLX | Four short prompts: **2.31–9.43 s**, **9.35–12.78 generated tokens/s**, model load **10.24 s**, peak MLX allocation **2.54 GiB** | Runs on this Mac, but **rejected as a replacement candidate in this probe** for intent/grounding and embedded-instruction failures |

Whisper word-error rates on these fixtures were 0% for public JFK and synthetic Vietnamese, 10% for synthetic English and 4.55% for synthetic Spanish. The English/Spanish differences were numeric rendering (`$20` versus `twenty dollars`; `30` versus `treinta`), not evidence of a semantic error in those examples. The metric is case/punctuation-normalized token edit distance; it does not normalize numbers or measure timing accuracy. Synthetic voices are not evidence of broad human speech or accent quality.

The image worker returned no travel candidates on the three chosen inputs. Blank-image abstention is useful, but this does not establish recall or calibration on travel photos. Metal equivalence was checked on one input, so the very small numerical difference must not be generalized to all inputs or hardware.

The text model added unsupported sunrise/scene details, changed a vegetarian preference to vegan, added a wait-time preference to the Vietnamese prompt, and followed a hotel-booking instruction embedded inside user-data tags. These are observed failures in an isolated model probe using Portava's system rules, not a full end-to-end test of Compass or the Input gateway. All outputs remain in the evidence, including failures. There was no booking, publication or other external action.

## Code fixes found by real execution

`artifacts/api-server/src/lib/media/captions/transcribe.py` now reads the parent's already normalized WAV directly. The installed faster-whisper 1.2.1 file decoder passed `metadata_errors` to PyAV 19.0.2, whose `av.open` rejects it. Reading bounded mono 16-bit, 16 kHz PCM avoids that redundant decoder and preserves the existing float32 sample conversion. Wrong formats, empty/truncated data, files over 30 MiB and duration over 901 seconds are refused before model loading.

Exact all-zero PCM now returns `{language: "und", languageProbability: 0, segments: []}` without loading the model. The existing caption validator refuses empty/unvalidated drafts, so no false caption is published. This is **not** a calibrated detector for noise, music or very quiet speech; those need representative tests. The experimental GPU probe intentionally retains its pre-fix output as evidence. The production entry point's post-fix silence result is stored separately.

The lab provisions only named, pinned model files, checks size and hashes, preserves a 10 GiB disk reserve, and refuses mismatched existing files. Inference runs used macOS `sandbox-exec` with `(deny network*)`, plus offline model-library settings. Public model/fixture downloads were separate from inference. No microphone, private photos, production database or user messages were used.

## Reproduction

Use the repository root as the working directory. Do not run all models concurrently on this machine. Model inference does not fetch weights. Provisioning needs explicit network access.

The installed bootstrap is uv **0.13.8**, with isolated Python **3.12.16**. Package snapshots are `requirements-media.macos-arm64-py312.txt` and `requirements-text.macos-arm64-py312.txt`; these record the tested macOS environment, not a universal Linux deployment lock. The official macOS 14+ MLX Metal 0.32.4 wheel was used on macOS 26 after the macOS 26-specific artifact download stalled. `mlx-metal-wheel.json` records its verified SHA-256. No package source was modified.

```sh
PORTAVA_LAB="$HOME/.local/share/portava-inference-lab"
python3 -m venv "$PORTAVA_LAB/bootstrap"
"$PORTAVA_LAB/bootstrap/bin/python" -m pip install uv==0.13.8
UV_PYTHON_INSTALL_DIR="$PORTAVA_LAB/python" "$PORTAVA_LAB/bootstrap/bin/uv" venv --python 3.12.16 "$PORTAVA_LAB/runtime"
"$PORTAVA_LAB/bootstrap/bin/uv" pip install --python "$PORTAVA_LAB/runtime/bin/python" -r tools/local-inference-lab/requirements-media.macos-arm64-py312.txt
python3 -B tools/local-inference-lab/prepare_models.py --model vision --root "$PORTAVA_LAB/models"
python3 -B tools/local-inference-lab/prepare_models.py --model captions --root "$PORTAVA_LAB/models"
python3 -B tools/local-inference-lab/prepare_models.py --model text --root "$PORTAVA_LAB/models"
```

Create `text-runtime` separately with the text package snapshot. To match the measured Metal build exactly, install the official wheel identified by `mlx-metal-wheel.json`, verifying its hash first. Keeping environments separate avoids changing the media worker's Transformers/PyTorch dependencies.

Fixture sources and hashes are in `jfk-source.json` and `coffee-source.json`; download them into `$PORTAVA_LAB/fixtures` and verify hashes. The three synthetic phrases are recorded in `benchmark.py`; use installed macOS voices Samantha, Paulina and Linh at rate 170, then `afconvert -f WAVE -d LEI16@16000 -c 1` to produce `english.wav`, `spanish.wav` and `vietnamese.wav`. Verify nonzero duration: a restricted `say` process initially returned empty audio despite exiting successfully. The caption benchmark creates its own eight-second silence fixture.

```sh
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  "$PORTAVA_LAB/runtime/bin/python" -B tools/local-inference-lab/benchmark.py \
  --kind vision --models "$PORTAVA_LAB/models" --fixtures "$PORTAVA_LAB/fixtures" --output "$PORTAVA_LAB/vision-result.json"

/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  "$PORTAVA_LAB/runtime/bin/python" -B tools/local-inference-lab/probe_caption_metal.py \
  --models "$PORTAVA_LAB/models" --fixtures "$PORTAVA_LAB/fixtures" --output "$PORTAVA_LAB/captions-metal-result.json"

/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  "$PORTAVA_LAB/text-runtime/bin/python" -B tools/local-inference-lab/probe_text.py \
  --model "$PORTAVA_LAB/models/text" --output "$PORTAVA_LAB/text-result.json"
```

The CPU caption experiment is `benchmark.py --kind captions` with the same arguments. It stops on a worker failure/180-second timeout and checkpoints results; do not discard failed cases. The Metal caption experiment is intentionally separate and experimental. `probe_text.py` uses four authored test prompts and reads the existing writing system rules from source. It caps output, runtime and MLX memory; it does not serve an HTTP endpoint or alter application models.

## Evidence and validation

Raw observed reports are in `results/`. Each explicitly says `eligibleForReplacement: false`. The CPU report is labeled as recovered from its completed-case/timeout log because the initial harness terminated before writing a final report; checkpoint handling has since been added.

- Eight model-provisioning/PCM/abstention/metric unit tests pass without downloading or loading any model.
- Thirteen caption pipeline regression tests pass.
- Eight provider-parity checker regression tests pass.
- Existing provider choices and production feature flags are unchanged.

Next qualification needs a representative held-out dataset, a real paid baseline, blind review, noise/music/quiet-speech and timing tests, meaningful image positives, prompt-injection and intent-preservation coverage, runtime tuning and sustained load/failure tests. Follow `docs/ops/provider-replacement-policy-20261113.md`; local feasibility is not a substitute for those gates.

Primary sources: [faster-whisper](https://github.com/SYSTRAN/faster-whisper), [Whisper Turbo conversion](https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo), [SigLIP](https://huggingface.co/google/siglip-base-patch16-224), [MLX LM](https://github.com/ml-explore/mlx-lm), [Qwen conversion](https://huggingface.co/mlx-community/Qwen3-4B-Instruct-2507-4bit), [original Qwen model](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507), [public speech test source](https://github.com/ggml-org/whisper.cpp/tree/master/samples), [public image test source](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.coffee).
