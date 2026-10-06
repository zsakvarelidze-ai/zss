/* ----------------------------------------------------------------------------
 * ZSS — the Atlas, on real tiles.
 *
 * Only the self-hosted build loads this. A published artifact runs under a policy
 * that blocks every image and every network request bar scripts from four CDNs, so
 * a map tile never arrives there and the page keeps its drawn vector basemap.
 * Served from anywhere else, there is no such policy, and the same register can sit
 * on OpenStreetMap, topography or satellite imagery.
 *
 * This replaces the map surface and nothing else. The descent — continents, then
 * regions, then countries, one segment of the code per click — is the page's own
 * logic: goto() still drives it, and only paintWorld, fitGroup, drawCountry and
 * selectCountry are swapped for versions that speak to Leaflet instead of SVG.
 * -------------------------------------------------------------------------- */
(function () {
  if (typeof L === 'undefined') return;          // no Leaflet: the SVG atlas stays

  /* ---- data ---------------------------------------------------------------
     Country files are classic scripts, not fetch(): a page opened from file://
     is refused every fetch by CORS, while a script tag beside it still loads. */
  var WORLD = null, ENV = null, ENVS = {}, BR = {}, pending = {}, NAME = {};
  var OWN = {}, ownGrp = null, ownTried = {};      // hand-traced settlement outlines, data/own/<country>.js
  // Envelope width is a display choice. '' is twelve nautical miles -- the territorial sea, a line
  // with a meaning. '100' is a hundred kilometres: a drawing, and the page says so. The 'outline'
  // mode draws each row as ONE closed shape, land and sea and islands inside a single outer line,
  // the way a reader sees a country; 'band' shows the sea as a pale fringe with the coast as the edge.
  var ENV_W = '', ENV_MODE = 'band';
  // Outlines: the thing you are looking at as ONE closed shape (land + envelope), its parts coloured
  // inside. World view: seven continents. Inside a continent: that continent, one line, regions
  // coloured within. Inside a region: that region, one line, countries within. (Owner, 21 Sep.)
  var OUT = null, OUTS = {};
  window.ZSSO = { load: function (d) { var w = d.__w || ''; delete d.__w; OUTS[w] = d; if (w === ENV_W) { OUT = d; if (map) repaintAll(); } } };
  // envelope colour: the row's own hue, or one colour for all
  var ENV_COL = 'match', ENV_ONE = '#7aa2ff';
  function envColor(fill) { return ENV_COL === 'one' ? ENV_ONE : fill; }
  // The "screen" look (owner, 22 Sep 2026): the same register drawn as an operations screen --
  // no basemap, a dark glass, a graticule, one glowing line around the thing you are looking at,
  // monospace captions, scanlines and a reflection over the glass, a reticle that locks on the
  // row under the pointer. Three hues. Nothing about the data changes; only the dress.
  var THEME = 'atlas';
  var SCREEN = { green: { hue: '#39ff9a', bg: '#03110c', land: '#0f4a34' },
                 cyan:  { hue: '#4de3ff', bg: '#020a14', land: '#0e3050' },
                 amber: { hue: '#ffb84d', bg: '#120c03', land: '#4a2e0a' } };
  function screen() { return THEME !== 'atlas'; }
  function screenHue() { return SCREEN[THEME].hue; }
  var gratGrp = null, gratRend = null, reticle = null, overlay = null, hudEl = null;
  function setTheme(t) {
    THEME = SCREEN[t] ? t : 'atlas';
    var el = map.getContainer();
    el.classList.toggle('zss-screen', screen());
    if (screen()) {
      el.style.setProperty('--zss-hue', SCREEN[THEME].hue); el.style.setProperty('--zss-bg', SCREEN[THEME].bg);
      if (tiles && map.hasLayer(tiles)) map.removeLayer(tiles);
      if (!gratGrp) {
        map.createPane('grat').style.zIndex = 350;                 // under the data, over the (absent) tiles
        gratRend = L.canvas({ pane: 'grat', padding: 0.3 });
        gratGrp = L.layerGroup();
      }
      gratGrp.clearLayers();
      for (var lon = -180; lon <= 180; lon += 15) gratGrp.addLayer(L.polyline([[-85, lon], [85, lon]], { renderer: gratRend, color: screenHue(), weight: lon % 90 ? .6 : 1, opacity: lon % 90 ? .12 : .22, interactive: false }));
      for (var lat = -75; lat <= 75; lat += 15) gratGrp.addLayer(L.polyline([[lat, -540], [lat, 540]], { renderer: gratRend, color: screenHue(), weight: lat ? .6 : 1, opacity: lat ? .12 : .22, interactive: false }));
      if (!map.hasLayer(gratGrp)) gratGrp.addTo(map);
      if (!overlay) {
        overlay = document.createElement('div'); overlay.className = 'zss-overlay';
        overlay.innerHTML = '<i class="c1"></i><i class="c2"></i><i class="c3"></i><i class="c4"></i>';
        hudEl = document.createElement('div'); hudEl.className = 'zss-hud'; overlay.appendChild(hudEl);
        el.appendChild(overlay);
      }
      overlay.style.display = '';
    } else {
      if (tiles && !map.hasLayer(tiles)) tiles.addTo(map);
      if (gratGrp && map.hasLayer(gratGrp)) map.removeLayer(gratGrp);
      if (overlay) overlay.style.display = 'none';
      if (reticle && map.hasLayer(reticle)) map.removeLayer(reticle);
    }
  }
  function hideReticle() { if (reticle && map && map.hasLayer(reticle)) map.removeLayer(reticle); }
  function hudText(title, sub) {
    if (!hudEl) return;
    hudEl.innerHTML = '<b>ZSS // ' + title.replace(/</g, '&lt;') + '</b><span>' + sub.replace(/</g, '&lt;') + '</span>';
  }
  // the reticle: every layer with a tooltip locks it on while the pointer is over it
  (function () {
    var bt = L.Layer.prototype.bindTooltip;
    L.Layer.prototype.bindTooltip = function () {
      var r = bt.apply(this, arguments);
      this.on('mouseover mousemove', function (e) {
        if (!screen() || !e.latlng) return;
        if (!reticle) reticle = L.marker([0, 0], { icon: L.divIcon({ className: 'zss-reticle', iconSize: [44, 44], iconAnchor: [22, 22] }), interactive: false, keyboard: false, zIndexOffset: 1000 });
        reticle.setLatLng(e.latlng); if (!map.hasLayer(reticle)) reticle.addTo(map);
      });
      this.on('mouseout', function () { if (reticle && map.hasLayer(reticle)) map.removeLayer(reticle); });
      return r;
    };
  })();
  // Envelopes (decision 7): each row's twelve nautical miles of sea, derived from the land line,
  // cut where a neighbour's is nearer, never overlapping, never covering land. A pixel-sized
  // island becomes a visible shape; a region's envelope is the union of its countries'.
  window.ZSSE = { load: function (d) { var w = d.__w || ''; delete d.__w; ENVS[w] = d; if (w === ENV_W) { ENV = d; if (map) repaintAll(); } } };
  // whatever is open -- the world, a country's branch, a lone outline -- drawn again with the current choices
  function repaintAll() { if (!map) return; if (!curCode) paintTiles(); else if (curParent) openBranch(curParent, true); else if (QS.c) openCountryPage(QS.c); }
  function wantEnv(w) {
    ENV_W = w;
    ENV = ENVS[w] || null; OUT = OUTS[w] || null;
    if (ENVS[w] && OUTS[w]) { repaintAll(); return; }
    [['env', ENVS], ['out', OUTS]].forEach(function (k) {
      if (k[1][w]) return;
      var se = document.createElement('script');
      se.src = 'data/' + k[0] + w + '.js' + V;
      se.onerror = function () { if (w !== '') { ENV_W = ''; ENV = ENVS[''] || null; OUT = OUTS[''] || null; repaintAll(); } };
      document.head.appendChild(se);
    });
  }
  // Two pages share this file. The world page stops at L3 (decision 1, 20 Sep 2026): a click
  // on a country leaves for that country's own page, which is the same page with ?c=<code>,
  // and carries the descent into the country's tiers. Nothing inside a country is drawn on
  // the world map.
  var PAGE = window.ZSS_PAGE || 'world';
  // Every file this page fetches carries the build stamp the page was published with. A visitor
  // whose browser cached last week's tiles.js and world.js saw the United States drawn at
  // longitude 250 for a week after the fix was live (21 Sep 2026); the stamp makes that impossible.
  var V = window.ZSS_BUILD ? '?v=' + encodeURIComponent(window.ZSS_BUILD) : '';
  var QS = {}; location.search.replace(/^\?/, '').split('&').forEach(function (kv) {
    var i = kv.indexOf('='); if (i > 0) QS[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1)); });
  window.ZSSW = { load: function (d) { WORLD = d; boot(); } };
  window.ZSS = {
    // one file per parent: its children, and (at the deepest level) their settlements
    branch: function (d) {
      BR[d.code] = d;
      d.units.forEach(function (u) { NAME[u.c] = u.n; });
      var f = pending[d.code]; delete pending[d.code]; if (f) f(d);
    },
    load: function () {},                // the old one-file-per-country shape; no longer read
    // traced outlines (geometry/own in the register): licence own, asserted, drawn in their own stroke
    own: function (d) { OWN[d.code] = d; if (curCode === d.code) drawOwn(d.code); }
  };
  function drawOwn(country) {
    if (ownGrp) { map.removeLayer(ownGrp); ownGrp = null; }
    var d = OWN[country];
    if (!d) {
      if (ownTried[country]) return; ownTried[country] = true;
      var s = document.createElement('script'); s.src = 'data/own/' + country + '.js' + V; s.onerror = function () {}; document.head.appendChild(s); return;
    }
    ownGrp = L.layerGroup(d.units.reduce(function (acc, u) {
      unwrap(u.r.map(ringPts)).forEach(function (pts) {
        var q = L.polygon(pts, { renderer: rend, color: '#ff7a59', weight: 2, dashArray: '6 4', opacity: .95, fillColor: '#ff7a59', fillOpacity: .12, interactive: true });
        q.bindTooltip(u.n + ' \u00b7 ' + u.c + (u.b === 'osm' ? ' \u00b7 derived outline (OpenStreetMap, ODbL)' : ' \u00b7 traced outline (own)'), { sticky: true, className: 'ttip' });
        acc.push(q);
      });
      return acc;
    }, [])).addTo(map);
  }
  function wantBranch(code, cb) {
    if (BR[code]) { cb(BR[code]); return; }
    if (pending[code]) { var prev = pending[code]; pending[code] = function (d) { prev(d); cb(d); }; return; }
    pending[code] = cb;
    var s = document.createElement('script');
    s.src = 'data/b/' + code.replace(/\./g, '_') + '.js' + V;
    s.onerror = function () { delete pending[code]; note('The shapes inside ' + (NAME[code] || code) + ' did not load. Keep data/ beside index.html.'); };
    document.head.appendChild(s);
  }

  /* rings are delta integers in ten-thousandths of a degree; Leaflet wants [lat,lng] */
  function ringPts(r) {
    if (typeof r !== 'string') {          // a file written before the delta encoding
      var o = new Array(r.length);
      for (var k = 0; k < r.length; k++) o[k] = [r[k][1], r[k][0]];
      return o;
    }
    var v = r.split(' '), x = +v[0], y = +v[1], out = [[y / 1e4, x / 1e4]];
    for (var i = 2; i < v.length; i += 2) { x += +v[i]; y += +v[i + 1]; out.push([y / 1e4, x / 1e4]); }
    return out;
  }

  /* The antimeridian. A shape that straddles 180 degrees -- Russia, the Aleutians, Fiji -- has
     points on both sides of the line, and drawn as-is its far end lands at the opposite edge of
     the map. If a set of rings spans more than half the world, the far-side points are moved
     by 360 so the shape draws in one piece, just past the right edge; Leaflet is happy to draw
     at longitude 190. Bounds for framing come from the shifted points. */
  function unwrap(ringsLL) {
    var lo = 999, hi = -999, neg = 0, pos = 0;
    ringsLL.forEach(function (r) { r.forEach(function (q) {
      if (q[1] < lo) lo = q[1]; if (q[1] > hi) hi = q[1]; if (q[1] < 0) neg++; else pos++; }); });
    if (hi - lo < 180) return ringsLL;
    // Move the MINORITY side across, never a fixed one. Russia is mostly east of Greenwich and
    // Chukotka's few western-hemisphere points come over to +190. The United States is mostly
    // west, and only the outer Aleutians sit past 180: those go to -190. Shifting the negative
    // side regardless drew all of America at longitude 260 -- a US-shaped hole on the world map.
    if (neg > pos) return ringsLL.map(function (r) { return r.map(function (q) { return q[1] > 0 ? [q[0], q[1] - 360] : q; }); });
    return ringsLL.map(function (r) { return r.map(function (q) { return q[1] < 0 ? [q[0], q[1] + 360] : q; }); });
  }
  function boundsOf(ringsLL) {
    var b = null;
    ringsLL.forEach(function (r) { r.forEach(function (q) { b = b ? b.extend(q) : L.latLngBounds(q, q); }); });
    return b;
  }

  var map, tiles, worldGrp, envGrp, brGrp = null, outGrp = null, ptGrp = null, envOn = true;
  var WORLD_VIEW = L.latLngBounds([-56, -170], [78, 180]);   // the inhabited world, Antarctica's coast just in
  var PT_ZOOM = 9;                       // settlements appear from this zoom; below it the note gives their count
  var curCode = null, meta = null, curParent = null, curLevel = null;
  var rend = L.canvas({ padding: 0.3 });

  function note(t) {
    var n = document.getElementById('dnote'); if (!n) return;
    // arrived through a superseded code: every note on this page says so
    if (QS.was) t = (t ? t + ' ' : '') + 'Opened from ' + QS.was + ', a code this row superseded.';
    n.textContent = t;
  }

  function boot() {

    var host = document.getElementById('mapwrap');
    var fresh = host.cloneNode(false);             // drops the SVG page's click listener
    // The map is the page. A wide rectangle, and the whole inhabited world fitted into it on
    // open -- not a fixed centre and zoom that cut the Americas off on a narrow screen.
    fresh.style.height = 'min(78vh, 900px)';
    var css = document.createElement('style');
    css.textContent = '[data-view="atlas"] .grid{grid-template-columns:1fr}[data-view="atlas"] .pane{max-width:70ch}';
    document.head.appendChild(css);
    host.parentNode.replaceChild(fresh, host);

    // Basemaps that need no key. CARTO's raster tiles went behind an API key after this was
    // first written, and stamped "API KEY REQUIRED" across the map the day the site went live.
    // Esri's light and dark canvases are the same idea -- quiet grey, made to sit under data --
    // and are served without a key, with attribution.
    var esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
    var esriAttr = 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, OpenStreetMap contributors';
    var base = {
      'Light': L.tileLayer(esri + 'Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 16, attribution: esriAttr }),
      'Dark': L.tileLayer(esri + 'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 16, attribution: esriAttr }),
      'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }),
      'OpenTopoMap': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
        { subdomains: 'abc', maxZoom: 17, attribution: 'Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="https://viewfinderpanoramas.org">SRTM</a> | style: <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)' }),
      'Satellite (Esri)': L.tileLayer(esri + 'World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community' })
    };
    var labels = L.tileLayer(esri + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: '&copy; Esri' });

    var dark = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    tiles = dark ? base['Dark'] : base['Light'];

    map = L.map(fresh, { center: [20, 10], zoom: 2, zoomSnap: 0.25, zoomDelta: 0.5, minZoom: 1,
                         layers: [tiles], preferCanvas: true, worldCopyJump: true });
    map.fitBounds(WORLD_VIEW, { padding: [8, 8] });
    L.control.layers(base, { 'Esri labels & boundaries': labels }, { position: 'topright', collapsed: true }).addTo(map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

    envGrp = L.layerGroup().addTo(map);     // under the land: added first, drawn first
    worldGrp = L.layerGroup().addTo(map);
    // the envelope toggle sits with the page's own sliders
    var ctl = document.querySelector('.mapctl');
    if (ctl && !document.getElementById('envtog')) {
      var lab = document.createElement('label');
      lab.innerHTML = '<input type="checkbox" id="envtog" checked> envelopes '
        + '<select id="envw"><option value="">12 nautical miles</option><option value="100">100 km</option><option value="100r">100 km, rough</option></select> '
        + '<select id="envm"><option value="band">band</option><option value="outline">one outline</option></select> '
        + '<select id="envc"><option value="match">colour of the row</option><option value="one">one colour</option></select>'
        + '<input type="color" id="envone" value="#7aa2ff" title="envelope colour" style="width:26px;height:20px;padding:0;border:0;background:none;vertical-align:middle">';
      ctl.insertBefore(lab, ctl.firstChild);
      var look = document.createElement('label');
      look.innerHTML = 'look <select id="thm"><option value="atlas">atlas</option><option value="green">screen \u00b7 green</option><option value="cyan">screen \u00b7 cyan</option><option value="amber">screen \u00b7 amber</option></select>';
      ctl.insertBefore(look, lab);
      var repaint = repaintAll;
      look.querySelector('#thm').addEventListener('change', function (e) {
        var was = screen(); setTheme(e.target.value);
        // the first switch to a screen brings the look it was drawn for: rough envelopes, one outline
        if (screen() && !was && ENV_W === '' && ENV_MODE === 'band') {
          ENV_MODE = 'outline'; lab.querySelector('#envm').value = 'outline';
          lab.querySelector('#envw').value = '100r'; wantEnv('100r'); return;
        }
        repaint();
      });
      lab.querySelector('#envtog').addEventListener('change', function (e) { envOn = e.target.checked; repaint(); });
      lab.querySelector('#envw').addEventListener('change', function (e) { wantEnv(e.target.value); });
      lab.querySelector('#envm').addEventListener('change', function (e) { ENV_MODE = e.target.value; repaint(); });
      lab.querySelector('#envc').addEventListener('change', function (e) { ENV_COL = e.target.value; repaint(); });
      lab.querySelector('#envone').addEventListener('input', function (e) { ENV_ONE = e.target.value; ENV_COL = 'one'; lab.querySelector('#envc').value = 'one'; repaint(); });
    }
    map.on('zoomend', function () {
      if (!ptGrp) return;
      if (map.getZoom() >= PT_ZOOM) { if (!map.hasLayer(ptGrp)) ptGrp.addTo(map); }
      else if (map.hasLayer(ptGrp)) map.removeLayer(ptGrp);
    });
    window.ZSSMAP = map;            // reachable from the console, and from a test

    // the page's own descent, unchanged: only what it draws on is different
    window.paintWorld = paintTiles;
    window.fitGroup = fitTiles;
    // On the world page every route into a country -- a map click, the register table, the
    // search box, a crumb, a pasted code -- leaves for the country page. Only country.html draws
    // inside a country. (The click path had this from the start; the others leaked until 21 Sep.)
    var leave = function (code) { if (code) location.href = 'country.html?c=' + encodeURIComponent(code); };
    window.drawCountry = PAGE === 'country' ? function (code) { pickCountry(code); } : leave;
    window.selectCountry = PAGE === 'country' ? pickCountry : leave;
    window.drawBranch = PAGE === 'country' ? openBranch : leave;

    var det = document.getElementById('detwrap');
    if (det) { det.hidden = true; det.innerHTML = ''; }

    var lv = document.getElementById('lvbtns');
    if (lv) {
      var f2 = lv.cloneNode(true); lv.parentNode.replaceChild(f2, lv);
      f2.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-l]'); if (!b || !meta) return;
        wholeLevel(Number(b.dataset.l));
      });
    }
    if (PAGE === 'country' && QS.c) openCountryPage(QS.c);
    else { if (QS.at && TREE[QS.at]) { var n = QS.at.split('.').length; nav = n === 2 ? [pre(QS.at, 1), QS.at] : [pre(QS.at, 1)]; }
           paintTiles(); if (QS.at) fitTiles(QS.at); }
  }

  /* Leaflet's controls are styled for a white page. On the dark theme the page's own colours
     bled into them -- dark text on a dark box -- so the control takes the page's tokens. */
  (function () {
    var css = document.createElement('style');
    css.textContent =
      '.leaflet-control-layers,.leaflet-bar a,.leaflet-control-attribution,.leaflet-control-scale-line{' +
      'background:var(--panel,#fff);color:var(--ink,#111);border-color:var(--line,#ccc)}' +
      '.leaflet-control-layers{padding:2px 4px;font:13px/1.7 "IBM Plex Sans",system-ui,sans-serif;box-shadow:0 1px 6px rgba(0,0,0,.35)}' +
      '.leaflet-control-layers-expanded{padding:8px 12px 8px 8px}' +
      '.leaflet-control-layers label{display:flex;align-items:center;gap:8px;color:var(--ink,#111);font-size:13px;cursor:pointer;margin:1px 0}' +
      '.leaflet-control-layers label span{display:flex;align-items:center;gap:8px}' +
      '.leaflet-control-layers input{width:auto;margin:0;accent-color:var(--accent,#2d7dd2)}' +
      '.leaflet-control-layers-separator{border-top:1px solid var(--line,#ccc);margin:6px -8px 6px -6px}' +
      '.leaflet-control-layers-toggle{filter:var(--lf-icon,none)}' +
      '.leaflet-bar a{border-bottom-color:var(--line,#ccc)}.leaflet-bar a:hover{background:var(--soft,#eee)}' +
      '.leaflet-container .leaflet-control-attribution,.leaflet-container .leaflet-control-scale-line{background:color-mix(in srgb,var(--panel,#fff) 85%,transparent);color:var(--muted,#555);font-size:10.5px}.leaflet-control-attribution a{color:var(--muted,#555)}' +
      '.leaflet-tooltip{background:var(--panel,#fff);color:var(--ink,#111);border-color:var(--line,#ccc)}' +
      '.leaflet-tooltip-top:before{border-top-color:var(--line,#ccc)}' +
      '@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--lf-icon:invert(.85)}}' +
      ':root[data-theme="dark"]{--lf-icon:invert(.85)}' +
      /* the screen look */
      '#mapwrap.leaflet-container.zss-screen,.leaflet-container.zss-screen{background:var(--zss-bg,#03110c) !important}' +
      '.zss-screen .zss-overlay{position:absolute;inset:0;z-index:450;pointer-events:none;' +
      'background:repeating-linear-gradient(0deg,rgba(0,0,0,.10) 0 1px,transparent 1px 3px),' +
      'linear-gradient(115deg,transparent 42%,rgba(255,255,255,.055) 50%,transparent 58%),' +
      'radial-gradient(ellipse at center,transparent 58%,rgba(0,0,0,.45) 100%)}' +
      '.zss-overlay i{position:absolute;width:26px;height:26px;border:1.5px solid var(--zss-hue);opacity:.9}' +
      '.zss-overlay .c1{left:8px;top:8px;border-right:0;border-bottom:0}.zss-overlay .c2{right:8px;top:8px;border-left:0;border-bottom:0}' +
      '.zss-overlay .c3{left:8px;bottom:8px;border-right:0;border-top:0}.zss-overlay .c4{right:8px;bottom:8px;border-left:0;border-top:0}' +
      '.zss-hud{position:absolute;left:58px;top:12px;color:var(--zss-hue);font:12px/1.5 ui-monospace,"Cascadia Mono",Consolas,"DejaVu Sans Mono",monospace;letter-spacing:.06em;text-transform:uppercase;text-shadow:0 0 8px var(--zss-hue)}' +
      '.zss-hud b{display:block;font-size:14px;font-weight:700}.zss-hud span{opacity:.7;font-size:10.5px}' +
      '.zss-screen .leaflet-tooltip{background:rgba(0,0,0,.78);color:var(--zss-hue);border:1px solid var(--zss-hue);border-radius:0;' +
      'font:11px/1.4 ui-monospace,"Cascadia Mono",Consolas,"DejaVu Sans Mono",monospace;letter-spacing:.05em;text-transform:uppercase;box-shadow:0 0 10px color-mix(in srgb,var(--zss-hue) 50%,transparent)}' +
      '.zss-screen .leaflet-tooltip-top:before,.zss-screen .leaflet-tooltip-bottom:before,.zss-screen .leaflet-tooltip-left:before,.zss-screen .leaflet-tooltip-right:before{display:none}' +
      '.zss-reticle{pointer-events:none}.zss-reticle:before,.zss-reticle:after{content:"";position:absolute;border-radius:50%;border:1px solid var(--zss-hue);box-shadow:0 0 6px var(--zss-hue)}' +
      '.zss-reticle:before{inset:6px}.zss-reticle:after{inset:15px}' +
      '.zss-reticle{background:linear-gradient(var(--zss-hue),var(--zss-hue)) top center/1px 7px no-repeat,linear-gradient(var(--zss-hue),var(--zss-hue)) bottom center/1px 7px no-repeat,' +
      'linear-gradient(var(--zss-hue),var(--zss-hue)) left center/7px 1px no-repeat,linear-gradient(var(--zss-hue),var(--zss-hue)) right center/7px 1px no-repeat}' +
      '.zss-screen .leaflet-control-scale-line,.zss-screen .leaflet-control-attribution{background:rgba(0,0,0,.6);color:var(--zss-hue);border-color:var(--zss-hue);font-family:ui-monospace,Consolas,monospace}' +
      '.zss-screen .leaflet-bar a{background:rgba(0,0,0,.7);color:var(--zss-hue);border-color:var(--zss-hue)}';
    document.head.appendChild(css);
  })();

  /* ---- world, continents, regions ---------------------------------------- */
  function paintTiles() {
    if (!WORLD || !map) return;
    if (curCode) return;                            // a country is open; leave its levels alone
    worldGrp.clearLayers(); envGrp.clearLayers(); hideReticle();
    var gs = groups(), col = {}, d = nav.length + 1;
    gs.forEach(function (c, i) { col[c] = catColor(i, gs.length); });
    var parent = nav.length ? nav[nav.length - 1] : '';
    var op = (Number(document.getElementById('uop').value) || 100) / 100;

    // world.js is keyed by the register's own code now, not by ISO: the polygons were placed
    // under the row that claims that ground, so Greenland arrives as 5.3.4 DENMARK TERRITORIES
    // under Northern America rather than as Danish ground filed in Europe.
    var oneline = envOn && ENV_MODE === 'outline' && OUT;
    if (oneline) {
      // the shapes at this depth: the seven continents on the world view; inside a continent, THAT
      // continent as one line (its regions coloured within) and the other six faded; inside a
      // region, that region as one line and the rest faded
      var shapes = nav.length === 0 ? gs.slice() : [parent];
      Object.keys(TREE).filter(function (c) { return TREE[c].l === 1 && shapes.indexOf(c) < 0 && !within(parent, c); }).forEach(function (c) { shapes.push(c); });
      shapes.forEach(function (code) {
        var ov = OUT[code]; if (!ov) return;
        var inside = nav.length === 0 || code === parent;
        var hue = screen() ? SCREEN[THEME].hue : inside ? envColor(col[code] || col[pre(parent, d - 1)] || levelColor(3)) : '#8a97a3';
        unwrap(ov.r.map(ringPts)).forEach(function (pts) {
          if (screen() && inside) [[7, .05], [4, .12]].forEach(function (g) {      // the glow: two soft passes under the line
            envGrp.addLayer(L.polygon(pts, { renderer: rend, color: hue, weight: g[0], opacity: g[1], fill: false, interactive: false }));
          });
          var q = L.polygon(pts, { renderer: rend, color: hue, weight: screen() ? 1.2 : 1.4, opacity: inside ? .95 : (screen() ? .18 : .25),
            fillColor: hue, fillOpacity: (inside ? (screen() ? .07 : .22) : (screen() ? .02 : .06)) * (inside ? op : 1), interactive: true });
          q.zss = { code: code };
          q.on('click', function (e) { if (nav.length === 0) goto(this.zss.code); L.DomEvent.stop(e); });
          q.bindTooltip((TREE[code] ? TREE[code].n : wname(code)) + ' \u00b7 ' + code + ' \u00b7 one outline, ' + envName(), { sticky: true });
          envGrp.addLayer(q);
        });
      });
      // inside the line, the parts: each child's own outline (land and sea together) filled in the
      // child's colour, no edge of its own -- Northern America, Central America and the Caribbean
      // sit inside North America's one line, each its own colour out to the water
      if (nav.length) gs.forEach(function (code) {
        var ov = OUT[code]; if (!ov) return;
        var hue = envColor(col[code]);
        unwrap(ov.r.map(ringPts)).forEach(function (pts) {
          var q = L.polygon(pts, { renderer: rend, weight: screen() ? .7 : 0, opacity: screen() ? .5 : 0, stroke: screen(), color: hue, fillColor: hue, fillOpacity: (screen() ? .16 : .2) * op, interactive: true });
          q.zss = { code: code };
          q.on('click', function (e) { goto(this.zss.code); L.DomEvent.stop(e); });
          q.bindTooltip((TREE[code] ? TREE[code].n : wname(code)) + ' · ' + code, { sticky: true });
          envGrp.addLayer(q);
        });
      });
    } else if (ENV && envOn) {
      Object.keys(WORLD).forEach(function (code) {
        var ev = ENV[code]; if (!ev) return;
        var inside = within(code, parent);
        var fill = inside && col[pre(code, d)] ? envColor(col[pre(code, d)]) : '#8a97a3';
        unwrap(ev.r.map(ringPts)).forEach(function (pts) {
          // no stroke: a second country-coloured edge twelve miles out read as a second border
          var q = L.polygon(pts, { renderer: rend, weight: 0, opacity: 0, stroke: false,
            fillColor: fill, fillOpacity: (inside ? .2 : .05) * (inside ? op : 1), interactive: true });
          q.zss = { code: code };
          q.on('click', function (e) { descend(this.zss); L.DomEvent.stop(e); });
          q.bindTooltip(wname(code) + ' \u00b7 ' + code + ' \u00b7 envelope, ' + envName(), { sticky: true });
          envGrp.addLayer(q);
        });
      });
    }
    // Territory members (k:'t') are the ground a set like DENMARK TERRITORIES actually is --
    // Greenland, not a blob called Denmark -- drawn in the set's colour with a dashed edge and
    // the holder named, so a reader sees the place and still sees whose it is (decision, 20 Sep).
    Object.keys(WORLD).forEach(function (code) {
      var w = WORLD[code], inside = within(code, parent), terr = w.k === 't';
      if (!w.r) return;                            // a superseded row: a record, not a place
      var fill = (inside && col[pre(code, d)]) || '#8a97a3';
      var label = wname(code) + ' \u00b7 ' + code + (terr && w.h ? ' \u00b7 held by ' + w.h : '') + (w.st ? ' \u00b7 ' + w.st : '');
      unwrap(w.r.map(ringPts)).forEach(function (pts) {
        var oneline = envOn && ENV_MODE === 'outline' && OUT;                 // the outline carries the line
        var p = screen()
          // on a screen the land is dark glass with a lit coast; its colour lives in the envelope
          ? L.polygon(pts, { renderer: rend, color: SCREEN[THEME].hue, weight: .5, opacity: inside ? .85 : .3, dashArray: terr ? '4 3' : null,
              fillColor: SCREEN[THEME].land, fillOpacity: (inside ? .92 : .5), interactive: true })
          : L.polygon(pts, {
          renderer: rend, color: fill, weight: oneline ? 0 : (terr ? 1.4 : 1), opacity: oneline ? 0 : (inside ? .95 : .35),
          dashArray: terr && !oneline ? '5 4' : null,
          fillColor: fill, fillOpacity: (inside ? (terr ? .38 : .55) : .12) * (inside ? op : 1), interactive: true
        });
        p.zss = { code: code };
        p.on('click', function (e) { descend(this.zss); L.DomEvent.stop(e); });
        p.bindTooltip(label, { sticky: true });
        worldGrp.addLayer(p);
      });
    });
    wlegend(gs, col); wcrumb();
    if (screen()) hudText(nav.length ? (TREE[parent] ? TREE[parent].n : parent) + '  ' + parent : 'WORLD REGISTER',
      (nav.length ? gs.length + ' parts' : '7 continents \u00b7 24 regions \u00b7 270 rows') + (envOn ? ' \u00b7 envelope ' + envName() + (ENV_MODE === 'outline' ? ' \u00b7 one outline' : '') : '') + ' \u00b7 land true');
    if ((ENV || OUT) && envOn) {
      var k = document.getElementById('wkey');
      if (k) k.insertAdjacentHTML('beforeend', '<span class="hint">' + (ENV_MODE === 'outline' ? 'one outline: land and ' : 'pale bands: ')
        + (ENV_W === '100r' ? 'about a hundred kilometres of sea, its edge straightened into long segments -- a drawing, not a boundary -- '
          : ENV_W === '100' ? 'a hundred kilometres of sea -- a drawing, not a boundary -- ' : 'twelve nautical miles of sea, the territorial-sea convention, ')
        + 'derived from the land line and split between neighbours at the equidistant line</span>');
    }
  }

  function envelopeUnder(code, col) {
    if (!envOn) return;
    col = envColor(col);
    var outline = ENV_MODE === 'outline';
    var src = outline ? (OUT && OUT[code]) : (ENV && ENV[code]);
    if (!src) return;
    if (screen()) col = SCREEN[THEME].hue;
    unwrap(src.r.map(ringPts)).forEach(function (pts) {
      if (screen() && outline) [[7, .05], [4, .12]].forEach(function (g) {
        envGrp.addLayer(L.polygon(pts, { renderer: rend, color: col, weight: g[0], opacity: g[1], fill: false, interactive: false }));
      });
      envGrp.addLayer(L.polygon(pts, { renderer: rend, color: col, weight: outline ? 1.4 : 0, opacity: outline ? .9 : 0, stroke: outline, fillColor: col, fillOpacity: outline ? (screen() ? .07 : .12) : .1, interactive: false }));
    });
  }

  function envName() { return ENV_W === '100' ? '100 km' : ENV_W === '100r' ? '100 km, rough' : '12 nm'; }
  function wname(code) { return (WORLD[code] && WORLD[code].n) || (TREE[code] ? TREE[code].n : code); }

  function descend(z) {
    if (!z.code) return;
    if (nav.length === 0) { goto(pre(z.code, 1)); return; }
    if (pre(z.code, 1) !== nav[0]) { goto(pre(z.code, 1)); return; }
    if (nav.length === 1) { goto(pre(z.code, 2)); return; }
    if (pre(z.code, 2) !== nav[1]) { goto(pre(z.code, 2)); return; }
    // the third click leaves the world map: a country is its own page
    if (PAGE !== 'country') { location.href = 'country.html?c=' + encodeURIComponent(z.code); return; }
    pickCountry(z.code);
  }

  /* ---- the country page ------------------------------------------------------
     Opened at ?c=<code>. A country with joined tiers gets the branch descent; a row with only
     its outline (a territory member, or one of the countries whose join has not run) gets that
     outline, its source, and a plain statement of what is not there yet. */
  function openCountryPage(code) {
    var w = WORLD[code], country = pre(code, 3);
    // a superseded code still resolves: it opens its successor and says so
    var sb = WORLD[country] && WORLD[country].sb;
    if (sb) { location.replace('country.html?c=' + encodeURIComponent(sb + code.slice(country.length)) + '&was=' + encodeURIComponent(code)); return; }
    if (D.atlas[country]) {
      if (code === country) { openBranch(code); return; }
      // a deeper code opens as a branch if it has one, else inside its parent's
      wantBranch(country, function (top) {
        var L = code.split('.').length, deepest = (top.meta && top.meta.deepest) || 9;
        openBranch(L < deepest ? code : code.slice(0, code.lastIndexOf('.')));
      });
      return;
    }
    if (!w) { note('No row ' + code + ' on the world map.'); return; }
    nav = [pre(code, 1), pre(code, 2)];
    worldGrp.clearLayers(); envGrp.clearLayers(); clearBranch(); hideReticle();
    var col = w.k === 't' ? levelColor(4) : levelColor(3);
    envelopeUnder(code, col);
    if (screen()) { col = SCREEN[THEME].hue; hudText(w.n + '  ' + code, (w.k === 't' ? 'territory' : 'country') + ' \u00b7 outline ' + w.src + (envOn ? ' \u00b7 envelope ' + envName() : '') + ' \u00b7 land true'); }
    var rr = unwrap(w.r.map(ringPts)), frame = null;
    rr.forEach(function (pts) {
      var ub = boundsOf([pts]);
      if (ub && (ub.getEast() - ub.getWest()) < 90) frame = frame ? frame.extend(ub) : ub;
    });
    outGrp = L.layerGroup(rr.map(function (pts) {
      return L.polygon(pts, { renderer: rend, color: col, weight: 2, opacity: .9, fillColor: col, fillOpacity: .25,
        dashArray: w.k === 't' ? '6 4' : null, interactive: false });
    })).addTo(map);
    if (frame) map.fitBounds(frame, { padding: [24, 24] });
    document.getElementById('dtitle').textContent = w.n;
    document.getElementById('detail').hidden = false;
    document.getElementById('lvbtns').innerHTML = '';
    var el = document.getElementById('wcrumb'), parts = ['<a data-nav="">World</a>'];
    nav.forEach(function (c) { parts.push('<a data-nav="' + c + '">' + TREE[c].n + '</a>'); });
    if (w.p) parts.push('<a data-nav="' + w.p + '">' + (TREE[w.p] ? TREE[w.p].n : w.p) + '</a>');
    parts.push('<b>' + w.n + '</b>');
    el.innerHTML = parts.join('<span class="sep">\u203a</span>');
    document.getElementById('wkey').innerHTML = '<span><i style="background:' + col + '"></i>' + (w.k === 't' ? 'territory' : 'country') + ' outline</span>'
      + '<span class="hint">' + w.src + '</span>';
    note((w.k === 't' ? (w.h ? 'Held by ' + w.h + '. ' : '') : '')
      + 'The register holds this row' + (w.k === 't' ? ' under ' + (TREE[w.p] ? TREE[w.p].n : w.p) : '')
      + '; its outline here comes from ' + w.src + '. No deeper tiers are joined to polygons yet' + (w.st ? ' (status: ' + w.st + ')' : '') + '.');
    var box = document.getElementById('selbox'); if (box) box.innerHTML = '<div class="selbox"><h4>' + w.n + '</h4><div class="c">' + code + '</div></div>';
  }

  function fitTiles(code) {
    if (!map || !WORLD) return;
    if (!code) { map.fitBounds(WORLD_VIEW, { padding: [8, 8] }); return; }
    // Not the outright extent. Europe's codes take in Greenland, the Azores, the Canaries,
    // Réunion and French Guiana, so Europe honestly spans most of the planet and framing that
    // shows you nothing. Trim a little weight off each edge by area and the camera lands on
    // the mass of the thing; the outliers stay drawn, just outside the frame.
    var parts = [];
    Object.keys(WORLD).forEach(function (c) {
      if (!within(c, code)) return;
      (WORLD[c].rb || []).forEach(function (q) {
        var w = q[2] - q[0], h = q[3] - q[1];
        // Russia's polygon crosses the antimeridian, so its box runs the full 360 degrees and
        // its landmass is 160 wide regardless. A ring that big is not a place a camera can
        // frame, so it is left out of the framing -- it is still drawn, just not aimed at.
        if (w > 150 || h > 60) return;    // 150, not 90: Asiatic Russia alone is 130 degrees wide and is a place
        parts.push({ c: c, x0: q[0], y0: q[1], x1: q[2], y1: q[3], w: Math.max(w * h, 1e-4) });
      });
    });
    if (!parts.length) return;
    // The trim is done child by child, then the children's frames are joined: Central America and
    // the Caribbean are a twentieth of North America by area and a single trim dropped them off the
    // bottom of the frame (21 Sep 2026). A child is never trimmed away by its parent's bulk; only
    // its own outliers are (France's mainland frames France, not French Guiana).
    var depth = code.split('.').length, kids = {};
    parts.forEach(function (q) { (kids[pre(q.c, depth + 1)] = kids[pre(q.c, depth + 1)] || []).push(q); });
    function frame(ps) {
      if (ps.length === 1) return ps[0];
      var total = ps.reduce(function (a, q) { return a + q.w; }, 0), CUT = 0.05 * total;
      function edge(key, dir) {
        var a = ps.slice().sort(function (m, n) { return dir > 0 ? m[key] - n[key] : n[key] - m[key]; });
        var acc = 0;
        for (var i = 0; i < a.length; i++) { acc += a[i].w; if (acc > CUT) return a[i][key]; }
        return a[a.length - 1][key];
      }
      var f = { x0: edge('x0', 1), y0: edge('y0', 1), x1: edge('x1', -1), y1: edge('y1', -1) };
      if (!(f.x1 > f.x0) || !(f.y1 > f.y0)) f = ps.slice().sort(function (m, n) { return n.w - m.w; })[0];
      return f;
    }
    var bb = null;
    Object.keys(kids).forEach(function (k) {
      var f = frame(kids[k]);
      bb = bb ? { x0: Math.min(bb.x0, f.x0), y0: Math.min(bb.y0, f.y0), x1: Math.max(bb.x1, f.x1), y1: Math.max(bb.y1, f.y1) } : { x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 };
    });
    map.fitBounds(L.latLngBounds([bb.y0, bb.x0], [bb.y1, bb.x1]), { padding: [36, 36] });
  }

  /* ---- one country, one branch at a time ------------------------------------
     A click answers with the children of the thing clicked: the country's regions, then that
     region's states, then that state's counties, then the settlements in a county. Each answer
     is one small file, fetched when asked for. Nothing above or beside the branch is loaded. */
  function pickCountry(code) {
    if (!code) return;
    if (!D.atlas[code]) {
      curCode = null;
      var nm = TREE[code] ? TREE[code].n : code;
      var pane = document.getElementById('pane');
      pane.innerHTML = '<h3>' + nm + '</h3><div class="code">' + code + '</div>'
        + '<p class="note">The register holds its rows; joining each code to a polygon is a '
        + 'separate run, and this country has not passed it.</p>';
      return;
    }
    openBranch(code);
  }

  function countryOf(code) { return pre(code, 3); }

  function clearBranch() {
    [brGrp, outGrp, ptGrp].forEach(function (g) { if (g && map.hasLayer(g)) map.removeLayer(g); });   // ptGrp may be detached below PT_ZOOM
    brGrp = outGrp = ptGrp = null;
    if (ownGrp && !curCode) { map.removeLayer(ownGrp); ownGrp = null; }
  }

  function openBranch(parent, keepView) {
    var country = countryOf(parent);
    if (!D.atlas[country]) { pickCountry(country); return; }
    var need = [country];                       // the country file carries the metadata
    if (parent !== country) need.push(parent);
    var got = 0;
    need.forEach(function (c) {
      wantBranch(c, function () { if (++got === need.length) showBranch(parent, keepView); });
    });
  }

  function showBranch(parent, keepView) {
    var country = countryOf(parent), top = BR[country], d = BR[parent];
    if (!top || !d) return;
    meta = top.meta; curCode = country; curParent = parent; curLevel = d.level;
    // a country opened by code (search, a link, the register) still sits inside its region
    if (nav.length < 2 || nav[1] !== pre(country, 2)) nav = [pre(country, 1), pre(country, 2)];
    worldGrp.clearLayers(); envGrp.clearLayers(); hideReticle();
    clearBranch();
    if (parent === country) envelopeUnder(country, levelColor(3));
    if (screen()) hudText((NAME[parent] || (TREE[parent] ? TREE[parent].n : parent)) + '  ' + parent,
      d.units.length + ' units \u00b7 level ' + d.level + (envOn && parent === country ? ' \u00b7 envelope ' + envName() : '') + ' \u00b7 land true');

    var op = (Number(document.getElementById('uop').value) || 100) / 100;
    var col = levelColor(d.level), deep = d.level >= meta.deepest || d.units.every(function (u) { return u.leaf; }), shapes = [];
    // 'deep' also when every unit here is a leaf: Banaadir's one unit, Mogadishu, has nothing below it
    // Siblings are told apart the way continents and regions are on the world view: one hue
    // each, from the same wheel. The level colour keeps the outline, so the legend still holds.
    // Past two dozen siblings the wheel stops separating and the level colour takes over.
    var many = d.units.length > 24;
    var frame = null;
    d.units.forEach(function (u, i) {
      var fill = many ? col : catColor(i, d.units.length);
      var rr = unwrap(u.r.map(ringPts));
      var ub = boundsOf(rr);
      if (ub && (ub.getEast() - ub.getWest()) < 90) frame = frame ? frame.extend(ub) : ub;
      // one shape per unit, all its rings together, filled even-odd: a ring inside another is a hole
      // (an enclave such as Madrid or Kyiv, a lake), separate rings are separate parts (islands)
      if (!rr.length) return;
      var p = L.polygon(rr, {
        // on a screen the parts are lit edges in the hue, tinted faintly in their own colour
        renderer: rend, color: screen() ? SCREEN[THEME].hue : (many ? col : 'rgba(255,255,255,.55)'), weight: d.level >= 7 ? .7 : (screen() ? .8 : 1.1), opacity: screen() ? .8 : .95,
        fillColor: fill, fillOpacity: (screen() ? .22 : (many ? .38 : .5)) * op, fillRule: 'evenodd', interactive: true
      });
      p.zss = u;
      p.on('click', function (e) {
        L.DomEvent.stop(e);
        if (deep || this.zss.leaf) { showUnit(this.zss, d.level, d); markUnit(this); }
        else openBranch(this.zss.c);
      });
      p.bindTooltip(u.n + ' · ' + u.c + (u.leaf && !deep ? ' · nothing below' : ''), { sticky: true });
      shapes.push(p);
    });
    brGrp = L.layerGroup(shapes).addTo(map);
    drawOwn(country);

    // the parent's own outline, so the children read as pieces of something. At the top of the
    // country it is the world layer's outline -- the same union the world map draws.
    if (parent === country && WORLD && WORLD[country]) {
      outGrp = L.layerGroup(unwrap(WORLD[country].r.map(ringPts)).map(function (pts) {
        return L.polygon(pts, { renderer: rend, color: levelColor(3), weight: 2, opacity: .7, fill: false, interactive: false, dashArray: '4 4' });
      })).addTo(map);
    }
    if (parent !== country) {
      var up = BR[parent.slice(0, parent.lastIndexOf('.'))];
      var me = up && up.units.filter(function (u) { return u.c === parent; })[0];
      if (me) {
        outGrp = L.layerGroup(unwrap(me.r.map(ringPts)).map(function (pts) {
          return L.polygon(pts, { renderer: rend, color: levelColor(d.level - 1), weight: 2.2,
            opacity: .8, fill: false, interactive: false, dashArray: '4 4' });
        })).addTo(map);
      }
    }

    // settlements, only at the deepest level, only the ones inside this parent -- and only once
    // the map is close enough for them to be dots rather than a blanket: 460 markers hid all
    // fourteen of Massachusetts' counties at zoom 7.
    if (deep && d.pts && d.pts.length) {
      ptGrp = L.layerGroup(d.pts.map(function (q) {
        var m = L.circleMarker([q[2], q[3]], {
          renderer: rend, radius: 2.2, color: '#fff', weight: .8, opacity: .9,
          fillColor: levelColor(9), fillOpacity: .65, interactive: true
        });
        m.zss = { c: q[0], n: q[1] };
        m.on('click', function (e) { showUnit(this.zss, 9, d); L.DomEvent.stop(e); });
        m.bindTooltip(q[1] + ' · ' + q[0], { sticky: true });
        return m;
      }));
      if (map.getZoom() >= PT_ZOOM) ptGrp.addTo(map);
    }

    // frame the children (not an antimeridian-crossing outlier among them)
    if (!keepView) {
      map.fitBounds(frame || L.latLngBounds([meta.bbox[1], meta.bbox[0]], [meta.bbox[3], meta.bbox[2]]), { padding: [22, 22] });
    }

    var here = parent === country ? (D.cname[meta.iso] || meta.name) : (NAME[parent] || parent);
    document.getElementById('dtitle').textContent = (D.cname[meta.iso] || meta.name) + ' — L' + d.level;
    document.getElementById('detail').hidden = false;
    document.getElementById('lvbtns').innerHTML = Object.keys(meta.counts).map(Number).sort(function (a, b) { return a - b; })
      .map(function (Lv) {
        return '<button data-l="' + Lv + '" aria-pressed="' + (Lv === d.level && parent === country) + '" title="every unit at this level, the whole country">L'
          + Lv + ' · ' + fmt(meta.counts[String(Lv)]) + '</button>';
      }).join('') + (meta.pts ? '<span class="hint" style="margin-left:8px">L9 · ' + fmt(meta.pts) + ' settlements, shown inside the deepest units</span>' : '');
    crumbBranch(parent);
    note(fmt(d.units.length) + ' units at L' + d.level + ' inside ' + here
      + (deep ? (d.pts && d.pts.length ? ', with ' + fmt(d.pts.length) + ' settlements' + (map.getZoom() < PT_ZOOM ? ' (zoom in to see them)' : '') + '. This is as deep as this country goes; click a unit for its code.'
                                         : '. This is as deep as this country goes; click a unit for its code.')
              : '. Click one to open what is inside it; the buttons below show a whole level at once.'));
    var box = document.getElementById('selbox'); if (box) box.innerHTML = '';
  }

  var marked = null;
  function markUnit(p) {
    if (marked && marked._zssStyle) marked.setStyle(marked._zssStyle);
    marked = p; p._zssStyle = { weight: p.options.weight, color: p.options.color };
    p.setStyle({ weight: 2.8, color: '#fff' }); p.bringToFront();
  }

  /* the whole of one level, for whoever wants the old view: every file down to that level */
  function wholeLevel(Lv) {
    if (!meta) return;
    var country = curCode, todo = [country], units = [], loading = 0;
    note('Loading every unit at L' + Lv + ' …');
    function step() {
      if (!todo.length) { if (!loading) done(); return; }
      var c = todo.shift(); loading++;
      wantBranch(c, function (d) {
        loading--;
        if (d.level === Lv) units = units.concat(d.units);
        else if (d.level < Lv) d.units.forEach(function (u) { todo.push(u.c); });
        while (todo.length && loading < 6) step();
        if (!todo.length && !loading) done();
      });
    }
    function done() {
      worldGrp.clearLayers(); clearBranch();
      var op = (Number(document.getElementById('uop').value) || 100) / 100, col = levelColor(Lv);
      brGrp = L.layerGroup(units.reduce(function (acc, u) {
        var rr = unwrap(u.r.map(ringPts));
        if (!rr.length) return acc;
        var p = L.polygon(rr, { renderer: rend, color: col, weight: Lv >= 7 ? .6 : 1, opacity: .9,
          fillColor: col, fillOpacity: .35 * op, fillRule: 'evenodd', interactive: true });
        p.zss = u;
        p.on('click', function (e) { L.DomEvent.stop(e); if (Lv < meta.deepest) openBranch(this.zss.c); else { showUnit(this.zss, Lv, null); markUnit(this); } });
        p.bindTooltip(u.n + ' · ' + u.c, { sticky: true });
        acc.push(p);
        return acc;
      }, [])).addTo(map);
    if (curCode) drawOwn(curCode);
      curParent = country; curLevel = Lv;
      map.fitBounds(L.latLngBounds([meta.bbox[1], meta.bbox[0]], [meta.bbox[3], meta.bbox[2]]), { padding: [22, 22] });
      document.getElementById('dtitle').textContent = (D.cname[meta.iso] || meta.name) + ' — L' + Lv;
      [].forEach.call(document.querySelectorAll('#lvbtns button[data-l]'), function (b) { b.setAttribute('aria-pressed', Number(b.dataset.l) === Lv); });
      crumbBranch(country);
      note(fmt(units.length) + ' units at L' + Lv + ', the whole of ' + (D.cname[meta.iso] || meta.name) + '. Click one to open what is inside it.');
    }
    step();
  }

  /* World › continent › region › Country › region › state -- every step is a link back up */
  function crumbBranch(parent) {
    var el = document.getElementById('wcrumb'), country = countryOf(parent);
    var parts = ['<a data-nav="">World</a>'];
    nav.forEach(function (c) { parts.push('<a data-nav="' + c + '">' + TREE[c].n + '</a>'); });
    var segs = parent.split('.');
    for (var n = 3; n <= segs.length; n++) {
      var c = segs.slice(0, n).join('.');
      var label = n === 3 ? (D.cname[meta.iso] || meta.name) : (NAME[c] || c);
      parts.push(n === segs.length ? '<b>' + label + '</b>' : '<a data-nav="' + c + '">' + label + '</a>');
    }
    el.innerHTML = parts.join('<span class="sep">›</span>');
    var k = document.getElementById('wkey');
    var Ls = Object.keys(meta.counts).map(Number).sort(function (a, b) { return a - b; });
    if (meta.pts) Ls.push(9);
    k.innerHTML = Ls.map(function (Lv) {
      return '<span' + (Lv === curLevel ? ' style="font-weight:600"' : '') + '><i style="background:' + levelColor(Lv) + '"></i>L' + Lv
        + (Lv === 9 ? ' — settlements' : '') + '</span>';
    }).join('') + '<span class="hint">one branch at a time — click a unit to open it, the crumb to go back up</span>';
  }

  function levelColor(Lv) {
    var v = getComputedStyle(document.documentElement).getPropertyValue('--d' + Math.min(Lv, 9));
    return (v || '').trim() || '#4ea3d8';
  }

  function showUnit(u, Lv, d) {
    var box = document.getElementById('selbox');
    var setts = 0;
    if (d && d.pts && Lv < 9) setts = d.pts.filter(function (q) { return q[0].indexOf(u.c + '.') === 0; }).length;
    box.innerHTML = '<div class="selbox"><h4>' + (u.n || '—') + '</h4>'
      + '<div class="c">' + u.c + '</div><p>L' + Lv + ', ' + u.c.split('.').length + ' segments'
      + (setts ? ' · ' + fmt(setts) + ' settlements' : '') + '</p></div>';
  }

  /* leaving a country goes back to the region it sits in */
  var crumb = document.getElementById('wcrumb');
  crumb.addEventListener('click', function (e) {
    var a = e.target.closest('a[data-nav]'); if (!a) return;
    if (PAGE === 'country' && a.dataset.nav.split('.').length < 3 || (PAGE === 'country' && !a.dataset.nav)) {
      // World, a continent or a region: that is the world page's business
      e.stopPropagation(); e.preventDefault();
      location.href = 'index.html' + (a.dataset.nav ? '?at=' + encodeURIComponent(a.dataset.nav) : ''); return;
    }
    if (a.dataset.nav.split('.').length >= 3) return;   // a step inside the country: goto() opens that branch
    curCode = null; meta = null; curParent = null; curLevel = null; marked = null;
    clearBranch();
    document.getElementById('detail').hidden = true; }, true);

  document.getElementById('uop').addEventListener('input', function () {
    if (curParent) openBranch(curParent, true);
    else paintTiles();
  });

  wantEnv('');                                    // twelve nautical miles by default; the selector fetches others
  var s = document.createElement('script');
  s.src = 'data/world.js' + V;
  s.onerror = function () { note('data/world.js did not load — keep data/ beside index.html.'); };
  document.head.appendChild(s);
})();
