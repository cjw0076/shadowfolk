/**
 * Shadowfolk — a hand-shadow theater for Meta Quest (IWSDK / WebXR).
 */
import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { PanelSystem } from './panel.js';
import { TheaterSystem } from './theater/theater-system.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(TheaterSystem);
  world.registerSystem(PanelSystem);
});
