const crypto = require('crypto');

class MediaIndexer {
  static hash(start, end) {
    return crypto.createHash('sha256').update(`${start.toFixed(3)}-${end.toFixed(3)}`).digest('hex').slice(0, 8);
  }

  static index(duration, cues = []) {
    const chunks = [];
    if (!cues || !cues.length) {
      for (let i = 0; i < duration; i += 5) {
        const start = i;
        const end = Math.min(i + 5, duration);
        chunks.push({ id: `c_${this.hash(start, end)}`, sourceStartSec: start, sourceEndSec: end, type: 'fixed' });
      }
      return chunks;
    }

    let start = 0;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      if (cue.startSec - start > 1.5 || i === cues.length - 1) {
        const end = cue.endSec;
        chunks.push({ id: `c_${this.hash(start, end)}`, sourceStartSec: start, sourceEndSec: end, text: cue.text, type: 'semantic' });
        start = end;
      }
    }
    return chunks;
  }
}

module.exports = MediaIndexer;
