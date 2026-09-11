import argparse
import json
import math
import os

from faster_whisper import WhisperModel, decode_audio

try:
    from faster_whisper import BatchedInferencePipeline
except ImportError:
    BatchedInferencePipeline = None


SAMPLE_RATE = 16000


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


def write_words_json(output_path, segments):
    words_path = os.path.splitext(output_path)[0] + ".words.json"
    temp_path = f"{words_path}.tmp"
    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump({
            "artifactType": "word_timestamps",
            "schemaVersion": 1,
            "segments": segments
        }, handle, ensure_ascii=False)
    os.replace(temp_path, words_path)
    return words_path


def load_cached_chunk(cache_path):
    try:
        with open(cache_path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        return payload if isinstance(payload, list) else None
    except (OSError, ValueError):
        return None


def save_cached_chunk(cache_path, segments):
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    temp_path = f"{cache_path}.tmp"
    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump(segments, handle, ensure_ascii=False)
    os.replace(temp_path, cache_path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--language", default="auto")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--chunk-sec", type=int, default=240)
    parser.add_argument("--cache-dir", required=True)
    args = parser.parse_args()

    audio = decode_audio(args.audio, sampling_rate=SAMPLE_RATE)
    chunk_samples = max(SAMPLE_RATE * 30, int(args.chunk_sec * SAMPLE_RATE))
    chunk_count = max(1, int(math.ceil(len(audio) / chunk_samples)))
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    batched_model = None
    if BatchedInferencePipeline is not None and args.batch_size > 1:
        try:
            batched_model = BatchedInferencePipeline(model=model)
        except Exception:
            batched_model = None
    all_segments = []
    detected_language = ""

    os.makedirs(args.cache_dir, exist_ok=True)
    for chunk_index in range(chunk_count):
        start_sample = chunk_index * chunk_samples
        end_sample = min(len(audio), start_sample + chunk_samples)
        offset_sec = start_sample / SAMPLE_RATE
        cache_path = os.path.join(args.cache_dir, f"chunk-{chunk_index:04d}.json")
        cached = load_cached_chunk(cache_path)
        if cached is not None:
            all_segments.extend(cached)
            write_srt(args.output, all_segments)
            write_words_json(args.output, all_segments)
            print(json.dumps({
                "event": "chunk",
                "index": chunk_index + 1,
                "total": chunk_count,
                "cached": True
            }), flush=True)
            continue

        transcribe_options = {
            "language": None if args.language == "auto" else args.language,
            "vad_filter": True,
            "beam_size": 1,
            "condition_on_previous_text": False,
            "word_timestamps": True
        }
        if batched_model is not None:
            try:
                generated, info = batched_model.transcribe(
                    audio[start_sample:end_sample],
                    batch_size=args.batch_size,
                    **transcribe_options
                )
                generated = list(generated)
            except Exception as error:
                print(json.dumps({
                    "event": "batch_fallback",
                    "index": chunk_index + 1,
                    "reason": str(error)
                }), flush=True)
                batched_model = None
                generated, info = model.transcribe(
                    audio[start_sample:end_sample],
                    **transcribe_options
                )
                generated = list(generated)
        else:
            generated, info = model.transcribe(
                audio[start_sample:end_sample],
                **transcribe_options
            )
            generated = list(generated)
        detected_language = detected_language or str(getattr(info, "language", "") or "")
        chunk_segments = []
        for segment in generated:
            text = " ".join((segment.text or "").strip().split())
            if not text:
                continue
            chunk_segments.append({
                "start": round(offset_sec + float(segment.start), 3),
                "end": round(offset_sec + float(segment.end), 3),
                "text": text,
                "words": [
                    {
                        "word": str(getattr(word, "word", "") or "").strip(),
                        "start": round(offset_sec + float(getattr(word, "start", segment.start) or segment.start), 3),
                        "end": round(offset_sec + float(getattr(word, "end", segment.end) or segment.end), 3),
                        "probability": round(float(getattr(word, "probability", 0) or 0), 4)
                    }
                    for word in (getattr(segment, "words", None) or [])
                    if str(getattr(word, "word", "") or "").strip()
                ]
            })
        save_cached_chunk(cache_path, chunk_segments)
        all_segments.extend(chunk_segments)
        write_srt(args.output, all_segments)
        write_words_json(args.output, all_segments)
        print(json.dumps({
            "event": "chunk",
            "index": chunk_index + 1,
            "total": chunk_count,
            "cached": False
        }), flush=True)

    words_path = write_words_json(args.output, all_segments)
    print(json.dumps({
        "event": "done",
        "provider": "faster_whisper",
        "model": args.model,
        "device": args.device,
        "computeType": args.compute_type,
        "language": detected_language,
        "segments": len(all_segments),
        "chunks": chunk_count,
        "wordTimestampsPath": words_path,
        "batchSize": args.batch_size if batched_model is not None else 1
    }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
