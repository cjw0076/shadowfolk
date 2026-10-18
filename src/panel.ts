/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, UIKitMLAsset, VisibilityState } from '@iwsdk/core';
import { capturing } from './capture.js';

export class PanelSystem extends createSystem({}) {
  init(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('welcome-panel');
    // Filming: the theater alone, without the 2D welcome panel.
    if (panel && capturing) panel.visible = false;
    const xrButton = panel?.getElementById('xr-button');
    const exitButton = panel?.getElementById('exit-button');
    if (xrButton == null || exitButton == null) {
      return;
    }
    if (!this.world.xrEnabled) {
      xrButton.setProperties({ display: 'none' });
      exitButton.setProperties({ display: 'none' });
      return;
    }

    // No immersive-ar here (a desktop browser): say how to play instead of failing silently.
    const xrLabel = panel?.getElementById('xr-label');
    const xrNote = panel?.getElementById('xr-note');
    let canEnter = true;
    const explain = () => {
      xrLabel?.setProperties({ text: 'Play it on Meta Quest' });
      xrNote?.setProperties({ display: 'flex' });
    };
    void navigator.xr?.isSessionSupported('immersive-ar').then((ok) => {
      canEnter = ok;
      if (!ok) xrLabel?.setProperties({ text: 'Play it on Meta Quest' });
    }).catch(() => { canEnter = false; });
    if (!navigator.xr) canEnter = false;
    const launchXR = () => {
      if (!canEnter) { explain(); return; }
      try {
        const started = this.world.launchXR() as unknown;
        if (started instanceof Promise) started.catch(explain);
      } catch { explain(); }
    };
    const exitXR = () => this.world.exitXR();
    xrButton.addEventListener('click', launchXR);
    exitButton.addEventListener('click', exitXR);
    this.cleanupFuncs.push(
      () => xrButton.removeEventListener('click', launchXR),
      () => exitButton.removeEventListener('click', exitXR),
      this.world.visibilityState.subscribe((visibilityState) => {
        const is2D = visibilityState === VisibilityState.NonImmersive;
        xrButton.setProperties({ display: is2D ? 'flex' : 'none' });
        exitButton.setProperties({ display: is2D ? 'none' : 'flex' });
        // In the headset the theater is the whole interface: hide the panel.
        if (panel) panel.visible = is2D && !capturing;
      }),
    );
  }
}
