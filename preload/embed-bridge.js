/**
 * WatchThemAll — Embed Bridge
 * Creates 5 edge navigation buttons + reload. Survives SPA DOM replacement.
 */

// ── CSS (injected once, survives DOM wipes via ID check) ──────
function ensureCSS() {
  if (document.getElementById('wta-css')) return;
  var s = document.createElement('style');
  s.id = 'wta-css';
  s.textContent = '.wta-btn{position:fixed;z-index:2147483647;display:flex;align-items:center;justify-content:center;gap:6px;background:rgba(15,15,25,0.62);backdrop-filter:blur(14px) saturate(140%);-webkit-backdrop-filter:blur(14px) saturate(140%);border:1px solid rgba(255,255,255,0.07);border-radius:10px;cursor:pointer;user-select:none;opacity:0.32;transition:opacity 200ms ease,background 200ms ease,transform 160ms ease;padding:6px 12px;color:#fff;font-family:system-ui,sans-serif;font-size:12px;font-weight:600;min-width:60px;height:34px}.wta-btn:hover{opacity:1;background:rgba(12,12,22,0.90);border-color:rgba(255,255,255,0.15);box-shadow:0 0 20px rgba(0,0,0,0.4),0 0 40px rgba(99,102,241,0.06);transform:scale(1.03)}.wta-btn:active{transform:scale(0.95)}';
  document.head.appendChild(s);
}

// ── URL parsing ───────────────────────────────────────────────
function parseUrl() {
  var url = new URL(window.location.href);
  var p = null;
  var id = url.searchParams.get('imdb') || url.searchParams.get('id') || url.searchParams.get('video_id');
  if (id) {
    var s = parseInt(url.searchParams.get('season')||url.searchParams.get('s')||url.searchParams.get('se'));
    var e = parseInt(url.searchParams.get('episode')||url.searchParams.get('e')||url.searchParams.get('ep'));
    return { id:id, s:isNaN(s)?1:s, e:isNaN(e)?1:e, mode:'query' };
  }
  var parts = url.pathname.split('/').filter(Boolean);
  for (var i=0; i<parts.length; i++) {
    if (/^tt\d{7,}$/.test(parts[i]) && i+2<parts.length) {
      var sn=parseInt(parts[i+1]), en=parseInt(parts[i+2]);
      if (!isNaN(sn)&&!isNaN(en)) return { id:parts[i], s:sn, e:en, mode:'path', parts:parts, idx:i };
    }
  }
  for (var k=0; k<parts.length; k++) {
    if (/^\d+$/.test(parts[k]) && k+2<parts.length) {
      var tn=parseInt(parts[k+1]), un=parseInt(parts[k+2]);
      if (!isNaN(tn)&&!isNaN(un) && tn<100 && un<1000) return { id:parts[k], s:tn, e:un, mode:'path', parts:parts, idx:k };
    }
  }
  for (var j=0; j<parts.length; j++) {
    var m=parts[j].match(/^(tt\d{7,}|\d+)-(\d+)-(\d+)$/);
    if (m) return { id:m[1], s:parseInt(m[2]), e:parseInt(m[3]), mode:'hyphen', parts:parts, idx:j };
  }
  return null;
}

// ── Button creation ───────────────────────────────────────────
function createButtons() {
  if (document.getElementById('wta-prev-ep')) return;
  if (!document.body) return;

  var p = parseUrl();
  if (!p) return;
  var s = p.s||1, e = p.e||1;

  ensureCSS();

  function nav(ns, ne) {
    var url = new URL(window.location.href);
    if (p.mode==='query') {
      var sk=url.searchParams.has('season')?'season':(url.searchParams.has('s')?'s':'se');
      var ek=url.searchParams.has('episode')?'episode':(url.searchParams.has('e')?'e':'ep');
      url.searchParams.set(sk, String(ns));
      url.searchParams.set(ek, String(ne));
      window.location.assign(url.toString());
    } else if (p.mode==='hyphen') {
      var hp=p.parts.slice(); hp[p.idx]=p.id+'-'+ns+'-'+ne;
      window.location.assign(url.origin+'/'+hp.join('/')+url.search);
    } else if (p.mode==='path') {
      var pp=p.parts.slice(); pp[p.idx+1]=String(ns); pp[p.idx+2]=String(ne);
      window.location.assign(url.origin+'/'+pp.join('/')+url.search);
    }
  }

  function btn(id, text, style, click) {
    var b = document.createElement('div');
    b.id = id; b.className = 'wta-btn'; b.textContent = text;
    for (var k in style) b.style[k] = style[k];
    b.addEventListener('click', function(e){ e.stopPropagation(); e.preventDefault(); click(); });
    document.body.appendChild(b);
  }

  btn('wta-prev-ep', '\u25C0 Ep '+(e>1?e-1:'?'), {left:'12px',top:'50%',marginTop:'-17px'}, function(){ if(e>1)nav(s,e-1); else if(s>1)nav(s-1,99); });
  btn('wta-next-ep', 'Ep '+(e+1)+' \u25B6', {right:'12px',top:'50%',marginTop:'-17px'}, function(){ nav(s,e+1); });
  btn('wta-prev-s', '\u25B2 S'+(s>1?s-1:'?'), {top:'12px',left:'50%',transform:'translateX(-50%)'}, function(){ if(s>1)nav(s-1,1); });
  btn('wta-next-s', 'S'+(s+1)+' \u25BC', {bottom:'12px',left:'50%',transform:'translateX(-50%)'}, function(){ nav(s+1,1); });
  btn('wta-reload', '\u21BB', {right:'12px',bottom:'12px',width:'34px',height:'34px',minWidth:'34px',borderRadius:'50%',fontSize:'16px',padding:'0'}, function(){ window.location.reload(); });
}

// ── Bootstrap ─────────────────────────────────────────────────
function boot() {
  createButtons();
  if (!document.getElementById('wta-prev-ep')) setTimeout(createButtons, 300);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// ── SPA survival (debounced) ──────────────────────────────────
var rebuildTimer = null;
new MutationObserver(function() {
  if (!document.getElementById('wta-prev-ep')) {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(function() {
      createButtons();
      if (!document.getElementById('wta-prev-ep')) setTimeout(createButtons, 500);
    }, 300);
  }
}).observe(document.documentElement, { childList: true, subtree: true });
