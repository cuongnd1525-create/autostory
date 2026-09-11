"""Persistent JSON-lines worker for OmniVoice inference."""

import argparse
import json
import logging
import os
import sys
import traceback

import soundfile as sf
import torch

from omnivoice.models.omnivoice import OmniVoice


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def best_device():
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def optional_float(value):
    if value is None or value == "":
        return None
    return float(value)


def main():
    parser = argparse.ArgumentParser(description="Persistent OmniVoice inference worker")
    parser.add_argument("--model", default="k2-fsa/OmniVoice")
    parser.add_argument("--device", default="")
    args = parser.parse_args()

    logging.basicConfig(
        format="%(asctime)s %(levelname)s [omnivoice_worker] %(message)s",
        level=logging.INFO,
        force=True,
    )
    device = args.device or best_device()
    logging.info("Loading model %s on %s", args.model, device)
    model = OmniVoice.from_pretrained(
        args.model,
        device_map=device,
        dtype=torch.float16,
    )
    emit({
        "type": "ready",
        "pid": os.getpid(),
        "model": args.model,
        "device": device,
        "samplingRate": model.sampling_rate,
    })

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request_id = ""
        try:
            request = json.loads(line)
            request_id = str(request.get("id") or "")
            if request.get("type") == "shutdown":
                emit({"type": "shutdown", "ok": True, "pid": os.getpid()})
                return

            output_path = str(request["outputPath"])
            os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
            audios = model.generate(
                text=str(request.get("text") or ""),
                language=request.get("language") or None,
                ref_audio=request.get("refAudio") or None,
                ref_text=request.get("refText") or None,
                instruct=request.get("instruct") or None,
                duration=optional_float(request.get("durationSec")),
                num_step=int(request.get("numStep") or 8),
                guidance_scale=float(request.get("guidanceScale") or 2.0),
                speed=float(request.get("speed") or 1.0),
                t_shift=float(request.get("tShift") or 0.1),
                denoise=request.get("denoise", True) is not False,
                postprocess_output=request.get("postprocessOutput", True) is not False,
                layer_penalty_factor=float(request.get("layerPenaltyFactor") or 5.0),
                position_temperature=float(request.get("positionTemperature") or 5.0),
                class_temperature=float(request.get("classTemperature") or 0.0),
            )
            sf.write(output_path, audios[0], model.sampling_rate)
            emit({
                "id": request_id,
                "ok": True,
                "pid": os.getpid(),
                "outputPath": output_path,
                "sampleCount": int(len(audios[0])),
                "samplingRate": int(model.sampling_rate),
            })
        except Exception as error:
            logging.error("Request %s failed:\n%s", request_id, traceback.format_exc())
            emit({
                "id": request_id,
                "ok": False,
                "pid": os.getpid(),
                "error": str(error),
            })


if __name__ == "__main__":
    main()
