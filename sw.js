/* ============================================================================
   VITROLA — service worker

   Faz duas coisas:

   1. Guarda a casca do aplicativo, para abrir sem rede. É pouco arquivo e
      nenhum deles muda sozinho, então cache-primeiro é a estratégia certa:
      abre instantâneo e só vai à rede quando falta algo.

   2. Recebe áudio compartilhado de outros aplicativos. No Android, o
      `share_target` do manifesto manda um POST para cá; eu tiro os arquivos
      do formulário, guardo, e redireciono para a página, que os recolhe.
      Sem isto, "compartilhar com a Vitrola" simplesmente não existe.
   ========================================================================== */

/* A estratégia é cache-primeiro, então este nome É o botão de publicar:
   enquanto ele não muda, quem já tem o aplicativo instalado continua abrindo
   a cópia guardada e NUNCA vê a versão nova. Trocar arquivo da casca sem
   trocar este texto é publicar para ninguém.
   v1 → v3 em 08/08/2026, junto com a reescrita 3.0. */
const VERSAO = 'vitrola-v3';

const CASCA = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icones/icone-192.png',
  './icones/icone-512.png',
  './icones/icone-maskable-512.png',
  './icones/apple-touch-icon.png',
];

/* ------------------------------------------------------------- instalação */

self.addEventListener('install', ev => {
  ev.waitUntil((async () => {
    const cache = await caches.open(VERSAO);
    // um a um: se um arquivo faltar, os outros ainda entram. `addAll`
    // aborta tudo por causa de um só, e aí o app fica sem cache nenhum.
    await Promise.all(CASCA.map(u =>
      cache.add(new Request(u, { cache: 'reload' })).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', ev => {
  ev.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(nomes.filter(n => n !== VERSAO).map(n => caches.delete(n)));
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.disable();
    }
    await self.clients.claim();
  })());
});

/* ------------------------------------------- guarda dos arquivos recebidos */

const BANCO = 'vitrola-compartilhados';
const LOJA  = 'entrada';

function abrirBanco() {
  return new Promise((ok, erro) => {
    const req = indexedDB.open(BANCO, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(LOJA)) {
        req.result.createObjectStore(LOJA, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => erro(req.error);
  });
}

async function guardarRecebidos(arquivos) {
  const db = await abrirBanco();
  await Promise.all(arquivos.map(a => new Promise((ok, erro) => {
    const tx = db.transaction(LOJA, 'readwrite');
    const r = tx.objectStore(LOJA).add({ arquivo: a, nome: a.name || 'audio' });
    r.onsuccess = () => ok();
    r.onerror = () => erro(r.error);
  })));
}

/* ---------------------------------------------------------------- pedidos */

self.addEventListener('fetch', ev => {
  const req = ev.request;
  const url = new URL(req.url);

  // 1. áudio chegando de outro aplicativo
  if (req.method === 'POST' && url.pathname.endsWith('/compartilhar')) {
    ev.respondWith((async () => {
      try {
        const form = await req.formData();
        const arquivos = form.getAll('audio').filter(a => a && a.size);
        if (arquivos.length) await guardarRecebidos(arquivos);
        return Response.redirect('./?compartilhado=' + arquivos.length, 303);
      } catch (_) {
        return Response.redirect('./', 303);
      }
    })());
    return;
  }

  if (req.method !== 'GET') return;

  // 2. navegação: a casca do cache primeiro, para abrir sem rede
  if (req.mode === 'navigate') {
    ev.respondWith((async () => {
      const guardada = await caches.match('./index.html', { ignoreSearch: true });
      if (guardada) return guardada;
      try { return await fetch(req); }
      catch (_) { return new Response('Sem conexão e sem cópia guardada.', { status: 503 }); }
    })());
    return;
  }

  // 3. o resto: cache primeiro, rede como reserva
  if (url.origin !== self.location.origin) return;

  ev.respondWith((async () => {
    const guardado = await caches.match(req);
    if (guardado) return guardado;
    try {
      const resposta = await fetch(req);
      if (resposta && resposta.ok && resposta.type === 'basic') {
        const cache = await caches.open(VERSAO);
        cache.put(req, resposta.clone());
      }
      return resposta;
    } catch (e) {
      return new Response('', { status: 504 });
    }
  })());
});

/* Permite a página mandar o worker novo assumir sem esperar recarregar. */
self.addEventListener('message', ev => {
  if (ev.data === 'assumir-agora') self.skipWaiting();
});
