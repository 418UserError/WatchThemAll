/**
 * WatchThemAll — Button Injection Script
 * Injected via webContents.executeJavaScript on every navigation.
 * Self-rebuilds via MutationObserver for SPA pages (CinemaOS etc.)
 */
(function() {
  // Guard against double injection
  if (document.getElementById('wta-prev-ep')) return;

  // CSS
  var s = document.createElement('style');
  s.id = 'wta-style';
  s.textContent = '.wta-btn{position:fixed;z-index:2147483647;display:flex;align-items:center;justify-content:center;gap:6px;background:rgba(15,15,25,0.62);backdrop-filter:blur(14px) saturate(140%);-webkit-backdrop-filter:blur(14px) saturate(140%);border:1px solid rgba(255,255,255,0.07);border-radius:10px;cursor:pointer;user-select:none;opacity:0.32;transition:opacity 200ms ease,background 200ms ease,transform 160ms ease;padding:6px 12px;color:#fff;font-family:system-ui,sans-serif;font-size:12px;font-weight:600;min-width:60px;height:34px}.wta-btn:hover{opacity:1;background:rgba(12,12,22,0.90);border-color:rgba(255,255,255,0.15);box-shadow:0 0 20px rgba(0,0,0,0.4),0 0 40px rgba(99,102,241,0.06);transform:scale(1.03)}.wta-btn:active{transform:scale(0.95)}';
  document.head.appendChild(s);

  // Parse URL
  var url = new URL(window.location.href);
  var p = null;
  var id = url.searchParams.get('imdb') || url.searchParams.get('id') || url.searchParams.get('video_id');
  if (id) {
    var se = parseInt(url.searchParams.get('season')||url.searchParams.get('s')||url.searchParams.get('se'));
    var ep = parseInt(url.searchParams.get('episode')||url.searchParams.get('e')||url.searchParams.get('ep'));
    p = { id: id, s: isNaN(se)?1:se, e: isNaN(ep)?1:ep, mode: 'query' };
  } else {
    var parts = url.pathname.split('/').filter(Boolean);
    for (var i = 0; i < parts.length && !p; i++) {
      if (/^tt\d{7,}$/.test(parts[i]) && i+2 < parts.length) {
        var sn = parseInt(parts[i+1]), en = parseInt(parts[i+2]);
        if (!isNaN(sn) && !isNaN(en)) p = { id: parts[i], s: sn, e: en, mode: 'path', parts: parts, idx: i };
      }
    }
    for (var j = 0; j < parts.length && !p; j++) {
      var m = parts[j].match(/^(tt\d{7,}|\d+)-(\d+)-(\d+)$/);
      if (m) p = { id: m[1], s: parseInt(m[2]), e: parseInt(m[3]), mode: 'hyphen', parts: parts, idx: j };
    }
    if (!p) {
      for (var k = 0; k < parts.length; k++) {
        if (/^tt\d{7,}$/.test(parts[k])) { p = { id: parts[k], s: 0, e: 0, mode: 'movie' }; break; }
      }
    }
  }
  if (!p) return;

  var curS = p.s || 1, curE = p.e || 1;

  function go(season, episode) {
    if (p.mode === 'query') {
      var next = new URL(window.location.href);
      var sk = url.searchParams.has('season')?'season':(url.searchParams.has('s')?'s':'se');
      var ek = url.searchParams.has('episode')?'episode':(url.searchParams.has('e')?'e':'ep');
      next.searchParams.set(sk, String(season));
      next.searchParams.set(ek, String(episode));
      window.location.assign(next.toString());
    } else if (p.mode === 'hyphen') {
      var hp = p.parts.slice();
      hp[p.idx] = p.id + '-' + season + '-' + episode;
      window.location.assign(url.origin + '/' + hp.join('/') + url.search);
    } else if (p.mode === 'path') {
      var pp = p.parts.slice();
      pp[p.idx+1] = String(season);
      pp[p.idx+2] = String(episode);
      window.location.assign(url.origin + '/' + pp.join('/') + url.search);
    }
  }

  function btn(id, text, style, click) {
    if (document.getElementById(id)) return;
    var b = document.createElement('div');
    b.id = id; b.className = 'wta-btn'; b.textContent = text;
    for (var k in style) b.style[k] = style[k];
    b.addEventListener('click', function(e) { e.stopPropagation(); e.preventDefault(); click(); });
    document.body.appendChild(b);
  }

  btn('wta-prev-ep', '\u25C0 Ep ' + (curE>1?curE-1:'?'), { left:'12px', top:'50%', marginTop:'-17px' }, function() {
    if (curE > 1) go(curS, curE-1); else if (curS > 1) go(curS-1, 99);
  });
  btn('wta-next-ep', 'Ep ' + (curE+1) + ' \u25B6', { right:'12px', top:'50%', marginTop:'-17px' }, function() { go(curS, curE+1); });
  btn('wta-prev-season', '\u25B2 S' + (curS>1?curS-1:'?'), { top:'12px', left:'50%', transform:'translateX(-50%)' }, function() {
    if (curS > 1) go(curS-1, 1);
  });
  btn('wta-next-season', 'S' + (curS+1) + ' \u25BC', { bottom:'12px', left:'50%', transform:'translateX(-50%)' }, function() {
    go(curS+1, 1);
  });
})();

// ═══════════════════════════════════════════════════════════════
// SPA rebuild observer — CinemaOS and similar frameworks replace
// the entire DOM. When buttons disappear, re-inject.
// ═══════════════════════════════════════════════════════════════
(function() {
  new MutationObserver(function() {
    if (document.getElementById('wta-prev-ep')) return;
    if (!document.getElementById('wta-style')) {
      var s = document.createElement('style');
      s.id = 'wta-style';
      s.textContent = document.currentScript ? '' : '';
      document.head.appendChild(s);
    }
    // Re-run the button creation above — we have to re-parse the URL
    // since it may have changed (SPA navigation)
    var url = new URL(window.location.href);
    var p = null;
    var id = url.searchParams.get('imdb') || url.searchParams.get('id') || url.searchParams.get('video_id');
    if (id) {
      var se = parseInt(url.searchParams.get('season')||url.searchParams.get('s')||url.searchParams.get('se'));
      var ep = parseInt(url.searchParams.get('episode')||url.searchParams.get('e')||url.searchParams.get('ep'));
      p = { id: id, s: isNaN(se)?1:se, e: isNaN(ep)?1:ep, mode: 'query' };
    } else {
      var parts = url.pathname.split('/').filter(Boolean);
      for (var i = 0; i < parts.length && !p; i++) {
        if (/^tt\d{7,}$/.test(parts[i]) && i+2 < parts.length) {
          var sn = parseInt(parts[i+1]), en = parseInt(parts[i+2]);
          if (!isNaN(sn) && !isNaN(en)) p = { id: parts[i], s: sn, e: en, mode: 'path', parts: parts, idx: i };
        }
      }
      for (var j = 0; j < parts.length && !p; j++) {
        var m = parts[j].match(/^(tt\d{7,}|\d+)-(\d+)-(\d+)$/);
        if (m) p = { id: m[1], s: parseInt(m[2]), e: parseInt(m[3]), mode: 'hyphen', parts: parts, idx: j };
      }
      if (!p) {
        for (var k = 0; k < parts.length; k++) {
          if (/^tt\d{7,}$/.test(parts[k])) { p = { id: parts[k], s: 0, e: 0, mode: 'movie' }; break; }
        }
      }
    }
    if (!p) return;

    var curS = p.s || 1, curE = p.e || 1;
    function go(season, episode) {
      if (p.mode === 'query') {
        var next = new URL(window.location.href);
        var sk = url.searchParams.has('season')?'season':(url.searchParams.has('s')?'s':'se');
        var ek = url.searchParams.has('episode')?'episode':(url.searchParams.has('e')?'e':'ep');
        next.searchParams.set(sk, String(season));
        next.searchParams.set(ek, String(episode));
        window.location.assign(next.toString());
      } else if (p.mode === 'hyphen') {
        var hp = p.parts.slice();
        hp[p.idx] = p.id + '-' + season + '-' + episode;
        window.location.assign(url.origin + '/' + hp.join('/') + url.search);
      } else if (p.mode === 'path') {
        var pp = p.parts.slice();
        pp[p.idx+1] = String(season);
        pp[p.idx+2] = String(episode);
        window.location.assign(url.origin + '/' + pp.join('/') + url.search);
      }
    }
    function btn(id, text, style, click) {
      if (document.getElementById(id)) return;
      var b = document.createElement('div');
      b.id = id; b.className = 'wta-btn'; b.textContent = text;
      for (var k in style) b.style[k] = style[k];
      b.addEventListener('click', function(e) { e.stopPropagation(); e.preventDefault(); click(); });
      document.body.appendChild(b);
    }
    btn('wta-prev-ep', '\u25C0 Ep ' + (curE>1?curE-1:'?'), { left:'12px', top:'50%', marginTop:'-17px' }, function() {
      if (curE > 1) go(curS, curE-1); else if (curS > 1) go(curS-1, 99);
    });
    btn('wta-next-ep', 'Ep ' + (curE+1) + ' \u25B6', { right:'12px', top:'50%', marginTop:'-17px' }, function() { go(curS, curE+1); });
    btn('wta-prev-season', '\u25B2 S' + (curS>1?curS-1:'?'), { top:'12px', left:'50%', transform:'translateX(-50%)' }, function() {
      if (curS > 1) go(curS-1, 1);
    });
    btn('wta-next-season', 'S' + (curS+1) + ' \u25BC', { bottom:'12px', left:'50%', transform:'translateX(-50%)' }, function() {
      go(curS+1, 1);
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
