import argparse
import json
import math
import os
import re
import shlex
import subprocess
import sys
import tempfile


def parse_timecode(value):
    value = value.strip().replace(",", ".")
    parts = value.split(":")
    if len(parts) != 3:
        return 0.0
    hours, minutes, seconds = parts
    return float(hours) * 3600 + float(minutes) * 60 + float(seconds)


def format_time(seconds):
    seconds = max(0.0, float(seconds or 0.0))
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = seconds % 60
    return f"{hours:02d}:{minutes:02d}:{secs:06.3f}"


def read_srt(path):
    if not path or not os.path.exists(path):
        return []
    raw = open(path, "r", encoding="utf-8-sig", errors="ignore").read()
    blocks = re.split(r"\n\s*\n", raw.strip())
    segments = []
    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        timing_index = next((index for index, line in enumerate(lines) if "-->" in line), -1)
        if timing_index < 0:
            continue
        start_raw, end_raw = [item.strip() for item in lines[timing_index].split("-->", 1)]
        text = " ".join(lines[timing_index + 1 :])
        if not text:
            continue
        segments.append(
            {
                "startSec": parse_timecode(start_raw),
                "endSec": parse_timecode(end_raw),
                "text": re.sub(r"<[^>]+>", "", text).strip(),
            }
        )
    return segments


def overlap(a_start, a_end, b_start, b_end):
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def transcript_for_scene(scene, srt_segments):
    start = float(scene.get("startSec", 0.0))
    end = float(scene.get("endSec", start))
    chosen = []
    for segment in srt_segments:
        if overlap(start, end, segment["startSec"], segment["endSec"]) > 0.05:
            chosen.append(segment["text"])
    return " ".join(chosen).strip()


def classify(value, low, high):
    if value >= high:
        return "HIGH"
    if value >= low:
        return "MEDIUM"
    return "LOW"


def energy_from_text(text):
    lowered = text.lower()
    loud_words = [
        "run",
        "chay",
        "chạy",
        "mau",
        "help",
        "danger",
        "kill",
        "monster",
        "no!",
        "stop",
        "scream",
        "boom",
    ]
    score = text.count("!") * 0.35 + sum(0.25 for word in loud_words if word in lowered)
    return classify(score, 0.25, 0.75)


def tags_from_text(text):
    lowered = text.lower()
    keyword_map = {
        "monster": ["monster", "creature", "dragon", "predator", "beast", "quai", "rồng"],
        "forest": ["forest", "tree", "jungle", "woods", "rừng"],
        "running person": ["run", "running", "chase", "chạy", "đuổi"],
        "fight": ["fight", "attack", "kill", "đánh", "tấn công", "giết"],
        "danger": ["danger", "poison", "trap", "nguy hiểm", "độc"],
        "explosion": ["explosion", "explode", "boom", "nổ"],
        "crying": ["cry", "tears", "khóc"],
        "vehicle": ["car", "truck", "ship", "train", "xe", "tàu"],
        "weapon": ["gun", "knife", "sword", "weapon", "súng", "dao", "kiếm"],
    }
    tags = []
    for tag, needles in keyword_map.items():
        if any(needle in lowered for needle in needles):
            tags.append(tag)
    return tags[:6]


def parse_external_tags(text):
    text = (text or "").strip()
    if not text:
        return []
    try:
        payload = json.loads(text)
        if isinstance(payload, dict):
            tags = payload.get("tags") or payload.get("labels") or payload.get("objects") or []
            caption = payload.get("caption") or payload.get("text") or ""
            if isinstance(tags, list):
                values = [str(item.get("label", item)) if isinstance(item, dict) else str(item) for item in tags]
            else:
                values = []
            if caption:
                values.extend(re.split(r"[,.;\n]", str(caption)))
            return [value.strip().lower() for value in values if value and value.strip()][:10]
        if isinstance(payload, list):
            return [str(item).strip().lower() for item in payload if str(item).strip()][:10]
    except Exception:
        pass
    return [part.strip().lower() for part in re.split(r"[,;\n]", text) if part.strip()][:10]


def run_external_tagger(command, image_path):
    if not command:
        return []
    try:
        args = shlex.split(command)
        if "{image}" in args:
            args = [image_path if part == "{image}" else part for part in args]
        else:
            args.append(image_path)
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=45)
        if result.returncode != 0:
            return []
        return parse_external_tags(result.stdout)
    except Exception:
        return []


def smooth_points(points):
    if not points:
        return []
    smoothed = []
    previous_x = points[0]["subject_x"]
    previous_y = points[0]["subject_y"]
    for point in points:
        x = previous_x * 0.65 + point["subject_x"] * 0.35
        y = previous_y * 0.65 + point["subject_y"] * 0.35
        updated = dict(point)
        updated["subject_x"] = round(max(0.05, min(0.95, x)), 3)
        updated["subject_y"] = round(max(0.08, min(0.92, y)), 3)
        smoothed.append(updated)
        previous_x = updated["subject_x"]
        previous_y = updated["subject_y"]
    return smoothed


def load_cv_detectors(cv2):
    face_detector = None
    try:
        cascade_path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
        face_detector = cv2.CascadeClassifier(cascade_path)
        if face_detector.empty():
            face_detector = None
    except Exception:
        face_detector = None

    person_detector = None
    try:
        person_detector = cv2.HOGDescriptor()
        person_detector.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
    except Exception:
        person_detector = None
    return face_detector, person_detector


def detect_subject(frame, gray, face_detector, person_detector, cv2):
    height, width = gray.shape[:2]

    if face_detector is not None:
        faces = face_detector.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=4, minSize=(18, 18))
        if len(faces):
            x, y, w, h = sorted(faces, key=lambda rect: rect[2] * rect[3], reverse=True)[0]
            return {
                "subject_x": (x + w / 2) / width,
                "subject_y": (y + h / 2) / height,
                "confidence": min(0.92, 0.55 + (w * h) / max(1, width * height)),
                "source": "face",
                "tag": "face",
            }

    if person_detector is not None and width >= 120 and height >= 80:
        try:
            boxes, weights = person_detector.detectMultiScale(frame, winStride=(8, 8), padding=(8, 8), scale=1.05)
            if len(boxes):
                pairs = list(zip(boxes, weights if len(weights) else [0.4] * len(boxes)))
                box, weight = sorted(pairs, key=lambda item: item[0][2] * item[0][3] * float(item[1]), reverse=True)[0]
                x, y, w, h = box
                return {
                    "subject_x": (x + w / 2) / width,
                    "subject_y": (y + h / 2) / height,
                    "confidence": min(0.78, 0.42 + float(weight) * 0.08),
                    "source": "person",
                    "tag": "person",
                }
        except Exception:
            pass

    edges = cv2.Canny(gray, 60, 140)
    moments = cv2.moments(edges)
    if moments["m00"] > 1:
        return {
            "subject_x": float(moments["m10"] / moments["m00"] / width),
            "subject_y": float(moments["m01"] / moments["m00"] / height),
            "confidence": 0.34,
            "source": "edge_focus",
            "tag": "action subject",
        }
    return None


def evenly_sample_scenes(scenes, max_scenes):
    if not max_scenes or max_scenes <= 0 or len(scenes) <= max_scenes:
        return scenes, set(scene.get("sceneId") for scene in scenes)
    sampled = []
    keep_ids = set()
    for index in range(max_scenes):
        source_index = round(index * (len(scenes) - 1) / max(1, max_scenes - 1))
        scene = scenes[source_index]
        sampled.append(scene)
        keep_ids.add(scene.get("sceneId"))
    return sampled, keep_ids


def compute_visual_metrics(video_path, scenes, vision_tagger_command="", max_scenes=120, samples_per_scene=2):
    try:
        import cv2
        import numpy as np
    except Exception:
        return {}

    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        return {}

    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    face_detector, person_detector = load_cv_detectors(cv2)
    results = {}
    try:
      sampled_scenes, keep_ids = evenly_sample_scenes(scenes, max_scenes)
      for scene in sampled_scenes:
        scene_id = scene.get("sceneId")
        start = float(scene.get("startSec", 0.0))
        end = float(scene.get("endSec", start + 0.5))
        duration = max(0.3, end - start)
        sample_count = max(1, min(4, int(samples_per_scene or 2)))
        sample_times = [start + (duration * (index + 1) / (sample_count + 1)) for index in range(sample_count)]
        grays = []
        brightness = []
        focus_x_values = []
        focus_y_values = []
        crop_path = []
        detected_tags = set()
        external_tags = set()
        detector_sources = []
        keyframe_for_tagger = None
        middle_sample_index = len(sample_times) // 2
        for sample_index, second in enumerate(sample_times):
            capture.set(cv2.CAP_PROP_POS_FRAMES, int(max(0, second) * fps))
            ok, frame = capture.read()
            if not ok or frame is None:
                continue
            if sample_index == middle_sample_index:
                keyframe_for_tagger = frame
            small = cv2.resize(frame, (160, 90))
            gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
            grays.append(gray)
            brightness.append(float(gray.mean()))
            subject = detect_subject(small, gray, face_detector, person_detector, cv2)
            if subject:
                subject_x = max(0.05, min(0.95, float(subject["subject_x"])))
                subject_y = max(0.08, min(0.92, float(subject["subject_y"])))
                focus_x_values.append(subject_x)
                focus_y_values.append(subject_y)
                detected_tags.add(subject["tag"])
                detector_sources.append(subject["source"])
                crop_path.append(
                    {
                        "timeSec": round(max(0.0, second - start), 3),
                        "subject_x": round(subject_x, 3),
                        "subject_y": round(subject_y, 3),
                        "confidence": round(float(subject["confidence"]), 3),
                        "source": subject["source"],
                    }
                )

        deltas = []
        for index in range(1, len(grays)):
            deltas.append(float(np.mean(cv2.absdiff(grays[index - 1], grays[index]))))

        motion_score = sum(deltas) / len(deltas) if deltas else 0.0
        light_delta = (max(brightness) - min(brightness)) if brightness else 0.0
        focus_x = sum(focus_x_values) / len(focus_x_values) if focus_x_values else 0.5
        focus_y = sum(focus_y_values) / len(focus_y_values) if focus_y_values else 0.5
        average_confidence = (
            sum(point["confidence"] for point in crop_path) / len(crop_path)
            if crop_path
            else 0.0
        )
        dominant_source = max(set(detector_sources), key=detector_sources.count) if detector_sources else "center_fallback"
        if motion_score >= 11:
            detected_tags.add("fast motion")
        if light_delta >= 38:
            detected_tags.add("flash lighting")
        if brightness and sum(brightness) / len(brightness) < 45:
            detected_tags.add("dark scene")
        elif brightness and sum(brightness) / len(brightness) > 170:
            detected_tags.add("bright scene")
        if vision_tagger_command and keyframe_for_tagger is not None:
            try:
                with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as handle:
                    keyframe_path = handle.name
                cv2.imwrite(keyframe_path, keyframe_for_tagger)
                external_tags.update(run_external_tagger(vision_tagger_command, keyframe_path))
            finally:
                try:
                    os.remove(keyframe_path)
                except Exception:
                    pass
        results[scene_id] = {
            "motion_score": round(motion_score, 3),
            "motion_intensity": classify(motion_score, 4.5, 11.0),
            "light_change_score": round(light_delta, 3),
            "light_change": "FLASH" if light_delta >= 38 else "SHIFT" if light_delta >= 18 else "STABLE",
            "detected_visual_tags": sorted(detected_tags),
            "external_visual_tags": sorted(external_tags),
            "reframe": {
                "mode": "local_subject_track" if crop_path else "center_fallback",
                "subject_x": round(max(0.05, min(0.95, focus_x)), 3),
                "subject_y": round(max(0.08, min(0.92, focus_y)), 3),
                "confidence": round(max(0.0, min(0.95, average_confidence)), 3),
                "source": dominant_source,
                "cropPath": smooth_points(crop_path),
            },
        }
    finally:
        capture.release()
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--scenes", required=True)
    parser.add_argument("--srt", default="")
    parser.add_argument("--output", default="")
    parser.add_argument("--vision-tagger-command", default="")
    parser.add_argument("--max-scenes", type=int, default=120)
    parser.add_argument("--samples-per-scene", type=int, default=2)
    args = parser.parse_args()

    detected = json.load(open(args.scenes, "r", encoding="utf-8"))
    scenes = detected.get("scenes", []) if isinstance(detected, dict) else []
    srt_segments = read_srt(args.srt)
    visual = compute_visual_metrics(
        args.video,
        scenes,
        args.vision_tagger_command,
        max_scenes=args.max_scenes,
        samples_per_scene=args.samples_per_scene,
    )

    enriched = []
    for index, scene in enumerate(scenes):
        scene_id = scene.get("sceneId") or f"scene_{index + 1:04d}"
        start = float(scene.get("startSec", 0.0))
        end = float(scene.get("endSec", start + 0.5))
        transcript = transcript_for_scene(scene, srt_segments)
        visual_metrics = visual.get(scene_id, {})
        tags = tags_from_text(transcript)
        if visual_metrics.get("motion_intensity") == "HIGH" and "fast motion" not in tags:
            tags.append("fast motion")
        if visual_metrics.get("light_change") == "FLASH" and "flash lighting" not in tags:
            tags.append("flash lighting")
        for tag in visual_metrics.get("detected_visual_tags", []):
            if tag not in tags:
                tags.append(tag)
        for tag in visual_metrics.get("external_visual_tags", []):
            if tag not in tags:
                tags.append(tag)
        enriched.append(
            {
                "scene_id": scene_id,
                "sceneId": scene_id,
                "timestamp": f"{format_time(start)} -> {format_time(end)}",
                "startSec": round(start, 3),
                "endSec": round(end, 3),
                "duration_seconds": round(max(0.0, end - start), 3),
                "audio_transcript": transcript,
                "motion_intensity": visual_metrics.get("motion_intensity", "UNKNOWN"),
                "motion_score": visual_metrics.get("motion_score", 0),
                "audio_energy": energy_from_text(transcript),
                "light_change": visual_metrics.get("light_change", "UNKNOWN"),
                "light_change_score": visual_metrics.get("light_change_score", 0),
                "local_visual_tags": tags[:8],
                "reframe": visual_metrics.get(
                    "reframe",
                    {"mode": "center_fallback", "subject_x": 0.5, "subject_y": 0.5, "confidence": 0.0},
                ),
            }
        )

    output = {
        "provider": "local_scene_metadata_cv2_tagger" if visual and args.vision_tagger_command else "local_scene_metadata_cv2" if visual else "local_scene_metadata_fallback",
        "video": os.path.basename(args.video),
        "transcriptProvider": "srt" if srt_segments else "none",
        "sceneCount": len(enriched),
        "scenes": enriched,
    }
    text = json.dumps(output, ensure_ascii=True, indent=2)
    if args.output:
        open(args.output, "w", encoding="utf-8").write(text)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
