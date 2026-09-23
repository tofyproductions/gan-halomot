/**
 * Turning a face found anywhere in a photograph into the 112x112 crop the
 * recogniser was trained on.
 *
 * This step is not cosmetic, and skipping it is the usual reason a home-made
 * pipeline "sort of works". The recogniser has never seen a tilted head: every
 * face it learned from had its eyes on one particular row of pixels and its
 * mouth on another. So each face is rotated, scaled and shifted until its five
 * landmarks land on the canonical positions below. Without it, two photographs
 * of the same child at different angles embed as different people.
 */

// ArcFace's canonical landmark positions for a 112x112 crop: left eye, right
// eye, nose, left mouth corner, right mouth corner. These numbers are part of
// the trained model's contract, not a choice.
const REFERENCE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

const SIZE = 112;

/**
 * Least-squares similarity transform (rotation + uniform scale + translation)
 * taking the detected landmarks onto the canonical ones.
 *
 * Closed form rather than the SVD that scikit-image uses: for a similarity
 * with no reflection the two are the same answer, and five eye/nose/mouth
 * points are never degenerate enough for the difference to appear. Parity
 * against the Python pipeline is asserted in scripts/face-parity.test.js.
 */
function similarityTransform(points) {
  const n = points.length;
  let sx = 0; let sy = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += points[i][0]; sy += points[i][1];
    dx += REFERENCE[i][0]; dy += REFERENCE[i][1];
  }
  sx /= n; sy /= n; dx /= n; dy /= n;

  let a = 0; let b = 0; let norm = 0;
  for (let i = 0; i < n; i += 1) {
    const px = points[i][0] - sx;
    const py = points[i][1] - sy;
    const qx = REFERENCE[i][0] - dx;
    const qy = REFERENCE[i][1] - dy;
    a += px * qx + py * qy;      // aligned component -> scale * cos
    b += px * qy - py * qx;      // perpendicular    -> scale * sin
    norm += px * px + py * py;
  }
  const c = a / norm;
  const s = b / norm;

  return {
    c, s,
    tx: dx - (c * sx - s * sy),
    ty: dy - (s * sx + c * sy),
  };
}

/**
 * Warp with bilinear sampling.
 *
 * Walks the 112x112 output and asks where each of its pixels came from, which
 * is why the transform is inverted here: mapping forwards would leave holes
 * wherever the source is being magnified.
 */
function warp(rgb, width, height, t) {
  const det = t.c * t.c + t.s * t.s;
  const ic = t.c / det;
  const is = -t.s / det;
  const itx = -(ic * t.tx - is * t.ty);
  const ity = -(is * t.tx + ic * t.ty);

  const out = Buffer.allocUnsafe(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const fx = ic * x - is * y + itx;
      const fy = is * x + ic * y + ity;

      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const o = (y * SIZE + x) * 3;

      // A face at the very edge of the frame samples past it. Black is what
      // OpenCV's warpAffine uses by default, so this matches Python rather
      // than inventing a nicer-looking edge.
      if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height) {
        out[o] = 0; out[o + 1] = 0; out[o + 2] = 0;
        continue;
      }

      const wx = fx - x0;
      const wy = fy - y0;
      const i00 = (y0 * width + x0) * 3;
      const i10 = i00 + 3;
      const i01 = i00 + width * 3;
      const i11 = i01 + 3;

      for (let ch = 0; ch < 3; ch += 1) {
        const top = rgb[i00 + ch] * (1 - wx) + rgb[i10 + ch] * wx;
        const bottom = rgb[i01 + ch] * (1 - wx) + rgb[i11 + ch] * wx;
        out[o + ch] = Math.round(top * (1 - wy) + bottom * wy);
      }
    }
  }
  return out;
}

/** Raw RGB of the source image + five landmarks -> a 112x112 aligned RGB crop. */
function align(rgb, width, height, kps) {
  return warp(rgb, width, height, similarityTransform(kps));
}

module.exports = { align, similarityTransform, warp, REFERENCE, SIZE };
