/**
 * Generic image preprocessing for tax/benchmark OCR.
 */
const { createCanvas, loadImage } = require("@napi-rs/canvas");

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function lum(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

function sharpenImageData(imageData) {
  const { data, width, height } = imageData;
  const copy = new Uint8ClampedArray(data);
  const kernel = [0,-1,0,-1,5,-1,0,-1,0];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      let r = 0, g = 0, b = 0;
      for (let ky = -1; ky <= 1; ky++) for (let kx = -1; kx <= 1; kx++) {
        const w = kernel[(ky+1)*3+(kx+1)];
        const s = ((y+ky)*width+(x+kx))*4;
        r += copy[s]*w; g += copy[s+1]*w; b += copy[s+2]*w;
      }
      data[idx]=clamp(Math.round(r),0,255); data[idx+1]=clamp(Math.round(g),0,255); data[idx+2]=clamp(Math.round(b),0,255);
    }
  }
}

function unsharpImageData(imageData, amount = 0.65) {
  const { data, width, height } = imageData;
  const copy = new Uint8ClampedArray(data);
  const blur = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    let sum = 0;
    for (let ky = -1; ky <= 1; ky++) for (let kx = -1; kx <= 1; kx++) {
      const i = ((y+ky)*width+(x+kx))*4; sum += lum(copy[i],copy[i+1],copy[i+2]);
    }
    blur[y*width+x] = sum/9;
  }
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = (y*width+x)*4;
    const o = lum(copy[i],copy[i+1],copy[i+2]);
    const v = clamp(Math.round(o + amount*(o-blur[y*width+x])),0,255);
    data[i]=v; data[i+1]=v; data[i+2]=v;
  }
}

function thresholdImageData(imageData, threshold) {
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    const v = lum(data[i],data[i+1],data[i+2]) >= threshold ? 255 : 0;
    data[i]=v; data[i+1]=v; data[i+2]=v;
  }
}

function otsuThreshold(imageData) {
  const { data } = imageData;
  const hist = new Uint32Array(256);
  let total = 0, sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const b = clamp(Math.round(lum(data[i],data[i+1],data[i+2])),0,255);
    hist[b]++; total++; sum += b;
  }
  let sumB = 0, wB = 0, maxVar = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const between = wB * wF * ((sumB/wB) - ((sum-sumB)/wF))**2;
    if (between > maxVar) { maxVar = between; threshold = t; }
  }
  return threshold;
}

function gammaCorrect(imageData, gamma = 1.35) {
  const { data } = imageData;
  const inv = 1 / gamma;
  for (let i = 0; i < data.length; i += 4) {
    const v = clamp(Math.round(255 * Math.pow(lum(data[i], data[i + 1], data[i + 2]) / 255, inv)), 0, 255);
    data[i] = v; data[i + 1] = v; data[i + 2] = v;
  }
}
function contrastStretch(imageData) {
  const { data } = imageData;
  let lo = 255, hi = 0;
  for (let i = 0; i < data.length; i += 4) {
    const l = lum(data[i],data[i+1],data[i+2]);
    if (l < lo) lo = l; if (l > hi) hi = l;
  }
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < data.length; i += 4) {
    const v = clamp(Math.round(((lum(data[i],data[i+1],data[i+2])-lo)/span)*255),0,255);
    data[i]=v; data[i+1]=v; data[i+2]=v;
  }
}

function medianDenoise(imageData) {
  const { data, width, height } = imageData;
  const copy = new Uint8ClampedArray(data);
  const w = [];
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    w.length = 0;
    for (let ky = -1; ky <= 1; ky++) for (let kx = -1; kx <= 1; kx++) {
      const i = ((y+ky)*width+(x+kx))*4; w.push(lum(copy[i],copy[i+1],copy[i+2]));
    }
    w.sort((a,b)=>a-b);
    const v = w[4]; const i = (y*width+x)*4;
    data[i]=v; data[i+1]=v; data[i+2]=v;
  }
}

function projectionScore(imageData, angleDeg) {
  const { width, height, data } = imageData;
  const rad = angleDeg * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const bins = new Float32Array(height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y*width+x)*4;
    if (lum(data[i],data[i+1],data[i+2]) < 200) {
      const bin = clamp(Math.round(y*cos - x*sin + width), 0, height-1);
      bins[bin]++;
    }
  }
  let mean = 0; for (let i = 0; i < height; i++) mean += bins[i]; mean /= height||1;
  let v = 0; for (let i = 0; i < height; i++) v += (bins[i]-mean)**2;
  return v/(height||1);
}

function estimateDeskewAngle(imageData) {
  let best = 0, score = -1;
  for (let a = -2.5; a <= 2.5; a += 0.5) {
    const s = projectionScore(imageData, a);
    if (s > score) { score = s; best = a; }
  }
  return best;
}

async function renderPageToImageData(buffer, options) {
  const image = await loadImage(Buffer.from(buffer));
  const scale = options.scale ?? 1;
  const angle = ((options.angle ?? 0) * Math.PI) / 180;
  const sw = Math.max(1, Math.round(image.width * scale));
  const sh = Math.max(1, Math.round(image.height * scale));
  const rw = Math.max(1, Math.ceil(Math.abs(sw*Math.cos(angle))+Math.abs(sh*Math.sin(angle))))+12;
  const rh = Math.max(1, Math.ceil(Math.abs(sw*Math.sin(angle))+Math.abs(sh*Math.cos(angle))))+12;
  const canvas = createCanvas(rw, rh);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0,0,rw,rh);
  ctx.translate(rw/2,rh/2);
  if (angle) ctx.rotate(angle);
  ctx.scale(scale,scale);
  ctx.filter = options.filter ?? "grayscale(1) contrast(1.55) brightness(1.06)";
  ctx.drawImage(image, -image.width/2, -image.height/2);
  return { canvas, imageData: ctx.getImageData(0,0,rw,rh) };
}

async function preprocessPageImage(buffer, options) {
  let { canvas, imageData } = await renderPageToImageData(buffer, options);
  const ctx = canvas.getContext("2d");
  if (options.denoise) medianDenoise(imageData);
  if (options.contrastStretch) contrastStretch(imageData);
  if (options.autoDeskew) {
    const detected = estimateDeskewAngle(imageData);
    if (Math.abs(detected) >= 0.25) {
      const redraw = await renderPageToImageData(buffer, { ...options, angle: (options.angle??0)+detected, autoDeskew: false });
      canvas = redraw.canvas; imageData = redraw.imageData;
      if (options.denoise) medianDenoise(imageData);
      if (options.contrastStretch) contrastStretch(imageData);
    }
  }
  if (options.gamma) gammaCorrect(imageData, options.gamma);
  if (options.unsharp) unsharpImageData(imageData);
  if (options.sharpen) sharpenImageData(imageData);
  if (options.adaptiveThreshold) thresholdImageData(imageData, otsuThreshold(imageData));
  else if (options.threshold !== undefined) thresholdImageData(imageData, options.threshold);
  ctx.putImageData(imageData, 0, 0);
  return canvas.toBuffer("image/png");
}

function buildTaxVariants({ heavy = false, hiDpi = false, scheduleL = false } = {}) {
  const base = [
    { name: "auto-deskew", scale: hiDpi ? 1.05 : 1.08, autoDeskew: true, contrastStretch: true, unsharp: true, filter: "grayscale(1) contrast(1.65) brightness(1.04)" },
    { name: "contrast-sharp", scale: hiDpi ? 1.06 : 1.1, contrastStretch: true, sharpen: true, filter: "grayscale(1) contrast(1.85) brightness(1.02)" },
    { name: "deskew-left", scale: hiDpi ? 1.04 : 1.08, angle: -1.25, contrastStretch: true, sharpen: true, threshold: 176, filter: "grayscale(1) contrast(1.75) brightness(1.04)" },
    { name: "deskew-right", scale: hiDpi ? 1.04 : 1.08, angle: 1.25, contrastStretch: true, sharpen: true, threshold: 176, filter: "grayscale(1) contrast(1.75) brightness(1.04)" },
    { name: "adaptive-bin", scale: hiDpi ? 1.08 : 1.12, adaptiveThreshold: true, denoise: true, filter: "grayscale(1) contrast(1.5) brightness(1.06)" },
    { name: "hi-contrast", scale: hiDpi ? 1.06 : 1.1, contrastStretch: true, unsharp: true, threshold: 172, filter: "grayscale(1) contrast(2) brightness(1)" },
    { name: "gamma-sharp", scale: hiDpi ? 1.07 : 1.1, gamma: 1.4, contrastStretch: true, sharpen: true, filter: "grayscale(1) contrast(1.7) brightness(1.03)" },
    { name: "gamma-deskew", scale: hiDpi ? 1.06 : 1.09, autoDeskew: true, gamma: 1.25, unsharp: true, filter: "grayscale(1) contrast(1.8) brightness(1.02)" },
  ];
  const sched = scheduleL ? [
    { name: "schedl-bin", scale: hiDpi ? 1.12 : 1.14, autoDeskew: true, gamma: 1.5, adaptiveThreshold: true, denoise: true, filter: "grayscale(1) contrast(2.1) brightness(0.98)" },
    { name: "schedl-sharp", scale: hiDpi ? 1.1 : 1.12, contrastStretch: true, sharpen: true, unsharp: true, filter: "grayscale(1) contrast(2.2) brightness(1)" },
  ] : [];
  const light = base.slice(0, 4);
  if (scheduleL) return [...light, ...sched, ...(heavy ? base.slice(4) : [])];
  return heavy ? base : light;
}

module.exports = { preprocessPageImage, sharpenImageData, thresholdImageData, estimateDeskewAngle, buildTaxVariants, gammaCorrect, contrastStretch, medianDenoise, unsharpImageData, otsuThreshold };
