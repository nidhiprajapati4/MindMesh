import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import JSZip from 'jszip';
import { MongoMemoryServer } from 'mongodb-memory-server';

export const PROJECT_ID = 'demo-mindmesh-test';

/**
 * Starts an in-memory MongoDB and the real Express app. Auth runs in Firebase-emulator mode,
 * where the Admin SDK accepts unsigned tokens, so tests exercise the real verifyIdToken path.
 */
export async function startTestApi() {
  const mongo = await MongoMemoryServer.create();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGODB_URI: mongo.getUri('mindmesh_test'),
    FIREBASE_PROJECT_ID: PROJECT_ID,
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9',
    CLIENT_ORIGIN: 'http://localhost:3000',
  });
  const { adminAuth } = await import('../config/firebase.js');
  // The Admin SDK would call the Auth emulator over HTTP; check the same claims locally instead.
  adminAuth.verifyIdToken = (async (token: string) => {
    const [, payload] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString() || 'null');
    const now = Date.now() / 1000;
    if (!claims || claims.aud !== PROJECT_ID || claims.iss !== `https://securetoken.google.com/${PROJECT_ID}` || claims.exp < now || !claims.sub) {
      throw new Error('auth/argument-error');
    }
    return { ...claims, uid: claims.sub };
  }) as typeof adminAuth.verifyIdToken;
  const { connectDb } = await import('../config/db.js');
  const { app } = await import('../app.js');
  const mongoose = (await import('mongoose')).default;
  await connectDb();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base,
    async stop() {
      server.closeAllConnections(); // fetch keeps connections alive; close() alone would wait on them
      await new Promise((r) => server.close(r));
      await mongoose.disconnect();
      await mongo.stop();
    },
  };
}

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** An unsigned ID token in the shape the Firebase Auth emulator issues. */
export function emulatorToken(uid: string, email = `${uid}@example.test`) {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url({ alg: 'none', typ: 'JWT' }),
    b64url({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      auth_time: now,
      user_id: uid,
      sub: uid,
      iat: now,
      exp: now + 3600,
      email,
      firebase: { identities: {}, sign_in_provider: 'password' },
    }),
    '',
  ].join('.');
}

export type Res = { status: number; body: any };

export function client(base: string, token?: string) {
  const send = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + path, { method, headers, body: payload });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  return {
    get: (p: string) => send('GET', p),
    post: (p: string, b?: unknown) => send('POST', p, b),
    patch: (p: string, b?: unknown) => send('PATCH', p, b),
    del: (p: string) => send('DELETE', p),
    upload: (fileName: string, data: Buffer | string, fields: Record<string, string> = {}) => {
      const form = new FormData();
      form.append('file', new Blob([typeof data === 'string' ? data : new Uint8Array(data)]), fileName);
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      return send('POST', '/api/notes/upload', form);
    },
  };
}

/** Builds a minimal, valid one-page PDF containing the given lines of text. */
export function makePdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, '\\$&');
  const stream = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** Builds a minimal .docx with one paragraph per line. */
export async function makeDocx(lines: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      lines.map((l) => `<w:p><w:r><w:t>${l}</w:t></w:r></w:p>`).join('') +
      '</w:body></w:document>'
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}
