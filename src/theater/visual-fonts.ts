const base = import.meta.env?.BASE_URL ?? './';

const playfairRegular = new FontFace('Playfair Display', `url(${base}fonts/playfair-display-latin-regular.woff2)`, {
  style: 'normal', weight: '400',
});
const playfairItalic = new FontFace('Playfair Display', `url(${base}fonts/playfair-display-latin-italic.woff2)`, {
  style: 'italic', weight: '400',
});

export const playfairReady = Promise.all([playfairRegular.load(), playfairItalic.load()])
  .then(faces => {
    for (const face of faces) document.fonts.add(face);
    return document.fonts.ready.then(() => true);
  })
  .catch(() => false);
