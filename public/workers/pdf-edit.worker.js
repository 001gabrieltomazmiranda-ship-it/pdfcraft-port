/**
 * Editor de PDF do leitor (celular): grava no arquivo as mudanças feitas na tela
 * (texto trocado/movido/apagado, imagens movidas/redimensionadas/apagadas, texto e
 * imagem novos) usando PyMuPDF via Pyodide. Roda fora da tela principal para não travar.
 *
 * Mensagens recebidas:
 *   { type: 'init' }                                  -> { type: 'ready' } | { type: 'error' }
 *   { type: 'apply', id, pdf: ArrayBuffer, ops: str } -> { type: 'result', id, pdf, warnings } | { type: 'error', id, message }
 */

const BASE = new URL('../pymupdf-wasm/', self.location.href).href;
const ENGINE = new URL('./pdf-edit-engine.py', self.location.href).href;

let readyPromise = null;
let pyodide = null;

function status(message) {
  self.postMessage({ type: 'status', message });
}

async function load() {
  status('loading');
  const { loadPyodide } = await import(BASE + 'pyodide.js');
  pyodide = await loadPyodide({ indexURL: BASE, fullStdLib: false });
  status('installing');
  await pyodide.loadPackage(BASE + 'pymupdf-1.26.3-cp313-none-pyodide_2025_0_wasm32.whl');
  const source = await (await fetch(ENGINE)).text();
  pyodide.runPython(source);
  status('ready');
}

function ready() {
  if (!readyPromise) {
    readyPromise = load().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === 'init') {
    try {
      await ready();
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: String((err && err.message) || err) });
    }
    return;
  }
  if (msg.type === 'apply') {
    const id = msg.id;
    try {
      await ready();
      status('saving');
      const inPath = '/edit_in_' + id + '.pdf';
      const outPath = '/edit_out_' + id + '.pdf';
      pyodide.FS.writeFile(inPath, new Uint8Array(msg.pdf));
      pyodide.globals.set('EDIT_OPS', msg.ops);
      const report = pyodide.runPython(
        "apply_edits('" + inPath + "', '" + outPath + "', EDIT_OPS)"
      );
      const out = pyodide.FS.readFile(outPath);
      try {
        pyodide.FS.unlink(inPath);
        pyodide.FS.unlink(outPath);
      } catch (e) {
        /* sem problema */
      }
      const buffer = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
      const parsed = JSON.parse(report);
      self.postMessage({ type: 'result', id, pdf: buffer, warnings: parsed.warnings || [] }, [buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', id, message: String((err && err.message) || err).slice(-2000) });
    }
  }
};
