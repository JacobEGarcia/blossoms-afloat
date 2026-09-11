# Blossoms Afloat

Flowers dropping into sea water. A real-time three.js shader study, built after
[@ann_nnng's post](https://x.com/ann_nnng/status/2098353630848160192).

- Procedural voronoi caustics on the pool floor
- Custom water-surface shader: wave normals, fresnel, sun glints, expanding ripple rings + foam on every impact
- Four procedural blossoms (pink hibiscus, bright hibiscus, white lily, plumeria) built from parametric petal geometry with canvas-painted gradient textures
- Click the water to drop a flower: fall, splash droplets, ripple, then it floats, bobs and drifts
- "Clear the water" drains the pool

No build step. Static HTML + ES modules, three.js from CDN.
