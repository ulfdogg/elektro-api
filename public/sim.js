'use strict';
// Elektro-Simulator — Spannungsausbreitung im Schaltplan
(function(global){

const PE=1, N=2, L1=4, L2=8, L3=16, ANY_L=4|8|16;

// Mehr als 1 Phase im selben Knoten → Phasenkurzschluss
const hasLLFault = dp => { const p=dp&ANY_L; return !!(p&(p-1)); };

// --- Union-Find ---
function makeUF(n){
  const p=new Int32Array(n).map((_,i)=>i);
  const find=x=>{while(p[x]!==x){p[x]=p[p[x]];x=p[x];}return x;};
  const union=(a,b)=>{a=find(a);b=find(b);if(a!==b)p[b]=a;};
  return{find,union};
}

// --- Port-Index: "compId:portIndex" → flat-Nummer ---
function buildIdx(comps){
  const idx={};let k=0;
  for(const c of comps)
    for(let i=0;i<c.def.ports.length;i++)
      idx[c.id+':'+i]=k++;
  return{idx,k};
}

function lbl(comp,l){return comp.def.ports.findIndex(p=>p.label===l);}

// --- Bauteile verschalten (je nach Zustand) ---
function connectComponents(comps,wires,simSt,uf,idx){
  const G=(id,i)=>idx[id+':'+i]??-1;
  const U=(a,b)=>{if(a>=0&&b>=0)uf.union(a,b);};

  for(const w of wires) U(G(w.fid,w.fp), G(w.tid,w.tp));

  for(const c of comps){
    const s=simSt[c.id]||{};
    const P=i=>G(c.id,i);
    switch(c.type){
      case'ls1':
        if(s.on!==false&&!s.tripped){ U(P(0),P(1)); } break;
      case'rcbo': // 2TE 1P+N: L(0)→L'(1), N(2)→N'(3)
        if(s.on!==false&&!s.tripped){ U(P(0),P(1)); U(P(2),P(3)); } break;
      case'ls3':
        if(s.on!==false&&!s.tripped){ U(P(0),P(3)); U(P(1),P(4)); U(P(2),P(5)); } break;
      case'rcd2':
        if(s.on!==false&&!s.tripped){ U(P(0),P(2)); U(P(1),P(3)); } break;
      case'rcd4':
        if(s.on!==false&&!s.tripped){ for(let i=0;i<4;i++) U(P(i),P(i+4)); } break;
      case'schalter':
        if(s.closed!==false) U(P(0),P(1)); break;
      case'wechsel':
        U(P(0), P(s.pos||1)); break;
      case'kreuzschalter':
        if(!s.crossed){ U(P(0),P(2)); U(P(1),P(3)); }
        else           { U(P(0),P(3)); U(P(1),P(2)); }
        break;
      case'serienschalter':
        if(s.on1!==false) U(P(0),P(1));
        if(s.on2!==false) U(P(0),P(2));
        break;
      case'taster':
        if(s.pressed) U(P(0),P(1)); break;
      case'stromstoss':
        if(s.on) U(P(1),P(4));   // NO 13-14 geschlossen
        else     U(P(2),P(5));   // NC 21-22 geschlossen
        break;
      case'schuetz':
        if(s.coilOn){
          U(P(0),P(3)); U(P(1),P(4)); U(P(2),P(5));
          U(P(6),P(7)); U(P(12),P(13));
        } else {
          U(P(8),P(9)); U(P(10),P(11));
        }
        break;
      case'bewegungsmelder':
        if(s.triggered) U(P(0),P(2)); break;
      case'cable3':
        U(P(0),P(3)); U(P(1),P(4)); U(P(2),P(5)); break;
      case'cable5':
        for(let i=0;i<5;i++) U(P(i),P(i+5)); break;
      case'knotenpunkt': case'klemme': case'klemme25':
      case'nblock': case'peblock':
      case'wago2': case'wago3': case'wago5':
        for(let i=1;i<c.def.ports.length;i++) U(P(0),P(i)); break;
    }
  }
  // PE-Klemmen (grün-gelb) auf derselben Hutschiene → PE-Busschiene
  const railBus={};
  for(const c of comps){
    if((c.type==='klemme'||c.type==='klemme25')&&c.railId!=null&&c.state&&c.state.color==='#16a34a'){
      const k=c.railId+':'+c.state.color;
      (railBus[k]||(railBus[k]=[])).push(c);
    }
  }
  for(const grp of Object.values(railBus)){
    if(grp.length<2) continue;
    const a=G(grp[0].id,0);
    for(let i=1;i<grp.length;i++) U(a,G(grp[i].id,0));
  }
}

// --- Drehrichtung: Rechtsdrehfeld L1→L2→L3 vorausgesetzt ---
// Zykl. Permutationen an U1/V1/W1 → Rechtslauf: L1-L2-L3, L2-L3-L1, L3-L1-L2
// Odd-Permutationen                → Linkslauf:  L1-L3-L2, L3-L2-L1, L2-L1-L3
// Potentiale: PE=1, N=2, L1=4, L2=8, L3=16
function motorDir(p0,p1,p2){
  p0&=ANY_L; p1&=ANY_L; p2&=ANY_L;
  if(!(p0&&p1&&p2&&p0!==p1&&p1!==p2&&p0!==p2)) return null;
  const cw=(p0===L1&&p1===L2&&p2===L3)||(p0===L2&&p1===L3&&p2===L1)||(p0===L3&&p1===L1&&p2===L2);
  return cw?'cw':'ccw';
}

// --- Schaltungsart und Richtung für Asyncronmotor bestimmen ---
// pU1/pV1/pW1 = Potential an U1,V1,W1 (Klemmen-Anfänge)
// pU2/pV2/pW2 = Potential an U2,V2,W2 (Klemmen-Enden)
function motorCheck(pU1,pV1,pW1,pU2,pV2,pW2){
  const bU1=pU1&ANY_L, bV1=pV1&ANY_L, bW1=pW1&ANY_L;
  const bU2=pU2&ANY_L, bV2=pV2&ANY_L, bW2=pW2&ANY_L;

  // Fall A: Einspeisung auf U1/V1/W1 (Stern oder Dreieck)
  const dir=motorDir(pU1,pV1,pW1);
  if(dir){
    let conn=null;
    // Dreieck: U1↔W2, V1↔U2, W1↔V2 (gleiche UF-Gruppe → gleiches Potential)
    if(bU1&&bU1===bW2&&bV1===bU2&&bW1===bV2) conn='Δ';
    // Stern: U2/V2/W2 kein L-Potential (floatender Sternpunkt)
    else if(!bU2&&!bV2&&!bW2) conn='Y';
    return{dir,conn};
  }

  // Fall B: Einspeisung auf U2/V2/W2 (umgekehrter Stern)
  // Strom fließt rückwärts durch die Wicklungen → Drehrichtung invertiert
  if(bU1===bV1&&bV1===bW1){ // U1/V1/W1 alle gleichpotential (gebrückter Sternpunkt)
    const rd=motorDir(pU2,pV2,pW2);
    if(rd) return{dir:rd==='cw'?'ccw':'cw',conn:'Y↑'};
  }
  return{dir:null,conn:null};
}

// --- Hauptfunktion ---
function simulate(comps, wires, simSt, _depth){
  const depth=_depth||0;
  if(depth>8) return{state:simSt,portPot:{},faults:[]};

  const{idx,k}=buildIdx(comps);
  if(!k) return{state:simSt,portPot:{},faults:[]};

  const uf=makeUF(k);
  connectComponents(comps,wires,simSt,uf,idx);

  // Spannungsquellen
  const pot=new Int32Array(k);
  for(const c of comps){
    if(c.type==='cee16_kupplung'){
      const pm=[L1,L2,L3,N,PE]; // port0=L1, port1=L2, port2=L3, port3=N, port4=PE
      for(let i=0;i<pm.length&&i<c.def.ports.length;i++){
        const p=idx[c.id+':'+i];
        if(p!=null) pot[uf.find(p)]|=pm[i];
      }
    }
  }

  const gp=(id,pi)=>{const p=idx[id+':'+pi];return p!=null?pot[uf.find(p)]:0;};

  // Rückkopplungen (Schütz, Stromstoß)
  const delta={};
  for(const c of comps){
    const s=simSt[c.id]||{};
    if(c.type==='schuetz'){
      const a1=lbl(c,'A1'), a2=lbl(c,'A2');
      const pa1=gp(c.id,a1), pa2=gp(c.id,a2);
      const coilOn=!!((pa1&ANY_L)&&(pa2&N) || (pa2&ANY_L)&&(pa1&N));
      if(coilOn!==!!s.coilOn) delta[c.id]={...s,coilOn};
    }
    if(c.type==='stromstoss'){
      const a1i=lbl(c,'A1');
      const now=!!(gp(c.id,a1i)&ANY_L), was=!!s.a1Was;
      let on=!!s.on;
      if(now&&!was) on=!on;
      if(on!==!!s.on || now!==was) delta[c.id]={...s,on,a1Was:now};
    }
  }

  if(Object.keys(delta).length)
    return simulate(comps, wires, {...simSt,...delta}, depth+1);

  // Verbraucher
  const result={...simSt};
  for(const c of comps){
    const s=simSt[c.id]||{};
    if(c.type==='lampe'||c.type==='spot'){
      const p0=gp(c.id,0), p1=gp(c.id,1);
      result[c.id]={...s, lit:!!((p0&ANY_L)&&(p1&N) || (p1&ANY_L)&&(p0&N))};
    }
    if(c.type==='motor'){
      // Motor: U1=port0, V1=port1, W1=port2, PE=port3, U2=port4, V2=port5, W2=port6
      const{dir,conn}=motorCheck(gp(c.id,0),gp(c.id,1),gp(c.id,2),
                                  gp(c.id,4),gp(c.id,5),gp(c.id,6));
      result[c.id]={...s,running:!!dir,direction:dir||null,connection:conn,speed:null};
    }
    if(c.type==='dahlander'){
      // Dahlander: Stufe 2 (YY) = 1U/1V/1W (port0/1/2), Stufe 1 (Δ) = 2U/2V/2W (port3/4/5)
      let dir=motorDir(gp(c.id,0),gp(c.id,1),gp(c.id,2));
      let speed=null,conn=null;
      if(dir){
        speed=2;
        const b3=gp(c.id,3)&ANY_L,b4=gp(c.id,4)&ANY_L,b5=gp(c.id,5)&ANY_L;
        conn=(!b3&&!b4&&!b5)?'YY':'Δ-2';
      } else {
        dir=motorDir(gp(c.id,3),gp(c.id,4),gp(c.id,5));
        if(dir){speed=1;conn='Δ';}
      }
      result[c.id]={...s,running:!!dir,direction:dir||null,connection:conn,speed};
    }
  }

  // ── Fehlererkennung ────────────────────────────────────────────────────────
  // Kurzschluss L-N : Knoten hat L- und N-Potential gleichzeitig
  // Kurzschluss L-L : Knoten hat ≥2 L-Phasen gleichzeitig
  // Erdschluss  L-PE: Knoten hat L- und PE-Potential gleichzeitig
  // Geprüft wird die AUSGANGSSEITE des Schutzgeräts.

  const faults=[];
  function addFault(type,cause,id){
    if(!faults.some(f=>f.id===id)) faults.push({type,cause,id});
  }

  for(const c of comps){
    const s=simSt[c.id]||{};
    if(s.tripped) continue;

    // LS 1-polig / RCBO
    if(c.type==='ls1' && s.on!==false){
      const dp=gp(c.id,1);
      if((dp&ANY_L)&&(dp&N))  addFault('ls_trip','L-N Kurzschluss',c.id);
      if((dp&ANY_L)&&(dp&PE)) addFault('ls_trip','Erdschluss',c.id);
      if(hasLLFault(dp))      addFault('ls_trip','L-L Kurzschluss',c.id);
    }
    if(c.type==='rcbo' && s.on!==false){
      // Ausgangsports: L'=Port1, N'=Port3
      const dpL=gp(c.id,1), dpN=gp(c.id,3);
      if((dpL&ANY_L)&&(dpL&N))  addFault('ls_trip','L-N Kurzschluss',c.id);
      if((dpL&ANY_L)&&(dpL&PE)) addFault('ls_trip','Erdschluss',c.id);
      if(hasLLFault(dpL))       addFault('ls_trip','L-L Kurzschluss',c.id);
      // N-Leiter berührt PE: Erdschluss
      if((dpN&N)&&(dpN&PE))     addFault('fi_trip','N-PE Verbindung',c.id);
    }

    // LS 3-polig
    if(c.type==='ls3' && s.on!==false){
      for(let i=3;i<=5;i++){
        const dp=gp(c.id,i);
        if((dp&ANY_L)&&(dp&N)) { addFault('ls_trip','L-N Kurzschluss',c.id); break; }
        if(hasLLFault(dp))     { addFault('ls_trip','L-L Kurzschluss',c.id); break; }
      }
    }

    // FI 2-polig (L-out=Port2, N-out=Port3)
    if(c.type==='rcd2' && s.on!==false){
      const dpL=gp(c.id,2), dpN=gp(c.id,3);
      if((dpL&ANY_L)&&(dpL&PE))      addFault('fi_trip','Erdschluss',c.id);
      else if((dpN&N)&&(dpN&PE))     addFault('fi_trip','N-PE Verbindung',c.id);
      else if((dpN&ANY_L)&&(dpN&PE)) addFault('fi_trip','Erdschluss',c.id);
      else if((dpL&ANY_L)&&(dpL&N))  addFault('fi_trip','L-N Kurzschluss',c.id);
    }

    // FI 4-polig (Ausgangsports 4-7: L1-out, L2-out, L3-out, N-out)
    if(c.type==='rcd4' && s.on!==false){
      // N-PE Verbindung: N-Leiter berührt PE ohne L-Phase → Fehlerstrom über PE
      const dpN=gp(c.id,7);
      if((dpN&N)&&(dpN&PE)){ addFault('fi_trip','N-PE Verbindung',c.id); }
      else {
        for(let i=4;i<=7;i++){
          const dp=gp(c.id,i);
          if((dp&ANY_L)&&(dp&PE)){ addFault('fi_trip','Erdschluss',c.id); break; }
          if((dp&ANY_L)&&(dp&N)) { addFault('fi_trip','L-N Kurzschluss',c.id); break; }
        }
      }
    }
  }

  // Port-Potential-Map (auch Fehlerknoten markieren)
  const portPot={};
  for(const c of comps)
    for(let i=0;i<c.def.ports.length;i++){
      const p=idx[c.id+':'+i];
      portPot[c.id+':'+i]=p!=null?pot[uf.find(p)]:0;
    }

  return{state:result, portPot, faults};
}

global.ElektroSim={simulate, ANY_L, POT_N:N, POT_PE:PE};
})(window);
