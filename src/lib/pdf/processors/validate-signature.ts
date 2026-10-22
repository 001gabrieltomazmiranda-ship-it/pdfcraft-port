/**
 * Validar assinatura: confere DE VERDADE cada assinatura digital e carimbo de tempo do PDF
 * (resumo do documento + assinatura criptográfica com a chave do certificado).
 * O trabalho pesado fica em src/lib/pdf/signature-inspect.ts.
 */
import type { ExtractedSignature, SignatureValidationResult } from '@/types/digital-signature';
import {
  digestName,
  findPdfSignatures,
  inspectPdfSignature,
  isIssuedBy,
  parseCert,
  signatureName,
  type CertInfo,
  type PdfSignatureReport,
} from '../signature-inspect';

/** Certificado de confiança: bytes DER/PEM ou um certificado do node-forge. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TrustedCertInput = Uint8Array | string | any;

/** Lista as assinaturas do PDF (sem conferir). */
export function extractSignatures(pdfBytes: Uint8Array): ExtractedSignature[] {
  return findPdfSignatures(pdfBytes).map((s, index) => ({
    index,
    contents: s.contents,
    byteRange: [...s.byteRange],
    reason: s.reason,
    location: s.location,
    contactInfo: s.contactInfo,
    name: s.name,
    signingTime: s.m ? s.m.toISOString() : undefined,
  }));
}

function pemToDer(pem: string): Uint8Array | null {
  const m = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem);
  if (!m) return null;
  const bin = atob(m[1].replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function trustedToCert(input: TrustedCertInput): Promise<CertInfo | null> {
  if (!input) return null;
  try {
    if (input instanceof Uint8Array) {
      const asText = new TextDecoder('latin1').decode(input.subarray(0, 64));
      if (asText.includes('-----BEGIN')) {
        const der = pemToDer(new TextDecoder('latin1').decode(input));
        return der ? parseCert(der) : null;
      }
      return parseCert(input);
    }
    if (typeof input === 'string') {
      const der = pemToDer(input);
      return der ? parseCert(der) : null;
    }
    // certificado do node-forge
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('node-forge');
    const forge = mod.default && mod.default.pki ? mod.default : mod;
    const der: string = forge.asn1.toDer(forge.pki.certificateToAsn1(input)).getBytes();
    const bytes = new Uint8Array(der.length);
    for (let i = 0; i < der.length; i++) bytes[i] = der.charCodeAt(i);
    return parseCert(bytes);
  } catch (err) {
    console.warn('[validar] certificado de confiança ilegível', err);
    return null;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function chainTrusted(certs: CertInfo[], trusted: CertInfo): Promise<boolean> {
  for (const c of certs) {
    if (sameBytes(c.der, trusted.der)) return true;
    if (await isIssuedBy(c, trusted)) return true;
  }
  return false;
}

function problemOf(report: PdfSignatureReport): SignatureValidationResult['problem'] {
  if (report.valid && !report.unverifiable) return undefined;
  if (report.unverifiable && report.valid) return 'unsupported';
  const e = report.error || '';
  if (/changed/.test(e)) return 'modified';
  if (/bad signature/.test(e) || report.check?.signatureOk === false) return 'badSignature';
  if (/not supported/.test(e)) return 'unsupported';
  return 'other';
}

async function toResult(index: number, report: PdfSignatureReport, trusted: CertInfo | null): Promise<SignatureValidationResult> {
  const signer = report.check?.signer;
  const now = new Date();
  const res: SignatureValidationResult = {
    signatureIndex: index,
    isValid: report.valid,
    signerName: signer?.subject.CN || signer?.subject.O || report.raw.name || 'Unknown',
    signerOrg: signer?.subject.O,
    signerEmail: signer?.subject.E,
    issuer: signer?.issuer.CN || signer?.issuer.O || 'Unknown',
    issuerOrg: signer?.issuer.O,
    validFrom: signer?.notBefore || new Date(0),
    validTo: signer?.notAfter || new Date(0),
    isExpired: !!signer?.notAfter && !!signer?.notBefore && (now > signer.notAfter || now < signer.notBefore),
    isSelfSigned: !!signer && sameBytes(signer.issuerDer, signer.subjectDer),
    isTrusted: false,
    signatureDate: report.timestampTime || report.check?.signingTime || report.raw.m,
    algorithms: {
      digest: digestName(report.check?.digestAlg || ''),
      signature: signatureName(report.check?.sigAlg || signer?.sigAlg || ''),
    },
    serialNumber: signer?.serialHex || '',
    byteRange: [...report.raw.byteRange],
    coverageStatus: report.coversWholeFile ? 'full' : 'partial',
    reason: report.raw.reason,
    location: report.raw.location,
    contactInfo: report.raw.contactInfo,
    errorMessage: report.error,
    problem: problemOf(report),
    kind: report.kind,
    subFilter: report.raw.subFilter,
    timestampTime: report.timestampTime,
    tsaName: report.tsaName,
    timestampSerial: report.timestampSerial,
    unverifiable: report.unverifiable,
    documentHash: report.documentHash,
  };
  if (trusted && report.check) {
    try {
      res.isTrusted = await chainTrusted(report.check.certs, trusted);
    } catch {
      res.isTrusted = false;
    }
  }
  return res;
}

/** Confere todas as assinaturas e carimbos do PDF. */
export async function validatePdfSignatures(pdfBytes: Uint8Array, trustedCert?: TrustedCertInput): Promise<SignatureValidationResult[]> {
  const bytes = new Uint8Array(pdfBytes.length);
  bytes.set(pdfBytes);
  const trusted = trustedCert ? await trustedToCert(trustedCert) : null;
  const found = findPdfSignatures(bytes);
  const out: SignatureValidationResult[] = [];
  for (let i = 0; i < found.length; i++) {
    const report = await inspectPdfSignature(bytes, found[i]);
    out.push(await toResult(i, report, trusted));
  }
  return out;
}

/** (compatibilidade) confere uma assinatura já extraída. */
export async function validateSignature(
  signature: ExtractedSignature,
  pdfBytes: Uint8Array,
  trustedCert?: TrustedCertInput
): Promise<SignatureValidationResult> {
  const found = findPdfSignatures(pdfBytes);
  const raw = found.find((f) => f.byteRange.join(',') === signature.byteRange.join(',')) || found[signature.index];
  const trusted = trustedCert ? await trustedToCert(trustedCert) : null;
  if (!raw) {
    return {
      signatureIndex: signature.index,
      isValid: false,
      signerName: 'Unknown',
      issuer: 'Unknown',
      validFrom: new Date(0),
      validTo: new Date(0),
      isExpired: false,
      isSelfSigned: false,
      isTrusted: false,
      algorithms: { digest: 'Unknown', signature: 'Unknown' },
      serialNumber: '',
      byteRange: signature.byteRange,
      coverageStatus: 'unknown',
      errorMessage: 'Signature not found',
    };
  }
  return toResult(signature.index, await inspectPdfSignature(pdfBytes, raw), trusted);
}
