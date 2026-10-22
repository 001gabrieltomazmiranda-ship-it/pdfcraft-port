/**
 * Lê e confere de verdade as assinaturas digitais e os carimbos de tempo de um PDF.
 *
 * - Acha cada assinatura pelo /ByteRange (o trecho do arquivo que ela protege).
 * - Lê o pacote PKCS#7/CMS com um leitor DER próprio (guarda as posições exatas dos bytes).
 * - Confere o resumo (hash) do documento e a assinatura criptográfica com a chave pública
 *   do certificado (RSA, RSA-PSS e ECDSA pelo WebCrypto; RSA também pelo node-forge se faltar).
 * - Carimbo de tempo RFC 3161 (DocTimeStamp ou dentro da assinatura): lê a hora oficial (genTime),
 *   o número de série e confere se o carimbo é deste documento.
 */

// ---------------------------------------------------------------- DER

export interface DerNode {
  tag: number;
  cls: number;
  constructed: boolean;
  tagNum: number;
  start: number;
  hdr: number;
  len: number;
  /** fim do valor (exclusivo) */
  end: number;
  children?: DerNode[];
  indefinite?: boolean;
}

function parseNode(buf: Uint8Array, pos: number, limit: number, depth = 0): DerNode {
  if (depth > 64) throw new Error('ASN.1 too deep');
  const start = pos;
  if (pos >= limit) throw new Error('ASN.1 truncated');
  const tag = buf[pos++];
  let tagNum = tag & 0x1f;
  if (tagNum === 0x1f) {
    tagNum = 0;
    let b = 0;
    let guard = 0;
    do {
      if (pos >= limit || ++guard > 4) throw new Error('ASN.1 bad tag');
      b = buf[pos++];
      tagNum = tagNum * 128 + (b & 0x7f);
    } while (b & 0x80);
  }
  if (pos >= limit) throw new Error('ASN.1 truncated');
  let len = buf[pos++];
  let indefinite = false;
  if (len === 0x80) {
    indefinite = true;
    len = -1;
  } else if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 4 || pos + n > limit) throw new Error('ASN.1 bad length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos++];
  }
  const hdr = pos - start;
  const constructed = (tag & 0x20) !== 0;
  const node: DerNode = { tag, cls: tag >> 6, constructed, tagNum, start, hdr, len, end: 0 };
  if (indefinite) {
    if (!constructed) throw new Error('ASN.1 indefinite primitive');
    node.indefinite = true;
    const kids: DerNode[] = [];
    let p = pos;
    for (;;) {
      if (p + 1 >= limit) throw new Error('ASN.1 truncated');
      if (buf[p] === 0 && buf[p + 1] === 0) {
        p += 2;
        break;
      }
      const k = parseNode(buf, p, limit, depth + 1);
      kids.push(k);
      p = k.end;
    }
    node.children = kids;
    node.end = p;
    node.len = p - pos;
    return node;
  }
  const end = pos + len;
  if (end > limit) throw new Error('ASN.1 truncated');
  node.end = end;
  if (constructed) {
    const kids: DerNode[] = [];
    let p = pos;
    while (p < end) {
      const k = parseNode(buf, p, end, depth + 1);
      kids.push(k);
      p = k.end;
    }
    node.children = kids;
  }
  return node;
}

export function parseDer(buf: Uint8Array, offset = 0): DerNode {
  return parseNode(buf, offset, buf.length);
}

function valueStart(n: DerNode): number {
  return n.start + n.hdr;
}

function valueBytes(buf: Uint8Array, n: DerNode): Uint8Array {
  if (n.indefinite) return buf.subarray(valueStart(n), n.end - 2);
  return buf.subarray(valueStart(n), n.end);
}

function wholeBytes(buf: Uint8Array, n: DerNode): Uint8Array {
  return buf.subarray(n.start, n.end);
}

/** OCTET STRING (inclusive a forma "em pedaços" do BER) */
function octets(buf: Uint8Array, n: DerNode): Uint8Array {
  if (!n.constructed) return valueBytes(buf, n);
  const parts = (n.children || []).map((c) => octets(buf, c));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function oid(buf: Uint8Array, n: DerNode): string {
  const v = valueBytes(buf, n);
  if (!v.length) return '';
  const parts: number[] = [];
  const first = v[0];
  parts.push(first < 80 ? Math.floor(first / 40) : 2, first < 80 ? first % 40 : first - 80);
  let acc = 0;
  for (let i = 1; i < v.length; i++) {
    acc = acc * 128 + (v[i] & 0x7f);
    if (!(v[i] & 0x80)) {
      parts.push(acc);
      acc = 0;
    }
  }
  return parts.join('.');
}

function toHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

function intHex(buf: Uint8Array, n: DerNode): string {
  let v = valueBytes(buf, n);
  while (v.length > 1 && v[0] === 0) v = v.subarray(1);
  return toHex(v).toUpperCase();
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function decodeString(buf: Uint8Array, n: DerNode): string {
  const v = valueBytes(buf, n);
  try {
    switch (n.tag) {
      case 0x0c: // UTF8String
        return new TextDecoder('utf-8').decode(v);
      case 0x1e: {
        // BMPString (UTF-16BE)
        let s = '';
        for (let i = 0; i + 1 < v.length; i += 2) s += String.fromCharCode((v[i] << 8) | v[i + 1]);
        return s;
      }
      case 0x1c: {
        // UniversalString (UTF-32BE)
        let s = '';
        for (let i = 0; i + 3 < v.length; i += 4) s += String.fromCodePoint(((v[i] << 24) | (v[i + 1] << 16) | (v[i + 2] << 8) | v[i + 3]) >>> 0);
        return s;
      }
      default:
        return new TextDecoder('latin1').decode(v);
    }
  } catch {
    return new TextDecoder('latin1').decode(v);
  }
}

function decodeTime(buf: Uint8Array, n: DerNode): Date | undefined {
  const s = new TextDecoder('latin1').decode(valueBytes(buf, n)).trim();
  // UTCTime: YYMMDDHHMM[SS]Z | GeneralizedTime: YYYYMMDDHHMMSS[.fff]Z
  const m =
    n.tag === 0x17
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.(\d+))?(Z|[+-]\d{4})?$/.exec(s)
      : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.(\d+))?(Z|[+-]\d{4})?$/.exec(s);
  if (!m) return undefined;
  let year = Number(m[1]);
  if (n.tag === 0x17) year += year < 50 ? 2000 : 1900;
  const ms = m[7] ? Number(('0.' + m[7]).slice(0, 5)) * 1000 : 0;
  let t = Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0), Math.round(ms));
  if (m[8] && m[8] !== 'Z') {
    const sign = m[8][0] === '+' ? 1 : -1;
    const off = (Number(m[8].slice(1, 3)) * 60 + Number(m[8].slice(3, 5))) * 60000;
    t -= sign * off;
  }
  return new Date(t);
}

// ---------------------------------------------------------------- nomes e certificados

const NAME_OIDS: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '1.2.840.113549.1.9.1': 'E',
  '2.5.4.5': 'SERIALNUMBER',
};

export type NameMap = Record<string, string>;

function decodeName(buf: Uint8Array, n: DerNode): NameMap {
  const out: NameMap = {};
  for (const rdn of n.children || []) {
    for (const atv of rdn.children || []) {
      const [o, v] = atv.children || [];
      if (!o || !v) continue;
      const key = NAME_OIDS[oid(buf, o)] || oid(buf, o);
      if (!(key in out)) out[key] = decodeString(buf, v);
    }
  }
  return out;
}

export interface CertInfo {
  der: Uint8Array;
  tbs: Uint8Array;
  serialHex: string;
  serialRaw: Uint8Array;
  issuerDer: Uint8Array;
  subjectDer: Uint8Array;
  issuer: NameMap;
  subject: NameMap;
  notBefore?: Date;
  notAfter?: Date;
  spki: Uint8Array;
  spkiAlg: string;
  spkiParam?: string;
  sigAlg: string;
  sigAlgParams?: DerNode;
  sigAlgBuf: Uint8Array;
  signature: Uint8Array;
  ski?: Uint8Array;
}

export function parseCert(der: Uint8Array): CertInfo {
  const root = parseDer(der);
  const [tbsN, algN, sigN] = root.children || [];
  if (!tbsN || !algN || !sigN) throw new Error('bad certificate');
  const t = tbsN.children || [];
  let i = 0;
  if (t[0] && t[0].tag === 0xa0) i = 1; // versão
  const serialN = t[i];
  const issuerN = t[i + 2];
  const validityN = t[i + 3];
  const subjectN = t[i + 4];
  const spkiN = t[i + 5];
  if (!serialN || !issuerN || !validityN || !subjectN || !spkiN) throw new Error('bad certificate');
  const [nb, na] = validityN.children || [];
  const spkiAlgN = spkiN.children?.[0];
  const spkiAlg = spkiAlgN?.children?.[0] ? oid(der, spkiAlgN.children[0]) : '';
  const spkiParamN = spkiAlgN?.children?.[1];
  const spkiParam = spkiParamN && spkiParamN.tag === 0x06 ? oid(der, spkiParamN) : undefined;
  const sigBits = valueBytes(der, sigN);
  // extensões: procurar Subject Key Identifier (2.5.29.14)
  let ski: Uint8Array | undefined;
  for (let k = i + 6; k < t.length; k++) {
    if (t[k].tag !== 0xa3) continue;
    const exts = t[k].children?.[0]?.children || [];
    for (const ext of exts) {
      const kids = ext.children || [];
      if (!kids[0] || oid(der, kids[0]) !== '2.5.29.14') continue;
      const val = kids[kids.length - 1];
      try {
        const inner = parseDer(valueBytes(der, val));
        ski = valueBytes(valueBytes(der, val), inner).slice();
      } catch {
        /* sem SKI */
      }
    }
  }
  return {
    der,
    tbs: wholeBytes(der, tbsN),
    serialHex: intHex(der, serialN),
    serialRaw: valueBytes(der, serialN),
    issuerDer: wholeBytes(der, issuerN),
    subjectDer: wholeBytes(der, subjectN),
    issuer: decodeName(der, issuerN),
    subject: decodeName(der, subjectN),
    notBefore: nb ? decodeTime(der, nb) : undefined,
    notAfter: na ? decodeTime(der, na) : undefined,
    spki: wholeBytes(der, spkiN),
    spkiAlg,
    spkiParam,
    sigAlg: algN.children?.[0] ? oid(der, algN.children[0]) : '',
    sigAlgParams: algN.children?.[1],
    sigAlgBuf: der,
    signature: sigBits.subarray(1), // tira o byte de "bits não usados"
    ski,
  };
}

// ---------------------------------------------------------------- algoritmos

const DIGEST_BY_OID: Record<string, string> = {
  '1.3.14.3.2.26': 'SHA-1',
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
  '1.2.840.113549.2.5': 'MD5',
};

const SIG_HASH: Record<string, string> = {
  '1.2.840.113549.1.1.5': 'SHA-1',
  '1.2.840.113549.1.1.11': 'SHA-256',
  '1.2.840.113549.1.1.12': 'SHA-384',
  '1.2.840.113549.1.1.13': 'SHA-512',
  '1.2.840.10045.4.1': 'SHA-1',
  '1.2.840.10045.4.3.2': 'SHA-256',
  '1.2.840.10045.4.3.3': 'SHA-384',
  '1.2.840.10045.4.3.4': 'SHA-512',
};

const SIG_NAME: Record<string, string> = {
  '1.2.840.113549.1.1.1': 'RSA',
  '1.2.840.113549.1.1.5': 'RSA com SHA-1',
  '1.2.840.113549.1.1.11': 'RSA com SHA-256',
  '1.2.840.113549.1.1.12': 'RSA com SHA-384',
  '1.2.840.113549.1.1.13': 'RSA com SHA-512',
  '1.2.840.113549.1.1.10': 'RSA-PSS',
  '1.2.840.10045.2.1': 'ECDSA',
  '1.2.840.10045.4.1': 'ECDSA com SHA-1',
  '1.2.840.10045.4.3.2': 'ECDSA com SHA-256',
  '1.2.840.10045.4.3.3': 'ECDSA com SHA-384',
  '1.2.840.10045.4.3.4': 'ECDSA com SHA-512',
};

const CURVES: Record<string, { name: string; size: number }> = {
  '1.2.840.10045.3.1.7': { name: 'P-256', size: 32 },
  '1.3.132.0.34': { name: 'P-384', size: 48 },
  '1.3.132.0.35': { name: 'P-521', size: 66 },
};

export function digestName(o: string): string {
  return DIGEST_BY_OID[o] || o || '?';
}

export function signatureName(o: string): string {
  return SIG_NAME[o] || o || '?';
}

function subtle(): SubtleCrypto | null {
  try {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    return c && c.subtle ? c.subtle : null;
  } catch {
    return null;
  }
}

function ab(b: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(b.length);
  new Uint8Array(out).set(b);
  return out;
}

function binStr(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 8192)));
  return s;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadForge(): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: any = await import('node-forge');
  return m.default && m.default.md ? m.default : m;
}

export async function digest(alg: string, data: Uint8Array): Promise<Uint8Array> {
  const s = subtle();
  if (s && alg !== 'MD5') {
    try {
      return new Uint8Array(await s.digest(alg, ab(data)));
    } catch {
      /* cai no forge */
    }
  }
  const forge = await loadForge();
  const name = alg.replace('-', '').toLowerCase();
  const md = forge.md[name]?.create();
  if (!md) throw new Error('unsupported digest ' + alg);
  for (let i = 0; i < data.length; i += 65536) md.update(binStr(data.subarray(i, i + 65536)));
  const raw: string = md.digest().getBytes();
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** ECDSA: DER SEQUENCE{r,s} -> r||s */
function ecdsaRaw(sig: Uint8Array, size: number): Uint8Array {
  const seq = parseDer(sig);
  const [r, s] = seq.children || [];
  if (!r || !s) throw new Error('bad ECDSA signature');
  const fix = (v: Uint8Array) => {
    let x = v;
    while (x.length > size && x[0] === 0) x = x.subarray(1);
    if (x.length > size) throw new Error('bad ECDSA integer');
    const out = new Uint8Array(size);
    out.set(x, size - x.length);
    return out;
  };
  const out = new Uint8Array(size * 2);
  out.set(fix(valueBytes(sig, r)), 0);
  out.set(fix(valueBytes(sig, s)), size);
  return out;
}

function pssSalt(buf: Uint8Array, params?: DerNode): { hash?: string; salt: number } {
  let hash: string | undefined;
  let salt = 20;
  for (const p of params?.children || []) {
    if (p.tag === 0xa0) {
      const algId = p.children?.[0];
      if (algId?.children?.[0]) hash = DIGEST_BY_OID[oid(buf, algId.children[0])];
    } else if (p.tag === 0xa2 && p.children?.[0]) {
      const v = valueBytes(buf, p.children[0]);
      salt = 0;
      for (const b of v) salt = salt * 256 + b;
    }
  }
  return { hash, salt };
}

/**
 * Confere uma assinatura. true/false = conferido; null = não deu para conferir neste aparelho.
 */
export async function verifyRaw(
  key: { spki: Uint8Array; spkiAlg: string; spkiParam?: string },
  sigAlgOid: string,
  sigParams: { buf: Uint8Array; node?: DerNode } | undefined,
  digestOid: string,
  data: Uint8Array,
  signature: Uint8Array
): Promise<boolean | null> {
  const hash = SIG_HASH[sigAlgOid] || DIGEST_BY_OID[digestOid];
  if (!hash || hash === 'MD5') return null;
  const s = subtle();
  const isEc = key.spkiAlg === '1.2.840.10045.2.1';
  const isPss = sigAlgOid === '1.2.840.113549.1.1.10';
  if (s) {
    try {
      if (isEc) {
        const curve = key.spkiParam ? CURVES[key.spkiParam] : undefined;
        if (!curve) return null;
        const k = await s.importKey('spki', ab(key.spki), { name: 'ECDSA', namedCurve: curve.name }, false, ['verify']);
        return await s.verify({ name: 'ECDSA', hash }, k, ab(ecdsaRaw(signature, curve.size)), ab(data));
      }
      if (isPss) {
        const p = pssSalt(sigParams?.buf || new Uint8Array(0), sigParams?.node);
        const h = p.hash || 'SHA-1';
        const k = await s.importKey('spki', ab(key.spki), { name: 'RSA-PSS', hash: h }, false, ['verify']);
        return await s.verify({ name: 'RSA-PSS', saltLength: p.salt }, k, ab(signature), ab(data));
      }
      const k = await s.importKey('spki', ab(key.spki), { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
      return await s.verify('RSASSA-PKCS1-v1_5', k, ab(signature), ab(data));
    } catch (err) {
      if (isEc || isPss) {
        console.warn('[assinatura] WebCrypto não conferiu', err);
        return null;
      }
      // RSA: tenta pelo forge abaixo
    }
  }
  if (isEc || isPss) return null;
  try {
    const forge = await loadForge();
    const pub = forge.pki.publicKeyFromAsn1(forge.asn1.fromDer(binStr(key.spki)));
    const d = await digest(hash, data);
    return !!pub.verify(binStr(d), binStr(signature));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- CMS / PKCS#7

const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const OID_SIGNING_TIME = '1.2.840.113549.1.9.5';
const OID_TS_TOKEN = '1.2.840.113549.1.9.16.2.14';

interface SignerInfo {
  node: DerNode;
  sidIssuer?: Uint8Array;
  sidSerial?: Uint8Array;
  sidSki?: Uint8Array;
  digestAlg: string;
  signedAttrs?: DerNode;
  sigAlg: string;
  sigAlgParams?: DerNode;
  signature: Uint8Array;
  unsignedAttrs?: DerNode;
}

interface Cms {
  buf: Uint8Array;
  eContentType: string;
  eContent?: Uint8Array;
  certs: CertInfo[];
  signers: SignerInfo[];
}

function parseCms(buf: Uint8Array): Cms {
  const ci = parseDer(buf);
  const [typeN, contentN] = ci.children || [];
  if (!typeN || oid(buf, typeN) !== OID_SIGNED_DATA || !contentN) throw new Error('not a PKCS#7 SignedData');
  const sd = contentN.children?.[0];
  const parts = sd?.children || [];
  if (parts.length < 4) throw new Error('bad SignedData');
  const encap = parts[2];
  const eContentType = encap.children?.[0] ? oid(buf, encap.children[0]) : '';
  let eContent: Uint8Array | undefined;
  const eWrap = encap.children?.[1];
  if (eWrap && eWrap.children?.[0]) eContent = octets(buf, eWrap.children[0]);
  const certs: CertInfo[] = [];
  let signerSet: DerNode | undefined;
  for (let i = 3; i < parts.length; i++) {
    const p = parts[i];
    if (p.tag === 0xa0) {
      for (const c of p.children || []) {
        if (c.tag !== 0x30) continue;
        try {
          certs.push(parseCert(wholeBytes(buf, c).slice()));
        } catch {
          /* certificado que não deu para ler */
        }
      }
    } else if (p.tag === 0x31) {
      signerSet = p;
    }
  }
  const signers: SignerInfo[] = [];
  for (const si of signerSet?.children || []) {
    const k = si.children || [];
    let i = 1;
    const sid = k[i++];
    const info: SignerInfo = { node: si, digestAlg: '', sigAlg: '', signature: new Uint8Array(0) };
    if (sid) {
      if (sid.tag === 0x30) {
        const [iss, ser] = sid.children || [];
        if (iss) info.sidIssuer = wholeBytes(buf, iss);
        if (ser) info.sidSerial = valueBytes(buf, ser);
      } else if (sid.tag === 0x80) {
        info.sidSki = valueBytes(buf, sid);
      }
    }
    const dAlg = k[i++];
    info.digestAlg = dAlg?.children?.[0] ? oid(buf, dAlg.children[0]) : '';
    if (k[i] && k[i].tag === 0xa0) info.signedAttrs = k[i++];
    const sAlg = k[i++];
    info.sigAlg = sAlg?.children?.[0] ? oid(buf, sAlg.children[0]) : '';
    info.sigAlgParams = sAlg?.children?.[1];
    const sig = k[i++];
    if (sig) info.signature = octets(buf, sig);
    if (k[i] && k[i].tag === 0xa1) info.unsignedAttrs = k[i];
    signers.push(info);
  }
  return { buf, eContentType, eContent, certs, signers };
}

function attr(buf: Uint8Array, set: DerNode | undefined, wanted: string): DerNode | undefined {
  for (const a of set?.children || []) {
    const [o, vals] = a.children || [];
    if (o && oid(buf, o) === wanted) return vals?.children?.[0];
  }
  return undefined;
}

function stripZeros(b: Uint8Array): Uint8Array {
  let x = b;
  while (x.length > 1 && x[0] === 0) x = x.subarray(1);
  return x;
}

function findSignerCert(cms: Cms, si: SignerInfo): CertInfo | undefined {
  if (si.sidSerial) {
    const want = stripZeros(si.sidSerial);
    const hit = cms.certs.find(
      (c) => sameBytes(stripZeros(c.serialRaw), want) && (!si.sidIssuer || sameBytes(c.issuerDer, si.sidIssuer))
    );
    if (hit) return hit;
  }
  if (si.sidSki) {
    const hit = cms.certs.find((c) => c.ski && sameBytes(c.ski, si.sidSki!));
    if (hit) return hit;
  }
  return cms.certs[0];
}

export interface TstInfo {
  genTime?: Date;
  serialHex: string;
  imprintAlg: string;
  imprint: Uint8Array;
  policy: string;
  tsaName?: string;
}

export function parseTstInfo(der: Uint8Array): TstInfo {
  const root = parseDer(der);
  const k = root.children || [];
  // version, policy, messageImprint, serialNumber, genTime, ...
  const imp = k[2]?.children || [];
  let tsaName: string | undefined;
  for (let i = 5; i < k.length; i++) {
    if (k[i].tag === 0xa0) {
      // GeneralName: directoryName [4]
      const gn = k[i].children?.[0];
      if (gn && gn.tag === 0xa4 && gn.children?.[0]) {
        const nm = decodeName(der, gn.children[0]);
        tsaName = nm.CN || nm.O;
      }
    }
  }
  return {
    policy: k[1] ? oid(der, k[1]) : '',
    imprintAlg: imp[0]?.children?.[0] ? oid(der, imp[0].children[0]) : '',
    imprint: imp[1] ? valueBytes(der, imp[1]).slice() : new Uint8Array(0),
    serialHex: k[3] ? intHex(der, k[3]) : '',
    genTime: k[4] ? decodeTime(der, k[4]) : undefined,
    tsaName,
  };
}

export interface CmsCheck {
  /** a assinatura criptográfica confere com o certificado */
  signatureOk: boolean | null;
  /** o resumo assinado bate com o conteúdo */
  digestOk: boolean;
  signer?: CertInfo;
  certs: CertInfo[];
  digestAlg: string;
  sigAlg: string;
  signingTime?: Date;
  /** quando é um carimbo de tempo (TSTInfo) */
  tst?: TstInfo;
  /** carimbo de tempo guardado dentro da assinatura (atributo não assinado) */
  embeddedTimestamp?: { time?: Date; ok: boolean; tsaName?: string };
  error?: string;
}

/**
 * Confere um pacote CMS. `content` é o conteúdo destacado (para assinatura "detached").
 */
export async function checkCms(der: Uint8Array, content?: Uint8Array): Promise<CmsCheck> {
  const cms = parseCms(der);
  const si = cms.signers[0];
  const base: CmsCheck = { signatureOk: null, digestOk: false, certs: cms.certs, digestAlg: '', sigAlg: '' };
  if (!si) return { ...base, error: 'no signer' };
  base.digestAlg = si.digestAlg;
  base.sigAlg = si.sigAlg;
  const signer = findSignerCert(cms, si);
  base.signer = signer;
  const hashName = DIGEST_BY_OID[si.digestAlg];
  if (!hashName) return { ...base, error: 'unknown digest ' + si.digestAlg };

  const data = cms.eContent ?? content;
  if (!data) return { ...base, error: 'no content' };
  const contentDigest = await digest(hashName, data);

  let signedData: Uint8Array;
  if (si.signedAttrs) {
    const md = attr(cms.buf, si.signedAttrs, OID_MESSAGE_DIGEST);
    base.digestOk = !!md && sameBytes(valueBytes(cms.buf, md), contentDigest);
    const st = attr(cms.buf, si.signedAttrs, OID_SIGNING_TIME);
    if (st) base.signingTime = decodeTime(cms.buf, st);
    // a assinatura cobre o SET dos atributos (troca a marca [0] por SET)
    signedData = wholeBytes(cms.buf, si.signedAttrs).slice();
    signedData[0] = 0x31;
  } else {
    base.digestOk = true; // sem atributos: a própria assinatura cobre o conteúdo
    signedData = data;
  }
  if (signer) {
    base.signatureOk = await verifyRaw(
      signer,
      si.sigAlg,
      si.sigAlgParams ? { buf: cms.buf, node: si.sigAlgParams } : undefined,
      si.digestAlg,
      signedData,
      si.signature
    );
  } else {
    base.error = 'no certificate';
  }

  if (cms.eContentType === OID_TST_INFO && cms.eContent) {
    try {
      base.tst = parseTstInfo(cms.eContent);
    } catch {
      /* ignora */
    }
  }

  // carimbo de tempo dentro da assinatura (assinatura + TSA)
  const tsNode = attr(cms.buf, si.unsignedAttrs, OID_TS_TOKEN);
  if (tsNode) {
    try {
      const tokenDer = wholeBytes(cms.buf, tsNode).slice();
      const inner = await checkCms(tokenDer);
      const tst = inner.tst;
      let ok = !!inner.signatureOk && inner.digestOk;
      if (tst) {
        const alg = DIGEST_BY_OID[tst.imprintAlg];
        const h = alg ? await digest(alg, si.signature) : null;
        ok = ok && !!h && sameBytes(h, tst.imprint);
      }
      base.embeddedTimestamp = { time: tst?.genTime, ok, tsaName: tst?.tsaName || inner.signer?.subject.CN };
    } catch {
      base.embeddedTimestamp = { ok: false };
    }
  }
  return base;
}

/** Confere se `cert` foi emitido (assinado) por `issuer`. */
export async function isIssuedBy(cert: CertInfo, issuer: CertInfo): Promise<boolean> {
  if (!sameBytes(cert.issuerDer, issuer.subjectDer)) return false;
  const res = await verifyRaw(
    issuer,
    cert.sigAlg,
    cert.sigAlgParams ? { buf: cert.sigAlgBuf, node: cert.sigAlgParams } : undefined,
    '',
    cert.tbs,
    cert.signature
  );
  return res === true;
}

// ---------------------------------------------------------------- PDF

export interface RawPdfSignature {
  byteRange: [number, number, number, number];
  contents: Uint8Array;
  kind: 'signature' | 'timestamp';
  subFilter: string;
  reason?: string;
  location?: string;
  contactInfo?: string;
  name?: string;
  /** /M do dicionário */
  m?: Date;
}

function latin1(bytes: Uint8Array, from: number, to: number): string {
  const a = Math.max(0, from);
  const b = Math.min(bytes.length, to);
  let s = '';
  for (let i = a; i < b; i += 8192) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(b, i + 8192))));
  return s;
}

function pdfText(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // string literal: tira escapes simples; hex: decodifica
  let s = raw;
  if (s.startsWith('<')) {
    const hex = s.slice(1, -1).replace(/\s+/g, '');
    const b: number[] = [];
    for (let i = 0; i + 1 < hex.length; i += 2) b.push(parseInt(hex.slice(i, i + 2), 16));
    s = String.fromCharCode(...b);
  } else {
    s = s
      .slice(1, -1)
      .replace(/\\([nrtbf()\\])/g, (_m, c: string) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[c] ?? c)
      .replace(/\\([0-7]{1,3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));
  }
  if (s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    return out;
  }
  let out = s;
  try {
    // pode ser UTF-8 (alguns programas gravam assim)
    const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
    out = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    out = s;
  }
  return readable(out);
}

/** Strings de PDF com senha ficam cifradas: se parecer lixo, não mostra. */
function readable(s: string): string | undefined {
  if (!s) return s;
  let bad = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) || 0;
    if ((c < 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) || (c >= 0x7f && c <= 0x9f) || c === 0xfffd) bad++;
  }
  return bad > Math.max(1, s.length * 0.1) ? undefined : s;
}

/** Lê uma string do PDF começando em `i`: (literal, com parênteses equilibrados) ou <hex>. */
function readPdfString(text: string, i: number): string | undefined {
  if (text[i] === '(') {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (ch === '\\') {
        j++;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return text.slice(i, j + 1);
      }
    }
    return undefined;
  }
  if (text[i] === '<' && text[i + 1] !== '<') {
    const j = text.indexOf('>', i);
    return j > 0 ? text.slice(i, j + 1) : undefined;
  }
  return undefined;
}

/**
 * Valor de uma chave do dicionário da assinatura. O dicionário fica em volta do Contents:
 * procura o mais perto antes (`before`, termina no Contents) ou logo depois (`after`).
 */
function nearestValue(before: string, after: string, key: string, value: string): string | undefined {
  const isString = value === PDF_STRING;
  const re = new RegExp('/' + key + '(?![A-Za-z0-9])\\s*' + (isString ? '' : '(' + value + ')'), 'g');
  const read = (text: string, m: RegExpExecArray) => (isString ? readPdfString(text, m.index + m[0].length) : m[1]);
  let best: { v: string; d: number } | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(before)) !== null) {
    const v = read(before, m);
    const d = before.length - m.index;
    if (v !== undefined && (!best || d < best.d)) best = { v, d };
  }
  re.lastIndex = 0;
  while ((m = re.exec(after)) !== null) {
    const v = read(after, m);
    if (v === undefined) continue;
    if (!best || m.index < best.d) best = { v, d: m.index };
    break;
  }
  return best?.v;
}

const PDF_STRING = 'string';

function pdfDate(raw: string | undefined): Date | undefined {
  const s = pdfText(raw);
  if (!s) return undefined;
  const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/.exec(s);
  if (!m) return undefined;
  let t = Date.UTC(Number(m[1]), Number(m[2] || 1) - 1, Number(m[3] || 1), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
  if (m[7] === '+' || m[7] === '-') {
    const off = (Number(m[8] || 0) * 60 + Number(m[9] || 0)) * 60000;
    t -= (m[7] === '+' ? 1 : -1) * off;
  }
  return new Date(t);
}

/** Acha as assinaturas pelo /ByteRange (funciona mesmo com Contents gigantes). */
export function findPdfSignatures(bytes: Uint8Array): RawPdfSignature[] {
  const out: RawPdfSignature[] = [];
  const marker = [0x2f, 0x42, 0x79, 0x74, 0x65, 0x52, 0x61, 0x6e, 0x67, 0x65]; // "/ByteRange"
  const seen = new Set<string>();
  for (let i = 0; i + marker.length < bytes.length; i++) {
    if (bytes[i] !== 0x2f) continue;
    let ok = true;
    for (let k = 1; k < marker.length; k++) {
      if (bytes[i + k] !== marker[k]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const tail = latin1(bytes, i, i + 120);
    const m = /^\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(tail);
    if (!m) continue;
    const br = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
    const key = br.join(',');
    if (seen.has(key)) continue;
    // Contents fica exatamente entre os dois pedaços protegidos: <....>
    const cStart = br[0] + br[1];
    const cEnd = br[2];
    if (!(br[0] === 0 && cStart < cEnd && cEnd <= bytes.length && br[2] + br[3] <= bytes.length)) continue;
    if (bytes[cStart] !== 0x3c || bytes[cEnd - 1] !== 0x3e) continue;
    seen.add(key);
    const hex = latin1(bytes, cStart + 1, cEnd - 1).replace(/[^0-9A-Fa-f]/g, '');
    const contents = new Uint8Array(Math.floor(hex.length / 2));
    for (let k = 0; k < contents.length; k++) contents[k] = parseInt(hex.substr(k * 2, 2), 16);
    // o resto do dicionário fica em volta do Contents (antes e depois)
    const before = latin1(bytes, Math.max(0, Math.min(i, cStart) - 4000), cStart);
    const after = latin1(bytes, cEnd, cEnd + 4000);
    const subFilter = nearestValue(before, after, 'SubFilter', '/[A-Za-z0-9.#_-]+')?.slice(1) || '';
    const type = nearestValue(before, after, 'Type', '/[A-Za-z]+')?.slice(1) || '';
    const isTs = type === 'DocTimeStamp' || /ETSI\.RFC3161/.test(subFilter);
    out.push({
      byteRange: br,
      contents,
      kind: isTs ? 'timestamp' : 'signature',
      subFilter,
      reason: pdfText(nearestValue(before, after, 'Reason', PDF_STRING)),
      location: pdfText(nearestValue(before, after, 'Location', PDF_STRING)),
      contactInfo: pdfText(nearestValue(before, after, 'ContactInfo', PDF_STRING)),
      name: pdfText(nearestValue(before, after, 'Name', PDF_STRING)),
      m: pdfDate(nearestValue(before, after, 'M', PDF_STRING)),
    });
  }
  return out.sort((a, b) => a.byteRange[2] + a.byteRange[3] - (b.byteRange[2] + b.byteRange[3]));
}

function signedBytes(bytes: Uint8Array, br: [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(br[1] + br[3]);
  out.set(bytes.subarray(br[0], br[0] + br[1]), 0);
  out.set(bytes.subarray(br[2], br[2] + br[3]), br[1]);
  return out;
}

export interface PdfSignatureReport {
  raw: RawPdfSignature;
  kind: 'signature' | 'timestamp';
  /** documento intacto e assinatura conferida */
  valid: boolean;
  /** a assinatura não pôde ser conferida neste aparelho (algoritmo sem suporte) */
  unverifiable: boolean;
  /** o arquivo continua depois do trecho assinado (houve alterações/assinaturas depois) */
  coversWholeFile: boolean;
  check?: CmsCheck;
  /** hora oficial do carimbo (TSA) */
  timestampTime?: Date;
  tsaName?: string;
  timestampSerial?: string;
  /** resumo SHA do documento que foi carimbado/assinado (hex) */
  documentHash?: string;
  error?: string;
}

export async function inspectPdfSignature(bytes: Uint8Array, raw: RawPdfSignature): Promise<PdfSignatureReport> {
  const br = raw.byteRange;
  const end = br[2] + br[3];
  // depois da última revisão pode haver só um fim de linha
  let tail = bytes.length;
  while (tail > end && (bytes[tail - 1] === 0x0a || bytes[tail - 1] === 0x0d || bytes[tail - 1] === 0x20 || bytes[tail - 1] === 0x00)) tail--;
  const report: PdfSignatureReport = {
    raw,
    kind: raw.kind,
    valid: false,
    unverifiable: false,
    coversWholeFile: end >= tail,
  };
  try {
    const len = parseDer(raw.contents).end;
    const der = raw.contents.subarray(0, len).slice();
    const content = signedBytes(bytes, br);
    if (raw.kind === 'timestamp' || raw.subFilter === 'ETSI.RFC3161') {
      const check = await checkCms(der);
      report.check = check;
      const tst = check.tst;
      if (!tst) throw new Error('timestamp without TSTInfo');
      const alg = DIGEST_BY_OID[tst.imprintAlg];
      if (!alg) throw new Error('unknown imprint hash');
      const h = await digest(alg, content);
      report.documentHash = toHex(h);
      const imprintOk = sameBytes(h, tst.imprint);
      report.timestampTime = tst.genTime;
      report.timestampSerial = tst.serialHex;
      report.tsaName = tst.tsaName || check.signer?.subject.CN || check.signer?.subject.O;
      report.unverifiable = check.signatureOk === null;
      report.valid = imprintOk && check.digestOk && check.signatureOk !== false;
      if (!imprintOk) report.error = 'document changed after timestamp';
    } else if (raw.subFilter === 'adbe.pkcs7.sha1') {
      const check = await checkCms(der);
      report.check = check;
      const h = await digest('SHA-1', content);
      report.documentHash = toHex(h);
      const cms = parseCms(der);
      const inner = cms.eContent && sameBytes(cms.eContent, h);
      report.unverifiable = check.signatureOk === null;
      report.valid = !!inner && check.digestOk && check.signatureOk !== false;
      if (check.embeddedTimestamp) {
        report.timestampTime = check.embeddedTimestamp.time;
        report.tsaName = check.embeddedTimestamp.tsaName;
      }
    } else if (raw.subFilter === 'adbe.x509.rsa_sha1') {
      report.unverifiable = true;
      report.error = 'adbe.x509.rsa_sha1 not supported';
    } else {
      const check = await checkCms(der, content);
      report.check = check;
      const alg = DIGEST_BY_OID[check.digestAlg];
      if (alg) report.documentHash = toHex(await digest(alg, content));
      report.unverifiable = check.signatureOk === null;
      report.valid = check.digestOk && check.signatureOk !== false;
      if (!check.digestOk) report.error = 'document changed after signing';
      if (check.embeddedTimestamp) {
        report.timestampTime = check.embeddedTimestamp.time;
        report.tsaName = check.embeddedTimestamp.tsaName;
        if (!check.embeddedTimestamp.ok) report.valid = false;
      }
    }
    if (report.check && report.check.signatureOk === false) report.error = report.error || 'bad signature';
  } catch (err) {
    report.valid = false;
    report.error = err instanceof Error ? err.message : String(err);
  }
  return report;
}

export async function inspectPdfSignatures(bytes: Uint8Array): Promise<PdfSignatureReport[]> {
  const found = findPdfSignatures(bytes);
  const out: PdfSignatureReport[] = [];
  for (const raw of found) out.push(await inspectPdfSignature(bytes, raw));
  return out;
}
