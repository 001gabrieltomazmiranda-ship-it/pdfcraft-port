/**
 * Tool Bridge
 *
 * Liga o leitor do aplicativo (celular) às ferramentas. Quando uma ferramenta
 * roda dentro do leitor, ela recebe o PDF que está aberto já carregado (não
 * precisa escolher o arquivo de novo) e o resultado pode voltar para o próprio
 * documento ("Aplicar no documento"), com Desfazer.
 *
 * Fora do leitor (site/desktop) não existe ponte: `useToolBridge()` devolve
 * `null` e as ferramentas se comportam exatamente como antes.
 */

'use client';

import { createContext, useContext } from 'react';

export interface ToolBridge {
  /** Documento aberto no leitor (já com as edições feitas na tela), se houver. */
  file: File | null;
  /** Entrega o documento à primeira área de envio de PDF da ferramenta (uma única vez). */
  takeFile: () => File | null;
  /** Diz se o documento já foi entregue à ferramenta. */
  hasTaken: () => boolean;
  /** Troca o documento aberto pelo resultado (entra no histórico do Desfazer). */
  apply: (blob: Blob, name?: string) => void;
  /** Abre o resultado como outro documento, sem mexer no atual. */
  openCopy: (blob: Blob, name: string) => void;
}

const ToolBridgeContext = createContext<ToolBridge | null>(null);

export const ToolBridgeProvider = ToolBridgeContext.Provider;

export function useToolBridge(): ToolBridge | null {
  return useContext(ToolBridgeContext);
}
