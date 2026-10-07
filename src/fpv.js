/* =========================================================
   THE WAR — FPV DRONE MODULE (src/fpv.js)
   Adds FPV DRONE MODE to THE WAR's menu. Self-contained:
   own engine, own world, own OSD/HUD, own audio. Reuses the
   main game's saved settings (potato presets, stick tuning).
   ========================================================= */
(async function(){
'use strict';
const $=s=>document.querySelector(s);
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const D2R=Math.PI/180;
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

/* ---------- three.js loader (same mirror chain as main) ---------- */
let THREE=null;
for(const u of ['./three.module.js',
  'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js',
  'https://unpkg.com/three@0.160.1/build/three.module.js',
  'https://esm.sh/three@0.160.1',
  'https://cdn.skypack.dev/three@0.160.1']){
  try{
    const m=await Promise.race([import(u),new Promise((_,rj)=>setTimeout(()=>rj(new Error('t')),9000))]);
    if(m&&m.Scene&&m.Vector3){THREE=m;break}
  }catch(e){console.warn('[FPV] mirror failed:',u)}
}

/* ---------- settings (shares potato/quality settings with main game) ---------- */
let TW={};try{TW=JSON.parse(localStorage.getItem('thewar2')||'{}')}catch(e){}
const P={mode:'angle',rates:'mid',tilt:25,invertYaw:false};
try{Object.assign(P,JSON.parse(localStorage.getItem('thewar-fpv')||'{}'))}catch(e){}
const saveP=()=>{try{localStorage.setItem('thewar-fpv',JSON.stringify(P))}catch(e){}};
const RATES={low:{p:160,r:160,y:120},mid:{p:260,r:260,y:180},high:{p:420,r:420,y:260}};
const MAXANG=.56;
function mapAxis(v){
  const dz=(TW.deadzone??12)/100,rg=(TW.stickRange??100)/100,a=Math.abs(v);
  if(a<=dz)return 0;
  let e=clamp((a-dz)/(rg-dz),0,1);e=Math.pow(e,(TW.response??150)/100);
  return Math.sign(v)*e;
}

/* ---------- audio (synthesized) ---------- */
let AC=null,MG=null,osc1,osc2,mGain,noiseBuf,windGain;
function ensureAudio(){
  if(AC)return;
  try{
    AC=new (window.AudioContext||window.webkitAudioContext)();
    MG=AC.createGain();MG.gain.value=.8;MG.connect(AC.destination);
    noiseBuf=AC.createBuffer(1,AC.sampleRate,AC.sampleRate);
    const d=noiseBuf.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;
    osc1=AC.createOscillator();osc1.type='sawtooth';
    osc2=AC.createOscillator();osc2.type='sawtooth';osc2.detune.value=9;
    mGain=AC.createGain();mGain.gain.value=0;
    osc1.connect(mGain);osc2.connect(mGain);mGain.connect(MG);osc1.start();osc2.start();
    const ws=AC.createBufferSource();ws.buffer=noiseBuf;ws.loop=true;
    const wf=AC.createBiquadFilter();wf.type='lowpass';wf.frequency.value=500;
    windGain=AC.createGain();windGain.gain.value=0;
    ws.connect(wf);wf.connect(windGain);windGain.connect(MG);ws.start();
  }catch(e){AC=null}
}
function boomSnd(){if(!AC)return;const s=AC.createBufferSource();s.buffer=noiseBuf;
  const f=AC.createBiquadFilter();f.type='lowpass';f.frequency.value=300;
  const g=AC.createGain();g.gain.setValueAtTime(.7,AC.currentTime);
  g.gain.exponentialRampToValueAtTime(.001,AC.currentTime+.9);
  s.connect(f);f.connect(g);g.connect(MG);s.start();s.stop(AC.currentTime+1)}
function whistleSnd(){if(!AC)return;const o=AC.createOscillator(),g=AC.createGain();
  o.type='sine';o.frequency.setValueAtTime(1300,AC.currentTime);
  o.frequency.exponentialRampToValueAtTime(320,AC.currentTime+.8);
  g.gain.setValueAtTime(.1,AC.currentTime);g.gain.exponentialRampToValueAtTime(.001,AC.currentTime+.8);
  o.connect(g);g.connect(MG);o.start();o.stop(AC.currentTime+.85)}
function beep(f){if(!AC)return;const o=AC.createOscillator(),g=AC.createGain();
  o.type='square';o.frequency.value=f;g.gain.setValueAtTime(.07,AC.currentTime);
  g.gain.exponentialRampToValueAtTime(.001,AC.currentTime+.09);
  o.connect(g);g.connect(MG);o.start();o.stop(AC.currentTime+.1)}

/* ---------- state ---------- */
let running=false,paused=false,ended=false,dead=false,arm=false;
let thr=0,thrT=0,yaw=0,time=0,batt=100,battDead=false;
let kills=0,bombsDropped=0,topSpd=0,shake=0,dropCd=0,wantDrop=false,groundedT=0;
let raf=0,rafRunning=false,last=0,glPrev='',seed=1;
let renderer=null,scene,camera,droneG,sun,worldGroup=null;
let solids=[],targets=[],bombs=[],fx=[],props=[];
let rawYaw=0,rawPitch=0,rawRoll=0,padOn=false,padPrev=[];
const ctl={p:0,r:0,y:0},keys={};
const osdMsgs=[];
const V=(x,y,z)=>new THREE.Vector3(x,y,z);
let q,tq,dq,tmpV,tmpV2,tmpE,tmpQ,UP,out;
let boxGeo,cylGeo,sphGeo,planeGeo,softTex;
let matDark,matWreck,matHull,matBand,matTrunk,matLeaf,matWall,matRoof,matWheel;
let GROUND_TEX=null;
const pos=V(0,1,500),vel=V(0,0,0);

function osdMsg(t){osdMsgs.unshift({t,life:3.5});if(osdMsgs.length>4)osdMsgs.pop()}

/* ---------- engine ---------- */
function ensureEngine(){
  if(renderer)return;
  renderer=new THREE.WebGLRenderer({canvas:$('#fpvgl'),antialias:true});
  renderer.setPixelRatio(clamp(((TW.renderScale??.85)*Math.min(devicePixelRatio,2)),.35,2));
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
  scene=new THREE.Scene();
  scene.background=new THREE.Color(0x7a5a34);
  scene.fog=new THREE.Fog(0x8a6a3d,80,520);
  camera=new THREE.PerspectiveCamera(95,1,.05,900);camera.rotation.order='YXZ';
  sun=new THREE.DirectionalLight(0xffb868,1.1);
  sun.position.set(-120,160,-80);sun.castShadow=true;
  sun.shadow.mapSize.set(1024,1024);
  const sc=sun.shadow.camera;sc.left=-70;sc.right=70;sc.top=70;sc.bottom=-70;sc.far=500;
  sun.shadow.bias=-.0004;
  scene.add(sun);scene.add(sun.target);
  scene.add(new THREE.HemisphereLight(0x6a6472,0x2a2620,.6));
  q=new THREE.Quaternion();tq=new THREE.Quaternion();dq=new THREE.Quaternion();
  tmpV=V();tmpV2=V();tmpE=new THREE.Euler();tmpQ=new THREE.Quaternion();
  UP=V(0,1,0);out={x:0,y:0};
  boxGeo=new THREE.BoxGeometry(1,1,1);cylGeo=new THREE.CylinderGeometry(.5,.5,1,8);
  sphGeo=new THREE.SphereGeometry(1,10,8);planeGeo=new THREE.PlaneGeometry(1,1);
  const lam=c=>new THREE.MeshLambertMaterial({color:c});
  matDark=lam(0x1c1c1a);matWreck=lam(0x1f1e1a);matHull=lam(0x4a4f52);
  matBand=lam(0x9c3b2c);matTrunk=lam(0xcfc7b2);matLeaf=lam(0x3a4226);
  matWall=lam(0x4a4438);matRoof=lam(0x33302a);matWheel=lam(0x1a1a18);
  softTex=(()=>{const c=document.createElement('canvas');c.width=c.height=64;
    const x=c.getContext('2d');const g=x.createRadialGradient(32,32,2,32,32,30);
    g.addColorStop(0,'rgba(255,255,255,1)');g.addColorStop(1,'rgba(255,255,255,0)');
    x.fillStyle=g;x.fillRect(0,0,64,64);return new THREE.CanvasTexture(c)})();
  buildDrone();
  scene.add(droneG);
}
function buildDrone(){
  droneG=new THREE.Group();
  const bx=(mat,sx,sy,sz,x,y,z)=>{const m=new THREE.Mesh(boxGeo,mat);
    m.scale.set(sx,sy,sz);m.position.set(x,y,z);m.castShadow=true;droneG.add(m);return m};
  bx(matDark,.10,.035,.16,0,.01,0);
  const a1=bx(matDark,.46,.022,.03,0,.015,0);a1.rotation.y=Math.PI/4;
  const a2=bx(matDark,.46,.022,.03,0,.015,0);a2.rotation.y=-Math.PI/4;
  props=[];
  [[.17,.17],[-.17,.17],[.17,-.17],[-.17,-.17]].forEach(([px,pz],i)=>{
    const mo=new THREE.Mesh(cylGeo,matDark);mo.scale.set(.056,.05,.056);
    mo.position.set(px,.03,pz);droneG.add(mo);
    const pr=new THREE.Mesh(cylGeo,new THREE.MeshBasicMaterial({color:0x8a8a86,transparent:true,opacity:.4,depthWrite:false}));
    pr.scale.set(.14,.008,.14);pr.position.set(px,.065,pz);
    pr.userData.d=i%2?1:-1;droneG.add(pr);props.push(pr);
  });
  bx(matDark,.05,.05,.06,0,.02,.10);
  camera.position.set(0,.04,.12);
  camera.rotation.x=P.tilt*D2R;
  droneG.add(camera);
}
function groundTexture(){
  const c=document.createElement('canvas');c.width=c.height=256;
  const x=c.getContext('2d');
  x.fillStyle='#42452c';x.fillRect(0,0,256,256);
  const pal=['#3a3d24','#4b4e31','#37341f','#514a30','#2f3220'];
  for(let i=0;i<3200;i++){x.fillStyle=pal[Math.random()*pal.length|0];
    x.globalAlpha=.14+Math.random()*.3;
    x.fillRect(Math.random()*256,Math.random()*256,1+Math.random()*2.6,1+Math.random()*2.6)}
  x.globalAlpha=1;
  const t=new THREE.CanvasTexture(c);
  t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(60,60);
  return t;
}
function makeVehicle(rng,type){
  const g=new THREE.Group();
  const bx=(mat,sx,sy,sz,x,y,z)=>{const m=new THREE.Mesh(boxGeo,mat);
    m.scale.set(sx,sy,sz);m.position.set(x,y,z);m.castShadow=true;g.add(m);return m};
  if(type==='tank'){
    bx(matHull,2.6,.9,4.6,0,.85,0);
    bx(matWheel,.7,.7,4.8,-1.35,.45,0);bx(matWheel,.7,.7,4.8,1.35,.45,0);
    bx(matHull,1.7,.65,2.2,0,1.6,-.4);
    const bar=new THREE.Mesh(cylGeo,matWheel);bar.scale.set(.18,2.8,.18);
    bar.rotation.x=Math.PI/2;bar.position.set(0,1.7,-1.9);g.add(bar);
    bx(matBand,1.3,.14,1.3,0,2.05,0);
  }else{
    bx(matHull,2,1,4.4,0,1.0,0);
    bx(matWheel,1.8,.9,1.6,0,1.8,-.7);
    for(const [wx,wz] of [[-1.05,1.5],[1.05,1.5],[-1.05,-1.5],[1.05,-1.5]]){
      const w=new THREE.Mesh(cylGeo,matWheel);w.scale.set(.65,.3,.65);
      w.rotation.z=Math.PI/2;w.position.set(wx,.35,wz);g.add(w);
    }
    bx(matBand,1.3,.14,1.3,0,2.4,0);
  }
  return g;
}
function buildWorld(sd){
  if(worldGroup)scene.remove(worldGroup);
  for(const f of fx)scene.remove(f.m);fx=[];
  for(const b of bombs)scene.remove(b.m);bombs=[];
  worldGroup=new THREE.Group();scene.add(worldGroup);
  solids=[];targets=[];
  const rng=mulberry32(sd);
  if(!GROUND_TEX)GROUND_TEX=groundTexture();
  const ground=new THREE.Mesh(new THREE.PlaneGeometry(1400,1400),
    new THREE.MeshLambertMaterial({map:GROUND_TEX}));
  ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;worldGroup.add(ground);
  const dens=clamp((TW.viewDist??280)/300,.5,1.2);
  for(let i=0;i<Math.round(30*dens);i++){
    const x=(rng()*2-1)*540,z=(rng()*2-1)*380;
    const w=7+rng()*8,h=6+rng()*10,d=7+rng()*8;
    const b=new THREE.Mesh(boxGeo,rng()<.5?matWall:matRoof);
    b.scale.set(w,h,d);b.position.set(x,h/2,z);b.castShadow=true;worldGroup.add(b);
    solids.push({minx:x-w/2,maxx:x+w/2,miny:0,maxy:h,minz:z-d/2,maxz:z+d/2});
  }
  for(let c=0;c<10;c++){
    const R=130+rng()*290,a=rng()*Math.PI*2;
    const cx=Math.sin(a)*R,cz=Math.cos(a)*R;
    for(let k=0;k<5;k++){
      const px=cx+(rng()-.5)*18,pz=cz+(rng()-.5)*18;
      const g=makeVehicle(rng,rng()<.4?'tank':'tech');
      g.position.set(px,0,pz);g.rotation.y=rng()*6.28;
      worldGroup.add(g);
      targets.push({g,pos:V(px,0,pz),dead:false});
      solids.push({minx:px-1.9,maxx:px+1.9,miny:0,maxy:2.6,minz:pz-2.6,maxz:pz+2.6});
    }
  }
  for(let i=0;i<Math.round(40*dens);i++){
    const x=(rng()*2-1)*540,z=(rng()*2-1)*480,h=4+rng()*4;
    const tr=new THREE.Mesh(cylGeo,matTrunk);tr.scale.set(.3,h,.3);
    tr.position.set(x,h/2,z);worldGroup.add(tr);
    const l=new THREE.Mesh(new THREE.IcosahedronGeometry(1,0),matLeaf);
    l.material.flatShading=true;l.scale.setScalar(1.4+rng());
    l.position.set(x,h,z);worldGroup.add(l);
  }
}

/* ---------- bombs / explosions ---------- */
function dropBomb(){
  const m=new THREE.Mesh(cylGeo,matDark);m.scale.set(.09,.32,.09);
  scene.add(m);
  const p=pos.clone();p.y-=.18;
  bombs.push({m,pos:p,vel:vel.clone(),age:0});
  bombsDropped++;whistleSnd();
}
function updateBombs(dt){
  for(let i=bombs.length-1;i>=0;i--){
    const b=bombs[i];
    b.age+=dt;b.vel.y-=9.81*dt;b.pos.addScaledVector(b.vel,dt);
    b.m.position.copy(b.pos);
    tmpV.copy(b.vel).normalize();
    b.m.quaternion.setFromUnitVectors(UP,tmpV);
    let hit=b.pos.y<=.12||b.age>9;
    if(!hit)for(const s of solids)
      if(b.pos.x>s.minx&&b.pos.x<s.maxx&&b.pos.y>s.miny&&b.pos.y<s.maxy&&b.pos.z>s.minz&&b.pos.z<s.maxz){hit=true;break}
    if(!hit)for(const t of targets)
      if(!t.dead&&t.pos.distanceTo(b.pos)<1.6){hit=true;break}
    if(hit){scene.remove(b.m);bombs.splice(i,1);explode(b.pos.clone(),8.5,true)}
  }
}
function explode(p,r,kill){
  boomSnd();
  shake=Math.min(1,shake+.25+clamp(1-p.distanceTo(pos)/25,0,1));
  const fl=new THREE.Mesh(sphGeo,new THREE.MeshBasicMaterial({color:0xffca7a,transparent:true,opacity:.95,fog:false}));
  fl.position.copy(p);fl.position.y+=.8;scene.add(fl);
  fx.push({m:fl,t:.25,sz:r/6,type:'flash'});
  for(let i=0;i<10;i++){
    const m=new THREE.Mesh(boxGeo,matWreck);
    m.scale.set(.3+Math.random()*.4,.25,.3);
    m.position.set(p.x,p.y+.6,p.z);scene.add(m);
    fx.push({m,t:1+Math.random()*.5,type:'debris',
      v:V((Math.random()-.5)*10,5+Math.random()*7,(Math.random()-.5)*10)});
  }
  for(let i=0;i<3;i++){
    const m=new THREE.Mesh(planeGeo,new THREE.MeshBasicMaterial({map:softTex,color:0x2a2620,transparent:true,opacity:.5,depthWrite:false}));
    m.position.copy(p);m.position.y+=1+i;scene.add(m);
    fx.push({m,t:1.2,sz:2.5+i,type:'smoke'});
  }
  if(kill)for(const t of targets)
    if(!t.dead&&t.pos.distanceTo(p)<r)destroyTarget(t);
  const d=p.distanceTo(pos);
  if(d<16&&d>.01){
    tmpV.copy(pos).sub(p).normalize();
    vel.addScaledVector(tmpV,(16-d)*.9);
    if(d<5.5)crash('CAUGHT IN OWN BLAST');
  }
}
function destroyTarget(t){
  t.dead=true;kills++;
  t.g.traverse(o=>{if(o.isMesh)o.material=matWreck});
  t.g.rotation.z=(Math.random()-.5)*.5;t.g.rotation.x=(Math.random()-.5)*.25;
  osdMsg('TARGET DESTROYED — '+kills+'/50');beep(1600);
  if(kills>=50&&!ended){
    ended=true;
    showEnd(true,'ALL TARGETS ELIMINATED','50 / 50 destroyed from the air.');
  }
}
function crash(reason){
  if(dead||ended)return;
  dead=true;arm=false;
  explode(pos.clone(),0,false);
  ended=true;
  setTimeout(()=>showEnd(false,'DRONE DOWN',reason),900);
}
function updateFX(dt){
  camera.getWorldQuaternion(tmpQ);
  for(let i=fx.length-1;i>=0;i--){
    const f=fx[i];f.t-=dt;
    if(f.type==='flash'){const k=1-f.t/.25;
      f.m.scale.setScalar(f.sz*(.5+k*4));f.m.material.opacity=.95*(1-k)}
    else if(f.type==='debris'){f.v.y-=12*dt;
      f.m.position.addScaledVector(f.v,dt);f.m.rotation.x+=dt*7;
      if(f.m.position.y<0)f.t=0}
    else{const k=1-f.t/1.2;
      f.m.scale.setScalar(f.sz*(.6+k*2));f.m.material.opacity=.5*(1-k);
      f.m.position.y+=dt*2;f.m.quaternion.copy(tmpQ)}
    if(f.t<=0){scene.remove(f.m);fx.splice(i,1)}
  }
}

/* ---------- input ---------- */
function pollPad(){
  rawYaw=rawPitch=rawRoll=0;padOn=false;
  const pads=navigator.getGamepads?navigator.getGamepads():[];
  let gp=null;for(const p of pads)if(p&&p.axes&&p.axes.length>=4){gp=p;break}
  if(!gp)return;
  padOn=true;
  rawYaw=mapAxis(gp.axes[0]||0);
  rawPitch=mapAxis(-(gp.axes[3]||0));
  rawRoll=mapAxis(gp.axes[2]||0);
  const cur=gp.buttons.map(b=>b.pressed||b.value>.4);
  const edge=i=>cur[i]&&!padPrev[i];
  if(edge(0))wantDrop=true;
  if(edge(3)){arm=!arm;beep(arm?1200:600)}
  if(edge(9))togglePause();
  padPrev=cur;
}
addEventListener('keydown',e=>{
  if(!running)return;
  keys[e.code]=true;
  if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();
  if(e.code==='Space')wantDrop=true;
  if(e.code==='Enter'){arm=!arm;beep(arm?1200:600)}
  if(e.code==='Escape')togglePause();
});
addEventListener('keyup',e=>{keys[e.code]=false});

/* ---------- flight ---------- */
function step(dt){
  pollPad();
  if(!padOn){
    rawYaw=(keys.KeyA?-1:0)+(keys.KeyD?1:0);
    rawPitch=(keys.ArrowUp?1:0)+(keys.ArrowDown?-1:0);
    rawRoll=(keys.ArrowRight?1:0)+(keys.ArrowLeft?-1:0);
  }
  ctl.p+=(rawPitch-ctl.p)*clamp(dt*10,0,1);
  ctl.r+=(rawRoll-ctl.r)*clamp(dt*10,0,1);
  ctl.y+=(rawYaw-ctl.y)*clamp(dt*10,0,1);
  if(padOn)thr=clamp((-( arguments.length?0:0)+0)+0,0,1),thr=clamp(thr,0,1); /* replaced below */
  if(padOn){
    const pads=navigator.getGamepads?navigator.getGamepads():[];
    let gp=null;for(const p of pads)if(p&&p.axes&&p.axes.length>=4){gp=p;break}
    if(gp)thr=clamp((-(gp.axes[1]||0)+1)/2,0,1);
  }else{
    if(keys.KeyW)thrT=clamp(thrT+dt*.7,0,1);
    if(keys.KeyS)thrT=clamp(thrT-dt*.7,0,1);
    thr+=(thrT-thr)*clamp(dt*6,0,1);
  }
  if(batt<=0)thr=0;
  const iy=P.invertYaw?-1:1;
  if(P.mode==='acro'){
    const R=RATES[P.rates];
    const wx=-ctl.p*R.p*D2R,wy=-iy*ctl.y*R.y*D2R,wz=-ctl.r*R.r*D2R;
    const h=dt*.5;
    dq.set(wx*h,wy*h,wz*h,1).normalize();
    q.multiply(dq);
  }else{
    const R=RATES[P.rates];
    yaw-=iy*ctl.y*R.y*D2R*dt;
    tmpE.set(-ctl.p*MAXANG,yaw,-ctl.r*MAXANG,'YXZ');
    tq.setFromEuler(tmpE);
    q.slerp(tq,clamp(dt*7,0,1));
  }
  droneG.quaternion.copy(q);
  const T=arm?thr*16.5:0;
  tmpV.set(0,1,0).applyQuaternion(q);
  vel.addScaledVector(tmpV,T*dt);
  vel.y-=9.81*dt;
  vel.multiplyScalar(Math.max(0,1-.085*dt));
  pos.addScaledVector(vel,dt);
  pos.x=clamp(pos.x,-580,580);pos.z=clamp(pos.z,-580,580);
  if(pos.y<.10){
    if(vel.y<-3.2)return crash('SLAMMED INTO THE GROUND');
    pos.y=.10;if(vel.y<0)vel.y=0;
    vel.x*=Math.max(0,1-6*dt);vel.z*=Math.max(0,1-6*dt);
  }
  for(const b of solids)
    if(pos.x>b.minx-.22&&pos.x<b.maxx+.22&&pos.y<b.maxy+.22&&pos.y>b.miny-.22&&pos.z>b.minz-.22&&pos.z<b.maxz+.22)
      return crash('COLLIDED WITH STRUCTURE');
  batt=Math.max(0,batt-(0.5+thr*1.05)*dt*(100/170));
  if(batt<=0&&!battDead){battDead=true;arm=false;osdMsg('BATTERY DEAD — GLIDE DOWN')}
  if(battDead&&pos.y<=.11&&vel.length()<.5){
    groundedT+=dt;
    if(groundedT>1.5&&!ended){ended=true;showEnd(false,'BATTERY DEPLETED','The pack ran dry behind enemy lines.')}
  }else groundedT=0;
  topSpd=Math.max(topSpd,vel.length()*3.6);
  time+=dt;
  droneG.position.copy(pos);
  for(const pr of props)pr.rotation.y+=(6+thr*55)*dt*pr.userData.d;
  camera.position.set((Math.random()-.5)*shake*.06,.04+(Math.random()-.5)*shake*.06,.12);
  camera.rotation.set(P.tilt*D2R,0,(Math.random()-.5)*shake*.05);
  shake=Math.max(0,shake-dt*1.1);
  if(AC){
    const f=75+thr*250+vel.length()*1.5;
    mGain.gain.value=arm?(.012+thr*.06):.006;
    osc1.frequency.value=f;osc2.frequency.value=f*1.01+3;
    windGain.gain.value=clamp(vel.length()/38,0,.16);
  }
  dropCd=Math.max(0,dropCd-dt);
  if(wantDrop){wantDrop=false;if(arm&&dropCd<=0){dropCd=.6;dropBomb()}}
  updateBombs(dt);
}

/* ---------- OSD ---------- */
function toScreen(p){
  tmpV.copy(p).project(camera);
  if(tmpV.z>1||Math.abs(tmpV.x)>1.1||Math.abs(tmpV.y)>1.1)return false;
  out.x=(tmpV.x*.5+.5)*osdW;out.y=(-tmpV.y*.5+.5)*osdH;
  return true;
}
let osdW=0,osdH=0;
function drawOSD(dt){
  camera.updateMatrixWorld();
  const osd=$('#fpvosd'),o=osd.getContext('2d');
  osdW=osd.width;osdH=osd.height;
  if(!osdW||!osdH)return;
  o.clearRect(0,0,osdW,osdH);
  const fs=Math.max(12,Math.round(osdH/46));
  const white='rgba(240,255,240,.95)',amber='#d9a52b',red='#e04a38';
  o.font=fs+'px "Share Tech Mono",monospace';
  o.textBaseline='middle';
  o.shadowColor='rgba(0,0,0,.85)';o.shadowOffsetX=1;o.shadowOffsetY=1;
  const e=tmpE.setFromQuaternion(camera.getWorldQuaternion(tmpQ),'YXZ');
  const heading=((-e.y/D2R)%360+360)%360;
  const cx=osdW/2;
  o.fillStyle=white;
  o.textAlign='left';o.fillText('THE WAR // FPV',14,fs);
  o.textAlign='right';
  const volts=(16.8-(100-batt)/100*2.8-thr*.35).toFixed(1);
  o.fillText(volts+'V  '+Math.ceil(batt)+'%',osdW-14,fs);
  /* compass tape */
  const pxPerDeg=osdW*.8/90,tapeY=fs*1.9;
  for(let a=Math.floor((heading-45)/5)*5;a<=heading+45;a+=5){
    const x=cx+(a-heading)*pxPerDeg,na=((a%360)+360)%360;
    if(na%90===0){
      o.fillStyle=white;o.textAlign='center';
      o.fillText({0:'N',90:'E',180:'S',270:'W'}[na],x,tapeY-fs*.8);
      o.fillRect(x-1,tapeY,2,fs*.7);
    }else{o.fillStyle='rgba(240,255,240,.4)';o.fillRect(x-.5,tapeY,1,fs*.4)}
  }
  o.fillStyle=white;o.textAlign='center';
  o.fillRect(cx-1,tapeY-fs*.3,2,fs);
  o.fillText(String(Math.round(heading)).padStart(3,'0'),cx,tapeY+fs*1.4);
  /* nearest target marker on tape */
  let nt=null,nd=1e9;
  for(const t of targets)if(!t.dead){const d=t.pos.distanceTo(pos);if(d<nd){nd=d;nt=t}}
  if(nt){
    const brg=(Math.atan2(nt.pos.x-pos.x,-(nt.pos.z-pos.z))*180/Math.PI+360)%360;
    let dd=brg-heading;while(dd>180)dd-=360;while(dd<-180)dd+=360;
    const x=cx+clamp(dd,-44,44)*pxPerDeg;
    o.fillStyle=amber;
    o.beginPath();o.moveTo(x,tapeY-fs*.2);o.lineTo(x+5,tapeY+fs*.5);
    o.lineTo(x,tapeY+fs*1.1);o.lineTo(x-5,tapeY+fs*.5);o.closePath();o.fill();
    if(Math.abs(dd)>44){o.fillStyle=amber;o.textAlign='left';
      o.fillText(dd>0?'▶':'◀',dd>0?osdW-20:6,tapeY+fs*1.5)}
  }
  /* horizon + pitch ladder */
  const pxPerRad=osdH/(camera.fov*D2R);
  o.save();
  o.translate(cx,osdH/2+e.x*pxPerRad);o.rotate(e.z);
  o.strokeStyle=white;o.lineWidth=1.5;
  o.beginPath();o.moveTo(-osdW*.7,0);o.lineTo(osdW*.7,0);o.stroke();
  o.lineWidth=1;
  for(const k of [-60,-45,-30,-15,15,30,45,60]){
    const y=(k*D2R-e.x)*pxPerRad;
    if(Math.abs(y)>osdH*.45)continue;
    const w=k%30===0?fs*2.4:fs*1.4;
    o.beginPath();o.moveTo(-w,y);o.lineTo(w,y);o.stroke();
    o.fillStyle='rgba(240,255,240,.7)';o.textAlign='left';
    o.fillText(String(-k),w+3,y);
  }
  o.restore();
  /* center cross */
  o.strokeStyle=white;o.lineWidth=1.5;
  o.beginPath();o.moveTo(cx-fs*.7,osdH/2);o.lineTo(cx-fs*.25,osdH/2);
  o.moveTo(cx+fs*.25,osdH/2);o.lineTo(cx+fs*.7,osdH/2);
  o.moveTo(cx,osdH/2-fs*.7);o.lineTo(cx,osdH/2-fs*.25);
  o.moveTo(cx,osdH/2+fs*.25);o.lineTo(cx,osdH/2+fs*.7);o.stroke();
  /* left: throttle + alt */
  o.fillStyle=white;o.textAlign='left';
  o.fillText('THR',14,osdH*.2);
  o.strokeStyle='rgba(240,255,240,.5)';
  o.strokeRect(14,osdH*.2+fs*.6,fs*.55,osdH*.34);
  o.fillRect(14,osdH*.2+fs*.6+osdH*.34*(1-thr),fs*.55,osdH*.34*thr);
  o.fillText('ALT '+pos.y.toFixed(1)+'M',14,osdH*.68);
  o.fillText((vel.y>=0?'+':'')+vel.y.toFixed(1)+'M/S',14,osdH*.68+fs*1.3);
  /* right: speed */
  o.textAlign='right';
  o.fillText('SPD '+(vel.length()*3.6).toFixed(0)+'KMH',osdW-14,osdH*.25);
  o.fillText('TGT '+kills+'/50',osdW-14,osdH*.25+fs*1.3);
  /* status bottom */
  o.textAlign='center';
  const by=osdH-fs*2.2;
  if(battDead){o.fillStyle=red;o.fillText('** BATTERY DEAD **',cx,by)}
  else if(batt<25&&Math.floor(time*2)%2===0){o.fillStyle=red;o.fillText('LOW BATTERY',cx,by)}
  if(!arm&&!dead){o.fillStyle=white;
    if(Math.floor(time*2)%2===0)o.fillText('DISARMED — ENTER / START TO ARM',cx,by+fs*1.4)}
  o.fillStyle=white;
  o.fillText(dropCd>0?'BOMB RELOADING':'BOMB READY — SPACE / A',cx,osdH-fs*.9);
  /* messages */
  o.textAlign='left';
  for(let i=osdMsgs.length-1;i>=0;i--){
    const m=osdMsgs[i];m.life-=dt;
    if(m.life<=0){osdMsgs.splice(i,1);continue}
    o.fillStyle=`rgba(217,165,43,${clamp(m.life,0,1)})`;
    o.fillText(m.t,14,fs*(2.6+(osdMsgs.length-1-i)*1.4));
  }
  /* target diamonds + impact predictor */
  o.strokeStyle=amber;o.fillStyle=amber;
  for(const t of targets){
    if(t.dead)continue;
    const d=t.pos.distanceTo(pos);
    if(d>500)continue;
    tmpV2.set(t.pos.x,1.6,t.pos.z);
    if(toScreen(tmpV2)){
      const s=clamp(700/d,5,22);
      o.beginPath();
      o.moveTo(out.x,out.y-s);o.lineTo(out.x+s,out.y);
      o.lineTo(out.x,out.y+s);o.lineTo(out.x-s,out.y);
      o.closePath();o.stroke();
      o.textAlign='center';
      o.fillText(Math.round(d)+'M',out.x,out.y+s+fs*.8);
    }
  }
  if(arm&&!dead&&!ended){
    const t=(vel.y+Math.sqrt(vel.y*vel.y+2*9.81*pos.y))/9.81;
    tmpV2.set(pos.x+vel.x*t,0,pos.z+vel.z*t);
    if(toScreen(tmpV2)){
      o.strokeStyle=amber;o.lineWidth=1.5;
      o.beginPath();o.arc(out.x,out.y,10,0,7);o.stroke();
      o.beginPath();
      o.moveTo(out.x-14,out.y);o.lineTo(out.x-6,out.y);
      o.moveTo(out.x+6,out.y);o.lineTo(out.x+14,out.y);
      o.moveTo(out.x,out.y-14);o.lineTo(out.x,out.y-6);
      o.moveTo(out.x,out.y+6);o.lineTo(out.x,out.y+14);o.stroke();
    }
  }
}

/* ---------- UI ---------- */
function buildUI(){
  if($('#fpvwrap'))return;
  const st=document.createElement('style');
  st.textContent=`
  #fpvwrap{position:fixed;inset:0;z-index:40;display:none;background:#14150f}
  #fpvwrap.on{display:block}
  #fpvgl,#fpvosd{position:absolute;inset:0;width:100%;height:100%}
  #fpvosd{pointer-events:none}
  .fpv-ov{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(15,16,10,.85)}
  .fpv-ov.on{display:flex}
  .fpv-box{background:#1c1e15;border:1px solid #3a3d2b;padding:30px 38px;min-width:320px;max-width:440px;font-family:'Share Tech Mono',monospace;color:#d6d2bf;text-align:center}
  .fpv-box h2{font-size:22px;letter-spacing:.25em;color:#d9a52b;margin-bottom:18px}
  .fpv-sub{font-size:11px;letter-spacing:.2em;color:#8b8873;margin:-10px 0 16px}
  .fpv-col{display:flex;flex-direction:column;gap:10px;margin-top:8px}
  .fpv-btn{background:none;border:1px solid #d9a52b;color:#d9a52b;font-family:inherit;font-size:13px;letter-spacing:.2em;padding:10px 18px;cursor:pointer}
  .fpv-btn:hover{background:#d9a52b;color:#14150f}
  .fpv-btn.sec{border-color:#3a3d2b;color:#d6d2bf}
  .fpv-btn.sec:hover{background:rgba(214,210,191,.1);color:#d6d2bf}
  .fpv-row{display:flex;justify-content:space-between;align-items:center;gap:14px;margin:12px 0;font-size:11px;letter-spacing:.15em;color:#8b8873}
  .fpv-row input[type=range]{accent-color:#d9a52b;width:150px}
  .fpv-seg{display:flex;gap:6px}
  .fpv-seg button{background:none;border:1px solid #3a3d2b;color:#d6d2bf;font-family:inherit;font-size:11px;letter-spacing:.1em;padding:5px 10px;cursor:pointer}
  .fpv-seg button.on{border-color:#d9a52b;color:#d9a52b}
  .fpv-hint{margin-top:16px;font-size:9px;letter-spacing:.14em;color:#8b8873;line-height:1.9}
  #fpv-stats{text-align:left;margin:6px 0 14px}
  #fpv-stats div{display:flex;justify-content:space-between;font-size:12px;letter-spacing:.12em;padding:6px 2px;border-bottom:1px solid #26281c}
  #fpv-stats div span:last-child{color:#d9a52b}`;
  document.head.appendChild(st);
  const w=document.createElement('div');
  w.id='fpvwrap';
  w.innerHTML=`
  <canvas id="fpvgl"></canvas>
  <canvas id="fpvosd"></canvas>
  <div id="fpvpause" class="fpv-ov"><div class="fpv-box">
    <h2>FPV PAUSED</h2>
    <div class="fpv-col">
      <button class="fpv-btn" id="fpv-resume">RESUME</button>
      <button class="fpv-btn sec" id="fpv-fpvset">FPV SETTINGS</button>
      <button class="fpv-btn sec" id="fpv-exit1">EXIT TO MENU</button>
    </div>
    <div class="fpv-hint">ENTER / PAD-Y — ARM · SPACE / PAD-A — DROP BOMB<br>
    W/S THROTTLE · A/D YAW · ARROWS PITCH/ROLL · ESC PAUSE</div>
  </div></div>
  <div id="fpvsettings" class="fpv-ov"><div class="fpv-box">
    <h2>FPV SETTINGS</h2>
    <div class="fpv-row"><span>FLIGHT MODE</span><span class="fpv-seg" id="fpv-modeseg"></span></div>
    <div class="fpv-row"><span>RATES</span><span class="fpv-seg" id="fpv-ratesseg"></span></div>
    <div class="fpv-row"><span>CAM TILT <b id="fpv-tiltv" style="color:#d9a52b"></b></span><input type="range" id="fpv-tilt" min="10" max="45" step="1"></div>
    <div class="fpv-row"><label style="cursor:pointer"><input type="checkbox" id="fpv-invy" style="accent-color:#d9a52b"> INVERT YAW</label></div>
    <button class="fpv-btn" id="fpv-setback">BACK</button>
  </div></div>
  <div id="fpvend" class="fpv-ov"><div class="fpv-box">
    <h2 id="fpv-endtitle"></h2><div class="fpv-sub" id="fpv-endsub"></div>
    <div id="fpv-stats"></div>
    <div class="fpv-col">
      <button class="fpv-btn" id="fpv-redeploy">REDEPLOY</button>
      <button class="fpv-btn sec" id="fpv-exit2">EXIT TO MENU</button>
    </div>
  </div></div>`;
  document.body.appendChild(w);
  /* settings widgets */
  const seg=(root,opts,key)=>{
    const el=$(root);el.innerHTML='';
    for(const [id,name] of opts){
      const b=document.createElement('button');
      b.textContent=name;
      if(P[key]===id)b.classList.add('on');
      b.addEventListener('click',()=>{
        P[key]=id;saveP();
        el.querySelectorAll('button').forEach(x=>x.classList.remove('on'));
        b.classList.add('on');beep(880);
      });
      el.appendChild(b);
    }
  };
  seg('#fpv-modeseg',[['angle','ANGLE'],['acro','ACRO']],'mode');
  seg('#fpv-rateseg',[['low','LOW'],['mid','MID'],['high','HIGH']],'rates');
  $('#fpv-tilt').value=P.tilt;
  $('#fpv-tiltv').textContent=P.tilt+'°';
  $('#fpv-tilt').addEventListener('input',e=>{
    P.tilt=+e.target.value;saveP();
    $('#fpv-tiltv').textContent=P.tilt+'°';
    camera.rotation.x=P.tilt*D2R;
  });
  $('#fpv-invy').checked=P.invertYaw;
  $('#fpv-invy').addEventListener('change',e=>{P.invertYaw=e.target.checked;saveP()});
  $('#fpv-resume').addEventListener('click',()=>togglePause());
  $('#fpv-fpvset').addEventListener('click',()=>{
    $('#fpvpause').classList.remove('on');
    $('#fpvsettings').classList.add('on');
  });
  $('#fpv-setback').addEventListener('click',()=>{
    $('#fpvsettings').classList.remove('on');
    $('#fpvpause').classList.add('on');
  });
  $('#fpv-exit1').addEventListener('click',exitFPV);
  $('#fpv-exit2').addEventListener('click',exitFPV);
  $('#fpv-redeploy').addEventListener('click',()=>{beep(880);deploy()});
}
function togglePause(){
  if(!running||ended)return;
  paused=!paused;
  $('#fpvpause').classList.toggle('on',paused);
  if(paused&&AC){mGain.gain.value=0;windGain.gain.value=0}
  beep(paused?600:900);
}
function showEnd(win,title,sub){
  ended=true;paused=false;
  $('#fpvpause').classList.remove('on');$('#fpvsettings').classList.remove('on');
  if(AC){mGain.gain.value=0;windGain.gain.value=0}
  $('#fpv-endtitle').textContent=title;
  $('#fpv-endsub').textContent=sub;
  const eff=bombsDropped?Math.round(kills/bombsDropped*100):0;
  $('#fpv-stats').innerHTML=[
    ['RESULT',win?'SUCCESS':'FAILURE'],
    ['TARGETS DESTROYED',kills+' / 50'],
    ['BOMBS DROPPED',bombsDropped],
    ['EFFICIENCY',eff+'%'],
    ['FLIGHT TIME',Math.floor(time/60)+':'+String(Math.floor(time%60)).padStart(2,'0')],
    ['TOP SPEED',topSpd.toFixed(0)+' KMH']
  ].map(r=>`<div><span>${r[0]}</span><span>${r[1]}</span></div>`).join('');
  $('#fpvend').classList.add('on');
}

/* ---------- deploy / exit ---------- */
function resize(){
  if(!renderer)return;
  renderer.setSize(innerWidth,innerHeight);
  camera.aspect=innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  const osd=$('#fpvosd');
  osd.width=innerWidth;osd.height=innerHeight;
}
addEventListener('resize',()=>{if(running)resize()});
function deploy(){
  seed=(Date.now()^(Math.random()*1e9))>>>0;
  buildWorld(seed);
  dead=false;ended=false;paused=false;arm=false;
  thr=0;thrT=0;yaw=0;time=0;batt=100;battDead=false;
  kills=0;bombsDropped=0;topSpd=0;shake=0;dropCd=0;groundedT=0;
  pos.set(0,1,500);vel.set(0,0,0);q.identity();
  ctl.p=ctl.r=ctl.y=0;osdMsgs.length=0;
  $('#fpvend').classList.remove('on');
  $('#fpvpause').classList.remove('on');
  $('#fpvsettings').classList.remove('on');
  osdMsg('FPV DRONE MODE — ARM WHEN READY');
  osdMsg('50 TARGETS · BOMB THEM ALL');
}
function startFPV(){
  ensureEngine();ensureAudio();buildUI();resize();
  const gl=document.getElementById('gl');
  glPrev=gl?gl.style.display:'';
  if(gl)gl.style.display='none';
  $('#fpvwrap').classList.add('on');
  running=true;window.__FPV_ACTIVE__=true;
  deploy();
  if(!rafRunning){rafRunning=true;last=performance.now();raf=requestAnimationFrame(loop)}
}
function exitFPV(){
  running=false;paused=false;ended=false;
  window.__FPV_ACTIVE__=false;
  rafRunning=false;cancelAnimationFrame(raf);
  $('#fpvwrap').classList.remove('on');
  const gl=document.getElementById('gl');
  if(gl)gl.style.display=glPrev;
  if(AC){mGain.gain.value=0;windGain.gain.value=0}
}

/* ---------- loop ---------- */
function loop(t){
  if(!rafRunning)return;
  raf=requestAnimationFrame(loop);
  const dt=Math.min((t-last)/1000,.05)||.016;last=t;
  if(!paused&&!ended&&!dead)step(dt);
  updateFX(dt);
  drawOSD(dt);
  renderer.render(scene,camera);
}

/* ---------- menu injection (merges with THE WAR / falls back standalone) ---------- */
function injectMenu(nav,ok){
  const btn=document.createElement('button');
  if(nav){
    btn.innerHTML='<span class="idx">00</span> FPV DRONE MODE<em>QUAD FLIGHT · BOMB 50 TARGETS</em>';
    const mm=document.querySelector('.mastmeta');
    if(mm)mm.innerHTML='FPV + GROUND COMBAT // BUILD 3.0 <em>// FPV MODE IS BACK</em>';
  }else{
    btn.textContent='FPV DRONE MODE';
    btn.style.cssText='position:fixed;left:18px;bottom:18px;z-index:99;background:#14150f;color:#d9a52b;border:1px solid #d9a52b;font-family:monospace;letter-spacing:.2em;padding:12px 18px;cursor:pointer';
  }
  if(!ok){
    btn.style.opacity=.4;
    btn.addEventListener('click',()=>alert('FPV: 3D engine failed to load — check connection.'));
  }else{
    btn.addEventListener('click',e=>{e.stopPropagation();startFPV()});
  }
  btn.addEventListener('mouseover',e=>e.stopPropagation());
  if(nav)nav.prepend(btn);else document.body.appendChild(btn);
  document.title='THE WAR — FPV & GROUND';
}
let nTries=0;
const iv=setInterval(()=>{
  if(!THREE)return;
  const nav=document.getElementById('modenav');
  if(nav||++nTries>120){clearInterval(iv);injectMenu(nav,true)}
},50);
if(!THREE){
  clearInterval(iv);
  setTimeout(()=>injectMenu(document.getElementById('modenav'),false),3000);
}
})();
