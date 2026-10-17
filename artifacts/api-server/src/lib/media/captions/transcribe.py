import argparse
import json
import os
import sys


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
    from faster_whisper import WhisperModel
    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=2, num_workers=1, local_files_only=True)
    segments, info = model.transcribe(args.audio, language=None if args.language == "auto" else args.language, task="transcribe", beam_size=1, vad_filter=False, condition_on_previous_text=False)
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
