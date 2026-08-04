'use strict';

/* ============================================================================
   VITROLA — toca os arquivos de música do seu aparelho.

   Nada sai daqui: não há servidor, não há envio, não há biblioteca externa.
   Título, artista, capa, cor e letra são lidos do próprio arquivo.

   Índice:
     1. Utilidades              6. Áudio
     2. Leitor de ID3           7. Brilho e pulso
     3. Cor da capa             8. Media Session
     4. Guarda (IndexedDB)      9. Telas e desenho
     5. Fila e estado          10. Entrada e arranque
   ========================================================================== */


/* ===========================================================================
   1. UTILIDADES
   ========================================================================= */

const $ = id => document.getElementById(id);

function tempo(seg) {
  if (!isFinite(seg) || seg < 0) seg = 0;
  const m = Math.floor(seg / 60), s = Math.floor(seg % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function avisar(texto) { $('aviso').textContent = texto; }

function mostrar(el, visivel) { if (el) el.toggleAttribute('hidden', !visivel); }

const menosMovimento = window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgDe(d, preenchido) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  if (preenchido) { p.setAttribute('fill', 'currentColor'); p.setAttribute('stroke', 'none'); }
  s.appendChild(p);
  return s;
}


/* ===========================================================================
   2. LEITOR DE ID3 — escrito à mão, sem biblioteca

   Suporta v2.2, v2.3 e v2.4 (título, artista, álbum, ano, faixa, capa e
   letra) e cai para o ID3v1 dos 128 bytes finais quando não há v2.
   ========================================================================= */

const ROTULO_ENC = { 0: 'windows-1252', 1: 'utf-16', 2: 'utf-16be', 3: 'utf-8' };

function latim(b, i, n) {
  let s = '';
  for (let k = i; k < i + n && k < b.length; k++) s += String.fromCharCode(b[k]);
  return s;
}

function lerU32(b, i) {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

/** Inteiro sincro-seguro: 7 bits úteis por byte, para nunca imitar um
    quadro de sincronismo de MP3. */
function sincroSeguro(b, i) {
  return ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) |
         ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
}

function decodificar(bytes, enc) {
  try { return new TextDecoder(ROTULO_ENC[enc] || 'utf-8').decode(bytes); }
  catch (_) { return latim(bytes, 0, bytes.length); }
}

function textoDoQuadro(corpo) {
  if (!corpo.length) return '';
  return decodificar(corpo.subarray(1), corpo[0]).replace(/\0[\s\S]*$/, '').trim();
}

/** Anda até o fim de uma cadeia terminada em nulo (duplo, se for UTF-16). */
function pularTexto(corpo, p, enc) {
  if (enc === 1 || enc === 2) {
    while (p + 1 < corpo.length && !(corpo[p] === 0 && corpo[p + 1] === 0)) p += 2;
    return p + 2;
  }
  while (p < corpo.length && corpo[p] !== 0) p++;
  return p + 1;
}

function capaDoQuadro(corpo, versao) {
  if (corpo.length < 4) return null;
  const enc = corpo[0];
  let p = 1, mime;

  if (versao === 2) {                       // PIC: formato em 3 letras
    mime = latim(corpo, 1, 3).toLowerCase();
    p = 4;
  } else {                                  // APIC: mime terminado em nulo
    let q = p;
    while (q < corpo.length && corpo[q] !== 0) q++;
    mime = latim(corpo, p, q - p).toLowerCase();
    p = q + 1;
  }

  p += 1;                                   // o byte do tipo de imagem
  p = pularTexto(corpo, p, enc);            // a descrição
  if (p >= corpo.length) return null;

  if (!mime || mime === 'jpg' || mime === 'jpeg' || mime === 'image/jpg') mime = 'image/jpeg';
  else if (mime === 'png') mime = 'image/png';
  else if (!mime.includes('/')) mime = 'image/' + mime;

  return new Blob([corpo.subarray(p)], { type: mime });
}

/** USLT: a letra inteira, sem marcação de tempo. */
function letraCorrida(corpo) {
  if (corpo.length < 5) return null;
  const enc = corpo[0];
  let p = pularTexto(corpo, 4, enc);         // pula idioma (3) e descrição
  if (p >= corpo.length) return null;
  const texto = decodificar(corpo.subarray(p), enc).replace(/\0+$/, '');
  const linhas = texto.split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean);
  return linhas.length ? { tipo: 'corrida', linhas } : null;
}

/** SYLT: a letra COM marcação de tempo — é o que permite o efeito karaokê. */
function letraSincronizada(corpo) {
  if (corpo.length < 7) return null;
  const enc = corpo[0];
  const formato = corpo[4];                  // 2 = milissegundos
  if (formato !== 2) return null;            // em quadros de MPEG eu não sei converter
  let p = pularTexto(corpo, 6, enc);         // pula idioma, formato, tipo e descrição

  const linhas = [];
  while (p < corpo.length - 4) {
    const inicio = p;
    p = pularTexto(corpo, p, enc);
    if (p > corpo.length - 4) break;
    let texto = decodificar(corpo.subarray(inicio, p), enc).replace(/\0+$/, '').trim();
    const t = lerU32(corpo, p) / 1000;
    p += 4;
    texto = texto.replace(/^[\r\n]+/, '');
    if (texto) linhas.push({ t, texto });
  }
  return linhas.length ? { tipo: 'sincronizada', linhas } : null;
}

const CAMPO = {
  TIT2: 'titulo', TT2: 'titulo',
  TPE1: 'artista', TP1: 'artista',
  TALB: 'album',  TAL: 'album',
  TRCK: 'faixa',  TRK: 'faixa',
  TYER: 'ano',    TYE: 'ano', TDRC: 'ano',
};

function parecerQuadro(b, p, idLen, fim) {
  if (p >= fim) return true;
  if (p + idLen > b.length) return false;
  for (let k = 0; k < idLen; k++) {
    const c = b[p + k];
    if (!((c >= 65 && c <= 90) || (c >= 48 && c <= 57))) return false;
  }
  return true;
}

function lerID3v2(b, versao) {
  const bandeiras = b[5];
  const fim = Math.min(b.length, 10 + sincroSeguro(b, 6));
  let p = 10;

  if (bandeiras & 0x40) {                   // cabeçalho estendido, raro
    p += versao >= 4 ? sincroSeguro(b, p) : lerU32(b, p) + 4;
  }

  const idLen  = versao === 2 ? 3 : 4;
  const cabLen = versao === 2 ? 6 : 10;
  const achados = {};

  while (p + cabLen <= fim) {
    const id = latim(b, p, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;     // chegou no enchimento de zeros

    let tam;
    if (versao === 2) {
      tam = (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5];
    } else if (versao >= 4) {
      tam = sincroSeguro(b, p + 4);
      // Há codificador que grava v2.4 com tamanho comum, fora da norma.
      // Se o próximo quadro não fizer sentido, tenta a outra leitura.
      const alt = lerU32(b, p + 4);
      if (alt !== tam && !parecerQuadro(b, p + cabLen + tam, idLen, fim)
                      &&  parecerQuadro(b, p + cabLen + alt, idLen, fim)) {
        tam = alt;
      }
    } else {
      tam = lerU32(b, p + 4);
    }

    if (tam <= 0 || p + cabLen + tam > fim) break;
    const corpo = b.subarray(p + cabLen, p + cabLen + tam);

    try {
      if (CAMPO[id]) {
        const t = textoDoQuadro(corpo);
        if (t && !achados[CAMPO[id]]) achados[CAMPO[id]] = t;
      } else if ((id === 'APIC' || id === 'PIC') && !achados.capa) {
        achados.capa = capaDoQuadro(corpo, versao);
      } else if ((id === 'SYLT' || id === 'SLT') && !achados.letraSinc) {
        achados.letraSinc = letraSincronizada(corpo);
      } else if ((id === 'USLT' || id === 'ULT') && !achados.letraTexto) {
        achados.letraTexto = letraCorrida(corpo);
      }
    } catch (_) { /* quadro torto não derruba os outros */ }

    p += cabLen + tam;
  }
  return achados;
}

async function lerID3v1(arquivo) {
  if (arquivo.size < 128) return {};
  const b = new Uint8Array(await arquivo.slice(arquivo.size - 128).arrayBuffer());
  if (latim(b, 0, 3) !== 'TAG') return {};
  const campo = (i, n) => latim(b, i, n).replace(/\0[\s\S]*$/, '').trim();
  const r = {};
  if (campo(3, 30))  r.titulo  = campo(3, 30);
  if (campo(33, 30)) r.artista = campo(33, 30);
  if (campo(63, 30)) r.album   = campo(63, 30);
  return r;
}

/** Lê o que der. Nunca falha: no pior caso devolve o nome do arquivo. */
async function lerEtiquetas(arquivo) {
  let tags = {};
  try {
    const cabeca = new Uint8Array(await arquivo.slice(0, 10).arrayBuffer());
    if (cabeca[0] === 0x49 && cabeca[1] === 0x44 && cabeca[2] === 0x33) {
      const total = Math.min(10 + sincroSeguro(cabeca, 6), arquivo.size, 12 * 1024 * 1024);
      const b = new Uint8Array(await arquivo.slice(0, total).arrayBuffer());
      tags = lerID3v2(b, cabeca[3]) || {};
    }
  } catch (_) {}

  if (!tags.titulo || !tags.artista) {
    try {
      const v1 = await lerID3v1(arquivo);
      for (const k in v1) if (!tags[k]) tags[k] = v1[k];
    } catch (_) {}
  }

  if (!tags.titulo) {
    tags.titulo = arquivo.name.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim();
  }
  if (!tags.artista) tags.artista = 'Artista desconhecido';
  return tags;
}


/* ===========================================================================
   3. COR DA CAPA
   O verde-limão é a cor das ações e não muda. A cor da capa serve ao
   BRILHO do fundo — a capa ilumina o ambiente, sem disputar com o limão.
   ========================================================================= */

function corDaImagem(img) {
  const N = 40;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const x = cv.getContext('2d', { willReadFrequently: true });
  let d;
  try {
    x.drawImage(img, 0, 0, N, N);
    d = x.getImageData(0, 0, N, N).data;
  } catch (_) { return null; }

  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue;
    const mx = Math.max(d[i], d[i + 1], d[i + 2]);
    const mn = Math.min(d[i], d[i + 1], d[i + 2]);
    // pondera pela viveza: um detalhe saturado vale mais que uma área
    // grande e barrenta
    const peso = 0.35 + (mx - mn) / 255;
    r += d[i] * peso; g += d[i + 1] * peso; b += d[i + 2] * peso; n += peso;
  }
  if (!n) return null;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}


/* ===========================================================================
   4. GUARDA — IndexedDB, para a biblioteca sobreviver ao fechar
   ========================================================================= */

const BANCO = 'vitrola', LOJA = 'faixas';
let bancoPromessa = null;

function banco() {
  if (bancoPromessa) return bancoPromessa;
  bancoPromessa = new Promise((ok, erro) => {
    if (!window.indexedDB) return erro(new Error('sem IndexedDB'));
    const req = indexedDB.open(BANCO, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(LOJA)) {
        req.result.createObjectStore(LOJA, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => erro(req.error);
  }).catch(e => { bancoPromessa = null; throw e; });
  return bancoPromessa;
}

function loja(modo) {
  return banco().then(db => db.transaction(LOJA, modo).objectStore(LOJA));
}

async function guardar(registro) {
  try {
    const l = await loja('readwrite');
    return await new Promise((ok, erro) => {
      const r = l.add(registro);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => erro(r.error);
    });
  } catch (e) {
    if (e && e.name === 'QuotaExceededError') {
      avisar('O aparelho ficou sem espaço. A fila desta sessão continua, mas não será lembrada.');
    }
    return null;
  }
}

async function regravar(registro) {
  try {
    const l = await loja('readwrite');
    l.put(registro);
  } catch (_) {}
}

async function todasGuardadas() {
  try {
    const l = await loja('readonly');
    return await new Promise((ok, erro) => {
      const r = l.getAll();
      r.onsuccess = () => ok(r.result || []);
      r.onerror = () => erro(r.error);
    });
  } catch (_) { return []; }
}

async function esquecerTudo() {
  try { (await loja('readwrite')).clear(); } catch (_) {}
}


/* ===========================================================================
   5. FILA E ESTADO
   ========================================================================= */

const som = $('som');

const estado = {
  fila: [],          // { id, arquivo, tags, capaURL, url, dur, curtida, letra }
  atual: -1,
  ordem: [],
  aleatorio: false,
  // 'tudo' e não 'nao': o transporte tem cinco controles e nenhum deles é
  // repetir, então não haveria como religar. Parar de tocar ao chegar na
  // última faixa, sem aviso e sem botão, seria só parecer defeito.
  repetir: 'tudo',   // 'nao' | 'tudo' | 'uma'
  filtro: 'todas',
  vista: 'biblioteca',
  arrastando: false,
  corCapa: null,
};

function faixaAtual() {
  return estado.atual >= 0 ? estado.fila[estado.atual] : null;
}

function refazerOrdem() {
  estado.ordem = estado.fila.map((_, i) => i);
  if (!estado.aleatorio) return;
  for (let i = estado.ordem.length - 1; i > 0; i--) {   // Fisher-Yates
    const j = Math.floor(Math.random() * (i + 1));
    const t = estado.ordem[i]; estado.ordem[i] = estado.ordem[j]; estado.ordem[j] = t;
  }
  const p = estado.ordem.indexOf(estado.atual);
  if (p > 0) { estado.ordem.splice(p, 1); estado.ordem.unshift(estado.atual); }
}

function vizinha(passo) {
  if (!estado.fila.length) return -1;
  const p = estado.ordem.indexOf(estado.atual);
  let novo = p + passo;
  if (novo >= estado.ordem.length) {
    if (estado.repetir === 'nao') return -1;
    novo = 0;
    if (estado.aleatorio) refazerOrdem();
  }
  if (novo < 0) novo = estado.ordem.length - 1;
  return estado.ordem[novo];
}

function filtradas() {
  if (estado.filtro === 'curtidas') {
    return estado.fila.map((f, i) => ({ f, i })).filter(x => x.f.curtida);
  }
  const todas = estado.fila.map((f, i) => ({ f, i }));
  if (estado.filtro === 'artistas') {
    todas.sort((a, b) =>
      a.f.tags.artista.localeCompare(b.f.tags.artista, 'pt-BR') ||
      a.f.tags.titulo.localeCompare(b.f.tags.titulo, 'pt-BR'));
  }
  return todas;
}


/* ===========================================================================
   6. ÁUDIO
   ========================================================================= */

let ac = null, analisador = null, espectro = null;

function ligarAudio() {
  if (ac) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  try {
    ac = new AC();
    const fonte = ac.createMediaElementSource(som);   // só pode uma vez
    analisador = ac.createAnalyser();
    analisador.fftSize = 1024;
    analisador.smoothingTimeConstant = 0.8;
    fonte.connect(analisador);
    analisador.connect(ac.destination);
    espectro = new Uint8Array(analisador.frequencyBinCount);
    return true;
  } catch (_) { ac = null; return false; }
}

function acordarAudio() { if (ac && ac.state === 'suspended') ac.resume(); }


/* ===========================================================================
   7. BRILHO E PULSO
   O brilho é a própria capa, ampliada e desfocada. O pulso é um sopro de
   luz que respira com os graves — profundidade sem competir com a leitura.
   ========================================================================= */

const cvPulso = $('pulso');
const eco = { grave: 0, fase: 0 };
let medida = null;

function medir() {
  if (medida) return medida;
  const d = Math.min(window.devicePixelRatio || 1, 2) * 0.6;
  const r = cvPulso.getBoundingClientRect();
  medida = {
    ctx: cvPulso.getContext('2d'), d,
    l: Math.max(1, Math.round(r.width * d)),
    a: Math.max(1, Math.round(r.height * d)),
  };
  if (cvPulso.width !== medida.l) cvPulso.width = medida.l;
  if (cvPulso.height !== medida.a) cvPulso.height = medida.a;
  return medida;
}

function desenharPulso(dt) {
  if (menosMovimento) return;
  const m = medir();
  m.ctx.clearRect(0, 0, m.l, m.a);

  let g = 0;
  if (analisador && espectro && !som.paused) {
    analisador.getByteFrequencyData(espectro);
    const ate = Math.floor(espectro.length * 0.06);
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += espectro[i];
    g = (soma / ate) / 255;
  }
  // sobe depressa e desce devagar: é como o ouvido sente o som, e sem isso
  // o fundo treme em vez de pulsar
  eco.grave += (g - eco.grave) * (g > eco.grave ? 0.28 : 0.05);
  eco.fase += dt * (0.25 + eco.grave * 0.9);

  const c = estado.corCapa;
  if (!c || eco.grave < 0.02) return;

  const cx = m.l / 2;
  const cy = m.a * 0.30;
  const raio = Math.hypot(m.l, m.a) * (0.34 + eco.grave * 0.20);
  const alfa = 0.05 + eco.grave * 0.16;

  const luz = m.ctx.createRadialGradient(cx, cy, 0, cx, cy, raio);
  luz.addColorStop(0, 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alfa.toFixed(3) + ')');
  luz.addColorStop(0.6, 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (alfa * 0.25).toFixed(3) + ')');
  luz.addColorStop(1, 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',0)');
  m.ctx.fillStyle = luz;
  m.ctx.fillRect(0, 0, m.l, m.a);
}


/* ===========================================================================
   8. MEDIA SESSION — capa e controles na tela de bloqueio
   ========================================================================= */

function anunciarAoSistema(f) {
  if (!('mediaSession' in navigator) || !f) return;
  const arte = [];
  if (f.capaURL) arte.push({ src: f.capaURL, sizes: '512x512', type: 'image/jpeg' });
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: f.tags.titulo,
      artist: f.tags.artista,
      album: f.tags.album || '',
      artwork: arte,
    });
  } catch (_) {}
}

function ligarControlesDoSistema() {
  if (!('mediaSession' in navigator)) return;
  const acoes = {
    play:          () => tocar(),
    pause:         () => pausar(),
    previoustrack: () => pular(-1),
    nexttrack:     () => pular(1),
    seekbackward:  d => { som.currentTime = Math.max(0, som.currentTime - ((d && d.seekOffset) || 10)); },
    seekforward:   d => { som.currentTime = Math.min(som.duration || 0, som.currentTime + ((d && d.seekOffset) || 10)); },
    seekto:        d => { if (d && d.seekTime != null) som.currentTime = d.seekTime; },
    stop:          () => { pausar(); som.currentTime = 0; },
  };
  for (const nome in acoes) {
    try { navigator.mediaSession.setActionHandler(nome, acoes[nome]); } catch (_) {}
  }
}

function posicaoNoSistema() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!isFinite(som.duration) || som.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: som.duration,
      position: Math.min(som.currentTime, som.duration),
      playbackRate: som.playbackRate || 1,
    });
  } catch (_) {}
}


/* ===========================================================================
   9. TELAS E DESENHO
   ========================================================================= */

function irPara(vista) {
  estado.vista = vista;
  mostrar($('tela-biblioteca'), vista === 'biblioteca');
  mostrar($('tela-tocando'), vista === 'tocando');
  fecharMenu();
  if (vista === 'tocando') pintarLetra(true);
}

function fecharMenu() {
  $('menu').hidden = true;
  $('btn-menu').setAttribute('aria-expanded', 'false');
}

/* ---- tema: escuro e claro, à escolha ----
   O verde-limão não muda de valor quando é PREENCHIMENTO (com texto
   escuro em cima ele funciona nos dois). Como TINTA ele muda: sobre
   fundo claro o verde vivo mede 1,4:1 e some. Quem cuida disso é o
   token --lima-tinta, no CSS. */
function temaAtual() {
  return document.documentElement.getAttribute('data-tema') === 'claro' ? 'claro' : 'escuro';
}

function aplicarTema(t) {
  if (t === 'claro') document.documentElement.setAttribute('data-tema', 'claro');
  else document.documentElement.removeAttribute('data-tema');

  const rot = $('rotulo-tema');
  if (rot) rot.textContent = t === 'claro' ? 'claro' : 'escuro';

  // a barra de status do sistema acompanha o fundo
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'claro' ? '#F4F5F7' : '#0B0B0D');

  // dentro do aplicativo Android, avisa o sistema para as barras de status
  // e de navegação acompanharem. No navegador esta ponte não existe.
  try { if (window.Sistema && window.Sistema.tema) window.Sistema.tema(t); } catch (_) {}

  try { localStorage.setItem('vitrola:tema', t); } catch (_) {}
}

const D_CORACAO = 'M12 20.5S3.5 15 3.5 9.2A4.7 4.7 0 0 1 12 6.4a4.7 4.7 0 0 1 8.5 2.8c0 5.8-8.5 11.3-8.5 11.3z';
const D_DISCO   = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 7.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z';

function pintarLista() {
  const ol = $('lista');
  ol.innerHTML = '';
  const itens = filtradas();

  const vazioGeral = estado.fila.length === 0;
  mostrar($('vazio'), vazioGeral);
  mostrar(ol, !vazioGeral);

  if (vazioGeral) return;

  if (!itens.length) {
    const li = document.createElement('li');
    li.className = 'lista-grupo';
    li.textContent = estado.filtro === 'curtidas'
      ? 'Você ainda não curtiu nenhuma faixa'
      : 'Nada aqui';
    ol.appendChild(li);
    return;
  }

  let artistaAnterior = null;
  for (const { f, i } of itens) {
    if (estado.filtro === 'artistas' && f.tags.artista !== artistaAnterior) {
      artistaAnterior = f.tags.artista;
      const cab = document.createElement('li');
      cab.className = 'lista-grupo';
      cab.textContent = artistaAnterior;
      ol.appendChild(cab);
    }

    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'item';
    b.dataset.i = i;
    b.setAttribute('aria-current', i === estado.atual ? 'true' : 'false');

    const capa = document.createElement('span');
    capa.className = 'item-capa';
    if (f.capaURL) {
      const img = document.createElement('img');
      img.src = f.capaURL;
      img.alt = '';
      capa.appendChild(img);
    } else {
      capa.appendChild(svgDe(D_DISCO, true));
    }

    const txt = document.createElement('span');
    txt.className = 'item-txt';
    const tit = document.createElement('strong');
    tit.className = 'item-tit';
    tit.textContent = f.tags.titulo;
    tit.title = f.tags.titulo;
    const sub = document.createElement('span');
    sub.className = 'item-sub';
    if (f.curtida) {
      const c = svgDe(D_CORACAO, true);
      c.setAttribute('class', 'item-curtida');
      sub.appendChild(c);
    }
    sub.appendChild(document.createTextNode(
      'De ' + f.tags.artista + (f.dur ? '  ·  ' + tempo(f.dur) : '')));
    txt.append(tit, sub);

    const play = document.createElement('span');
    play.className = 'item-play';
    play.appendChild(svgDe('M8 5v14l11-7z', true));

    b.setAttribute('aria-label',
      f.tags.titulo + ', de ' + f.tags.artista + (f.dur ? ', ' + tempo(f.dur) : '') +
      (f.curtida ? ', curtida' : ''));

    b.append(capa, txt, play);
    li.appendChild(b);
    ol.appendChild(li);
  }
}

function pintarAgora() {
  const f = faixaAtual();

  $('titulo').textContent  = f ? f.tags.titulo : 'Nenhuma faixa';
  $('artista').textContent = f ? f.tags.artista : 'Escolha uma música na biblioteca';

  const img = $('capa-img');
  if (f && f.capaURL) {
    img.src = f.capaURL;
    img.alt = 'Capa de ' + (f.tags.album || f.tags.titulo);
    mostrar(img, true);
    mostrar($('bolacha-vazia'), false);
  } else {
    img.removeAttribute('src');
    mostrar(img, false);
    mostrar($('bolacha-vazia'), true);
  }

  // o brilho: a mesma capa, ampliada e desfocada por trás de tudo
  const bimg = $('brilho-img');
  if (f && f.capaURL) {
    bimg.src = f.capaURL;
    $('brilho').classList.add('aceso');
  } else {
    bimg.removeAttribute('src');
    $('brilho').classList.remove('aceso');
    estado.corCapa = null;
  }

  $('btn-curtir').setAttribute('aria-pressed', f && f.curtida ? 'true' : 'false');
  $('btn-curtir').setAttribute('aria-label', f && f.curtida ? 'Descurtir' : 'Curtir');

  // mini player
  mostrar($('mini'), !!f);
  if (f) {
    $('mini-titulo').textContent = f.tags.titulo;
    $('mini-artista').textContent = f.tags.artista;
    const mi = $('mini-img');
    if (f.capaURL) { mi.src = f.capaURL; mi.alt = ''; } else { mi.removeAttribute('src'); }
  }

  document.title = f ? (f.tags.titulo + ' — ' + f.tags.artista) : 'Vitrola';
}

function pintarBotaoTocar() {
  const tocando = !som.paused;
  mostrar($('icone-tocar'), !tocando);
  mostrar($('icone-pausa'), tocando);
  mostrar($('mini-icone-tocar'), !tocando);
  mostrar($('mini-icone-pausa'), tocando);
  const r = tocando ? 'Pausar' : 'Tocar';
  $('btn-tocar').setAttribute('aria-label', r);
  $('mini-tocar').setAttribute('aria-label', r);
}

function pintarProgresso() {
  const dur = isFinite(som.duration) ? som.duration : 0;
  const p = dur ? som.currentTime / dur : 0;
  $('trilho-cheio').style.width = (p * 100).toFixed(3) + '%';
  $('trilho-bola').style.insetInlineStart = (p * 100).toFixed(3) + '%';
  $('t-atual').textContent = tempo(som.currentTime);
  $('t-resta').textContent = '-' + tempo(Math.max(0, dur - som.currentTime));

  const t = $('trilho');
  t.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  t.setAttribute('aria-valuetext', dur
    ? tempo(som.currentTime) + ' de ' + tempo(dur)
    : 'sem faixa');
}

/* ---- a letra ---- */
let letraIndice = -1;

function pintarLetra(forcar) {
  const f = faixaAtual();
  const antes = $('letra-antes'), atual = $('letra-atual'), depois = $('letra-depois');
  const caixa = $('letra');

  // sem faixa a área da letra some inteira, senão abre um buraco no meio
  // da composição e o disco deixa de ser o centro
  mostrar(caixa, !!f);

  if (!f || !f.letra) {
    if (forcar) {
      antes.textContent = '';
      atual.className = 'letra-linha letra-aviso';
      atual.textContent = f ? 'Este arquivo não traz a letra.' : '';
      depois.textContent = '';
      letraIndice = -1;
    }
    return;
  }

  atual.className = 'letra-linha letra-atual';
  const L = f.letra.linhas;

  if (f.letra.tipo === 'corrida') {
    // sem marcação de tempo não dá para acompanhar; mostro as três
    // primeiras linhas e digo que é assim mesmo
    if (!forcar) return;
    antes.textContent  = L[0] || '';
    atual.textContent  = L[1] || L[0] || '';
    depois.textContent = L[2] || '';
    caixa.title = 'Letra sem marcação de tempo';
    return;
  }

  let i = 0;
  while (i + 1 < L.length && L[i + 1].t <= som.currentTime) i++;
  if (som.currentTime < L[0].t) i = -1;
  if (i === letraIndice && !forcar) return;
  letraIndice = i;

  antes.textContent  = i > 0 ? L[i - 1].texto : '';
  atual.textContent  = i >= 0 ? L[i].texto : (L[0] ? L[0].texto : '');
  depois.textContent = L[i + 1] ? L[i + 1].texto : '';
}


/* --------------------------------------------------------- toca-discos */

async function carregar(i, tocarDepois) {
  const f = estado.fila[i];
  if (!f) return;
  estado.atual = i;

  if (!f.url) f.url = URL.createObjectURL(f.arquivo);
  som.src = f.url;

  letraIndice = -1;
  pintarAgora();
  pintarLista();
  pintarLetra(true);
  anunciarAoSistema(f);
  avisar(f.tags.titulo + ', de ' + f.tags.artista);

  if (f.capaURL) {
    const img = new Image();
    img.onload = () => { estado.corCapa = corDaImagem(img); };
    img.onerror = () => { estado.corCapa = null; };
    img.src = f.capaURL;
  } else {
    estado.corCapa = null;
  }

  if (tocarDepois) tocar();
}

function tocar() {
  if (estado.atual < 0 && estado.fila.length) {
    return carregar(estado.ordem.length ? estado.ordem[0] : 0, true);
  }
  ligarAudio(); acordarAudio();
  som.play().then(pintarBotaoTocar).catch(() => {});
}

function pausar() { som.pause(); pintarBotaoTocar(); }

function pular(passo) {
  const i = vizinha(passo);
  if (i < 0) { pausar(); som.currentTime = 0; return; }
  carregar(i, true);
}

function alternarCurtida() {
  const f = faixaAtual();
  if (!f) return;
  f.curtida = !f.curtida;
  if (f.id != null) {
    regravar({ id: f.id, arquivo: f.arquivo, tags: f.tagsCruas, capa: f.capaBlob, curtida: f.curtida });
  }
  pintarAgora();
  pintarLista();
  avisar(f.curtida ? 'Curtida' : 'Descurtida');
}


/* ------------------------------------------------------ entrada de arquivos */

async function acrescentar(arquivos, guardarNoBanco) {
  const lista = Array.from(arquivos).filter(a =>
    (a.type && a.type.startsWith('audio/')) ||
    /\.(mp3|m4a|ogg|oga|opus|flac|wav|aac)$/i.test(a.name || ''));

  if (!lista.length) { avisar('Nenhum arquivo de áudio reconhecido.'); return; }

  const primeira = estado.fila.length === 0;

  for (const arquivo of lista) {
    const tags = await lerEtiquetas(arquivo);
    const capa = tags.capa || null;
    const letra = tags.letraSinc || tags.letraTexto || null;
    const limpas = { titulo: tags.titulo, artista: tags.artista, album: tags.album, ano: tags.ano, faixa: tags.faixa };

    const f = {
      id: null, arquivo, tags: limpas, tagsCruas: limpas, capaBlob: capa, letra,
      capaURL: capa ? URL.createObjectURL(capa) : null,
      url: null, dur: 0, curtida: false,
    };
    estado.fila.push(f);

    if (guardarNoBanco) {
      guardar({ arquivo, tags: limpas, capa, letra, curtida: false })
        .then(id => { if (id != null) f.id = id; });
    }

    const sonda = new Audio();
    sonda.preload = 'metadata';
    sonda.onloadedmetadata = () => {
      f.dur = sonda.duration;
      pintarLista();
      URL.revokeObjectURL(sonda.src);
    };
    sonda.src = URL.createObjectURL(arquivo);
  }

  refazerOrdem();
  pintarLista();
  avisar(lista.length === 1 ? 'Uma faixa adicionada.' : lista.length + ' faixas adicionadas.');
  if (primeira) carregar(0, false);
}

async function recuperarBiblioteca() {
  const guardadas = await todasGuardadas();
  if (!guardadas.length) return;
  for (const g of guardadas) {
    const f = {
      id: g.id, arquivo: g.arquivo, tags: g.tags, tagsCruas: g.tags,
      capaBlob: g.capa || null, letra: g.letra || null,
      capaURL: g.capa ? URL.createObjectURL(g.capa) : null,
      url: null, dur: 0, curtida: !!g.curtida,
    };
    estado.fila.push(f);
    const sonda = new Audio();
    sonda.preload = 'metadata';
    sonda.onloadedmetadata = () => { f.dur = sonda.duration; pintarLista(); URL.revokeObjectURL(sonda.src); };
    sonda.src = URL.createObjectURL(g.arquivo);
  }
  refazerOrdem();
  pintarLista();
  carregar(0, false);
  avisar(guardadas.length + ' faixas recuperadas.');
}


/* ===========================================================================
   10. ENTRADA E ARRANQUE
   ========================================================================= */

/* --- navegação --- */
$('btn-voltar').addEventListener('click', () => irPara('biblioteca'));
$('mini-abrir').addEventListener('click', () => irPara('tocando'));
$('mini-abrir-txt').addEventListener('click', () => irPara('tocando'));
$('btn-fila').addEventListener('click', () => irPara('biblioteca'));

$('btn-menu').addEventListener('click', e => {
  e.stopPropagation();
  const m = $('menu');
  m.hidden = !m.hidden;
  $('btn-menu').setAttribute('aria-expanded', String(!m.hidden));
});
document.addEventListener('click', e => {
  if (!$('menu').hidden && !$('menu').contains(e.target)) fecharMenu();
});

/* --- filtros --- */
for (const c of document.querySelectorAll('.chip')) {
  c.addEventListener('click', () => {
    estado.filtro = c.dataset.filtro;
    for (const o of document.querySelectorAll('.chip')) {
      o.setAttribute('aria-pressed', String(o === c));
    }
    pintarLista();
  });
}

/* --- lista --- */
$('lista').addEventListener('click', e => {
  const b = e.target.closest('.item');
  if (b) { carregar(Number(b.dataset.i), true); irPara('tocando'); }
});

/* --- transporte --- */
$('btn-tocar').addEventListener('click', () => (som.paused ? tocar() : pausar()));
$('mini-tocar').addEventListener('click', () => (som.paused ? tocar() : pausar()));
$('btn-proximo').addEventListener('click', () => pular(1));
$('mini-proximo').addEventListener('click', () => pular(1));
$('btn-anterior').addEventListener('click', () => {
  if (som.currentTime > 3) { som.currentTime = 0; return; }
  pular(-1);
});
$('btn-curtir').addEventListener('click', alternarCurtida);

$('btn-aleatorio').addEventListener('click', e => {
  estado.aleatorio = !estado.aleatorio;
  e.currentTarget.setAttribute('aria-pressed', String(estado.aleatorio));
  refazerOrdem();
  avisar(estado.aleatorio ? 'Ordem aleatória ligada' : 'Ordem aleatória desligada');
});

$('btn-tema').addEventListener('click', () => {
  aplicarTema(temaAtual() === 'claro' ? 'escuro' : 'claro');
  avisar('Tema ' + temaAtual());
});

$('btn-embaralhar-tudo').addEventListener('click', () => {
  if (!estado.fila.length) return;
  estado.aleatorio = true;
  $('btn-aleatorio').setAttribute('aria-pressed', 'true');
  refazerOrdem();
  carregar(estado.ordem[0], true);
  irPara('tocando');
});

$('btn-limpar').addEventListener('click', async () => {
  pausar();
  for (const f of estado.fila) {
    if (f.url) URL.revokeObjectURL(f.url);
    if (f.capaURL) URL.revokeObjectURL(f.capaURL);
  }
  estado.fila = []; estado.atual = -1; estado.ordem = []; estado.corCapa = null;
  som.removeAttribute('src'); som.load();
  await esquecerTudo();
  fecharMenu();
  pintarLista(); pintarAgora(); pintarBotaoTocar(); pintarProgresso();
  avisar('Biblioteca esvaziada.');
});

/* --- progresso --- */
const trilho = $('trilho');
function buscarPor(clientX) {
  if (!isFinite(som.duration) || som.duration <= 0) return;
  const r = trilho.getBoundingClientRect();
  const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  som.currentTime = p * som.duration;
  pintarProgresso();
  pintarLetra(true);
}
trilho.addEventListener('pointerdown', e => {
  estado.arrastando = true;
  trilho.setPointerCapture(e.pointerId);
  buscarPor(e.clientX);
});
trilho.addEventListener('pointermove', e => { if (estado.arrastando) buscarPor(e.clientX); });
trilho.addEventListener('pointerup', e => {
  estado.arrastando = false;
  try { trilho.releasePointerCapture(e.pointerId); } catch (_) {}
});
trilho.addEventListener('keydown', e => {
  if (!isFinite(som.duration)) return;
  const salto = e.shiftKey ? 30 : 5;
  if (e.key === 'ArrowRight') { som.currentTime = Math.min(som.duration, som.currentTime + salto); e.preventDefault(); }
  if (e.key === 'ArrowLeft')  { som.currentTime = Math.max(0, som.currentTime - salto); e.preventDefault(); }
});

/* --- arquivos --- */
for (const b of [$('btn-adicionar'), $('btn-adicionar-vazio')]) {
  if (b) b.addEventListener('click', () => $('arquivos').click());
}
$('arquivos').addEventListener('change', e => {
  acrescentar(e.target.files, true);
  e.target.value = '';
});

/* --- arrastar e soltar --- */
let contaArrasto = 0;
window.addEventListener('dragenter', e => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
  e.preventDefault(); contaArrasto++; $('cortina').hidden = false;
});
window.addEventListener('dragover', e => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  if (--contaArrasto <= 0) { contaArrasto = 0; $('cortina').hidden = true; }
});
window.addEventListener('drop', e => {
  e.preventDefault(); contaArrasto = 0; $('cortina').hidden = true;
  if (e.dataTransfer && e.dataTransfer.files.length) acrescentar(e.dataTransfer.files, true);
});

/* --- teclado --- */
window.addEventListener('keydown', e => {
  const a = e.target;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key) {
    case ' ': case 'k': e.preventDefault(); som.paused ? tocar() : pausar(); break;
    case 'ArrowRight': e.preventDefault(); pular(1); break;
    case 'ArrowLeft':  e.preventDefault(); pular(-1); break;
    case 'Escape':     irPara('biblioteca'); break;
    default: {
      const k = e.key.toLowerCase();
      if (k === 's') $('btn-aleatorio').click();
      else if (k === 'l') alternarCurtida();
    }
  }
}, { passive: false });

/* --- eventos do áudio --- */
som.addEventListener('play', () => { acordarAudio(); pintarBotaoTocar(); });
som.addEventListener('playing', acordarAudio);
som.addEventListener('pause', pintarBotaoTocar);
document.addEventListener('visibilitychange', () => { if (!som.paused) acordarAudio(); });

som.addEventListener('timeupdate', () => { pintarProgresso(); pintarLetra(false); posicaoNoSistema(); });
som.addEventListener('loadedmetadata', () => {
  const f = faixaAtual();
  if (f && !f.dur) { f.dur = som.duration; pintarLista(); }
  pintarProgresso(); posicaoNoSistema();
});
som.addEventListener('ended', () => {
  if (estado.repetir === 'uma') { som.currentTime = 0; tocar(); return; }
  pular(1);
});
som.addEventListener('error', () => {
  const f = faixaAtual();
  const nome = f ? '“' + f.tags.titulo + '”' : 'Esta faixa';
  avisar(nome + ' não abre neste aparelho. Converta para MP3 ou M4A e adicione de novo.');
});

/* --- redimensionar --- */
let espera = 0;
window.addEventListener('resize', () => {
  clearTimeout(espera);
  espera = setTimeout(() => { medida = null; }, 150);
});

/* --- laço --- */
let anterior = 0;
function quadro(agora) {
  requestAnimationFrame(quadro);
  const dt = anterior ? Math.min(0.1, (agora - anterior) / 1000) : 0.016;
  anterior = agora;
  desenharPulso(dt);
}

/* --- service worker: só no navegador, e falha em silêncio --- */
(async function ligarAplicativo() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  try { await navigator.serviceWorker.register('sw.js', { scope: './' }); } catch (_) {}
})();

/* --- arranque --- */
(function iniciar() {
  let salvo = null;
  try { salvo = localStorage.getItem('vitrola:tema'); } catch (_) {}
  aplicarTema(salvo === 'claro' ? 'claro' : 'escuro');

  ligarControlesDoSistema();
  irPara('biblioteca');
  pintarLista();
  pintarAgora();
  pintarLetra(true);          // sem isto a área da letra fica ocupando espaço
  pintarBotaoTocar();         // antes mesmo de existir faixa
  pintarProgresso();
  recuperarBiblioteca().catch(() => {});
  requestAnimationFrame(quadro);
})();
