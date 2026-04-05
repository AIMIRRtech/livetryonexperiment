import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/* ── DOM ─────────────────────────────────────────────── */
const loadingScreen   = document.getElementById("loadingScreen");
const loadingStatus   = document.getElementById("loadingStatus");
const loadingProgress = document.getElementById("loadingProgress");
const appEl           = document.getElementById("app");
const viewportEl      = document.getElementById("viewport");
const videoEl         = document.getElementById("inputVideo");
const imageEl         = document.getElementById("inputImage");
const overlayCanvas   = document.getElementById("overlayCanvas");
const segCanvas       = document.getElementById("segmentationCanvas");
const segCtx          = segCanvas.getContext("2d");
const statusPill      = document.getElementById("statusPill");
const statusText      = document.getElementById("statusText");
const fpsCounter      = document.getElementById("fpsCounter");
const poseGuide       = document.getElementById("poseGuide");
const toggleBtn       = document.getElementById("toggleTrackingBtn");
const playIcon        = document.getElementById("playIcon");
const stopIcon        = document.getElementById("stopIcon");
const flipBtn         = document.getElementById("flipCameraBtn");
const segBtn          = document.getElementById("segToggleBtn");
const screenshotBtn   = document.getElementById("screenshotBtn");
const fileInput       = document.getElementById("fileInput");
const sourceButtons   = document.querySelectorAll(".source-btn");
const productPanel    = document.getElementById("productPanel");
const productToggleBtn= document.getElementById("productToggleBtn");
const productGrid     = document.getElementById("productGrid");
const productCards    = document.querySelectorAll(".product-card");
const shopLink        = document.getElementById("shopLink");
const textureInput    = document.getElementById("textureInput");
const textureResetBtn = document.getElementById("textureResetBtn");
const textureUploadLabel = document.querySelector(".texture-upload-btn");
const textureUrlInput = document.getElementById("textureUrlInput");
const textureUrlLoadBtn = document.getElementById("textureUrlLoadBtn");

/* ── State ───────────────────────────────────────────── */
let pose = null;
let selfieSegmentation = null;
let isTracking = false;
let poseBusy = false;
let segBusy = false;
let segmentationEnabled = true;
let activeSource = "camera";
let cameraStream = null;
let facingMode = "user";
let selectedProduct = null; // null = default red jacket
let frameCount = 0;
let lastFpsTime = performance.now();
let poseDetectedFrames = 0;
const POSE_GUIDE_HIDE_AFTER = 25;
let customTextureApplied = false; // tracks whether a user-uploaded PNG texture is active

/* ── Mobile Detection & Segmentation Performance ──────── */
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
// Mobile: skip frames + downscale input. Desktop: every frame, full res.
let segFrameCounter = 0;
const SEG_EVERY_N = IS_MOBILE ? 3 : 1;
let segInputCanvas = null;
let segInputCtx = null;
const SEG_MAX_DIM = 256; // only used on mobile

/* ── Three.js — Orthographic camera for pixel-space overlay ── */
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(0, 1, 0, 1, 0.1, 1000);
camera.position.z = 10;

const renderer = new THREE.WebGLRenderer({
  canvas: overlayCanvas,
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true,
  powerPreference: "high-performance",
});
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.localClippingEnabled = true;

/* ── Realistic Multi-Light Setup (toned-down for fabric realism) ── */
// Warm ambient — lowered for softer base fill
const ambientLight = new THREE.AmbientLight(0xffeedd, 0.55);
scene.add(ambientLight);

// Key light — main, warm white, reduced intensity for less specular shine
const keyLight = new THREE.DirectionalLight(0xfff8f0, 0.85);
keyLight.position.set(100, -50, 300);
scene.add(keyLight);

// Fill light — cooler, from left, gentle
const fillLight = new THREE.DirectionalLight(0xd8e8ff, 0.35);
fillLight.position.set(-150, 30, 200);
scene.add(fillLight);

// Rim light — subtle edge definition
const rimLight = new THREE.DirectionalLight(0xffffff, 0.35);
rimLight.position.set(0, -80, -200);
scene.add(rimLight);

// Hemisphere — natural sky/ground gradient
const hemiLight = new THREE.HemisphereLight(0xc0d8ff, 0x806040, 0.25);
scene.add(hemiLight);

/* ── Garment State ───────────────────────────────────── */

/* HIDE_ON_BAD_POSE: When true, jacket disappears on side poses and arms
 * raised above T-pose (90°), showing a user instruction instead.
 * Set to false later when side-pose / raised-arm rendering is improved. */
const HIDE_ON_BAD_POSE = true;
const SIDENESS_HIDE_THRESHOLD = 0.55;  // sideness above this hides jacket

const GARMENT_SCALE_FACTOR = 1.0;
const TRACKING_LERP = 0.24;
const BONE_TRACKING_LERP = 0.32;

/* Clipping planes to crop sleeves in side-on views.
 * Planes are in the jacketAnchor's local space.
 * We set them on individual materials when sideness is high. */
let currentClipPlanes = [];

const jacketAnchor = new THREE.Group();
jacketAnchor.visible = false;
scene.add(jacketAnchor);

let jacketObject = null;
const jacketBaseSize = new THREE.Vector3(1, 1, 1);
const targetJacketPosition = new THREE.Vector3();
const targetJacketScale = new THREE.Vector3(1, 1, 1);
const armRigState = { active: false, bones: null, rest: null };

/* ── Helpers ─────────────────────────────────────────── */
function setStatus(message, type = "") {
  statusText.textContent = message;
  statusPill.className = "status-pill visible " + type;
  clearTimeout(setStatus._timer);
  if (type !== "loading") {
    setStatus._timer = setTimeout(() => {
      statusPill.classList.remove("visible");
    }, 4000);
  }
}

function setLoading(msg, pct) {
  loadingStatus.textContent = msg;
  loadingProgress.style.width = pct + "%";
}

function isImageMode() { return activeSource === "image"; }
function getActiveEl() { return isImageMode() ? imageEl : videoEl; }

/* ── Pose Instruction Overlay (HIDE_ON_BAD_POSE) ──────── */
let _poseInstrEl = null;
function _ensurePoseInstrEl() {
  if (_poseInstrEl) return _poseInstrEl;
  _poseInstrEl = document.createElement("div");
  _poseInstrEl.id = "poseInstruction";
  _poseInstrEl.style.cssText = `
    position:absolute; bottom:140px; left:50%; transform:translateX(-50%);
    background:rgba(10,10,18,0.82); color:#f4ede4; padding:10px 20px;
    border-radius:20px; font:500 0.82rem/1.3 Barlow,sans-serif;
    z-index:12; pointer-events:none; opacity:0;
    transition:opacity 0.3s ease; white-space:nowrap;
    border:1px solid rgba(201,100,207,0.35);
  `;
  document.querySelector(".viewport").appendChild(_poseInstrEl);
  return _poseInstrEl;
}
function showPoseInstruction(msg) {
  const el = _ensurePoseInstrEl();
  el.textContent = msg;
  el.style.opacity = "1";
}
function hidePoseInstruction() {
  if (_poseInstrEl) _poseInstrEl.style.opacity = "0";
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function toScenePos(nx, ny) {
  return { x: nx * overlayCanvas.width, y: ny * overlayCanvas.height };
}
function hasLandmark(lm) {
  if (!lm) return false;
  return (lm.visibility ?? lm.presence ?? 1) > 0.35;
}
function normalizeAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
function renderScene() { renderer.render(scene, camera); }

/* ── Canvas Sync ─────────────────────────────────────── */
function syncCanvasSize() {
  const el = getActiveEl();
  let srcW, srcH;
  if (el.tagName === "VIDEO" && el.videoWidth) {
    srcW = el.videoWidth; srcH = el.videoHeight;
  } else if (el.tagName === "IMG" && el.naturalWidth) {
    srcW = el.naturalWidth; srcH = el.naturalHeight;
  } else {
    srcW = viewportEl.clientWidth; srcH = viewportEl.clientHeight;
  }

  // Use source resolution for internal canvas drawing
  const w = srcW;
  const h = srcH;
  overlayCanvas.width = w;
  overlayCanvas.height = h;
  segCanvas.width = w;
  segCanvas.height = h;
  camera.left = 0; camera.right = w;
  camera.top = 0; camera.bottom = h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  segCtx.clearRect(0, 0, w, h);
  renderScene();
}

/* ── Camera ──────────────────────────────────────────── */
function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
    videoEl.srcObject = null;
  }
}

async function startCamera() {
  stopCamera();
  try {
    // Lower resolution on mobile for better perf; desktop stays at 720p
    const idealW = IS_MOBILE ? 640 : 1280;
    const idealH = IS_MOBILE ? 480 : 720;
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: idealW }, height: { ideal: idealH } },
      audio: false,
    });
    videoEl.srcObject = cameraStream;
    videoEl.style.display = "block";
    imageEl.style.display = "none";
    await videoEl.play();
    syncCanvasSize();
    setStatus("Camera active");
  } catch (err) {
    if (err.name === "NotAllowedError" || err.message.includes("Permission")) {
      setStatus("Camera blocked — open in a new tab", "error");
    } else {
      setStatus("Camera error: " + err.message, "error");
    }
  }
}

/* ── Segmentation (optimized for mobile) ───────────── */
function clearSeg() { segCtx.clearRect(0, 0, segCanvas.width, segCanvas.height); }

function renderSegOverlay(mask) {
  if (!segmentationEnabled || !mask) { clearSeg(); return; }
  const el = getActiveEl();
  const w = segCanvas.width, h = segCanvas.height;
  if (w < 2 || h < 2 || !el) { clearSeg(); return; }
  segCtx.clearRect(0, 0, w, h);
  segCtx.drawImage(el, 0, 0, w, h);
  segCtx.globalCompositeOperation = "destination-out";
  // Mask comes back at seg input size; drawImage scales it up automatically
  segCtx.drawImage(mask, 0, 0, w, h);
  segCtx.globalCompositeOperation = "source-over";
}

// Create or reuse a small off-screen canvas for downscaled seg input
function getSegInputCanvas(srcW, srcH) {
  const scale = Math.min(1, SEG_MAX_DIM / Math.max(srcW, srcH));
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  if (!segInputCanvas) {
    segInputCanvas = document.createElement("canvas");
    segInputCtx = segInputCanvas.getContext("2d");
  }
  segInputCanvas.width = w;
  segInputCanvas.height = h;
  return { canvas: segInputCanvas, ctx: segInputCtx, w, h };
}

async function runSegmentation(source) {
  if (!segmentationEnabled || !selfieSegmentation || segBusy || !source) return;
  segBusy = true;
  try {
    if (IS_MOBILE) {
      // Mobile: downscale source before sending to seg model for speed
      const srcW = source.videoWidth || source.naturalWidth || source.width;
      const srcH = source.videoHeight || source.naturalHeight || source.height;
      if (srcW > SEG_MAX_DIM || srcH > SEG_MAX_DIM) {
        const { canvas, ctx, w, h } = getSegInputCanvas(srcW, srcH);
        ctx.drawImage(source, 0, 0, w, h);
        await selfieSegmentation.send({ image: canvas });
      } else {
        await selfieSegmentation.send({ image: source });
      }
    } else {
      // Desktop: full resolution
      await selfieSegmentation.send({ image: source });
    }
  }
  catch { clearSeg(); }
  finally { segBusy = false; }
}

/* ── Arm Rig Setup ───────────────────────────────────── */
function setupArmRig(obj) {
  const boneMap = new Map();
  obj.traverse(n => { if (n.isBone && n.name) boneMap.set(n.name.toLowerCase(), n); });

  const pick = names => {
    for (const name of names) { const b = boneMap.get(name.toLowerCase()); if (b) return b; }
    return null;
  };

  const lCollar   = pick(["m_avg_l_collar", "leftcollar", "l_collar"]);
  const rCollar   = pick(["m_avg_r_collar", "rightcollar", "r_collar"]);
  const lShoulder = pick(["m_avg_l_shoulder", "leftshoulder", "l_shoulder"]);
  const rShoulder = pick(["m_avg_r_shoulder", "rightshoulder", "r_shoulder"]);
  const lElbow    = pick(["m_avg_l_elbow", "leftelbow", "l_elbow"]);
  const rElbow    = pick(["m_avg_r_elbow", "rightelbow", "r_elbow"]);

  if (!lShoulder || !rShoulder || !lElbow || !rElbow) {
    armRigState.active = false;
    return;
  }

  const q = b => (b ? b.quaternion.clone() : new THREE.Quaternion());
  armRigState.active = true;
  armRigState.bones = { lCollar, rCollar, lShoulder, rShoulder, lElbow, rElbow };
  armRigState.rest = {
    lCollar: q(lCollar), rCollar: q(rCollar),
    lShoulder: q(lShoulder), rShoulder: q(rShoulder),
    lElbow: q(lElbow), rElbow: q(rElbow),
  };
}

/* Quaternion SLERP-based bone animation — smoother than Euler lerp */
function applyBonePose(bone, restQ, angle, strength, lerpVal) {
  if (!bone || !restQ || !(restQ instanceof THREE.Quaternion)) return;
  const tq = restQ.clone().multiply(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -angle * strength)
  );
  bone.quaternion.slerp(tq, lerpVal);
}

/* Accelerate angle away from zero — keeps T-pose sacred (0) but bends
 * 20% faster as arms move toward A-pose.  Uses sign-preserving power
 * curve: out = sign(a) * |a|^BEND_ACCEL.  Exponent < 1 = faster ramp. */
const BEND_ACCEL = 0.72; // <1 = arms reach target angle sooner (≈35% faster)
function accelBend(angle) {
  const sign = angle < 0 ? -1 : 1;
  return sign * Math.pow(Math.abs(angle), BEND_ACCEL);
}

function updateArms(landmarks, torsoAngle) {
  if (!armRigState.active || !armRigState.bones || !armRigState.rest) return;

  const lsLm = landmarks[11], rsLm = landmarks[12];
  const leLm = landmarks[13], reLm = landmarks[14];
  const lwLm = landmarks[15], rwLm = landmarks[16];

  if ([lsLm, rsLm, leLm, reLm, lwLm, rwLm].some(l => !hasLandmark(l))) return;

  const lu = Math.atan2(leLm.y - lsLm.y, leLm.x - lsLm.x);
  const ru = Math.atan2(reLm.y - rsLm.y, reLm.x - rsLm.x);
  const ll = Math.atan2(lwLm.y - leLm.y, lwLm.x - leLm.x);
  const rl = Math.atan2(rwLm.y - reLm.y, rwLm.x - reLm.x);

  const lsOff = accelBend(normalizeAngle(lu - torsoAngle));
  const rsOff = accelBend(normalizeAngle(ru - torsoAngle));
  const leOff = accelBend(normalizeAngle(ll - lu));
  const reOff = accelBend(normalizeAngle(rl - ru));

  const { bones, rest } = armRigState;
  applyBonePose(bones.lCollar,   rest.lCollar,   lsOff + Math.PI, 0.196, BONE_TRACKING_LERP);
  applyBonePose(bones.rCollar,   rest.rCollar,   rsOff + Math.PI, 0.196, BONE_TRACKING_LERP);
  applyBonePose(bones.lShoulder, rest.lShoulder, lsOff + Math.PI, 0.72, BONE_TRACKING_LERP);
  const rTotal = normalizeAngle(rsOff + Math.PI + Math.PI - (60 * Math.PI / 180));
  applyBonePose(bones.rShoulder, rest.rShoulder, rTotal, 0.78, BONE_TRACKING_LERP);
  applyBonePose(bones.lElbow,    rest.lElbow,    leOff, 0.80, BONE_TRACKING_LERP);
  applyBonePose(bones.rElbow,    rest.rElbow,    reOff, 0.80, BONE_TRACKING_LERP);
}

/* ── GLB Loading & Materials ─────────────────────────── */
/* Check if a Three.js texture has an alpha channel.
 * GLTFLoader decodes PNG images to ImageBitmap or canvas — both carry
 * the alpha information. We check multiple signals. */
function textureHasAlpha(tex) {
  if (!tex) return false;
  // Three.js sets format to RGBAFormat for textures with alpha
  if (tex.format === THREE.RGBAFormat) return true;
  // GLTFLoader sometimes stores decoded data as ImageBitmap
  const img = tex.image || tex.source?.data;
  if (!img) return false;
  // ImageBitmap from PNG will have 4-channel data
  // Canvas elements from PNG are always RGBA
  if (img instanceof HTMLCanvasElement) return true;
  if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) return true;
  return false;
}

function enhanceMaterials(obj) {
  obj.traverse(n => {
    if (!n.isMesh) return;
    n.frustumCulled = false;
    const mats = Array.isArray(n.material) ? n.material : [n.material];
    mats.forEach(mat => {
      if (!mat) return;
      if (mat.isMeshStandardMaterial) {
        mat.envMapIntensity = 0.15;
        // Increase roughness for realistic fabric look (less shiny)
        if (mat.roughness < 0.7) mat.roughness = Math.max(mat.roughness, 0.7);
        mat.side = THREE.DoubleSide;

        /* Enable alpha for PNG textures with transparency.
         * Uses alphaTest (hard cutoff) rather than full blending to
         * avoid depth-sorting artifacts on the jacket mesh. */
        if (textureHasAlpha(mat.map)) {
          mat.transparent = true;
          mat.alphaTest = 0.05;
          mat.depthWrite = true;
          console.log("Alpha texture detected — transparency enabled");
        }
        if (mat.transparent || mat.alphaTest > 0) {
          mat.depthWrite = true;
        }
        mat.needsUpdate = true;
      } else if (mat.isMeshBasicMaterial) {
        const alpha = textureHasAlpha(mat.map);
        n.material = new THREE.MeshStandardMaterial({
          color: mat.color,
          map: mat.map,
          roughness: 0.75,
          metalness: 0.0,
          transparent: mat.transparent || alpha,
          alphaTest: alpha ? 0.05 : 0,
          opacity: mat.opacity || 1.0,
          side: THREE.DoubleSide,
          depthWrite: true,
        });
      }
    });
  });
}

function mountGarment(obj) {
  jacketAnchor.clear();
  jacketObject = obj;

  obj.traverse(n => { if (n.isMesh) n.frustumCulled = false; });

  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  obj.position.sub(center);
  obj.position.y += size.y * 0.04;
  obj.rotation.set(0, Math.PI, 0);

  jacketBaseSize.set(
    Math.max(size.x, 0.001),
    Math.max(size.y, 0.001),
    Math.max(size.z, 0.001)
  );

  enhanceMaterials(obj);
  setupArmRig(obj);
  jacketAnchor.add(obj);
  jacketAnchor.visible = false;
  renderScene();
}

function createPlaceholderJacket() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2a2a4e,
    roughness: 0.6,
    metalness: 0.04,
    emissive: 0x1a0e32,
    emissiveIntensity: 0.15,
    transparent: true,
    opacity: 0.82,
    side: THREE.DoubleSide,
  });

  const g = new THREE.Group();

  // Body — slightly tapered torso shape
  const bodyGeo = new THREE.CylinderGeometry(0.48, 0.44, 1.3, 8);
  const body = new THREE.Mesh(bodyGeo, mat);
  g.add(body);

  // Left sleeve — angled outward slightly
  const sleeveMat = mat.clone();
  const ls = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.11, 0.8, 8), sleeveMat);
  ls.position.set(-0.52, 0.12, 0);
  ls.rotation.z = 0.35;
  g.add(ls);

  // Right sleeve
  const rs = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.11, 0.8, 8), sleeveMat);
  rs.position.set(0.52, 0.12, 0);
  rs.rotation.z = -0.35;
  g.add(rs);

  // Collar — subtle round neckline
  const collarMat = mat.clone();
  collarMat.color = new THREE.Color(0x252548);
  collarMat.opacity = 0.7;
  const collar = new THREE.Mesh(
    new THREE.TorusGeometry(0.14, 0.025, 8, 16, Math.PI),
    collarMat
  );
  collar.position.set(0, 0.65, 0.05);
  collar.rotation.x = -Math.PI * 0.1;
  g.add(collar);

  // Center seam — subtle zip line
  const seamMat = new THREE.MeshStandardMaterial({
    color: 0x16163a, roughness: 0.9, transparent: true, opacity: 0.25
  });
  const seam = new THREE.Mesh(new THREE.PlaneGeometry(0.012, 1.25), seamMat);
  seam.position.set(0, 0, 0.16);
  g.add(seam);

  return g;
}

/* ── Product Color Palettes ──────────────────────────── */
// Each product defines a primary body color and an accent (neon trim) color.
// We tint the existing red jacket mesh material to match each product.
const PRODUCT_COLORS = {
  "aurora-pullover": {
    body: 0x1e2148,    // deep navy
    accent: 0xd946ef,  // neon pink/magenta
    roughness: 0.65,
    metalness: 0.0,
    emissive: 0x0c0e24,
    emissiveIntensity: 0.1,
  },
  "nebula-pullover": {
    body: 0x2a2d33,    // dark charcoal
    accent: 0x22d3ee,  // cyan/teal
    roughness: 0.62,
    metalness: 0.0,
    emissive: 0x121418,
    emissiveIntensity: 0.08,
  },
  "phantom-zip": {
    body: 0x141416,    // near-black
    accent: 0x22d3ee,  // cyan/teal
    roughness: 0.55,
    metalness: 0.02,
    emissive: 0x0a0a0c,
    emissiveIntensity: 0.06,
  },
  "prism-zip": {
    body: 0xe8e8ee,    // light grey / white
    accent: 0xc084fc,  // soft purple/pink
    roughness: 0.5,
    metalness: 0.08,
    emissive: 0xf0f0f5,
    emissiveIntensity: 0.05,
  },
};

// Store reference to original material properties so we can restore them
let originalMaterialState = null;

function saveOriginalMaterial(obj) {
  obj.traverse(n => {
    if (!n.isMesh || !n.material) return;
    const mat = n.material;
    originalMaterialState = {
      color: mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
      map: mat.map,
      roughness: mat.roughness,
      metalness: mat.metalness,
      emissive: mat.emissive ? mat.emissive.clone() : new THREE.Color(0x000000),
      emissiveIntensity: mat.emissiveIntensity || 0,
      normalMap: mat.normalMap,
    };
  });
}

function applyProductColor(productId) {
  if (!jacketObject) return;
  const palette = productId ? PRODUCT_COLORS[productId] : null;

  jacketObject.traverse(n => {
    if (!n.isMesh || !n.material) return;
    const mat = n.material;

    if (!palette) {
      // Restore original red jacket — put back the base color texture and original color
      if (originalMaterialState) {
        mat.color.copy(originalMaterialState.color);
        mat.map = originalMaterialState.map;
        mat.roughness = originalMaterialState.roughness;
        mat.metalness = originalMaterialState.metalness;
        mat.emissive.copy(originalMaterialState.emissive);
        mat.emissiveIntensity = originalMaterialState.emissiveIntensity;
        mat.normalMap = originalMaterialState.normalMap;
      }
    } else {
      // Tint to product color — remove the base color texture so the flat color shows,
      // but keep the normal map for fabric detail
      mat.color.setHex(palette.body);
      mat.map = null; // remove the red texture; the normal map gives us surface detail
      mat.roughness = palette.roughness;
      mat.metalness = palette.metalness;
      mat.emissive.setHex(palette.emissive);
      mat.emissiveIntensity = palette.emissiveIntensity;
      if (originalMaterialState) {
        mat.normalMap = originalMaterialState.normalMap; // keep fabric wrinkles
      }
    }
    mat.needsUpdate = true;
  });
  renderScene();
}

/* ── Azure Blob CDN ──────────────────────────────────── */
const AZURE_BLOB_BASE = "https://testpriteshlive.blob.core.windows.net/assets";
const AZURE_SAS = "sp=r&st=2026-03-29T16:01:18Z&se=2030-03-30T00:16:18Z&spr=https&sv=2024-11-04&sr=c&sig=cS7pcQeG%2BIdqjdHgd4xfzbS5pjmUT%2FGjh5MDGyvJhX4%3D";
function azureUrl(filename) { return `${AZURE_BLOB_BASE}/${filename}?${AZURE_SAS}`; }

async function loadGarment() {
  const loader = new GLTFLoader();
  // Try Azure blob first (reliable CDN), then local file fallbacks
  const candidates = [
    azureUrl("virtualtryon.glb"),
    "assets/jacket-model.dat",
    "assets/virtualtryon.glb",
    "assets/jacket.glb",
  ];
  for (const url of candidates) {
    try {
      const gltf = await loader.loadAsync(url);
      saveOriginalMaterial(gltf.scene);
      mountGarment(gltf.scene);
      console.log("GLB loaded from:", url.startsWith("http") ? "Azure Blob" : url);
      return true;
    } catch {}
  }
  // Final fallback: base64-encoded JS modules (survives Heroku binary mangling)
  try {
    const resp = await fetch("glb-data.js");
    const text = await resp.text();
    const b64Match = text.match(/["']([A-Za-z0-9+/=]{100,})["']/);
    if (b64Match) {
      const bin = Uint8Array.from(atob(b64Match[1]), c => c.charCodeAt(0));
      const gltf = await loader.parseAsync(bin.buffer, "");
      saveOriginalMaterial(gltf.scene);
      mountGarment(gltf.scene);
      console.log("GLB loaded from: base64 fallback (glb-data.js)");
      return true;
    }
  } catch {}
  mountGarment(createPlaceholderJacket());
  return false;
}

/* ── Garment Placement ───────────────────────────────── */
// Track a stable "front-facing shoulder width" to use as reference when side-on
let stableFrontShW = 0;

function placeGarment(landmarks) {
  const ls = landmarks[11], rs = landmarks[12];
  const lh = landmarks[23], rh = landmarks[24];

  if (!ls || !rs || !lh || !rh) {
    jacketAnchor.visible = false;
    renderScene();
    return;
  }

  const shoulderMid = midpoint(ls, rs);
  const hipMid = midpoint(lh, rh);

  const rawShW = dist(ls, rs) * overlayCanvas.width;
  const torsoH = dist(shoulderMid, hipMid) * overlayCanvas.height;
  
  // Pre-compute sideness for center weighting (full computation below)
  const earlyRatio = torsoH > 0 ? rawShW / torsoH : 1;
  const earlySideness = THREE.MathUtils.clamp(
    1.0 - (earlyRatio - 0.15) / (0.40 - 0.15), 0, 1
  );

  // Torso center — use more hip weight when side-on or arms raised
  const isArmsRaised = shoulderMid.y < hipMid.y * 0.65;
  const xShoulderW = earlySideness > 0.3 ? 0.45 : 0.55;
  const yShoulderW = (earlySideness > 0.3 || isArmsRaised) ? 0.38 : 0.46;
  const center = {
    x: shoulderMid.x * xShoulderW + hipMid.x * (1 - xShoulderW),
    y: shoulderMid.y * yShoulderW + hipMid.y * (1 - yShoulderW),
  };

  if (torsoH < 20) {
    jacketAnchor.visible = false;
    renderScene();
    return;
  }

  /* ── Side-Pose Detection ───────────────────────────────
   * When the person turns sideways, the 2D shoulder width (rawShW)
   * collapses because left & right shoulder landmarks nearly overlap.
   * We detect this via the ratio of shoulder width to torso height.
   * Front-facing: ratio ≈ 0.6–1.2
   * Side-facing:  ratio ≈ 0.02–0.20
   *
   * Strategy:
   * 1. Track a stable front-facing shoulder width for reference.
   * 2. Compute a "sideness" factor 0..1.
   * 3. When side, use torsoH-based width (as if seeing jacket from side)
   *    and keep the height the same.
   * 4. Blend smoothly between front and side sizing.
   */
  const shToTorsoRatio = rawShW / torsoH;

  // Update stable reference when clearly front-facing
  if (shToTorsoRatio > 0.45 && rawShW > 50) {
    stableFrontShW = stableFrontShW === 0
      ? rawShW
      : stableFrontShW * 0.85 + rawShW * 0.15;
  }
  // Fallback reference if we never saw a front pose
  const refShW = stableFrontShW > 0 ? stableFrontShW : torsoH * 0.65;

  // sideness: 0 = front, 1 = fully side
  // Ramp from ratio 0.40 (front) down to 0.15 (side)
  const sideness = THREE.MathUtils.clamp(
    1.0 - (shToTorsoRatio - 0.15) / (0.40 - 0.15), 0, 1
  );

  /* HIDE_ON_BAD_POSE: hide jacket on side pose or arms above T-pose */
  if (HIDE_ON_BAD_POSE) {
    const le = landmarks[13], re = landmarks[14]; // elbows
    const armsAboveTpose = (le && le.y < ls.y) || (re && re.y < rs.y); // elbow above shoulder = arms raised
    const isSidePose = sideness > SIDENESS_HIDE_THRESHOLD;

    if (isSidePose || armsAboveTpose) {
      jacketAnchor.visible = false;
      renderScene();
      showPoseInstruction(isSidePose
        ? "Face the camera for best results"
        : "Keep arms below shoulder level");
      return;
    }
    hidePoseInstruction();
  }

  // Front width uses measured shoulders; side width uses body depth
  const frontW = rawShW * 2.97;   // 2.7 shoulders + 10% wider torso
  // Side view: body depth is roughly 35% of the front-view shoulder span
  const sideW = refShW * 2.97 * 0.35;
  const effectiveW = THREE.MathUtils.lerp(frontW, sideW, sideness);

  // Enforce minimum width based on torso height — never let jacket vanish
  const minW = torsoH * 0.60;
  const garmentW = Math.max(effectiveW, minW) * GARMENT_SCALE_FACTOR;
  const garmentH = torsoH * 1.455 * GARMENT_SCALE_FACTOR;

  if (garmentW < 20) {
    jacketAnchor.visible = false;
    renderScene();
    return;
  }

  // Track pose guide
  poseDetectedFrames++;
  if (poseDetectedFrames === POSE_GUIDE_HIDE_AFTER) {
    poseGuide.classList.add("hidden");
    setStatus("Tracking active");
  }

  const pos = toScenePos(center.x, center.y);
  // Shift jacket upward so top edge sits at neckline
  targetJacketPosition.set(pos.x, pos.y - torsoH * 0.19, 2);

  // Shoulder angle: when side-on, the angle becomes very noisy (shoulders overlap)
  // so damp it toward 0 (vertical) as sideness increases
  const rawShoulderAngle = Math.atan2(rs.y - ls.y, rs.x - ls.x);
  const shoulderAngle = THREE.MathUtils.lerp(rawShoulderAngle, 0, sideness * 0.85);

  // Proportional scaling — fit garment to detected body proportions
  const sx = garmentW / jacketBaseSize.x;
  const sy = garmentH / jacketBaseSize.y;
  // Z-depth: increase when side-on for solid appearance
  const baseZ = ((sx + sy) / 2) * 1.1;
  const sideZ = sy * 1.6; // thicker from the side so jacket looks solid
  const sz = THREE.MathUtils.lerp(baseZ, sideZ, sideness);
  targetJacketScale.set(sx, sy, sz);

  jacketAnchor.visible = true;
  const lerpVal = isTracking ? TRACKING_LERP : 1;
  jacketAnchor.position.lerp(targetJacketPosition, lerpVal);
  jacketAnchor.scale.lerp(targetJacketScale, lerpVal);
  jacketAnchor.rotation.z = THREE.MathUtils.lerp(
    jacketAnchor.rotation.z, shoulderAngle, lerpVal
  );

  // Dynamic key light follows shoulder turn for realistic shading
  const lightBias = shoulderAngle * 80;
  keyLight.position.x = THREE.MathUtils.lerp(keyLight.position.x, 100 + lightBias, 0.05);

  // Arm rig: apply when front-facing, forcefully tuck arms when side-on
  if (sideness < 0.3) {
    try { updateArms(landmarks, shoulderAngle); } catch {}
  } else if (armRigState.active && armRigState.bones && armRigState.rest) {
    // Side pose: force arms to rest position
    const { bones, rest } = armRigState;
    const tuckLerp = isImageMode() ? 1.0 : 0.25;
    for (const key of Object.keys(bones)) {
      if (bones[key] && rest[key]) {
        bones[key].quaternion.slerp(rest[key], tuckLerp);
      }
    }
  }

  // Apply world-space clipping planes when side-on to crop protruding sleeves
  if (jacketObject && sideness > 0.3) {
    // World-space: X axis is horizontal on the canvas
    // Allow jacket to extend clipMargin pixels beyond the torso center
    const centerX = pos.x;
    const clipMarginX = garmentW * 0.32; // X crop for side view sleeves
    // Also crop bottom to prevent downward sleeve flare
    const bottomY = pos.y + garmentH * 0.48; // below hip line in screen space (Y increases downward)
    // Plane: normal.dot(point) + constant >= 0 means point is on visible side
    // Left boundary: x >= centerX - clipMarginX
    const clipL = new THREE.Plane(new THREE.Vector3( 1, 0, 0), -(centerX - clipMarginX));
    // Right boundary: x <= centerX + clipMarginX  
    const clipR = new THREE.Plane(new THREE.Vector3(-1, 0, 0), (centerX + clipMarginX));
    // Bottom boundary: y <= bottomY (remember Y is flipped in screen space — positive is down)
    // In ortho camera, Y-axis goes top=0, bottom=canvasH. So y >= 0 is all visible.
    // We want to clip y > bottomY. That's: -y + bottomY >= 0 → normal=(0,-1,0), const=bottomY
    const clipB = new THREE.Plane(new THREE.Vector3(0, -1, 0), bottomY);
    const planes = [clipL, clipR, clipB];
    jacketObject.traverse(n => {
      if (n.isMesh && n.material) {
        const mats = Array.isArray(n.material) ? n.material : [n.material];
        mats.forEach(m => { m.clippingPlanes = planes; m.clipShadows = true; });
      }
    });
  } else if (jacketObject) {
    // Remove clipping for front-facing
    jacketObject.traverse(n => {
      if (n.isMesh && n.material) {
        const mats = Array.isArray(n.material) ? n.material : [n.material];
        mats.forEach(m => { m.clippingPlanes = []; });
      }
    });
  }

  renderScene();
}

/* ── Pose Tracking ───────────────────────────────────── */
async function processImage() {
  if (!pose || !imageEl.src) return;
  try {
    setStatus("Processing image...", "loading");
    pose.setOptions({ staticImageMode: true });
    await pose.send({ image: imageEl });
    await runSegmentation(imageEl);
    setStatus("Garment overlaid");
  } catch (err) {
    jacketAnchor.visible = false;
    clearSeg();
    renderScene();
    setStatus("Processing failed", "error");
  }
}

async function trackFrame() {
  if (!isTracking || !pose) return;
  if (videoEl.paused || videoEl.ended) { stopTracking(); return; }

  frameCount++;
  const now = performance.now();
  if (now - lastFpsTime >= 1000) {
    fpsCounter.textContent = frameCount + " FPS";
    frameCount = 0;
    lastFpsTime = now;
  }

  if (!poseBusy) {
    poseBusy = true;
    try {
      // Pose runs every frame for smooth tracking
      await pose.send({ image: videoEl });

      // Segmentation: mobile skips frames + fire-and-forget; desktop awaits every frame
      segFrameCounter++;
      if (segFrameCounter >= SEG_EVERY_N) {
        segFrameCounter = 0;
        if (IS_MOBILE) {
          // Fire without awaiting so it doesn't block the next pose frame
          runSegmentation(videoEl);
        } else {
          await runSegmentation(videoEl);
        }
      }
    } catch {
      stopTracking();
      setStatus("Tracking lost", "error");
    } finally {
      poseBusy = false;
    }
  }

  if (isTracking) requestAnimationFrame(trackFrame);
}

function startTracking() {
  if (!pose) { setStatus("Models not ready", "error"); return; }
  if (isImageMode()) { processImage(); return; }

  pose.setOptions({ staticImageMode: false });
  isTracking = true;
  videoEl.play();
  toggleBtn.classList.add("recording");
  playIcon.style.display = "none";
  stopIcon.style.display = "block";
  setStatus("Tracking live");
  requestAnimationFrame(trackFrame);
}

function stopTracking() {
  isTracking = false;
  poseBusy = false;
  toggleBtn.classList.remove("recording");
  playIcon.style.display = "block";
  stopIcon.style.display = "none";
  fpsCounter.textContent = "-- FPS";
  setStatus("Tracking paused");
}

/* ── Source Switching ─────────────────────────────────── */
function setActiveSourceBtn(source) {
  sourceButtons.forEach(btn => {
    btn.classList.toggle("active", btn.dataset.source === source);
  });
}

async function switchSource(source) {
  stopTracking();
  poseDetectedFrames = 0;
  poseGuide.classList.remove("hidden");

  if (source !== "camera") stopCamera();

  if (source === "camera") {
    activeSource = "camera";
    setActiveSourceBtn("camera");
    videoEl.style.display = "block";
    imageEl.style.display = "none";
    videoEl.removeAttribute("src");
    await startCamera();
    setTimeout(() => {
      if (activeSource === "camera" && cameraStream) startTracking();
    }, 300);
    return;
  }

  if (source === "upload-video") {
    fileInput.accept = "video/*";
    fileInput.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      activeSource = "video";
      setActiveSourceBtn("upload-video");
      stopCamera();
      videoEl.style.display = "block";
      imageEl.style.display = "none";
      videoEl.srcObject = null;
      videoEl.src = URL.createObjectURL(file);
      videoEl.currentTime = 0;
      await videoEl.play().catch(() => {});
      videoEl.pause();
      syncCanvasSize();
      setStatus("Video loaded — tap play to track");
    };
    fileInput.click();
    return;
  }

  if (source === "upload-image") {
    fileInput.accept = "image/*";
    fileInput.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      activeSource = "image";
      setActiveSourceBtn("upload-image");
      stopCamera();
      videoEl.style.display = "none";
      imageEl.style.display = "block";
      imageEl.src = URL.createObjectURL(file);
      await imageEl.decode().catch(() => {});
      syncCanvasSize();
      setStatus("Image loaded — tap play to detect");
    };
    fileInput.click();
    return;
  }
}

/* ── Screenshot ──────────────────────────────────────── */
function takeScreenshot() {
  const flash = document.createElement("div");
  flash.className = "flash-overlay";
  document.body.appendChild(flash);
  flash.addEventListener("animationend", () => flash.remove());

  const canvas = document.createElement("canvas");
  const el = getActiveEl();
  const w = overlayCanvas.width, h = overlayCanvas.height;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");

  ctx.drawImage(el, 0, 0, w, h);
  if (segmentationEnabled) ctx.drawImage(segCanvas, 0, 0, w, h);
  ctx.drawImage(overlayCanvas, 0, 0, w, h);

  // AIMIRR watermark
  ctx.save();
  ctx.fillStyle = "rgba(244, 237, 228, 0.45)";
  ctx.font = "600 13px Barlow, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("Powered by AIMIRR", w - 14, h - 14);
  ctx.restore();

  // Try native share, fall back to download
  canvas.toBlob(async (blob) => {
    if (navigator.share) {
      try {
        const file = new File([blob], "aimirr-tryon.png", { type: "image/png" });
        await navigator.share({ title: "My AIMIRR Try-On Look", files: [file] });
        setStatus("Shared");
        return;
      } catch (e) {
        if (e.name === "AbortError") return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aimirr-tryon-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus("Screenshot saved");
  });
}

/* ── Product Selector ──────────────────────────────────── */
const PRODUCTS = {
  "aurora-pullover": {
    name: "Aurora Pullover",
    subtitle: "Women's Hoodie without Zipper",
    price: "$50.00",
    url: "https://neonkernel.com/products/womens-futuristic-hoodie-without-zipper",
  },
  "nebula-pullover": {
    name: "Nebula Pullover",
    subtitle: "Men's Hoodie without Zipper",
    price: "$50.00",
    url: "https://neonkernel.com/products/mens-futuristic-hoodie-without-zipper",
  },
  "phantom-zip": {
    name: "Phantom Zip",
    subtitle: "Men's Hoodie with Zipper",
    price: "$50.00",
    url: "https://neonkernel.com/products/mens-futuristic-hoodie-with-zipper",
  },
  "prism-zip": {
    name: "Prism Zip",
    subtitle: "Women's Hoodie with Zipper",
    price: "$50.00",
    url: "https://neonkernel.com/products/womens-futuristic-hoodie-with-zipper",
  },
};

async function selectProduct(productId) {
  // "default" means the original red jacket
  const isDefault = (productId === "default" || !productId);
  selectedProduct = isDefault ? null : productId;

  // Update active card
  productCards.forEach(card => {
    const match = isDefault
      ? card.dataset.product === "default"
      : card.dataset.product === productId;
    card.classList.toggle("active", match);
  });

  // Update shop link
  if (!isDefault && PRODUCTS[productId]) {
    shopLink.href = PRODUCTS[productId].url;
    shopLink.style.display = "";
  } else {
    shopLink.style.display = "none";
  }

  // Apply color swap on the existing jacket mesh — instant, no GLB reload needed
  const displayName = isDefault ? "Red Jacket" : PRODUCTS[productId]?.name || productId;
  applyProductColor(isDefault ? null : productId);
  setStatus(`${displayName} applied`);

  // Re-process current image if in image mode
  if (isImageMode() && imageEl.src) {
    processImage();
  }
}

/* ── Custom Texture Upload ────────────────────────────── */
// Allows the user to upload a PNG/JPG that replaces the jacket's base texture at runtime.
// The uploaded image is applied to all mesh materials on the jacket.
function applyCustomTexture(file) {
  if (!jacketObject) { setStatus("Load a garment first", "warning"); return; }

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const tex = new THREE.Texture(img);
      tex.flipY = false;              // GLB textures use top-left origin
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;

      const hasAlpha = file.type === "image/png";

      jacketObject.traverse(n => {
        if (!n.isMesh || !n.material) return;
        const mats = Array.isArray(n.material) ? n.material : [n.material];
        mats.forEach(mat => {
          mat.map = tex;
          mat.color.setHex(0xffffff); // neutral so texture shows true colors
          if (hasAlpha) {
            mat.transparent = true;
            mat.alphaTest = 0.05;
          }
          mat.needsUpdate = true;
        });
      });

      customTextureApplied = true;
      textureUploadLabel.classList.add("has-texture");
      textureResetBtn.style.display = "";
      setStatus("Custom texture applied");
      renderScene();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

/* Load a texture from a URL and apply it to the jacket.
 * Works with any publicly accessible image URL (PNG, JPG, WebP).
 * Also used by the ?texture=<url> URL parameter. */
function applyTextureFromURL(url) {
  if (!jacketObject) { setStatus("Load a garment first", "warning"); return; }
  if (!url || !url.trim()) return;

  setStatus("Loading texture...");
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    const tex = new THREE.Texture(img);
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;

    const hasAlpha = url.toLowerCase().includes(".png");

    jacketObject.traverse(n => {
      if (!n.isMesh || !n.material) return;
      const mats = Array.isArray(n.material) ? n.material : [n.material];
      mats.forEach(mat => {
        mat.map = tex;
        mat.color.setHex(0xffffff);
        if (hasAlpha) {
          mat.transparent = true;
          mat.alphaTest = 0.05;
        }
        mat.needsUpdate = true;
      });
    });

    customTextureApplied = true;
    textureUploadLabel.classList.add("has-texture");
    textureResetBtn.style.display = "";
    if (textureUrlInput) {
      textureUrlInput.value = url;
      textureUrlInput.classList.add("loaded");
    }
    setStatus("URL texture applied");
    renderScene();
  };
  img.onerror = () => {
    setStatus("Failed to load texture URL", "warning");
    console.warn("Texture URL load failed:", url);
  };
  img.src = url;
}

function resetCustomTexture() {
  if (!jacketObject || !originalMaterialState) return;

  // Restore the original material (or re-apply current product color)
  if (selectedProduct) {
    applyProductColor(selectedProduct);
  } else {
    applyProductColor(null); // restores original red jacket
  }

  customTextureApplied = false;
  textureUploadLabel.classList.remove("has-texture");
  textureResetBtn.style.display = "none";
  if (textureInput) textureInput.value = "";
  if (textureUrlInput) { textureUrlInput.value = ""; textureUrlInput.classList.remove("loaded"); }
  setStatus("Texture reset to default");
  renderScene();
}

function toggleProductPanel() {
  productPanel.classList.toggle("open");
}

/* ── Event Binding ───────────────────────────────────── */
function bindEvents() {
  sourceButtons.forEach(btn => {
    btn.addEventListener("click", () => switchSource(btn.dataset.source));
  });

  toggleBtn.addEventListener("click", () => {
    isTracking ? stopTracking() : startTracking();
  });

  flipBtn.addEventListener("click", async () => {
    if (activeSource !== "camera") return;
    facingMode = facingMode === "user" ? "environment" : "user";
    await startCamera();
    setTimeout(() => {
      if (activeSource === "camera" && cameraStream) startTracking();
    }, 300);
  });

  segBtn.addEventListener("click", () => {
    segmentationEnabled = !segmentationEnabled;
    segBtn.classList.toggle("active", segmentationEnabled);
    if (!segmentationEnabled) clearSeg();
    setStatus(segmentationEnabled ? "Background removal on" : "Background removal off");
  });

  screenshotBtn.addEventListener("click", takeScreenshot);

  // Product selector
  productToggleBtn.addEventListener("click", toggleProductPanel);
  productCards.forEach(card => {
    card.addEventListener("click", () => selectProduct(card.dataset.product));
  });

  // Texture upload
  if (textureInput) {
    textureInput.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (file) applyCustomTexture(file);
    });
  }
  if (textureResetBtn) {
    textureResetBtn.addEventListener("click", resetCustomTexture);
  }

  // Texture URL load
  if (textureUrlLoadBtn && textureUrlInput) {
    textureUrlLoadBtn.addEventListener("click", () => {
      applyTextureFromURL(textureUrlInput.value.trim());
    });
    textureUrlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") applyTextureFromURL(textureUrlInput.value.trim());
    });
  }

  window.addEventListener("resize", syncCanvasSize);
  videoEl.addEventListener("loadeddata", syncCanvasSize);
  imageEl.addEventListener("load", syncCanvasSize);
}

/* ── Initialization ──────────────────────────────────── */
async function initPose() {
  setLoading("Loading pose detection...", 20);
  pose = new window.Pose({
    locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
  });
  pose.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  pose.onResults(results => {
    const lm = results.poseLandmarks || [];
    placeGarment(lm);
  });
}

async function initSegmentation() {
  setLoading("Loading segmentation...", 50);
  selfieSegmentation = new window.SelfieSegmentation({
    locateFile: file =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`,
  });
  // modelSelection: 0 = "landscape" (lighter/faster)
  // modelSelection: 1 = "general" (better edges, heavier)
  selfieSegmentation.setOptions({ modelSelection: IS_MOBILE ? 0 : 1 });
  selfieSegmentation.onResults(results => {
    renderSegOverlay(results.segmentationMask);
  });
}

async function init() {
  bindEvents();

  setLoading("Loading garment model...", 5);
  const glbLoaded = await loadGarment();
  setLoading(glbLoaded ? "Garment loaded" : "Using placeholder garment", 15);

  // Apply texture from ?texture=<url> URL parameter if present
  const urlParams = new URLSearchParams(window.location.search);
  const textureParam = urlParams.get("texture");
  if (textureParam) {
    setLoading("Applying texture from URL...", 18);
    applyTextureFromURL(textureParam);
  }

  await initPose();
  await initSegmentation();

  setLoading("Starting camera...", 80);
  await startCamera();

  setLoading("Ready", 100);

  setTimeout(() => {
    loadingScreen.classList.add("hidden");
    appEl.style.display = "flex";
    syncCanvasSize();

    // Auto-start tracking
    setTimeout(() => {
      if (activeSource === "camera" && cameraStream) startTracking();
    }, 400);
  }, 500);
}

window.addEventListener("beforeunload", () => {
  stopTracking();
  stopCamera();
});

init().catch(err => {
  setLoading("Init failed: " + err.message, 0);
  console.error(err);
});
