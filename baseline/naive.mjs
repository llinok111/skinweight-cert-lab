/**
 * baseline/naive.mjs — the O(V*J) baseline: for every vertex, scan EVERY joint
 * to find its influences (as a dense bone-weight lookup would), then skin.
 * Reference behaviour only; do not "optimise" this to make numbers look good.
 */
export function denseReplay(rig, poseIndex = -1) {
  const V = rig.vertexCount, J = rig.jointCount;
  const pose = poseIndex < 0 ? rig.restPose : rig.poses[poseIndex].matrices;
  const S = new Array(J * 16);
  for (let j = 0; j < J; j++) {
    const a = pose.slice(j * 16, j * 16 + 16);
    const b = rig.inverseBindMatrices.slice(j * 16, j * 16 + 16);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      S[j * 16 + r * 4 + c] =
        a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
    }
  }
  const out = new Float64Array(V * 3);
  for (let v = 0; v < V; v++) {
    const px = rig.positions[3 * v], py = rig.positions[3 * v + 1], pz = rig.positions[3 * v + 2];
    let ax = 0, ay = 0, az = 0;
    for (let j = 0; j < J; j++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (rig.joints[4 * v + k] === j && rig.weights[4 * v + k] > 0) w += rig.weights[4 * v + k];
      if (w === 0) continue;
      const m = S.slice(j * 16, j * 16 + 16);
      ax += w * (m[0] * px + m[4] * py + m[8] * pz + m[12]);
      ay += w * (m[1] * px + m[5] * py + m[9] * pz + m[13]);
      az += w * (m[2] * px + m[6] * py + m[10] * pz + m[14]);
    }
    out[3 * v] = ax; out[3 * v + 1] = ay; out[3 * v + 2] = az;
  }
  return out;
}
