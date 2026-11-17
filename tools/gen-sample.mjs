/**
 * tools/gen-sample.mjs — deterministic rig corpus generator.
 * `node tools/gen-sample.mjs` writes data/rigs.json (byte-identical across runs).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { mat4Mul, invertRigid, mat4Xform } from "../src/core.mjs";

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r6 = (x) => Math.round(x * 1e6) / 1e6;
const r4 = (x) => Math.round(x * 1e4) / 1e4;

function rotZ(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function trans(x, y, z) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function makeRig({ id, J, ring, spacing, broken, seed }) {
  const rand = mulberry32(seed);
  const restPose = [];
  for (let j = 0; j < J; j++) {
    const ang = j * 0.10 + 0.02 * Math.sin(j);
    const x = j * spacing, y = 0.35 * Math.sin(j * 0.31), z = 0.15 * Math.cos(j * 0.27);
    restPose.push(...mat4Mul(trans(x, y, z), rotZ(ang)).map(r6));
  }
  const inverseBindMatrices = [];
  for (let j = 0; j < J; j++) {
    inverseBindMatrices.push(...invertRigid(restPose.slice(j * 16, j * 16 + 16)).map(r6));
  }
  const positions = [], joints = [], weights = [];
  const isDefect = new Set();
  const bump = (v) => { if (isDefect.has(v)) return false; isDefect.add(v); return true; };
  for (let j = 0; j < J; j++) {
    const M = restPose.slice(j * 16, j * 16 + 16);
    for (let m = 0; m < ring; m++) {
      const u = (m + 0.5) / ring;
      const th = (2 * Math.PI * m) / ring + 0.05 * rand();
      const local = [u * spacing, 0.35 * Math.cos(th), 0.35 * Math.sin(th)];
      const w = mat4Xform(M, local[0], local[1], local[2]);
      positions.push(r4(w[0]), r4(w[1]), r4(w[2]));
      const v = j * ring + m;
      const js = [j, Math.min(j + 1, J - 1), j, j];
      const ws = [1 - u, u, 0, 0];
      if (broken && v % 37 === 5 && bump(v)) { ws[0] *= 1.7; ws[1] *= 1.7; }            // unnormalized
      else if (broken && v % 53 === 11 && bump(v)) { ws[0] = 0; ws[1] = 0; }             // zero weight
      else if (broken && v % 71 === 23 && bump(v)) { ws[0] = -0.3; ws[1] = 1.3; }        // negative
      else if (broken && v % 97 === 41 && bump(v)) {                                     // out of range
        js[3] = J + 5; ws[3] = 0.25;
        ws[0] *= 0.75; ws[1] *= 0.75;
      }
      joints.push(js[0], js[1], js[2], js[3]);
      weights.push(ws[0], ws[1], ws[2], ws[3]); // unrounded: ring sizes are powers of two, so clean weights sum to exactly 1
    }
  }
  const poses = [0, 1, 2].map((k) => {
    const matrices = [];
    for (let j = 0; j < J; j++) {
      const base = restPose.slice(j * 16, j * 16 + 16);
      const x = base[12], y = base[13], z = base[14];
      matrices.push(...mat4Mul(trans(x, y, z), rotZ((k + 1) * 0.35 * Math.sin(j * 0.5))).map(r6));
    }
    return { name: `pose-${k}`, matrices };
  });
  return {
    id, jointCount: J, vertexCount: (J * ring),
    positions, joints, weights,
    inverseBindMatrices, restPose, poses,
  };
}

const rigs = [
  makeRig({ id: "big-broken", J: 64, ring: 64, spacing: 1.2, broken: true, seed: 20261117 }),
  makeRig({ id: "small-broken", J: 8, ring: 32, spacing: 1.0, broken: true, seed: 7 }),
];
for (let i = 0; i < 6; i++) {
  rigs.push(makeRig({ id: `clean-${i}`, J: 6, ring: 16, spacing: 0.8 + 0.05 * i, broken: false, seed: 100 + i }));
}

const data = { schema: "skinrig/v1", seed: 20261117, rigs };
mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
const json = JSON.stringify(data) + "\n";
writeFileSync(new URL("../data/rigs.json", import.meta.url), json);
const sha = createHash("sha256").update(json).digest("hex");
console.log(`wrote data/rigs.json  rigs=${rigs.length}  bytes=${json.length}  sha256=${sha}`);
for (const r of rigs) console.log(`  ${r.id}: J=${r.jointCount} V=${r.vertexCount}`);
