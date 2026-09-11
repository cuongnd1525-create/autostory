"""Persistent JSON-lines worker for local English to Vietnamese translation."""

import argparse
import json
import logging
import sys
import traceback

import torch
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(description="Persistent OPUS-MT translation worker")
    parser.add_argument("--model", default="Helsinki-NLP/opus-mt-en-vi")
    parser.add_argument("--device", default="")
    args = parser.parse_args()

    logging.basicConfig(
        format="%(asctime)s %(levelname)s [opus_translate_worker] %(message)s",
        level=logging.INFO,
        force=True,
    )
    device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    logging.info("Loading tokenizer %s", args.model)
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    logging.info("Loading translation model %s on %s", args.model, device)
    model = AutoModelForSeq2SeqLM.from_pretrained(args.model)
    model.to(device)
    model.eval()
    emit({"type": "ready", "model": args.model, "device": device})

    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            if request.get("type") == "shutdown":
                break
            request_id = request.get("id")
            items = request.get("segments") or []
            batch_size = max(1, min(16, int(request.get("batchSize") or 8)))
            results = []
            for offset in range(0, len(items), batch_size):
                batch = items[offset:offset + batch_size]
                source_texts = [
                    ">>vie<< " + str(item.get("text") or "").strip()
                    for item in batch
                ]
                encoded = tokenizer(
                    source_texts,
                    return_tensors="pt",
                    padding=True,
                    truncation=True,
                    max_length=512,
                )
                encoded = {key: value.to(device) for key, value in encoded.items()}
                with torch.inference_mode():
                    generated = model.generate(
                        **encoded,
                        max_new_tokens=256,
                        num_beams=4,
                        early_stopping=True,
                    )
                translations = tokenizer.batch_decode(generated, skip_special_tokens=True)
                for item, translated in zip(batch, translations):
                    results.append({
                        "id": item.get("id"),
                        "text": translated.strip(),
                    })
            emit({"id": request_id, "ok": True, "segments": results})
        except Exception as error:
            logging.error("%s", traceback.format_exc())
            emit({
                "id": request.get("id") if isinstance(request, dict) else None,
                "ok": False,
                "error": str(error),
            })


if __name__ == "__main__":
    main()
