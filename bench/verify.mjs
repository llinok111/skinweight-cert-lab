/**
 * bench/verify.mjs — behavioural assertions over the generated corpus.
 * Every assertion prints the measured value it checked. exit 0 = all passed.
 */
import { readFileSync } from "node:fs";
import {
  auditWeights, repairWeights, replaySkin, bindPoseError, validateWitness,
  scaleRig, hashRig, rigsEquivalent, DEFECT_TYPES,
} from "../src/core.mjs";
import { denseReplay } from "../baseline/naive.mjs";

const data = JSON.parse(readFileSync(new URL("../data/rigs.json", import.meta.url), "utf8"));
const rigs = data.rigs;
const byId = (id) => rigs.find((r) => r.id === id);
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}  ${detail}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
};
const fmt = (x) => (typeof x === "number" ? x.toExponential(4) : String(x));

console.log("== skinweight-cert-lab :: verify ==");
console.log(`corpus: rigs=${rigs.length} schema=${data.schema}`);
for (const r of rigs) console.log(`  ${r.id}: J=${r.jointCount} V=${r.vertexCount}`);

const big = byId("big-broken");
const small = byId("small-broken");
const cleans = rigs.filter((r) => r.id.startsWith("clean-"));

/* A1 */ ok("A1 corpus shape", rigs.length === 8 && big.vertexCount === 4096 && big.jointCount === 64,
  `rigs=${rigs.length} big.V=${big.vertexCount} big.J=${big.jointCount}`);

/* A2 */ const aBig = auditWeights(big);
ok("A2 broken big has all four defect classes",
  DEFECT_TYPES.every((t) => aBig.counts[t] > 0),
  DEFECT_TYPES.map((t) => `${t}=${aBig.counts[t]}`).join(" "));
console.log(`        big total=${aBig.total} maxSumDeviation=${fmt(aBig.maxSumDeviation)} maxNegMag=${fmt(aBig.maxNegativeMagnitude)}`);

/* A3 */ const aSmall = auditWeights(small);
ok("A3 broken small has all four defect classes", DEFECT_TYPES.every((t) => aSmall.counts[t] > 0),
  DEFECT_TYPES.map((t) => `${t}=${aSmall.counts[t]}`).join(" "));

/* A4 */ const cleanAudits = cleans.map((r) => auditWeights(r));
ok("A4 clean rigs defect-free", cleanAudits.every((a) => a.total === 0),
  `clean total=[${cleanAudits.map((a) => a.total).join(",")}]`);

/* A5 */ const witnesses = [...aBig.witnesses, ...aSmall.witnesses];
let wOk = 0;
const wByRig = [[big, aBig.witnesses], [small, aSmall.witnesses]];
for (const [rig, ws] of wByRig) for (const w of ws) if (validateWitness(rig, w)) wOk++;
ok("A5 every audit witness re-validates independently", wOk === witnesses.length && witnesses.length > 0,
  `validated=${wOk}/${witnesses.length}`);

/* A6 */ const bindBeforeBig = bindPoseError(big);
const repBig = repairWeights(big);
const aBigFixed = auditWeights(repBig.rig);
const bindAfterBig = bindPoseError(repBig.rig);
ok("A6 repair removes every defect on big rig", aBigFixed.total === 0,
  `total ${aBig.total} -> ${aBigFixed.total}; maxSumDeviation ${fmt(aBig.maxSumDeviation)} -> ${fmt(aBigFixed.maxSumDeviation)}`);
ok("A7 bind-pose error collapses after repair",
  bindBeforeBig.maxError > 1e-2 && bindAfterBig.maxError < 1e-3,
  `before=${fmt(bindBeforeBig.maxError)} (worst v=${bindBeforeBig.worstVertex}) after=${fmt(bindAfterBig.maxError)} (floor set by 1e-6 JSON rounding of matrices)`);
ok("A8 repaired weights normalized to machine precision", aBigFixed.maxSumDeviation < 1e-12,
  `maxSumDeviation=${fmt(aBigFixed.maxSumDeviation)}`);
console.log(`        repair: changedVertices=${repBig.changedVertices} droppedInfluences=${repBig.droppedInfluences} fallbackVertices=${repBig.fallbackVertices}`);

/* A9 */ const repSmall = repairWeights(small);
const cleanNoop = cleans.map((r) => rigsEquivalent(r, repairWeights(r).rig));
ok("A9 repair removes every defect on small rig + clean rigs are no-op",
  auditWeights(repSmall.rig).total === 0 && cleanNoop.every(Boolean),
  `small total -> ${auditWeights(repSmall.rig).total}; clean equivalent=[${cleanNoop.join(",")}]`);

/* A10 */ const pose0Broken = replaySkin(big, 0), pose0Fixed = replaySkin(repBig.rig, 0);
let collapsedBefore = 0, collapsedAfter = 0, moved = 0;
for (let v = 0; v < big.vertexCount; v++) {
  const b = Math.hypot(pose0Broken[3 * v], pose0Broken[3 * v + 1], pose0Broken[3 * v + 2]);
  const a = Math.hypot(pose0Fixed[3 * v], pose0Fixed[3 * v + 1], pose0Fixed[3 * v + 2]);
  if (b <= 1e-12) collapsedBefore++;
  if (a <= 1e-12) collapsedAfter++;
  if (Math.hypot(pose0Fixed[3 * v] - pose0Broken[3 * v], pose0Fixed[3 * v + 1] - pose0Broken[3 * v + 1], pose0Fixed[3 * v + 2] - pose0Broken[3 * v + 2]) > 1e-9) moved++;
}
ok("A10 zero-weight vertices collapse to origin before repair, none after",
  collapsedBefore > 0 && collapsedAfter === 0,
  `collapsed before=${collapsedBefore} after=${collapsedAfter}; vertices moved by repair=${moved}`);

/* A11 */ const dense0 = denseReplay(big, 0);
let maxDiff = 0;
for (let i = 0; i < dense0.length; i++) maxDiff = Math.max(maxDiff, Math.abs(dense0[i] - pose0Broken[i]));
ok("A11 sparse core replay matches the dense O(V*J) baseline within 1e-12 (accumulation order differs)", maxDiff < 1e-12,
  `max|sparse-dense|=${fmt(maxDiff)}`);

/* A12 */ const h1 = hashRig(byId("clean-0")), h2 = hashRig(byId("clean-0"));
ok("A12 rig fingerprint is deterministic", h1 === h2, `hash=${h1} twice=${h2}`);

/* A13 */ const scaleVerdict = [];
for (const s of [1e-3, 1, 1e3, 1e6]) {
  const scaled = scaleRig(big, s);
  const a = auditWeights(scaled);
  const fixed = repairWeights(scaled).rig;
  scaleVerdict.push(`${s}:${a.total}/${auditWeights(fixed).total}`);
}
const allScaleSame = scaleVerdict.every((x) => x.endsWith(`:${aBig.total}/0`));
ok("A13 defect verdicts are scale-invariant (1e-3 .. 1e6)", allScaleSame, scaleVerdict.join(" "));

/* A14 */ const empty = { jointCount: 0, vertexCount: 0, positions: [], joints: [], weights: [], inverseBindMatrices: [], restPose: [], poses: [] };
let emptyOk = false, emptyTotal = -1;
try { emptyTotal = auditWeights(empty).total; emptyOk = true; } catch (e) { emptyOk = false; }
ok("A14 empty rig returns a structured zero result, no throw", emptyOk && emptyTotal === 0,
  `total=${emptyTotal}`);

/* A15 */ const bindSmallBefore = bindPoseError(small).maxError, bindSmallAfter = bindPoseError(repSmall.rig).maxError;
ok("A15 small rig bind error also collapses", bindSmallBefore > 1e-2 && bindSmallAfter < 1e-3,
  `before=${fmt(bindSmallBefore)} after=${fmt(bindSmallAfter)}`);

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
