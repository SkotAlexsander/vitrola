'use strict';

/* ============================================================================
   VITROLA — toca os MP3 do seu computador.

   Nada sai da máquina: não há servidor, não há upload, não há biblioteca.
   As etiquetas, a capa e a cor são lidas do próprio arquivo, aqui.

   Índice:
     1. Utilidades              6. Áudio e picos de onda
     2. Leitor de ID3           7. Desenho: onda e espectro
     3. Cor da capa             8. Media Session
     4. Biblioteca (IndexedDB)  9. Interface
     5. Fila e estado          10. Entrada e arranque
   ========================================================================== */


/* ===========================================================================
   1. UTILIDADES
   ========================================================================= */

const $ = id => document.getElementById(id);

function tempo(seg) {
  if (!isFinite(seg) || seg < 0) seg = 0;
  const m = Math.floor(seg / 60), s = Math.floor(seg % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function avisar(texto) { $('aviso').textContent = texto; }

const menosMovimento = window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Ajusta um canvas à sua caixa em CSS, respeitando a densidade da tela.

   A medida fica em cache de propósito. `getBoundingClientRect()` força o
   navegador a recalcular layout; chamar isso 60 vezes por segundo, em dois
   canvas, durante as horas que um player fica aberto, é desperdício puro.
   O cache só vence quando a janela muda de tamanho.                      */
const medidas = new Map();
let medidasVencidas = true;

function encaixarCanvas(cv, escala) {
  let m = medidas.get(cv);
  if (!m || medidasVencidas) {
    const d = Math.min(window.devicePixelRatio || 1, 2) * (escala || 1);
    const r = cv.getBoundingClientRect();
    m = {
      ctx: cv.getContext('2d'),
      d,
      l: Math.max(1, Math.round(r.width * d)),
      a: Math.max(1, Math.round(r.height * d)),
    };
    if (cv.width !== m.l || cv.height !== m.a) { cv.width = m.l; cv.height = m.a; }
    medidas.set(cv, m);
  }
  return m;
}

function lerVar(nome) {
  return getComputedStyle(document.documentElement).getPropertyValue(nome).trim();
}


/* ===========================================================================
   2. LEITOR DE ID3 — escrito à mão, sem biblioteca

   Suporta ID3v2.2, v2.3 e v2.4 (título, artista, álbum, ano, faixa e capa)
   e cai para o ID3v1 dos 128 bytes finais quando não há v2.
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

/** Inteiro "sincro-seguro": 7 bits úteis por byte, para nunca imitar um
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

  // a descrição também termina em nulo — duplo, se o texto for UTF-16
  if (enc === 1 || enc === 2) {
    while (p + 1 < corpo.length && !(corpo[p] === 0 && corpo[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    while (p < corpo.length && corpo[p] !== 0) p++;
    p += 1;
  }
  if (p >= corpo.length) return null;

  if (!mime || mime === 'jpg' || mime === 'jpeg' || mime === 'image/jpg') mime = 'image/jpeg';
  else if (mime === 'png') mime = 'image/png';
  else if (!mime.includes('/')) mime = 'image/' + mime;

  return new Blob([corpo.subarray(p)], { type: mime });
}

const CAMPO = {
  TIT2: 'titulo', TT2: 'titulo',
  TPE1: 'artista', TP1: 'artista',
  TALB: 'album',  TAL: 'album',
  TRCK: 'faixa',  TRK: 'faixa',
  TYER: 'ano',    TYE: 'ano', TDRC: 'ano',
};

function parecerQuadro(b, p, idLen, fim) {
  if (p >= fim) return true;                // acabou: também vale
  if (p + idLen > b.length) return false;
  for (let k = 0; k < idLen; k++) {
    const c = b[p + k];
    const ok = (c >= 65 && c <= 90) || (c >= 48 && c <= 57);
    if (!ok) return false;
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

    if (CAMPO[id]) {
      const t = textoDoQuadro(corpo);
      if (t && !achados[CAMPO[id]]) achados[CAMPO[id]] = t;
    } else if ((id === 'APIC' || id === 'PIC') && !achados.capa) {
      try { achados.capa = capaDoQuadro(corpo, versao); } catch (_) {}
    }

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

/** Lê o que der do arquivo. Nunca falha: no pior caso devolve o nome dele. */
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
    tags.titulo = arquivo.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
  }
  if (!tags.artista) tags.artista = 'Artista desconhecido';
  return tags;
}


/* ===========================================================================
   3. COR DA CAPA

   Dois passos. Primeiro acha a cor que manda na capa — ponderando por
   viveza, para que um detalhe saturado ganhe de uma área grande e barrenta.
   Depois **corrige a luminosidade** dela até passar no contraste WCAG contra
   o fundo do tema em vigor: capa clara em tema claro daria uma cor que some.
   ========================================================================= */

function rgbParaHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r)      h = ((g - b) / d + (g < b ? 6 : 0));
    else if (mx === g) h = ((b - r) / d + 2);
    else               h = ((r - g) / d + 4);
    h *= 60;
  }
  const l = (mx + mn) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [h, s, l];
}

function hslParaRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if      (h <  60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else              { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function canalLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminancia(rgb) {
  return 0.2126 * canalLinear(rgb[0]) + 0.7152 * canalLinear(rgb[1]) + 0.0722 * canalLinear(rgb[2]);
}

function contraste(l1, l2) {
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function hexParaRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** A cor que manda na imagem, em HSL. Null se a capa for cinza ou ilegível. */
function corDaImagem(img) {
  const N = 56;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const x = cv.getContext('2d', { willReadFrequently: true });
  let d;
  try {
    x.drawImage(img, 0, 0, N, N);
    d = x.getImageData(0, 0, N, N).data;
  } catch (_) {
    return null;                            // tela suja: origem cruzada
  }

  const baldes = new Map();                 // 30 faixas de matiz, de 12 graus
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue;
    const [h, s, l] = rgbParaHsl(d[i], d[i + 1], d[i + 2]);
    if (s < 0.16 || l < 0.08 || l > 0.94) continue;   // cinza e extremos fora
    const chave = Math.floor(h / 12);
    const peso = s * s * (1 - Math.abs(l - 0.5) * 1.2);
    const b = baldes.get(chave) || { peso: 0, h: 0, s: 0, l: 0, n: 0 };
    b.peso += peso; b.h += h; b.s += s; b.l += l; b.n++;
    baldes.set(chave, b);
  }

  let melhor = null;
  for (const b of baldes.values()) if (!melhor || b.peso > melhor.peso) melhor = b;
  if (!melhor) return null;

  return {
    h: melhor.h / melhor.n,
    s: Math.min(0.92, (melhor.s / melhor.n) * 1.12),
    l: melhor.l / melhor.n,
  };
}

/** Sobe ou desce a luminosidade até bater o contraste pedido contra o fundo. */
function corrigirContraste(hsl, fundoHex, alvo) {
  const lumFundo = luminancia(hexParaRgb(fundoHex));
  const escurecer = lumFundo > 0.35;        // fundo claro pede cor escura
  const passo = escurecer ? -0.015 : 0.015;
  let l = hsl.l;

  for (let i = 0; i < 70; i++) {
    if (contraste(luminancia(hslParaRgb(hsl.h, hsl.s, l)), lumFundo) >= alvo) break;
    l += passo;
    if (l <= 0.05 || l >= 0.95) break;
  }
  return { h: hsl.h, s: hsl.s, l: Math.max(0.05, Math.min(0.95, l)) };
}

const ALVO_CONTRASTE = 4.5;                 // o mínimo do WCAG para texto

let corBruta = null;                        // a extraída, antes da correção

function aplicarCor(hsl) {
  corBruta = hsl;
  const raiz = document.documentElement;
  if (!hsl) {                               // sem faixa = sem cor
    raiz.style.removeProperty('--cor');
    return;
  }
  const fundo = temaEscuro() ? '#0E0E10' : '#E8E9EC';
  const c = corrigirContraste(hsl, fundo, ALVO_CONTRASTE);
  const [r, g, b] = hslParaRgb(c.h, c.s, c.l);
  raiz.style.setProperty('--cor', `rgb(${r} ${g} ${b})`);
  estado.corRGB = [r, g, b];
}


/* ===========================================================================
   4. BIBLIOTECA — IndexedDB, para a fila sobreviver ao recarregar
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

function transacao(modo) {
  return banco().then(db => db.transaction(LOJA, modo).objectStore(LOJA));
}

async function guardar(registro) {
  try {
    const loja = await transacao('readwrite');
    return await new Promise((ok, erro) => {
      const r = loja.add(registro);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => erro(r.error);
    });
  } catch (e) {
    if (e && e.name === 'QuotaExceededError') {
      avisar('O navegador ficou sem espaço — a fila desta sessão continua, mas não será lembrada.');
    }
    return null;
  }
}

async function todasGuardadas() {
  try {
    const loja = await transacao('readonly');
    return await new Promise((ok, erro) => {
      const r = loja.getAll();
      r.onsuccess = () => ok(r.result || []);
      r.onerror = () => erro(r.error);
    });
  } catch (_) { return []; }
}

async function esquecerTudo() {
  try { (await transacao('readwrite')).clear(); } catch (_) {}
}


/* ===========================================================================
   5. FILA E ESTADO
   ========================================================================= */

const som = $('som');

const estado = {
  fila: [],            // { id, arquivo, tags, url, capaURL, dur, picos }
  atual: -1,
  ordem: [],           // índices, embaralhados quando aleatório está ligado
  aleatorio: false,
  repetir: 'nao',      // 'nao' | 'tudo' | 'uma'
  corRGB: null,
  arrastando: false,
};

function faixaAtual() {
  return estado.atual >= 0 ? estado.fila[estado.atual] : null;
}

function refazerOrdem() {
  estado.ordem = estado.fila.map((_, i) => i);
  if (!estado.aleatorio) return;
  for (let i = estado.ordem.length - 1; i > 0; i--) {   // Fisher-Yates
    const j = Math.floor(Math.random() * (i + 1));
    [estado.ordem[i], estado.ordem[j]] = [estado.ordem[j], estado.ordem[i]];
  }
  // a que está tocando vai para a frente, para não repetir na hora
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


/* ===========================================================================
   6. ÁUDIO E PICOS DE ONDA
   ========================================================================= */

let ac = null, analisador = null, espectroDados = null;

function ligarAudio() {
  if (ac) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  try {
    ac = new AC();
    const fonte = ac.createMediaElementSource(som);   // só pode uma vez
    analisador = ac.createAnalyser();
    analisador.fftSize = 2048;
    analisador.smoothingTimeConstant = 0.82;
    fonte.connect(analisador);
    analisador.connect(ac.destination);
    espectroDados = new Uint8Array(analisador.frequencyBinCount);
    return true;
  } catch (_) { ac = null; return false; }
}

function acordarAudio() {
  if (ac && ac.state === 'suspended') ac.resume();
}

/** Decodifica a faixa inteira e reduz a `n` picos. É isto que faz a barra de
    progresso ser a forma de onda de verdade, e não um desenho decorativo. */
async function calcularPicos(arquivo, n = 1000) {
  // Decodifica num contexto DESCARTÁVEL, de propósito. Usar o contexto de
  // reprodução aqui seria uma armadilha: ele nasceria fora de um clique, e
  // um AudioContext suspenso com o <audio> ligado nele toca em silêncio.
  // O OfflineAudioContext decodifica sem depender de gesto do usuário.
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return null;
  const forno = new OAC(1, 1, 44100);

  const buf = await arquivo.arrayBuffer();
  const audio = await new Promise((ok, erro) => {
    const p = forno.decodeAudioData(buf, ok, erro);
    if (p && p.then) p.then(ok, erro);            // Safari usa a forma antiga
  });

  const canais = Math.min(audio.numberOfChannels, 2);
  const dados = [];
  for (let c = 0; c < canais; c++) dados.push(audio.getChannelData(c));

  const bloco = Math.max(1, Math.floor(dados[0].length / n));
  const picos = new Float32Array(n);
  let topo = 0;

  for (let i = 0; i < n; i++) {
    const ini = i * bloco, fim = Math.min(ini + bloco, dados[0].length);
    let max = 0;
    for (let j = ini; j < fim; j += 3) {          // amostra 1 em 3: é o bastante
      for (let c = 0; c < canais; c++) {
        const v = Math.abs(dados[c][j]);
        if (v > max) max = v;
      }
    }
    picos[i] = max;
    if (max > topo) topo = max;
  }
  if (topo > 0) for (let i = 0; i < n; i++) picos[i] /= topo;
  return picos;
}


/* ===========================================================================
   7. DESENHO
   ========================================================================= */

const cvOnda = $('onda'), cvEspectro = $('espectro');

function corAcento(alfa) {
  const c = estado.corRGB;
  if (!c) return `rgba(140,142,150,${alfa})`;
  return `rgba(${c[0]},${c[1]},${c[2]},${alfa})`;
}

let corOndaOff = '#84858A';
function relerCoresDoTema() {
  corOndaOff = lerVar('--onda-off') || corOndaOff;
}

function desenharOnda() {
  const { ctx, l, a, d } = encaixarCanvas(cvOnda);
  ctx.clearRect(0, 0, l, a);

  const f = faixaAtual();
  const meio = a / 2;

  // Sem faixa: um fio no centro, e só. Antes eu desenhava barrinhas de
  // amplitude fixa aqui, e o resultado parecia chuvisco de televisão
  // quebrada. Vazio de verdade também não serve — abre um buraco na
  // composição. O fio diz "aqui é a barra de progresso" sem mentir.
  if (!f) {
    ctx.fillStyle = corOndaOff;
    ctx.fillRect(0, meio - Math.max(1, d / 2), l, Math.max(1, d));
    return;
  }

  const prog = som.duration ? som.currentTime / som.duration : 0;

  const corte = l * prog;

  const largura = 2 * d;
  const vao = 1 * d;
  const passo = largura + vao;
  const barras = Math.floor(l / passo);
  const picos = f && f.picos;

  for (let i = 0; i < barras; i++) {
    const x = i * passo;
    let v;
    if (picos) {
      const k = Math.floor(i / barras * picos.length);
      v = picos[k];
    } else {
      v = 0.10;                             // ainda decodificando: fio reto
    }
    const h = Math.max(1 * d, v * (meio - 2 * d));
    // a cor da parte não tocada vem do token, não de um hex repetido aqui:
    // duplicar o valor era garantia de o CSS e o canvas discordarem
    ctx.fillStyle = x + largura <= corte ? corAcento(1) : corOndaOff;
    ctx.fillRect(x, meio - h, largura, h * 2);
  }

  if (f && som.duration) {                  // agulha
    ctx.fillStyle = corAcento(1);
    ctx.fillRect(Math.min(corte, l - d), 0, Math.max(1, d), a);
  }
}

function desenharEspectro() {
  const { ctx, l, a, d } = encaixarCanvas(cvEspectro);
  ctx.clearRect(0, 0, l, a);
  if (!analisador || !espectroDados) return;

  analisador.getByteFrequencyData(espectroDados);

  // as graves ocupam poucos compartimentos e as agudas muitos: a escala
  // logarítmica é a que corresponde ao que o ouvido percebe
  const n = 72;
  const total = espectroDados.length * 0.72;
  ctx.beginPath();
  ctx.moveTo(0, a);

  const pontos = [];
  for (let i = 0; i < n; i++) {
    const a0 = Math.floor(Math.pow(i / n, 2.1) * total);
    const a1 = Math.max(a0 + 1, Math.floor(Math.pow((i + 1) / n, 2.1) * total));
    let soma = 0;
    for (let k = a0; k < a1 && k < espectroDados.length; k++) soma += espectroDados[k];
    const v = (soma / (a1 - a0)) / 255;
    pontos.push({ x: (i / (n - 1)) * l, y: a - Math.pow(v, 1.35) * a * 0.95 });
  }

  ctx.moveTo(0, a);
  for (const p of pontos) ctx.lineTo(p.x, p.y);
  ctx.lineTo(l, a);
  ctx.closePath();
  ctx.fillStyle = corAcento(0.30);
  ctx.fill();

  ctx.beginPath();
  pontos.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.strokeStyle = corAcento(0.9);
  ctx.lineWidth = 1.4 * d;
  ctx.stroke();
}

/* --------------------------------------------------- o disco de fundo

   Três camadas de sulcos concêntricos, cada uma girando a uma velocidade
   diferente. É daí que vem a profundidade: o que está mais longe gira mais
   devagar, é mais fino e mais apagado — o mesmo truque de paralaxe de um
   cenário pintado.

   Os anéis não são círculos perfeitos: o raio ondula ao longo do ângulo, e
   a amplitude dessa onda vem do espectro. Círculo perfeito girando não
   parece girar — precisa da deformação para o olho perceber o movimento.  */

const cvFundo = $('fundo');
const eco = { grave: 0, medio: 0, agudo: 0, giro: 0 };
let centroFundo = null;

function energiaDe(dados, de, ate) {
  let soma = 0, n = 0;
  const fim = Math.min(Math.floor(ate), dados.length);
  for (let i = Math.floor(de); i < fim; i++) { soma += dados[i]; n++; }
  return n ? (soma / n) / 255 : 0;
}

/* O disco gira em torno da capa, não do meio da tela: é a capa que é o
   assunto, e centrar ali amarra o fundo ao conteúdo. */
function centroDoDisco(l, a, d) {
  if (centroFundo) return centroFundo;
  const capa = $('capa').getBoundingClientRect();
  centroFundo = capa.width
    ? { x: (capa.left + capa.width / 2) * d, y: (capa.top + capa.height / 2) * d }
    : { x: l / 2, y: a / 2 };
  return centroFundo;
}

const CAMADAS = [
  { aneis: 16, r0: 0.10, r1: 0.72, giro:  1.00, alfa: 0.26, esp: 1.5, onda: 1.00, lados: 48 },
  { aneis: 11, r0: 0.30, r1: 1.05, giro: -0.52, alfa: 0.15, esp: 1.1, onda: 0.62, lados: 40 },
  { aneis:  7, r0: 0.60, r1: 1.55, giro:  0.26, alfa: 0.08, esp: 0.8, onda: 0.34, lados: 32 },
];

function desenharFundo(dt) {
  // resolução reduzida de propósito: é imagem macia, ninguém vê o pixel,
  // e são três camadas desenhando a cada quadro
  const { ctx, l, a, d } = encaixarCanvas(cvFundo, 0.72);
  ctx.clearRect(0, 0, l, a);
  if (menosMovimento) return;

  let g = 0, m = 0, ag = 0;
  if (analisador && espectroDados && !som.paused) {
    analisador.getByteFrequencyData(espectroDados);
    const n = espectroDados.length;
    g  = energiaDe(espectroDados, 0, n * 0.05);
    m  = energiaDe(espectroDados, n * 0.05, n * 0.22);
    ag = energiaDe(espectroDados, n * 0.22, n * 0.55);
  }

  // sobe depressa, desce devagar: é assim que o ouvido sente o som, e sem
  // isso o fundo treme em vez de pulsar
  const sub = 0.30, desc = 0.05;
  eco.grave += (g  - eco.grave) * (g  > eco.grave ? sub : desc);
  eco.medio += (m  - eco.medio) * (m  > eco.medio ? sub : desc);
  eco.agudo += (ag - eco.agudo) * (ag > eco.agudo ? sub : desc);
  eco.giro  += dt * (0.05 + eco.grave * 0.22);

  const c = centroDoDisco(l, a, d);
  const base = Math.hypot(l, a) * 0.5;

  const raio = base * (0.55 + eco.grave * 0.25);
  const brilho = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, raio);
  brilho.addColorStop(0,    corAcento(0.13 + eco.grave * 0.12));
  brilho.addColorStop(0.45, corAcento(0.045));
  brilho.addColorStop(1,    corAcento(0));
  ctx.fillStyle = brilho;
  ctx.fillRect(0, 0, l, a);

  for (const cam of CAMADAS) {
    const fase = eco.giro * cam.giro;
    for (let i = 0; i < cam.aneis; i++) {
      const t = cam.aneis === 1 ? 0 : i / (cam.aneis - 1);
      const R = base * (cam.r0 + (cam.r1 - cam.r0) * t);
      const amp  = R * 0.045 * cam.onda * (0.25 + eco.medio * 1.6);
      const amp2 = R * 0.022 * cam.onda * eco.agudo * 1.4;

      ctx.beginPath();
      for (let k = 0; k <= cam.lados; k++) {
        const th = (k / cam.lados) * Math.PI * 2;
        const r = R + Math.sin(th * 3 + fase + i * 0.4) * amp
                    + Math.sin(th * 7 - fase * 1.7 + i * 0.9) * amp2;
        const x = c.x + Math.cos(th) * r;
        const y = c.y + Math.sin(th) * r;
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      const some = 1 - t * 0.65;
      ctx.strokeStyle = corAcento(cam.alfa * some * (0.5 + eco.grave * 0.7));
      ctx.lineWidth = Math.max(0.5, cam.esp * d * some);
      ctx.stroke();
    }
  }
}

let laco = 0, marcaAnterior = 0, conta = 0;

function quadro(agora) {
  laco = requestAnimationFrame(quadro);
  const dt = marcaAnterior ? Math.min(0.1, (agora - marcaAnterior) / 1000) : 0.016;
  marcaAnterior = agora;
  conta++;

  // parado, o fundo só precisa respirar — um quadro a cada três poupa
  // bateria sem que ninguém perceba
  if (!som.paused || conta % 3 === 0) desenharFundo(dt);

  if (!som.paused || estado.arrastando) desenharOnda();
  if (!som.paused && !menosMovimento) desenharEspectro();
  medidasVencidas = false;      // já foi medido neste quadro; vale até redimensionar
}


/* ===========================================================================
   8. MEDIA SESSION — capa e controles na tela de bloqueio do celular
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
    play:            () => tocar(),
    pause:           () => pausar(),
    previoustrack:   () => pular(-1),
    nexttrack:       () => pular(1),
    seekbackward:    d => { som.currentTime = Math.max(0, som.currentTime - ((d && d.seekOffset) || 10)); },
    seekforward:     d => { som.currentTime = Math.min(som.duration || 0, som.currentTime + ((d && d.seekOffset) || 10)); },
    seekto:          d => { if (d && d.seekTime != null) som.currentTime = d.seekTime; },
    stop:            () => { pausar(); som.currentTime = 0; },
  };
  for (const nome in acoes) {
    try { navigator.mediaSession.setActionHandler(nome, acoes[nome]); } catch (_) {}
  }
}

function atualizarPosicaoNoSistema() {
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
   9. INTERFACE
   ========================================================================= */

function temaEscuro() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function aplicarTema(t) {
  if (t) document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
  $('rotulo-tema').textContent = temaEscuro() ? 'Claro' : 'Escuro';
  relerCoresDoTema();
  pintarBarraDoSistema();                   // a barra do sistema segue o tema
  aplicarCor(corBruta);                     // o contraste muda com o fundo
  desenharOnda();
}

function pintarFila() {
  const ol = $('fila');
  ol.innerHTML = '';
  estado.fila.forEach((f, i) => {
    const li = document.createElement('li');

    // Um <button> de verdade, não um <li> com onclick. Sem isto a fila
    // inteira é inalcançável pelo teclado — não dá para trocar de faixa
    // sem mouse. É a primeira regra do ARIA: use o elemento nativo.
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fila-linha';
    b.dataset.i = i;
    b.setAttribute('aria-current', i === estado.atual ? 'true' : 'false');

    const num = document.createElement('span');
    num.className = 'fila-num';
    num.textContent = String(i + 1).padStart(2, '0');

    const txt = document.createElement('span');
    txt.className = 'fila-txt';
    const tit = document.createElement('strong');
    tit.className = 'fila-tit';
    tit.textContent = f.tags.titulo;
    tit.title = f.tags.titulo;            // o nome truncado continua alcançável
    const art = document.createElement('span');
    art.className = 'fila-art';
    art.textContent = f.tags.artista;
    art.title = f.tags.artista;
    txt.append(tit, art);

    const dur = document.createElement('span');
    dur.className = 'fila-dur';
    dur.textContent = f.dur ? tempo(f.dur) : '--:--';

    // o nome acessível diz tudo o que a linha mostra, em ordem de leitura
    b.setAttribute('aria-label',
      `${i + 1}. ${f.tags.titulo}, ${f.tags.artista}` + (f.dur ? `, ${tempo(f.dur)}` : ''));

    b.append(num, txt, dur);
    li.appendChild(b);
    ol.appendChild(li);
  });

  const n = estado.fila.length;
  $('conta').textContent = n === 1 ? '1 faixa' : `${n} faixas`;
  $('encarte-vazio').hidden = n > 0;
  $('btn-limpar').hidden = n === 0;
}

function pintarAgora() {
  const f = faixaAtual();
  $('titulo').textContent  = f ? f.tags.titulo : 'Nenhuma faixa';
  $('artista').textContent = f ? f.tags.artista : 'Solte arquivos de áudio em qualquer lugar';
  $('album').textContent   = f && f.tags.album ? f.tags.album : '';

  const img = $('capa-img');
  if (f && f.capaURL) {
    img.src = f.capaURL; img.hidden = false; img.alt = `Capa de ${f.tags.album || f.tags.titulo}`;
    $('capa-vazia').hidden = true;
  } else {
    img.hidden = true; img.removeAttribute('src');
    $('capa-vazia').hidden = false;
  }
  document.title = f ? `${f.tags.titulo} — ${f.tags.artista}` : 'Vitrola';
}

/* `elemento.hidden = true` NÃO funciona em SVG: `hidden` é propriedade de
   HTMLElement, e num SVGElement a atribuição só cria uma propriedade solta
   que nunca vira atributo. O resultado é play e pausa desenhados juntos —
   e nenhum teste de lógica pega isso, porque a lógica está certa.
   `toggleAttribute` mexe no atributo de verdade, em qualquer elemento. */
function mostrar(el, visivel) {
  if (el) el.toggleAttribute('hidden', !visivel);
}

function pintarBotaoTocar() {
  const tocando = !som.paused;
  mostrar($('icone-tocar'), !tocando);
  mostrar($('icone-pausa'), tocando);
  $('btn-tocar').setAttribute('aria-label', tocando ? 'Pausar' : 'Tocar');
}


/* --------------------------------------------------------- ações de toca-fita */

async function carregar(i, tocarDepois) {
  const f = estado.fila[i];
  if (!f) return;
  estado.atual = i;

  if (!f.url) f.url = URL.createObjectURL(f.arquivo);
  som.src = f.url;

  pintarAgora();
  pintarFila();
  anunciarAoSistema(f);
  avisar(`${f.tags.titulo}, de ${f.tags.artista}`);   // troca de faixa também se anuncia

  // a cor vem da capa; sem capa, a interface volta ao preto e branco
  if (f.capaURL) {
    const img = new Image();
    img.onload = () => aplicarCor(corDaImagem(img));
    img.onerror = () => aplicarCor(null);
    img.src = f.capaURL;
  } else {
    aplicarCor(null);
  }

  if (tocarDepois) tocar();

  // os picos vêm depois: decodificar a faixa inteira não pode atrasar o play
  if (!f.picos && !f.picosPedidos) {
    f.picosPedidos = true;
    calcularPicos(f.arquivo)
      .then(p => { f.picos = p; if (faixaAtual() === f) desenharOnda(); })
      .catch(() => { f.picos = null; });
  }
  desenharOnda();
}

function tocar() {
  if (estado.atual < 0 && estado.fila.length) return carregar(estado.ordem[0] ?? 0, true);
  ligarAudio(); acordarAudio();
  som.play().then(pintarBotaoTocar).catch(() => {});
}

function pausar() { som.pause(); pintarBotaoTocar(); }

function pular(passo) {
  const i = vizinha(passo);
  if (i < 0) { pausar(); som.currentTime = 0; return; }
  carregar(i, true);
}


/* --------------------------------------------------------- entrada de arquivos */

async function acrescentar(arquivos, guardarNoBanco) {
  const lista = Array.from(arquivos).filter(a =>
    a.type.startsWith('audio/') || /\.(mp3|m4a|ogg|oga|opus|flac|wav|aac)$/i.test(a.name));

  if (!lista.length) {
    avisar('Nenhum arquivo de áudio reconhecido.');
    return;
  }

  const primeira = estado.fila.length === 0;

  for (const arquivo of lista) {
    const tags = await lerEtiquetas(arquivo);
    const capa = tags.capa || null;
    delete tags.capa;

    const f = {
      arquivo, tags,
      capaURL: capa ? URL.createObjectURL(capa) : null,
      url: null, dur: 0, picos: null,
    };
    estado.fila.push(f);

    if (guardarNoBanco) {
      guardar({ arquivo, tags, capa });     // sem await: não trava a fila
    }

    // duração sem tocar: um elemento de áudio descartável
    const sonda = new Audio();
    sonda.preload = 'metadata';
    sonda.onloadedmetadata = () => {
      f.dur = sonda.duration;
      pintarFila();
      URL.revokeObjectURL(sonda.src);
    };
    sonda.src = URL.createObjectURL(arquivo);
  }

  refazerOrdem();
  pintarFila();
  avisar(`${lista.length} ${lista.length === 1 ? 'faixa adicionada' : 'faixas adicionadas'}.`);

  if (primeira) carregar(estado.ordem[0] ?? 0, false);
}

async function recuperarBiblioteca() {
  const guardadas = await todasGuardadas();
  if (!guardadas.length) return;
  for (const g of guardadas) {
    estado.fila.push({
      arquivo: g.arquivo,
      tags: g.tags,
      capaURL: g.capa ? URL.createObjectURL(g.capa) : null,
      url: null, dur: 0, picos: null,
    });
    const sonda = new Audio();
    sonda.preload = 'metadata';
    const f = estado.fila[estado.fila.length - 1];
    sonda.onloadedmetadata = () => { f.dur = sonda.duration; pintarFila(); URL.revokeObjectURL(sonda.src); };
    sonda.src = URL.createObjectURL(g.arquivo);
  }
  refazerOrdem();
  pintarFila();
  carregar(0, false);
  avisar(`${guardadas.length} faixas recuperadas da sessão anterior.`);
}


/* ===========================================================================
   10. ENTRADA E ARRANQUE
   ========================================================================= */

/* --- transporte --- */
$('btn-tocar').addEventListener('click', () => (som.paused ? tocar() : pausar()));
$('btn-anterior').addEventListener('click', () => {
  if (som.currentTime > 3) { som.currentTime = 0; return; }   // como no CD player
  pular(-1);
});
$('btn-proximo').addEventListener('click', () => pular(1));

$('btn-aleatorio').addEventListener('click', e => {
  estado.aleatorio = !estado.aleatorio;
  e.currentTarget.setAttribute('aria-pressed', String(estado.aleatorio));
  refazerOrdem();
  avisar(estado.aleatorio ? 'Ordem aleatória ligada' : 'Ordem aleatória desligada');
});

$('btn-repetir').addEventListener('click', e => {
  estado.repetir = estado.repetir === 'nao' ? 'tudo' : estado.repetir === 'tudo' ? 'uma' : 'nao';
  e.currentTarget.setAttribute('aria-pressed', String(estado.repetir !== 'nao'));
  $('marca-um').hidden = estado.repetir !== 'uma';
  avisar({ nao: 'Repetir desligado', tudo: 'Repetir a fila', uma: 'Repetir esta faixa' }[estado.repetir]);
});

/* --- volume --- */
const volume = $('volume');
let volumeAntes = 0.85;
som.volume = 0.85;

volume.addEventListener('input', () => {
  som.volume = volume.value / 100;
  som.muted = som.volume === 0;
  pintarMudo();
});

function pintarMudo() {
  const mudo = som.muted || som.volume === 0;
  mostrar($('icone-som'), !mudo);
  mostrar($('icone-mudo'), mudo);
  $('btn-mudo').setAttribute('aria-label', mudo ? 'Voltar o som' : 'Sem som');
}

$('btn-mudo').addEventListener('click', () => {
  if (som.muted || som.volume === 0) {
    som.muted = false;
    som.volume = volumeAntes || 0.85;
  } else {
    volumeAntes = som.volume;
    som.muted = true;
  }
  volume.value = Math.round((som.muted ? 0 : som.volume) * 100);
  pintarMudo();
});

/* --- a onda também é a barra de progresso --- */
const caixaOnda = $('onda-caixa');

function buscarPor(clientX) {
  if (!isFinite(som.duration) || som.duration <= 0) return;
  const r = caixaOnda.getBoundingClientRect();
  const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  som.currentTime = p * som.duration;
  atualizarSlider();
  desenharOnda();
}

caixaOnda.addEventListener('pointerdown', e => {
  estado.arrastando = true;
  caixaOnda.setPointerCapture(e.pointerId);
  buscarPor(e.clientX);
});
caixaOnda.addEventListener('pointermove', e => { if (estado.arrastando) buscarPor(e.clientX); });
caixaOnda.addEventListener('pointerup',   e => {
  estado.arrastando = false;
  try { caixaOnda.releasePointerCapture(e.pointerId); } catch (_) {}
});
caixaOnda.addEventListener('keydown', e => {
  if (!isFinite(som.duration)) return;
  const salto = e.shiftKey ? 30 : 5;
  if (e.key === 'ArrowRight') { som.currentTime = Math.min(som.duration, som.currentTime + salto); e.preventDefault(); }
  if (e.key === 'ArrowLeft')  { som.currentTime = Math.max(0, som.currentTime - salto); e.preventDefault(); }
});

/* --- a fila --- */
$('fila').addEventListener('click', e => {
  const b = e.target.closest('.fila-linha');
  if (b) carregar(Number(b.dataset.i), true);
});

$('btn-limpar').addEventListener('click', async () => {
  pausar();
  for (const f of estado.fila) {
    if (f.url) URL.revokeObjectURL(f.url);
    if (f.capaURL) URL.revokeObjectURL(f.capaURL);
  }
  estado.fila = []; estado.atual = -1; estado.ordem = [];
  som.removeAttribute('src'); som.load();
  await esquecerTudo();
  aplicarCor(null);
  pintarFila(); pintarAgora(); pintarBotaoTocar(); desenharOnda();
  avisar('Fila esvaziada.');
});

/* --- arquivos --- */
for (const b of [$('btn-abrir'), $('btn-abrir-vazio')]) {
  if (b) b.addEventListener('click', () => $('arquivos').click());
}
$('arquivos').addEventListener('change', e => {
  acrescentar(e.target.files, true);
  e.target.value = '';
});

/* --- arrastar e soltar em qualquer lugar --- */
let contaArrasto = 0;
const cortina = $('cortina');

window.addEventListener('dragenter', e => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
  e.preventDefault();
  contaArrasto++;
  cortina.hidden = false;
});
window.addEventListener('dragover', e => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  if (--contaArrasto <= 0) { contaArrasto = 0; cortina.hidden = true; }
});
window.addEventListener('drop', e => {
  e.preventDefault();
  contaArrasto = 0;
  cortina.hidden = true;
  if (e.dataTransfer && e.dataTransfer.files.length) acrescentar(e.dataTransfer.files, true);
});

/* --- tema --- */
$('btn-tema').addEventListener('click', () => {
  const novo = temaEscuro() ? 'light' : 'dark';
  try { localStorage.setItem('vitrola:tema', novo); } catch (_) {}
  aplicarTema(novo);
});

if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!document.documentElement.hasAttribute('data-theme')) aplicarTema(null);
  });
}

/* --- teclado --- */
window.addEventListener('keydown', e => {
  const alvo = e.target;
  if (alvo && (alvo.tagName === 'INPUT' || alvo.tagName === 'TEXTAREA')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key) {
    case ' ': case 'k':
      e.preventDefault(); som.paused ? tocar() : pausar(); break;
    case 'ArrowRight': e.preventDefault(); pular(1); break;
    case 'ArrowLeft':  e.preventDefault(); pular(-1); break;
    case 'ArrowUp':
      e.preventDefault();
      som.volume = Math.min(1, som.volume + 0.05);
      volume.value = Math.round(som.volume * 100); pintarMudo(); break;
    case 'ArrowDown':
      e.preventDefault();
      som.volume = Math.max(0, som.volume - 0.05);
      volume.value = Math.round(som.volume * 100); pintarMudo(); break;
    default:
      const k = e.key.toLowerCase();
      if (k === 's') $('btn-aleatorio').click();
      else if (k === 'r') $('btn-repetir').click();
      else if (k === 'm') $('btn-mudo').click();
  }
}, { passive: false });

/* --- eventos do elemento de áudio --- */
som.addEventListener('play',  () => { acordarAudio(); pintarBotaoTocar(); });

som.addEventListener('pause', () => {
  pintarBotaoTocar();
  // sem isto o espectro congela na última leitura e fica mostrando som
  // onde já não há som nenhum
  const m = encaixarCanvas(cvEspectro);
  m.ctx.clearRect(0, 0, m.l, m.a);
});

/* O leitor de tela anunciando "37" não diz nada. `aria-valuetext` faz ele
   ler "1:23 de 3:45", que é a informação que a pessoa quer. */
function atualizarSlider() {
  if (!isFinite(som.duration) || som.duration <= 0) {
    caixaOnda.setAttribute('aria-valuenow', '0');
    caixaOnda.setAttribute('aria-valuetext', 'sem faixa');
    return;
  }
  caixaOnda.setAttribute('aria-valuenow', String(Math.round(som.currentTime / som.duration * 100)));
  caixaOnda.setAttribute('aria-valuetext', `${tempo(som.currentTime)} de ${tempo(som.duration)}`);
}

som.addEventListener('timeupdate', () => {
  $('t-atual').textContent = tempo(som.currentTime);
  atualizarSlider();
  atualizarPosicaoNoSistema();
});

som.addEventListener('loadedmetadata', () => {
  $('t-total').textContent = tempo(som.duration);
  const f = faixaAtual();
  if (f && !f.dur) { f.dur = som.duration; pintarFila(); }
  atualizarPosicaoNoSistema();
  desenharOnda();
});

som.addEventListener('ended', () => {
  if (estado.repetir === 'uma') { som.currentTime = 0; tocar(); return; }
  pular(1);
});

som.addEventListener('error', () => {
  const f = faixaAtual();
  const nome = f ? `“${f.tags.titulo}”` : 'esta faixa';
  // um erro é uma instrução: diz o que fazer, não só o que houve
  avisar(`${nome} não abre neste navegador. Converta para MP3 ou M4A e adicione de novo.`);
});

/* --- redimensionar --- */
let debounce = 0;
window.addEventListener('resize', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    medidasVencidas = true;
    centroFundo = null;         // a capa mudou de lugar; o disco tem de segui-la
    desenharOnda();
    desenharEspectro();
  }, 120);
});

/* ===========================================================================
   11. APLICATIVO — instalar, funcionar sem rede, receber áudio de fora
   ========================================================================= */

/* A barra de status acompanha o FUNDO do tema, não a cor do álbum. Pintar
   a barra de laranja com a página preta faria a emenda parecer defeito —
   a ousadia fica num lugar só, e esse lugar é a onda. */
function pintarBarraDoSistema() {
  const cor = temaEscuro() ? '#0E0E10' : '#E8E9EC';
  let m = document.getElementById('meta-barra');
  if (!m) {
    m = document.createElement('meta');
    m.id = 'meta-barra';
    m.name = 'theme-color';
    document.head.prepend(m);             // sem `media`, e primeiro: vence
  }
  m.content = cor;
}

/* --- áudio que não morre ao trocar de aplicativo ---------------------------
   O <audio> passa pelo AudioContext (é assim que o espectro existe). Se o
   sistema suspende esse contexto ao mandar a página para segundo plano, a
   música fica muda com o botão dizendo que está tocando. Retomar ao voltar,
   e ao primeiro sinal de reprodução, cobre os dois casos.                  */
document.addEventListener('visibilitychange', () => { if (!som.paused) acordarAudio(); });
som.addEventListener('playing', acordarAudio);

/* --- instalação ---------------------------------------------------------- */
let convite = null;
const btnInstalar = $('btn-instalar');

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();                     // o convite é nosso, na nossa hora
  convite = e;
  if (btnInstalar) btnInstalar.hidden = false;
});

if (btnInstalar) {
  btnInstalar.addEventListener('click', async () => {
    if (!convite) return;
    btnInstalar.hidden = true;
    convite.prompt();
    const { outcome } = await convite.userChoice;
    convite = null;
    avisar(outcome === 'accepted' ? 'Vitrola instalada.' : 'Instalação cancelada.');
  });
}

window.addEventListener('appinstalled', () => {
  convite = null;
  if (btnInstalar) btnInstalar.hidden = true;
});

/* --- áudio vindo de outro aplicativo -------------------------------------
   O service worker recebe o compartilhamento e deixa os arquivos aqui.
   Esta função esvazia a caixa e devolve o que achou.                      */
async function recolherCompartilhados() {
  if (!window.indexedDB) return [];
  const db = await new Promise((ok, erro) => {
    const r = indexedDB.open('vitrola-compartilhados', 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains('entrada')) {
        r.result.createObjectStore('entrada', { keyPath: 'id', autoIncrement: true });
      }
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => erro(r.error);
  }).catch(() => null);
  if (!db) return [];

  const itens = await new Promise(ok => {
    const r = db.transaction('entrada', 'readonly').objectStore('entrada').getAll();
    r.onsuccess = () => ok(r.result || []);
    r.onerror = () => ok([]);
  });
  if (itens.length) {
    await new Promise(ok => {
      const r = db.transaction('entrada', 'readwrite').objectStore('entrada').clear();
      r.onsuccess = r.onerror = () => ok();
    });
  }
  return itens.map(i => i.arquivo).filter(Boolean);
}

/* --- registro do service worker ------------------------------------------
   Só funciona em https (ou localhost). Aberto por duplo clique em file://
   o registro falha — e tem de falhar em silêncio: o player continua
   inteiro, só não guarda a casca para abrir sem rede.                     */
async function ligarAplicativo() {
  const compartilhados = await recolherCompartilhados().catch(() => []);
  if (compartilhados.length) {
    acrescentar(compartilhados, true);
    avisar(`${compartilhados.length} recebida(s) de outro aplicativo.`);
  }

  // arquivo aberto pelo sistema, com a Vitrola instalada.
  // `LaunchParams` pode nem existir — testar direto lançaria ReferenceError.
  if ('launchQueue' in window && typeof LaunchParams !== 'undefined'
      && 'files' in LaunchParams.prototype) {
    window.launchQueue.setConsumer(async params => {
      if (!params.files || !params.files.length) return;
      const arquivos = [];
      for (const punho of params.files) {
        try { arquivos.push(await punho.getFile()); } catch (_) {}
      }
      if (arquivos.length) acrescentar(arquivos, true);
    });
  }

  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  try {
    const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
    reg.addEventListener('updatefound', () => {
      const novo = reg.installing;
      if (!novo) return;
      novo.addEventListener('statechange', () => {
        if (novo.state === 'installed' && navigator.serviceWorker.controller) {
          avisar('Há uma versão nova da Vitrola. Recarregue quando quiser.');
        }
      });
    });
  } catch (_) { /* sem cache offline; o resto funciona igual */ }
}

/* --- arranque --- */
(function iniciar() {
  let salvo = null;
  try { salvo = localStorage.getItem('vitrola:tema'); } catch (_) {}
  aplicarTema(salvo);

  ligarControlesDoSistema();
  pintarMudo();
  pintarFila();
  pintarBotaoTocar();
  desenharOnda();

  // a ordem importa: primeiro a fila guardada, depois o que veio de fora.
  // `acrescentar` só carrega sozinho quando a fila estava vazia, então
  // recuperar antes evita que um compartilhamento roube a faixa em foco.
  recuperarBiblioteca()
    .catch(() => {})
    .then(() => ligarAplicativo())
    .catch(() => {});

  quadro();
})();
