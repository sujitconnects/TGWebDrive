import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

const THUMB_DIR = path.join(DATA_DIR, "thumbs");
fs.mkdirSync(THUMB_DIR, { recursive: true });

export function thumbCachePath(key) {
  return path.join(THUMB_DIR, `${key}.jpg`);
}

// Generate a small JPEG thumbnail from an image path or buffer.
export async function generateThumb(input, outPath) {
  let source = input;
  try {
    source = await sharp(input).rotate().toBuffer();
  } catch {
    const heicConvert = (await import("heic-convert")).default;
    const buffer = Buffer.isBuffer(input) ? input : await fs.promises.readFile(input);
    source = Buffer.from(await heicConvert({ buffer, format: "JPEG", quality: 0.82 }));
  }
  const pipeline = sharp(source, { failOn: "none" }).resize(480, 480, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 78 });
  if (outPath) {
    await pipeline.toFile(outPath);
    return outPath;
  }
  return pipeline.toBuffer();
}

export const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|tiff?|avif|heic|heif)$/i;
