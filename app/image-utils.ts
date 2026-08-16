export type Crop = { x: number; y: number; w: number; h: number };
export type Transform = { x: number; y: number; scale: number; rotation: number; flipX: boolean; flipY: boolean; straighten: number };
export type Filters = { brightness: number; contrast: number; grayscale: number; saturation: number; invert: boolean; sharpen: number };
export type OutputSettings = {
  format: "image/png" | "image/jpeg";
  quality: number;
  exif: "keep" | "remove";
  background: "#ffffff" | "#000000";
  targetBytes: number;
  filenameMode: "original" | "suffix" | "sequence";
  suffix: string;
};
export type EditState = {
  crop: Crop;
  outputWidth: number;
  outputHeight: number;
  lockAspect: boolean;
  transform: Transform;
  filters: Filters;
  output: OutputSettings;
};
export type SourceImage = {
  file: File;
  image: HTMLImageElement;
  width: number;
  height: number;
  url: string;
  exif: Uint8Array | null;
};

export const FULL_CROP: Crop = { x: 0, y: 0, w: 1, h: 1 };
export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0, flipX: false, flipY: false, straighten: 0 };
export const DEFAULT_FILTERS: Filters = { brightness: 100, contrast: 100, grayscale: 0, saturation: 100, invert: false, sharpen: 0 };
export const DEFAULT_OUTPUT: OutputSettings = {
  format: "image/png", quality: 0.9, exif: "remove", background: "#ffffff", targetBytes: 0,
  filenameMode: "suffix", suffix: "edited",
};

export function createInitialEdit(width: number, height: number, recent?: Partial<OutputSettings>): EditState {
  return {
    crop: { ...FULL_CROP }, outputWidth: width, outputHeight: height, lockAspect: true,
    transform: { ...DEFAULT_TRANSFORM }, filters: { ...DEFAULT_FILTERS },
    output: { ...DEFAULT_OUTPUT, ...recent },
  };
}

export function cloneEdit(edit: EditState): EditState {
  return JSON.parse(JSON.stringify(edit)) as EditState;
}

export function dimensionsForLongEdge(longEdge: number, aspect: number) {
  return aspect >= 1
    ? { width: Math.max(1, Math.round(longEdge)), height: Math.max(1, Math.round(longEdge / aspect)) }
    : { width: Math.max(1, Math.round(longEdge * aspect)), height: Math.max(1, Math.round(longEdge)) };
}

export function cropPixelDimensions(width: number, height: number, crop: Crop) {
  return { width: Math.max(1, Math.round(width * crop.w)), height: Math.max(1, Math.round(height * crop.h)) };
}

function extractExif(buffer: ArrayBuffer): Uint8Array | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 < bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) break;
    if (marker === 0xe1 && length >= 8) {
      const sig = String.fromCharCode(...bytes.slice(offset + 4, offset + 10));
      if (sig === "Exif\u0000\u0000") return bytes.slice(offset, offset + length + 2);
    }
    offset += length + 2;
  }
  return null;
}

export async function loadImageFile(file: File): Promise<SourceImage> {
  const [buffer] = await Promise.all([file.arrayBuffer()]);
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("画像を読み込めませんでした"));
    image.src = url;
  });
  return { file, image, width: image.naturalWidth, height: image.naturalHeight, url, exif: extractExif(buffer) };
}

function applySharpen(canvas: HTMLCanvasElement, amount: number) {
  if (amount <= 0) return;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  if (width * height > 18_000_000) return;
  const source = ctx.getImageData(0, 0, width, height);
  const out = ctx.createImageData(width, height);
  out.data.set(source.data);
  const s = source.data;
  const d = out.data;
  const strength = Math.min(1, amount / 100);
  const center = 1 + 4 * strength;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        d[i + c] = Math.max(0, Math.min(255,
          s[i + c] * center - strength * (s[i - 4 + c] + s[i + 4 + c] + s[i - width * 4 + c] + s[i + width * 4 + c])));
      }
    }
  }
  ctx.putImageData(out, 0, 0);
}

export function renderCanvas(
  source: SourceImage,
  edit: EditState,
  options: { before?: boolean; maxEdge?: number; width?: number; height?: number; jpegBackground?: boolean } = {},
): HTMLCanvasElement {
  const before = Boolean(options.before);
  let targetW = options.width ?? (before ? source.width : edit.outputWidth);
  let targetH = options.height ?? (before ? source.height : edit.outputHeight);
  if (options.maxEdge && Math.max(targetW, targetH) > options.maxEdge) {
    const ratio = options.maxEdge / Math.max(targetW, targetH);
    targetW = Math.max(1, Math.round(targetW * ratio));
    targetH = Math.max(1, Math.round(targetH * ratio));
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(targetW));
  canvas.height = Math.max(1, Math.round(targetH));
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) throw new Error("Canvasを利用できません");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (options.jpegBackground) {
    ctx.fillStyle = edit.output.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  if (before) {
    const fit = Math.min(canvas.width / source.width, canvas.height / source.height);
    const w = source.width * fit;
    const h = source.height * fit;
    ctx.drawImage(source.image, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    return canvas;
  }

  const crop = edit.crop;
  const sx = Math.round(crop.x * source.width);
  const sy = Math.round(crop.y * source.height);
  const sw = Math.max(1, Math.round(crop.w * source.width));
  const sh = Math.max(1, Math.round(crop.h * source.height));
  const t = edit.transform;
  const f = edit.filters;
  ctx.save();
  ctx.translate(canvas.width * (0.5 + t.x), canvas.height * (0.5 + t.y));
  ctx.rotate(((t.rotation + t.straighten) * Math.PI) / 180);
  ctx.scale(t.scale * (t.flipX ? -1 : 1), t.scale * (t.flipY ? -1 : 1));
  ctx.filter = `brightness(${f.brightness}%) contrast(${f.contrast}%) grayscale(${f.grayscale}%) saturate(${f.saturation}%) invert(${f.invert ? 100 : 0}%)`;
  ctx.drawImage(source.image, sx, sy, sw, sh, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
  ctx.restore();
  if (f.sharpen > 0) applySharpen(canvas, f.sharpen);
  return canvas;
}

export function canvasBlob(canvas: HTMLCanvasElement, type: "image/png" | "image/jpeg", quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("書き出しに失敗しました")), type, quality));
}

function normalizeExifOrientation(segment: Uint8Array): Uint8Array {
  const out = segment.slice();
  try {
    const tiff = 10;
    const little = out[tiff] === 0x49 && out[tiff + 1] === 0x49;
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const ifdOffset = view.getUint32(tiff + 4, little);
    const ifd = tiff + ifdOffset;
    const count = view.getUint16(ifd, little);
    for (let i = 0; i < count; i += 1) {
      const entry = ifd + 2 + i * 12;
      if (view.getUint16(entry, little) === 0x0112) view.setUint16(entry + 8, 1, little);
    }
  } catch { /* malformed EXIF is left untouched */ }
  return out;
}

function insertExif(jpeg: Blob, exif: Uint8Array): Promise<Blob> {
  return jpeg.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return jpeg;
    const normalized = normalizeExifOrientation(exif);
    const merged = new Uint8Array(bytes.length + normalized.length);
    merged.set(bytes.slice(0, 2), 0);
    merged.set(normalized, 2);
    merged.set(bytes.slice(2), 2 + normalized.length);
    return new Blob([merged], { type: "image/jpeg" });
  });
}

export type ExportResult = { blob: Blob; width: number; height: number; quality: number; targetMet: boolean };

export async function exportEdited(source: SourceImage, edit: EditState): Promise<ExportResult> {
  const isJpeg = edit.output.format === "image/jpeg";
  let width = edit.outputWidth;
  let height = edit.outputHeight;
  let quality = edit.output.quality;
  let blob: Blob;
  let canvas = renderCanvas(source, edit, { width, height, jpegBackground: isJpeg });
  blob = await canvasBlob(canvas, edit.output.format, quality);
  const target = isJpeg ? edit.output.targetBytes : 0;

  if (target > 0 && blob.size > target) {
    let low = 0.25;
    let high = quality;
    let best = blob;
    let bestQuality = quality;
    for (let i = 0; i < 7; i += 1) {
      const q = (low + high) / 2;
      const candidate = await canvasBlob(canvas, "image/jpeg", q);
      if (candidate.size <= target) { best = candidate; bestQuality = q; low = q; }
      else high = q;
    }
    blob = best;
    quality = bestQuality;
    for (let pass = 0; pass < 4 && blob.size > target; pass += 1) {
      const factor = Math.max(0.55, Math.sqrt(target / blob.size) * 0.94);
      width = Math.max(64, Math.round(width * factor));
      height = Math.max(64, Math.round(height * factor));
      canvas = renderCanvas(source, edit, { width, height, jpegBackground: true });
      blob = await canvasBlob(canvas, "image/jpeg", 0.55);
      quality = 0.55;
    }
  }
  if (isJpeg && edit.output.exif === "keep" && source.exif) blob = await insertExif(blob, source.exif);
  return { blob, width, height, quality, targetMet: target === 0 || blob.size <= target };
}

export async function estimateBytes(source: SourceImage, edit: EditState): Promise<number> {
  const canvas = renderCanvas(source, edit, { maxEdge: 900, jpegBackground: edit.output.format === "image/jpeg" });
  const blob = await canvasBlob(canvas, edit.output.format, edit.output.quality);
  const fullPixels = edit.outputWidth * edit.outputHeight;
  const samplePixels = canvas.width * canvas.height;
  return Math.max(blob.size, Math.round(blob.size * Math.pow(fullPixels / samplePixels, 0.86)));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function outputFilename(original: string, edit: EditState, index?: number): string {
  const ext = edit.output.format === "image/png" ? "png" : "jpg";
  const base = original.replace(/\.[^.]+$/, "") || "image";
  if (edit.output.filenameMode === "original") return `${base}.${ext}`;
  if (edit.output.filenameMode === "sequence") return `IMG_${String((index ?? 0) + 1).padStart(3, "0")}_${edit.output.suffix || "edited"}.${ext}`;
  return `${base}_${edit.output.suffix || "edited"}.${ext}`;
}
