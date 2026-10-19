// A deterministic, code-painted landscape. No external images or personal files.
export function landscape(): ImageData {
  const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 900;
  const c = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })!;
  const sky = c.createLinearGradient(0, 0, 0, 650);
  sky.addColorStop(0, '#94afbd'); sky.addColorStop(.65, '#c3cdd0'); sky.addColorStop(1, '#dde0da');
  c.fillStyle = sky; c.fillRect(0, 0, 1200, 900);
  let seed = 1847;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  // Mist, distant ridges and a lake. The sample is deliberately not presented as a photograph.
  c.fillStyle = '#829da7'; c.beginPath(); c.moveTo(0, 540);
  c.bezierCurveTo(120, 510, 260, 460, 390, 484); c.bezierCurveTo(560, 515, 640, 405, 800, 452);
  c.bezierCurveTo(990, 480, 1070, 445, 1200, 490); c.lineTo(1200, 700); c.lineTo(0, 700); c.fill();
  c.fillStyle = '#657f8b'; c.beginPath(); c.moveTo(0, 570);
  c.bezierCurveTo(150, 470, 340, 350, 490, 421); c.bezierCurveTo(610, 460, 630, 550, 780, 566);
  c.lineTo(1200, 615); c.lineTo(1200, 730); c.lineTo(0, 730); c.fill();
  const lake = c.createLinearGradient(0, 585, 0, 900);
  lake.addColorStop(0, '#9aafb6'); lake.addColorStop(.22, '#6f909e'); lake.addColorStop(1, '#375d70');
  c.fillStyle = lake; c.fillRect(0, 590, 1200, 310);
  for (let i = 0; i < 280; i++) {
    const x = random() * 1200, y = 600 + random() * 300;
    c.strokeStyle = i % 3 === 0 ? 'rgba(220,229,225,.22)' : 'rgba(39,71,86,.13)';
    c.lineWidth = 1 + (y - 600) / 250; c.beginPath(); c.moveTo(x, y); c.lineTo(x + 6 + random() * 80, y); c.stroke();
  }
  c.fillStyle = '#344d4a'; c.beginPath(); c.moveTo(0, 900); c.lineTo(0, 560);
  c.bezierCurveTo(95, 625, 120, 682, 194, 707); c.bezierCurveTo(240, 728, 241, 783, 300, 803);
  c.bezierCurveTo(420, 839, 445, 863, 510, 900); c.closePath(); c.fill();
  c.fillStyle = '#4e6252'; c.beginPath(); c.moveTo(0, 900); c.lineTo(0, 760); c.bezierCurveTo(115, 798, 194, 830, 285, 900); c.fill();
  c.strokeStyle = '#e5dbbd'; c.lineWidth = 4; c.beginPath(); c.moveTo(815, 718); c.lineTo(858, 718); c.stroke();
  c.strokeStyle = '#d6d7c9'; c.lineWidth = 2; c.beginPath(); c.moveTo(838, 717); c.lineTo(838, 675); c.stroke();
  c.fillStyle = '#f0e9d8'; c.beginPath(); c.moveTo(833, 679); c.lineTo(833, 708); c.lineTo(808, 708); c.fill();
  const data = c.getImageData(0, 0, 1200, 900, { colorSpace: 'srgb' }); canvas.width = canvas.height = 0;
  return data;
}
