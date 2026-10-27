"use strict";

// Live 2026-10-21: renderer OOM (exit 0xE0000008) during draft render with
// ~180 eager <video> scene previews on a 1080p60 AV1 source.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createScenePreviewManager } = require("../src/scenePreviewManager");

function fakeVideo({ src = "file:///source.mp4", start = 0, collapsed = false } = {}) {
  const attrs = {};
  const video = {
    isConnected: true, dataset: { src, startSec: String(start) }, currentTime: 0, preload: "none", loads: 0, pauses: 0,
    getAttribute: (name) => attrs[name] ?? null,
    setAttribute: (name, value) => { attrs[name] = value; },
    removeAttribute: (name) => { delete attrs[name]; },
    load() { this.loads += 1; },
    pause() { this.pauses += 1; },
    addEventListener() {},
    closest: (selector) => (collapsed && selector === ".segment-scene-preview.collapsed" ? {} : null)
  };
  return video;
}

class FakeObserver {
  constructor(callback) { this.callback = callback; this.targets = []; FakeObserver.last = this; }
  observe(target) { this.targets.push(target); }
  disconnect() { this.targets = []; }
  fire(targets, isIntersecting) { this.callback(targets.map((target) => ({ target, isIntersecting }))); }
}

(() => {
  const manager = createScenePreviewManager({ maxLive: 8, IntersectionObserverImpl: FakeObserver });
  // 20 segments x (1 main + 7 choices) + 20 timeline clips = 180 previews; choices inside collapsed pickers.
  const mains = Array.from({ length: 20 }, (_, i) => fakeVideo({ start: i * 10 }));
  const choices = Array.from({ length: 140 }, (_, i) => fakeVideo({ start: i, collapsed: true }));
  const timeline = Array.from({ length: 20 }, (_, i) => fakeVideo({ start: i * 5 }));
  const all = [...mains, ...choices, ...timeline];
  const doc = { querySelectorAll: (selector) => (selector === "video[data-scene-preview]" ? all : []) };
  manager.hydrate(doc);
  assert.strictEqual(FakeObserver.last.targets.length, 180, "every preview observed");
  assert(all.every((video) => !video.getAttribute("src")), "no preview loads before it is visible");

  FakeObserver.last.fire(all, true); // worst case: everything reported visible at once
  assert.strictEqual(manager.liveCount(), 8, "at most 8 live media players");
  assert.strictEqual(all.filter((video) => video.getAttribute("src")).length, 8);
  assert(choices.every((video) => !video.getAttribute("src")), "collapsed scene pickers never get a decoder");
  assert.strictEqual(timeline.at(-1).getAttribute("src"), "file:///source.mp4", "newest visible kept, oldest evicted");
  assert(mains[0].loads >= 1 && !mains[0].getAttribute("src"), "evicted preview released with load()");

  // Leaving the viewport releases it.
  FakeObserver.last.fire([timeline.at(-1)], false);
  assert.strictEqual(timeline.at(-1).getAttribute("src"), null);
  assert.strictEqual(manager.liveCount(), 7);

  // Re-render: old elements detached -> released at hydrate, before any new one loads.
  const stillLive = all.filter((video) => video.getAttribute("src"));
  stillLive.forEach((video) => { video.isConnected = false; });
  manager.hydrate({ querySelectorAll: () => [] });
  assert.strictEqual(manager.liveCount(), 0);
  assert(stillLive.every((video) => !video.getAttribute("src") && video.loads >= 1));

  // No IntersectionObserver available -> previews stay unloaded (never eager).
  const fallback = createScenePreviewManager({ IntersectionObserverImpl: null });
  const lone = fakeVideo();
  fallback.hydrate({ querySelectorAll: () => [lone] });
  assert.strictEqual(lone.getAttribute("src"), null);
})();

(() => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
  const eager = renderer.match(/<video[^>]*data-scene-preview[^>]*\ssrc=/g) || [];
  assert.deepStrictEqual(eager, [], "scene preview templates must use data-src, not src");
  assert.strictEqual((renderer.match(/data-scene-preview data-start-sec="[^"]*" data-src=/g) || []).length, 4);
  assert(html.indexOf("scenePreviewManager.js") > 0 && html.indexOf("scenePreviewManager.js") < html.indexOf("renderer.js"), "manager loads before renderer.js");
})();

console.log("scenePreviewManager tests passed (lazy, capped at 8, collapsed pickers never decoded, released on scroll/re-render)");
