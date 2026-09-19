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
  var WORLD = null, CDB = {}, pending = {};
  window.ZSSW = { load: function (d) { WORLD = d; boot(); } };
  window.ZSS = {
    load: function (d) { CDB[d.code] = d; var f = pending[d.code]; delete pending[d.code]; if (f) f(d); }
  };
  function wantCountry(code, cb) {
    if (CDB[code]) { cb(CDB[code]); return; }
    pending[code] = cb;
    var s = document.createElement('script');
    s.src = 'data/' + code.replace(/\./g, '_') + '.js';
    s.onerror = function () { note('That country’s shapes did not load. Keep data/ beside index.html.'); };
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

  var map, tiles, worldGrp, lvlGrp = {}, lvlOn = {}, curCode = null, curData = null;
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
    L.control.layers(base, { 'Place labels': labels }, { position: 'topright', collapsed: true }).addTo(map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

    worldGrp = L.layerGroup().addTo(map);
    window.ZSSMAP = map;            // reachable from the console, and from a test

    // the page's own descent, unchanged: only what it draws on is different
    window.paintWorld = paintTiles;
    window.fitGroup = fitTiles;
    window.drawCountry = drawOnMap;
    window.selectCountry = pickCountry;

    var det = document.getElementById('detwrap');
    if (det) { det.hidden = true; det.innerHTML = ''; }

    var lv = document.getElementById('lvbtns');
    if (lv) {
      var f2 = lv.cloneNode(true); lv.parentNode.replaceChild(f2, lv);
      f2.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-l]'); if (!b || !curData) return;
        var L1 = Number(b.dataset.l);
        lvlOn = {}; lvlOn[L1] = true;
        showLevels(); markLevelButtons(); crumbWith(curData);
      });
    }
    paintTiles();
  }

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
    Object.keys(WORLD).forEach(function (code) {
      var inside = within(code, parent);
      var fill = (inside && col[pre(code, d)]) || '#8a97a3';
      WORLD[code].r.forEach(function (r) {
        var p = L.polygon(ringPts(r), {
          renderer: rend, color: fill, weight: 1, opacity: inside ? .95 : .35,
          fillColor: fill, fillOpacity: inside ? .55 * op : .12, interactive: true
        });
        p.zss = { code: code };
        p.on('click', function (e) { descend(this.zss); L.DomEvent.stop(e); });
        p.bindTooltip((TREE[code] ? TREE[code].n : code) + ' \u00b7 ' + code, { sticky: true });
        worldGrp.addLayer(p);
      });
    });
    wlegend(gs, col); wcrumb();
  }

  function descend(z) {
    if (!z.code) return;
    if (nav.length === 0) { goto(pre(z.code, 1)); return; }
    if (pre(z.code, 1) !== nav[0]) { goto(pre(z.code, 1)); return; }
    if (nav.length === 1) { goto(pre(z.code, 2)); return; }
    if (pre(z.code, 2) !== nav[1]) { goto(pre(z.code, 2)); return; }
    pickCountry(z.code);
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
        if (w > 90 || h > 60) return;
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

  /* ---- one country, its own divisions ------------------------------------ */
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
    drawOnMap(code, null, false);
  }

  function drawOnMap(code, level) {
    wantCountry(code, function (d) {
      curCode = code; curData = d;
      worldGrp.clearLayers();
      Object.keys(lvlGrp).forEach(function (k) { map.removeLayer(lvlGrp[k]); });
      lvlGrp = {};

      var keys = Object.keys(d.levels).map(Number).sort(function (a, b) { return a - b; });
      var deep = keys[keys.length - 1];
      var want = level && d.levels[String(level)] ? Number(level) : deep;
      lvlOn = {}; lvlOn[want] = true;

      var op = (Number(document.getElementById('uop').value) || 100) / 100;
      keys.forEach(function (Lv) {
        var col = levelColor(Lv), shapes = [];
        d.levels[String(Lv)].forEach(function (u) {
          u.r.forEach(function (r) {
            var p = L.polygon(ringPts(r), {
              renderer: rend, color: col, weight: Lv >= 7 ? .6 : 1.1, opacity: .9,
              fillColor: col, fillOpacity: .35 * op, interactive: true
            });
            p.zss = u;
            p.on('click', function (e) { showUnit(this.zss, Lv); L.DomEvent.stop(e); });
            p.bindTooltip(u.n + ' · ' + u.c, { sticky: true });
            shapes.push(p);
          });
        });
        lvlGrp[String(Lv)] = L.layerGroup(shapes);
      });
      if (d.pts && d.pts.length) {
        lvlGrp['9'] = L.layerGroup(d.pts.map(function (q) {
          var m = L.circleMarker([q[2], q[3]], {
            renderer: rend, radius: 2.6, color: '#fff', weight: .9, opacity: .9,
            fillColor: '#fff', fillOpacity: .6, interactive: true
          });
          m.zss = { c: q[0], n: q[1] };
          m.on('click', function (e) { showUnit(this.zss, 9); L.DomEvent.stop(e); });
          m.bindTooltip(q[1] + ' · ' + q[0], { sticky: true });
          return m;
        }));
      }

      document.getElementById('dtitle').textContent = (D.cname[d.iso] || d.iso) + ' — L' + want;
      document.getElementById('detail').hidden = false;
      var all = Object.keys(lvlGrp).map(Number).sort(function (a, b) { return a - b; });
      document.getElementById('lvbtns').innerHTML = all.map(function (Lv) {
        var n = Lv === 9 ? d.pts.length : d.levels[String(Lv)].length;
        return '<button data-l="' + Lv + '">L' + Lv + ' · ' + fmt(n) + '</button>';
      }).join('');
      showLevels(); markLevelButtons(); crumbWith(d);
      map.fitBounds(L.latLngBounds([d.bbox[1], d.bbox[0]], [d.bbox[3], d.bbox[2]]), { padding: [22, 22] });
      note(fmt(d.levels[String(want)] ? d.levels[String(want)].length : d.pts.length)
        + ' units at L' + want + ', drawn from ' + d.src
        + '. Click one for its code; the level buttons switch depth; the layers control, top '
        + 'right, switches the imagery underneath.');
      wcrumb();
    });
  }

  function crumbWith(d) {
    var el = document.getElementById('wcrumb');
    var parts = ['<a data-nav="">World</a>'];
    nav.forEach(function (c) { parts.push('<a data-nav="' + c + '">' + TREE[c].n + '</a>'); });
    if (d) parts.push('<b>' + (D.cname[d.iso] || d.iso) + '</b>');
    el.innerHTML = parts.join('<span class="sep">\u203a</span>');
    var k = document.getElementById('wkey');
    if (d) {
      k.innerHTML = Object.keys(lvlGrp).map(Number).sort(function (a, b) { return a - b; })
        .map(function (Lv) {
          return '<span><i style="background:' + levelColor(Lv) + '"></i>L' + Lv
            + (Lv === 9 ? ' \u2014 settlements' : '') + '</span>';
        }).join('') + '<span class="hint">one level at a time \u2014 use the buttons below</span>';
    }
  }

  function levelColor(Lv) {
    var v = getComputedStyle(document.documentElement).getPropertyValue('--d' + Math.min(Lv, 9));
    return (v || '').trim() || '#4ea3d8';
  }
  function showLevels() {
    Object.keys(lvlGrp).forEach(function (k) {
      if (lvlOn[k]) { if (!map.hasLayer(lvlGrp[k])) lvlGrp[k].addTo(map); }
      else if (map.hasLayer(lvlGrp[k])) map.removeLayer(lvlGrp[k]);
    });
  }
  function markLevelButtons() {
    [].forEach.call(document.querySelectorAll('#lvbtns button[data-l]'), function (b) {
      b.setAttribute('aria-pressed', !!lvlOn[b.dataset.l]);
    });
    if (curData) {
      var on = Object.keys(lvlOn).filter(function (k) { return lvlOn[k]; })[0];
      if (on) document.getElementById('dtitle').textContent =
        (D.cname[curData.iso] || curData.iso) + ' — L' + on;
    }
  }

  function showUnit(u, Lv) {
    var box = document.getElementById('selbox');
    var kids = 0, setts = 0;
    if (curData) {
      var nx = curData.levels[String(Lv + 1)];
      if (nx) kids = nx.filter(function (q) { return q.c.indexOf(u.c + '.') === 0; }).length;
      setts = (curData.pts || []).filter(function (q) { return q[0].indexOf(u.c + '.') === 0; }).length;
    }
    box.innerHTML = '<div class="selbox"><h4>' + (u.n || '—') + '</h4>'
      + '<div class="c">' + u.c + '</div><p>L' + Lv + ', ' + u.c.split('.').length + ' segments'
      + (kids ? ' · ' + fmt(kids) + ' inside it' : '')
      + (setts ? ' · ' + fmt(setts) + ' settlements' : '') + '</p></div>';
  }

  /* leaving a country goes back to the region it sits in */
  var crumb = document.getElementById('wcrumb');
  crumb.addEventListener('click', function () { curCode = null; curData = null;
    Object.keys(lvlGrp).forEach(function (k) { map.removeLayer(lvlGrp[k]); }); lvlGrp = {};
    document.getElementById('detail').hidden = true; }, true);

  document.getElementById('uop').addEventListener('input', function () {
    if (curCode) drawOnMap(curCode, Object.keys(lvlOn).filter(function (k) { return lvlOn[k]; })[0]);
    else paintTiles();
  });

  var s = document.createElement('script');
  s.src = 'data/world.js';
  s.onerror = function () { note('data/world.js did not load — keep data/ beside index.html.'); };
  document.head.appendChild(s);
})();
