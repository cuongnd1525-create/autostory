import argparse
import json
import re
import subprocess
import sys


def merge_short_scenes(boundaries, duration, min_duration):
    points = [0.0]
    for value in boundaries:
        value = max(0.0, min(float(duration), float(value)))
        if value - points[-1] >= min_duration:
            points.append(value)
    if duration - points[-1] < min_duration and len(points) > 1:
        points[-1] = float(duration)
    elif duration > points[-1]:
        points.append(float(duration))

    scenes = []
    for index in range(len(points) - 1):
        start = points[index]
        end = points[index + 1]
        if end - start >= 0.35:
            scenes.append(
                {
                    "sceneId": f"scene_{index + 1:04d}",
                    "startSec": round(start, 3),
                    "endSec": round(end, 3),
                    "duration": round(end - start, 3),
                }
            )
    return scenes


def detect_with_pyscenedetect(video_path, duration, threshold, min_duration):
    from scenedetect import ContentDetector, detect

    scene_list = detect(video_path, ContentDetector(threshold=threshold))
    boundaries = []
    for start_time, end_time in scene_list:
        start = float(start_time.get_seconds())
        end = float(end_time.get_seconds())
        if start > 0:
            boundaries.append(start)
        if end < duration:
            boundaries.append(end)
    return merge_short_scenes(sorted(set(boundaries)), duration, min_duration)


def detect_with_ffmpeg(video_path, duration, ffmpeg_path, threshold, min_duration):
    command = [
        ffmpeg_path,
        "-hide_banner",
        "-i",
        video_path,
        "-vf",
        f"select='gt(scene,{threshold})',showinfo",
        "-f",
        "null",
        "-",
    ]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    text = (result.stdout or "") + "\n" + (result.stderr or "")
    boundaries = []
    for match in re.finditer(r"pts_time:([0-9.]+)", text):
        boundaries.append(float(match.group(1)))
    return merge_short_scenes(sorted(set(boundaries)), duration, min_duration)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--duration", type=float, required=True)
    parser.add_argument("--threshold", type=float, default=27.0)
    parser.add_argument("--ffmpeg-threshold", type=float, default=0.32)
    parser.add_argument("--min-duration", type=float, default=1.0)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()

    provider = "pyscenedetect"
    try:
        scenes = detect_with_pyscenedetect(args.video, args.duration, args.threshold, args.min_duration)
    except Exception as error:
        provider = "ffmpeg_scene_fallback"
        try:
            scenes = detect_with_ffmpeg(
                args.video,
                args.duration,
                args.ffmpeg,
                args.ffmpeg_threshold,
                args.min_duration,
            )
        except Exception as fallback_error:
            print(json.dumps({"provider": "failed", "error": str(fallback_error), "scenes": []}))
            return 0

    if not scenes:
        scenes = merge_short_scenes([], args.duration, args.min_duration)
    print(json.dumps({"provider": provider, "scenes": scenes}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
