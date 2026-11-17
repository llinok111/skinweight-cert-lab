/**
 * bench/bench.mjs — wall-clock timing, 1 cold start + 7 warm samples per case.
 * Writes bench/result.json. wall-clock drifts between runs; correctness does not.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { auditWeights, repairWeights, replaySkin } from "../src/core.mjs";
import { denseReplay } from "../baseline/naive.mjs";

const data = JSON.parse(readFileSync(new URL("../data/rigs.json", import.meta.url), "utf8"));
const big = data.rigs.find((r) => r.id === "big-broken");
const SAMPLES = 7;

function stats(ms) {
  const s = [...ms].sort((a, b) => a - b);
  const n = s.length;
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  return { min: s[0], median, p95: s[Math.min(n - 1, Math.ceil(0.95 * n) - 1)], stddev, relSD: mean ? stddev / mean : 0 };
}

function run(name, fn, iters) {
  const cold = (() => { const t = performance.now(); fn(); return performance.now() - t; })();
  fn(); // warmup 1
  const ms = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = performance.now();
    for (let k = 0; k < iters; k++) fn();
    ms.push((performance.now() - t) / iters); // per-iteration milliseconds
  }
  const st = stats(ms);
  console.log(`${name.padEnd(22)} iters=${String(iters).padStart(3)} cold=${cold.toFixed(2)}ms median=${st.median.toFixed(3)}ms p95=${st.p95.toFixed(3)}ms relSD=${(st.relSD * 100).toFixed(1)}%`);
  return { coldMs: cold, iters, samples: SAMPLES, ...st, raw: ms };
}

const cases = {
  "audit-big": run("audit-big", () => auditWeights(big), 20),
  "repair-big": run("repair-big", () => repairWeights(big), 10),
  "replay-sparse-pose0": run("replay-sparse-pose0", () => replaySkin(big, 0), 20),
  "replay-dense-pose0": run("replay-dense-pose0", () => denseReplay(big, 0), 5),
};

const sparse = replaySkin(big, 0), dense = denseReplay(big, 0);
let maxDiff = 0;
for (let i = 0; i < sparse.length; i++) maxDiff = Math.max(maxDiff, Math.abs(sparse[i] - dense[i]));
const audit = auditWeights(big);
const repaired = repairWeights(big).rig;

const out = {
  generatedBy: "bench/bench.mjs",
  node: process.version,
  rig: { id: big.id, vertexCount: big.vertexCount, jointCount: big.jointCount, influencesPerVertex: 4 },
  samples: SAMPLES,
  cases,
  correctness: {
    sparseVsDenseMaxAbsDiff: maxDiff,
    agreeWithin1e_12: maxDiff < 1e-12,
    defectTotalBeforeRepair: audit.total,
    defectTotalAfterRepair: auditWeights(repaired).total,
  },
  speedup: {
    "replay-dense/sparse":
      cases["replay-dense-pose0"].median / cases["replay-sparse-pose0"].median,
  },
  note: "wall-clock milliseconds on this machine; only the ratios and the correctness block are stable across runs.",
};
writeFileSync(new URL("./result.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out.speedup, null, 2));
console.log(`correctness: sparse vs dense maxDiff=${maxDiff} (agreeWithin1e_12=${out.correctness.agreeWithin1e_12})`);
