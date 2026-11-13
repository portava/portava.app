import argparse
import json
import os
import sys
import wave


def read_pcm_wav(path):
    # The parent already extracts bounded mono, 16 kHz PCM. Do not decode it a
    # second time through PyAV: newer PyAV versions removed metadata_errors,
    # which faster-whisper's generic file loader still passes to av.open.
    if os.path.getsize(path) > 30 * 1024 * 1024:
        raise ValueError("audio_byte_budget")
    with wave.open(path, "rb") as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, 16000, "NONE"):
            raise ValueError("normalized_pcm_required")
        frames = audio.getnframes()
        if not 0 < frames <= 16000 * 901:
            raise ValueError("audio_duration_budget")
        pcm = audio.readframes(frames)
        if len(pcm) != frames * 2:
            raise ValueError("truncated_pcm")
        return pcm


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--language", default="auto")
    args = parser.parse_args()
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    if not os.path.isdir(args.model) or not os.path.isfile(args.audio):
        raise ValueError("local_inputs_required")
    pcm = read_pcm_wav(args.audio)
    # Exact digital silence contains no speech. Avoid both model loading and
    # Whisper's known tendency to invent a closing phrase on silent samples.
    # Do not apply an uncalibrated loudness threshold to quiet real speech.
    if not any(pcm):
        print(json.dumps({"language": "und", "languageProbability": 0, "segments": []}))
        return
    import numpy as np
    from faster_whisper import WhisperModel
    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    del pcm
    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=2, num_workers=1, local_files_only=True)
    segments, info = model.transcribe(audio, language=None if args.language == "auto" else args.language, task="transcribe", beam_size=1, vad_filter=False, condition_on_previous_text=False)
    collected = []
    text_bytes = 0
    for segment in segments:
        text_bytes += len(segment.text.encode("utf-8"))
        if len(collected) >= 2000 or text_bytes > 262144:
            raise ValueError("caption_output_budget")
        collected.append({"start": segment.start, "end": segment.end, "text": segment.text})
    print(json.dumps({"language": info.language, "languageProbability": info.language_probability, "segments": collected}, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("local_transcription_failed", file=sys.stderr)
        sys.exit(1)
