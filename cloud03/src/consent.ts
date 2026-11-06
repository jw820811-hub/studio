import { randomBytes } from 'node:crypto';
const escaped = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function consentPage(name: string, requestedScopes: string[], requestId: string) {
  const nonce = randomBytes(18).toString('base64');
  const payload = JSON.stringify({ requestId, canWrite: requestedScopes.includes('studio.write') }).replace(/</g, '\\u003c');
  return { nonce, html: `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>連結 Cloud03 · Woody’s Studio</title>
<style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;background:#eaf1eb;color:#173d30;font:17px/1.7 system-ui,"Microsoft JhengHei",sans-serif;padding:32px 16px}main{max-width:580px;margin:6vh auto;background:white;border-radius:20px;padding:32px;box-shadow:0 12px 40px #163c3012}h1{font-size:26px;line-height:1.4;margin:12px 0}h2{font-size:18px}p{color:#465c50}.brand{font-weight:700;letter-spacing:1px}.account{padding:12px;background:#f0f5f1;overflow-wrap:anywhere}button{font:inherit;padding:11px 18px;border-radius:8px;border:1px solid #b8c8bd;background:white;color:#173d30;cursor:pointer;min-height:48px}button.primary{background:#173d30;color:white;border-color:#173d30}button:disabled{opacity:.5;cursor:wait}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}label{display:flex;gap:10px;align-items:flex-start;margin:18px 0}input{width:20px;height:20px;flex-shrink:0;margin-top:5px}small{display:block;color:#465c50;font-size:14px}#message{color:#9d241d;white-space:pre-wrap}[hidden]{display:none!important}:focus-visible{outline:3px solid #c48414;outline-offset:3px}
</style></head><body><main><div class="brand">Woody’s Studio</div><h1>讓 Cloud03 協助管理工作台</h1>
<p>連線應用程式：<strong>${escaped(name)}</strong></p>
<h2>這次連線可以做什麼</h2><ul><li>查詢你帳號內的行程、待辦、投稿與計畫文字。</li><li>查看紀錄的最後更新時間。</li></ul>
${requestedScopes.includes('studio.write') ? '<label><input id="allowWrite" type="checkbox" checked><span>允許建立單次行程、待辦，以及更新投稿狀態與待辦完成狀態。</span></label>' : ''}
<small>附件內容、作者聯絡資料及計畫經費不包含在這次連線。每筆更新會保留操作紀錄。</small>
<div class="account"><span id="account">請使用登入工作台的 Google 帳號。</span></div>
<div class="actions"><button id="login">選擇 Google 帳號</button><button id="approve" class="primary" disabled>同意連結</button><button id="cancel">取消</button></div>
<p id="message" role="status" aria-live="polite"></p><small>連結有效期限為 30 天。可在 ChatGPT 外掛設定撤銷授權；期滿需重新連結。</small>
</main><script type="module" nonce="${nonce}">
import {initializeApp} from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js';
import {getAuth,setPersistence,inMemoryPersistence,GoogleAuthProvider,signInWithPopup} from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js';
const context=${payload};
const app=initializeApp({apiKey:'AIzaSyADzwR63uIMyQZc1KNU_6GamTmXtGP5c_U',authDomain:'woodys-studio.firebaseapp.com',projectId:'woodys-studio',appId:'1:1095186977856:web:e649c370afb0fa28143ba5'});
const auth=getAuth(app);await setPersistence(auth,inMemoryPersistence);
const byId=id=>document.getElementById(id);let user=null;let busy=false;
function state(value){busy=value;byId('login').disabled=value;byId('approve').disabled=value||!user;byId('cancel').disabled=value;}
function error(e){byId('message').textContent=e.code==='auth/unauthorized-domain'?'連結頁的網域尚未完成設定，請聯絡網站管理者。':e.code==='auth/popup-closed-by-user'?'登入視窗已關閉，尚未連結。':e.code==='auth/popup-blocked'?'請允許 Google 登入視窗後重試。':e.message||'連線失敗，請重試。';}
byId('login').onclick=async()=>{state(true);byId('message').textContent='';try{const provider=new GoogleAuthProvider();provider.setCustomParameters({prompt:'select_account'});user=(await signInWithPopup(auth,provider)).user;byId('account').textContent=user.email||user.displayName||'已登入';}catch(e){error(e);}finally{state(false);}};
async function submit(action){if(busy)return;state(true);byId('message').textContent='';try{const response=await fetch('/consent/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:context.requestId,...action==='approve'?{idToken:await user.getIdToken(),allowWrite:!!byId('allowWrite')?.checked}:{}})});const result=await response.json();if(!response.ok)throw Error(result.error||'連線失敗');window.location.assign(result.redirect);}catch(e){error(e);state(false);}}
byId('approve').onclick=()=>submit('approve');byId('cancel').onclick=()=>submit('cancel');
</script></body></html>` };
}
