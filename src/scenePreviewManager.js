// Scene preview <video> thumbnails: lazy, capped, released.
//
// Every <video> that has a src owns a Chromium media player and decoder. Live
// 2026-10-21: the Studio rendered ~180 preview videos (20 segments x (1 main +
// up to 7 scene choices) + timeline clips, including the ones inside COLLAPSED
// scene pickers) all pointing at a 1920x1080 60 fps AV1 source. During the
// draft render the renderer died with reason "oom" (exit 0xE0000008, see
// %APPDATA%\cineviral-studio\logs\renderer-crashes.log) and the window reloaded
// to step 1.
//
// Previews now carry data-src only. A src is attached while the element is
// visible (IntersectionObserver), never inside a collapsed picker, at most
// maxLive at a time (oldest evicted), and released (src removed + load()) when
// it leaves the viewport or the list is re-rendered.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ScenePreviewManager = api;
})(typeof self !== "undefined" ? self : this, function () {
  function createScenePreviewManager({ maxLive = 8, rootMargin = "120px", IntersectionObserverImpl = (typeof IntersectionObserver === "function" ? IntersectionObserver : null) } = {}) {
    const live = new Set();
    let observer = null;

    function release(video) {
      live.delete(video);
      if (!video || !video.getAttribute || !video.getAttribute("src")) return;
      try { video.pause(); } catch (_error) {}
      video.removeAttribute("src");
      try { video.load(); } catch (_error) {}
    }

    function attach(video) {
      if (!video || !video.isConnected || video.getAttribute("src") || !video.dataset || !video.dataset.src) return false;
      if (video.closest && video.closest(".segment-scene-preview.collapsed")) return false;
      for (const item of [...live]) if (!item.isConnected) release(item);
      while (live.size >= maxLive) release(live.values().next().value);
      const start = Number(video.dataset.startSec || 0);
      const seek = () => {
        try {
          if (Number.isFinite(start) && Math.abs((video.currentTime || 0) - start) > 0.25) video.currentTime = Math.max(0, start);
        } catch (_error) {
          // Some codecs delay seekability until more metadata is available.
        }
      };
      video.addEventListener("loadedmetadata", seek, { once: true });
      video.addEventListener("seeked", () => { try { video.pause(); } catch (_error) {} }, { once: true });
      video.preload = "metadata";
      video.setAttribute("src", video.dataset.src);
      live.add(video);
      return true;
    }

    /** Call after every (re)render of a container that holds video[data-scene-preview]. */
    function hydrate(doc) {
      for (const item of [...live]) if (!item.isConnected) release(item);
      if (observer) observer.disconnect();
      observer = IntersectionObserverImpl
        ? new IntersectionObserverImpl((entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) attach(entry.target);
            else release(entry.target);
          }
        }, { rootMargin })
        : null;
      if (!observer) return;
      for (const video of doc.querySelectorAll("video[data-scene-preview]")) observer.observe(video);
    }

    return { hydrate, attach, release, liveCount: () => live.size };
  }
  return { createScenePreviewManager };
});
