#!/usr/bin/env python3
"""AutoStory v3 - Phase 2: lightweight non-speech audio event detector.

Purpose is EDITORIAL, not forensic: find moments worth cutting on -
loudness spikes (raised voice / impact / crash) and sudden silences - using
ffmpeg's ebur128 momentary loudness envelope plus silencedetect. No heavy ML
dependency. Optional YAMNet can be layered later behind the same JSON contract.

Output (stdout): JSON array of {type,startSec,endSec,peak}
  type   : loud_spike | raised_voice | sudden_silence
  peak   : 0..1 normalized intensity (1 = loudest)

Never fails hard: on any error prints [] and exits 0 so the JS caller degrades.
"""
import argparse
import json
import re
import subprocess
import sys


def lufs_to_unit(lufs):
    # Map momentary LUFS (~ -40 quiet .. 0 loud) to 0..1.
    try:
        v = (float(lufs) + 40.0) / 40.0
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, v))


def run_ebur128(ffmpeg, input_path):
    """Return list of (t, momentary_lufs) samples from ffmpeg ebur128."""
    cmd = [ffmpeg, "-nostats", "-i", input_path, "-af", "ebur128=metadata=1", "-f", "null", "-"]
    proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, universal_newlines=True)
    samples = []
    t = None
    # ffmpeg prints blocks like:  t: 1.2   ... M: -23.4  ...
    t_re = re.compile(r"t:\s*([0-9]+\.?[0-9]*)")
    m_re = re.compile(r"\bM:\s*(-?[0-9]+\.?[0-9]*)")
    for line in proc.stderr.splitlines():
        tm = t_re.search(line)
        if tm:
            t = float(tm.group(1))
        mm = m_re.search(line)
        if mm and t is not None:
            samples.append((t, float(mm.group(1))))
    return samples


def run_silencedetect(ffmpeg, input_path, noise_db=-35, min_sil=0.8):
    cmd = [ffmpeg, "-nostats", "-i", input_path, "-af",
           "silencedetect=noise=%ddB:d=%s" % (noise_db, min_sil), "-f", "null", "-"]
    proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, universal_newlines=True)
    events = []
    start = None
    for line in proc.stderr.splitlines():
        s = re.search(r"silence_start:\s*(-?[0-9.]+)", line)
        e = re.search(r"silence_end:\s*(-?[0-9.]+)", line)
        if s:
            start = float(s.group(1))
        elif e and start is not None:
            events.append((max(0.0, start), float(e.group(1))))
            start = None
    return events


def detect_spikes(samples):
    """Rolling-baseline spike detection over the loudness envelope."""
    if not samples:
        return []
    out = []
    window = []
    WIN = 30  # ~ last N momentary samples as baseline
    for (t, lufs) in samples:
        window.append(lufs)
        if len(window) > WIN:
            window.pop(0)
        baseline = sum(window) / len(window)
        # A spike is a momentary loudness well above the recent baseline.
        if lufs - baseline >= 6.0 and lufs > -30.0:
            peak = lufs_to_unit(lufs)
            kind = "loud_spike" if (lufs - baseline) >= 9.0 else "raised_voice"
            if out and t - out[-1]["endSec"] <= 0.6 and out[-1]["type"] == kind:
                out[-1]["endSec"] = round(t, 3)
                out[-1]["peak"] = max(out[-1]["peak"], round(peak, 3))
            else:
                out.append({"type": kind, "startSec": round(t, 3), "endSec": round(t + 0.3, 3), "peak": round(peak, 3)})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--duration", type=float, default=None)
    args = ap.parse_args()

    events = []
    try:
        samples = run_ebur128(args.ffmpeg, args.input)
        events.extend(detect_spikes(samples))
    except Exception:
        pass
    try:
        for (s, e) in run_silencedetect(args.ffmpeg, args.input):
            # A sudden silence after speech is a strong editorial beat.
            events.append({"type": "sudden_silence", "startSec": round(s, 3), "endSec": round(e, 3), "peak": 0.5})
    except Exception:
        pass

    events.sort(key=lambda x: x["startSec"])
    sys.stdout.write(json.dumps(events))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stdout.write("[]")
        sys.exit(0)
