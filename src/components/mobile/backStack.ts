'use client';

import { useEffect, useRef } from 'react';

/**
 * Botão "Voltar" do Android para as folhas que abrem por cima do leitor.
 *
 * Cada folha aberta (Mais ferramentas, ferramenta, painel...) ocupa uma entrada
 * extra no histórico. Ao apertar Voltar, só a folha de cima fecha, em vez de
 * sair do leitor. Quando a folha fecha por outro caminho (Aplicar, X), a entrada
 * extra é desfeita sem fechar mais nada.
 */

interface Layer {
  close: () => void;
}

const layers: Layer[] = [];
let depth = 0; // entradas de histórico criadas por nós
let ignore = 0; // popstate provocado por nós mesmos
let pushedAt = '';
let timer: ReturnType<typeof setTimeout> | null = null;
let bound = false;

function sync() {
  timer = null;
  if (typeof window === 'undefined') return;
  while (depth < layers.length) {
    window.history.pushState(window.history.state ?? {}, '');
    pushedAt = window.location.href;
    depth++;
  }
  if (depth > layers.length) {
    const extra = depth - layers.length;
    depth = layers.length;
    // Se a página mudou no meio do caminho, não mexe no histórico.
    if (window.location.href === pushedAt) {
      ignore++;
      window.history.go(-extra);
    }
  }
}

function schedule() {
  if (timer === null) timer = setTimeout(sync, 0);
}

function onPop() {
  if (ignore > 0) {
    ignore--;
    return;
  }
  if (depth === 0) return;
  depth--;
  const top = layers[layers.length - 1];
  if (top) top.close();
}

/** Faz o Voltar do Android fechar esta folha enquanto ela estiver aberta. */
export function useBackClose(onClose: () => void): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!bound) {
      window.addEventListener('popstate', onPop);
      bound = true;
    }
    const layer: Layer = { close: () => ref.current() };
    layers.push(layer);
    schedule();
    return () => {
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
      schedule();
    };
  }, []);
}
