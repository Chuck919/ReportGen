const fs = require("node:fs");
const path = require("node:path");
const target = path.join(__dirname, "ocr-preprocess.cjs");
let s = fs.readFileSync(target, "utf8").replace(/^\uFEFF/, "");
if (!s.includes("function gammaCorrect")) {
  s = s.replace("function contrastStretch(imageData)", `function gammaCorrect(imageData, gamma = 1.35) {
  const { data } = imageData;
  const inv = 1 / gamma;
  for (let i = 0; i < data.length; i += 4) {
    const v = clamp(Math.round(255 * Math.pow(lum(data[i], data[i + 1], data[i + 2]) / 255, inv)), 0, 255);
    data[i] = v; data[i + 1] = v; data[i + 2] = v;
  }
}
function contrastStretch(imageData)`);
}
if (!s.includes("if (options.gamma)")) {
  s = s.replace("  if (options.unsharp) unsharpImageData(imageData);", "  if (options.gamma) gammaCorrect(imageData, options.gamma);\n  if (options.unsharp) unsharpImageData(imageData);");
}
s = s.replace(/function buildTaxVariants[\s\S]*?\n\}/, `function buildTaxVariants({ heavy = false, hiDpi = false, scheduleL = false } = {}) {
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
}`);
s = s.replace(/module\.exports = \{[\s\S]*\};?/, `module.exports = { preprocessPageImage, sharpenImageData, thresholdImageData, estimateDeskewAngle, buildTaxVariants, gammaCorrect, contrastStretch, medianDenoise, unsharpImageData, otsuThreshold };`);
fs.writeFileSync(target, s, "utf8");
const m = require(target);
console.log("ok", m.buildTaxVariants({ scheduleL: true, heavy: true }).length);