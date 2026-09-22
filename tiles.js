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
  var WORLD = null, BR = {}, pending = {}, NAME = {};
  // Two pages share this file. The world page stops at L3 (decision 1, 20 Sep 2026): a click
  // on a country leaves for that country's own page, which is the same page with ?c=<code>,
  // and carries the descent into the country's tiers. Nothing inside a country is drawn on
  // the world map.
  var PAGE = window.ZSS_PAGE || 'world';
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
    load: function () {}                 // the old one-file-per-country shape; no longer read
  };
  function wantBranch(code, cb) {
    if (BR[code]) { cb(BR[code]); return; }
    if (pending[code]) { var prev = pending[code]; pending[code] = function (d) { prev(d); cb(d); }; return; }
    pending[code] = cb;
    var s = document.createElement('script');
    s.src = 'data/b/' + code.replace(/\./g, '_') + '.js';
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

  var map, tiles, worldGrp, brGrp = null, outGrp = null, ptGrp = null;
  var curCode = null, meta = null, curParent = null, curLevel = null;
  var rend = L.canvas({ padding: 0.3 });

  function note(t) { var n = document.getElementById('dnote'); if (n) n.textContent = t; }

  function boot() {

    var host = document.getElementById('mapwrap');
    var fresh = host.cloneNode(false);             // drops the SVG page's click listener
    fresh.style.height = 'min(64vh, 640px)';
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

    map = L.map(fresh, { center: [22, 12], zoom: 2, layers: [tiles], preferCanvas: true, worldCopyJump: true });
    L.control.layers(base, { 'Esri labels & boundaries': labels }, { position: 'topright', collapsed: true }).addTo(map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

    worldGrp = L.layerGroup().addTo(map);
    window.ZSSMAP = map;            // reachable from the console, and from a test

    // the page's own descent, unchanged: only what it draws on is different
    window.paintWorld = paintTiles;
    window.fitGroup = fitTiles;
    window.drawCountry = function (code) { pickCountry(code); };
    window.selectCountry = pickCountry;
    window.drawBranch = openBranch;       // goto(code) for anything inside a country lands here

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
      ':root[data-theme="dark"]{--lf-icon:invert(.85)}';
    document.head.appendChild(css);
  })();

  /* ---- world, continents, regions ---------------------------------------- */
  function paintTiles() {
    if (!WORLD || !map) return;
    if (curCode) return;                            // a country is open; leave its levels alone
    worldGrp.clearLayers();
    var gs = groups(), col = {}, d = nav.length + 1;
    gs.forEach(function (c, i) { col[c] = catColor(i, gs.length); });
    var parent = nav.length ? nav[nav.length - 1] : '';
    var op = (Number(document.getElementById('uop').value) || 100) / 100;

    // world.js is keyed by the register's own code now, not by ISO: the polygons were placed
    // under the row that claims that ground, so Greenland arrives as 5.3.4 DENMARK TERRITORIES
    // under Northern America rather than as Danish ground filed in Europe.
    // Territory members (k:'t') are the ground a set like DENMARK TERRITORIES actually is --
    // Greenland, not a blob called Denmark -- drawn in the set's colour with a dashed edge and
    // the holder named, so a reader sees the place and still sees whose it is (decision, 20 Sep).
    Object.keys(WORLD).forEach(function (code) {
      var w = WORLD[code], inside = within(code, parent), terr = w.k === 't';
      var fill = (inside && col[pre(code, d)]) || '#8a97a3';
      var label = wname(code) + ' \u00b7 ' + code + (terr && w.h ? ' \u00b7 held by ' + w.h : '') + (w.st ? ' \u00b7 ' + w.st : '');
      unwrap(w.r.map(ringPts)).forEach(function (pts) {
        var p = L.polygon(pts, {
          renderer: rend, color: fill, weight: terr ? 1.4 : 1, opacity: inside ? .95 : .35,
          dashArray: terr ? '5 4' : null,
          fillColor: fill, fillOpacity: (inside ? (terr ? .38 : .55) : .12) * (inside ? op : 1), interactive: true
        });
        p.zss = { code: code };
        p.on('click', function (e) { descend(this.zss); L.DomEvent.stop(e); });
        p.bindTooltip(label, { sticky: true });
        worldGrp.addLayer(p);
      });
    });
    wlegend(gs, col); wcrumb();
  }

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
    if (D.atlas[country] && code === country) { openBranch(code); return; }
    if (!w) { note('No row ' + code + ' on the world map.'); return; }
    nav = [pre(code, 1), pre(code, 2)];
    worldGrp.clearLayers(); clearBranch();
    var col = w.k === 't' ? levelColor(4) : levelColor(3);
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
    if (!code) { map.setView([22, 12], 2); return; }
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
        parts.push({ x0: q[0], y0: q[1], x1: q[2], y1: q[3], w: Math.max(w * h, 1e-4) });
      });
    });
    if (!parts.length) return;
    if (parts.length === 1) {
      var o = parts[0];
      map.fitBounds(L.latLngBounds([o.y0, o.x0], [o.y1, o.x1]), { padding: [24, 24] });
      return;
    }
    var total = parts.reduce(function (a, q) { return a + q.w; }, 0), CUT = 0.05 * total;
    function edge(key, dir) {
      var a = parts.slice().sort(function (m, n) { return dir > 0 ? m[key] - n[key] : n[key] - m[key]; });
      var acc = 0;
      for (var i = 0; i < a.length; i++) { acc += a[i].w; if (acc > CUT) return a[i][key]; }
      return a[a.length - 1][key];
    }
    var x0 = edge('x0', 1), y0 = edge('y0', 1), x1 = edge('x1', -1), y1 = edge('y1', -1);
    if (!(x1 > x0) || !(y1 > y0)) {
      var big = parts.slice().sort(function (m, n) { return n.w - m.w; })[0];
      x0 = big.x0; y0 = big.y0; x1 = big.x1; y1 = big.y1;
    }
    map.fitBounds(L.latLngBounds([y0, x0], [y1, x1]), { padding: [24, 24] });
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
    [brGrp, outGrp, ptGrp].forEach(function (g) { if (g && map.hasLayer(g)) map.removeLayer(g); });
    brGrp = outGrp = ptGrp = null;
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
    worldGrp.clearLayers();
    clearBranch();

    var op = (Number(document.getElementById('uop').value) || 100) / 100;
    var col = levelColor(d.level), deep = d.level >= meta.deepest, shapes = [];
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
      rr.forEach(function (pts) {
        var p = L.polygon(pts, {
          renderer: rend, color: many ? col : 'rgba(255,255,255,.55)', weight: d.level >= 7 ? .7 : 1.1, opacity: .95,
          fillColor: fill, fillOpacity: (many ? .38 : .5) * op, interactive: true
        });
        p.zss = u;
        p.on('click', function (e) {
          L.DomEvent.stop(e);
          if (deep) { showUnit(this.zss, d.level, d); markUnit(this); }
          else openBranch(this.zss.c);
        });
        p.bindTooltip(u.n + ' · ' + u.c, { sticky: true });
        shapes.push(p);
      });
    });
    brGrp = L.layerGroup(shapes).addTo(map);

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

    // settlements, only at the deepest level, only the ones inside this parent
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
      })).addTo(map);
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
      + (deep ? (d.pts && d.pts.length ? ', with ' + fmt(d.pts.length) + ' settlements. This is as deep as this country goes; click a unit for its code.'
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
        unwrap(u.r.map(ringPts)).forEach(function (pts) {
          var p = L.polygon(pts, { renderer: rend, color: col, weight: Lv >= 7 ? .6 : 1, opacity: .9,
            fillColor: col, fillOpacity: .35 * op, interactive: true });
          p.zss = u;
          p.on('click', function (e) { L.DomEvent.stop(e); if (Lv < meta.deepest) openBranch(this.zss.c); else { showUnit(this.zss, Lv, null); markUnit(this); } });
          p.bindTooltip(u.n + ' · ' + u.c, { sticky: true });
          acc.push(p);
        });
        return acc;
      }, [])).addTo(map);
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

  var s = document.createElement('script');
  s.src = 'data/world.js';
  s.onerror = function () { note('data/world.js did not load — keep data/ beside index.html.'); };
  document.head.appendChild(s);
})();
