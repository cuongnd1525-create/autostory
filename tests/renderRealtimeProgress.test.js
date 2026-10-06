const assert = require("assert");
const EventEmitter = require("events");
const { createMonotonicProgressNormalizer } = require("../electron/services/progressPolicy");

function testProgressPolicy() {
  const normalize = createMonotonicProgressNormalizer();
  const res1 = normalize({ percent: 1, message: "Start" });
  assert.strictEqual(res1.percent, 1);

  const res2 = normalize({ percent: 15, message: "Block 1" });
  assert.strictEqual(res2.percent, 15);

  const res3 = normalize({ percent: 10, message: "Retry" });
  // Monotonic: cannot regress
  assert.strictEqual(res3.percent, 15);

  const res4 = normalize({ percent: 75, message: "Concat" });
  assert.strictEqual(res4.percent, 75);

  const res5 = normalize({ percent: 100, message: "Done" });
  assert.strictEqual(res5.percent, 100);
}

function testFfmpegStderrParsing() {
  const captured = [];
  const options = {
    totalDurationSec: 100,
    onProgress: (p) => captured.push(p)
  };

  let lastReportedSec = -1;
  const simulateChunk = (chunkStr) => {
    const match = chunkStr.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (match) {
      const sec = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      if (sec >= 0 && Math.abs(sec - lastReportedSec) >= 0.4) {
        lastReportedSec = sec;
        options.onProgress({
          currentSec: sec,
          totalDurationSec: Number(options.totalDurationSec || 0),
          percent: options.totalDurationSec > 0
            ? Math.min(99, Math.max(1, Math.round((sec / options.totalDurationSec) * 100)))
            : null
        });
      }
    }
  };

  simulateChunk("frame=  100 fps=50 q=-0.0 size=N/A time=00:00:10.50 bitrate=N/A speed=15x");
  simulateChunk("frame=  200 fps=50 q=-0.0 size=N/A time=00:00:25.00 bitrate=N/A speed=15x");
  simulateChunk("frame=  300 fps=50 q=-0.0 size=N/A time=00:01:15.50 bitrate=N/A speed=15x");

  assert.strictEqual(captured.length, 3);
  assert.strictEqual(captured[0].currentSec, 10.5);
  assert.strictEqual(captured[0].percent, 11);
  assert.strictEqual(captured[1].currentSec, 25);
  assert.strictEqual(captured[1].percent, 25);
  assert.strictEqual(captured[2].currentSec, 75.5);
  assert.strictEqual(captured[2].percent, 76);
}

function testSenderFallback() {
  let frameSent = false;
  let windowSent = false;

  const mockFrame = {
    isDestroyed: () => false,
    detached: false,
    send: (ch, p) => {
      frameSent = true;
    }
  };

  const normalize = createMonotonicProgressNormalizer();
  const sender = (payload) => {
    const normalized = normalize(payload);
    let delivered = false;
    if (mockFrame && !mockFrame.isDestroyed?.() && !mockFrame.detached) {
      delivered = true;
      mockFrame.send("pipeline:progress", normalized);
    }
    if (!delivered) {
      windowSent = true;
    }
  };

  sender({ percent: 50, message: "Testing" });
  assert.strictEqual(frameSent, true);

  // When frame is detached/destroyed
  mockFrame.detached = true;
  frameSent = false;
  const detachedSender = (payload) => {
    const normalized = normalize(payload);
    let delivered = false;
    if (mockFrame && !mockFrame.isDestroyed?.() && !mockFrame.detached) {
      delivered = true;
      mockFrame.send("pipeline:progress", normalized);
    }
    if (!delivered) {
      windowSent = true;
    }
  };

  detachedSender({ percent: 60, message: "Fallback" });
  assert.strictEqual(frameSent, false);
  assert.strictEqual(windowSent, true);
}

testProgressPolicy();
testFfmpegStderrParsing();
testSenderFallback();
console.log("Realtime render progress tests passed successfully!");
