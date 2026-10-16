# Shadowfolk texture credits

All five textures were created for this project on 2026-10-16. The three material sources are original OpenAI built-in `image_gen` outputs; `collab/codex/visual/` retains the source references. The final 1024² JPEGs were resized and seam-blended with `collab/codex/visual/prepare-textures.cjs`. The PNG sprites were created by that same script.

| File | Generator | Prompt |
|---|---|---|
| `washi.jpg` | OpenAI built-in `image_gen` | “A seamless, square, straight-on scan of unbleached Japanese mulberry washi, neutral warm ivory `#eadbc0`, fine irregular translucent kozo fibres at 12–45 mm real scale, sparse tiny bark inclusions, tactile handmade pulp. Even diffuse colour; no lantern light, vignette, shadow, silhouettes, frame, text, perspective or border.” |
| `lantern-paper.jpg` | OpenAI built-in `image_gen` | “A seamless, square, flat cylindrical-UV chōchin paper swatch: cream kozo fibres with about 12 regular horizontal warm-brown bamboo rib shadows, faint handmade seams. No baked glow, hotspot, vignette, dark caps, object, text or perspective.” |
| `dark-wood.jpg` | OpenAI built-in `image_gen` | “A seamless, square, flat PBR albedo swatch of aged Japanese chestnut, very dark smoked walnut/chestnut `#241610`, fine longitudinal grain, tiny pores and subtle rubbed tung-oil satin character. No planks, highlights, cast shadows, perspective, bevels, border or text.” |
| `ember.png` | Procedural `prepare-textures.cjs` | “Centered soft additive mote with ivory core, amber middle and burnt-orange falloff to zero alpha, without a hard ring.” |
| `eye-glint.png` | Procedural `prepare-textures.cjs` | “Centered warm-ivory pupil highlight with amber halo fading to zero alpha.” |
