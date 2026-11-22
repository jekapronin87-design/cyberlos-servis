/** Страница Системно для телефона (PWA без зависимостей). Скрипт и стили отдаются отдельными файлами — так работает строгий CSP. */

export const INDEX_HTML = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#050b14">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="/app.css">
<title>Системно</title></head>
<body>
<main id="pair" hidden>
  <div class="orb"></div>
  <h1>Системно</h1>
  <p>Откройте на компьютере Системно → Настройки → «Доступ с телефона» → «Показать код» и введите 6 цифр.</p>
  <input id="code" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="off">
  <input id="devname" maxlength="40" placeholder="Название телефона">
  <button id="pairBtn">Подключить</button>
  <p id="pairErr" class="err"></p>
</main>
<main id="app" hidden>
  <header><span class="dot" id="dot"></span><b>Системно</b><span id="mode"></span><button id="mute" title="Озвучка ответов">🔊</button><button id="logout" title="Отключить этот телефон">⎋</button></header>
  <section id="log" aria-live="polite"></section>
  <p id="note"></p>
  <form id="form"><button type="button" id="mic" title="Голос">🎤</button><input id="text" placeholder="Сообщение…" autocomplete="off"><button id="send">➤</button><button type="button" id="stop" hidden>■</button></form>
</main>
<script src="/app.js"></script>
</body></html>`;

export const MANIFEST = JSON.stringify({
  name: 'Системно',
  short_name: 'Системно',
  start_url: '/',
  display: 'standalone',
  background_color: '#050b14',
  theme_color: '#050b14',
  icons: [],
});

export const APP_CSS = `
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#050b14;color:#cfe9ff;font:16px system-ui,sans-serif}
main{display:flex;flex-direction:column;height:100%;padding:12px;max-width:640px;margin:0 auto}
#pair{align-items:center;justify-content:center;text-align:center;gap:12px}
.orb{width:96px;height:96px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#bff6ff,#27c4ff 45%,#0a3b6b);box-shadow:0 0 40px #27c4ff88;animation:p 3s ease-in-out infinite}
@keyframes p{50%{transform:scale(1.07);box-shadow:0 0 70px #27c4ffcc}}
h1{margin:0;letter-spacing:.3em;font-weight:300}
input,button{font:inherit;color:inherit;background:#0b1b2e;border:1px solid #1d4468;border-radius:10px;padding:12px}
#code{font-size:28px;letter-spacing:.4em;text-align:center;width:11em}
button{cursor:pointer;background:#0d3a5f}button:active{background:#14578a}
header{display:flex;align-items:center;gap:8px;padding:4px 2px 10px}header b{letter-spacing:.2em;flex:1}header button{padding:6px 10px}
.dot{width:10px;height:10px;border-radius:50%;background:#e55}.dot.ok{background:#3d6}
#mode{font-size:12px;opacity:.7}
#log{flex:1;overflow:auto;display:flex;flex-direction:column;gap:8px;padding:4px 0}
.m{max-width:88%;padding:10px 12px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word;line-height:1.4}
.m.user{align-self:flex-end;background:#0d3a5f}.m.assistant{align-self:flex-start;background:#0b1b2e;border:1px solid #17375a}
.m.sys{align-self:center;font-size:13px;opacity:.7}
#note{min-height:1.2em;margin:4px 2px;font-size:13px;opacity:.75}
#form{display:flex;gap:6px}#text{flex:1;min-width:0}#mic.on{background:#a22}
.err{color:#f88}
`;

export const APP_JS = `
(function(){
var $=function(i){return document.getElementById(i)};
var tok=null;try{tok=localStorage.getItem('jt')}catch(e){}
var muted=false;try{muted=localStorage.getItem('jm')==='1'}catch(e){}
var busy=false,pollT=null,lastShown='';
function show(id){$('pair').hidden=id!=='pair';$('app').hidden=id!=='app'}
function api(path,body){
  var o={method:body===undefined?'GET':'POST',headers:{}};
  if(tok)o.headers['Authorization']='Bearer '+tok;
  if(body!==undefined){o.headers['Content-Type']='application/json';o.body=JSON.stringify(body)}
  return fetch(path,o).then(function(r){return r.json().catch(function(){return {}}).then(function(j){if(r.status===401&&tok){drop()}if(!r.ok)throw new Error(j.error||('Ошибка '+r.status));return j})});
}
function drop(){tok=null;try{localStorage.removeItem('jt')}catch(e){}show('pair')}
function add(role,text){var d=document.createElement('div');d.className='m '+role;d.textContent=text;var l=$('log');l.appendChild(d);l.scrollTop=l.scrollHeight;return d}
function setBusy(b){busy=b;$('send').hidden=b;$('stop').hidden=!b;$('dot').className='dot'+(b?'':' ok')}
function speak(t){
  if(muted||!window.speechSynthesis||!t)return;
  try{speechSynthesis.cancel();var u=new SpeechSynthesisUtterance(t);u.lang='ru-RU';speechSynthesis.speak(u)}catch(e){}
}
function init(){
  show('app');$('dot').className='dot ok';$('mute').textContent=muted?'🔇':'🔊';
  api('/api/me').then(function(me){$('mode').textContent=me.mode==='live'?'Claude':'демо-режим';if(me.busy)poll()})
   .catch(function(e){$('note').textContent=e.message});
  api('/api/messages').then(function(r){r.messages.forEach(function(m){add(m.role,m.text)})}).catch(function(){});
}
function poll(){
  setBusy(true);clearTimeout(pollT);
  api('/api/run').then(function(r){
    $('note').textContent=r.waitingForPc?'Жду подтверждения на компьютере…':(r.status==='running'?'Думаю…':'');
    if(r.status==='running'){pollT=setTimeout(poll,1000);return}
    setBusy(false);$('note').textContent='';
    if(r.status==='error')add('sys','Ошибка: '+(r.error||'не удалось'));
    else if(r.status==='stopped')add('sys','Остановлено.');
    else if(r.reply){add('assistant',r.reply);speak(r.reply)}
  }).catch(function(e){pollT=setTimeout(poll,3000);$('note').textContent=e.message});
}
function send(text){
  text=(text||'').trim();if(!text||busy)return;
  add('user',text);$('text').value='';setBusy(true);
  api('/api/chat',{text:text}).then(poll).catch(function(e){setBusy(false);add('sys',e.message)});
}
$('pairBtn').onclick=function(){
  $('pairErr').textContent='';
  api('/api/pair',{code:$('code').value.trim(),name:$('devname').value.trim()||navigator.platform||'Телефон'}).then(function(r){
    tok=r.token;try{localStorage.setItem('jt',tok)}catch(e){}init();
  }).catch(function(e){$('pairErr').textContent=e.message});
};
$('form').onsubmit=function(e){e.preventDefault();send($('text').value)};
$('stop').onclick=function(){api('/api/stop',{}).catch(function(){})};
$('mute').onclick=function(){muted=!muted;try{localStorage.setItem('jm',muted?'1':'0')}catch(e){}$('mute').textContent=muted?'🔇':'🔊';if(muted&&window.speechSynthesis)speechSynthesis.cancel()};
$('logout').onclick=function(){if(confirm('Отключить этот телефон?'))api('/api/logout',{}).catch(function(){}).then(drop)};
var SR=window.SpeechRecognition||window.webkitSpeechRecognition,rec=null;
$('mic').onclick=function(){
  if(!SR){$('note').textContent='Голос в этом браузере недоступен (для микрофона часто нужен https). Пишите текстом.';return}
  if(rec){rec.stop();return}
  rec=new SR();rec.lang='ru-RU';rec.interimResults=false;
  rec.onresult=function(e){var t=e.results[0][0].transcript;send(t)};
  rec.onerror=function(e){$('note').textContent='Микрофон: '+(e.error||'ошибка')};
  rec.onend=function(){rec=null;$('mic').className=''};
  $('mic').className='on';try{rec.start()}catch(e){rec=null;$('mic').className=''}
};
if(tok)init();else show('pair');
})();
`;
