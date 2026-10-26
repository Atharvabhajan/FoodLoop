import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import multer from 'multer';
import type { Db } from '../../db/client.js';
import { verificationDocuments, type DocumentType, type VerificationDocument } from '../../db/schema.js';
import { AppError, errors } from '../../http/errors.js';
import type { FileStorage } from '../../storage/index.js';
import type { Actor, OrganizationService } from './service.js';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENTS_PER_ORG = 10;

const TYPES = {
  pdf: { mime: 'application/pdf', extensions: ['pdf'] },
  png: { mime: 'image/png', extensions: ['png'] },
  jpeg: { mime: 'image/jpeg', extensions: ['jpg', 'jpeg'] },
} as const;

/** Detects the real format from the file's leading bytes; the client-declared type is never trusted. */
export function sniffFormat(data: Buffer): keyof typeof TYPES | null {
  if (data.length >= 5 && data.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  return null;
}

/** Returns a safe display name, or null if the name looks like a path or contains control characters. */
export function safeDisplayFilename(raw: string): string | null {
  const name = raw.normalize('NFC').trim();
  if (name.length === 0 || name.length > 120) return null;
  // eslint-disable-next-line no-control-regex
  if (/[/\\\u0000-\u001f\u007f]/.test(name)) return null;
  if (name === '.' || name === '..' || name.split('.').every((p) => p === '')) return null;
  if (name.includes('..')) return null;
  return name;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5, fieldSize: 1024, parts: 8 },
  // Keep the raw client filename so unsafe paths are rejected instead of silently stripped.
  preservePath: true,
}).single('file');

export function parseUpload(req: Request, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    upload(req, res, (err: unknown) => {
      if (!err) return resolve();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return reject(new AppError(413, 'FILE_TOO_LARGE', `File is too large. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`));
        }
        return reject(new AppError(400, 'UPLOAD_INVALID', 'The upload could not be processed. Send one file in the "file" field.'));
      }
      // Anything else from the multipart parser (malformed or truncated body) is a client error.
      reject(new AppError(400, 'UPLOAD_INVALID', 'The upload could not be processed. Send one file in the "file" field.'));
    });
  });
}

export function serializeDocument(d: VerificationDocument) {
  // storageKey and sha256 are deliberately omitted.
  return {
    id: d.id,
    documentType: d.documentType,
    originalFilename: d.originalFilename,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    reviewStatus: d.reviewStatus,
    createdAt: d.createdAt,
  };
}

export function createDocumentService(db: Db, storage: FileStorage, orgs: OrganizationService) {
  return {
    async list(actor: Actor, orgId: string) {
      await orgs.resolve(actor, orgId, 'read');
      const rows = await db
        .select()
        .from(verificationDocuments)
        .where(eq(verificationDocuments.organizationId, orgId))
        .orderBy(asc(verificationDocuments.createdAt));
      return rows.map(serializeDocument);
    },

    async add(actor: Actor, orgId: string, documentType: DocumentType, file: Express.Multer.File | undefined) {
      const { org } = await orgs.resolve(actor, orgId, 'manage');
      orgs.assertEditable(org);
      if (!file) throw new AppError(400, 'FILE_REQUIRED', 'Attach a file in the "file" field.', { fields: { file: 'A file is required.' } });

      const displayName = safeDisplayFilename(file.originalname ?? '');
      if (!displayName) {
        throw new AppError(400, 'INVALID_FILENAME', 'The file name is not allowed.', { fields: { file: 'Rename the file without path characters.' } });
      }
      if (file.size === 0) throw new AppError(400, 'UPLOAD_INVALID', 'The file is empty.', { fields: { file: 'The file is empty.' } });
      const format = sniffFormat(file.buffer);
      const ext = displayName.includes('.') ? displayName.split('.').pop()!.toLowerCase() : '';
      const allowedExt: readonly string[] = format ? TYPES[format].extensions : [];
      if (!format || !allowedExt.includes(ext)) {
        throw new AppError(415, 'UNSUPPORTED_FILE_TYPE', 'Only PDF, PNG and JPEG files are accepted.', {
          fields: { file: 'Only PDF, PNG and JPEG files are accepted.' },
        });
      }

      const existing = await db
        .select({ id: verificationDocuments.id })
        .from(verificationDocuments)
        .where(eq(verificationDocuments.organizationId, orgId));
      if (existing.length >= MAX_DOCUMENTS_PER_ORG) {
        throw new AppError(409, 'DOCUMENT_LIMIT_REACHED', `An organization can have at most ${MAX_DOCUMENTS_PER_ORG} documents.`);
      }

      const key = await storage.save(`org-${orgId}`, allowedExt[0]!, file.buffer);
      try {
        const [row] = await db
          .insert(verificationDocuments)
          .values({
            organizationId: orgId,
            documentType,
            originalFilename: displayName,
            mimeType: TYPES[format].mime,
            sizeBytes: file.size,
            sha256: createHash('sha256').update(file.buffer).digest('hex'),
            storageKey: key,
            uploadedBy: actor.id,
          })
          .returning();
        return serializeDocument(row!);
      } catch (err) {
        await storage.remove(key).catch(() => undefined);
        throw err;
      }
    },

    async remove(actor: Actor, orgId: string, docId: string) {
      const { org } = await orgs.resolve(actor, orgId, 'manage');
      orgs.assertEditable(org);
      const [doc] = await db
        .delete(verificationDocuments)
        .where(and(eq(verificationDocuments.id, docId), eq(verificationDocuments.organizationId, orgId)))
        .returning();
      if (!doc) throw errors.notFound('Document not found.');
      await storage.remove(doc.storageKey).catch(() => undefined);
    },

    /** Authorization (member of the owning org, or admin) is checked before the file is opened. */
    async open(actor: Actor, orgId: string, docId: string) {
      await orgs.resolve(actor, orgId, 'read');
      const [doc] = await db
        .select()
        .from(verificationDocuments)
        .where(and(eq(verificationDocuments.id, docId), eq(verificationDocuments.organizationId, orgId)))
        .limit(1);
      if (!doc) throw errors.notFound('Document not found.');
      return { doc, stream: storage.open(doc.storageKey) };
    },
  };
}

export type DocumentService = ReturnType<typeof createDocumentService>;
