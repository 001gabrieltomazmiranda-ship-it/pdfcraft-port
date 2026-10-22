/**
 * Selo de cera + certificado ("Cifrar Certificado").
 *
 * - Desenha um selo de cera (imagem) no ponto escolhido e usa esse selo como a aparência
 *   de uma ASSINATURA DIGITAL de verdade (PKCS#7 destacada, SHA-256), feita com um
 *   certificado próprio do app ("PDFCraft Selo de Cera", autoassinado, criado no aparelho).
 *   Qualquer alteração posterior no arquivo aparece como assinatura inválida.
 * - Opcional: protege o PDF com senha para abrir (AES de 256 bits).
 */

import type { ProcessInput, ProcessOutput, ProgressCallback } from '@/types/pdf';
import { PDFErrorCode } from '@/types/pdf';
import { BasePDFProcessor } from '../processor';
import { loadPdfLib } from '../loader';
import { loadZga, zgaSign, hasSignatures } from '../zga';
import { findPdfSignatures, inspectPdfSignature } from '../signature-inspect';
import { tr } from '../ui-lang';

export interface CertCryptorOptions {
  waxColor: 'gold' | 'red' | 'bronze';
  /** página do selo (0 = primeira) */
  sealPage?: number;
  /** posição do centro do selo em frações da página (0..1, a partir do canto de cima à esquerda) */
  sealFx?: number;
  sealFy?: number;
  /** (antigo) centro do selo em pontos do PDF, origem embaixo à esquerda, numa página A4 */
  sealX?: number;
  sealY?: number;
  /** senha para abrir o PDF quando a proteção com senha está ligada */
  pfxPassword?: string;
  /** liga a proteção com senha (AES-256) */
  encryptWithCert?: boolean;
  /** tamanho do selo em pontos */
  sealSize?: number;
}

const PALETTES = {
  gold: { base: '#c9971f', light: '#f6d873', dark: '#6f4d06' },
  red: { base: '#a3161a', light: '#e8696b', dark: '#4e0507' },
  bronze: { base: '#8c5a2b', light: '#d29d63', dark: '#3f240c' },
} as const;

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Desenha o selo de cera numa imagem PNG (fundo transparente). */
export async function drawWaxSealPng(color: keyof typeof PALETTES, px = 300): Promise<Uint8Array> {
  if (typeof document === 'undefined') throw new Error('canvas not available');
  const pal = PALETTES[color] || PALETTES.gold;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas not available');
  const c = px / 2;
  const R = px * 0.43;

  // cera derretida: borda irregular, com sombra embaixo
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.38)';
  ctx.shadowBlur = px * 0.05;
  ctx.shadowOffsetX = px * 0.012;
  ctx.shadowOffsetY = px * 0.02;
  ctx.beginPath();
  const N = 48;
  const pts: [number, number][] = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = R * (1 + 0.045 * Math.sin(i * 2.7) + 0.03 * Math.sin(i * 5.3 + 1.3) + 0.02 * Math.cos(i * 9.1));
    pts.push([c + Math.cos(a) * r, c + Math.sin(a) * r]);
  }
  for (let i = 0; i < N; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % N];
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    if (i === 0) ctx.moveTo(mx, my);
    else ctx.quadraticCurveTo(x0, y0, mx, my);
  }
  ctx.quadraticCurveTo(pts[0][0], pts[0][1], (pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
  ctx.closePath();
  const g = ctx.createRadialGradient(c - R * 0.4, c - R * 0.45, R * 0.05, c, c, R * 1.15);
  g.addColorStop(0, pal.light);
  g.addColorStop(0.45, pal.base);
  g.addColorStop(1, pal.dark);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();

  // disco prensado no meio (um pouco mais fundo)
  const r2 = R * 0.7;
  const g2 = ctx.createRadialGradient(c + r2 * 0.3, c + r2 * 0.35, r2 * 0.1, c, c, r2);
  g2.addColorStop(0, pal.light);
  g2.addColorStop(0.55, pal.base);
  g2.addColorStop(1, pal.dark);
  ctx.beginPath();
  ctx.arc(c, c, r2, 0, Math.PI * 2);
  ctx.fillStyle = g2;
  ctx.fill();
  // borda do disco: sombra em cima, brilho embaixo (efeito afundado)
  const edge = ctx.createLinearGradient(c - r2, c - r2, c + r2, c + r2);
  edge.addColorStop(0, pal.dark);
  edge.addColorStop(1, pal.light);
  ctx.lineWidth = px * 0.022;
  ctx.strokeStyle = edge;
  ctx.stroke();

  // pontinhos em volta
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const x = c + Math.cos(a) * R * 0.84;
    const y = c + Math.sin(a) * R * 0.84;
    ctx.beginPath();
    ctx.arc(x + px * 0.003, y + px * 0.003, px * 0.009, 0, Math.PI * 2);
    ctx.fillStyle = pal.dark;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, px * 0.008, 0, Math.PI * 2);
    ctx.fillStyle = pal.light;
    ctx.fill();
  }

  // brasão: escudo com "visto", em alto-relevo (sombra + brilho + base)
  const shield = (dx: number, dy: number) => {
    const w = r2 * 0.95;
    const h = r2 * 1.12;
    const x = c - w / 2 + dx;
    const y = c - h / 2 + dy;
    ctx.beginPath();
    ctx.moveTo(x, y + h * 0.12);
    ctx.quadraticCurveTo(x + w / 2, y - h * 0.06, x + w, y + h * 0.12);
    ctx.lineTo(x + w, y + h * 0.5);
    ctx.quadraticCurveTo(x + w, y + h * 0.85, x + w / 2, y + h);
    ctx.quadraticCurveTo(x, y + h * 0.85, x, y + h * 0.5);
    ctx.closePath();
  };
  const check = (dx: number, dy: number) => {
    ctx.beginPath();
    ctx.moveTo(c - r2 * 0.26 + dx, c + r2 * 0.02 + dy);
    ctx.lineTo(c - r2 * 0.06 + dx, c + r2 * 0.24 + dy);
    ctx.lineTo(c + r2 * 0.3 + dx, c - r2 * 0.2 + dy);
  };
  const o = px * 0.008;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = px * 0.018;
  shield(o, o);
  ctx.strokeStyle = pal.dark;
  ctx.stroke();
  shield(-o, -o);
  ctx.strokeStyle = pal.light;
  ctx.stroke();
  shield(0, 0);
  ctx.fillStyle = pal.base;
  ctx.fill();
  ctx.lineWidth = px * 0.04;
  check(o, o);
  ctx.strokeStyle = pal.dark;
  ctx.stroke();
  check(-o * 0.7, -o * 0.7);
  ctx.strokeStyle = pal.light;
  ctx.stroke();

  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  if (blob) return new Uint8Array(await blob.arrayBuffer());
  const url = canvas.toDataURL('image/png');
  const bin = atob(url.split(',')[1] || '');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface SealIdentity {
  p12: Uint8Array;
  pwd: string;
  name: string;
}

let identity: Promise<SealIdentity> | null = null;

/** Certificado do selo, criado uma vez por sessão no próprio aparelho. */
function sealIdentity(): Promise<SealIdentity> {
  if (!identity) {
    identity = (async () => {
      const mod: any = await import('node-forge');
      const forge = mod.default && mod.default.pki ? mod.default : mod;
      const keys: any = await new Promise((resolve, reject) => {
        forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 }, (err: unknown, kp: unknown) => (err ? reject(err) : resolve(kp)));
      });
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;
      cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(15));
      const now = Date.now();
      cert.validity.notBefore = new Date(now - 24 * 3600 * 1000);
      cert.validity.notAfter = new Date(now + 10 * 365 * 24 * 3600 * 1000);
      const name = 'PDFCraft Selo de Cera';
      const attrs = [
        { name: 'commonName', value: name },
        { name: 'organizationName', value: 'PDFCraft' },
      ];
      cert.setSubject(attrs);
      cert.setIssuer(attrs);
      cert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', critical: true, digitalSignature: true, nonRepudiation: true },
        { name: 'subjectKeyIdentifier' },
      ]);
      cert.sign(keys.privateKey, forge.md.sha256.create());
      const pwd = forge.util.bytesToHex(forge.random.getBytesSync(12));
      const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], pwd, { algorithm: '3des' });
      const der: string = forge.asn1.toDer(asn1).getBytes();
      const p12 = new Uint8Array(der.length);
      for (let i = 0; i < der.length; i++) p12[i] = der.charCodeAt(i);
      return { p12, pwd, name };
    })().catch((err) => {
      identity = null;
      throw err;
    });
  }
  return identity;
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 160 ? msg.slice(0, 160) + '…' : msg;
}

export class CertCryptorProcessor extends BasePDFProcessor {
  async process(input: ProcessInput, onProgress?: ProgressCallback): Promise<ProcessOutput> {
    this.reset();
    this.onProgress = onProgress;

    const { files, options } = input;
    const opts: CertCryptorOptions = {
      waxColor: 'gold',
      sealPage: 0,
      encryptWithCert: false,
      ...(options as Partial<CertCryptorOptions>),
    };

    if (files.length < 1) {
      return this.createErrorOutput(PDFErrorCode.INVALID_OPTIONS, tr('Envie um PDF.', 'At least one PDF file is required.'));
    }
    const pdfFile = files[0];

    try {
      this.updateProgress(10, tr('Lendo o PDF…', 'Reading PDF…'));
      const bytes = new Uint8Array(await pdfFile.arrayBuffer());
      const pdfLib = await loadPdfLib();
      let doc: any;
      try {
        doc = await pdfLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      } catch (err) {
        return this.createErrorOutput(PDFErrorCode.PDF_MALFORMED, tr('Não foi possível ler este PDF.', 'Could not read this PDF.'), shortError(err));
      }
      if (doc.isEncrypted) {
        return this.createErrorOutput(
          PDFErrorCode.PDF_ENCRYPTED,
          tr('Este PDF já tem senha. Use "Remover senha" primeiro.', 'This PDF is password-protected. Remove the password first.')
        );
      }
      const wantPassword = !!opts.encryptWithCert;
      const password = (opts.pfxPassword || '').trim() || 'pdfcraft';
      if (wantPassword && hasSignatures(bytes)) {
        return this.createErrorOutput(
          PDFErrorCode.INVALID_OPTIONS,
          tr(
            'Este PDF já tem uma assinatura. Colocar senha agora estragaria a assinatura anterior: desmarque a senha ou use uma cópia sem assinatura.',
            'This PDF is already signed. Adding a password now would break the existing signature: turn the password off or use an unsigned copy.'
          )
        );
      }

      const pageCount = doc.getPageCount();
      const pageIdx = Math.min(pageCount - 1, Math.max(0, Math.round(opts.sealPage || 0)));
      const page = doc.getPage(pageIdx);
      const { width: pw, height: ph } = page.getSize();
      const angle = (((page.getRotation().angle || 0) % 360) + 360) % 360;
      const sideways = angle === 90 || angle === 270;
      const vw = sideways ? ph : pw;
      const vh = sideways ? pw : ph;

      let fx = opts.sealFx;
      let fy = opts.sealFy;
      if (typeof fx !== 'number' || typeof fy !== 'number') {
        // formato antigo: pontos numa página A4 com origem embaixo
        fx = (opts.sealX ?? 120) / 595.276;
        fy = 1 - (opts.sealY ?? 500) / 841.89;
      }
      fx = Math.min(1, Math.max(0, fx));
      fy = Math.min(1, Math.max(0, fy));
      const size = Math.min(opts.sealSize || 72, vw * 0.5, vh * 0.5);
      const x = Math.min(Math.max(0, fx * vw - size / 2), vw - size);
      const y = Math.min(Math.max(0, fy * vh - size / 2), vh - size);

      this.updateProgress(25, tr('Desenhando o selo de cera…', 'Drawing the wax seal…'));
      const png = await drawWaxSealPng(opts.waxColor in PALETTES ? opts.waxColor : 'gold');

      this.updateProgress(40, tr('Criando o certificado do selo…', 'Creating the seal certificate…'));
      const [z, id] = await Promise.all([loadZga(), sealIdentity()]);
      if (this.checkCancelled()) return this.createErrorOutput(PDFErrorCode.PROCESSING_CANCELLED, 'Processing was cancelled.');

      this.updateProgress(65, tr('Assinando o documento…', 'Signing the document…'));
      const signOptions = {
        p12cert: id.p12,
        pwd: id.pwd,
        reason: tr('Selo de cera digital (PDFCraft)', 'Digital wax seal (PDFCraft)'),
        signame: 'SeloDeCera',
        drawinf: {
          area: { x, y, w: size, h: size },
          pageidx: pageIdx,
          imgInfo: { imgData: png, imgType: 'png' },
        },
      };
      const encrypt = wantPassword
        ? { mode: z.Crypto.Mode.AES_256, userpwd: password, permissions: ['modify', 'assemble'] }
        : undefined;
      const out = await zgaSign(z, signOptions, bytes, encrypt);

      this.updateProgress(85, tr('Conferindo a assinatura…', 'Checking the signature…'));
      const sigs = findPdfSignatures(out).filter((s) => s.kind === 'signature');
      const last = sigs[sigs.length - 1];
      const report = last ? await inspectPdfSignature(out, last) : null;
      if (!report || !report.valid) {
        throw new Error('signature self-check failed: ' + (report?.error || 'not found'));
      }

      this.updateProgress(100, tr('Selo e assinatura aplicados!', 'Wax seal and signature applied!'));
      const outputBlob = new Blob([new Uint8Array(out)], { type: 'application/pdf' });
      return this.createSuccessOutput(outputBlob, pdfFile.name.replace(/\.pdf$/i, '_signed.pdf'), {
        signedPage: pageIdx + 1,
        certified: true,
        encrypted: wantPassword,
        openPassword: wantPassword ? password : undefined,
        signer: id.name,
      });
    } catch (error) {
      return this.createErrorOutput(
        PDFErrorCode.PROCESSING_FAILED,
        tr('Não foi possível aplicar o selo e a assinatura.', 'Failed to apply certificate cryptor and wax seal.'),
        shortError(error)
      );
    }
  }

  protected getAcceptedTypes(): string[] {
    return ['application/pdf'];
  }
}

export function createCertCryptorProcessor(): CertCryptorProcessor {
  return new CertCryptorProcessor();
}

export async function encryptAndSignCert(
  file: File,
  options?: Partial<CertCryptorOptions>,
  onProgress?: ProgressCallback
): Promise<ProcessOutput> {
  const processor = createCertCryptorProcessor();
  return processor.process({ files: [file], options: options || {} }, onProgress);
}
