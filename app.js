import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const canvas = document.getElementById('scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
} catch (e) {
  document.getElementById('fallback').style.display = 'grid';
  throw e;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbfe6ea);
scene.fog = new THREE.Fog(0xbfe6ea, 20, 46);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 120);
camera.position.set(0, 10.5, 12.5);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0, 0.6);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.rotateSpeed = 0.5;
controls.minDistance = 6.5;
controls.maxDistance = 22;
controls.minPolarAngle = 0.3;
controls.maxPolarAngle = 1.18;
controls.minAzimuthAngle = -1.0;
controls.maxAzimuthAngle = 1.0;

/* ---------- lights ---------- */
scene.add(new THREE.HemisphereLight(0xddf5ff, 0x9fc4bb, 1.05));
const sun = new THREE.DirectionalLight(0xfff6e8, 1.5);
sun.position.set(6, 12, 4);
scene.add(sun);

/* ---------- shared uniforms ---------- */
const MAXR = 16;
const rippleVecs = Array.from({ length: MAXR }, () => new THREE.Vector4(0, 0, -100, 0));
let rippleIdx = 0;
const uTime = { value: 0 };

const MAXS = 24;
const shadowVecs = Array.from({ length: MAXS }, () => new THREE.Vector4(0, 0, 0.001, 0));

/* ---------- GLSL: caustics + hash ---------- */
const GLSL_NOISE = /* glsl */`
vec2 hash22(vec2 p){
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
float voronoi(vec2 x, float t){
  vec2 n = floor(x), f = fract(x);
  float f1 = 8.0, f2 = 8.0;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    vec2 g = vec2(float(i), float(j));
    vec2 o = hash22(n + g);
    o = 0.5 + 0.5 * sin(t + 6.2831 * o);
    vec2 r = g + o - f;
    float d = dot(r, r);
    if(d < f1){ f2 = f1; f1 = d; } else if(d < f2){ f2 = d; }
  }
  return f2 - f1;
}
float caustic(vec2 uv, float t){
  float c = voronoi(uv * 1.1, t);
  c = 1.0 - clamp(c, 0.0, 1.0);
  float c2 = voronoi(uv * 2.3 + 7.7, t * 1.3);
  c2 = 1.0 - clamp(c2, 0.0, 1.0);
  return pow(c, 3.2) * 0.85 + pow(c2, 5.0) * 0.5;
}
`;

/* ---------- pool floor ---------- */
const floorMat = new THREE.ShaderMaterial({
  uniforms: {
    uTime,
    uShadows: { value: shadowVecs },
    uFogColor: { value: new THREE.Color(0xbfe6ea) },
    uFogNear: { value: 20 },
    uFogFar: { value: 46 },
  },
  vertexShader: /* glsl */`
    varying vec3 vWorld;
    void main(){
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: /* glsl */`
    uniform float uTime;
    uniform vec4 uShadows[${MAXS}];
    uniform vec3 uFogColor;
    uniform float uFogNear, uFogFar;
    varying vec3 vWorld;
    ${GLSL_NOISE}
    void main(){
      vec2 p = vWorld.xz;
      float dist = length(p);
      vec3 shallow = vec3(0.62, 0.88, 0.87);
      vec3 deep    = vec3(0.05, 0.42, 0.50);
      vec3 col = mix(shallow, deep, smoothstep(2.0, 26.0, dist));
      col = mix(col, deep * 0.85, smoothstep(0.0, 3.0, -vWorld.z + 14.0) * 0.2);
      float ca = caustic(p * 0.55 + vec2(uTime * 0.03), uTime * 0.9);
      float ca2 = caustic(p * 0.33 - vec2(uTime * 0.02), uTime * 0.7);
      col += (ca * 0.55 + ca2 * 0.35) * vec3(0.9, 1.0, 0.98) * (1.0 - smoothstep(6.0, 30.0, dist) * 0.55);
      for(int i=0;i<${MAXS};i++){
        vec4 s = uShadows[i];
        if(s.z > 0.01){
          float d = distance(p, s.xy) / s.z;
          float dark = (1.0 - smoothstep(0.0, 1.0, d)) * s.w;
          col *= 1.0 - dark * 0.62;
        }
      }
      float fog = smoothstep(uFogNear, uFogFar, length(vWorld - cameraPosition));
      col = mix(col, uFogColor, fog);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80, 1, 1), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -2.1;
scene.add(floor);

/* ---------- water surface ---------- */
const waterMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: {
    uTime,
    uRipples: { value: rippleVecs },
    uSunDir: { value: new THREE.Vector3(6, 12, 4).normalize() },
    uFogColor: { value: new THREE.Color(0xbfe6ea) },
    uFogNear: { value: 20 },
    uFogFar: { value: 46 },
  },
  vertexShader: /* glsl */`
    varying vec3 vWorld;
    void main(){
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: /* glsl */`
    uniform float uTime;
    uniform vec4 uRipples[${MAXR}];
    uniform vec3 uSunDir;
    uniform vec3 uFogColor;
    uniform float uFogNear, uFogFar;
    varying vec3 vWorld;
    ${GLSL_NOISE}
    float waveH(vec2 p, float t){
      float h = 0.0;
      h += sin(p.x * 1.3 + t * 0.9) * 0.045;
      h += sin(p.y * 1.8 - t * 0.75) * 0.038;
      h += sin((p.x + p.y) * 2.4 + t * 1.25) * 0.022;
      h += sin(p.x * 4.3 - t * 1.9) * 0.011;
      h += sin(p.y * 5.1 + t * 2.2) * 0.009;
      for(int i=0;i<${MAXR};i++){
        vec4 rp = uRipples[i];
        float age = t - rp.z;
        if(age > 0.0 && age < 4.0){
          float r = distance(p, rp.xy);
          float front = r - age * 2.1;
          float ring = exp(-front * front * 9.0) * exp(-age * 1.35) * rp.w;
          h += ring * sin(front * 15.0) * 0.075;
        }
      }
      return h;
    }
    void main(){
      vec2 p = vWorld.xz;
      float t = uTime;
      float e = 0.09;
      float hC = waveH(p, t);
      float hX = waveH(p + vec2(e, 0.0), t);
      float hZ = waveH(p + vec2(0.0, e), t);
      vec3 N = normalize(vec3(hC - hX, e * 2.2, hC - hZ));
      vec3 V = normalize(cameraPosition - vWorld);
      float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
      vec3 deepCol = vec3(0.06, 0.47, 0.55);
      vec3 skyCol  = vec3(0.82, 0.94, 0.95);
      vec3 col = mix(deepCol, skyCol, 0.25 + fres * 0.75);
      vec3 R = reflect(-uSunDir, N);
      float spec = pow(max(dot(R, V), 0.0), 90.0);
      col += spec * vec3(1.0, 0.98, 0.9) * 1.1;
      float sparkle = caustic(p * 1.6 + 3.1, t * 1.4);
      col += sparkle * 0.10 * vec3(1.0);
      float foam = 0.0;
      for(int i=0;i<${MAXR};i++){
        vec4 rp = uRipples[i];
        float age = t - rp.z;
        if(age > 0.0 && age < 3.0){
          float r = distance(p, rp.xy);
          float front = r - age * 2.1;
          float ring = exp(-front * front * 26.0) * exp(-age * 1.6) * rp.w;
          foam += ring;
        }
      }
      foam = clamp(foam, 0.0, 1.0);
      col = mix(col, vec3(0.97, 1.0, 1.0), foam * 0.85);
      float alpha = mix(0.62, 0.96, fres) + foam * 0.3 + spec * 0.3;
      float fog = smoothstep(uFogNear, uFogFar, length(vWorld - cameraPosition));
      col = mix(col, uFogColor, fog);
      gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.97));
    }
  `,
});
const water = new THREE.Mesh(new THREE.PlaneGeometry(80, 80, 1, 1), waterMat);
water.rotation.x = -Math.PI / 2;
water.position.y = 0;
scene.add(water);

function addRipple(x, z, strength){
  rippleVecs[rippleIdx].set(x, z, uTime.value, strength);
  rippleIdx = (rippleIdx + 1) % MAXR;
}

/* ---------- petal texture painter ---------- */
function petalTexture({ base, tip, stripe = null, stripeAlpha = 0.5, blotch = null }){
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 256, 0, 0);
  grad.addColorStop(0, base);
  grad.addColorStop(0.45, tip);
  grad.addColorStop(1, tip);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 256);
  if(blotch){
    const rg = g.createRadialGradient(64, 235, 4, 64, 235, 110);
    rg.addColorStop(0, blotch);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, 128, 256);
  }
  if(stripe){
    const sg = g.createLinearGradient(0, 0, 128, 0);
    sg.addColorStop(0, 'rgba(0,0,0,0)');
    sg.addColorStop(0.5, stripe);
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = stripeAlpha;
    g.fillStyle = sg;
    g.fillRect(0, 0, 128, 256);
    g.globalAlpha = 1;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ---------- petal geometry ---------- */
function petalGeometry({ len = 1, wid = 0.5, curl = 0.3, cup = 0.16, twist = 0, sharp = 0.85 }){
  const segL = 18, segW = 12;
  const pos = [], uv = [], idx = [];
  for(let i = 0; i <= segL; i++){
    const v = i / segL;
    const profile = Math.pow(Math.sin(Math.PI * Math.pow(v, sharp)), 0.75);
    const halfW = wid * 0.5 * profile;
    for(let j = 0; j <= segW; j++){
      const u = j / segW - 0.5;
      let x = u * 2 * halfW;
      let y = cup * (x * x) / Math.max(wid, 0.01) + curl * v * v * len * 0.5;
      const z = v * len;
      const a = twist * v;
      const ca = Math.cos(a), sa = Math.sin(a);
      const xr = x * ca - y * sa * 0.4;
      const yr = y * ca + x * sa * 0.6;
      pos.push(xr, yr, z);
      uv.push(j / segW, v);
    }
  }
  for(let i = 0; i < segL; i++){
    for(let j = 0; j < segW; j++){
      const a = i * (segW + 1) + j;
      const b = a + segW + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/* ---------- species ---------- */
function buildHibiscus(scale, palette){
  const g = new THREE.Group();
  const tex = petalTexture({
    base: palette.base, tip: palette.tip, stripe: palette.stripe, stripeAlpha: 0.55, blotch: palette.blotch,
  });
  const mat = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.75, metalness: 0, emissive: palette.tip, emissiveIntensity: 0.38, emissiveMap: tex });
  const geo = petalGeometry({ len: 0.95, wid: 1.35, curl: 0.24, cup: 0.2, sharp: 0.58 });
  for(let i = 0; i < 5; i++){
    const m = new THREE.Mesh(geo, mat);
    m.rotation.order = 'YXZ';
    m.rotation.y = (i / 5) * Math.PI * 2 + 0.3;
    m.rotation.x = -Math.PI / 2 + 1.12;
    g.add(m);
  }
  const columnMat = new THREE.MeshStandardMaterial({ color: palette.column, roughness: 0.5 });
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.5, 6), columnMat);
  column.position.y = 0.28;
  column.rotation.z = 0.12;
  g.add(column);
  const antherMat = new THREE.MeshStandardMaterial({ color: 0xffd94d, roughness: 0.5 });
  const antherGeo = new THREE.SphereGeometry(0.028, 6, 5);
  for(let i = 0; i < 7; i++){
    const a = new THREE.Mesh(antherGeo, antherMat);
    const ang = (i / 7) * Math.PI * 2;
    a.position.set(Math.cos(ang) * 0.055, 0.52 + Math.sin(i * 2.3) * 0.02, Math.sin(ang) * 0.055);
    g.add(a);
  }
  const heart = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 10, 8),
    new THREE.MeshStandardMaterial({ color: palette.heart, roughness: 0.6 })
  );
  heart.position.y = 0.05;
  g.add(heart);
  g.scale.setScalar(scale);
  return g;
}

function buildLily(scale){
  const g = new THREE.Group();
  const tex = petalTexture({ base: '#cfe3c2', tip: '#ffffff', stripe: 'rgba(180,215,170,0.7)', stripeAlpha: 0.5, blotch: 'rgba(190,225,180,0.85)' });
  const mat = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.75, metalness: 0, emissive: 0xf2f7ec, emissiveIntensity: 0.38, emissiveMap: tex });
  const geo = petalGeometry({ len: 1.15, wid: 0.72, curl: 0.34, cup: 0.14, sharp: 0.55 });
  for(let i = 0; i < 6; i++){
    const m = new THREE.Mesh(geo, mat);
    m.rotation.order = 'YXZ';
    const layer = i % 2;
    m.rotation.y = (i / 6) * Math.PI * 2 + layer * 0.52;
    m.rotation.x = -Math.PI / 2 + (layer ? 1.12 : 0.92);
    g.add(m);
  }
  const filamentMat = new THREE.MeshStandardMaterial({ color: 0xd7e8c9, roughness: 0.5 });
  const antherMat = new THREE.MeshStandardMaterial({ color: 0x9c6b30, roughness: 0.5 });
  for(let i = 0; i < 5; i++){
    const ang = (i / 5) * Math.PI * 2;
    const fil = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.55, 5), filamentMat);
    fil.position.set(Math.cos(ang) * 0.16, 0.3, Math.sin(ang) * 0.16);
    fil.rotation.z = Math.cos(ang) * 0.55;
    fil.rotation.x = -Math.sin(ang) * 0.55;
    g.add(fil);
    const an = new THREE.Mesh(new THREE.CapsuleGeometry(0.02, 0.09, 3, 6), antherMat);
    an.position.set(Math.cos(ang) * 0.34, 0.52, Math.sin(ang) * 0.34);
    an.rotation.z = Math.cos(ang) * 1.2;
    an.rotation.x = -Math.sin(ang) * 1.2;
    g.add(an);
  }
  const pistil = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.026, 0.55, 6), new THREE.MeshStandardMaterial({ color: 0xa8c68a, roughness: 0.5 }));
  pistil.position.y = 0.3;
  g.add(pistil);
  g.scale.setScalar(scale);
  return g;
}

function buildPlumeria(scale){
  const g = new THREE.Group();
  const tex = petalTexture({ base: '#ffd84d', tip: '#fffdf4', blotch: 'rgba(255,205,60,0.9)' });
  const mat = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.75, metalness: 0, emissive: 0xfff3c4, emissiveIntensity: 0.35, emissiveMap: tex });
  const geo = petalGeometry({ len: 0.9, wid: 1.0, curl: 0.16, cup: 0.1, twist: 0.8, sharp: 0.62 });
  for(let i = 0; i < 5; i++){
    const m = new THREE.Mesh(geo, mat);
    m.rotation.order = 'YXZ';
    m.rotation.y = (i / 5) * Math.PI * 2;
    m.rotation.x = -Math.PI / 2 + 1.08;
    g.add(m);
  }
  g.scale.setScalar(scale);
  return g;
}

const SPECIES = [
  { id: 'pink-hibiscus',  name: 'Pink hibiscus',   dot: '#f06292', build: s => buildHibiscus(s, { base: '#a4133c', tip: '#ff6fa5', stripe: 'rgba(120,10,45,0.9)', blotch: 'rgba(140,15,55,0.95)', column: 0xd62839, heart: 0x8f1038 }) },
  { id: 'bright-hibiscus',name: 'Bright hibiscus', dot: '#ff2e88', build: s => buildHibiscus(s, { base: '#c9184a', tip: '#ff4d9d', stripe: 'rgba(255,220,235,0.55)', blotch: 'rgba(190,20,80,0.9)', column: 0xe0355f, heart: 0xb01144 }) },
  { id: 'white-lily',     name: 'White lily',      dot: '#f4f9f0', build: s => buildLily(s) },
  { id: 'plumeria',       name: 'Plumeria',        dot: '#ffd84d', build: s => buildPlumeria(s) },
];
let currentSpecies = 0;

/* ---------- soft blob shadows on the floor ---------- */
const shadowCanvas = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  rg.addColorStop(0, 'rgba(0,25,30,0.55)');
  rg.addColorStop(1, 'rgba(0,25,30,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  return t;
})();
const shadowMat = new THREE.MeshBasicMaterial({ map: shadowCanvas, transparent: true, depthWrite: false });
const shadowGeo = new THREE.PlaneGeometry(1, 1);

/* ---------- splash droplets ---------- */
const dropSprite = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  rg.addColorStop(0, 'rgba(255,255,255,1)');
  rg.addColorStop(0.6, 'rgba(230,250,252,0.65)');
  rg.addColorStop(1, 'rgba(230,250,252,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();

const splashes = [];
function spawnSplash(x, z, power){
  const n = Math.floor(40 + power * 40);
  const positions = new Float32Array(n * 3);
  const vels = [];
  for(let i = 0; i < n; i++){
    positions[i * 3] = x; positions[i * 3 + 1] = 0.05; positions[i * 3 + 2] = z;
    const ang = Math.random() * Math.PI * 2;
    const speed = (0.6 + Math.random() * 1.6) * (0.5 + power * 0.5);
    vels.push(new THREE.Vector3(Math.cos(ang) * speed * 0.55, 1.2 + Math.random() * 2.2 * power, Math.sin(ang) * speed * 0.55));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ map: dropSprite, size: 0.14, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
  const pts = new THREE.Points(geo, mat);
  scene.add(pts);
  splashes.push({ pts, vels, life: 0, maxLife: 0.85 + Math.random() * 0.2 });
}

/* ---------- flowers ---------- */
const flowers = [];
const MAX_FLOWERS = 36;

function dropFlower(speciesIdx, x, z){
  const spec = SPECIES[speciesIdx];
  const scale = 0.85 + Math.random() * 0.45;
  const mesh = spec.build(scale);
  mesh.position.set(x + (Math.random() - 0.5) * 0.2, 6.1 + Math.random() * 1.0, z);
  mesh.rotation.y = Math.random() * Math.PI * 2;
  scene.add(mesh);

  const shadow = new THREE.Mesh(shadowGeo, shadowMat.clone());
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(x, -2.05, z);
  shadow.scale.setScalar(0.6);
  scene.add(shadow);

  const f = {
    mesh, shadow,
    state: 'falling',
    vy: 0,
    spin: (Math.random() - 0.5) * 1.6,
    bobPhase: Math.random() * Math.PI * 2,
    driftSeed: Math.random() * 100,
    rock: 0, rockVel: 0,
    scale,
    fade: 1,
    driftDir: Math.random() * Math.PI * 2,
  };
  flowers.push(f);

  if(flowers.filter(o => o.state !== 'dying').length > MAX_FLOWERS){
    const oldest = flowers.find(o => o.state === 'floating');
    if(oldest) oldest.state = 'dying';
  }
  return f;
}

function updateFlower(f, dt, t){
  const m = f.mesh;
  if(f.state === 'falling'){
    f.vy -= 13.0 * dt;
    m.position.y += f.vy * dt;
    m.rotation.y += f.spin * dt;
    const h = Math.max(m.position.y, 0);
    const s = f.scale * (1.7 - Math.min(h / 7.5, 1) * 0.9);
    f.shadow.scale.setScalar(s);
    f.shadow.material.opacity = Math.min(0.28 + (1 - Math.min(h / 7.5, 1)) * 0.4, 0.68);
    if(m.position.y <= 0.06){
      m.position.y = 0.06;
      f.state = 'floating';
      const power = Math.min(Math.abs(f.vy) / 6, 1.4);
      addRipple(m.position.x, m.position.z, 0.7 + power * 0.7);
      spawnSplash(m.position.x, m.position.z, power);
      f.rockVel = 2.4 * power;
      f.vy = 0;
    }
  } else if(f.state === 'floating' || f.state === 'dying'){
    m.position.y = 0.06 + Math.sin(t * 1.25 + f.bobPhase) * 0.035;
    const drift = 0.14;
    f.driftDir += Math.sin(t * 0.13 + f.driftSeed) * 0.15 * dt;
    m.position.x += Math.cos(f.driftDir) * drift * dt + Math.sin(t * 0.21 + f.driftSeed * 2.0) * 0.05 * dt;
    m.position.z += Math.sin(f.driftDir) * drift * dt + Math.cos(t * 0.17 + f.driftSeed) * 0.05 * dt;
    const rr = Math.hypot(m.position.x, m.position.z);
    if(rr > 13){
      f.driftDir = Math.atan2(-m.position.z, -m.position.x) + (Math.random() - 0.5) * 0.6;
    }
    m.rotation.y += f.spin * 0.25 * dt;
    f.rockVel += (-f.rock * 6 - f.rockVel * 1.4) * dt;
    f.rock += f.rockVel * dt;
    m.rotation.x = f.rock * 0.12 + Math.sin(t * 1.1 + f.bobPhase) * 0.02;
    m.rotation.z = f.rock * 0.1 + Math.cos(t * 0.9 + f.bobPhase * 1.3) * 0.02;
    f.shadow.position.set(m.position.x, -2.05, m.position.z);
    f.shadow.scale.setScalar(f.scale * 1.7);
    if(f.state === 'dying'){
      f.fade -= dt * 1.6;
      const s = Math.max(f.fade, 0.0001);
      m.scale.setScalar(f.scale * s);
      f.shadow.material.opacity = 0.68 * s;
      if(f.fade <= 0){
        scene.remove(m); scene.remove(f.shadow);
        flowers.splice(flowers.indexOf(f), 1);
      }
    }
  }
}

/* ---------- shader floor shadows from floating flowers ---------- */
function syncShadowUniforms(){
  let i = 0;
  for(const f of flowers){
    if(i >= MAXS) break;
    if(f.state === 'falling') continue;
    shadowVecs[i].set(f.mesh.position.x, f.mesh.position.z, f.scale * 1.35, f.fade * 0.55);
    i++;
  }
  for(; i < MAXS; i++) shadowVecs[i].set(0, 0, 0.001, 0);
}

/* ---------- UI ---------- */
const optsEl = document.getElementById('opts');
SPECIES.forEach((s, i) => {
  const label = document.createElement('label');
  label.className = 'opt' + (i === 0 ? ' sel' : '');
  label.innerHTML = `<input type="radio" name="sp" value="${i}"><span class="dot" style="background:${s.dot}"></span>${s.name}`;
  label.addEventListener('click', () => {
    currentSpecies = i;
    optsEl.querySelectorAll('.opt').forEach(o => o.classList.remove('sel'));
    label.classList.add('sel');
  });
  optsEl.appendChild(label);
});
document.getElementById('clear').addEventListener('click', () => {
  for(const f of flowers) if(f.state !== 'dying') f.state = 'dying';
});

/* ---------- click to drop ---------- */
const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let downPos = null;
canvas.addEventListener('pointerdown', e => { downPos = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', e => {
  if(!downPos) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  downPos = null;
  if(moved > 7) return;
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  if(raycaster.ray.intersectPlane(groundPlane, hit)){
    const r = Math.hypot(hit.x, hit.z);
    if(r > 13){ hit.x *= 13 / r; hit.z *= 13 / r; }
    dropFlower(currentSpecies, hit.x, hit.z);
  }
});

/* ---------- verification hook: ?shot pre-lands flowers ---------- */
const shotMode = new URLSearchParams(location.search).has('shot');
if(shotMode){
  const spots = [[-1.6,-0.4],[1.4,0.9],[0.2,-1.8],[2.6,-0.9],[-2.8,1.2],[-0.9,2.2],[3.4,1.8],[-3.6,-2.2],[1.1,-3.4],[-1.2,3.8]];
  spots.forEach((p, i) => {
    const f = dropFlower(i % SPECIES.length, p[0], p[1]);
    f.state = 'floating';
    f.mesh.position.y = 0.06;
    f.shadow.material.opacity = 0.55;
    f.shadow.scale.setScalar(f.scale * 1.7);
  });
}

/* ---------- ambience: intro + occasional auto drops ---------- */
const introDrops = [
  { t: 0.9,  sp: 0, x: -1.6, z: -0.4 },
  { t: 2.0,  sp: 2, x: 1.4,  z: 0.9 },
  { t: 3.1,  sp: 3, x: 0.2,  z: -1.8 },
  { t: 4.4,  sp: 1, x: 2.6,  z: -0.9 },
];
let introDone = false, startT = null;
function scheduleAuto(){
  setTimeout(() => {
    const alive = flowers.filter(f => f.state !== 'dying').length;
    if(alive < 14 && !document.hidden){
      const ang = Math.random() * Math.PI * 2;
      const r = 2 + Math.random() * 7;
      dropFlower(Math.floor(Math.random() * SPECIES.length), Math.cos(ang) * r, Math.sin(ang) * r);
    }
    if(!shotMode) scheduleAuto();
  }, 6000 + Math.random() * 4000);
}
if(!shotMode) scheduleAuto();

/* ---------- loop ---------- */
const clock = new THREE.Clock();
function tick(){
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  uTime.value = t;
  if(startT === null) startT = t;
  const et = t - startT;
  for(const d of introDrops){
    if(!shotMode && !d.done && et >= d.t){ d.done = true; dropFlower(d.sp, d.x, d.z); }
  }
  for(let i = flowers.length - 1; i >= 0; i--) updateFlower(flowers[i], dt, t);
  for(let i = splashes.length - 1; i >= 0; i--){
    const s = splashes[i];
    s.life += dt;
    const pos = s.pts.geometry.attributes.position;
    for(let j = 0; j < s.vels.length; j++){
      const v = s.vels[j];
      v.y -= 7.5 * dt;
      pos.array[j * 3] += v.x * dt;
      pos.array[j * 3 + 1] += v.y * dt;
      pos.array[j * 3 + 2] += v.z * dt;
      if(pos.array[j * 3 + 1] < 0) pos.array[j * 3 + 1] = 0;
    }
    pos.needsUpdate = true;
    s.pts.material.opacity = Math.max(0, 0.95 * (1 - s.life / s.maxLife));
    if(s.life >= s.maxLife){
      scene.remove(s.pts);
      s.pts.geometry.dispose();
      s.pts.material.dispose();
      splashes.splice(i, 1);
    }
  }
  syncShadowUniforms();
  controls.update();
  renderer.render(scene, camera);
}
tick();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
