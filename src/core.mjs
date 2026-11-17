/**
 * core.mjs — pure skin-weight audit + constructive repair + LBS replay.
 *
 * No `three`, no window/document/navigator, no fs, no network, no env.
 * Every function takes plain JS data and returns plain JS data.
 *
 * Rig descriptor (data/rigs.json):
 *   { id, jointCount, vertexCount,
 *     positions:  number[3V],
 *     joints:     number[4V]   // per-vertex influence joint indices
 *     weights:    number[4V]   // per-vertex influence weights (slot-aligned)
 *     inverseBindMatrices: number[16J],
 *     restPose:   number[16J], // bind-time joint world matrices
 *     poses: [{ name, matrices: number[16J] }] }
 *
 * Matrices are row-major 16-element arrays, column-vector convention:
 *   p' = M * p,  x' = m0*x + m4*y + m8*z + m12, ...
 */

export const MAX_INFLUENCES = 4;

/* ------------------------------------------------------------------ 4x4 */

export function mat4Mul(a, b) {
  const o = new Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      o[r * 4 + c] =
        a[r * 4 + 0] * b[0 * 4 + c] +
        a[r * 4 + 1] * b[1 * 4 + c] +
        a[r * 4 + 2] * b[2 * 4 + c] +
        a[r * 4 + 3] * b[3 * 4 + c];
    }
  }
  return o;
}

export function mat4Xform(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Inverse of a rigid transform (rotation + translation, bottom row 0001). */
export function invertRigid(m) {
  const i = new Array(16).fill(0);
  // R^T
  i[0] = m[0]; i[4] = m[1]; i[8] = m[2];
  i[1] = m[4]; i[5] = m[5]; i[9] = m[6];
  i[2] = m[8]; i[6] = m[9]; i[10] = m[10];
  i[3] = 0; i[7] = 0; i[11] = 0;
  const tx = m[12], ty = m[13], tz = m[14];
  i[12] = -(i[0] * tx + i[4] * ty + i[8] * tz);
  i[13] = -(i[1] * tx + i[5] * ty + i[9] * tz);
  i[14] = -(i[2] * tx + i[6] * ty + i[10] * tz);
  i[15] = 1;
  return i;
}

/* --------------------------------------------------------------- helpers */

function poseMatrices(rig, poseIndex) {
  if (poseIndex < 0) return rig.restPose;
  const p = rig.poses?.[poseIndex];
  if (!p) throw new Error(`no pose ${poseIndex}`);
  return p.matrices;
}

/** Skin matrices M_j = pose_j * inverseBind_j for one pose. */
export function jointMatrices(rig, poseIndex) {
  const J = rig.jointCount;
  const pose = poseMatrices(rig, poseIndex);
  const out = new Float64Array(J * 16);
  for (let j = 0; j < J; j++) {
    const m = mat4Mul(
      pose.slice(j * 16, j * 16 + 16),
      rig.inverseBindMatrices.slice(j * 16, j * 16 + 16),
    );
    for (let k = 0; k < 16; k++) out[j * 16 + k] = m[k];
  }
  return out;
}

/** Linear blend skinning, sparse influences. Out-of-range joints are ignored. */
export function replaySkin(rig, poseIndex = -1) {
  const V = rig.vertexCount, J = rig.jointCount;
  const S = jointMatrices(rig, poseIndex);
  const out = new Float64Array(V * 3);
  for (let v = 0; v < V; v++) {
    const px = rig.positions[3 * v], py = rig.positions[3 * v + 1], pz = rig.positions[3 * v + 2];
    let ax = 0, ay = 0, az = 0;
    for (let k = 0; k < MAX_INFLUENCES; k++) {
      const j = rig.joints[4 * v + k];
      const w = rig.weights[4 * v + k];
      if (!(w > 0) || !Number.isFinite(w)) continue;
      if (!(j >= 0 && j < J)) continue; // undefined joint -> no contribution
      const m = S.subarray(j * 16, j * 16 + 16);
      ax += w * (m[0] * px + m[4] * py + m[8] * pz + m[12]);
      ay += w * (m[1] * px + m[5] * py + m[9] * pz + m[13]);
      az += w * (m[2] * px + m[6] * py + m[10] * pz + m[14]);
    }
    out[3 * v] = ax; out[3 * v + 1] = ay; out[3 * v + 2] = az;
  }
  return out;
}

/** Max |replaySkin(bind pose) - rest position|; non-zero <=> weights not normalized/valid. */
export function bindPoseError(rig) {
  const P = replaySkin(rig, -1);
  let max = 0, worst = -1;
  for (let v = 0; v < rig.vertexCount; v++) {
    const dx = P[3 * v] - rig.positions[3 * v];
    const dy = P[3 * v + 1] - rig.positions[3 * v + 1];
    const dz = P[3 * v + 2] - rig.positions[3 * v + 2];
    const e = Math.hypot(dx, dy, dz);
    if (e > max) { max = e; worst = v; }
  }
  return { maxError: max, worstVertex: worst };
}

/* ----------------------------------------------------------------- audit */

export const DEFECT_TYPES = ["negativeWeight", "zeroWeight", "unnormalized", "outOfRange"];

/**
 * Classify per-vertex weight defects and return witnesses.
 * `eps` is RELATIVE to the vertex's own world radius (|p|): an influence set is
 * "unnormalized" when |sum(w) - 1| > eps * max(1, |p|).  Relative threshold =>
 * the verdict is invariant under uniform scaling of the rig.
 */
export function auditWeights(rig, { eps = 1e-9 } = {}) {
  const V = rig.vertexCount, J = rig.jointCount;
  const defects = { negativeWeight: [], zeroWeight: [], unnormalized: [], outOfRange: [] };
  const witnesses = [];
  let maxSumDeviation = 0, maxNegMag = 0;

  for (let v = 0; v < V; v++) {
    const px = rig.positions[3 * v], py = rig.positions[3 * v + 1], pz = rig.positions[3 * v + 2];
    const radius = Math.max(1, Math.hypot(px, py, pz));
    let sum = 0, neg = 0, oor = 0;
    for (let k = 0; k < MAX_INFLUENCES; k++) {
      const w = rig.weights[4 * v + k];
      const j = rig.joints[4 * v + k];
      if (!Number.isFinite(w)) continue;
      if (w < 0) { neg += -w; }
      sum += w;
      if (!(j >= 0 && j < J)) oor++;
    }
    const dev = Math.abs(sum - 1);
    if (neg > 0) { defects.negativeWeight.push(v); witnesses.push({ type: "negativeWeight", vertex: v, magnitude: neg }); }
    if (Math.abs(sum) <= 1e-15) { defects.zeroWeight.push(v); witnesses.push({ type: "zeroWeight", vertex: v }); }
    if (dev > eps * radius) {
      defects.unnormalized.push(v);
      witnesses.push({ type: "unnormalized", vertex: v, deviation: dev });
      if (dev > maxSumDeviation) maxSumDeviation = dev;
    }
    if (oor > 0) { defects.outOfRange.push(v); witnesses.push({ type: "outOfRange", vertex: v, count: oor }); }
    if (neg > maxNegMag) maxNegMag = neg;
  }
  const counts = {};
  for (const t of DEFECT_TYPES) counts[t] = defects[t].length;
  return {
    vertexCount: V, jointCount: J, eps, counts, defects, witnesses,
    maxSumDeviation, maxNegativeMagnitude: maxNegMag,
    total: DEFECT_TYPES.reduce((a, t) => a + counts[t], 0),
  };
}

/** Independent re-check of a single audit witness (no shared state with audit). */
export function validateWitness(rig, w) {
  const v = w.vertex;
  if (!(v >= 0 && v < rig.vertexCount)) return false;
  const ws = [0, 1, 2, 3].map((k) => rig.weights[4 * v + k]);
  const js = [0, 1, 2, 3].map((k) => rig.joints[4 * v + k]);
  const sum = ws.reduce((a, b) => a + b, 0);
  switch (w.type) {
    case "negativeWeight": return ws.some((x) => x < 0);
    case "zeroWeight": return Math.abs(sum) <= 1e-15;
    case "unnormalized": return Math.abs(sum - 1) > 1e-9 * Math.max(1, Math.hypot(rig.positions[3 * v], rig.positions[3 * v + 1], rig.positions[3 * v + 2]));
    case "outOfRange": return js.some((j) => !(j >= 0 && j < rig.jointCount));
    default: return false;
  }
}

/* ---------------------------------------------------------------- repair */

/**
 * Constructive repair: drop out-of-range/negative/zero influences, dedupe by
 * joint (keep max), keep the top-MAX_INFLUENCES by magnitude, renormalize.
 * A vertex left with no influence gets weight 1 on the joint whose bind origin
 * is closest to the rest position.
 */
export function repairWeights(rig, { maxInfluences = MAX_INFLUENCES } = {}) {
  const V = rig.vertexCount, J = rig.jointCount;
  const joints = new Array(4 * V);
  const weights = new Array(4 * V).fill(0);
  const jointOrigin = new Float64Array(J * 3);
  for (let j = 0; j < J; j++) {
    const ib = invertRigid(rig.inverseBindMatrices.slice(j * 16, j * 16 + 16));
    jointOrigin[3 * j] = ib[12]; jointOrigin[3 * j + 1] = ib[13]; jointOrigin[3 * j + 2] = ib[14];
  }
  let changedVertices = 0, droppedInfluences = 0, fallbackVertices = 0;

  for (let v = 0; v < V; v++) {
    const map = new Map();
    for (let k = 0; k < MAX_INFLUENCES; k++) {
      const j = rig.joints[4 * v + k];
      const w = rig.weights[4 * v + k];
      if (!Number.isFinite(w) || w <= 0) { if (w !== 0) droppedInfluences++; continue; }
      if (!(j >= 0 && j < J)) { droppedInfluences++; continue; }
      map.set(j, Math.max(map.get(j) ?? 0, w));
    }
    let list = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxInfluences);
    if (list.length === 0) {
      fallbackVertices++;
      const px = rig.positions[3 * v], py = rig.positions[3 * v + 1], pz = rig.positions[3 * v + 2];
      let best = 0, bestD = Infinity;
      for (let j = 0; j < J; j++) {
        const d = (jointOrigin[3 * j] - px) ** 2 + (jointOrigin[3 * j + 1] - py) ** 2 + (jointOrigin[3 * j + 2] - pz) ** 2;
        if (d < bestD) { bestD = d; best = j; }
      }
      list = [[best, 1]];
    }
    const s = list.reduce((a, e) => a + e[1], 0);
    for (let k = 0; k < maxInfluences; k++) {
      if (k < list.length) { joints[4 * v + k] = list[k][0]; weights[4 * v + k] = list[k][1] / s; }
      else { joints[4 * v + k] = list[0][0]; weights[4 * v + k] = 0; }
    }
    const before = [0, 1, 2, 3].map((k) => rig.weights[4 * v + k]);
    if (joints.slice(4 * v, 4 * v + 4).some((j, k) => j !== rig.joints[4 * v + k]) ||
        weights.slice(4 * v, 4 * v + 4).some((w, k) => Math.abs(w - before[k]) > 1e-15)) changedVertices++;
  }
  const out = { ...rig, joints, weights };
  return { rig: out, changedVertices, droppedInfluences, fallbackVertices };
}

/* ------------------------------------------------------------- utilities */

/** Uniformly scale all positions and joint origins — for scale-invariance tests. */
export function scaleRig(rig, s) {
  const scaleFlat = (flat) => {
    const o = flat.slice();
    for (let j = 0; j * 16 < o.length; j++) { o[j * 16 + 12] *= s; o[j * 16 + 13] *= s; o[j * 16 + 14] *= s; }
    return o;
  };
  return {
    ...rig,
    positions: rig.positions.map((x) => x * s),
    inverseBindMatrices: scaleFlat(rig.inverseBindMatrices),
    restPose: scaleFlat(rig.restPose),
    poses: rig.poses.map((p) => ({ name: p.name, matrices: scaleFlat(p.matrices) })),
  };
}

/** True when two rigs define the same joint->weight function per vertex (slot order ignored). */
export function rigsEquivalent(a, b, eps = 1e-12) {
  if (a.vertexCount !== b.vertexCount) return false;
  for (let v = 0; v < a.vertexCount; v++) {
    const ma = new Map(), mb = new Map();
    for (let k = 0; k < MAX_INFLUENCES; k++) {
      const ja = a.joints[4 * v + k], wa = a.weights[4 * v + k];
      if (wa > 0) ma.set(ja, (ma.get(ja) ?? 0) + wa);
      const jb = b.joints[4 * v + k], wb = b.weights[4 * v + k];
      if (wb > 0) mb.set(jb, (mb.get(jb) ?? 0) + wb);
    }
    if (ma.size !== mb.size) return false;
    for (const [j, w] of ma) {
      if (!mb.has(j) || Math.abs(mb.get(j) - w) > eps) return false;
    }
  }
  return true;
}

/** djb2 over the canonical numeric content — cheap determinism fingerprint. */
export function hashRig(rig) {
  const parts = [rig.id, String(rig.jointCount), String(rig.vertexCount)];
  for (const arr of [rig.positions, rig.joints, rig.weights, rig.inverseBindMatrices]) {
    for (let i = 0; i < arr.length; i++) parts.push(Number(arr[i]).toFixed(12));
  }
  let h = 5381;
  const s = parts.join(",");
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}
