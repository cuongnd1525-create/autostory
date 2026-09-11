import argparse
import json
import math
import os

import soundfile as sf
import torch
import nemo.collections.asr as nemo_asr


def timestamp(seconds):
    total_ms = max(0, int(round(float(seconds or 0) * 1000)))
    hours, remainder = divmod(total_ms, 3600000)
    minutes, remainder = divmod(remainder, 60000)
    secs, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{milliseconds:03d}"


def write_srt(output_path, segments):
    temp_path = f"{output_path}.tmp"
    with open(temp_path, "w", encoding="utf-8") as handle:
        for index, item in enumerate(segments, start=1):
            handle.write(
                f"{index}\n{timestamp(item['start'])} --> {timestamp(item['end'])}\n"
                f"{item['text']}\n\n"
            )
    os.replace(temp_path, output_path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="nvidia/parakeet-tdt-0.6b-v3")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--chunk-sec", type=int, default=240)
    parser.add_argument("--cache-dir", required=True)
    args = parser.parse_args()

    audio, sample_rate = sf.read(args.audio, dtype="float32", always_2d=False)
    if getattr(audio, "ndim", 1) > 1:
        audio = audio.mean(axis=1)
    chunk_samples = max(sample_rate * 30, int(args.chunk_sec * sample_rate))
    chunk_count = max(1, int(math.ceil(len(audio) / chunk_samples)))
    os.makedirs(args.cache_dir, exist_ok=True)

    model = nemo_asr.models.ASRModel.from_pretrained(model_name=args.model)
    if args.device == "cuda" and torch.cuda.is_available():
        model = model.cuda()
    else:
        model = model.cpu()
    try:
        model.change_attention_model(
            self_attention_model="rel_pos_local_attn",
            att_context_size=[256, 256]
        )
    except Exception:
        pass

    all_segments = []
    for chunk_index in range(chunk_count):
        start_sample = chunk_index * chunk_samples
        end_sample = min(len(audio), start_sample + chunk_samples)
        offset_sec = start_sample / sample_rate
        cache_path = os.path.join(args.cache_dir, f"chunk-{chunk_index:04d}.json")
        try:
            with open(cache_path, "r", encoding="utf-8") as handle:
                chunk_segments = json.load(handle)
        except (OSError, ValueError):
            chunk_audio_path = os.path.join(args.cache_dir, f"chunk-{chunk_index:04d}.wav")
            sf.write(chunk_audio_path, audio[start_sample:end_sample], sample_rate)
            output = model.transcribe([chunk_audio_path], timestamps=True)
            hypothesis = output[0]
            segment_timestamps = getattr(hypothesis, "timestamp", {}).get("segment", [])
            chunk_segments = []
            for item in segment_timestamps:
                text = " ".join(str(item.get("segment", "")).strip().split())
                if text:
                    chunk_segments.append({
                        "start": round(offset_sec + float(item.get("start", 0)), 3),
                        "end": round(offset_sec + float(item.get("end", 0)), 3),
                        "text": text
                    })
            if not chunk_segments:
                text = " ".join(str(getattr(hypothesis, "text", hypothesis)).strip().split())
                if text:
                    chunk_segments.append({
                        "start": round(offset_sec, 3),
                        "end": round(end_sample / sample_rate, 3),
                        "text": text
                    })
            with open(f"{cache_path}.tmp", "w", encoding="utf-8") as handle:
                json.dump(chunk_segments, handle, ensure_ascii=False)
            os.replace(f"{cache_path}.tmp", cache_path)
        all_segments.extend(chunk_segments)
        write_srt(args.output, all_segments)
        print(json.dumps({
            "event": "chunk",
            "index": chunk_index + 1,
            "total": chunk_count
        }), flush=True)

    print(json.dumps({
        "event": "done",
        "provider": "nvidia_parakeet",
        "model": args.model,
        "device": args.device,
        "segments": len(all_segments),
        "chunks": chunk_count
    }), flush=True)


if __name__ == "__main__":
    main()
