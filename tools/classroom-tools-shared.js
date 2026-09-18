(()=>{
'use strict';
const LEGACY_KEY='kathleenClassListsV1';
const VAULT_KEY='kathleenClassListsVaultV2';
const KDF_ITERATIONS=250000;
const AUTO_LOCK_MS=15*60*1000;
const enc=new TextEncoder(),dec=new TextDecoder(),AAD=enc.encode('KathleenClassListsVaultV2');
let key=null,cache=[],guardPromise=null,guardResolve=null,lockTimer=null,activityBound=false;

function uid(){return 'class-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7)}
function cleanStudents(v){
  const a=Array.isArray(v)?v:String(v||'').split(/[\n,;]+/),seen=new Set(),out=[];
  for(const raw of a){const n=String(raw).trim().replace(/\s+/g,' ');if(!n)continue;const k=n.toLocaleLowerCase('de');if(seen.has(k))continue;seen.add(k);out.push(n)}
  return out
}
function sanitizeLists(v){
  if(!Array.isArray(v))return[];
  return v.map(x=>({id:String(x?.id||uid()),name:String(x?.name||'').trim(),students:cleanStudents(x?.students||[]),updatedAt:x?.updatedAt||new Date().toISOString()}))
    .filter(x=>x.name)
    .sort((a,b)=>a.name.localeCompare(b.name,'de',{numeric:true}))
}
function bytesToB64(bytes){let s='';for(let i=0;i<bytes.length;i+=0x8000)s+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(s)}
function b64ToBytes(s){const b=atob(s),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a}
function randomBytes(n){const a=new Uint8Array(n);crypto.getRandomValues(a);return a}
function vaultIterations(v){const n=Number(v?.iterations)||KDF_ITERATIONS;return Math.max(100000,Math.min(1000000,n))}
async function deriveKey(pin,salt,iterations=KDF_ITERATIONS){
  const material=await crypto.subtle.importKey('raw',enc.encode(pin),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])
}
function hasVault(){return !!localStorage.getItem(VAULT_KEY)}
function hasLegacy(){return !!localStorage.getItem(LEGACY_KEY)}
function isUnlocked(){return !!key}
function load(){return key?cache.map(c=>({...c,students:[...c.students]})):[]}
function get(id){return key?(cache.find(x=>x.id===id)||null):null}
function assertUnlocked(){if(!key)throw new Error('Klassenlisten sind gesperrt.')}
function readLegacy(){try{return sanitizeLists(JSON.parse(localStorage.getItem(LEGACY_KEY)||'[]'))}catch(e){return[]}}
async function persist(lists=cache){
  assertUnlocked();cache=sanitizeLists(lists);
  let vault;try{vault=JSON.parse(localStorage.getItem(VAULT_KEY)||'null')}catch(e){vault=null}
  if(!vault?.salt)throw new Error('Verschlüsselung ist nicht eingerichtet.');
  const iv=randomBytes(12),payload=enc.encode(JSON.stringify({version:2,classes:cache}));
  const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:AAD},key,payload));
  const next={version:2,cipher:'AES-256-GCM',kdf:'PBKDF2-SHA256',iterations:KDF_ITERATIONS,salt:vault.salt,iv:bytesToB64(iv),data:bytesToB64(cipher),updatedAt:new Date().toISOString()};
  localStorage.setItem(VAULT_KEY,JSON.stringify(next));localStorage.removeItem(LEGACY_KEY);touch();
  window.dispatchEvent(new CustomEvent('kathleen:classlists'));return true
}
async function setup(pin){
  pin=String(pin||'');if(pin.length<8)throw new Error('Die Lehrer-PIN muss mindestens 8 Zeichen haben.');
  if(!crypto?.subtle)throw new Error('Dieser Browser unterstützt die benötigte Verschlüsselung nicht.');
  const salt=randomBytes(16);key=await deriveKey(pin,salt);cache=readLegacy();
  localStorage.setItem(VAULT_KEY,JSON.stringify({version:2,cipher:'AES-256-GCM',kdf:'PBKDF2-SHA256',iterations:KDF_ITERATIONS,salt:bytesToB64(salt),iv:'',data:'',updatedAt:new Date().toISOString()}));
  try{await persist(cache)}catch(e){localStorage.removeItem(VAULT_KEY);key=null;cache=[];throw e}
  bindActivity();window.dispatchEvent(new CustomEvent('kathleen:classlists-unlocked'));return true
}
async function unlock(pin){
  pin=String(pin||'');if(!hasVault())return setup(pin);
  if(!crypto?.subtle)throw new Error('Dieser Browser unterstützt die benötigte Verschlüsselung nicht.');
  let vault;try{vault=JSON.parse(localStorage.getItem(VAULT_KEY)||'null')}catch(e){throw new Error('Der verschlüsselte Speicher ist beschädigt.')}
  if(!vault?.salt||!vault?.iv||!vault?.data)throw new Error('Der verschlüsselte Speicher ist unvollständig.');
  const candidate=await deriveKey(pin,b64ToBytes(vault.salt),vaultIterations(vault));
  try{
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64ToBytes(vault.iv),additionalData:AAD},candidate,b64ToBytes(vault.data));
    const parsed=JSON.parse(dec.decode(plain));key=candidate;cache=sanitizeLists(parsed?.classes||[]);localStorage.removeItem(LEGACY_KEY);bindActivity();
    window.dispatchEvent(new CustomEvent('kathleen:classlists-unlocked'));return true
  }catch(e){key=null;cache=[];throw new Error('Lehrer-PIN falsch oder Backup beschädigt.')}
}
function lock(reload=false){key=null;cache=[];clearTimeout(lockTimer);lockTimer=null;window.dispatchEvent(new CustomEvent('kathleen:classlists-locked'));if(reload)setTimeout(()=>location.reload(),20)}
function touch(){if(!key)return;clearTimeout(lockTimer);lockTimer=setTimeout(()=>lock(true),AUTO_LOCK_MS)}
function bindActivity(){touch();if(activityBound)return;activityBound=true;['pointerdown','keydown','touchstart'].forEach(ev=>window.addEventListener(ev,touch,{passive:true}))}
async function upsert(data){
  assertUnlocked();const lists=load(),id=data.id||uid(),item={id,name:String(data.name||'').trim(),students:cleanStudents(data.students),updatedAt:new Date().toISOString()};
  if(!item.name)throw new Error('Klassenname fehlt');const i=lists.findIndex(x=>x.id===id);if(i>=0)lists[i]=item;else lists.push(item);await persist(lists);return item
}
async function remove(id){assertUnlocked();await persist(load().filter(x=>x.id!==id))}
function shuffle(input){const a=[...input];for(let i=a.length-1;i>0;i--){let j;if(window.crypto&&crypto.getRandomValues){const u=new Uint32Array(1);crypto.getRandomValues(u);j=u[0]%(i+1)}else j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function detectDelimiter(line){const counts={';':0,',':0,'\t':0};let quoted=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'){if(line[i+1]==='"')i++;else quoted=!quoted}else if(!quoted&&Object.prototype.hasOwnProperty.call(counts,ch))counts[ch]++}return Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0]}
function parseDelimited(text){
  text=String(text||'').replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim();if(!text)return[];
  const delimiter=detectDelimiter(text.split('\n')[0]),rows=[];let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){const ch=text[i];if(ch==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++}else quoted=!quoted}else if(ch===delimiter&&!quoted){row.push(field);field=''}else if(ch==='\n'&&!quoted){row.push(field);rows.push(row);row=[];field=''}else field+=ch}
  row.push(field);rows.push(row);return rows.filter(r=>r.some(v=>String(v).trim()))
}
function normalizeHeader(s){return String(s||'').trim().toLocaleLowerCase('de').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[\s-]+/g,'_')}
async function importCsv(text,{replace=false}={}){
  assertUnlocked();const rows=parseDelimited(text);if(rows.length<2)throw new Error('Die CSV enthält keine Datenzeilen.');
  const header=rows[0].map(normalizeHeader),classAliases=['class_name','klasse','class','klassenname'],studentAliases=['student_name','schueler','schuler','student','name'];
  const ci=header.findIndex(h=>classAliases.includes(h)),si=header.findIndex(h=>studentAliases.includes(h));if(ci<0||si<0)throw new Error('Erwartete Spalten: class_name und student_name.');
  const grouped=new Map();for(const r of rows.slice(1)){const cn=String(r[ci]||'').trim(),sn=String(r[si]||'').trim();if(!cn||!sn)continue;if(!grouped.has(cn))grouped.set(cn,[]);grouped.get(cn).push(sn)}
  if(!grouped.size)throw new Error('Keine gültigen Schülerdaten gefunden.');let lists=replace?[]:load();
  for(const [name,students] of grouped){const existing=lists.find(x=>x.name.toLocaleLowerCase('de')===name.toLocaleLowerCase('de'));if(existing)existing.students=cleanStudents([...existing.students,...students]),existing.updatedAt=new Date().toISOString();else lists.push({id:uid(),name,students:cleanStudents(students),updatedAt:new Date().toISOString()})}
  await persist(lists);return {classes:grouped.size,students:[...grouped.values()].reduce((n,a)=>n+a.length,0)}
}
function csvEscape(v,del=';'){const s=String(v??'');return /["\n\r;,\t]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}
function exportCsv(lists=load(),delimiter=';'){assertUnlocked();const rows=[['class_name','student_name']];for(const c of lists)for(const s of c.students)rows.push([c.name,s]);return '\uFEFF'+rows.map(r=>r.map(v=>csvEscape(v,delimiter)).join(delimiter)).join('\r\n')}
function templateCsv(){return '\uFEFFclass_name;student_name\r\n9a;Anna M.\r\n9a;Ben K.\r\n10b;Carla S.\r\n'}
async function importPlainJson(text,{replace=false}={}){
  assertUnlocked();const d=JSON.parse(text),incoming=Array.isArray(d)?d:Array.isArray(d.classes)?d.classes:null;if(!incoming)throw new Error('Ungültiges JSON-Format.');let lists=replace?[]:load();
  for(const raw of incoming){const name=String(raw.name||'').trim(),students=cleanStudents(raw.students);if(!name||!students.length)continue;const existing=lists.find(x=>x.name.toLocaleLowerCase('de')===name.toLocaleLowerCase('de'));if(existing)existing.students=cleanStudents([...existing.students,...students]),existing.updatedAt=new Date().toISOString();else lists.push({id:uid(),name,students,updatedAt:new Date().toISOString()})}
  await persist(lists);return {classes:lists.length,students:lists.reduce((n,c)=>n+c.students.length,0)}
}
function exportSecureBackup(){
  const raw=localStorage.getItem(VAULT_KEY);if(!raw)throw new Error('Noch kein verschlüsselter Speicher vorhanden.');
  return JSON.stringify({format:'kathleen-class-vault',version:2,exportedAt:new Date().toISOString(),vault:JSON.parse(raw)},null,2)
}
function validateVault(v){return !!(v&&v.version===2&&v.cipher==='AES-256-GCM'&&typeof v.salt==='string'&&typeof v.iv==='string'&&typeof v.data==='string')}
async function importSecureBackup(text,pin){
  const d=JSON.parse(text),v=d?.format==='kathleen-class-vault'?d.vault:null;if(!validateVault(v))throw new Error('Kein gültiges verschlüsseltes Klassenlisten-Backup.');
  const candidate=await deriveKey(String(pin||''),b64ToBytes(v.salt),vaultIterations(v));let restored;
  try{const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64ToBytes(v.iv),additionalData:AAD},candidate,b64ToBytes(v.data));restored=sanitizeLists(JSON.parse(dec.decode(plain))?.classes||[])}catch(e){throw new Error('Backup-PIN falsch oder Backup beschädigt.')}
  localStorage.setItem(VAULT_KEY,JSON.stringify(v));localStorage.removeItem(LEGACY_KEY);key=candidate;cache=restored;bindActivity();window.dispatchEvent(new CustomEvent('kathleen:classlists'));return true
}
async function changePin(newPin){
  assertUnlocked();newPin=String(newPin||'');if(newPin.length<8)throw new Error('Die neue Lehrer-PIN muss mindestens 8 Zeichen haben.');
  const lists=load(),salt=randomBytes(16),oldVault=localStorage.getItem(VAULT_KEY),oldKey=key;key=await deriveKey(newPin,salt);
  localStorage.setItem(VAULT_KEY,JSON.stringify({version:2,cipher:'AES-256-GCM',kdf:'PBKDF2-SHA256',iterations:KDF_ITERATIONS,salt:bytesToB64(salt),iv:'',data:'',updatedAt:new Date().toISOString()}));
  try{await persist(lists);return true}catch(e){if(oldVault)localStorage.setItem(VAULT_KEY,oldVault);key=oldKey;throw e}
}
async function secureSet(namespace,value){assertUnlocked();const name=String(namespace||'').trim();if(!name)throw new Error('Speichername fehlt.');const iv=randomBytes(12),aad=enc.encode('KathleenSecureStore:'+name),payload=enc.encode(JSON.stringify({version:1,value}));const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},key,payload));localStorage.setItem('kathleenSecure:'+name,JSON.stringify({version:1,iv:bytesToB64(iv),data:bytesToB64(cipher),updatedAt:new Date().toISOString()}));touch();return true}
async function secureGet(namespace,fallback=null){assertUnlocked();const name=String(namespace||'').trim(),raw=localStorage.getItem('kathleenSecure:'+name);if(!raw)return fallback;try{const box=JSON.parse(raw),aad=enc.encode('KathleenSecureStore:'+name),plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64ToBytes(box.iv),additionalData:aad},key,b64ToBytes(box.data));return JSON.parse(dec.decode(plain))?.value??fallback}catch(e){throw new Error('Geschützter Zusatzspeicher konnte nicht entschlüsselt werden.')}}
function secureRemove(namespace){assertUnlocked();localStorage.removeItem('kathleenSecure:'+String(namespace||'').trim());touch();return true}
function ensureGuardStyles(){
  if(document.getElementById('kclGuardStyle'))return;
  const s=document.createElement('style');s.id='kclGuardStyle';
  s.textContent='.kcl-guard{position:fixed;inset:0;z-index:20000;display:grid;place-items:center;padding:18px;background:rgba(58,41,60,.42);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}.kcl-guard-card{width:min(470px,94vw);background:#fff;border:1px solid #eadde9;border-radius:24px;padding:20px;box-shadow:0 30px 100px rgba(70,46,72,.28);color:#503d51}.kcl-lock-icon{width:58px;height:58px;border-radius:18px;display:grid;place-items:center;font-size:27px;background:linear-gradient(145deg,#ffe4f0,#ece6ff);margin-bottom:12px}.kcl-guard h2{margin:0;font:950 22px/1.1 Inter,ui-rounded,"SF Pro Rounded",Arial,sans-serif;color:#684d6b}.kcl-guard p{font:500 11px/1.55 Inter,Arial,sans-serif;color:#8d788f;margin:8px 0 13px}.kcl-guard label{display:block;font:950 9px/1 Inter,Arial,sans-serif;text-transform:uppercase;letter-spacing:.08em;color:#8d788f;margin:10px 0 5px}.kcl-guard input{width:100%;min-height:46px;border:1px solid #eadde9;border-radius:12px;background:#fffafd;padding:11px;font:inherit;font-size:16px;color:#503d51;outline:none}.kcl-guard input:focus{border-color:#d5a7c5;box-shadow:0 0 0 4px rgba(239,181,210,.13)}.kcl-guard-actions{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:14px}.kcl-guard button{border:1px solid #eadde9;background:#fff;color:#503d51;border-radius:12px;padding:11px 13px;font-weight:900;min-height:44px;cursor:pointer}.kcl-guard .primary{border:0;color:#fff;background:linear-gradient(135deg,#d790b5,#aa8cde)}.kcl-guard-msg{min-height:16px;margin-top:9px!important;color:#a8556a!important;font-weight:800!important}.kcl-security-note{padding:9px 10px;border-radius:11px;background:#f4f9f7;color:#5b806f!important;border:1px solid #dceee7}@media(max-width:560px){.kcl-guard{align-items:end;padding:0}.kcl-guard-card{width:100%;max-width:none;border-radius:24px 24px 0 0;padding:18px 14px calc(18px + env(safe-area-inset-bottom))}.kcl-guard-actions{grid-template-columns:1fr}.kcl-guard button{width:100%}}';
  document.head.appendChild(s)
}
function closeGuard(){document.getElementById('kclGuard')?.remove();const r=guardResolve;guardPromise=null;guardResolve=null;if(r)r(true)}
async function requireUnlock(){
  if(key){touch();return true}
  const admin=sessionStorage.getItem('kathleenAdminPass')||'';if(hasVault()&&admin){try{await unlock(admin);return true}catch(e){}}
  if(guardPromise)return guardPromise;ensureGuardStyles();guardPromise=new Promise(resolve=>{guardResolve=resolve});
  const setupMode=!hasVault(),g=document.createElement('div');g.id='kclGuard';g.className='kcl-guard';
  g.innerHTML='<div class="kcl-guard-card"><div class="kcl-lock-icon">🔐</div><h2>'+(setupMode?'Klassenlisten schützen':'Klassenlisten entsperren')+'</h2><p>'+(setupMode?'Lege einmalig eine lokale Lehrer-PIN fest. Vorhandene unverschlüsselte Listen werden automatisch verschlüsselt und danach aus dem alten Speicher entfernt.':'Die Namen sind auf diesem Gerät AES-256-GCM-verschlüsselt. Zum Verwenden der Klassenlisten bitte entsperren.')+'</p><p class="kcl-security-note">🔒 Nur lokal · kein Upload · automatische Sperre nach 15 Minuten Inaktivität.</p><label>Lehrer-PIN</label><input id="kclPin" type="password" autocomplete="'+(setupMode?'new-password':'current-password')+'" placeholder="Mindestens 8 Zeichen">'+(setupMode?'<label>PIN wiederholen</label><input id="kclPin2" type="password" autocomplete="new-password" placeholder="PIN wiederholen">':'')+'<div class="kcl-guard-msg" id="kclMsg"></div><div class="kcl-guard-actions"><button class="primary" id="kclUnlock">'+(setupMode?'Verschlüsselung aktivieren':'Entsperren')+'</button><button id="kclBack">← Tools</button></div>'+(setupMode?'<p>Die PIN wird nicht gespeichert und kann nicht wiederhergestellt werden. Du kannst dieselbe wie dein Kisten-Admin-Passwort verwenden.</p>':'')+'</div>';
  document.body.appendChild(g);
  const pin=g.querySelector('#kclPin'),msg=g.querySelector('#kclMsg'),submit=g.querySelector('#kclUnlock');
  const run=async()=>{msg.textContent='';submit.disabled=true;try{if(setupMode){const p2=g.querySelector('#kclPin2').value;if(pin.value!==p2)throw new Error('Die beiden PINs stimmen nicht überein.');await setup(pin.value)}else await unlock(pin.value);closeGuard()}catch(e){msg.textContent=e.message||'Entsperren fehlgeschlagen.';submit.disabled=false;pin.focus()}};
  submit.onclick=run;pin.addEventListener('keydown',e=>{if(e.key==='Enter')run()});g.querySelector('#kclPin2')?.addEventListener('keydown',e=>{if(e.key==='Enter')run()});g.querySelector('#kclBack').onclick=()=>{location.href=new URL('../../#tools',location.href).toString()};setTimeout(()=>pin.focus(),60);
  return guardPromise
}
window.KathleenClassLists={load,persist,upsert,remove,get,cleanStudents,shuffle,parseDelimited,importCsv,exportCsv,templateCsv,importPlainJson,exportSecureBackup,importSecureBackup,changePin,setup,unlock,lock,requireUnlock,isUnlocked,hasVault,hasLegacy,autoLockMinutes:AUTO_LOCK_MS/60000,secureSet,secureGet,secureRemove,key:VAULT_KEY,legacyKey:LEGACY_KEY};
})();