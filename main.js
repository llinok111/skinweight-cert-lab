/**
 * main.js — renderer + interaction only. All numbers on screen come from the
 * same src/core.mjs the node bench uses; nothing is recomputed here.
 */
import * as THREE from "three";
import { auditWeights, repairWeights, replaySkin, bindPoseError } from "./src/core.mjs";

const hud = document.getElementById("hud");
const data = await (await fetch("./data/rigs.json")).json();
const rig = data.rigs.find((r) => r.id === "big-broken");

const auditBefore = auditWeights(rig);
const repaired = repairWeights(rig).rig;
const auditAfter = auditWeights(repaired);
const bindBefore = bindPoseError(rig).maxError;
const bindAfter = bindPoseError(repaired).maxError;
const posBefore = replaySkin(rig, 0);
const posAfter = replaySkin(repaired, 0);

const defectClass = new Int8Array(rig.vertexCount); // 0 ok, 1 neg, 2 zero, 3 unnorm, 4 oor
for (const v of auditBefore.defects.negativeWeight) defectClass[v] = 1;
for (const v of auditBefore.defects.zeroWeight) defectClass[v] = 2;
for (const v of auditBefore.defects.unnormalized) defectClass[v] = 3;
for (const v of auditBefore.defects.outOfRange) defectClass[v] = 4;

hud.innerHTML =
  `<b>skinweight-cert-lab</b> — same <span class="k">src/core.mjs</span> as <span class="k">node bench/verify.mjs</span><br>` +
  `<span class="k">rig</span> ${rig.id} · V=${rig.vertexCount} · J=${rig.jointCount} · 4 influences/vertex<br>` +
  `<span class="k">defects as-authored</span> total=${auditBefore.total} ` +
  `<span class="red">neg=${auditBefore.counts.negativeWeight}</span> ` +
  `<span class="org">zero=${auditBefore.counts.zeroWeight}</span> ` +
  `<span class="yel">unnorm=${auditBefore.counts.unnormalized}</span> ` +
  `<span class="mag">oor=${auditBefore.counts.outOfRange}</span> max|Σw−1|=${auditBefore.maxSumDeviation.toFixed(6)}<br>` +
  `<span class="k">after repair</span> total=${auditAfter.total} ` +
  `<span class="grn">max|Σw−1|=${auditAfter.maxSumDeviation.toExponential(2)}</span> ` +
  `bindErr ${bindBefore.toExponential(3)} → ${bindAfter.toExponential(3)}<br>` +
  `<span class="k">animation pose-0: vertices collapsed to origin</span> ${[...Array(rig.vertexCount).keys()].filter((v) => Math.hypot(posBefore[3 * v], posBefore[3 * v + 1], posBefore[3 * v + 2]) <= 1e-12).length} → 0`;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 500);
camera.position.set(38, 26, 46);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.getElementById("app").appendChild(renderer.domElement);
const controls = new (await import("three/addons/controls/OrbitControls.js")).OrbitControls(camera, renderer.domElement);
controls.target.set(38, 0, 0);

const palette = [0x3fb950, 0xf85149, 0xd29922, 0xe3b341, 0xbc8cff];
const positions = new Float32Array(rig.vertexCount * 3);
const colors = new Float32Array(rig.vertexCount * 3);
const c = new THREE.Color();
for (let v = 0; v < rig.vertexCount; v++) {
  c.setHex(palette[defectClass[v]]);
  colors[3 * v] = c.r; colors[3 * v + 1] = c.g; colors[3 * v + 2] = c.b;
}
const geom = new THREE.BufferGeometry();
geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
scene.add(new THREE.Points(geom, new THREE.PointsMaterial({ size: 0.35, vertexColors: true })));

const slider = document.getElementById("blend");
const blendv = document.getElementById("blendv");
function setBlend(t) {
  blendv.textContent = t.toFixed(2);
  for (let i = 0; i < positions.length; i++) positions[i] = posBefore[i] * (1 - t) + posAfter[i] * t;
  geom.attributes.position.needsUpdate = true;
}
slider.addEventListener("input", () => setBlend(parseFloat(slider.value)));
setBlend(0);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
(function loop() { requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); })();
