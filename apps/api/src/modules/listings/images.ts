import multer from 'multer';
import type { Request, Response } from 'express';
import { AppError } from '../../http/errors.js';
import { MAX_IMAGE_BYTES } from './constants.js';

export type ImageFormat = 'png' | 'jpeg';
export const IMAGE_TYPES: Record<ImageFormat, { mime: string; extension: string; names: readonly string[] }> = {
  png: { mime: 'image/png', extension: 'png', names: ['png'] },
  jpeg: { mime: 'image/jpeg', extension: 'jpg', names: ['jpg', 'jpeg'] },
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Detects the real image format from leading bytes; the client-declared type is ignored. */
export function sniffImage(data: Buffer): ImageFormat | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  return null;
}

/**
 * Removes metadata that could reveal the exact pickup location (EXIF GPS) or other details:
 * JPEG APP1 (EXIF/XMP) and APP13 segments, and PNG eXIf/tEXt/iTXt/zTXt chunks.
 * Returns null if the structure is malformed, in which case the upload is rejected.
 */
export function stripImageMetadata(data: Buffer, format: ImageFormat): Buffer | null {
  return format === 'jpeg' ? stripJpeg(data) : stripPng(data);
}

function stripJpeg(d: Buffer): Buffer | null {
  const out: Buffer[] = [d.subarray(0, 2)];
  let i = 2;
  while (i < d.length) {
    if (d[i] !== 0xff) return null;
    const marker = d[i + 1];
    if (marker === undefined) return null;
    if (marker === 0xff) { i += 1; continue; } // fill byte
    if (marker === 0xd9) { out.push(d.subarray(i)); return Buffer.concat(out); } // EOI
    if (marker === 0xda) { out.push(d.subarray(i)); return Buffer.concat(out); } // SOS: entropy-coded data follows
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { out.push(d.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > d.length) return null;
    const len = d.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > d.length) return null;
    if (marker !== 0xe1 && marker !== 0xed) out.push(d.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}

const DROP_PNG_CHUNKS = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt']);

function stripPng(d: Buffer): Buffer | null {
  const out: Buffer[] = [d.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= d.length) {
    const len = d.readUInt32BE(i);
    const end = i + 12 + len;
    if (end > d.length) return null;
    const type = d.toString('latin1', i + 4, i + 8);
    if (!DROP_PNG_CHUNKS.has(type)) out.push(d.subarray(i, end));
    i = end;
    if (type === 'IEND') return Buffer.concat(out);
  }
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 2, fieldSize: 256, parts: 4 },
  preservePath: true,
}).single('file');

export function parseImageUpload(req: Request, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    upload(req, res, (err: unknown) => {
      if (!err) return resolve();
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return reject(new AppError(413, 'FILE_TOO_LARGE', `Image is too large. The limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`));
      }
      reject(new AppError(400, 'UPLOAD_INVALID', 'The upload could not be processed. Send one image in the "file" field.'));
    });
  });
}
