# skinweight-cert-lab

**Promise.** A skin-weight doctor for rigged meshes that turns “this rig deforms wrong” into a
number: on the bundled 4,096-vertex / 64-joint rig it finds **358 defects** (187 unnormalized,
76 zero-weight, 55 negative, 40 out-of-range joint references), a constructive repair removes
**all 358 → 0** defects, and the bind-pose reconstruction error drops from **76.74** to
**6.68e-5** (that floor is the 1e-6 JSON rounding of the matrices, not a residual defect).
Baseline: the dense O(V·J) skinning scan in [`baseline/naive.mjs`](baseline/naive.mjs) —
sparse replay is **3.20×** faster at the median (0.501 ms vs 1.606 ms) and agrees with it to
**2.84e-14**.

Upstream: none

## Why this exists

Game engines and DCC exporters disagree about skin weights in ways that only show up as
artifacts: unnormalized weights scale the mesh at bind time, zero-weight vertices collapse to
the origin, negative weights invert geometry, and joint indices outside the skeleton are
silently ignored (so the vertex loses part of its transform). `gltf-audit-lab` (team B) checks
container integrity, not weight semantics; the official glTF-Validator checks ranges, not the
resulting deformation. This lab classifies each failure with a witness vertex, repairs it, and
then *re-verifies by replaying the skin*, so the fix is proven, not asserted.

## Run it

```bash
node tools/gen-sample.mjs     # deterministic corpus -> data/rigs.json (sha256 e82f07a0…)
node bench/verify.mjs         # 15 behavioural assertions, exit 0
node bench/bench.mjs          # timing -> bench/result.json
python3 -m http.server 4173   # then open http://localhost:4173
```

No install step, no bundler, no `node_modules`. The browser page imports three.js 0.169.0 from a
pinned CDN importmap and consumes the same `src/core.mjs` the bench uses.

## Evidence (`bench/result.json`, 1 cold + 7 samples)

| case | iters | median | p95 | cold |
| --- | --- | --- | --- | --- |
| audit-big | 20 | 0.219 ms | 0.637 ms | 4.53 ms |
| repair-big | 10 | 3.788 ms | 6.345 ms | 9.46 ms |
| replay-sparse-pose0 | 20 | 0.501 ms | 0.994 ms | 2.88 ms |
| replay-dense-pose0 (baseline) | 5 | 1.606 ms | 3.428 ms | 6.22 ms |

- Correctness: `max|sparse − dense| = 2.842e-14` (agrees within 1e-12; the two paths sum in a
  different order, they are not bit-identical).
- `bench/verify.mjs` output is committed as [`bench/verify-output.txt`](bench/verify-output.txt):
  **15 passed / 0 failed**, every assertion prints its measured value.
- Scale invariance: defect verdicts are identical at rig scales 1e-3, 1, 1e3 and 1e6
  (`A13: 0.001:358/0 1:358/0 1000:358/0 1000000:358/0` — i.e. 358 before, 0 after, at every scale).
- The “unnormalized” test uses a **relative** threshold `1e-9 · max(1, |p|)`, which is what makes
  A13 hold; the matrices/positions are JSON-rounded to 1e-6/1e-4, so the repaired bind error is
  bounded by that rounding rather than by float64 epsilon.

## 本轮创新

**B.** First skin-weight audit whose repair is *re-verified by skinning replay*: defect classes are
paired with witness vertices that an independent `validateWitness()` re-derives (382/382), the
repair is checked for two directions at once — no defect remains **and** the fix is a no-op on six
clean rigs (`rigsEquivalent` 6/6 true) — and bind-pose error is measured before/after on the same
core that renders. Prior team-B work certified static geometry or articulated collision; nothing
touched deformation semantics, and existing validators stop at range checks instead of replaying
the skin.

## Known limitations

- The rig descriptor is **flat world-space joint matrices, no parent hierarchy**: a binding that
  multiplies parent chains is out of scope.
- Max 4 influences per vertex (the GLTF/WebGL-common budget); 8-influence rigs are truncated by
  `repairWeights`, not audited as a class of their own.
- `unnormalized` is relative to `|p|` (world radius). At rig scales outside 1e-6…1e6 the threshold
  has not been tested.
- Timing is wall-clock on a 4-core shared VM: `relSD` is 23–49% because the workloads are
  sub-5 ms. Only the ratio and the correctness block are stable; the four medians above are copied
  verbatim from the committed `bench/result.json` (re-running `bench/bench.mjs` rewrites that file
  and will move them a few percent; the README is not edited to chase a re-run).
- No headless-browser automation (forbidden in this environment): the page is verified by
  HTTP 200 + importmap presence + node-side recomputation, not by screenshots.

## License

MIT — see [LICENSE](LICENSE).
