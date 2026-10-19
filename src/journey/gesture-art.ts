import type { Ability } from './generator.js';

export function gestureInk(ability: Ability): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 192;
  canvas.height = 112;
  const brush = canvas.getContext('2d', { willReadFrequently: true })!;
  brush.lineCap = 'round';
  brush.lineJoin = 'round';
  brush.strokeStyle = '#261713';
  brush.lineWidth = 5;
  const stroke = (fromX: number, fromY: number, controlX: number, controlY: number, toX: number, toY: number) => {
    brush.beginPath();
    brush.moveTo(fromX, fromY);
    brush.quadraticCurveTo(controlX, controlY, toX, toY);
    brush.stroke();
  };
  if (ability === 'bark') {
    for (let index = 0; index < 3; index++) {
      const x = 32 + index * 34;
      stroke(x, 32 - index * 5, x + 25, 56, x, 80 + index * 4);
    }
  } else if (ability === 'peck' || ability === 'snip') {
    stroke(36, 26, 80, 62, 146, 91);
    stroke(58, 92, 110, 48, 153, 26);
    brush.lineWidth = 3;
    stroke(109, 15, 100, 54, 104, 88);
  } else if (ability === 'hop') {
    stroke(23, 91, 94, -12, 170, 91);
    brush.lineWidth = 3;
    stroke(50, 87, 64, 91, 76, 94);
    stroke(126, 94, 142, 91, 156, 87);
  } else if (ability === 'fan' || ability === 'fly') {
    for (let index = 0; index < 4; index++) {
      const y = 21 + index * 23;
      stroke(16, y, 88, y + (index % 2 ? 24 : -25), 178, y);
    }
  } else if (ability === 'giant') {
    for (let index = 0; index < 4; index++) {
      const x = 34 + index * 36;
      stroke(x, 18, x - 11, 55, x + 7, 98);
    }
  } else {
    for (let index = 0; index < 3; index++) {
      const x = 53 + index * 42;
      stroke(x - 10, 31, x, 18, x + 10, 31);
      stroke(x - 10, 81, x, 94, x + 10, 81);
    }
  }
  const glint = brush.createRadialGradient(96, 56, 1, 96, 56, 27);
  glint.addColorStop(0, 'rgba(255, 237, 172, 0.95)');
  glint.addColorStop(0.35, 'rgba(228, 151, 74, 0.65)');
  glint.addColorStop(1, 'rgba(228, 151, 74, 0)');
  brush.fillStyle = glint;
  brush.fillRect(68, 28, 56, 56);
  return canvas;
}
