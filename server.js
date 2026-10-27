const http=require('http'),fs=require('fs'),path=require('path'),{WebSocketServer}=require('ws');
const page=fs.readFileSync(path.join(__dirname,'index.html'));
const srv=http.createServer((q,s)=>{s.writeHead(200,{'content-type':'text/html; charset=utf-8'});s.end(page)});
const wss=new WebSocketServer({server:srv,maxPayload:2e6});
const rooms={};
const roles=(r,order)=>{const n=order.length,o=[];for(let k=1;k<n;k++)o.push(order[(r+k)%n]);return{presenter:order[r%n],picker:o[0],themer:o[1%o.length],titler:o[2%o.length]}};
const round0=(r,order)=>({phase:'setup',round:r,...roles(r,order),slides:null,theme:null,title:null,slideIdx:0,result:null});
const send=(ws,m)=>{if(ws&&ws.readyState===1)ws.send(JSON.stringify(m))};
const voters=R=>R.S.order.filter(x=>x!==R.S.presenter&&R.players[x]);
const txt=(s,n)=>String(s==null?'':s).trim().slice(0,n);
function broadcast(R){const P={};for(const id in R.players)P[id]={name:R.players[id].name,photos:R.players[id].photos};
  for(const id in R.players)send(R.players[id].ws,{t:'st',code:R.code,S:{...R.S,host:R.host},P,I:R.I})}
function step(R){const S=R.S;if(S.slideIdx+1<S.slides.length)S.slideIdx++;else S.phase='fav'}
function finish(R){
  const S=R.S,I=R.I,r=S.round,vs=voters(R);
  const tot=S.slides.map((_,i)=>vs.reduce((a,v)=>a+((I[`vote_${r}_${i}_${v}`]||{}).n||0),0));
  const gain={},add=(u,n)=>{gain[u]=(gain[u]||0)+n};
  add(S.presenter,tot.reduce((a,b)=>a+b,0));
  const who=I['fav_'+r].who;add({photo:S.picker,theme:S.themer,title:S.titler}[who],10);
  const b=tot.indexOf(Math.max(...tot));add(S.slides[b].o,5);if(S.title&&S.title.slide===b)add(S.titler,5);
  for(const u in gain)S.scores[u]=(S.scores[u]||0)+gain[u];
  Object.assign(S,{phase:'results',result:{gain,best:b,who}});
}
function check(R){
  const S=R.S,I=R.I,r=S.round;
  if(S.phase==='setup'&&I['pick_'+r]&&I['theme_'+r])Object.assign(S,{phase:'title',slides:I['pick_'+r].slides,theme:I['theme_'+r].text});
  else if(S.phase==='title'&&I['title_'+r])Object.assign(S,{phase:'present',slideIdx:0,title:I['title_'+r]});
  else if(S.phase==='present'){const i=S.slideIdx;if(I[`adv_${r}_${i}`]&&voters(R).every(v=>I[`vote_${r}_${i}_${v}`]))step(R)}
  else if(S.phase==='fav'&&I['fav_'+r])finish(R);
}
function handle(R,pid,m){
  const S=R.S,I=R.I,r=S.round,me=R.players[pid],host=pid===R.host;
  switch(m.t){
    case 'photo':{const d=m.data;if(me.photos.length<3&&typeof d==='string'&&d.startsWith('data:image/jpeg;base64,')&&d.length<300000){const id=pid+'_'+(++R.n);R.ph[id]=d;me.photos.push(id);for(const q in R.players)send(R.players[q].ws,{t:'ph',id,data:d})}break}
    case 'clear':if(S.phase==='lobby'){me.photos=[]}break;
    case 'start':if(host&&S.phase==='lobby'){const ids=Object.keys(R.players);if(ids.length>=3){S.order=ids.sort(()=>Math.random()-.5);S.scores={};Object.assign(S,round0(0,S.order));R.I={}}}break;
    case 'pick':if(S.phase==='setup'&&pid===S.picker&&Array.isArray(m.slides)&&m.slides.length>=1&&m.slides.length<=5&&m.slides.every(s=>s.o!==S.presenter&&R.players[s.o]&&R.players[s.o].photos[s.i]))I['pick_'+r]={slides:m.slides.map(s=>({o:s.o,i:s.i}))};break;
    case 'theme':if(S.phase==='setup'&&pid===S.themer&&txt(m.text,60))I['theme_'+r]={text:txt(m.text,60)};break;
    case 'title':if(S.phase==='title'&&pid===S.titler&&txt(m.text,40)&&S.slides[m.slide])I['title_'+r]={slide:m.slide,text:txt(m.text,40)};break;
    case 'vote':if(S.phase==='present'&&voters(R).includes(pid)&&m.n>=1&&m.n<=5)I[`vote_${r}_${S.slideIdx}_${pid}`]={n:m.n|0};break;
    case 'adv':if(S.phase==='present'&&pid===S.presenter)I[`adv_${r}_${S.slideIdx}`]={t:1};break;
    case 'skip':if(S.phase==='present'&&host)step(R);break;
    case 'fav':if(S.phase==='fav'&&pid===S.presenter&&['photo','theme','title'].includes(m.who))I['fav_'+r]={who:m.who};break;
    case 'next':if(S.phase==='results'&&host){if(r+1<S.order.length)Object.assign(S,round0(r+1,S.order));else S.phase='end'}break;
  }
}
wss.on('connection',ws=>{
  let R=null,pid=null;
  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw)}catch{return}
    if(m.t==='create'||m.t==='join'){
      pid=txt(m.pid,40);if(!pid)return;
      if(m.t==='create'){let c;do{c=Array.from({length:4},()=>'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random()*24|0]).join('')}while(rooms[c]);
        R=rooms[c]={code:c,host:pid,players:{},S:{phase:'lobby',round:0,scores:{},order:[]},I:{},ph:{},n:0,made:Date.now()}}
      else{R=rooms[txt(m.code,4).toUpperCase()];if(!R)return send(ws,{t:'err',msg:'No room with that code.'})}
      const p=R.players[pid]||(R.players[pid]={photos:[]});p.name=txt(m.name,14)||'Player';p.ws=ws;
      for(const id in R.ph)send(ws,{t:'ph',id,data:R.ph[id]});
      return broadcast(R);
    }
    if(!R||!R.players[pid])return;
    handle(R,pid,m);check(R);broadcast(R);
  });
});
setInterval(()=>{for(const c in rooms)if(Date.now()-rooms[c].made>6*36e5)delete rooms[c]},6e5);
srv.listen(process.env.PORT||3000,()=>console.log('Slide Sabotage running'));
