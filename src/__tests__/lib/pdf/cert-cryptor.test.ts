import { describe, it, expect } from 'vitest';
import {
  CertCryptorProcessor,
  createCertCryptorProcessor,
  encryptAndSignCert,
} from '@/lib/pdf/processors/cert-cryptor';
import { PDFErrorCode } from '@/types/pdf';

// A assinatura de verdade (selo + PKCS#7 + AES-256) é testada no navegador,
// porque precisa de canvas e WebCrypto. Aqui ficam só as validações de entrada.
describe('CertCryptorProcessor', () => {
  it('should instantiate cert cryptor processor correctly', () => {
    const processor = createCertCryptorProcessor();
    expect(processor).toBeInstanceOf(CertCryptorProcessor);
  });

  it('should validate empty input files', async () => {
    const processor = createCertCryptorProcessor();
    const result = await processor.process({ files: [], options: {} });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(PDFErrorCode.INVALID_OPTIONS);
  });

  it('should reject a file that is not a PDF', async () => {
    const notPdf = {
      name: 'nota.pdf',
      size: 5,
      type: 'application/pdf',
      arrayBuffer: async () => new TextEncoder().encode('hello').buffer,
    } as unknown as File;
    const result = await encryptAndSignCert(notPdf, { waxColor: 'gold' });
    expect(result.success).toBe(false);
  });
});
