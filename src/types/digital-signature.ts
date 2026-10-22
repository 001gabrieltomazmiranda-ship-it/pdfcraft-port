/**
 * Digital Signature Types
 */
import type forge from 'node-forge';

export interface CertificateData {
  p12Buffer: ArrayBuffer;
  password: string;
  certificate: forge.pki.Certificate;
}

export interface SignatureInfo {
  reason?: string;
  location?: string;
  contactInfo?: string;
}

export interface VisibleSignatureOptions {
  enabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  page: number | string;
  imageData?: ArrayBuffer;
  imageType?: 'png' | 'jpeg' | 'webp';
  text?: string;
  textColor?: string;
  textSize?: number;
}

export interface SignPdfOptions {
  signatureInfo?: SignatureInfo;
  visibleSignature?: VisibleSignatureOptions;
}

export interface ExtractedSignature {
  index: number;
  contents: Uint8Array;
  byteRange: number[];
  reason?: string;
  location?: string;
  contactInfo?: string;
  name?: string;
  signingTime?: string;
}

export interface SignatureValidationResult {
  signatureIndex: number;
  isValid: boolean;
  signerName: string;
  signerOrg?: string;
  signerEmail?: string;
  issuer: string;
  issuerOrg?: string;
  validFrom: Date;
  validTo: Date;
  isExpired: boolean;
  isSelfSigned: boolean;
  isTrusted: boolean;
  signatureDate?: Date;
  algorithms: {
    digest: string;
    signature: string;
  };
  serialNumber: string;
  byteRange: number[];
  coverageStatus: 'full' | 'partial' | 'unknown';
  reason?: string;
  location?: string;
  contactInfo?: string;
  errorMessage?: string;
  /** assinatura comum ou carimbo de tempo do documento (RFC 3161) */
  kind?: 'signature' | 'timestamp';
  subFilter?: string;
  /** hora oficial dada pela autoridade de carimbo de tempo (TSA) */
  timestampTime?: Date;
  tsaName?: string;
  timestampSerial?: string;
  /** o algoritmo não pôde ser conferido neste aparelho */
  unverifiable?: boolean;
  /** resumo (hash) do trecho assinado, em hexadecimal */
  documentHash?: string;
  /** por que não é válida */
  problem?: 'modified' | 'badSignature' | 'unsupported' | 'other';
}
