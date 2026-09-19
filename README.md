# ZSS — the self-hosted build

Two pages that sit on a host of your own, where no content policy applies:

- **`index.html`** — the register. Atlas, the register table, the faults, the drawn Natural
  Earth basemap, the palette and opacity controls.
- **`map.html`** — the same boundaries on real tiles: OpenStreetMap, Carto dark and light,
  OpenTopoMap, and Esri satellite imagery, with settlements as points.

They link to each other in the nav.

## Why this exists

A page published as a Claude artifact runs under a content-security policy that allows external
scripts from four CDNs and fonts from Google, and blocks everything else — every image, every
fetch. A map tile is an image fetched from a tile server, so tiles cannot load there, and they
fail silently rather than with an error. That policy belongs to the host, not to the page.

Served from anywhere else, the same HTML has no such limit. Hence this build: live tiles, no
16 MB ceiling, and the data beside the page rather than inside it, so the browser caches it
instead of re-parsing it on every visit.

## Putting it online

1. Make a repository — call it `zss` — and put the contents of this folder at its root.

       git init
       git add .
       git commit -m "ZSS: register and tile map"
       git branch -M main
       git remote add origin https://github.com/<you>/zss.git
       git push -u origin main

2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   branch `main`, folder `/ (root)`. Save.

3. A minute later it is at `https://<you>.github.io/zss/`.

Public repository means a public site. For a private one, Netlify and Cloudflare Pages both take
a drag-and-drop of this folder and will serve it behind a password on their free tier.

## What is in here

    index.html          the register, atlas and faults
    map.html            the tile map
    data/site.js        everything index.html draws (~15 MB)
    data/index.js       the country list for map.html
    data/<code>.js      one file per country for map.html, loaded on demand
    lib/                Leaflet 1.9.4, BSD-2-Clause

Total is about 52 MB, well inside GitHub's limits (100 MB per file, 1 GB per Pages site).

## Sources

Boundaries from geoBoundaries (gbOpen) — CC BY 4.0 or ODbL depending on the country; see
`LICENSE.md` in the register. Context layers from Natural Earth, public domain. Settlement names
from GeoNames, CC BY 4.0. Codes, names and administrative structure: the ZSS register.
Tile providers are credited in the corner of the map, as their terms require.

The register's own files are not published here — only what these two pages draw.
