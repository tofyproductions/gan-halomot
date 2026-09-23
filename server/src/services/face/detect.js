const sharp = require('sharp');

/**
 * Finding faces — a JavaScript port of InsightFace's SCRFD post-processing.
 *
 * The network itself is the unmodified det_10g.onnx, so the arithmetic here
 * has to match what Python does bit for bit or the embeddings downstream drift
 * and every threshold in FACE_RECOGNITION_PLAN.md becomes meaningless. That is
 * what scripts/face-parity.test.js exists to prove.
 *
 * SCRFD is anchor-free: for each cell of each feature map it predicts how far
 * the four box edges are from the cell's centre, in stride units, plus five
 * landmarks the same way. Three feature maps at strides 8, 16 and 32 catch
 * large, medium and small faces; two anchors sit on every cell.
 */

const STRIDES = [8, 16, 32];
const ANCHORS_PER_CELL = 2;
const NMS_IOU = 0.4;

// Cached per (stride, width, height): the pixel centre of every anchor. These
// depend only on the input size, which never changes at runtime, so building
// them once turns the hottest loop in detection into two array reads.
const centreCache = new Map();

function anchorCentres(stride, w, h) {
  const key = `${stride}:${w}x${h}`;
  const hit = centreCache.get(key);
  if (hit) return hit;

  const cols = Math.ceil(w / stride);
  const rows = Math.ceil(h / stride);
  const centres = new Float32Array(rows * cols * ANCHORS_PER_CELL * 2);
  let i = 0;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      for (let a = 0; a < ANCHORS_PER_CELL; a += 1) {
        centres[i] = x * stride;
        centres[i + 1] = y * stride;
        i += 2;
      }
    }
  }
  centreCache.set(key, centres);
  return centres;
}

/**
 * Fit the photograph into the network's square input.
 *
 * Deliberately NOT a centred letterbox: InsightFace pastes the scaled image
 * into the top-left corner and leaves the rest black, and every coordinate it
 * produces is relative to that. Centring it would shift every box by half the
 * padding — faces would be found, and then drawn in the wrong place.
 */
async function preprocess(buffer, size) {
  const src = sharp(buffer, { failOn: 'none' }).rotate();   // honour EXIF; see photo.service
  const meta = await src.metadata();
  const w = meta.autoOrient?.width ?? meta.width;
  const h = meta.autoOrient?.height ?? meta.height;

  const scale = Math.min(size / w, size / h);
  const newW = Math.round(w * scale);
  const newH = Math.round(h * scale);

  const { data } = await src
    .resize(newW, newH, { fit: 'fill' })
    .extend({
      top: 0, left: 0,
      bottom: size - newH, right: size - newW,
      background: { r: 0, g: 0, b: 0 },
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // NCHW float, (pixel - 127.5) / 128. sharp hands back RGB, which is the
  // channel order the model was trained on — no swap needed here, unlike the
  // OpenCV path in Python which has to undo BGR.
  const plane = size * size;
  const blob = new Float32Array(3 * plane);
  for (let p = 0, j = 0; p < plane; p += 1, j += 3) {
    blob[p] = (data[j] - 127.5) / 128;
    blob[plane + p] = (data[j + 1] - 127.5) / 128;
    blob[2 * plane + p] = (data[j + 2] - 127.5) / 128;
  }

  return { blob, scale, width: w, height: h };
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1 + 1) * Math.max(0, y2 - y1 + 1);
  const areaA = (a[2] - a[0] + 1) * (a[3] - a[1] + 1);
  const areaB = (b[2] - b[0] + 1) * (b[3] - b[1] + 1);
  return inter / (areaA + areaB - inter);
}

/** Greedy non-maximum suppression: keep the best box, drop everything it overlaps. */
function nms(dets) {
  const kept = [];
  const order = [...dets].sort((p, q) => q.score - p.score);
  for (const cand of order) {
    if (!kept.some((k) => iou(cand.bbox, k.bbox) > NMS_IOU)) kept.push(cand);
  }
  return kept;
}

/**
 * Run the detector.
 *
 * `threshold` is the network's own confidence, NOT the identity threshold —
 * they are different numbers with different jobs and confusing them is easy.
 * Anything the caller keeps is filtered again in index.js at DET_SCORE_MIN,
 * which is where the ears and the doll from the feasibility test get dropped.
 */
async function detect(session, buffer, { size = 1024, threshold = 0.5 } = {}) {
  const ort = require('onnxruntime-node');
  const { blob, scale, width, height } = await preprocess(buffer, size);

  const out = await session.run({
    [session.inputNames[0]]: new ort.Tensor('float32', blob, [1, 3, size, size]),
  });
  const o = session.outputNames.map((n) => out[n]);

  // Nine outputs: scores for the three strides, then the box regressions, then
  // the landmark regressions — the order InsightFace relies on (fmc = 3).
  const dets = [];
  for (let s = 0; s < STRIDES.length; s += 1) {
    const stride = STRIDES[s];
    const scores = o[s].data;
    const boxes = o[s + 3].data;
    const kps = o[s + 6].data;
    const centres = anchorCentres(stride, size, size);

    for (let i = 0; i < scores.length; i += 1) {
      if (scores[i] < threshold) continue;
      const cx = centres[i * 2];
      const cy = centres[i * 2 + 1];
      const b = i * 4;

      // Predictions are distances from the centre, in stride units.
      const bbox = [
        (cx - boxes[b] * stride) / scale,
        (cy - boxes[b + 1] * stride) / scale,
        (cx + boxes[b + 2] * stride) / scale,
        (cy + boxes[b + 3] * stride) / scale,
      ];

      const k = i * 10;
      const points = [];
      for (let p = 0; p < 5; p += 1) {
        points.push([
          (cx + kps[k + p * 2] * stride) / scale,
          (cy + kps[k + p * 2 + 1] * stride) / scale,
        ]);
      }

      dets.push({ bbox, score: scores[i], kps: points });
    }
  }

  return { faces: nms(dets), width, height };
}

module.exports = { detect, preprocess };
