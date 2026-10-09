import * as THREE from 'three';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const filePly = $('filePly'), btnDemo = $('btnDemo'), btnSensor = $('btnSensor'), btnCamera = $('btnCamera');
const selAxis = $('selAxis'), rngHeight = $('rngHeight'), rngFov = $('rngFov'), heightVal = $('heightVal'), fovVal = $('fovVal');
const chkCompass = $('chkCompass'), chkGyro = $('chkGyro'), chkStep = $('chkStep');
const rngStep = $('rngStep'), stepVal = $('stepVal'), btnNorth = $('btnNorth'), btnExportMap = $('btnExportMap');
const statusLine = $('statusLine'), poseText = $('poseText'), yawText = $('yawText'), compassText = $('compassText');
const video = $('video'), overlay = $('overlay'), rngOpacity = $('rngOpacity'), hudYaw = $('hudYaw');
const rngPitch = $('rngPitch'), pitchVal = $('pitchVal');
const topmap = $('topmap'), tctx = topmap.getContext('2d');
const rngGrid = $('rngGrid'), stepGridVal = $('stepGridVal');

// ---------- State ----------
const S = {
  axis: 'YZ',            // 'YZ': Xが上 / 'XZ': Yが上
  pts: null,             // Float32Array xyz
  count: 0,
  bounds: null,          // {min:[x,y,z], max:[x,y,z]}
  top: null,             // offscreen canvas (上面投影)
  map: null,             // {ou, ov, scale, size}
  pose: { u: 0, v: 0, yaw: 0 },  // yaw deg, 0=地図上向き, 時計回り+
  trim: 0,               // コンパス連動時の補正
  eyeH: 1.4, fov: 62, pitchMan: 0, opacity: 0.9, grid: 0.2, stepLen: 0.6,
  heading: null, pitchDev: null, rollDev: null,
  trail: [],
  liveOnly: true,
};
try {
  const saved = JSON.parse(localStorage.getItem('plyloc') || '{}');
  if (saved.pose) S.pose = saved.pose;
  if (saved.axis) { S.axis = saved.axis; selAxis.value = saved.axis; }
  if (saved.eyeH) { S.eyeH = saved.eyeH; rngHeight.value = saved.eyeH; }
  if (saved.fov) { S.fov = saved.fov; rngFov.value = saved.fov; }
} catch {}
function save() { try { localStorage.setItem('plyloc', JSON.stringify({ pose: S.pose, axis: S.axis, eyeH: S.eyeH, fov: S.fov })); } catch {} }

// 軸マッピング: 3D座標 <-> (u,v,h)
function axes() {
  // U,V,UP を単位ベクトルで返す
  if (S.axis === 'YZ') return { u: 1, v: 2, up: 0, U: new THREE.Vector3(0,1,0), V: new THREE.Vector3(0,0,1), UP: new THREE.Vector3(1,0,0) };
  return { u: 0, v: 2, up: 1, U: new THREE.Vector3(1,0,0), V: new THREE.Vector3(0,0,1), UP: new THREE.Vector3(0,1,0) };
}
const gU = (p) => p[axes().u], gV = (p) => p[axes().v], gH = (p) => p[axes().up];

// ---------- Three.js live overlay ----------
const renderer = new THREE.WebGLRenderer({ canvas: overlay, alpha: true, antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(S.fov, 3/4, 0.1, 500);
let pointsObj = null;

function resizeLive() {
  const r = overlay.parentElement.getBoundingClientRect();
  const w = Math.max(2, r.width|0), h = Math.max(2, r.height|0);
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resizeLive).observe(overlay.parentElement);
resizeLive();

function setPoints(buffer, n) {
  S.pts = buffer; S.count = n;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(buffer, 3));
  // 高さで色付け
  const ax = axes(); const cols = new Float32Array(n*3);
  let mn = Infinity, mx = -Infinity;
  for (let i=0;i<n;i++){ const h = buffer[i*3+ax.up]; if(h<mn)mn=h; if(h>mx)mx=h; }
  const c = new THREE.Color();
  for (let i=0;i<n;i++){
    const t = (buffer[i*3+ax.up]-mn)/Math.max(1e-6,(mx-mn));
    c.setHSL(0.33*(1-t), 1, 0.55); // 低=緑 高=赤
    cols[i*3]=c.r; cols[i*3+1]=c.g; cols[i*3+2]=c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols,3));
  g.computeBoundingBox();
  const bb = g.boundingBox;
  S.bounds = { min:[bb.min.x,bb.min.y,bb.min.z], max:[bb.max.x,bb.max.y,bb.max.z] };
  if (pointsObj) { scene.remove(pointsObj); pointsObj.geometry.dispose(); }
  const m = new THREE.PointsMaterial({ size: 0.035, vertexColors: true, transparent: true, opacity: S.opacity, sizeAttenuation: true, depthTest: true });
  pointsObj = new THREE.Points(g, m);
  scene.add(pointsObj);
  buildTopView();
  // 初期位置: 中心
  if (!localStorage.getItem('plyloc')) {
    S.pose.u = (gU(S.bounds.min)+gU(S.bounds.max))/2;
    S.pose.v = (gV(S.bounds.min)+gV(S.bounds.max))/2;
  }
  status(`点群 ${n.toLocaleString()}点 読込OK。カメラ映像と重ねて位置合わせしてください`);
}

// ---------- 上面図生成 ----------
function buildTopView() {
  const ax = axes(), N = 640;
  const u0 = gU(S.bounds.min), u1 = gU(S.bounds.max);
  const v0 = gV(S.bounds.min), v1 = gV(S.bounds.max);
  const h0 = gH(S.bounds.min), h1 = gH(S.bounds.max);
  const sc = Math.min(N/(u1-u0+1e-6), N/(v1-v0+1e-6));
  const W = Math.max(64, Math.ceil((u1-u0)*sc)), H = Math.max(64, Math.ceil((v1-v0)*sc));
  const dens = new Float32Array(W*H), hsum = new Float32Array(W*H);
  const stride = Math.max(1, Math.floor(S.count / 350000));
  for (let i=0;i<S.count;i+=stride){
    const u = S.pts[i*3+ax.u], v = S.pts[i*3+ax.v], h = S.pts[i*3+ax.up];
    const x = Math.floor((u-u0)*sc), y = Math.floor((v-v0)*sc);
    if (x<0||y<0||x>=W||y>=H) continue;
    dens[y*W+x]++; hsum[y*W+x]+=h;
  }
  const cv = document.createElement('canvas'); cv.width=W; cv.height=H;
  const cx = cv.getContext('2d'); const img = cx.createImageData(W,H);
  let dmax = 0; for (let i=0;i<W*H;i++) if (dens[i]>dmax) dmax=dens[i];
  dmax = Math.max(dmax*0.35, 1);
  for (let i=0;i<W*H;i++){
    const d = dens[i]; if (!d) continue;
    const t = Math.min(1, (hsum[i]/d - h0)/Math.max(1e-6,h1-h0));
    const a = Math.min(255, 40 + 215*Math.min(1, d/dmax));
    // 緑→黄→赤
    const r = Math.floor(80+175*t), g = Math.floor(200-110*t), b = 60;
    img.data[i*4]=r; img.data[i*4+1]=g; img.data[i*4+2]=b; img.data[i*4+3]=a;
  }
  cx.putImageData(img,0,0);
  S.top = cv; S.map = { ou:u0, ov:v0, scale:sc, W, H };
  save();
}

function mapToPx(u,v){
  const m=S.map; const pad=30, availW=topmap.width-pad*2, availH=topmap.height-pad*2;
  const s=Math.min(availW/m.W, availH/m.H);
  return { x: pad+(u-m.ou)*m.scale*s, y: pad+(v-m.ov)*m.scale*s, s };
}
function pxToMap(px,py){
  const r=topmap.getBoundingClientRect();
  const x=(px-r.left)/r.width*topmap.width, y=(py-r.top)/r.height*topmap.height;
  // mapToPxの逆算（sを再計算）
  const m=S.map; const pad=30, availW=topmap.width-pad*2, availH=topmap.height-pad*2;
  const s=Math.min(availW/m.W, availH/m.H);
  return { u: m.ou+(x-pad)/(m.scale*s), v: m.ov+(y-pad)/(m.scale*s) };
}

function drawTop() {
  const W=topmap.width, H=topmap.height;
  tctx.fillStyle='#000'; tctx.fillRect(0,0,W,H);
  if (S.top && S.map) {
    const p0=mapToPx(S.map.ou,S.map.ov);
    const dw=S.map.W*S.map.scale*p0.s, dh=S.map.H*S.map.scale*p0.s;
    tctx.imageSmoothingEnabled=false;
    tctx.drawImage(S.top, p0.x, p0.y, dw, dh);
    // 1mグリッド
    tctx.strokeStyle='rgba(255,255,255,.18)'; tctx.lineWidth=1;
    tctx.font='11px sans-serif'; tctx.fillStyle='rgba(255,255,255,.6)';
    const u0=Math.ceil(S.map.ou), u1=Math.floor(S.map.ou+S.map.W/S.map.scale);
    for(let u=u0;u<=u1;u++){ const p=mapToPx(u,S.map.ov); tctx.beginPath(); tctx.moveTo(p.x,p0.y); tctx.lineTo(p.x,p0.y+dh); tctx.stroke(); tctx.fillText(u+'m',p.x+2,p0.y+12); }
    const v0=Math.ceil(S.map.ov), v1=Math.floor(S.map.ov+S.map.H/S.map.scale);
    for(let v=v0;v<=v1;v++){ const p=mapToPx(S.map.ou,v); tctx.beginPath(); tctx.moveTo(p0.x,p.y); tctx.lineTo(p0.x+dw,p.y); tctx.stroke(); }
    // 北
    tctx.fillStyle='#fff'; tctx.font='bold 14px sans-serif'; tctx.fillText('▲北', p0.x+dw-44, p0.y+18);
  } else {
    tctx.fillStyle='#8b949e'; tctx.font='16px sans-serif';
    tctx.fillText('PLY未読込', 30, 40);
  }
  // 軌跡
  if (S.trail.length>1){
    tctx.strokeStyle='rgba(47,129,247,.8)'; tctx.lineWidth=2; tctx.beginPath();
    S.trail.forEach((p,i)=>{ const q=mapToPx(p.u,p.v); i?tctx.lineTo(q.x,q.y):tctx.moveTo(q.x,q.y); });
    tctx.stroke();
  }
  // 自分
  const q=mapToPx(S.pose.u,S.pose.v);
  const yaw=S.pose.yaw*Math.PI/180;
  // 視野コーン
  tctx.fillStyle='rgba(255,0,0,.18)'; tctx.beginPath();
  tctx.moveTo(q.x,q.y);
  const L=90, fov=S.fov*Math.PI/180/2;
  tctx.lineTo(q.x+Math.sin(yaw-fov)*L, q.y-Math.cos(yaw-fov)*L);
  tctx.lineTo(q.x+Math.sin(yaw+fov)*L, q.y-Math.cos(yaw+fov)*L);
  tctx.closePath(); tctx.fill();
  // 矢印
  tctx.save(); tctx.translate(q.x,q.y); tctx.rotate(yaw);
  tctx.fillStyle='#ff3b30'; tctx.beginPath();
  tctx.moveTo(0,-16); tctx.lineTo(11,10); tctx.lineTo(0,4); tctx.lineTo(-11,10); tctx.closePath(); tctx.fill();
  tctx.strokeStyle='#fff'; tctx.lineWidth=2; tctx.stroke();
  tctx.restore();
  tctx.fillStyle='#2f81f7'; tctx.beginPath(); tctx.arc(q.x,q.y,6,0,7); tctx.fill();
  tctx.strokeStyle='#fff'; tctx.lineWidth=2; tctx.stroke();
}

// ---------- 有効yaw / pitch ----------
function effYaw() {
  if (chkCompass.checked && S.heading != null) return S.heading + S.trim;
  return S.pose.yaw;
}
function effPitch() {
  if (chkGyro.checked && S.pitchDev != null) return S.pitchDev;
  return S.pitchMan;
}
function effRoll() { return (chkGyro.checked && S.rollDev != null) ? S.rollDev : 0; }

// ---------- メインループ ----------
function tick() {
  requestAnimationFrame(tick);
  S.pose.yaw = ((effYaw()%360)+360)%360;
  if (pointsObj) {
    const ax = axes();
    const pos = new THREE.Vector3();
    pos.setComponent(ax.u, S.pose.u); pos.setComponent(ax.v, S.pose.v);
    // 目線高さ = bounds最小 + eyeH
    pos.setComponent(ax.up, S.bounds ? gH(S.bounds.min)+S.eyeH : S.eyeH);
    const yawR = S.pose.yaw*Math.PI/180, pitchR = effPitch()*Math.PI/180, rollR = effRoll()*Math.PI/180;
    const cp = Math.cos(pitchR);
    const tgt = pos.clone()
      .addScaledVector(ax.U, Math.sin(yawR)*cp)
      .addScaledVector(ax.V, -Math.cos(yawR)*cp)
      .addScaledVector(ax.UP, Math.sin(pitchR));
    camera.position.copy(pos);
    camera.up.copy(ax.UP);
    camera.lookAt(tgt);
    camera.rotateZ(-rollR); // rollRはrad
    camera.fov = S.fov; camera.updateProjectionMatrix();
    if (S.liveOnly) renderer.render(scene, camera);
  }
  drawTop();
  // HUD
  poseText.textContent = `u=${S.pose.u.toFixed(2)}, v=${S.pose.v.toFixed(2)}`;
  yawText.textContent = `${S.pose.yaw.toFixed(1)}°`;
  hudYaw.textContent = `yaw ${S.pose.yaw.toFixed(0)}° ${chkCompass.checked&&S.heading!=null?'🧭':'✋'}`;
  compassText.textContent = S.heading==null?'—':`${S.heading.toFixed(0)}°`;
}

// ---------- PLY読込 ----------
const loader = new PLYLoader();
async function loadFile(f) {
  status('PLY解析中…');
  const buf = await f.arrayBuffer();
  try {
    const geo = loader.parse(buf);
    const p = geo.getAttribute('position');
    setPoints(new Float32Array(p.array), p.count);
  } catch(e){ console.error(e); status('PLY解析失敗: '+e.message); }
}
function loadDemo() {
  // X=高さ(0..3), Y=-4..4, Z=-3..3 の部屋＋柱 (YZ地面モード用)
  const pts=[];
  const push=(x,y,z)=>pts.push(x,y,z);
  const R=(a,b)=>a+Math.random()*(b-a);
  for(let i=0;i<9000;i++){ push(R(0,0.05),R(-4,4),R(-3,3)); }          // 床(X=0)
  for(let i=0;i<9000;i++){ push(R(2.9,3),R(-4,4),R(-3,3)); }           // 天井
  for(let i=0;i<7000;i++){ push(R(0,3),-4,R(-3,3)); push(R(0,3),4,R(-3,3)); }
  for(let i=0;i<7000;i++){ push(R(0,3),R(-4,4),-3); push(R(0,3),R(-4,4),3); }
  for(let i=0;i<2500;i++){ const y=R(-3.5,3.5); push(R(0,2.6),y+R(-.08,.08),R(-.08,.08)); } // 柱
  for(let i=0;i<1500;i++){ push(R(1,2),R(1,3),R(1,2)); }               // 家具っぽい塊
  setPoints(new Float32Array(pts), pts.length/3);
}
filePly.addEventListener('change', e=>{ if(e.target.files[0]) loadFile(e.target.files[0]); });
btnDemo.addEventListener('click', loadDemo);
selAxis.addEventListener('change', ()=>{
  S.axis = selAxis.value; save();
  if (S.pts) setPoints(S.pts, S.count); // 色と上面図を再計算
  status('地面定義を切替: '+S.axis);
});

// ?ply=URL 対応
(async ()=>{
  const u = new URLSearchParams(location.search).get('ply');
  if (u) { status('URLからPLY取得中…'); try { const r=await fetch(u); const b=await r.arrayBuffer();
    const geo=loader.parse(b); const p=geo.getAttribute('position'); setPoints(new Float32Array(p.array),p.count);
  } catch(e){ status('URL読込失敗: '+e.message); } }
  else loadDemo();
})();

// ---------- カメラ ----------
btnCamera.addEventListener('click', async ()=>{
  try {
    const st = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment' }, audio:false });
    video.srcObject = st; await video.play();
    status('カメラ起動OK。点群と重ねて合わせてください');
  } catch(e){ status('カメラ起動失敗: '+e.message+'（https必須・Safari推奨）'); }
});

// ---------- センサー許可 (iOS対応) ----------
btnSensor.addEventListener('click', async ()=>{
  try {
    if (typeof DeviceOrientationEvent!=='undefined' && DeviceOrientationEvent.requestPermission) {
      await DeviceOrientationEvent.requestPermission();
    }
    if (typeof DeviceMotionEvent!=='undefined' && DeviceMotionEvent.requestPermission) {
      await DeviceMotionEvent.requestPermission().catch(()=>{});
    }
    status('センサー許可OK。iPhoneを立てて周囲を見回してください');
  } catch(e){ status('センサー許可: '+e.message); }
});
window.addEventListener('deviceorientation', (e)=>{
  if (e.webkitCompassHeading!=null && !isNaN(e.webkitCompassHeading)) S.heading = e.webkitCompassHeading;
  else if (e.alpha!=null) S.heading = (360-e.alpha)%360;
  if (e.beta!=null) { S.pitchDev = Math.max(-60,Math.min(60, e.beta-90)); S.rollDev = e.gamma||0;
    rngPitch.value = S.pitchDev; pitchVal.textContent = `${S.pitchDev.toFixed(0)}°`; }
}, true);

// 歩数検出 → 前進
let lastStep=0, lastMag=0;
window.addEventListener('devicemotion', (e)=>{
  if (!chkStep.checked) return;
  const a=e.accelerationIncludingGravity||e.acceleration; if(!a) return;
  const m=Math.hypot(a.x||0,a.y||0,a.z||0);
  const now=performance.now();
  if (lastMag<10.2 && m>=10.2 && now-lastStep>380) { lastStep=now; moveRel(0, S.stepLen); }
  lastMag=m;
});

// ---------- 移動 ----------
function moveRel(side, dist) {
  const y=S.pose.yaw*Math.PI/180;
  const fx=Math.sin(y), fz=-Math.cos(y), rx=Math.cos(y), rz=Math.sin(y);
  // side: 前方向成分, distつき / 左右は別呼び
  S.pose.u += fx*dist + rx*side; S.pose.v += fz*dist + rz*side;
  S.trail.push({u:S.pose.u,v:S.pose.v}); if(S.trail.length>400)S.trail.shift();
  save();
}
function yawBy(d) {
  if (chkCompass.checked && S.heading!=null) S.trim+=d;
  else S.pose.yaw+=d;
  save();
}
document.querySelectorAll('[data-move]').forEach(b=>{
  const go=()=>{
    const k=b.dataset.move;
    if(k==='fwd')moveRel(0,S.grid); if(k==='back')moveRel(0,-S.grid);
    if(k==='right')moveRel(S.grid,0); if(k==='left')moveRel(-S.grid,0);
  };
  b.addEventListener('click',go);
  let t=null;
  b.addEventListener('pointerdown',()=>{ t=setInterval(go,90); });
  ['pointerup','pointerleave','pointercancel'].forEach(ev=>b.addEventListener(ev,()=>clearInterval(t)));
});
document.querySelectorAll('[data-yaw]').forEach(b=>{
  const go=()=>{
    const k=b.dataset.yaw;
    if(k==='left')yawBy(-5); if(k==='right')yawBy(5);
    if(k==='fine-left')yawBy(-1); if(k==='fine-right')yawBy(1);
  };
  b.addEventListener('click',go);
  let t=null;
  b.addEventListener('pointerdown',()=>{ t=setInterval(go,110); });
  ['pointerup','pointerleave','pointercancel'].forEach(ev=>b.addEventListener(ev,()=>clearInterval(t)));
});
$('btnResetPose').addEventListener('click', ()=>{
  if(!S.bounds) return;
  S.pose.u=(gU(S.bounds.min)+gU(S.bounds.max))/2; S.pose.v=(gV(S.bounds.min)+gV(S.bounds.max))/2;
  S.trail=[]; save();
});
btnNorth.addEventListener('click', ()=>{
  if (S.heading==null){ status('コンパス値がまだありません（センサー許可＋屋外で取得）'); return; }
  S.trim = 0; // raw compass = yaw。0°=北=地図上
  status(`北合わせ: コンパス${S.heading.toFixed(0)}°を地図上に一致させました`);
});

// 上面図タップで位置指定
topmap.addEventListener('pointerdown', (e)=>{
  if(!S.map) return;
  const p=pxToMap(e.clientX,e.clientY);
  S.pose.u=p.u; S.pose.v=p.v;
  S.trail.push({u:p.u,v:p.v}); save();
});

// ---------- 設定UI ----------
function status(s){ statusLine.textContent=s; }
rngHeight.addEventListener('input',()=>{ S.eyeH=+rngHeight.value; heightVal.textContent=`${S.eyeH.toFixed(2)}m`; save(); });
rngFov.addEventListener('input',()=>{ S.fov=+rngFov.value; fovVal.textContent=`${S.fov}°`; save(); });
rngPitch.addEventListener('input',()=>{ S.pitchMan=+rngPitch.value; pitchVal.textContent=`${S.pitchMan}°`; });
rngOpacity.addEventListener('input',()=>{ S.opacity=+rngOpacity.value; if(pointsObj)pointsObj.material.opacity=S.opacity; });
rngStep.addEventListener('input',()=>{ S.stepLen=+rngStep.value; stepVal.textContent=`${S.stepLen.toFixed(2)}m`; });
rngGrid.addEventListener('input',()=>{ S.grid=+rngGrid.value; stepGridVal.textContent=`${S.grid.toFixed(2)}m`; });
btnExportMap.addEventListener('click',()=>{
  const a=document.createElement('a'); a.download='topmap.png'; a.href=topmap.toDataURL('image/png'); a.click();
});
$('btnHelp').addEventListener('click',()=>$('helpModal').classList.remove('hidden'));
$('btnCloseHelp').addEventListener('click',()=>$('helpModal').classList.add('hidden'));
$('tabLive').addEventListener('click',()=>{ S.liveOnly=true; $('liveWrap').style.display=''; $('tabLive').classList.add('active'); $('tabMap').classList.remove('active'); resizeLive(); });
$('tabMap').addEventListener('click',()=>{ S.liveOnly=false; $('liveWrap').style.display='none'; $('tabMap').classList.add('active'); $('tabLive').classList.remove('active'); });

heightVal.textContent=`${S.eyeH.toFixed(2)}m`; fovVal.textContent=`${S.fov}°`;
tick();
