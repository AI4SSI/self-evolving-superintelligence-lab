/* RAILab Workflow Decomposer — 3D bench view of the digital twin (spec §10).

   A pure renderer: twin.js turns the server's twin state into a SCENE
   DESCRIPTION (bench size + one item per placement with its bench pose,
   size, model, flags, slots, accessories + transfer arrows) and hands it
   to TW3D.render(). Nothing here knows the workflow or the API; a future
   dynamic twin only has to call TW3D.applyPose() with new poses between
   two checkpoints.

   Conventions: millimetres, the bench frame is RIGHT-HANDED — x right,
   y away from the operator (towards the back of the bench), z up — and
   the scene uses it verbatim: no mirroring anywhere, so a chiral model
   looks exactly like its CAD (the 2D canvas is the view that flips its
   screen y to put the operator's edge at the bottom). The camera starts
   in front of the bench (y < 0) looking towards +y. Models are glTF
   binaries (one named node per STEP part, Z-up model frame, placements
   baked — written from the STEP by twin/cad.py) loaded from
   /api/twin/asset/… and shifted by -origin (the type's held point, see
   Library._derive_origin) so that anchor sits on the placement at bench
   level. The mesh is for DRAWING AND CLICKING ONLY (spec §10.2,
   2026-10-19): nothing is measured from its triangles.

   ARTICULATED models (2026-10-20): an item may carry `kinematics` (links
   = groups of glTF part nodes, each with a parent and a revolute /
   prismatic joint in the model frame, see twin/model.py) and `joints`
   (joint id -> value). The part nodes are re-parented into one
   THREE.Group per link, nested by parent, and each link group's matrix is
   the joint transform conjugated about its axis point — the same maths as
   Kinematics.transforms on the server. TW3D.applyPose() takes `joints`
   too, so a dynamic twin can tween them.

   MATING POINTS are intrinsic to a TYPE (spec §10.2, 2026-10-16): they are
   defined in the Library tab on the type's own model, in the standalone
   `ModelView` below (TW3D.modelView(wrap)), not on a bench placement.
   The view shows one model with its mating points, and in pick mode
   raycasts the next click and snaps it to the CAD feature the user hit:
   the model's <model>.features.json (the STEP's planar faces /
   cylindrical faces / circular rims, extracted by twin/cad.py) resolves
   the click to the REAL B-rep feature — the face's centre + outward
   normal, a face corner / edge midpoint near the cursor, or the
   bore/post axis at its lower end (AprilTag picks: planar faces only). The triangle under the
   cursor only says WHICH feature was hit; the stored coordinates come
   from the STEP. A model without features.json yields the raw click
   point. The result carries the point in the model file's frame
   (`model`, what a mating point stores), relative to the item's anchor
   (`local`) and the up direction. While a pick is armed, hovering
   previews the snap as a ring + axis marker, re-snapped on every move. No CAD kernel, no STEP is
   read here. */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const COLORS = {
  bench: 0xf5f5f7, benchEdge: 0xb8bcc4, grid: 0xe3e5ea,
  module: 0x9fb4d8, moduleBusy: 0x7fa4e8, container: 0xf0b56a, glass: 0xd9ecf5, holder: 0xc8c2b4,
  selected: 0xff3b30, fail: 0xc0392b, suggest: 0x27ae60, slot: 0xffffff, slotFull: 0xf6cf8f,
  reach: 0x2f6fdd, accessory: 0x5aa65a, arrow: 0xe67e22, placeholder: 0xc9d2e3,
};

const S = {                       // module state
  wrap: null, renderer: null, scene: null, camera: null, controls: null,
  root: null, items: null, overlays: null, handlers: {},
  groups: new Map(),              // placement id -> THREE.Group
  modelCache: new Map(),          // url -> Promise<THREE.Group> (a glTF scene; cloned per use)
  spriteCache: new Map(),         // text -> SpriteMaterial
  desc: null, needs: false, drag: null, selected: null, raf: 0,
  pick: null,                     // {pid, snap, planar, onPick, onCancel} while a mating-point pick is armed
  featCache: new Map(),           // features url -> {data|null, promise}
  hover: null,                    // preview marker group while picking
  hoverKey: "",
  extraViews: new Set(),          // render requests of other views (MotionView) built from the same items
  triad: null,                    // the view triad (bench axes at the bottom-left corner) drawn after the scene
};
const Z_UP = new THREE.Vector3(0, 0, 1);
const loader = new GLTFLoader();
const PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);   // bench top, z = 0
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();

/* ------------------------------------------------------------- mount */
function mount(wrap, handlers = {}) {
  S.wrap = wrap; S.handlers = handlers;
  S.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  wrap.appendChild(S.renderer.domElement);
  S.scene = new THREE.Scene();
  S.camera = new THREE.PerspectiveCamera(40, 1, 5, 20000);
  S.camera.up.set(0, 0, 1);
  S.controls = new OrbitControls(S.camera, S.renderer.domElement);
  S.controls.enableDamping = false;
  S.controls.maxPolarAngle = Math.PI / 2 - 0.02;   // never below the bench
  S.controls.addEventListener("change", requestRender);
  S.triad = viewTriad();
  S.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(-600, -900, 1400);
  S.scene.add(sun);
  S.root = new THREE.Group();                        // bench frame == scene frame
  S.scene.add(S.root);
  S.items = new THREE.Group(); S.overlays = new THREE.Group();
  S.root.add(S.items, S.overlays);
  new ResizeObserver(resize).observe(wrap);
  resize();
  wirePointer();
}

function resize() {
  if (!S.renderer || !S.wrap) return;
  const w = Math.max(1, S.wrap.clientWidth), h = Math.max(1, S.wrap.clientHeight);
  S.renderer.setSize(w, h, false);
  S.renderer.domElement.style.width = "100%"; S.renderer.domElement.style.height = "100%";
  S.camera.aspect = w / h; S.camera.updateProjectionMatrix();
  requestRender();
}

function requestRender() {
  for (const f of S.extraViews) f();               // other views sharing the caches (motion view): async model loads
  if (S.needs || !S.renderer) return;
  S.needs = true;
  S.raf = requestAnimationFrame(() => { S.needs = false; renderView(S.renderer, S.scene, S.camera, S.triad); });
}

/* ------------------------------------------------------------ camera */
function fit() {
  if (!S.desc) return;
  const [W, D] = S.desc.bench;
  const L = Math.max(W, D);
  S.controls.target.set(W / 2, D / 2, 60);
  S.camera.position.set(W / 2, -L * 0.75, L * 0.8);   // in front of the bench, looking towards +y
  S.controls.update();
  requestRender();
}

/* --------------------------------------------------------- building */
function disposeGroup(g) {
  g.traverse(o => {
    if (o.isMesh || o.isLine || o.isSprite) {
      if (o.geometry && !o.userData.shared) o.geometry.dispose();
      if (o.material && !o.userData.sharedMat && !o.isSprite) o.material.dispose();
    }
  });
  g.clear();
}

function buildBench(bench, name) {
  const [W, D] = bench;
  const g = new THREE.Group();
  const top = new THREE.Mesh(new THREE.BoxGeometry(W, D, 24),
                             new THREE.MeshStandardMaterial({ color: COLORS.bench, roughness: 0.9 }));
  top.position.set(W / 2, D / 2, -12);
  g.add(top);
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(top.geometry),
                                      new THREE.LineBasicMaterial({ color: COLORS.benchEdge }));
  edge.position.copy(top.position);
  g.add(edge);
  const pts = [];
  for (let x = 100; x < W; x += 100) pts.push(x, 0, 0.3, x, D, 0.3);
  for (let y = 100; y < D; y += 100) pts.push(0, y, 0.3, W, y, 0.3);
  const grid = new THREE.BufferGeometry();
  grid.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  g.add(new THREE.LineSegments(grid, new THREE.LineBasicMaterial({ color: COLORS.grid })));
  g.add(sprite(`${name} · ${W} × ${D} mm · front edge`, 0x666666, 22, [W / 2, -70, 2]));
  return g;
}

function placeholder(it) {
  const [w, d, h] = it.size;
  let geo;
  if (it.kind === "container") {
    geo = new THREE.CylinderGeometry(Math.min(w, d) / 2, Math.min(w, d) / 2, h, 32);
    geo.rotateX(Math.PI / 2);                         // cylinder axis -> z
  } else {
    geo = new THREE.BoxGeometry(w, d, h);
  }
  geo.translate(0, 0, h / 2);
  return geo;
}

function material(it) {
  if (it.tint != null) {                              // a state colour (spec §10.8: grey / light green / deep green)
    return new THREE.MeshStandardMaterial({ color: it.tint, roughness: 0.6, metalness: 0.05 });
  }
  if (it.kind === "container") {
    return new THREE.MeshStandardMaterial({ color: it.model ? COLORS.glass : COLORS.container,
      roughness: 0.25, metalness: 0.05, transparent: true, opacity: 0.85 });
  }
  if (it.kind === "holder") return new THREE.MeshStandardMaterial({ color: COLORS.holder, roughness: 0.75, metalness: 0.0 });
  if (it.kind === "accessory") return new THREE.MeshStandardMaterial({ color: COLORS.accessory, roughness: 0.5 });
  return new THREE.MeshStandardMaterial({ color: it.busy ? COLORS.moduleBusy : (it.model ? COLORS.module : COLORS.placeholder),
    roughness: 0.6, metalness: 0.1 });
}

/* translucent material for links flagged `material: "glass"` (the
   Bunny's windshield housing): see-through, drawn after the opaque parts,
   no depth write so the parts behind it stay visible */
function glassMaterial() {
  return new THREE.MeshPhysicalMaterial({ color: 0xbfe3f4, roughness: 0.15, metalness: 0.0,
    transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide });
}

function highlight(g, selected) {
  g.traverse(o => {                                  // its own body only, not the items mated onto it
    if (o.isMesh && o.userData.body && o.userData.pid === g.userData.pid) {
      o.material.emissive = new THREE.Color(selected ? COLORS.selected : (o.userData.fail ? COLORS.fail : 0x000000));
      o.material.emissiveIntensity = selected ? 0.35 : 0.25;
    }
  });
}

function loadModel(url) {
  if (!S.modelCache.has(url)) {
    S.modelCache.set(url, new Promise((res, rej) => loader.load(url, (gltf) => res(gltf.scene), undefined, rej)));
  }
  return S.modelCache.get(url);
}

/* The drawable body of an item: a group (`bodyRoot`) that is shifted by
   -origin once the model is in, so the group's local frame IS the model
   file's frame. It starts with a placeholder box / cylinder and swaps in
   a clone of the loaded glTF scene (geometries shared across clones, one
   material per item). Every mesh in it is flagged `body` for picking.
   With `kinematics` the part nodes are regrouped into link groups
   (`userData.link`) and posed at `joints`. */
function makeBody(it, mat, onLoaded) {
  const root = new THREE.Group();
  root.userData.bodyRoot = true;
  root.userData.whenLinked = [];                       // callbacks once the link groups exist (tags, mated items)
  const ph = new THREE.Mesh(placeholder(it), mat);
  ph.userData = { body: true, pid: it.id, fail: it.fail };
  root.add(ph);
  if (it.model && it.model.url) {
    root.userData.loading = true;                      // a played move waits until every body is in (playOnce)
    loadModel(it.model.url).then(scene => {
      root.userData.loading = false;
      if (!root.parent) return;                      // scene rebuilt meanwhile
      const inst = scene.clone(true);
      inst.traverse(o => {
        if (o.isMesh) { o.material = mat; o.userData = { body: true, pid: it.id, fail: it.fail, shared: true, sharedMat: true }; }
      });
      root.remove(ph); ph.geometry.dispose();
      root.add(inst);
      if (it.kinematics) { buildLinks(root, inst, it.kinematics); root.userData.fixes = linkFixes(it); applyJoints(root, it.joints); applyLinkMaterials(root, it.kinematics); }
      for (const f of root.userData.whenLinked.splice(0)) f();
      const o = it.model.origin || [0, 0, 0];
      root.position.set(-o[0], -o[1], -o[2]);
      if (onLoaded) onLoaded(inst);
      requestRender();
    }).catch(() => { root.userData.loading = false; });
  }
  return root;
}

/* ---------------------------------------------------------- articulation
   glTF node names are the STEP part names; GLTFLoader sanitises them
   (spaces etc. -> '_'), so parts are matched on a normalised key. */
const nodeKey = (n) => String(n || "").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
function buildLinks(root, inst, kin) {
  const byKey = new Map();
  inst.traverse(o => { if (o !== inst && o.name) byKey.set(nodeKey(o.name), o); });
  const groups = new Map();
  for (const l of kin.links || []) {
    const g = new THREE.Group();
    g.name = `link:${l.id}`; g.userData.link = l.id; g.userData.joint = l.joint || null;
    g.matrixAutoUpdate = false;
    groups.set(l.id, g);
  }
  for (const l of kin.links || []) {                 // nest by parent (a dangling parent -> root)
    const g = groups.get(l.id);
    const parent = l.parent && groups.get(l.parent);
    (parent || inst).add(g);
    for (const name of l.parts || []) {
      const node = byKey.get(nodeKey(name));
      if (node) { node.removeFromParent(); g.add(node); }
    }
  }
  root.userData.links = groups;
  root.userData.kinematics = kin;
}
/* per-link render hints: a link with material "glass" gets a translucent
   material (shared by its meshes; selection / failure emissive still applies) */
/* the links of a (ghost) body painted red: the parts at fault in a refused plan (2026-10-26) */
function paintLinks(root, links) {
  const groups = root.userData.links; if (!groups || !links || !links.length) return;
  for (const id of links) {
    const g = groups.get(id); if (!g) continue;
    g.traverse(o => {
      if (!o.isMesh || !o.userData.body) return;
      if (!o.userData.failMat) o.userData.failMat = new THREE.MeshStandardMaterial({ color: COLORS.fail, emissive: COLORS.fail, emissiveIntensity: 0.4,
                                                                                    transparent: true, opacity: 0.6, depthWrite: false, roughness: 0.5 });
      o.material = o.userData.failMat;
    });
  }
}
function applyLinkMaterials(root, kin) {
  const groups = root.userData.links; if (!groups) return;
  for (const l of kin.links || []) {
    if (l.material !== "glass") continue;
    const g = groups.get(l.id); if (!g) continue;
    const glass = glassMaterial();
    g.traverse(o => { if (o.isMesh && o.userData.body) { o.material = glass; o.renderOrder = 5; } });
  }
}
/* joint transform in the model frame: revolute = turn about the axis
   through point_mm by factor × (value - modelled) degrees; prismatic =
   slide along the axis by factor × (value - modelled) mm. Mirrors
   Joint.transform (model.py). */
function jointMatrix(j, value) {
  const d = ((value == null ? (j.modelled || 0) : value) - (j.modelled || 0)) * (j.factor == null ? 1 : j.factor);
  const a = unitUp(j.axis || [0, 0, 1]);
  const m = new THREE.Matrix4();
  if (j.type === "prismatic") return m.makeTranslation(a.x * d, a.y * d, a.z * d);
  const p = new THREE.Vector3(...(j.point_mm || [0, 0, 0]));
  const r = new THREE.Matrix4().makeRotationAxis(a, THREE.MathUtils.degToRad(d));
  return m.makeTranslation(p.x, p.y, p.z).multiply(r).multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
}
function clampJoint(j, v) {
  const r = j.range || [0, 0], lo = Math.min(r[0], r[1]), hi = Math.max(r[0], r[1]);
  return Math.min(Math.max(v == null ? (j.modelled || 0) : v, lo), hi);
}
/* every joint's value from a partial dict — mirrors Kinematics.values:
   a missing input = its as-modelled value, clamped; a mimic joint =
   factor × master + offset */
function resolveJoints(kin, joints) {
  const out = {}, src = joints || {};
  const all = (kin.links || []).map(l => l.joint).filter(Boolean);
  for (const j of all) if (!j.mimic) out[j.id] = clampJoint(j, src[j.id]);
  for (const j of all) if (j.mimic) {
    const m = all.find(x => x.id === j.mimic.joint);
    const master = out[j.mimic.joint] != null ? out[j.mimic.joint] : (m ? (m.modelled || 0) : 0);
    out[j.id] = clampJoint(j, master * (j.mimic.factor == null ? 1 : j.mimic.factor) + (j.mimic.offset || 0));
  }
  return out;
}
function applyJoints(root, joints) {
  const groups = root.userData.links; if (!groups) return;
  const kin = root.userData.kinematics, fixes = root.userData.fixes;
  const vals = kin ? resolveJoints(kin, joints) : (joints || {});
  for (const g of groups.values()) {
    const j = g.userData.joint;
    g.matrix.copy(j ? jointMatrix(j, vals[j.id]) : new THREE.Matrix4());
    const f = fixes && fixes.get(g.userData.link);
    if (f) g.matrix.multiply(f);                       // then the link where its measured tag has it (linkFixes)
    g.matrixWorldNeedsUpdate = true;
  }
}
/* EVERY LINK FOLLOWS ITS OWN MEASURED TAG (operator 2026-10-25; the same maths as
   Scene.link_fix): for a link a joint moves, the transform in the link's own frame
   taking its CAD to where its measured accurate tag says — measured frame × inverse
   of the tag's CAD frame (pointBasis at point_mm). The root link has none (the
   placement itself is that measurement); an approx tag places nothing. */
function linkFixes(it) {
  const out = new Map();
  const kin = it.kinematics, meas = it.measured;
  if (!kin || !meas) return out;
  const root = (kin.links || []).find(l => !l.parent);
  for (const tg of it.tags || []) {
    if (!tg.link || (root && tg.link === root.id) || tg.accuracy === "approx" || out.has(tg.link)) continue;
    const s = meas[String(tg.tag_id)]; if (!s || !s.R || !s.p) continue;
    const M = new THREE.Matrix4().set(s.R[0][0], s.R[0][1], s.R[0][2], s.p[0],
                                      s.R[1][0], s.R[1][1], s.R[1][2], s.p[1],
                                      s.R[2][0], s.R[2][1], s.R[2][2], s.p[2], 0, 0, 0, 1);
    const C = pointBasis(tg.up || [0, 0, 1], tg.x_axis).setPosition(new THREE.Vector3(...(tg.point_mm || [0, 0, 0])));
    out.set(tg.link, M.multiply(C.invert()));
  }
  return out;
}

function buildItem(it, selected = S.selected) {
  const g = new THREE.Group();
  g.userData.pid = it.id;
  g.position.set(it.x, it.y, it.z || 0);
  g.quaternion.copy(poseQuaternion(it.rot, it.up));
  const mat = material(it);
  // a mated item (it.parent) is re-parented into its host's node by
  // render(): its body hangs from its DRIVEN point instead of its anchor
  const mount = it.parent && it.parent.mount;
  g.add(makeBody(mount && it.model ? { ...it, model: { ...it.model, origin: mount.point } } : it, mat));
  if (it.model && it.model.features) loadFeatures(it.model.features);   // warm the picker
  if (it.fail) {
    const [w, d, h] = it.size;
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w + 8, d + 8, h + 8)),
                                       new THREE.LineBasicMaterial({ color: COLORS.fail }));
    box.position.z = h / 2;
    g.add(box);
  }
  for (const s of it.slots || []) {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(16, 16, 2, 24),
                                new THREE.MeshStandardMaterial({ color: s.full ? COLORS.slotFull : COLORS.slot, roughness: 0.8 }));
    disc.geometry.rotateX(Math.PI / 2);
    const up = unitUp(s.up);
    disc.position.set(s.x + up.x, s.y + up.y, (s.z || 0) + up.z);
    disc.quaternion.setFromUnitVectors(Z_UP, up);
    disc.userData.pid = it.id;
    g.add(disc);
    g.add(sprite(s.id, 0x5b7fbf, 14, [s.x + up.x * 22, s.y + up.y * 22, (s.z || 0) + up.z * 22]));
  }
  if (it.tags && it.tags.length) {                 // AprilTags on their links (rest frame): follow the joints
    const place = () => {
      const root = g.children.find(c => c.userData.bodyRoot);
      for (const tg of it.tags) {
        const lg = root && linkGroup(root, tg.link);
        const m = tagMesh(tg);
        if (lg) lg.add(m); else if (root) root.add(m); else g.add(m);
      }
    };
    if (it.model && it.kinematics) { const root = g.children.find(c => c.userData.bodyRoot); root.userData.whenLinked.push(place); }
    else place();
  }
  const h = it.size[2];
  const lines = [it.label, it.sub].filter(Boolean);
  const lab = sprite(lines.join("\n"), it.kind === "module" ? 0x1a1a1a : 0xa85f12, it.kind === "module" ? 17 : 15,
                     [0, 0, h + 28]);
  lab.userData.unrotate = true;
  g.add(lab);
  highlight(g, it.id === selected);
  return g;
}

function buildReach(it) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(it.reach - 6, it.reach, 96),
                              new THREE.MeshBasicMaterial({ color: COLORS.reach, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
  ring.position.set(it.x, it.y, 0.6);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(it.reach, 96),
                              new THREE.MeshBasicMaterial({ color: COLORS.reach, transparent: true, opacity: 0.04, side: THREE.DoubleSide }));
  disc.position.set(it.x, it.y, 0.4);
  const g = new THREE.Group(); g.add(ring, disc); return g;
}

function buildArrow(a) {
  const p0 = new THREE.Vector3(...a.from), p2 = new THREE.Vector3(...a.to);
  const mid = p0.clone().add(p2).multiplyScalar(0.5);
  mid.z = Math.max(p0.z, p2.z) + Math.max(80, p0.distanceTo(p2) * 0.35);
  const curve = new THREE.QuadraticBezierCurve3(p0, mid, p2);
  const g = new THREE.Group();
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 32, 3, 8, false),
                              new THREE.MeshStandardMaterial({ color: COLORS.arrow, roughness: 0.5 }));
  g.add(tube);
  const cone = new THREE.Mesh(new THREE.ConeGeometry(9, 24, 16), tube.material);
  cone.userData.sharedMat = true;
  const t = curve.getTangent(0.98).normalize();
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), t);
  cone.position.copy(curve.getPoint(0.97));
  g.add(cone);
  if (a.label) g.add(sprite(a.label, 0xa8520f, 16, [mid.x, mid.y, mid.z + 24]));
  return g;
}

/* text sprite (canvas texture); mirrored root -> flip the sprite back */
function sprite(text, color, px, pos) {
  const key = `${text}|${color}|${px}`;
  let mat = S.spriteCache.get(key);
  if (!mat) {
    const lines = String(text).split("\n");
    const cv = document.createElement("canvas");
    const ctx = cv.getContext("2d");
    const fpx = px * 4;
    ctx.font = `600 ${fpx}px system-ui, Segoe UI, sans-serif`;
    const wpx = Math.max(...lines.map(l => ctx.measureText(l).width)) + 24;
    cv.width = Math.ceil(wpx); cv.height = Math.ceil(fpx * 1.25 * lines.length + 16);
    ctx.font = `600 ${fpx}px system-ui, Segoe UI, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillStyle = "#" + color.toString(16).padStart(6, "0");
    lines.forEach((l, i) => ctx.fillText(l, cv.width / 2, 8 + i * fpx * 1.25));
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    mat.userData = { w: cv.width / 4, h: cv.height / 4 };
    S.spriteCache.set(key, mat);
  }
  const sp = new THREE.Sprite(mat);
  sp.userData.sharedMat = true;
  sp.scale.set(mat.userData.w, mat.userData.h, 1);
  sp.position.set(...pos);
  sp.renderOrder = 10;
  return sp;
}

/* --------------------------------------------------------------- pose */
function unitUp(u) {
  const v = Array.isArray(u) && u.length === 3 ? new THREE.Vector3(u[0], u[1], u[2]) : new THREE.Vector3(0, 0, 1);
  return v.lengthSq() < 1e-12 ? new THREE.Vector3(0, 0, 1) : v.normalize();
}
/* a MATED item's turn inside its host (spec §10.2): its driven point's
   direction `n` (out of the item) onto minus the driving point's
   direction `d` (out of the host) — the two face each other — then its
   own rot_deg spin about that axis. Anti-parallel = half a turn about x
   (the model's +x stays +x). */
/* MATING POSE (operator 2026-10-23: "they are paired the same connector
   orientation"): the driven point's whole FRAME is laid onto the driving
   point's frame — same z, same x (y = z × x) — then the item's own
   rotation° spins it about that shared z (normally 0). d / n = driving /
   driven direction (z), dx / nx = their x axes (made ⟂ z here; a missing x
   = the model's +x laid flat, else +y, like model.frame_x). */
function pointBasis(z, x) {
  const zz = unitUp(z);
  let xx = x ? new THREE.Vector3(...x) : new THREE.Vector3(1, 0, 0);
  xx.addScaledVector(zz, -xx.dot(zz));
  if (xx.lengthSq() < 1e-8) { xx = new THREE.Vector3(0, 1, 0); xx.addScaledVector(zz, -xx.dot(zz)); }
  xx.normalize();
  const yy = new THREE.Vector3().crossVectors(zz, xx);
  return new THREE.Matrix4().makeBasis(xx, yy, zz);
}
function mateQuaternion(d, n, rotDeg, dx = null, nx = null) {
  const Rd = pointBasis(d, dx), Rn = pointBasis(n, nx);
  const q = new THREE.Quaternion().setFromRotationMatrix(Rd.multiply(Rn.transpose()));   // driven frame -> driving frame
  // a SIDE ENTRY (2026-10-27, scene.py mate_world): the pair's z (the way in) horizontal — rot_deg turns about the host's
  // vertical through the point (the seat round about the vertical), not about the way in
  const ud = unitUp(d);
  const axis = Math.abs(ud.z) < 0.7 ? Z_UP.clone() : ud;
  return new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(rotDeg || 0)).multiply(q);
}
/* yaw about the item's vertical (model files are z-up), then turn that
   vertical onto `up` (z on the bench, or the seat's axis when hosted in
   a tilted holds point) */
function poseQuaternion(rotDeg, up) {
  const q = new THREE.Quaternion().setFromAxisAngle(Z_UP, THREE.MathUtils.degToRad(rotDeg || 0));
  const u = up ? unitUp(up) : Z_UP;
  if (Z_UP.distanceTo(u) > 1e-9) q.premultiply(new THREE.Quaternion().setFromUnitVectors(Z_UP, u));
  return q;
}

/* ------------------------------------------------- CAD feature snapping
   <model>.features.json (twin/cad.py): exact faces / bores / rims from
   the STEP, in the model frame — the same frame as the glTF. */
function loadFeatures(url) {
  let e = S.featCache.get(url);
  if (!e) {
    e = { data: null, promise: null };
    e.promise = fetch(url).then(r => (r.ok ? r.json() : null)).then(d => { e.data = d; return d; }).catch(() => null);
    S.featCache.set(url, e);
  }
  return e.promise;
}
function featuresFor(url) { const e = url && S.featCache.get(url); return e ? e.data : null; }
const _v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const NEAR_MM = 8;                          // auto mode: a click this close to a corner / edge midpoint takes it
const NEAR_PX = 12;                         // ... or this close on screen (zoomed out, 8 mm is a few pixels)
const _closed = (e) => _v3(e.start).distanceTo(_v3(e.end)) < 1e-3;   // a full circle: no corner, no midpoint
/* is p inside the face's outer outline? The outline is the edge starts
   (plus the midpoint of curved edges), projected onto the face plane;
   a face without edges falls back to its bbox (already checked). */
function insideFace(face, p, nrm) {
  const edges = face.edges || [];
  if (edges.length < 3) return true;
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(u.dot(nrm)) > 0.9) u.set(0, 1, 0);
  u.addScaledVector(nrm, -u.dot(nrm)).normalize();
  const v = new THREE.Vector3().crossVectors(nrm, u);
  const pts = [];
  for (const e of edges) {
    pts.push(_v3(e.start));
    if (e.kind !== "line") pts.push(_v3(e.mid));
  }
  const px = p.dot(u), py = p.dot(v);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].dot(u), yi = pts[i].dot(v), xj = pts[j].dot(u), yj = pts[j].dot(v);
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-12) + xi) inside = !inside;
  }
  if (inside) return true;
  // on the boundary counts (clicks land on edges / corners): within 1 mm of any segment
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j], b = pts[i], ab = b.clone().sub(a), t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / (ab.lengthSq() || 1e-12)));
    if (a.clone().addScaledVector(ab, t).distanceTo(p) < 1.0) return true;
  }
  return false;
}
/* a planar face's boundary points (from features.json edges): corners =
   edge starts, midpoints of every open edge (straight or curved; a full
   circle has neither). kind: any | corner | edge */
function facePoints(face, kind) {
  const pts = [];
  (face.edges || []).forEach((e, k) => {
    if (_closed(e)) return;
    if (kind !== "edge") pts.push({ kind: "corner", id: `c${k + 1}`, at: _v3(e.start), face });
    if (kind !== "corner") pts.push({ kind: "edge", id: e.id, at: _v3(e.mid), length: e.length, face });
  });
  return pts;
}
const _pointResult = (q) => ({ kind: q.kind, count: 1, point: q.at, up: _v3(q.face.normal), length: q.length,
                               feature: { kind: q.kind, id: `${q.face.id}/${q.id}`, face: q.face.id } });
/* forced corner / edge mode: the nearest one on the hit face, any distance */
function pointSnap(face, p, kind) {
  const best = facePoints(face, kind).reduce((b, q) => { const d = q.at.distanceTo(p); return (!b || d < b.d) ? { ...q, d } : b; }, null);
  return best ? _pointResult(best) : null;
}
/* auto mode: the NEAREST corner or edge midpoint within `reach` mm of p —
   on ANY planar face, not only the one hit (next to a short edge the
   click often lands on a neighbouring face — a fillet, a step — that
   does not own it), skipping faces turned away from the viewer. Plain
   nearest-wins, no corner priority: on a short edge the midpoint sits a
   few mm from both corners, and a priority would make it unpickable.
   The same spot shared by several faces takes the hit face's normal,
   else the face turned most towards the viewer. */
function nearPoint(feats, p, n, reach, hitIds) {
  const b = nearPointD(feats, p, n, reach, hitIds);
  return b ? _pointResult(b) : null;
}
function nearPointD(feats, p, n, reach, hitIds) {
  let best = null;
  for (const f of feats.planes || []) {
    const [lo, hi] = f.bbox;
    if (p.x < lo[0] - reach || p.x > hi[0] + reach || p.y < lo[1] - reach || p.y > hi[1] + reach || p.z < lo[2] - reach || p.z > hi[2] + reach) continue;
    const facing = n ? n.dot(_v3(f.normal)) : 1;
    if (facing < -0.2) continue;
    const pref = (hitIds.has(f.id) ? 2 : 0) + facing;
    for (const q of facePoints(f, "any")) {
      const d = q.at.distanceTo(p);
      if (d > reach) continue;
      if (!best || d < best.d - 0.25 || (Math.abs(d - best.d) <= 0.25 && pref > best.pref)) best = { ...q, d, pref };
    }
  }
  return best;
}

/* CIRCLE CENTRES (2026-10-22): every full circular edge (features.circles,
   exact from the B-rep) and every circular edge of a planar face's
   outline — arcs too (fillets, rounded corners) — whose centre is the
   edge's `center` when features.json records it (cad._outer_edges, newer
   files), else the circle through its B-rep start / mid / end points.
   A click snaps to a centre when it lands close to the CIRCLE itself
   (the centre of a hole is in the air). Hole rims are not in a face's
   OUTER outline, so features.circles is always searched (a tag pick
   takes the face under the click, snapHit). */
function circumcentre(a, b, c) {
  const ab = b.clone().sub(a), ac = c.clone().sub(a), nn = new THREE.Vector3().crossVectors(ab, ac);
  const l2 = nn.lengthSq();
  if (l2 < 1e-9) return null;
  return a.clone().add(new THREE.Vector3().crossVectors(nn, ab).multiplyScalar(ac.lengthSq())
    .add(new THREE.Vector3().crossVectors(ac, nn).multiplyScalar(ab.lengthSq())).multiplyScalar(1 / (2 * l2)));
}
function circleCentres(feats, p, reach) {
  const out = [];
  for (const r of feats.circles || [])
    out.push({ id: r.id, centre: _v3(r.center), normal: _v3(r.normal), radius: r.radius });
  for (const f of feats.planes || []) {
    const [lo, hi] = f.bbox;
    if (reach != null && (p.x < lo[0] - reach || p.x > hi[0] + reach || p.y < lo[1] - reach || p.y > hi[1] + reach ||
                          p.z < lo[2] - reach || p.z > hi[2] + reach)) continue;
    for (const e of f.edges || []) {
      if (e.kind !== "circle") continue;
      if (_closed(e)) continue;                            // a full circle: already in features.circles
      const c = e.center ? _v3(e.center) : circumcentre(_v3(e.start), _v3(e.mid), _v3(e.end));
      if (!c) continue;
      out.push({ id: `${f.id}/${e.id}`, face: f.id, centre: c, normal: _v3(f.normal), radius: c.distanceTo(_v3(e.start)) });
    }
  }
  return out;
}
const circleDist = (q, p) => {
  const rel = p.clone().sub(q.centre), t = rel.dot(q.normal);
  return Math.hypot(rel.addScaledVector(q.normal, -t).length() - q.radius, t);
};
function circleSnapD(feats, p, n, reach) {
  let best = null;
  for (const q of circleCentres(feats, p, reach)) {
    const d = circleDist(q, p);
    if ((reach == null || d <= reach) && (!best || d < best.d)) best = { ...q, d };
  }
  if (!best) return null;
  const up = best.normal.clone(); if (n && n.dot(up) < 0) up.negate();   // out of the item, towards the viewer
  return { d: best.d, res: { kind: "circle", count: 1, point: best.centre, up, radius: best.radius,
                             feature: { kind: "circle", id: best.id, ...(best.face ? { face: best.face } : {}) } } };
}

/* AUXILIARY POINTS (role "aux", 2026-10-22): helpers picked on the
   model; the MIDPOINT of any two (on the same link as the click) is a
   snap target — the centre of a pocket from two opposite corners, of a
   slot from its two ends. Matched by its distance to the cursor RAY (a
   midpoint may float over a hole); its direction = the two points'
   mean direction (or the hit face's). opts.aux = [{id, point_mm, up,
   link}], opts.ray = {o, d} in the click's frame, opts.link. */
function auxSnapD(p, n, opts, reach) {
  const aux = (opts.aux || []).filter(a => (a.link || "") === (opts.link || ""));
  if (aux.length < 2 || !opts.ray) return null;
  let best = null;
  for (let i = 0; i < aux.length; i++) for (let j = i + 1; j < aux.length; j++) {
    const m = _v3(aux[i].point_mm).add(_v3(aux[j].point_mm)).multiplyScalar(0.5);
    const d = m.clone().sub(opts.ray.o).cross(opts.ray.d).length();
    if ((reach == null || d <= reach) && (!best || d < best.d)) best = { d, m, a: aux[i], b: aux[j] };
  }
  if (!best) return null;
  const up = unitUp(best.a.up).add(unitUp(best.b.up));
  if (up.lengthSq() < 1e-6) up.copy(n || Z_UP);
  up.normalize();
  return { d: best.d, res: { kind: "aux", count: 1, point: best.m, up,
                             feature: { kind: "aux", id: `${best.a.id}+${best.b.id}` } } };
}
/* opts: reach = auto mode's corner / midpoint distance (mm, default
   NEAR_MM); planar = planar faces only (an AprilTag: no bores / rims) */
function featureSnap(feats, p, n, snap, opts = {}) {
  if (snap === "aux") { const a = auxSnapD(p, n, opts, null); return a ? a.res : null; }   // forced: nearest aux midpoint
  if (!feats) { const a = snap === "auto" ? auxSnapD(p, n, opts, opts.reach || NEAR_MM) : null; return a ? a.res : null; }
  if (snap === "circle") { const c = circleSnapD(feats, p, n, null); return c ? c.res : null; }
  const cands = [];
  const wantPoint = snap === "corner" || snap === "edge";
  if (snap !== "flat" && !wantPoint && !opts.planar) {
    for (const c of feats.cylinders || []) {
      const axis = _v3(c.axis), rel = p.clone().sub(_v3(c.point));
      const t = rel.dot(axis), radial = rel.clone().addScaledVector(axis, -t).length();
      if (Math.abs(radial - c.radius) > 0.6 || t < -1 || t > c.length + 1) continue;
      if (n && Math.abs(n.dot(axis)) > 0.15) continue;                    // wall normal ⟂ axis
      cands.push({ kind: "cylinder", point: _v3(c.point), up: axis, radius: c.radius, length: c.length,
                   feature: c, size: c.area });
    }
  }
  if (snap !== "round") {
    for (const f of feats.planes || []) {
      const nrm = _v3(f.normal);
      if (Math.abs(p.clone().sub(_v3(f.center)).dot(nrm)) > 0.6) continue;
      const [lo, hi] = f.bbox;
      if (p.x < lo[0] - 1 || p.x > hi[0] + 1 || p.y < lo[1] - 1 || p.y > hi[1] + 1 || p.z < lo[2] - 1 || p.z > hi[2] + 1) continue;
      if (n && Math.abs(n.dot(nrm)) < 0.98) continue;
      if (!insideFace(f, p, nrm)) continue;               // the real outline, not just the bbox
      cands.push({ kind: "face", point: _v3(f.center), up: nrm, area: f.area, feature: f, size: f.area });
    }
  }
  if (wantPoint) {                                   // forced: the nearest one on the (smallest) hit face
    const fc = cands.filter(c => c.kind === "face").sort((a, b) => a.size - b.size)[0];
    return fc ? pointSnap(fc.feature, p, snap) : null;
  }
  if (snap === "auto") {
    // taken only when the click is right next to one: the NEAREST of a
    // corner / edge midpoint, a circle (-> its centre), an aux midpoint
    const reach = opts.reach || NEAR_MM;
    const pt = nearPointD(feats, p, n, reach, new Set(cands.filter(c => c.kind === "face").map(c => c.feature.id)));
    // a circle wins a near-tie (within 0.5 mm): on a short arc its own
    // midpoint is always about as close as the arc, and the centre is the
    // useful point (the arc midpoint stays reachable with snap = edge)
    const circ = circleSnapD(feats, p, n, reach);
    if (circ) circ.d = Math.max(0, circ.d - 0.5);
    const near = [pt ? { d: pt.d, res: _pointResult(pt) } : null, circ,
                  auxSnapD(p, n, opts, reach)].filter(Boolean).sort((a, b) => a.d - b.d);
    if (near.length) return near[0].res;
  }
  if (!cands.length && snap !== "flat" && !opts.planar) {
    for (const r of feats.circles || []) {                                  // a rim: its centre
      const nrm = _v3(r.normal), rel = p.clone().sub(_v3(r.center));
      const t = rel.dot(nrm), radial = rel.clone().addScaledVector(nrm, -t).length();
      if (Math.abs(radial - r.radius) > 1.5 || Math.abs(t) > 1.5) continue;
      cands.push({ kind: "circle", point: _v3(r.center), up: nrm, radius: r.radius, feature: r, size: r.radius });
    }
  }
  if (!cands.length) return null;
  // a bore beats the plate it is cut into (they only coincide at the rim);
  // among faces the smallest one containing the point wins
  cands.sort((a, b) => (a.kind === "cylinder") !== (b.kind === "cylinder") ? (a.kind === "cylinder" ? -1 : 1) : a.size - b.size);
  const c = cands[0];
  return { kind: c.kind, count: 1, point: c.point, up: c.up, radius: c.radius, length: c.length, area: c.area,
           feature: { kind: c.kind, id: c.feature.id } };
}

/* ------------------------------------------------------------- AprilTags
   A tag (mating point role "tag", twin/tags.py) is drawn as a square the
   size of the printed tag INCLUDING its white border, textured with the
   family's real bit pattern: exactly apriltag.c's apriltag_to_image —
   all black, a 1-cell white ring of width (width_at_border + 2, or
   width_at_border when the border is reversed), then every set code bit
   white (MSB first, cells bit_x / bit_y inside the border square). The
   family tables are vendored under /static/vendor/apriltag/. The tag
   frame: x = x_axis (right), z = up (out of the face), y = z × x (top). */
const TAG_FAMILIES = new Map();            // family -> {data|null, promise}
const TAG_TEX = new Map();                 // family|id -> CanvasTexture
function loadFamily(name) {
  let e = TAG_FAMILIES.get(name);
  if (!e) {
    e = { data: null, promise: null };
    e.promise = fetch(`/static/vendor/apriltag/${name}.json`).then(r => (r.ok ? r.json() : null))
      .then(d => { e.data = d; return d; }).catch(() => null);
    TAG_FAMILIES.set(name, e);
  }
  return e.promise;
}
function tagBitmap(fam, id) {
  const W = fam.total_width, cells = new Uint8Array(W * W);      // 0 = black, 1 = white
  const wb = fam.width_at_border + (fam.reversed_border ? 0 : 2), ws = Math.floor((W - wb) / 2);
  for (let i = 0; i < wb - 1; i++) {                               // the 1-cell white ring
    cells[ws * W + ws + i] = 1;
    cells[(ws + i) * W + W - 1 - ws] = 1;
    cells[(W - 1 - ws) * W + ws + i + 1] = 1;
    cells[(ws + 1 + i) * W + ws] = 1;
  }
  const bs = Math.floor((W - fam.width_at_border) / 2);
  const code = BigInt("0x" + fam.codes[id]);
  for (let i = 0; i < fam.nbits; i++) {
    if ((code >> BigInt(fam.nbits - i - 1)) & 1n) cells[(fam.bit_y[i] + bs) * W + fam.bit_x[i] + bs] = 1;
  }
  return { W, cells };
}
function tagTexture(fam, id) {
  const key = `${fam.name}|${id}`;
  let tex = TAG_TEX.get(key);
  if (tex) return tex;
  const { W, cells } = tagBitmap(fam, id);
  const px = 16, cv = document.createElement("canvas");
  cv.width = W * px; cv.height = W * px;
  const ctx = cv.getContext("2d");
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    ctx.fillStyle = cells[y * W + x] ? "#ffffff" : "#000000";
    ctx.fillRect(x * px, y * px, px, px);                          // row 0 = the tag's TOP edge
  }
  tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  TAG_TEX.set(key, tex);
  return tex;
}
/* a tag square at {point_mm, up, x_axis} (in the parent group's frame): a
   plane whose +z is the normal, x the tag's x; the pattern loads async */
function tagMesh(tag) {
  const size = +(tag.size_mm || 40);
  const geo = new THREE.PlaneGeometry(size, size);                 // in XY, facing +z; image top = +y
  const mat = new THREE.MeshBasicMaterial({ color: 0x888888, side: THREE.DoubleSide });
  const m = new THREE.Mesh(geo, mat);
  const z = unitUp(tag.up), x = unitUp(tag.x_axis || [1, 0, 0]);
  x.addScaledVector(z, -x.dot(z)).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  m.matrixAutoUpdate = false;
  m.matrix.makeBasis(x, y, z).setPosition(new THREE.Vector3(...(tag.point_mm || [0, 0, 0])).addScaledVector(z, 0.15));
  m.userData.tag = true;
  const fam = tag.family || "tag16h5", id = +(tag.tag_id != null ? tag.tag_id : (tag.id || 0));
  loadFamily(fam).then(f => {
    if (!f || !m.parent) return;
    if (id >= f.codes.length) { mat.color.set(0xc0392b); requestRender(); return; }   // no such id in the family
    mat.map = tagTexture(f, id); mat.color.set(0xffffff); mat.needsUpdate = true;
    requestRender();
  });
  return m;
}

/* marker: a ring (feature radius or 10 mm) + an axis line at a point (in
   the parent group's frame) along `up`; used for the hover preview and
   for drawing a type's mating points */
function pointMarker(point, up, color, radius, len = 30, label = null) {
  const h = new THREE.Group();
  const r = radius || 10;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r, Math.max(0.8, r * 0.06), 8, 48),
                              new THREE.MeshBasicMaterial({ color, depthTest: false }));
  ring.renderOrder = 20;
  const u = unitUp(up);
  ring.quaternion.setFromUnitVectors(Z_UP, u);
  const pt = _v3(point);
  ring.position.copy(pt);
  const line = new THREE.BufferGeometry().setFromPoints([pt, pt.clone().addScaledVector(u, len)]);
  const axis = new THREE.Line(line, new THREE.LineBasicMaterial({ color, depthTest: false }));
  axis.renderOrder = 20;
  h.add(ring, axis);
  if (label) h.add(sprite(label, color, 14, [pt.x + u.x * (len + 12), pt.y + u.y * (len + 12), pt.z + u.z * (len + 12)]));
  return h;
}
/* a mounting / aux point's FRAME (2026-10-22): x red, y green, z blue
   arrows from `point` (z = up, x = x_axis made perpendicular, y = z × x),
   drawn on top — only for the point selected in the Library viewer */
const AXIS_COLORS = { x: 0xe53935, y: 0x2e9d48, z: 0x1e6fe0 };
function frameTriad(point, up, xAxis, len = 40, thick = 1) {
  const g = new THREE.Group();
  const z = unitUp(up), x = unitUp(xAxis || [1, 0, 0]);
  x.addScaledVector(z, -x.dot(z));
  if (x.lengthSq() < 1e-9) x.set(1, 0, 0).addScaledVector(z, -z.x);
  x.normalize();
  const y = new THREE.Vector3().crossVectors(z, x), o = _v3(point);
  for (const [name, d] of [["x", x], ["y", y], ["z", z]]) {
    const mat = new THREE.MeshBasicMaterial({ color: AXIS_COLORS[name], depthTest: false });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.9 * thick, 0.9 * thick, len, 8), mat);
    const head = new THREE.Mesh(new THREE.ConeGeometry(3 * thick, 9, 12), mat);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    shaft.quaternion.copy(q); head.quaternion.copy(q);
    shaft.position.copy(o).addScaledVector(d, len / 2);
    head.position.copy(o).addScaledVector(d, len + 4.5);
    shaft.renderOrder = head.renderOrder = 30;
    g.add(shaft, head, sprite(name, AXIS_COLORS[name], 13, o.clone().addScaledVector(d, len + 16).toArray()));
  }
  return g;
}
/* the bench frame's axes as a VIEW TRIAD (2026-10-25, operator: not at the origin — "always at the bottom
   left of the screen, like most CAD software"): a small scene of its own drawn into the bottom-left corner
   of a bench view after the scene, turned like the view's camera, so it never moves with the bench or hides
   behind an item */
const TRIAD_PX = 128;
function viewTriad() {
  const scene = new THREE.Scene();
  scene.add(frameTriad([0, 0, 0], [0, 0, 1], [1, 0, 0], 40, 1.6));
  const camera = new THREE.OrthographicCamera(-68, 68, 68, -68, 1, 1000);
  return { scene, camera, dir: new THREE.Vector3() };
}
function renderView(renderer, scene, camera, triad) {
  renderer.render(scene, camera);
  if (!triad) return;
  const size = renderer.getSize(new THREE.Vector2());
  renderer.autoClear = false;
  renderer.clearDepth();
  renderer.setScissorTest(true);
  renderer.setScissor(0, 0, TRIAD_PX, TRIAD_PX);
  renderer.setViewport(0, 0, TRIAD_PX, TRIAD_PX);
  triad.dir.set(0, 0, 1).applyQuaternion(camera.quaternion);   // a camera looks down its own -z
  triad.camera.position.copy(triad.dir).multiplyScalar(400);
  triad.camera.quaternion.copy(camera.quaternion);
  renderer.render(triad.scene, triad.camera);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, size.x, size.y);
  renderer.autoClear = true;
}
function linkGroup(root, link) {
  const groups = root && root.userData.links;
  return (link && groups && groups.get(link)) || null;
}
function showHover(pid, res) {
  const g = S.groups.get(pid);
  const key = res ? `${pid}|${res.kind}|${res.link || ""}|${res.local.join(",")}` : "";
  if (key === S.hoverKey) return;
  S.hoverKey = key;
  if (S.hover) { S.hover.parent && S.hover.parent.remove(S.hover); disposeGroup(S.hover); S.hover = null; }
  if (!res || !g) { requestRender(); return; }
  // a point on a moving link is drawn in that link's frame (model coords) so it follows the joint
  const root = g.children.find(c => c.userData.bodyRoot), lg = linkGroup(root, res.link);
  S.hover = lg ? pointMarker(res.model, res.up, COLORS.selected, res.radius) : pointMarker(res.local, res.up, COLORS.selected, res.radius);
  (lg || g).add(S.hover);
  requestRender();
}

/* a raycast hit on an item's body -> snapped point. `snap`: auto | flat |
   round | corner | edge | point; `feats` = the item's parsed
   features.json or null; `opts`: viewH = the view's height in px (auto
   mode's reach becomes max(NEAR_MM, NEAR_PX on screen)), planar = an
   AprilTag pick (planar faces only; snap = point still records the face
   under the click). The
   hit only identifies the spot; the coordinates come from the CAD
   feature matched there (no mesh fitting — spec §10.2). Without
   features, or with snap = point, it is the raw click. Coordinates:
   `model` = in the model file's own frame (what a mating point stores),
   `local` = relative to the item's anchor; `up` in the item's frame. */
function bodyRootOf(obj) {
  let o = obj;
  while (o && !o.userData.bodyRoot) o = o.parent;
  return o;
}
/* the frame a picked point is stored in: the LINK's rest frame when the
   hit part belongs to a link (its group's local frame is the model frame
   before the joint transform), else the body root (= model frame) */
function frameOf(obj, root) {
  let o = obj, link = "";
  while (o && o !== root) { if (o.userData.link) { link = o.userData.link; break; } o = o.parent; }
  return { frame: link ? o : root, link };
}
function snapHit(hit, snap, feats, camera = S.camera, opts = {}) {
  const obj = hit.object, root = bodyRootOf(obj);
  if (!root) return null;
  const { frame, link } = frameOf(obj, root);
  const local = frame.worldToLocal(hit.point.clone());      // model file frame (link at rest)
  const n0 = new THREE.Vector3(0, 0, 1);
  let res = { kind: "point", count: 1, point: local.clone(), up: n0.clone() };
  if (obj.userData.body && hit.face) {
    // triangle normal, taken from the hit object's frame into the model frame
    const toFrame = new THREE.Matrix4().copy(frame.matrixWorld).invert().multiply(obj.matrixWorld);
    n0.copy(hit.face.normal).transformDirection(toFrame);
    if (camera) {                                             // face the viewer
      const dir = frame.worldToLocal(hit.point.clone().add(camera.getWorldDirection(new THREE.Vector3()))).sub(local);
      if (n0.dot(dir) > 0) n0.negate();
    }
    let reach = NEAR_MM;
    if (camera && camera.isPerspectiveCamera && opts.viewH) {
      const mmPerPx = 2 * hit.distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / opts.viewH;
      reach = Math.max(NEAR_MM, NEAR_PX * mmPerPx);
    }
    const eye = camera ? frame.worldToLocal(camera.getWorldPosition(new THREE.Vector3())) : null;
    const ray = eye ? { o: eye, d: local.clone().sub(eye).normalize() } : null;
    const fromCad = snap === "point" ? null : featureSnap(feats, local, n0, snap,
      { reach, planar: opts.planar, aux: opts.aux, ray, link });
    if (fromCad) res = fromCad;
    else res.up = n0.clone();
    if (opts.planar && res.feature && res.kind !== "face" && !res.feature.face) {   // a tag needs the face under the click
      const f = featureSnap(feats, local, n0, "flat", { planar: true });
      if (f) res.feature = { ...res.feature, face: f.feature.id };
    }
    if (snap === "point" && opts.planar) {                    // the raw click, on the face it lies on
      const f = featureSnap(feats, local, n0, "flat", { planar: true });
      if (f) { res.up = f.up; res.feature = { kind: "point", face: f.feature.id }; }
    }
  }
  const off = root.position;                                  // body sits at -origin inside its group
  const toArr = (v) => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];
  const out = {
    kind: res.kind, count: res.count,
    model: toArr(res.point),
    local: toArr(res.point.clone().add(off)),
    up: [+res.up.x.toFixed(4), +res.up.y.toFixed(4), +res.up.z.toFixed(4)],
  };
  if (res.radius != null) out.radius = +res.radius.toFixed(2);
  if (res.length != null) out.length = +res.length.toFixed(1);
  if (res.area != null) out.area = +res.area.toFixed(0);
  if (res.feature) out.feature = res.feature;
  if (link) out.link = link;
  return out;
}

/* arm a pick: the next left click on item `pid` returns a snapped point;
   a click anywhere else cancels. The view is locked meanwhile. */
function setPickMode(opts) {
  S.pick = opts || null;
  if (S.controls) S.controls.enabled = !S.pick;
  if (S.renderer) S.renderer.domElement.style.cursor = S.pick ? "crosshair" : "";
  if (!S.pick) showHover(null, null);
  else {
    const it = S.desc && S.desc.items.find(i => i.id === S.pick.pid);
    if (it && it.model && it.model.features) loadFeatures(it.model.features);
  }
}
function itemFeatures(pid) {
  const it = S.desc && S.desc.items.find(i => i.id === pid);
  return it && it.model ? featuresFor(it.model.features) : null;
}

/* ------------------------------------------------------------ render */
/* build a scene description into groups (shared by the bench view and
   the motion view): bench + reach rings + items, mated items nested in
   their host's node, transfer arrows */
function populate(desc, items, overlays, groups, selected) {
  disposeGroup(items); disposeGroup(overlays); groups.clear();
  overlays.add(buildBench(desc.bench, desc.name || "workstation"));
  for (const it of desc.items) if (it.reach) overlays.add(buildReach(it));
  for (const it of desc.items) {
    const g = buildItem(it, selected);
    groups.set(it.id, g);
    items.add(g);
  }
  // mated items hang inside their host's node (spec §10.2): at the driving
  // point, on its link — so they follow the host's moves and joints
  for (const it of desc.items) {
    const hg = it.parent && groups.get(it.parent.id), g = groups.get(it.id);
    if (!hg || !g) continue;
    const root = hg.children.find(c => c.userData.bodyRoot);
    if (!root) continue;
    g.position.set(...it.parent.point);
    g.quaternion.copy(mateQuaternion(it.parent.up, it.parent.mount.up, it.rot, it.parent.x_axis, it.parent.mount.x_axis));
    root.add(g);
    const toLink = () => { const lg = linkGroup(root, it.parent.link); if (lg) lg.add(g); requestRender(); };
    if (it.parent.link) { if (root.userData.links) toLink(); else root.userData.whenLinked.push(toLink); }
  }
  for (const a of desc.arrows || []) overlays.add(buildArrow(a));
}
function render(desc) {
  if (!S.renderer) return;
  const first = !S.desc || S.desc.bench[0] !== desc.bench[0] || S.desc.bench[1] !== desc.bench[1];
  S.desc = desc;
  populate(desc, S.items, S.overlays, S.groups, S.selected);
  if (first) fit(); else requestRender();
}

/* move existing items without rebuilding (future dynamic twin: tween
   poses and joint values) */
function applyPose(poses) {
  for (const p of poses) {
    const g = S.groups.get(p.id); if (!g) continue;
    if (p.x != null) g.position.set(p.x, p.y, p.z || 0);
    if (p.rot != null || p.up) g.quaternion.copy(poseQuaternion(p.rot, p.up));
    if (p.joints) { const root = g.children.find(c => c.userData.bodyRoot); if (root) applyJoints(root, p.joints); }
  }
  requestRender();
}

function setSelected(id) {
  S.selected = id;
  for (const [pid, g] of S.groups) highlight(g, pid === id);
  requestRender();
}

/* ------------------------------------------------------- interaction */
function toNdc(e) {
  const r = S.renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, S.camera);
}
function benchPoint(clientX, clientY) {
  if (!S.renderer) return null;
  toNdc({ clientX, clientY });
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(PLANE, hit)) return null;
  return { x: hit.x, y: hit.y };                    // scene frame == bench frame
}
function pickHit(e) {
  toNdc(e);
  const hits = ray.intersectObjects(S.items.children, true);
  for (const h of hits) {
    let o = h.object;
    while (o && !o.userData.pid) o = o.parent;
    if (o && o.userData.pid) return { pid: o.userData.pid, hit: h };
  }
  return null;
}
function pick(e) { const r = pickHit(e); return r ? r.pid : null; }
/* where the cursor ray meets a (vertical) plane — the Shift + drag lift */
function liftPoint(plane, e) {
  toNdc(e);
  const hit = new THREE.Vector3();
  return ray.ray.intersectPlane(plane, hit) ? hit : null;
}
const pickOpts = (p, el) => ({ viewH: el.clientHeight, planar: !!p.planar });
function wirePointer() {
  const el = S.renderer.domElement;
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (S.pick) {                                    // mating-point pick armed
      const p = S.pick, r = pickHit(e);
      setPickMode(null);
      const snapped = r && r.pid === p.pid ? snapHit(r.hit, p.snap || "auto", itemFeatures(p.pid), S.camera, pickOpts(p, el)) : null;
      if (snapped) p.onPick && p.onPick(snapped);
      else p.onCancel && p.onCancel();
      return;
    }
    const hitId = pick(e);
    if (!hitId) { S.bgClick = { x: e.clientX, y: e.clientY }; return; }   // orbit — or a click on the bench
    // a mated group drags as one: its root host; Ctrl + drag takes the
    // item itself off its host (no snapping on the drop, twin.js)
    let pid = hitId;
    if (!e.ctrlKey) for (let it = S.desc.items.find(i => i.id === pid), n = 0; it && it.parent && n < 20; n++) {
      pid = it.parent.id; it = S.desc.items.find(i => i.id === pid);
    }
    const g = S.groups.get(pid);
    const it = S.desc.items.find(i => i.id === pid);
    if (!it || !g) return;
    const w = g.getWorldPosition(new THREE.Vector3());
    const bp = benchPoint(e.clientX, e.clientY);
    S.drag = { pid, hitId, g, it, moved: false, ctrl: e.ctrlKey, dx: w.x - (bp ? bp.x : w.x), dy: w.y - (bp ? bp.y : w.y),
               x: w.x, y: w.y, z: w.z, locked: !!S.desc.locked || !!it.locked };   // checkpoint view / a locked item
    if (e.shiftKey && !e.ctrlKey) {                  // Shift + drag: straight up / down on a vertical plane facing the camera
      const n = S.camera.getWorldDirection(new THREE.Vector3()).setZ(0);
      if (n.lengthSq() < 1e-6) n.set(0, 1, 0);
      S.drag.vplane = new THREE.Plane().setFromNormalAndCoplanarPoint(n.normalize(), w.clone());
      const h = liftPoint(S.drag.vplane, e);
      S.drag.dz = w.z - (h ? h.z : w.z);
    }
    S.controls.enabled = false;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (S.pick) {                                    // preview the snap under the cursor
      // re-snapped on EVERY move (not per triangle: a big face is two
      // triangles, and its corners / edge midpoints depend on where the
      // cursor is on it); showHover skips redraws of the same result
      const r = pickHit(e);
      const snapped = r && r.pid === S.pick.pid ? snapHit(r.hit, S.pick.snap || "auto", itemFeatures(r.pid), S.camera, pickOpts(S.pick, el)) : null;
      showHover(snapped ? r.pid : null, snapped);
      return;
    }
    if (!S.drag || S.drag.locked) return;
    if (S.drag.vplane) {                             // lift: x / y stay, z follows the cursor, never below the bench
      const h = liftPoint(S.drag.vplane, e); if (!h) return;
      S.drag.z = Math.max(0, h.z + S.drag.dz); S.drag.moved = true;
      S.drag.g.position.set(S.drag.x, S.drag.y, S.drag.z);
      requestRender();
      return;
    }
    const bp = benchPoint(e.clientX, e.clientY); if (!bp) return;
    if (S.drag.g.parent !== S.items) S.items.attach(S.drag.g);   // Ctrl: off its host, world pose kept
    S.drag.x = bp.x + S.drag.dx; S.drag.y = bp.y + S.drag.dy; S.drag.moved = true;
    S.drag.g.position.set(S.drag.x, S.drag.y, S.drag.z || 0);
    requestRender();
  });
  const finish = (e) => {
    if (S.bgClick) {                                 // press on empty space that did not orbit: deselect
      const c = S.bgClick; S.bgClick = null;
      if (!S.drag && Math.hypot(e.clientX - c.x, e.clientY - c.y) < 4) {
        S.handlers.onSelect && S.handlers.onSelect(null);
      }
    }
    if (!S.drag) return;
    const d = S.drag; S.drag = null;
    S.controls.enabled = true;
    try { el.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (d.moved && !d.locked) S.handlers.onMove && S.handlers.onMove(d.pid, Math.round(d.x), Math.round(d.y),
      d.vplane ? { z: Math.round(d.z) } : { ctrl: d.ctrl });
    else S.handlers.onSelect && S.handlers.onSelect(d.hitId);
  };
  el.addEventListener("pointerup", finish);
  el.addEventListener("pointercancel", finish);
  el.addEventListener("dblclick", fit);
}

/* ------------------------------------------------ digital twin in motion
   (spec §10.6) The LOCKED as-set-up snapshot in its own view — orbit /
   pan / zoom only, nothing is dragged or picked — and joint trajectories
   played on it: `play(pid, traj)` eases the arm from its set-up pose onto
   the first sample, then loops the samples (joints interpolated between
   them, the tool-point path drawn); `stop()` puts it back. Shares the
   model / sprite caches and the item builders with the bench view. */
const smooth = (u) => u * u * (3 - 2 * u);
/* the follower's target at time t (s): ramped linearly from `from` to `to` over T */
function followTarget(f, t) {
  const u = Math.min(1, Math.max(0, (t - f.t0) / f.T)), o = {};
  for (const k of Object.keys(f.lim)) o[k] = f.from[k] + (f.to[k] - f.from[k]) * u;
  return o;
}
// live-mirror motion limits of a twin joint (the real PiPER runs at ≤ 30 % here; these only shape the drawing)
const FOLLOW_LIMITS = { revolute: { vmax: 60, amax: 180 },     // deg/s, deg/s²
                        prismatic: { vmax: 80, amax: 300 } };  // mm/s, mm/s²
class MotionView {
  constructor(wrap) {
    this.wrap = wrap;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    wrap.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.width = "100%"; this.renderer.domElement.style.height = "100%";
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 5, 20000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.addEventListener("change", () => this.requestRender());
    this.triad = viewTriad();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(-600, -900, 1400); this.scene.add(sun);
    this.items = new THREE.Group(); this.overlays = new THREE.Group();
    this.scene.add(this.items, this.overlays);
    this.groups = new Map(); this.desc = null; this.needs = false; this.anim = null;
    this.trailOn = true; this.speed = 1;
    S.extraViews.add(() => this.requestRender());
    new ResizeObserver(() => this.resize()).observe(wrap);
    this.renderer.domElement.addEventListener("dblclick", () => this.fit());
    // a click (no orbit) on an item: onPick([pid, its host, …]) — innermost first (spec §10.7)
    this.onPick = null; this.ghostG = null; this.ghostPid = null; this.ghostJ = null; this.live = new Map();
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", (e) => { this.down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; });
    el.addEventListener("pointerup", (e) => {
      const d = this.down; this.down = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || !this.onPick) return;
      this.onPick(this.pickChain(e));
    });
    this.resize();
  }
  pickChain(e) {
    const r = this.renderer.domElement.getBoundingClientRect(), rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    for (const h of rc.intersectObjects(this.items.children, true)) {
      const chain = [];
      for (let o = h.object; o; o = o.parent) {
        if (o.userData.ghost) { chain.length = 0; break; }
        if (o.userData.pid && !o.isMesh && !chain.includes(o.userData.pid)) chain.push(o.userData.pid);
      }
      if (chain.length) return chain;
    }
    return [];
  }
  /* Live mirror of the real module: `joints` is a TARGET the twin chases with
     per-joint velocity / acceleration limits (revolute: deg/s, deg/s²;
     prismatic: mm/s, mm/s²) — readings arrive at ~5 Hz, so jumping to each one
     looks like a seizure. Two stages: (1) the target itself is RAMPED from
     where it was to the new reading over the interval between readings (one
     reading of delay, ~0.2 s), so a moving arm gives a moving target instead of
     a staircase the twin would stop at; (2) each frame a joint's velocity moves
     (by at most accel × dt) toward the speed from which it can still brake:
     v_des = sign(e)·min(vmax, √(2·a·|e|)) — it accelerates, cruises and
     decelerates into the pose. Starts from the pose the twin shows, kept across
     async model loads and scene rebuilds. */
  setJoints(pid, joints) {
    if (this.anim && this.anim.pid === pid && !this.anim.done) return;   // a playback running on it
    this.live.set(pid, joints);
    let f = this.follow && this.follow.get(pid);
    if (!f) {
      const it = this.desc && this.desc.items.find(i => i.id === pid);
      if (!it || !it.kinematics) return;
      const all = resolveJoints(it.kinematics, it.joints || {}), lim = {}, start = {};
      for (const l of it.kinematics.links || []) {        // input joints only: mimic joints (the 2nd finger) follow their master
        const j = l.joint; if (!j || j.mimic) continue;
        lim[j.id] = j.type === "prismatic" ? FOLLOW_LIMITS.prismatic : FOLLOW_LIMITS.revolute;
        start[j.id] = all[j.id];
      }
      // base = the scene's own joint values (refreshed by show()); live = the joints a reading has set: only those are
      // chased, the others stay the scene's (2026-10-26: the Bunny's platform shook — the follower kept a stale start
      // value for it while the playback drew the measured one, each overwriting the other every frame)
      f = { cur: { ...start }, vel: {}, from: { ...start }, to: { ...start }, t0: 0, T: 0.2, tSet: 0, lim, base: { ...start }, live: new Set() };
      (this.follow || (this.follow = new Map())).set(pid, f);
    }
    const now = performance.now() / 1000, at = followTarget(f, now);
    f.T = f.tSet ? Math.min(0.5, Math.max(0.1, now - f.tSet)) : 0.2;   // ramp over the reading interval
    f.tSet = now; f.t0 = now;
    for (const [k, v] of Object.entries(joints)) {
      if (!f.lim[k] || !Number.isFinite(v)) continue;
      f.from[k] = at[k] != null ? at[k] : f.cur[k];
      f.to[k] = v;
      f.live.add(k);
    }
    this.startFollow();
  }
  followJoints(f) {                                        // the scene's values, the live-read joints chased over them
    const o = { ...f.base };
    for (const k of f.live) o[k] = f.cur[k];
    return o;
  }
  drivenByPlayback(pid) {                                  // a playback running moves this body itself
    const a = this.anim;
    return !!(a && !a.done && (a.pid === pid || (a.others || []).includes(pid)));
  }
  startFollow() {
    if (this.followRaf) return;
    let last = performance.now();
    const step = (now) => {
      this.followRaf = null;                                 // an exception below must not leave the loop marked as running
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      let moving = false;
      for (const [pid, f] of this.follow) {
        if (this.drivenByPlayback(pid)) continue;            // the playback owns it for now
        const tg = followTarget(f, now / 1000);
        if (now / 1000 - f.t0 < f.T) moving = true;          // the target is still ramping
        for (const k of Object.keys(f.lim)) {
          const { vmax, amax } = f.lim[k], target = tg[k], e = target - f.cur[k], v = f.vel[k] || 0;
          const vdes = Math.sign(e) * Math.min(vmax, Math.sqrt(2 * amax * Math.abs(e)));
          let nv = v + Math.max(-amax * dt, Math.min(amax * dt, vdes - v));
          let nx = f.cur[k] + nv * dt;
          if (Math.abs(target - nx) < 0.02 && Math.abs(nv) < 2 * amax * dt) { nx = target; nv = 0; }   // settled (0.02 deg / mm)
          f.cur[k] = nx; f.vel[k] = nv;
          if (nv !== 0 || nx !== target) moving = true;
        }
        const root = this.bodyOf(pid);
        if (root && root.userData.links) applyJoints(root, this.followJoints(f));
      }
      this.draw();
      this.followRaf = moving ? requestAnimationFrame(step) : null;
    };
    this.followRaf = requestAnimationFrame(step);
  }
  clearLive(pid) {
    this.live.delete(pid);
    if (this.follow) this.follow.delete(pid);
    const it = this.desc && this.desc.items.find(i => i.id === pid), root = this.bodyOf(pid);
    if (it && root && root.userData.links) { applyJoints(root, it.joints || {}); this.requestRender(); }
  }
  /* a translucent copy of item pid posed at `joints` (the target of a joint move; a refused plan's failing posture,
     2026-10-26, with the links in `fail` painted red); null removes it */
  ghost(pid, joints, fail = []) {
    if (!joints) {
      if (this.ghostG) { this.items.remove(this.ghostG); disposeGroup(this.ghostG); }
      this.ghostG = this.ghostPid = this.ghostJ = null; this.ghostFail = []; this.requestRender(); return;
    }
    const src = this.groups.get(pid), it = this.desc && this.desc.items.find(i => i.id === pid);
    if (!src || !it) return;
    if (!this.ghostG || this.ghostPid !== pid) {
      this.ghost(null);
      const mat = new THREE.MeshStandardMaterial({ color: 0xff7a00, transparent: true, opacity: 0.35, depthWrite: false, roughness: 0.5 });
      const g = new THREE.Group(); g.userData.ghost = true;
      const body = makeBody({ ...it, id: "ghost:" + pid }, mat);
      g.add(body);
      src.updateMatrixWorld(true);
      src.matrixWorld.decompose(g.position, g.quaternion, g.scale);
      this.items.add(g);
      body.userData.whenLinked.push(() => { if (this.ghostJ) applyJoints(body, this.ghostJ); paintLinks(body, this.ghostFail); this.requestRender(); });
      this.ghostG = g; this.ghostPid = pid;
    }
    this.ghostJ = joints; this.ghostFail = fail || [];
    const body = this.ghostG.children[0];
    if (body.userData.links) { applyJoints(body, joints); paintLinks(body, this.ghostFail); }
    this.requestRender();
  }
  /* a translucent GREEN copy of placement pid (with what stands on it) at `pose` {x, y, z, rot}: where a refused
     plan's suggestion would put the holder / module (2026-10-26); null removes it. The copy is the drawn group
     cloned (geometries shared: never disposed here), its meshes in the suggest colour, its markers hidden. */
  ghostPlace(pid, pose) {
    if (this.placeG) { this.items.remove(this.placeG); this.placeG = null; }
    if (!pose) { this.requestRender(); return; }
    const src = this.groups.get(pid), it = this.desc && this.desc.items.find(i => i.id === pid);
    if (!src || !it) return;
    if (!this.placeMat) this.placeMat = new THREE.MeshStandardMaterial({ color: COLORS.suggest, emissive: COLORS.suggest, emissiveIntensity: 0.25,
                                                                          transparent: true, opacity: 0.45, depthWrite: false, roughness: 0.5 });
    const g = src.clone(true);
    g.traverse(o => {
      if (o.isMesh) { o.material = this.placeMat; o.userData = { ...o.userData, sharedMat: true, shared: true }; }
      else if (o.isSprite || o.isLine) o.visible = false;
    });
    const poseM = (x, y, z, rot) => new THREE.Matrix4().makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(rot)));
    src.updateMatrixWorld(true);
    const M = poseM(pose.x, pose.y, pose.z || 0, pose.rot).multiply(poseM(it.x, it.y, it.z || 0, it.rot).invert()).multiply(src.matrixWorld);
    M.decompose(g.position, g.quaternion, g.scale);
    g.userData.ghost = true;
    this.items.add(g);
    this.placeG = g;
    this.requestRender();
  }
  resize() {
    const w = Math.max(1, this.wrap.clientWidth), h = Math.max(1, this.wrap.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.requestRender();
  }
  draw() { renderView(this.renderer, this.scene, this.camera, this.triad); }
  requestRender() {
    // a RUNNING animation renders every frame anyway; a finished one does not (2026-10-24: orbiting after a
    // played demo did nothing — the finished playback blocked every render)
    if (this.needs || (this.anim && !this.anim.done)) return;
    this.needs = true;
    requestAnimationFrame(() => { this.needs = false; this.draw(); });
  }
  fit() {
    if (!this.desc) return;
    const [W, D] = this.desc.bench, L = Math.max(W, D);
    this.controls.target.set(W / 2, D / 2, 120);
    this.camera.position.set(W / 2 + L * 0.35, -L * 0.7, L * 0.75);
    this.controls.update(); this.requestRender();
  }
  /* show a (locked) scene description; the camera fits on the first one */
  show(desc) {
    this.stop(true);
    this.ghostG = null; this.ghostPid = null; this.placeG = null;   // populate() disposes everything in items
    const first = !this.desc;
    this.desc = { ...desc, locked: true };
    populate(this.desc, this.items, this.overlays, this.groups, null);
    // rebuilt bodies: pose them where the follower is now once their links exist — the joints no reading has set
    // take the new scene's values (a module found again, its platform measured anew: 2026-10-26)
    for (const [pid, f] of (this.follow || new Map())) {
      const it = this.desc.items.find(i => i.id === pid);
      if (it && it.kinematics) {
        f.base = resolveJoints(it.kinematics, it.joints || {});
        for (const k of Object.keys(f.lim)) if (!f.live.has(k)) { f.cur[k] = f.from[k] = f.to[k] = f.base[k]; f.vel[k] = 0; }
      }
      const root = this.bodyOf(pid);
      if (root) root.userData.whenLinked.push(() => { applyJoints(root, this.followJoints(f)); this.requestRender(); });
    }
    if (this.follow && this.follow.size) this.startFollow();
    if (first) this.fit(); else this.requestRender();
  }
  bodyOf(pid) { const g = this.groups.get(pid); return g && g.children.find(c => c.userData.bodyRoot); }
  /* move items on the bench in place, no rebuild (spec §10.8: modules moving to where their tags say);
     items mated onto them hang in their node and come along */
  moveItems(items) {
    for (const it of items) {
      const g = this.groups.get(it.id);
      if (!g || it.parent) continue;
      g.position.set(it.x, it.y, it.z || 0);
      g.quaternion.copy(poseQuaternion(it.rot, it.up));
    }
    if (this.desc) this.desc = { ...this.desc, items };
    this.requestRender();
  }
  /* play a joint trajectory {frames: [{joints, tcp}], period_s} on item pid */
  play(pid, traj) {
    this.stop(true);
    const it = this.desc && this.desc.items.find(i => i.id === pid), root = this.bodyOf(pid);
    if (!it || !root || !it.kinematics || !traj.frames.length) return false;
    const kin = it.kinematics, frames = traj.frames, N = frames.length;
    const start = resolveJoints(kin, it.joints || {});
    const names = Object.keys(frames[0].joints).filter(k => (kin.links || []).some(l => l.joint && l.joint.id === k && !l.joint.mimic));
    // the tool-point path (model frame: the body root's own frame) + a marker riding it
    const pts = frames.map(f => new THREE.Vector3(...f.tcp)); pts.push(pts[0].clone());
    const trail = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
                                 new THREE.LineBasicMaterial({ color: 0xff7a00, transparent: true, opacity: 0.85, depthTest: false }));
    trail.renderOrder = 15; trail.visible = this.trailOn;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(5, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff3d00, depthTest: false }));
    dot.renderOrder = 16; dot.visible = this.trailOn;
    root.add(trail, dot);
    const LEAD = 1.6;                                    // s: ease from the set-up pose onto the path
    const a = { pid, root, kin, start, frames, N, names, trail, dot, period: traj.period_s || 12, t: 0, last: performance.now() };
    this.anim = a;
    const lerp = (A, B, u) => { const o = {}; for (const k of names) o[k] = A[k] + ((B[k] != null ? B[k] : A[k]) - A[k]) * u; return o; };
    const step = (now) => {
      if (this.anim !== a) return;
      const dt = Math.min(0.1, (now - a.last) / 1000); a.last = now;
      a.t += dt * (a.t < LEAD ? 1 : this.speed);
      let joints, tcp;
      if (a.t < LEAD) {
        joints = lerp(start, frames[0].joints, smooth(a.t / LEAD)); tcp = frames[0].tcp;
      } else {
        const x = (((a.t - LEAD) / a.period) % 1) * N, i = Math.floor(x) % N, j = (i + 1) % N, u = x - Math.floor(x);
        joints = lerp(frames[i].joints, frames[j].joints, u);
        tcp = frames[i].tcp.map((v, k) => v + (frames[j].tcp[k] - v) * u);
      }
      applyJoints(root, joints);
      dot.position.set(...tcp);
      this.draw();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return true;
  }
  /* play a planned move ONCE (spec §10.6 Transfer, twin/transfer.py): plan = {arm, frames: [{t, joints, tcp}],
     events: [{t, kind grip | release, item, to, link}], others: [{placement, keys: [{t, joints}]}]}.
     At "grip" the item's node (and what rides on it: the vial on the head) is re-parented into the
     gripper's link, at "release" into the destination's link — keeping where it is in the world — so
     it travels with the gripper in between and stays where it was put. It ends at the last frame
     and holds there; stop() rebuilds the snapshot as set up. onStep(t, total) reports progress. */
  playOnce(plan, onStep = null) {
    this.stop(true);
    const it = this.desc && this.desc.items.find(i => i.id === plan.arm), root = this.bodyOf(plan.arm);
    if (!it || !root || !it.kinematics || !plan.frames || !plan.frames.length) return false;
    const frames = plan.frames, N = frames.length, total = frames[N - 1].t;
    const start = resolveJoints(it.kinematics, it.joints || {});
    const names = Object.keys(frames[0].joints);
    const pts = frames.map(f => new THREE.Vector3(...f.tcp));
    const trail = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
                                 new THREE.LineBasicMaterial({ color: 0xff7a00, transparent: true, opacity: 0.85, depthTest: false }));
    trail.renderOrder = 15; trail.visible = this.trailOn;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(5, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff3d00, depthTest: false }));
    dot.renderOrder = 16; dot.visible = this.trailOn;
    root.add(trail, dot);
    const others = (plan.others || []).map(o => ({ pid: o.placement, root: this.bodyOf(o.placement), keys: o.keys || [] })).filter(o => o.root && o.keys.length);
    const events = (plan.events || []).slice().sort((x, y) => x.t - y.t);
    const a = { pid: plan.arm, root, start, trail, dot, t: 0, last: performance.now(), ei: 0, k: 0, once: true,
                others: others.map(o => o.pid) };                 // the bodies the playback drives (the follower leaves them)
    this.anim = a;
    const at = (keys, t) => {                         // a joint track at time t: eased between its keys
      if (t <= keys[0].t) return keys[0].joints;
      for (let i = 0; i + 1 < keys.length; i++) {
        const k0 = keys[i], k1 = keys[i + 1];
        if (t <= k1.t) {
          const u = smooth(k1.t > k0.t ? (t - k0.t) / (k1.t - k0.t) : 1), o = {};
          for (const j of Object.keys(k0.joints)) o[j] = k0.joints[j] + ((k1.joints[j] != null ? k1.joints[j] : k0.joints[j]) - k0.joints[j]) * u;
          return o;
        }
      }
      return keys[keys.length - 1].joints;
    };
    const fire = (ev) => {                            // hand the item over, keeping its world pose
      const g = this.groups.get(ev.item), host = this.bodyOf(ev.to);
      if (!g || !host) return;
      const lg = (ev.link && linkGroup(host, ev.link)) || host;
      this.scene.updateMatrixWorld(true);
      lg.attach(g);
      // (2026-10-26: no shifted release any more — the item is re-parented when it sits on the mount, the hand goes on alone)
    };
    const loading = () => [...this.groups.values()].some(g => g.children.some(c => c.userData.bodyRoot && c.userData.loading));
    const t_wait = performance.now();
    const step = (now) => {
      if (this.anim !== a) return;
      if (a.t === 0 && loading() && now - t_wait < 8000) {   // models still loading: links / mated items not in place yet
        a.last = now; requestAnimationFrame(step); return;
      }
      const dt = Math.min(0.1, (now - a.last) / 1000); a.last = now;
      a.t = Math.min(total, a.t + dt * this.speed);
      while (a.k + 1 < N - 1 && frames[a.k + 1].t <= a.t) a.k++;
      while (a.k > 0 && frames[a.k].t > a.t) a.k--;
      const f0 = frames[a.k], f1 = frames[Math.min(N - 1, a.k + 1)];
      const u = f1.t > f0.t ? Math.min(1, Math.max(0, (a.t - f0.t) / (f1.t - f0.t))) : 1;
      const joints = {};
      for (const j of names) joints[j] = f0.joints[j] + (f1.joints[j] - f0.joints[j]) * u;
      for (const o of others) applyJoints(o.root, at(o.keys, a.t));   // the destination's housing
      applyJoints(root, joints);
      dot.position.set(...f0.tcp.map((v, i) => v + (f1.tcp[i] - v) * u));
      while (a.ei < events.length && events[a.ei].t <= a.t) fire(events[a.ei++]);
      this.draw();
      if (onStep) onStep(a.t, total);
      if (a.t < total) requestAnimationFrame(step);
      else a.done = true;
    };
    requestAnimationFrame(step);
    return true;
  }
  setSpeed(v) { this.speed = +v || 1; }
  setTrail(on) { this.trailOn = !!on; if (this.anim) { this.anim.trail.visible = this.anim.dot.visible = this.trailOn; } }
  /* stop the animation; the arm goes back to its set-up pose (a played-once move: the whole
     snapshot is rebuilt, so carried items return to where they were set up) */
  stop(quiet = false) {
    const a = this.anim; this.anim = null;
    if (!a) return;
    a.root.remove(a.trail, a.dot);
    for (const o of [a.trail, a.dot]) { o.geometry.dispose(); o.material.dispose(); }
    if (a.once && this.desc) { this.show(this.desc); return; }
    applyJoints(a.root, a.start);
    if (!quiet) this.requestRender(); else this.draw();
  }
  get playing() { return !!this.anim && !this.anim.done; }
  /* the item (with what rides on it) changes hands: into `link` of placement `to`, keeping where it is in the
     world — the real run's grip (spec §10.6: the twin moves like the real arm) */
  attachItem(item, to, link) {
    const g = this.groups.get(item), host = this.bodyOf(to);
    if (!g || !host) return false;
    this.scene.updateMatrixWorld(true);
    ((link && linkGroup(host, link)) || host).attach(g);
    this.requestRender();
    return true;
  }
}
function motionView(wrap) { return new MotionView(wrap); }

/* ------------------------------------------------- type model viewer
   Standalone view of ONE type's model (Library tab): the model shifted by
   its held point onto the origin, a floor grid, its mating points
   (base = orange marker at the origin, driving = blue, driven = teal), and the same
   pick / hover / snap as the bench — on the type itself, no placement.
   Shares the geometry and feature caches with the bench view. */
class ModelView {
  constructor(wrap, handlers = {}) {
    this.wrap = wrap; this.handlers = handlers;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    wrap.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.width = "100%"; this.renderer.domElement.style.height = "100%";
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 20000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.addEventListener("change", () => this.requestRender());
    this.triad = viewTriad();                          // the model frame's axes, at the bottom-left corner (2026-10-25, operator)
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.3); sun.position.set(-400, -700, 900); this.scene.add(sun);
    this.root = new THREE.Group(); this.scene.add(this.root);
    this.marks = new THREE.Group(); this.scene.add(this.marks);
    this.body = null; this.hover = null; this.hoverKey = "";
    this.pick = null; this.feats = null; this.desc = null; this.needs = false;
    new ResizeObserver(() => this.resize()).observe(wrap);
    this.resize();
    this.wirePointer();
  }
  resize() {
    const w = Math.max(1, this.wrap.clientWidth), h = Math.max(1, this.wrap.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.requestRender();
  }
  requestRender() {
    if (this.needs) return;
    this.needs = true;
    requestAnimationFrame(() => { this.needs = false; renderView(this.renderer, this.scene, this.camera, this.triad); });
  }
  /* desc: {url, features, origin: [x, y, z], mates: [...], size: [w, d, h],
     kind, kinematics, joints} */
  show(desc) {
    this.desc = desc; this.feats = null;
    disposeGroup(this.root); this.body = null;
    this.setPickMode(null);
    const it = { id: "type", kind: desc.kind || "module", size: desc.size || [100, 100, 100],
                 model: desc.url ? { url: desc.url, origin: desc.origin || [0, 0, 0] } : null,
                 kinematics: desc.kinematics || null, joints: desc.joints || {} };
    const body = makeBody(it, material(it), (inst) => {
      if (this.desc !== desc) return;
      this.setMates(desc.mates || []);                 // mates on links need the link groups
      const bb = new THREE.Box3().setFromObject(inst);
      this.fit([bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z]);
      this.requestRender();
    });
    this.body = body; this.root.add(body);
    const L = Math.max(...it.size, 120) * 1.4;
    const pts = [];
    for (let x = -L; x <= L; x += Math.max(10, Math.round(L / 10 / 10) * 10)) pts.push(x, -L, 0, x, L, 0, -L, x, 0, L, x, 0);
    const grid = new THREE.BufferGeometry(); grid.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    this.root.add(new THREE.LineSegments(grid, new THREE.LineBasicMaterial({ color: COLORS.grid })));
    this.setMates(desc.mates || []);
    this.fit(it.size);
    if (desc.features) loadFeatures(desc.features).then(d => { if (this.desc === desc) this.feats = d; });
  }
  setMates(mates) {
    this.mates = mates || [];                          // aux points feed the picker's midpoint snap
    disposeGroup(this.marks);
    for (const g of (this.body && this.body.userData.links ? this.body.userData.links.values() : [])) {
      for (const c of [...g.children]) if (c.userData.mark) { g.remove(c); disposeGroup(c); }
    }
    const o = (this.desc && this.desc.origin) || [0, 0, 0];
    const rel = (p) => [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    const tool = this.desc && this.desc.kinematics && this.desc.kinematics.tool;
    if (tool) {                                        // the tool frame (TCP): green marker along its approach axis
      const lg = linkGroup(this.body, tool.link);
      if (lg) {
        const mk = pointMarker(tool.point_mm || [0, 0, 0], tool.x_axis || [1, 0, 0], 0x1e9e50, 8, 45, "tcp");
        mk.userData.mark = true; lg.add(mk);
      }
    }
    for (const m of mates || []) {
      if (m.hidden) continue;                          // hidden in the table: not drawn, not clickable
      const held = m.role === "held";
      const lg = linkGroup(this.body, m.link);
      if (m.role === "tag") {                           // the printed tag + a small frame marker (x = right)
        const t = { ...m, family: m.tag && m.tag.family, tag_id: m.tag && m.tag.id, size_mm: m.tag && m.tag.size_mm };
        if (!lg) t.point_mm = rel(m.point_mm || [0, 0, 0]);
        const mk = tagMesh(t); mk.userData.mark = true;
        const fr = pointMarker(t.point_mm, m.up, 0x8e44ad, Math.max(6, (t.size_mm || 40) * 0.12), 25, `${m.id} · ${t.family || "tag16h5"} #${t.tag_id != null ? t.tag_id : "?"}`);
        fr.userData.mark = true;
        (lg || this.marks).add(mk, fr);
        continue;
      }
      // a mating point on a moving link lives in that link's frame (model
      // coords) and follows the joint; anything else sits in the view frame
      // orange = base point, blue = driving, teal = driven (axis = the direction out of the item), grey = auxiliary;
      // the SELECTED point (click it, or its table row) turns amber and shows its x / y / z frame
      const aux = m.role === "aux", sel = !held && this.selMate === m.id;
      const at = lg ? (m.point_mm || [0, 0, 0]) : rel(m.point_mm || [0, 0, 0]);
      const mk = pointMarker(at, held ? [0, 0, 1] : m.up,
                             sel ? 0xffa000 : held ? 0xa85f12 : aux ? 0x8a8a8a : (m.role === "driven" ? 0x16a085 : m.role === "grip" ? 0xd63384 : 0x2f6fdd),
                             (held ? 14 : aux ? 4 : 10) * (sel ? 1.4 : 1), sel ? 0 : (held ? 40 : aux ? 12 : 30),
                             held || aux ? m.id : `${m.id} · ${m.role === "driven" ? "driven" : m.role === "grip" ? "grip point"
                                                            : (m.source && m.source.kind === "grip") ? "gripper point" : "driving"}`);
      mk.userData.mark = true;
      if (!held) {                                     // an invisible, generous click target (the ring is thin)
        const tgt = new THREE.Mesh(new THREE.SphereGeometry(aux ? 6 : 9, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
        tgt.position.set(...at); tgt.userData.mateId = m.id;
        mk.add(tgt);
        if (sel) mk.add(frameTriad(at, m.up, m.x_axis, aux ? 28 : 40));
      }
      (lg || this.marks).add(mk);
    }
    this.requestRender();
  }
  auxPoints() { return (this.mates || []).filter(m => m.role === "aux" && !m.hidden); }   // a hidden point is no midpoint end
  /* select a mounting / aux point by id (null = none): its marker turns
     amber and shows its x / y / z frame */
  selectMate(id) { this.selMate = id || null; this.setMates(this.mates || []); }
  /* the mounting / aux point marker under a click, or null */
  mateAt(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster(); rc.setFromCamera(v, this.camera);
    const tgts = [];
    this.scene.traverse(o => { if (o.userData.mateId) tgts.push(o); });
    const h = rc.intersectObjects(tgts, false)[0];
    return h ? h.object.userData.mateId : null;
  }
  /* pose the model at these joint values (Library tab configuration / sliders) */
  setJoints(joints) {
    if (this.desc) this.desc.joints = joints || {};
    if (this.body) applyJoints(this.body, joints || {});
    this.requestRender();
  }
  fit(size) {
    const L = Math.max(...(size || [100, 100, 100]));
    this.controls.target.set(0, 0, (size ? size[2] : 100) / 2);
    this.camera.position.set(L * 0.9, -L * 1.4, L * 1.0);
    this.controls.update();
    this.requestRender();
  }
  setPickMode(opts) {
    this.pick = opts || null;
    this.controls.enabled = !this.pick;
    this.renderer.domElement.style.cursor = this.pick ? "crosshair" : "";
    if (!this.pick) this.showHover(null);
  }
  hit(e) {
    if (!this.body) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster(); rc.setFromCamera(v, this.camera);
    const hits = rc.intersectObject(this.body, true).filter(h => h.object.userData.body);
    return hits.length ? hits[0] : null;
  }
  showHover(res) {
    const key = res ? `${res.kind}|${res.link || ""}|${res.local.join(",")}` : "";
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    if (this.hover) { this.hover.parent && this.hover.parent.remove(this.hover); disposeGroup(this.hover); this.hover = null; }
    if (res) {                                     // a point on a moving link follows its posed link
      const lg = linkGroup(this.body, res.link);
      this.hover = pointMarker(lg ? res.model : res.local, res.up, COLORS.selected, res.radius);
      (lg || this.root).add(this.hover);
    }
    this.requestRender();
  }
  wirePointer() {
    const el = this.renderer.domElement;
    // a click (no orbit) on a mounting / aux point selects it; on anything else deselects
    el.addEventListener("pointerdown", (e) => { this.down = !this.pick && e.button === 0 ? { x: e.clientX, y: e.clientY } : null; });
    el.addEventListener("pointerup", (e) => {
      const d = this.down; this.down = null;
      if (!d || this.pick || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      const id = this.mateAt(e);
      this.selectMate(id);
      this.handlers.onMateSelect && this.handlers.onMateSelect(id);
    });
    el.addEventListener("pointerdown", (e) => {
      if (!this.pick || e.button !== 0) return;
      const p = this.pick, h = this.hit(e);
      this.setPickMode(null);
      const snapped = h ? snapHit(h, p.snap || "auto", this.feats, this.camera, { ...pickOpts(p, el), aux: this.auxPoints() }) : null;
      if (snapped) p.onPick && p.onPick(snapped);
      else p.onCancel && p.onCancel();
    });
    el.addEventListener("pointermove", (e) => {
      if (!this.pick) return;
      const h = this.hit(e);                         // re-snapped on every move, like the bench view
      this.showHover(h ? snapHit(h, this.pick.snap || "auto", this.feats, this.camera, { ...pickOpts(this.pick, el), aux: this.auxPoints() }) : null);
    });
    el.addEventListener("dblclick", () => this.fit(this.desc && this.desc.size));
  }
}
function modelView(wrap, handlers) { return new ModelView(wrap, handlers); }

window.TW3D = { mount, render, applyPose, setSelected, fit, benchPoint, resize, setPickMode, snapHit, loadFeatures, modelView, jointMatrix, resolveJoints, tagBitmap, loadFamily, mateQuaternion, circumcentre, frameTriad, motionView };
window.dispatchEvent(new Event("tw3d-ready"));
