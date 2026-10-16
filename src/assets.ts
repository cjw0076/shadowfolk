import { AssetType, defineAssets } from '@iwsdk/core';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

export default defineAssets({
  'washi-paper': {
    url: publicAssetUrl('textures/washi.jpg'),
    type: AssetType.Texture,
    name: 'Kozo Washi Paper',
  },
  'lantern-paper': {
    url: publicAssetUrl('textures/lantern-paper.jpg'),
    type: AssetType.Texture,
    name: 'Chochin Lantern Paper',
  },
  'dark-wood': {
    url: publicAssetUrl('textures/dark-wood.jpg'),
    type: AssetType.Texture,
    name: 'Stained Chestnut Wood',
  },
  'ember-sprite': {
    url: publicAssetUrl('textures/ember.png'),
    type: AssetType.Texture,
    name: 'Lantern Ember',
  },
  'eye-glint': {
    url: publicAssetUrl('textures/eye-glint.png'),
    type: AssetType.Texture,
    name: 'Eye Glint',
  },
  'welcome-panel': {
    url: publicAssetUrl('ui/welcome.uikitml'),
    type: AssetType.UIKitML,
    name: 'Welcome Panel',
  },
});
