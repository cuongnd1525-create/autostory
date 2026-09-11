"""Persistent JSON-lines worker for Kokoro TTS."""

import argparse
import json
import logging
import os
import sys
import traceback

import numpy as np
import soundfile as sf
from kokoro import KPipeline


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def create_pipeline(lang_code, model, device):
    kwargs = {"lang_code": lang_code}
    if model:
        kwargs["repo_id"] = model
    if device:
        kwargs["device"] = device
    try:
        return KPipeline(**kwargs)
    except TypeError:
        kwargs.pop("device", None)
        try:
            return KPipeline(**kwargs)
        except TypeError:
            kwargs.pop("repo_id", None)
            return KPipeline(**kwargs)


def main():
    parser = argparse.ArgumentParser(description="Persistent Kokoro TTS worker")
    parser.add_argument("--model", default="hexgrad/Kokoro-82M")
    parser.add_argument("--device", default="")
    args = parser.parse_args()

    logging.basicConfig(
        format="%(asctime)s %(levelname)s [kokoro_worker] %(message)s",
        level=logging.INFO,
        force=True,
    )
    pipelines = {}
    emit({"type": "ready", "model": args.model, "device": args.device or "auto"})

    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            if request.get("type") == "shutdown":
                break

            request_id = request.get("id")
            text = str(request.get("text") or "").strip()
            output_path = os.path.abspath(str(request.get("outputPath") or ""))
            voice = str(request.get("voice") or "af_heart").strip()
            lang_code = str(request.get("langCode") or "a").strip()
            speed = float(request.get("speed") or 1.0)
            if not text:
                raise ValueError("Kokoro text is empty.")
            if not output_path:
                raise ValueError("Kokoro output path is empty.")

            if lang_code not in pipelines:
                logging.info("Loading Kokoro pipeline for language %s", lang_code)
                pipelines[lang_code] = create_pipeline(lang_code, args.model, args.device)

            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            chunks = []
            for _, _, audio in pipelines[lang_code](
                text,
                voice=voice,
                speed=max(0.5, min(2.0, speed)),
                split_pattern=r"\n+",
            ):
                array = np.asarray(audio, dtype=np.float32).reshape(-1)
                if array.size:
                    chunks.append(array)
            if not chunks:
                raise RuntimeError("Kokoro returned no audio.")

            sf.write(output_path, np.concatenate(chunks), 24000)
            emit({
                "id": request_id,
                "ok": True,
                "outputPath": output_path,
                "sampleRate": 24000,
            })
        except Exception as error:
            logging.error("%s", traceback.format_exc())
            emit({
                "id": request.get("id") if isinstance(request, dict) else None,
                "ok": False,
                "error": str(error),
            })


if __name__ == "__main__":
    main()
