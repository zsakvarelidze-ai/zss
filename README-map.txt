ZSS on OpenStreetMap
====================

Unzip this folder anywhere, then open  index.html  in a browser.
Keep index.html, index.js, lib/ and data/ together -- the page loads each
country from data/ as you pick it.

You need to be online: the boundaries ship with the folder, but the basemap
tiles come from the tile servers.

  Basemaps      OpenStreetMap, Carto dark, Carto light, OpenTopoMap,
                Satellite (Esri).  Switch top right.
  Levels        L4 to L9, each its own checkbox.  L9 is settlements, drawn
                as points.  Two levels are on when a country opens.
  Click         any unit -> its ZSS code, its level, how many segments the
                code has, its children, its settlements.
  Find          a name or a whole code, e.g.  4.3.14.2.14

Why this is a file and not a web page: a published artifact runs under a
content-security policy that blocks every image and every network request
except scripts from four CDNs and fonts from Google.  A map tile is an image
fetched from a tile server, so tiles cannot load there -- silently, with no
error.  Opened from your own disk, this page is under no such policy.

Sources
  Boundaries    geoBoundaries (gbOpen), CC BY 4.0 or ODbL depending on the
                country -- see LICENSE.md in the register.
  Settlements   GeoNames, CC BY 4.0.
  Codes, names  the ZSS register.
  Leaflet       1.9.4, BSD-2-Clause, in lib/.
  Tiles         credited in the corner of the map, as their terms require.
