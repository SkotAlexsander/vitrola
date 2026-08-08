'use strict';

/* ============================================================================
   VITROLA — toca os arquivos de música do seu aparelho.

   Nada sai daqui: não há servidor, não há envio, não há biblioteca externa.
   Título, artista, capa, cor e letra são lidos do próprio arquivo.

   Índice:
     1. Utilidades              7. Brilho e pulso
     2. Leitor de ID3           8. Media Session e ponte Android
     3. Cor da capa             9. Desenho da tela
     4. Guarda (IndexedDB)     10. Folhas (fila, letra, ajustes, editor)
     5. Biblioteca e fila      11. Entrada e arranque
     6. Áudio e equalizador
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

/** Sem acento e em minúsculas — é assim que a busca compara, senão
    procurar "musica" não acha "música", que é o caso mais comum de todos. */
function normalizar(s) {
  return (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** O aviso invisível é para o leitor de tela; o recado é para o olho. Os
    dois dizem a mesma coisa, e é de propósito: quem não vê a tela precisa
    da mesma informação que quem vê. */
let recadoTempo = 0;
function avisar(texto) {
  $('aviso').textContent = texto;

  const r = $('recado');
  r.textContent = texto;
  r.hidden = false;
  r.classList.remove('saindo');
  clearTimeout(recadoTempo);
  recadoTempo = setTimeout(() => {
    r.classList.add('saindo');
    setTimeout(() => { r.hidden = true; }, 200);
  }, 2600);
}

function mostrar(el, visivel) { if (el) el.toggleAttribute('hidden', !visivel); }

const menosMovimento = window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgDe(d, preenchido) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  for (const um of (Array.isArray(d) ? d : [d])) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', um);
    if (preenchido) { p.setAttribute('fill', 'currentColor'); p.setAttribute('stroke', 'none'); }
    s.appendChild(p);
  }
  return s;
}

function elemento(tag, classe, texto) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto != null) e.textContent = texto;
  return e;
}

/** Preferências pequenas moram no localStorage: são poucas, cabem, e não
    vale abrir transação de banco para lembrar o volume. */
const pref = {
  ler(chave, padrao) {
    try {
      const v = localStorage.getItem('vitrola:' + chave);
      return v === null ? padrao : JSON.parse(v);
    } catch (_) { return padrao; }
  },
  gravar(chave, valor) {
    try { localStorage.setItem('vitrola:' + chave, JSON.stringify(valor)); } catch (_) {}
  },
};


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

/** Quantos caracteres "estranhos" (substituição, controle, privados) o
    texto tem — serve pra saber se a decodificação deu certo de verdade,
    e não só sem lançar erro. */
function contarEstranhos(s) {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0xFFFD || (c >= 0xE000 && c <= 0xF8FF) || (c < 32 && c !== 9 && c !== 10 && c !== 13)) n++;
  }
  return n;
}

/** O embaralhamento mais comum de todos NÃO deixa losango nenhum: um
    arquivo gravado em UTF-8 mas etiquetado como latin1 vira "AÃ§Ã£o" —
    todo caractere imprimível, nada que o contador ache estranho. Só o
    olho humano vê. Então esse caso é pego antes, por outra pergunta:
    os bytes formam UTF-8 VÁLIDO? O modo fatal do TextDecoder lança se
    não formarem. Texto latin1 de verdade quase nunca passa nesse teste
    por acaso — as sequências de vários bytes do UTF-8 são exigentes
    demais para sair por acidente. */
function pareceUtf8(bytes) {
  let temMultibyte = false;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0x80) { temMultibyte = true; break; }
  if (!temMultibyte) return null;          // só ASCII: os dois alfabetos concordam
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (_) { return null; }
}

/** Tenta decodificar do jeito que a etiqueta diz, e se o resultado vier
    cheio de caractere de substituição (aquele losango ou o quadrado
    vazio), tenta de novo como se os bytes fossem de outro alfabeto — é
    comum um programa gravar encoding 0 (windows-1252) num texto que na
    verdade é UTF-8 ou vem de um alfabeto do Leste Asiático. Fica com a
    leitura que tiver menos caractere estranho. */
function decodificar(bytes, enc) {
  const rotulo = ROTULO_ENC[enc] || 'utf-8';
  let melhor = '', poucosEstranhos = Infinity;

  if (rotulo === 'windows-1252') {
    const utf8 = pareceUtf8(bytes);
    if (utf8 !== null && contarEstranhos(utf8) === 0) return utf8;
  }

  try {
    const s = new TextDecoder(rotulo).decode(bytes);
    const e = contarEstranhos(s);
    if (e === 0) return s;              // já veio limpo, nem precisa tentar mais nada
    melhor = s; poucosEstranhos = e;
  } catch (_) {}

  const tentativas = rotulo === 'utf-8'
    ? ['windows-1252', 'gbk', 'shift-jis', 'euc-kr', 'big5']
    : ['utf-8', 'gbk', 'shift-jis', 'euc-kr', 'big5', 'windows-1252'];

  for (const alt of tentativas) {
    try {
      const s = new TextDecoder(alt).decode(bytes);
      const e = contarEstranhos(s);
      if (e < poucosEstranhos) { melhor = s; poucosEstranhos = e; }
      if (e === 0) break;
    } catch (_) {}
  }

  if (melhor) return melhor;
  return latim(bytes, 0, bytes.length);
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

  // Há quem grave a letra em formato LRC dentro do quadro de letra corrida.
  // Se for o caso, ela vira sincronizada de graça.
  const lrc = lerLRC(texto);
  if (lrc) return lrc;

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

/** LRC: o formato de letra sincronizada que se acha solto por aí, em
    arquivo .lrc ao lado da música. Uma linha pode ter vários tempos
    (refrão que se repete), e todos valem. */
function lerLRC(texto) {
  if (!texto || texto.indexOf('[') < 0) return null;
  const linhas = [];
  for (const bruta of texto.split(/\r\n|\r|\n/)) {
    const marcas = bruta.match(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g);
    if (!marcas) continue;
    const letra = bruta.replace(/\[[^\]]*\]/g, '').trim();
    if (!letra) continue;
    for (const m in marcas) {
      const parte = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(marcas[m]);
      if (!parte) continue;
      const cs = parte[3] ? Number(('0.' + parte[3])) : 0;
      linhas.push({ t: Number(parte[1]) * 60 + Number(parte[2]) + cs, texto: letra });
    }
  }
  if (!linhas.length) return null;
  linhas.sort((a, b) => a.t - b.t);
  return { tipo: 'sincronizada', linhas };
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

  // Nome de arquivo no formato "Artista - Título": aproveita os dois lados
  // em vez de jogar tudo no título, que é o que dava antes.
  if (!tags.titulo || !tags.artista) {
    const cru = (arquivo.name || '').replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim();
    const partido = cru.split(/\s+[-–—]\s+/);
    if (partido.length >= 2 && partido[0].length > 1) {
      if (!tags.artista) tags.artista = partido[0].trim();
      if (!tags.titulo)  tags.titulo  = partido.slice(1).join(' - ').trim();
    } else if (!tags.titulo) {
      tags.titulo = cru;
    }
  }

  if (!tags.titulo)  tags.titulo  = 'Sem título';
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

   Versão 2: continua a loja de faixas da versão 1 (nada é apagado na
   subida) e acrescenta a loja de playlists.
   ========================================================================= */

const BANCO = 'vitrola', LOJA = 'faixas', LOJA_LISTAS = 'listas';
let bancoPromessa = null;

function banco() {
  if (bancoPromessa) return bancoPromessa;
  bancoPromessa = new Promise((ok, erro) => {
    if (!window.indexedDB) return erro(new Error('sem IndexedDB'));
    const req = indexedDB.open(BANCO, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LOJA)) {
        db.createObjectStore(LOJA, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(LOJA_LISTAS)) {
        db.createObjectStore(LOJA_LISTAS, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => erro(req.error);
  }).catch(e => { bancoPromessa = null; throw e; });
  return bancoPromessa;
}

function loja(nome, modo) {
  return banco().then(db => db.transaction(nome, modo).objectStore(nome));
}

function pedido(req) {
  return new Promise((ok, erro) => {
    req.onsuccess = () => ok(req.result);
    req.onerror = () => erro(req.error);
  });
}

async function guardar(registro) {
  try {
    return await pedido((await loja(LOJA, 'readwrite')).add(registro));
  } catch (e) {
    if (e && e.name === 'QuotaExceededError') {
      avisar('O aparelho ficou sem espaço. Esta sessão continua, mas não será lembrada.');
    }
    return null;
  }
}

async function regravar(nome, registro) {
  try { (await loja(nome, 'readwrite')).put(registro); } catch (_) {}
}

async function apagar(nome, id) {
  try { (await loja(nome, 'readwrite')).delete(id); } catch (_) {}
}

async function todasDe(nome) {
  try { return (await pedido((await loja(nome, 'readonly')).getAll())) || []; }
  catch (_) { return []; }
}

async function esquecerTudo() {
  try { (await loja(LOJA, 'readwrite')).clear(); } catch (_) {}
  try { (await loja(LOJA_LISTAS, 'readwrite')).clear(); } catch (_) {}
}


/* ===========================================================================
   5. BIBLIOTECA E FILA

   A biblioteca é a coleção; a fila é a ORDEM em que se toca agora. As duas
   se referem às faixas por `uid`, nunca por posição no vetor: quando uma
   faixa é removida, todo índice guardado por aí passaria a apontar para a
   vizinha, calado. Já aconteceu, e não se vê acontecer.
   ========================================================================= */

const som = $('som');

const estado = {
  biblioteca: [],       // faixas
  porUid: new Map(),
  fila: [],             // uids na ordem de tocar
  filaOriginal: [],     // a mesma fila sem embaralhar, para desfazer
  pos: -1,
  aleatorio: pref.ler('aleatorio', false),
  repetir: pref.ler('repetir', 'tudo'),   // 'nao' | 'tudo' | 'uma'
  filtro: 'todas',
  ordenacao: pref.ler('ordenacao', 'recente'),
  busca: '',
  grupoAberto: null,    // { tipo: 'artista'|'album'|'lista', chave, rotulo }
  vista: 'biblioteca',
  arrastando: false,
  corCapa: null,
  listas: [],
  contado: false,       // se a faixa atual já contou como ouvida
  timer: null,
  timerFim: 0,
  timerAoFim: false,
};

let proximoUid = 1;
function novoUid() { return 'u' + (proximoUid++); }

function faixaAtual() {
  if (estado.pos < 0) return null;
  return estado.porUid.get(estado.fila[estado.pos]) || null;
}

function faixaDe(uid) { return estado.porUid.get(uid) || null; }

/* ---- capas: URL só de quem está à vista ----
   Um objeto de URL por capa, criado no arranque para a biblioteca inteira,
   era memória parada — 500 músicas, 500 blobs vivos o tempo todo. Agora a
   URL nasce quando a linha aparece e as mais antigas são devolvidas. */
const capasVivas = new Map();
const CAPAS_MAX = 80;

function urlCapa(f) {
  if (!f || !f.capaBlob) return null;
  const jaTem = capasVivas.get(f.uid);
  if (jaTem) return jaTem;

  const url = URL.createObjectURL(f.capaBlob);
  capasVivas.set(f.uid, url);

  if (capasVivas.size > CAPAS_MAX) {
    for (const [uid, u] of capasVivas) {
      if (uid === f.uid) continue;
      const atual = faixaAtual();
      if (atual && atual.uid === uid) continue;   // a que toca nunca é despejada
      URL.revokeObjectURL(u);
      capasVivas.delete(uid);
      break;
    }
  }
  return url;
}

function soltarCapa(uid) {
  const u = capasVivas.get(uid);
  if (u) { URL.revokeObjectURL(u); capasVivas.delete(uid); }
}

/* ---- ordenação e filtro ---- */

const ORDENS = {
  recente:  { rotulo: 'adição',    cmp: (a, b) => (b.adicionadaEm || 0) - (a.adicionadaEm || 0) },
  titulo:   { rotulo: 'título',    cmp: (a, b) => a.tags.titulo.localeCompare(b.tags.titulo, 'pt-BR') },
  artista:  { rotulo: 'artista',   cmp: (a, b) => a.tags.artista.localeCompare(b.tags.artista, 'pt-BR') ||
                                                  a.tags.titulo.localeCompare(b.tags.titulo, 'pt-BR') },
  album:    { rotulo: 'álbum',     cmp: (a, b) => (a.tags.album || '~').localeCompare(b.tags.album || '~', 'pt-BR') ||
                                                  (Number(a.tags.faixa) || 0) - (Number(b.tags.faixa) || 0) },
  duracao:  { rotulo: 'duração',   cmp: (a, b) => (b.dur || 0) - (a.dur || 0) },
  ouvidas:  { rotulo: 'mais ouvidas', cmp: (a, b) => (b.contagem || 0) - (a.contagem || 0) ||
                                                  (b.ultimaVez || 0) - (a.ultimaVez || 0) },
};

function combina(f, alvo) {
  if (!alvo) return true;
  return normalizar(f.tags.titulo).includes(alvo) ||
         normalizar(f.tags.artista).includes(alvo) ||
         normalizar(f.tags.album || '').includes(alvo);
}

/** O que a lista deve mostrar agora — já resolvido: busca, filtro, grupo
    aberto e ordenação, tudo num lugar só. */
function visaoAtual() {
  const alvo = normalizar(estado.busca.trim());
  const todas = estado.biblioteca;

  if (alvo) {
    return { modo: 'faixas', faixas: todas.filter(f => combina(f, alvo)).sort(ORDENS[estado.ordenacao].cmp) };
  }

  if (estado.grupoAberto) {
    const g = estado.grupoAberto;
    let faixas;
    if (g.tipo === 'lista') {
      const lista = estado.listas.find(l => l.id === g.chave);
      faixas = lista ? lista.faixas.map(faixaDe).filter(Boolean) : [];
      return { modo: 'faixas', faixas, grupo: g, ordemFixa: true };
    }
    const campo = g.tipo === 'artista' ? 'artista' : 'album';
    faixas = todas.filter(f => (f.tags[campo] || 'Sem álbum') === g.chave)
                  .sort(ORDENS[g.tipo === 'album' ? 'album' : 'titulo'].cmp);
    return { modo: 'faixas', faixas, grupo: g };
  }

  if (estado.filtro === 'curtidas') {
    return { modo: 'faixas', faixas: todas.filter(f => f.curtida).sort(ORDENS[estado.ordenacao].cmp) };
  }

  if (estado.filtro === 'artistas' || estado.filtro === 'albuns') {
    const campo = estado.filtro === 'artistas' ? 'artista' : 'album';
    const mapa = new Map();
    for (const f of todas) {
      const chave = f.tags[campo] || (campo === 'album' ? 'Sem álbum' : 'Artista desconhecido');
      if (!mapa.has(chave)) mapa.set(chave, []);
      mapa.get(chave).push(f);
    }
    const grupos = [...mapa.entries()]
      .map(([chave, faixas]) => ({ tipo: campo === 'artista' ? 'artista' : 'album', chave, rotulo: chave, faixas }))
      .sort((a, b) => a.chave.localeCompare(b.chave, 'pt-BR'));
    return { modo: 'grupos', grupos };
  }

  if (estado.filtro === 'listas') {
    const grupos = estado.listas.map(l => ({
      tipo: 'lista', chave: l.id, rotulo: l.nome,
      faixas: l.faixas.map(faixaDe).filter(Boolean),
    }));
    return { modo: 'grupos', grupos, listas: true };
  }

  return { modo: 'faixas', faixas: [...todas].sort(ORDENS[estado.ordenacao].cmp) };
}

/* ---- a fila ---- */

function embaralhar(v) {
  for (let i = v.length - 1; i > 0; i--) {      // Fisher-Yates
    const j = Math.floor(Math.random() * (i + 1));
    const t = v[i]; v[i] = v[j]; v[j] = t;
  }
  return v;
}

/** Define a fila a partir de uma lista de faixas, começando numa delas.
    É o que acontece quando se toca alguém de dentro de um filtro: a fila
    passa a ser AQUELE recorte, não a biblioteca inteira. */
function definirFila(faixas, comecarEm) {
  estado.filaOriginal = faixas.map(f => f.uid);
  if (estado.aleatorio) {
    const resto = estado.filaOriginal.filter(u => u !== comecarEm);
    estado.fila = comecarEm ? [comecarEm, ...embaralhar(resto)] : embaralhar(resto);
  } else {
    estado.fila = [...estado.filaOriginal];
  }
  estado.pos = comecarEm ? estado.fila.indexOf(comecarEm) : 0;
  guardarSessao();
}

function refazerAleatorio() {
  const atual = estado.fila[estado.pos];
  if (estado.aleatorio) {
    const resto = estado.filaOriginal.filter(u => u !== atual);
    estado.fila = atual ? [atual, ...embaralhar(resto)] : embaralhar(resto);
    estado.pos = atual ? 0 : -1;
  } else {
    estado.fila = [...estado.filaOriginal];
    estado.pos = atual ? estado.fila.indexOf(atual) : -1;
  }
  guardarSessao();
}

function proximaPosicao(passo) {
  if (!estado.fila.length) return -1;
  let novo = estado.pos + passo;
  if (novo >= estado.fila.length) {
    if (estado.repetir === 'nao') return -1;
    novo = 0;
  }
  if (novo < 0) novo = estado.fila.length - 1;
  return novo;
}

function tocarASeguir(uid) {
  const onde = estado.fila.indexOf(uid);
  if (onde >= 0) estado.fila.splice(onde, 1);
  const destino = estado.pos < 0 ? 0 : estado.pos + (onde >= 0 && onde < estado.pos ? 0 : 1);
  estado.fila.splice(destino, 0, uid);
  if (onde >= 0 && onde < estado.pos) estado.pos--;
  if (!estado.filaOriginal.includes(uid)) estado.filaOriginal.push(uid);
  guardarSessao();
}

function acrescentarNaFila(uid) {
  if (!estado.fila.includes(uid)) estado.fila.push(uid);
  if (!estado.filaOriginal.includes(uid)) estado.filaOriginal.push(uid);
  guardarSessao();
}

function guardarSessao() {
  const f = faixaAtual();
  pref.gravar('sessao', {
    fila: estado.fila,
    original: estado.filaOriginal,
    pos: estado.pos,
    uid: f ? f.uid : null,
    // o uid é de sessão; o que sobrevive ao fechar é o id do banco
    id: f ? f.id : null,
    segundo: f && isFinite(som.currentTime) ? som.currentTime : 0,
  });
}


/* ===========================================================================
   6. ÁUDIO E EQUALIZADOR
   ========================================================================= */

let ac = null, analisador = null, espectro = null, audioDesistiu = false;
let ganho = null, bandas = [];

const EQ_HZ = [60, 230, 910, 3600, 14000];
const EQ_PADROES = {
  Plano:  [0, 0, 0, 0, 0],
  Grave:  [7, 4, 0, 1, 2],
  Voz:    [-2, 0, 4, 4, 1],
  Agudo:  [-1, 0, 1, 4, 6],
  Noite:  [3, 1, 2, -1, -3],
};
let eqGanhos = pref.ler('eq', [0, 0, 0, 0, 0]);
let volume = pref.ler('volume', 1);          // 0 a 1,5 (acima de 1 usa o ganho)

/* Liga o analisador — mas só depois de CONFIRMAR que o contexto está
   rodando, e este cuidado é o mais importante do arquivo.

   `createMediaElementSource` é irreversível: uma vez que o <audio> passa
   pelo grafo, ele só sai por ali. Se o contexto estiver suspenso — coisa
   comum dentro de um WebView — a música toca em SILÊNCIO ABSOLUTO, com o
   botão dizendo que está tocando e a barra andando. É o pior defeito
   possível, porque não parece defeito.

   Então: se o contexto não subir, desisto do grafo inteiro e deixo o áudio
   tocar direto. Perde-se o brilho reagindo à música e o equalizador. Não
   se perde o som. */
function ligarAudio() {
  if (ac || audioDesistiu) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { audioDesistiu = true; return; }

  let ctx;
  try { ctx = new AC(); } catch (_) { audioDesistiu = true; return; }

  const desistir = () => {
    try { ctx.close(); } catch (_) {}
    audioDesistiu = true;
  };

  const seguir = () => {
    if (ctx.state !== 'running') return desistir();
    try {
      const fonte = ctx.createMediaElementSource(som);   // só pode uma vez

      bandas = EQ_HZ.map((hz, i) => {
        const b = ctx.createBiquadFilter();
        b.type = i === 0 ? 'lowshelf' : (i === EQ_HZ.length - 1 ? 'highshelf' : 'peaking');
        b.frequency.value = hz;
        if (b.type === 'peaking') b.Q.value = 1;
        b.gain.value = eqGanhos[i] || 0;
        return b;
      });

      const g = ctx.createGain();
      g.gain.value = Math.max(1, volume);

      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      an.smoothingTimeConstant = 0.8;

      let no = fonte;
      for (const b of bandas) { no.connect(b); no = b; }
      no.connect(g);
      g.connect(an);
      an.connect(ctx.destination);

      ac = ctx;
      ganho = g;
      analisador = an;
      espectro = new Uint8Array(an.frequencyBinCount);
    } catch (_) { desistir(); }
  };

  if (ctx.state === 'suspended') {
    const p = ctx.resume();
    if (p && p.then) p.then(seguir, desistir); else seguir();
  } else {
    seguir();
  }
}

function acordarAudio() { if (ac && ac.state === 'suspended') ac.resume(); }

function aplicarEq() {
  for (let i = 0; i < bandas.length; i++) {
    try { bandas[i].gain.value = eqGanhos[i] || 0; } catch (_) {}
  }
  pref.gravar('eq', eqGanhos);
}

function aplicarVolume() {
  som.volume = Math.min(1, volume);
  if (ganho) { try { ganho.gain.value = Math.max(1, volume); } catch (_) {} }
  pref.gravar('volume', volume);
}

function aplicarVelocidade(v) {
  som.playbackRate = v;
  try { som.preservesPitch = true; som.mozPreservesPitch = true; } catch (_) {}
  pref.gravar('velocidade', v);
  $('rotulo-velocidade').textContent = (v === 1 ? '1' : String(v).replace('.', ',')) + 'x';
  $('btn-velocidade').classList.toggle('ativa', v !== 1);
  $('btn-velocidade').setAttribute('aria-label', 'Velocidade: ' + v + 'x');
}


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
  const u = urlCapa(f);
  if (u) arte.push({ src: u, sizes: '512x512', type: 'image/jpeg' });
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

/* ---- o card da tela de bloqueio, no aplicativo Android ----

   Tudo o que está acima serve ao NAVEGADOR: quem lê `navigator.mediaSession`
   e desenha o card é o Chrome. Dentro do aplicativo não há navegador — há um
   WebView — e ninguém lê aquilo. Por isso o card do aplicativo é montado em
   Java, pelo ServicoMidia, e esta parte só conta a ele o que está tocando.

   Nos dois lados o mesmo código roda: no navegador `Sistema` não existe e
   estas funções não fazem nada. */

function ponteDoSistema() {
  const s = window.Sistema;
  return (s && typeof s.midia === 'function') ? s : null;
}

/** A capa vai para o Java como JPEG em base64. Reduzida a 320px de
    propósito: a original pode ter 1500px e passar isso pela ponte a cada
    troca de faixa é caro à toa — na tela de bloqueio ela nunca aparece
    maior que a largura do aparelho. */
function capaParaOSistema(f) {
  if (!f || f.capaAviso !== undefined) return;   // já resolvida, ou já se sabe que não há
  f.capaAviso = null;
  const u = urlCapa(f);
  if (!u || !ponteDoSistema()) return;

  const img = new Image();
  img.onload = () => {
    try {
      const L = 320;
      const c = document.createElement('canvas');
      c.width = c.height = L;
      c.getContext('2d').drawImage(img, 0, 0, L, L);
      f.capaAviso = c.toDataURL('image/jpeg', 0.85).replace(/^data:[^,]*,/, '');
      if (faixaAtual() === f) contarAoSistema(true);
    } catch (_) {}
  };
  img.onerror = () => {};
  img.src = u;
}

let ultimoRecado = 0;

/** `forcar` para o que muda de repente — tocar, pausar, trocar de faixa,
    arrastar. Sem ele, o timeupdate dispararia isto uma vez a cada 250ms, e
    não adianta: o card anda a barra sozinho, extrapolando da posição e da
    velocidade que já mandei. Só preciso corrigir de vez em quando. */
function contarAoSistema(forcar) {
  const p = ponteDoSistema();
  if (!p) return;

  const f = faixaAtual();
  if (!f) { try { p.pararMidia(); } catch (_) {} return; }

  const agora = (new Date()).getTime();
  if (!forcar && agora - ultimoRecado < 5000) return;
  ultimoRecado = agora;

  const dur = isFinite(som.duration) && som.duration > 0 ? Math.round(som.duration * 1000) : 0;
  const pos = isFinite(som.currentTime) ? Math.round(som.currentTime * 1000) : 0;
  try {
    p.midia(f.tags.titulo || '', f.tags.artista || '', f.tags.album || '',
            !som.paused, dur, pos, f.capaAviso || '');
  } catch (_) {}
}

/* O caminho de volta: o dedo tocou no card, ou no botão do fone. O Java não
   tem como mandar em som nenhum — o <audio> vive aqui.

   Só chegam comandos que vieram de FORA do aplicativo. O foco de áudio não
   entra nesta lista de propósito: quem toca o som é o WebView, e é ele que
   pede foco ao Android. Quando o serviço pedia também, eram dois pedintes
   dentro do mesmo aplicativo, um tirava o foco do outro, e o resultado era
   pausar a cada play. */
window.__midia = function (qual, argumento) {
  switch (qual) {
    case 'tocar':    tocar(); break;
    case 'pausar':   pausar(); break;
    case 'proxima':  pular(1); break;
    case 'anterior': pular(-1); break;
    case 'buscar':
      som.currentTime = Math.max(0, (Number(argumento) || 0) / 1000);
      break;
    case 'parar':    pausar(); som.currentTime = 0; break;
  }
  contarAoSistema(true);
};

/* ---- diagnóstico ----
   O card da tela de bloqueio é feito de peças que só existem do lado
   Android, e quando uma falha ela falha CALADA: some o card e ninguém diz
   por quê. Metade da resposta só o Java sabe (permissão, serviço, sessão);
   a outra metade só a página sabe (se a ponte existe, se algo foi mandado,
   se o áudio subiu). Aqui as duas se juntam. */
function relatorio() {
  const p = ponteDoSistema();
  const linhas = [];

  if (p && typeof p.diagnostico === 'function') {
    try { linhas.push(p.diagnostico()); } catch (_) { linhas.push('o Java não respondeu'); }
  } else {
    linhas.push('Rodando no NAVEGADOR, não no aplicativo.\n' +
                'A tela de bloqueio aqui é do navegador, não da Vitrola.\n');
  }

  linhas.push('ponte com o sistema: ' + (p ? 'existe' : 'não existe'));
  linhas.push('recados já enviados: ' + (ultimoRecado ? 'sim' : 'NENHUM'));

  const f = faixaAtual();
  linhas.push('faixa atual: ' + (f ? f.tags.titulo : 'nenhuma'));
  linhas.push('capa para o card: ' + (!f ? '—'
    : f.capaAviso ? 'pronta' : (f.capaBlob ? 'a faixa tem capa, mas não converteu' : 'a faixa não tem capa')));
  linhas.push('biblioteca: ' + estado.biblioteca.length + ' faixas');
  linhas.push('fila: ' + estado.fila.length + ' faixas, posição ' + (estado.pos + 1));
  linhas.push('som: ' + (som.paused ? 'pausado' : 'tocando') +
              (som.src ? '' : ', sem arquivo carregado'));
  linhas.push('web audio: ' + (ac ? 'ligado' : (audioDesistiu ? 'DESISTIU' : 'ainda não')));
  linhas.push('equalizador: ' + (bandas.length ? 'disponível' : 'indisponível'));
  linhas.push('capas em memória: ' + capasVivas.size);

  return linhas.join('\n');
}


/* ===========================================================================
   9. DESENHO DA TELA
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

/* O botão físico de voltar do Android pergunta à página antes de fechar o
   aplicativo. Sem isto, voltar no meio do player sairia direto do app —
   que é o contrário do que a seta na tela faz. Devolve true quando tratou. */
window.__voltar = function () {
  if (!$('folha').hidden) { fecharFolha(); return true; }
  if (!$('menu').hidden) { fecharMenu(); return true; }
  if (estado.vista === 'tocando') { irPara('biblioteca'); return true; }
  if (estado.grupoAberto) { estado.grupoAberto = null; pintarLista(); return true; }
  if (estado.busca) { limparBusca(); return true; }
  return false;
};

/* ---- tema: escuro e claro, à escolha ----
   O verde-limão não muda de valor quando é PREENCHIMENTO (com texto
   escuro em cima ele funciona nos dois). Como TINTA ele muda: sobre
   fundo claro o verde vivo mede 1,4:1 e some. Quem cuida disso é o
   token --lima-tinta, no CSS. */
function temaEscolhido() { return pref.ler('tema', 'escuro'); }

function temaEfetivo(escolha) {
  if (escolha === 'sistema') {
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)
      ? 'claro' : 'escuro';
  }
  return escolha === 'claro' ? 'claro' : 'escuro';
}

function aplicarTema(escolha) {
  pref.gravar('tema', escolha);
  const t = temaEfetivo(escolha);

  if (t === 'claro') document.documentElement.setAttribute('data-tema', 'claro');
  else document.documentElement.removeAttribute('data-tema');

  // a barra de status do sistema acompanha o fundo
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'claro' ? '#F4F5F7' : '#0B0B0D');

  // dentro do aplicativo Android, avisa o sistema para as barras de status
  // e de navegação acompanharem. No navegador esta ponte não existe.
  try { if (window.Sistema && window.Sistema.tema) window.Sistema.tema(t); } catch (_) {}
}

const D_CORACAO = 'M12 20.5S3.5 15 3.5 9.2A4.7 4.7 0 0 1 12 6.4a4.7 4.7 0 0 1 8.5 2.8c0 5.8-8.5 11.3-8.5 11.3z';
const D_DISCO   = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 7.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z';
const D_SETA_D  = 'M9 6l6 6-6 6';
const D_SETA_E  = 'M15 6l-6 6 6 6';

/** Uma linha da lista. `contexto` diz de onde ela saiu, para que tocar
    nela defina a fila certa. */
function linhaDeFaixa(f, contexto, extras) {
  const li = elemento('li', 'item-linha');

  const b = elemento('button', 'item');
  b.type = 'button';
  b.dataset.uid = f.uid;
  const atual = faixaAtual();
  b.setAttribute('aria-current', atual && atual.uid === f.uid ? 'true' : 'false');

  const capa = elemento('span', 'item-capa');
  const u = urlCapa(f);
  if (u) {
    const img = document.createElement('img');
    img.src = u; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
    capa.appendChild(img);
  } else {
    capa.appendChild(svgDe(D_DISCO, true));
  }
  const eq = elemento('span', 'equalizador');
  eq.append(elemento('i'), elemento('i'), elemento('i'));
  capa.appendChild(eq);

  const txt = elemento('span', 'item-txt');
  const tit = elemento('strong', 'item-tit', f.tags.titulo);
  tit.title = f.tags.titulo;
  const sub = elemento('span', 'item-sub');
  if (f.curtida) {
    const c = svgDe(D_CORACAO, true);
    c.setAttribute('class', 'item-curtida');
    sub.appendChild(c);
  }
  const partes = [f.tags.artista];
  if (f.dur) partes.push(tempo(f.dur));
  if (extras && extras.mostrarAlbum && f.tags.album) partes.splice(1, 0, f.tags.album);
  sub.appendChild(document.createTextNode(partes.join('  ·  ')));
  txt.append(tit, sub);

  b.setAttribute('aria-label',
    f.tags.titulo + ', de ' + f.tags.artista + (f.dur ? ', ' + tempo(f.dur) : '') +
    (f.curtida ? ', curtida' : ''));

  b.append(capa, txt, elemento('span'));

  const mais = elemento('button', 'item-mais');
  mais.type = 'button';
  mais.dataset.uid = f.uid;
  mais.setAttribute('aria-label', 'Opções de ' + f.tags.titulo);
  const pontos = svgDe([], false);
  pontos.setAttribute('class', 'pontos');
  for (const cx of [5, 12, 19]) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', cx); c.setAttribute('cy', 12); c.setAttribute('r', 2);
    pontos.appendChild(c);
  }
  mais.appendChild(pontos);

  li.append(b, mais);
  if (contexto) li.dataset.contexto = contexto;
  return li;
}

let pinturaAgendada = false;
function agendarPintura() {
  if (pinturaAgendada) return;
  pinturaAgendada = true;
  requestAnimationFrame(() => { pinturaAgendada = false; pintarLista(); });
}

function pintarLista() {
  const ol = $('lista');
  const vazioGeral = estado.biblioteca.length === 0;

  mostrar($('vazio'), vazioGeral);
  mostrar(ol, !vazioGeral);
  mostrar($('busca'), !vazioGeral);
  mostrar($('chips'), !vazioGeral && !estado.busca && !estado.grupoAberto);
  if (vazioGeral) { ol.innerHTML = ''; return; }

  const v = visaoAtual();
  const frag = document.createDocumentFragment();

  // cabeçalho de grupo aberto, com o caminho de volta
  if (v.grupo) {
    const li = elemento('li');
    const voltar = elemento('button', 'grupo-linha');
    voltar.type = 'button';
    voltar.id = 'voltar-grupo';
    const ico = elemento('span', 'grupo-capa');
    ico.appendChild(svgDe(D_SETA_E, false));
    const txt = elemento('span', 'item-txt');
    txt.append(
      elemento('strong', 'item-tit', v.grupo.rotulo),
      elemento('span', 'item-sub', v.faixas.length + (v.faixas.length === 1 ? ' faixa' : ' faixas')));
    voltar.append(ico, txt, elemento('span'));
    li.appendChild(voltar);
    frag.appendChild(li);
  }

  if (v.modo === 'grupos') {
    if (!v.grupos.length) {
      frag.appendChild(elemento('li', 'lista-vazia', v.listas
        ? 'Nenhuma playlist ainda. Crie uma pelo menu.'
        : 'Nada aqui.'));
    }
    for (const g of v.grupos) {
      const li = elemento('li');
      const b = elemento('button', 'grupo-linha');
      b.type = 'button';
      b.dataset.grupo = g.tipo;
      b.dataset.chave = String(g.chave);
      b.dataset.rotulo = g.rotulo;

      const capa = elemento('span', 'grupo-capa');
      const comCapa = g.faixas.find(f => f.capaBlob);
      if (comCapa) {
        const img = document.createElement('img');
        img.src = urlCapa(comCapa); img.alt = ''; img.loading = 'lazy';
        capa.appendChild(img);
      } else {
        capa.appendChild(svgDe(D_DISCO, true));
      }

      const txt = elemento('span', 'item-txt');
      txt.append(
        elemento('strong', 'item-tit', g.rotulo),
        elemento('span', 'item-sub', g.faixas.length + (g.faixas.length === 1 ? ' faixa' : ' faixas')));

      const seta = elemento('span', 'grupo-seta');
      seta.appendChild(svgDe(D_SETA_D, false));

      b.append(capa, txt, seta);
      li.appendChild(b);
      frag.appendChild(li);
    }
  } else {
    if (!v.faixas.length) {
      frag.appendChild(elemento('li', 'lista-vazia',
        estado.busca ? 'Nada encontrado para “' + estado.busca + '”.'
        : estado.filtro === 'curtidas' ? 'Você ainda não curtiu nenhuma faixa.'
        : 'Nada aqui.'));
    }
    const mostrarAlbum = estado.filtro === 'albuns' || (estado.grupoAberto && estado.grupoAberto.tipo === 'artista');
    for (const f of v.faixas) frag.appendChild(linhaDeFaixa(f, 'lista', { mostrarAlbum }));
  }

  ol.innerHTML = '';
  ol.appendChild(frag);
}

/** As faixas que a lista mostra AGORA — é isso que vira fila quando se
    toca alguém a partir dela. */
function faixasVisiveis() {
  const v = visaoAtual();
  return v.modo === 'faixas' ? v.faixas : [];
}

function pintarAgora() {
  const f = faixaAtual();

  $('titulo').textContent  = f ? f.tags.titulo : 'Nenhuma faixa';
  $('artista').textContent = f ? f.tags.artista : 'Escolha uma música na biblioteca';

  const origem = $('cabeca-origem');
  origem.textContent = estado.grupoAberto ? estado.grupoAberto.rotulo
    : estado.aleatorio ? 'Tocando embaralhado' : 'Tocando agora';

  const u = f ? urlCapa(f) : null;
  const img = $('capa-img');
  if (u) {
    img.src = u;
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
  if (u) {
    bimg.src = u;
    $('brilho').classList.add('aceso');
  } else {
    bimg.removeAttribute('src');
    $('brilho').classList.remove('aceso');
    estado.corCapa = null;
  }

  $('btn-curtir').setAttribute('aria-pressed', f && f.curtida ? 'true' : 'false');
  $('btn-curtir').setAttribute('aria-label', f && f.curtida ? 'Descurtir' : 'Curtir');
  $('prato').classList.toggle('pousado', !!f);

  // mini player
  mostrar($('mini'), !!f);
  if (f) {
    $('mini-titulo').textContent = f.tags.titulo;
    $('mini-artista').textContent = f.tags.artista;
    const mi = $('mini-img');
    if (u) { mi.src = u; mi.alt = ''; } else { mi.removeAttribute('src'); }
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
  $('prato').classList.toggle('rodando', tocando);
  document.body.classList.toggle('tocando', tocando);
}

function pintarProgresso() {
  const dur = isFinite(som.duration) ? som.duration : 0;
  const p = dur ? som.currentTime / dur : 0;
  $('trilho-cheio').style.width = (p * 100).toFixed(3) + '%';
  $('trilho-bola').style.insetInlineStart = (p * 100).toFixed(3) + '%';
  $('t-atual').textContent = tempo(som.currentTime);
  $('t-resta').textContent = '-' + tempo(Math.max(0, dur - som.currentTime));
  $('mini-barra').style.width = (p * 100).toFixed(2) + '%';
  $('prato').style.setProperty('--avanco', p.toFixed(4));

  const t = $('trilho');
  t.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  t.setAttribute('aria-valuetext', dur
    ? tempo(som.currentTime) + ' de ' + tempo(dur)
    : 'sem faixa');
}

function pintarRepetir() {
  const b = $('btn-repetir');
  b.dataset.modo = estado.repetir;
  mostrar($('selo-um'), estado.repetir === 'uma');
  b.setAttribute('aria-label',
    estado.repetir === 'nao' ? 'Repetir: desligado'
    : estado.repetir === 'uma' ? 'Repetir: só esta faixa'
    : 'Repetir: a fila toda');
}

/* ---- a letra ---- */
let letraIndice = -1;

function linhaDaLetra(L, agora) {
  let i = 0;
  while (i + 1 < L.length && L[i + 1].t <= agora) i++;
  if (agora < L[0].t) i = -1;
  return i;
}

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
      atual.textContent = f ? 'Sem letra neste arquivo. Toque para importar um .lrc.' : '';
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
    caixa.title = 'Letra sem marcação de tempo — toque para ver inteira';
    return;
  }

  const i = linhaDaLetra(L, som.currentTime);
  if (i === letraIndice && !forcar) return;
  letraIndice = i;

  antes.textContent  = i > 0 ? L[i - 1].texto : '';
  atual.textContent  = i >= 0 ? L[i].texto : (L[0] ? L[0].texto : '');
  depois.textContent = L[i + 1] ? L[i + 1].texto : '';

  if (folhaAberta === 'letra') pintarLetraInteira();
}


/* --------------------------------------------------------- toca-discos */

async function carregar(uid, tocarDepois) {
  const f = faixaDe(uid);
  if (!f) return;

  const onde = estado.fila.indexOf(uid);
  if (onde >= 0) estado.pos = onde;

  if (!f.url) f.url = URL.createObjectURL(f.arquivo);
  som.src = f.url;
  som.playbackRate = pref.ler('velocidade', 1);

  letraIndice = -1;
  estado.contado = false;
  pintarAgora();
  agendarPintura();
  pintarLetra(true);
  anunciarAoSistema(f);
  capaParaOSistema(f);
  contarAoSistema(true);
  guardarSessao();
  avisar(f.tags.titulo + ' — ' + f.tags.artista);

  const u = urlCapa(f);
  if (u) {
    const img = new Image();
    img.onload = () => { estado.corCapa = corDaImagem(img); };
    img.onerror = () => { estado.corCapa = null; };
    img.src = u;
  } else {
    estado.corCapa = null;
  }

  if (tocarDepois) tocar();
}

function tocar() {
  if (estado.pos < 0 && estado.fila.length) return carregar(estado.fila[0], true);
  ligarAudio(); acordarAudio();
  som.play().then(pintarBotaoTocar).catch(() => {});
}

function pausar() { som.pause(); pintarBotaoTocar(); }

function pular(passo) {
  const p = proximaPosicao(passo);
  if (p < 0) { pausar(); som.currentTime = 0; return; }
  estado.pos = p;
  carregar(estado.fila[p], true);
}

/** Contabiliza a escuta: metade da faixa já é escutar. Serve para a
    ordenação "mais ouvidas" e para nada mais — não sai do aparelho. */
function contarEscuta() {
  const f = faixaAtual();
  if (!f || estado.contado) return;
  const dur = isFinite(som.duration) ? som.duration : 0;
  if (!dur || som.currentTime < Math.min(dur * 0.5, 60)) return;
  estado.contado = true;
  f.contagem = (f.contagem || 0) + 1;
  f.ultimaVez = Date.now();
  persistir(f);
}

/** Regrava a faixa no banco INTEIRA. O put() do IndexedDB substitui o
    registro, não remenda: montar o objeto na mão em cada lugar que altera
    algo faz o campo esquecido sumir em silêncio — foi assim que curtir uma
    música apagava a letra dela, e só se via na próxima vez que o app abria. */
function persistir(f) {
  if (f.id == null) return;
  regravar(LOJA, {
    id: f.id, arquivo: f.arquivo, tags: f.tags, capa: f.capaBlob,
    letra: f.letra, curtida: f.curtida, dur: f.dur,
    contagem: f.contagem, ultimaVez: f.ultimaVez, adicionadaEm: f.adicionadaEm,
  });
}

function alternarCurtida(uid) {
  const f = uid ? faixaDe(uid) : faixaAtual();
  if (!f) return;
  f.curtida = !f.curtida;
  persistir(f);
  pintarAgora();
  agendarPintura();
  avisar(f.curtida ? 'Curtida' : 'Descurtida');
}

async function removerFaixa(uid) {
  const f = faixaDe(uid);
  if (!f) return;

  const eraAtual = faixaAtual() && faixaAtual().uid === uid;
  if (eraAtual) { pausar(); }

  if (f.url) URL.revokeObjectURL(f.url);
  soltarCapa(uid);

  estado.biblioteca = estado.biblioteca.filter(x => x.uid !== uid);
  estado.porUid.delete(uid);

  const antes = estado.pos;
  const naFila = estado.fila.indexOf(uid);
  estado.fila = estado.fila.filter(u => u !== uid);
  estado.filaOriginal = estado.filaOriginal.filter(u => u !== uid);
  if (naFila >= 0 && naFila < antes) estado.pos--;

  for (const l of estado.listas) {
    if (l.faixas.includes(uid)) {
      l.faixas = l.faixas.filter(u => u !== uid);
      regravar(LOJA_LISTAS, { id: l.id, nome: l.nome, faixas: l.faixas, criadaEm: l.criadaEm });
    }
  }

  if (f.id != null) await apagar(LOJA, f.id);

  if (eraAtual) {
    if (estado.fila.length) {
      estado.pos = Math.min(estado.pos < 0 ? 0 : estado.pos, estado.fila.length - 1);
      carregar(estado.fila[estado.pos], false);
    } else {
      estado.pos = -1;
      som.removeAttribute('src'); som.load();
      estado.corCapa = null;
      pintarAgora(); pintarProgresso(); contarAoSistema(true);
      irPara('biblioteca');
    }
  }

  pintarLista();
  guardarSessao();
  avisar('“' + f.tags.titulo + '” saiu da biblioteca.');
}


/* ------------------------------------------------------ entrada de arquivos */

/** A duração vem de uma sonda: um <audio> que carrega só os metadados.
    Uma de cada vez, e só de quem ainda não tem duração guardada — antes
    eram 500 elementos de áudio abertos ao mesmo tempo no arranque, e o
    aparelho engasgava por vários segundos sem explicar por quê. */
const filaSondas = [];
let sondando = false;

function pedirDuracao(f) {
  if (f.dur) return;
  filaSondas.push(f);
  proximaSonda();
}

function proximaSonda() {
  if (sondando || !filaSondas.length) return;
  const f = filaSondas.shift();
  if (!f || f.dur) return proximaSonda();

  sondando = true;
  const sonda = new Audio();
  const url = URL.createObjectURL(f.arquivo);
  const terminar = () => {
    URL.revokeObjectURL(url);
    sondando = false;
    agendarPintura();
    proximaSonda();
  };
  sonda.preload = 'metadata';
  sonda.onloadedmetadata = () => {
    f.dur = sonda.duration;
    persistir(f);
    terminar();
  };
  sonda.onerror = terminar;
  sonda.src = url;
}

function registrarFaixa(dados) {
  const f = {
    uid: novoUid(),
    id: dados.id != null ? dados.id : null,
    arquivo: dados.arquivo,
    tags: dados.tags,
    capaBlob: dados.capa || null,
    letra: dados.letra || null,
    curtida: !!dados.curtida,
    dur: dados.dur || 0,
    contagem: dados.contagem || 0,
    ultimaVez: dados.ultimaVez || 0,
    adicionadaEm: dados.adicionadaEm || Date.now(),
    url: null,
  };
  estado.biblioteca.push(f);
  estado.porUid.set(f.uid, f);
  return f;
}

const EXTENSOES = /\.(mp3|m4a|ogg|oga|opus|flac|wav|aac|mp4|weba)$/i;

async function acrescentar(arquivos) {
  const lista = Array.from(arquivos).filter(a =>
    (a.type && a.type.startsWith('audio/')) || EXTENSOES.test(a.name || ''));

  if (!lista.length) { avisar('Nenhum arquivo de áudio reconhecido.'); return; }

  const primeira = estado.biblioteca.length === 0;
  const novas = [];

  for (const arquivo of lista) {
    const tags = await lerEtiquetas(arquivo);
    const capa = tags.capa || null;
    const letra = tags.letraSinc || tags.letraTexto || null;
    const limpas = { titulo: tags.titulo, artista: tags.artista, album: tags.album, ano: tags.ano, faixa: tags.faixa };
    const adicionadaEm = Date.now();

    const f = registrarFaixa({ arquivo, tags: limpas, capa, letra, curtida: false, adicionadaEm });
    novas.push(f);

    guardar({ arquivo, tags: limpas, capa, letra, curtida: false, dur: 0,
              contagem: 0, ultimaVez: 0, adicionadaEm })
      .then(id => { if (id != null) f.id = id; });

    pedirDuracao(f);
    agendarPintura();
  }

  for (const f of novas) if (!estado.filaOriginal.includes(f.uid)) estado.filaOriginal.push(f.uid);
  if (!estado.aleatorio) estado.fila = [...estado.filaOriginal];
  else for (const f of novas) estado.fila.push(f.uid);

  pintarLista();
  avisar(lista.length === 1 ? 'Uma faixa adicionada.' : lista.length + ' faixas adicionadas.');
  if (primeira && novas.length) { definirFila(novas, novas[0].uid); carregar(novas[0].uid, false); }
}

async function recuperarBiblioteca() {
  const [guardadas, listas] = await Promise.all([todasDe(LOJA), todasDe(LOJA_LISTAS)]);

  for (const g of guardadas) {
    const f = registrarFaixa({
      id: g.id, arquivo: g.arquivo, tags: g.tags, capa: g.capa, letra: g.letra,
      curtida: g.curtida, dur: g.dur, contagem: g.contagem,
      ultimaVez: g.ultimaVez, adicionadaEm: g.adicionadaEm || g.id,
    });
    if (!f.dur) pedirDuracao(f);
  }

  const porId = new Map(estado.biblioteca.map(f => [f.id, f.uid]));
  estado.listas = listas.map(l => ({
    id: l.id, nome: l.nome, criadaEm: l.criadaEm,
    faixas: (l.faixas || []).map(id => porId.get(id)).filter(Boolean),
    idsCrus: l.faixas || [],
  }));

  pintarLista();
  if (!guardadas.length) return;

  // retoma de onde parou: mesma faixa, mesmo segundo, PAUSADA. Voltar
  // tocando sozinho ao abrir o app assusta mais do que ajuda.
  const sessao = pref.ler('sessao', null);
  const ordenadas = [...estado.biblioteca].sort(ORDENS[estado.ordenacao].cmp);
  definirFila(ordenadas, ordenadas[0] ? ordenadas[0].uid : null);

  let alvo = ordenadas[0];
  if (sessao && sessao.id != null) {
    const achada = estado.biblioteca.find(f => f.id === sessao.id);
    if (achada) alvo = achada;
  }
  if (alvo) {
    await carregar(alvo.uid, false);
    if (sessao && sessao.segundo > 2) {
      const pular = () => {
        try { som.currentTime = sessao.segundo; } catch (_) {}
        pintarProgresso(); pintarLetra(true);
        som.removeEventListener('loadedmetadata', pular);
      };
      som.addEventListener('loadedmetadata', pular);
    }
  }
  avisar(guardadas.length + ' faixas na biblioteca.');
}

/* ---- playlists ---- */

function idsDaLista(l) {
  return l.faixas.map(uid => { const f = faixaDe(uid); return f ? f.id : null; }).filter(x => x != null);
}

async function criarLista(nome) {
  const registro = { nome, faixas: [], criadaEm: Date.now() };
  try {
    const id = await pedido((await loja(LOJA_LISTAS, 'readwrite')).add(registro));
    estado.listas.push({ id, nome, faixas: [], criadaEm: registro.criadaEm });
    return id;
  } catch (_) { return null; }
}

function gravarLista(l) {
  regravar(LOJA_LISTAS, { id: l.id, nome: l.nome, faixas: idsDaLista(l), criadaEm: l.criadaEm });
}

function porNaLista(l, uid) {
  if (l.faixas.includes(uid)) return false;
  l.faixas.push(uid);
  gravarLista(l);
  return true;
}


/* ===========================================================================
   10. FOLHAS — fila, letra, ajustes, editor e menus de faixa

   Uma folha só, reaproveitada. Um lugar só para o gesto de fechar, para o
   foco e para o botão físico de voltar.
   ========================================================================= */

let folhaAberta = null;
let focoAnterior = null;
/* O fechar é animado, e o esconder de verdade acontece depois. Se outra
   folha abrisse nesse meio-tempo — "remover" abrindo a confirmação, por
   exemplo — o relógio da anterior disparava e apagava a nova, calado.
   Por isso a marcação: abrir sempre cancela um fechamento pendente. */
let relogioDaFolha = 0;

function abrirFolha(nome, titulo, construir) {
  clearTimeout(relogioDaFolha);
  relogioDaFolha = 0;

  folhaAberta = nome;
  if (!focoAnterior) focoAnterior = document.activeElement;

  $('folha-titulo').textContent = titulo;
  const corpo = $('folha-corpo');
  corpo.innerHTML = '';
  construir(corpo);

  $('folha-fundo').hidden = false;
  const folha = $('folha');
  folha.hidden = false;
  folha.classList.remove('saindo');
  folha.style.transform = '';
  corpo.scrollTop = 0;

  const primeiro = corpo.querySelector('input, button, textarea, select');
  if (primeiro && nome === 'editar') primeiro.focus();
  else $('folha-fechar').focus();
}

function fecharFolha() {
  if (!folhaAberta) return;
  const folha = $('folha');
  folha.classList.add('saindo');
  folha.style.transform = '';

  clearTimeout(relogioDaFolha);
  relogioDaFolha = setTimeout(() => {
    relogioDaFolha = 0;
    if (folhaAberta) return;          // outra folha subiu no meio do caminho
    folha.hidden = true;
    folha.classList.remove('saindo');
    $('folha-fundo').hidden = true;
    $('folha-corpo').innerHTML = '';
  }, 180);

  folhaAberta = null;
  const voltarPara = focoAnterior;
  focoAnterior = null;
  if (voltarPara && voltarPara.focus) { try { voltarPara.focus(); } catch (_) {} }
}

function acaoDaFolha(rotulo, iconeD, aoClicar, opcoes) {
  const b = elemento('button', 'folha-acao' + (opcoes && opcoes.perigo ? ' perigo' : ''));
  b.type = 'button';
  if (iconeD) b.appendChild(svgDe(iconeD, !!(opcoes && opcoes.cheio)));
  b.appendChild(document.createTextNode(rotulo));
  if (opcoes && opcoes.direita) b.appendChild(elemento('span', 'direita', opcoes.direita));
  b.addEventListener('click', aoClicar);
  return b;
}

function secao(texto) { return elemento('p', 'folha-secao', texto); }

/* ---- menu de uma faixa ---- */

function folhaDaFaixa(uid) {
  const f = faixaDe(uid);
  if (!f) return;

  abrirFolha('faixa', f.tags.titulo, corpo => {
    corpo.appendChild(elemento('p', 'folha-nota', f.tags.artista +
      (f.tags.album ? '  ·  ' + f.tags.album : '') +
      (f.dur ? '  ·  ' + tempo(f.dur) : '') +
      (f.contagem ? '  ·  ' + f.contagem + (f.contagem === 1 ? ' escuta' : ' escutas') : '')));

    corpo.append(
      acaoDaFolha('Tocar agora', 'M8 5v14l11-7z', () => {
        fecharFolha();
        definirFila(faixasVisiveis().length ? faixasVisiveis() : estado.biblioteca, uid);
        carregar(uid, true);
        irPara('tocando');
      }, { cheio: true }),

      acaoDaFolha('Tocar a seguir', ['M5 6v12l9.4-6z', 'M15.4 6H18v12h-2.6'], () => {
        tocarASeguir(uid); fecharFolha(); avisar('Toca em seguida.');
      }),

      acaoDaFolha('Pôr no fim da fila', 'M3 6h12M3 12h12M3 18h8M19 8v9M17 19a2 2 0 1 0 4 0 2 2 0 1 0-4 0', () => {
        acrescentarNaFila(uid); fecharFolha(); avisar('Foi para o fim da fila.');
      }),

      acaoDaFolha(f.curtida ? 'Descurtir' : 'Curtir', D_CORACAO, () => {
        alternarCurtida(uid); fecharFolha();
      }),

      acaoDaFolha('Pôr numa playlist', 'M4 7h11M4 12h8M4 17h6M17 12v8M13 16h8', () => {
        folhaEscolherLista(uid);
      }),
    );

    corpo.appendChild(secao('Corrigir'));
    corpo.append(
      acaoDaFolha('Editar título, artista e álbum',
        'M4 17.25V20h2.75L16.81 9.94l-2.75-2.75L4 17.25zM18.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
        () => folhaEditar(uid), { cheio: true }),

      acaoDaFolha('Trocar a capa', 'M4 6h4l2-2h4l2 2h4v13H4zM12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', () => {
        alvoDaCapa = uid;
        $('arquivo-capa').click();
      }),

      acaoDaFolha(f.letra ? 'Trocar a letra (.lrc)' : 'Importar a letra (.lrc)',
        'M4 5h16M4 10h16M4 15h10M4 20h7', () => {
        alvoDaLetra = uid;
        $('arquivo-letra').click();
      }),
    );

    if (estado.grupoAberto && estado.grupoAberto.tipo === 'lista') {
      const lista = estado.listas.find(l => l.id === estado.grupoAberto.chave);
      if (lista) {
        corpo.appendChild(acaoDaFolha('Tirar desta playlist', 'M6 6l12 12M18 6L6 18', () => {
          lista.faixas = lista.faixas.filter(u => u !== uid);
          gravarLista(lista);
          fecharFolha(); pintarLista();
          avisar('Saiu da playlist.');
        }, { perigo: true }));
      }
    }

    corpo.appendChild(secao('Cuidado'));
    corpo.appendChild(acaoDaFolha('Remover da biblioteca',
      'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6', () => {
        fecharFolha();
        confirmarFolha('Remover “' + f.tags.titulo + '”?',
          'A faixa sai da Vitrola. O arquivo continua no aparelho.',
          'Remover', () => removerFaixa(uid));
      }, { perigo: true }));
  });
}

function confirmarFolha(titulo, texto, rotuloOk, aoConfirmar) {
  abrirFolha('confirmar', titulo, corpo => {
    corpo.appendChild(elemento('p', 'folha-nota', texto));
    const ok = elemento('button', 'botao-lima', rotuloOk);
    ok.type = 'button';
    ok.style.width = '100%';
    ok.style.marginBlockStart = '20px';
    ok.addEventListener('click', () => { fecharFolha(); aoConfirmar(); });
    const nao = acaoDaFolha('Deixar como está', null, fecharFolha);
    nao.style.justifyContent = 'center';
    corpo.append(ok, nao);
  });
}

/* ---- editor de etiquetas ---- */

function folhaEditar(uid) {
  const f = faixaDe(uid);
  if (!f) return;

  abrirFolha('editar', 'Corrigir informações', corpo => {
    const campos = [
      ['titulo', 'Título', f.tags.titulo],
      ['artista', 'Artista', f.tags.artista],
      ['album', 'Álbum', f.tags.album || ''],
    ];
    const entradas = {};
    for (const [chave, rotulo, valor] of campos) {
      const l = elemento('label', 'campo');
      l.appendChild(elemento('span', 'campo-rotulo', rotulo));
      const i = elemento('input', 'campo-entrada');
      i.type = 'text';
      i.value = valor;
      i.autocomplete = 'off';
      l.appendChild(i);
      entradas[chave] = i;
      corpo.appendChild(l);
    }

    corpo.appendChild(elemento('p', 'folha-nota',
      'Serve para traduzir, renomear ou consertar etiqueta que veio com os quadradinhos ██. ' +
      'A correção fica valendo depois de fechar o aplicativo. O arquivo não é alterado.'));

    const salvar = elemento('button', 'botao-lima', 'Salvar');
    salvar.type = 'button';
    salvar.style.width = '100%';
    salvar.style.marginBlockStart = '8px';
    salvar.addEventListener('click', () => {
      const t = entradas.titulo.value.trim();
      const a = entradas.artista.value.trim();
      const al = entradas.album.value.trim();
      f.tags.titulo  = t || f.tags.titulo;
      f.tags.artista = a || 'Artista desconhecido';
      f.tags.album   = al;
      persistir(f);
      fecharFolha();
      pintarLista(); pintarAgora(); anunciarAoSistema(f); contarAoSistema(true);
      avisar('Informações corrigidas.');
    });
    corpo.appendChild(salvar);
  });
}

/* ---- escolher playlist ---- */

function folhaEscolherLista(uid) {
  abrirFolha('listas', 'Pôr numa playlist', corpo => {
    if (!estado.listas.length) {
      corpo.appendChild(elemento('p', 'folha-nota', 'Você ainda não tem playlists.'));
    }
    for (const l of estado.listas) {
      corpo.appendChild(acaoDaFolha(l.nome, 'M4 7h11M4 12h8M4 17h6', () => {
        const entrou = porNaLista(l, uid);
        fecharFolha();
        avisar(entrou ? 'Foi para “' + l.nome + '”.' : 'Já estava em “' + l.nome + '”.');
      }, { direita: l.faixas.length + '' }));
    }

    corpo.appendChild(secao('Nova'));
    const l = elemento('label', 'campo');
    l.appendChild(elemento('span', 'campo-rotulo', 'Nome da playlist'));
    const i = elemento('input', 'campo-entrada');
    i.type = 'text'; i.placeholder = 'Para dirigir, Para dormir…';
    l.appendChild(i);
    corpo.appendChild(l);

    const criar = elemento('button', 'botao-lima', 'Criar e pôr aqui');
    criar.type = 'button';
    criar.style.width = '100%';
    criar.addEventListener('click', async () => {
      const nome = i.value.trim();
      if (!nome) { i.focus(); return; }
      const id = await criarLista(nome);
      if (id == null) { avisar('Não deu para criar a playlist.'); return; }
      const nova = estado.listas.find(x => x.id === id);
      porNaLista(nova, uid);
      fecharFolha(); pintarLista();
      avisar('“' + nome + '” criada.');
    });
    corpo.appendChild(criar);
  });
}

/* ---- a fila ---- */

function folhaFila() {
  abrirFolha('fila', 'A fila', corpo => {
    if (!estado.fila.length) {
      corpo.appendChild(elemento('p', 'folha-nota', 'A fila está vazia.'));
      return;
    }

    const cab = elemento('div', 'fila-cabeca');
    cab.appendChild(elemento('span', 'folha-secao',
      (estado.pos + 1) + ' de ' + estado.fila.length +
      (estado.aleatorio ? '  ·  embaralhada' : '')));
    const limpar = elemento('button', 'chip', 'Limpar o que já passou');
    limpar.type = 'button';
    limpar.addEventListener('click', () => {
      estado.fila = estado.fila.slice(estado.pos);
      estado.pos = 0;
      guardarSessao();
      folhaFila();
    });
    if (estado.pos > 0) cab.appendChild(limpar);
    corpo.appendChild(cab);

    const ol = elemento('ol', 'folha-lista');
    estado.fila.forEach((uid, i) => {
      const f = faixaDe(uid);
      if (!f) return;
      const li = linhaDeFaixa(f, 'fila');
      if (i < estado.pos) li.classList.add('fila-passada');
      li.querySelector('.item').dataset.filaPos = i;
      ol.appendChild(li);
    });
    corpo.appendChild(ol);

    ol.addEventListener('click', e => {
      const mais = e.target.closest('.item-mais');
      if (mais) { folhaDaFaixa(mais.dataset.uid); return; }
      const b = e.target.closest('.item');
      if (!b) return;
      estado.pos = Number(b.dataset.filaPos);
      carregar(estado.fila[estado.pos], true);
      fecharFolha();
      irPara('tocando');
    });
  });
}

/* ---- a letra inteira ---- */

function pintarLetraInteira() {
  const caixa = $('folha-corpo').querySelector('.letra-toda');
  if (!caixa) return;
  const f = faixaAtual();
  if (!f || !f.letra || f.letra.tipo !== 'sincronizada') return;
  const i = linhaDaLetra(f.letra.linhas, som.currentTime);
  const botoes = caixa.children;
  for (let k = 0; k < botoes.length; k++) botoes[k].classList.toggle('ativa', k === i);
  const ativo = botoes[i];
  if (ativo && ativo.scrollIntoView) {
    ativo.scrollIntoView({ block: 'center', behavior: menosMovimento ? 'auto' : 'smooth' });
  }
}

function folhaLetra() {
  const f = faixaAtual();
  if (!f) return;

  if (!f.letra) {
    abrirFolha('letra', 'Letra', corpo => {
      corpo.appendChild(elemento('p', 'folha-nota',
        'Este arquivo não traz a letra. Dá para importar um arquivo .lrc — ' +
        'se ele tiver marcação de tempo, a letra acompanha a música.'));
      corpo.appendChild(acaoDaFolha('Importar arquivo .lrc', 'M12 4v12M7 11l5 5 5-5M5 20h14', () => {
        alvoDaLetra = f.uid;
        $('arquivo-letra').click();
      }));
    });
    return;
  }

  abrirFolha('letra', f.tags.titulo, corpo => {
    const caixa = elemento('div', 'letra-toda');
    const sinc = f.letra.tipo === 'sincronizada';

    for (const linha of f.letra.linhas) {
      const b = elemento('button', null, sinc ? linha.texto : linha);
      b.type = 'button';
      if (sinc) {
        b.addEventListener('click', () => {
          som.currentTime = Math.max(0, linha.t - 0.15);
          pintarProgresso(); pintarLetra(true);
          if (som.paused) tocar();
        });
      } else {
        b.disabled = true;
      }
      caixa.appendChild(b);
    }
    corpo.appendChild(caixa);

    if (!sinc) {
      corpo.appendChild(elemento('p', 'folha-nota',
        'Sem marcação de tempo — dá para ler, mas não dá para acompanhar.'));
    }
    setTimeout(pintarLetraInteira, 30);
  });
}

/* ---- ordenação ---- */

function folhaOrdenar() {
  abrirFolha('ordenar', 'Ordenar por', corpo => {
    for (const chave in ORDENS) {
      const marca = estado.ordenacao === chave ? '✓' : '';
      corpo.appendChild(acaoDaFolha(ORDENS[chave].rotulo[0].toUpperCase() + ORDENS[chave].rotulo.slice(1),
        null, () => {
          estado.ordenacao = chave;
          pref.gravar('ordenacao', chave);
          $('rotulo-ordem').textContent = ORDENS[chave].rotulo;
          fecharFolha(); pintarLista();
        }, { direita: marca }));
    }
  });
}

/* ---- velocidade ---- */

function folhaVelocidade() {
  abrirFolha('velocidade', 'Velocidade', corpo => {
    const atual = pref.ler('velocidade', 1);
    const seg = elemento('div', 'segmentos');
    for (const v of [0.75, 1, 1.25, 1.5, 2]) {
      const b = elemento('button', 'segmento', (v === 1 ? '1' : String(v).replace('.', ',')) + 'x');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(v === atual));
      b.addEventListener('click', () => {
        aplicarVelocidade(v);
        for (const o of seg.children) o.setAttribute('aria-pressed', String(o === b));
      });
      seg.appendChild(b);
    }
    corpo.appendChild(seg);
    corpo.appendChild(elemento('p', 'folha-nota',
      'O tom é mantido: a música fica mais rápida sem ficar mais aguda.'));
  });
}

/* ---- timer para dormir ---- */

function limparTimer() {
  clearTimeout(estado.timer);
  estado.timer = null;
  estado.timerFim = 0;
  estado.timerAoFim = false;
  mostrar($('selo-timer'), false);
  $('btn-timer').classList.remove('ativa');
}

function marcarTimer(minutos) {
  limparTimer();
  if (!minutos) return;
  estado.timerFim = Date.now() + minutos * 60000;
  estado.timer = setTimeout(() => {
    pausar();
    limparTimer();
    avisar('Boa noite. A música parou.');
  }, minutos * 60000);
  pintarTimer();
  avisar('Para em ' + minutos + ' min.');
}

function pintarTimer() {
  const b = $('btn-timer');
  const selo = $('selo-timer');
  if (estado.timerAoFim) {
    selo.textContent = 'fim';
    mostrar(selo, true);
    b.classList.add('ativa');
    return;
  }
  if (!estado.timerFim) { mostrar(selo, false); b.classList.remove('ativa'); return; }
  const faltam = Math.max(0, Math.ceil((estado.timerFim - Date.now()) / 60000));
  selo.textContent = faltam;
  mostrar(selo, true);
  b.classList.add('ativa');
}

function folhaTimer() {
  abrirFolha('timer', 'Parar de tocar', corpo => {
    corpo.appendChild(elemento('p', 'folha-nota',
      'A música para sozinha depois do tempo escolhido.'));
    for (const m of [10, 20, 30, 45, 60]) {
      corpo.appendChild(acaoDaFolha('Em ' + m + ' minutos', null, () => {
        marcarTimer(m); fecharFolha();
      }));
    }
    corpo.appendChild(acaoDaFolha('No fim desta faixa', null, () => {
      limparTimer();
      estado.timerAoFim = true;
      pintarTimer();
      fecharFolha();
      avisar('Para quando esta faixa acabar.');
    }));
    if (estado.timerFim || estado.timerAoFim) {
      corpo.appendChild(secao('Agora'));
      corpo.appendChild(acaoDaFolha('Cancelar o timer', 'M6 6l12 12M18 6L6 18', () => {
        limparTimer(); fecharFolha(); avisar('Timer cancelado.');
      }, { perigo: true }));
    }
  });
}

/* ---- ajustes ---- */

function folhaAjustes() {
  abrirFolha('ajustes', 'Ajustes', corpo => {
    /* tema */
    corpo.appendChild(secao('Aparência'));
    const segTema = elemento('div', 'segmentos');
    for (const [valor, rotulo] of [['escuro', 'Escuro'], ['claro', 'Claro'], ['sistema', 'Do sistema']]) {
      const b = elemento('button', 'segmento', rotulo);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(temaEscolhido() === valor));
      b.addEventListener('click', () => {
        aplicarTema(valor);
        for (const o of segTema.children) o.setAttribute('aria-pressed', String(o === b));
      });
      segTema.appendChild(b);
    }
    corpo.appendChild(segTema);

    const girar = pref.ler('girar', true);
    corpo.appendChild(acaoDaFolha('Girar o disco enquanto toca',
      'M12 3a9 9 0 1 0 9 9', () => {
        const novo = document.documentElement.getAttribute('data-girar') === 'nao';
        document.documentElement.setAttribute('data-girar', novo ? 'sim' : 'nao');
        pref.gravar('girar', novo);
        folhaAjustes();
      }, { direita: girar ? 'sim' : 'não' }));

    /* som */
    corpo.appendChild(secao('Som'));

    const linhaVol = elemento('div', 'linha-controle');
    linhaVol.appendChild(svgDe(['M4 9v6h4l5 4V5L8 9H4', 'M17 9.5a4 4 0 0 1 0 5'], false));
    const vol = elemento('input', 'deslizante');
    vol.type = 'range'; vol.min = '0'; vol.max = '1.5'; vol.step = '0.05';
    vol.value = String(volume);
    vol.setAttribute('aria-label', 'Volume');
    const valorVol = elemento('span', 'valor', Math.round(volume * 100) + '%');
    vol.addEventListener('input', () => {
      volume = Number(vol.value);
      aplicarVolume();
      valorVol.textContent = Math.round(volume * 100) + '%';
    });
    linhaVol.append(vol, valorVol);
    corpo.appendChild(linhaVol);
    if (volume > 1 && !ganho) {
      corpo.appendChild(elemento('p', 'folha-nota',
        'Acima de 100% só funciona quando o equalizador está disponível.'));
    }

    corpo.appendChild(acaoDaFolha('Velocidade', null, folhaVelocidade,
      { direita: pref.ler('velocidade', 1) + 'x' }));

    /* equalizador */
    corpo.appendChild(secao('Equalizador'));
    if (!bandas.length) {
      corpo.appendChild(elemento('p', 'folha-nota',
        audioDesistiu
          ? 'Indisponível neste aparelho: o processamento de áudio não subiu, e a Vitrola prefere tocar sem efeito a tocar mudo.'
          : 'Toque uma música primeiro — o equalizador liga junto com o som.'));
    } else {
      const presets = elemento('div', 'segmentos');
      for (const nome in EQ_PADROES) {
        const b = elemento('button', 'segmento', nome);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(EQ_PADROES[nome].every((g, i) => g === eqGanhos[i])));
        b.addEventListener('click', () => {
          eqGanhos = [...EQ_PADROES[nome]];
          aplicarEq();
          folhaAjustes();
        });
        presets.appendChild(b);
      }
      corpo.appendChild(presets);

      const eq = elemento('div', 'eq');
      EQ_HZ.forEach((hz, i) => {
        const faixa = elemento('div', 'eq-faixa');
        const hzRotulo = elemento('span', 'eq-hz', hz >= 1000 ? (hz / 1000) + ' kHz' : hz + ' Hz');
        const db = elemento('span', 'eq-db', (eqGanhos[i] > 0 ? '+' : '') + (eqGanhos[i] || 0) + ' dB');
        const r = elemento('input', 'deslizante');
        r.type = 'range'; r.min = '-12'; r.max = '12'; r.step = '1';
        r.value = String(eqGanhos[i] || 0);
        r.setAttribute('aria-label', hz + ' hertz');
        r.addEventListener('input', () => {
          eqGanhos[i] = Number(r.value);
          db.textContent = (eqGanhos[i] > 0 ? '+' : '') + eqGanhos[i] + ' dB';
          aplicarEq();
        });
        faixa.append(hzRotulo, r, db);
        eq.appendChild(faixa);
      });
      corpo.appendChild(eq);
    }

    /* biblioteca */
    corpo.appendChild(secao('Biblioteca'));
    const total = estado.biblioteca.length;
    const curtidas = estado.biblioteca.filter(f => f.curtida).length;
    const segundos = estado.biblioteca.reduce((s, f) => s + (f.dur || 0), 0);
    const horas = Math.floor(segundos / 3600), mins = Math.round((segundos % 3600) / 60);
    corpo.appendChild(elemento('p', 'folha-nota',
      total + (total === 1 ? ' faixa' : ' faixas') +
      '  ·  ' + curtidas + ' curtidas' +
      (segundos ? '  ·  ' + (horas ? horas + 'h ' : '') + mins + 'min de música' : '')));

    corpo.appendChild(elemento('p', 'folha-nota',
      'Tudo fica neste aparelho. Nada é enviado para lugar nenhum, e a Vitrola ' +
      'funciona sem internet.'));
  });
}


/* ===========================================================================
   11. ENTRADA E ARRANQUE
   ========================================================================= */

/* --- navegação --- */
$('btn-voltar').addEventListener('click', () => irPara('biblioteca'));
$('mini-abrir').addEventListener('click', () => irPara('tocando'));
$('mini-abrir-txt').addEventListener('click', () => irPara('tocando'));
$('btn-fila').addEventListener('click', folhaFila);
$('letra').addEventListener('click', folhaLetra);

$('btn-menu').addEventListener('click', e => {
  e.stopPropagation();
  const m = $('menu');
  m.hidden = !m.hidden;
  $('btn-menu').setAttribute('aria-expanded', String(!m.hidden));
});
document.addEventListener('click', e => {
  if (!$('menu').hidden && !$('menu').contains(e.target) && e.target !== $('btn-menu')) fecharMenu();
});

$('btn-faixa-menu').addEventListener('click', () => {
  const f = faixaAtual();
  if (f) folhaDaFaixa(f.uid);
});

/* --- folha: fechar --- */
$('folha-fechar').addEventListener('click', fecharFolha);
$('folha-fundo').addEventListener('click', fecharFolha);

/* arrastar a folha para baixo fecha — o mesmo gesto que o dedo já espera */
(function arrastarFolha() {
  const puxador = $('folha-puxador');
  const folha = $('folha');
  let y0 = 0, arrastando = false;

  puxador.addEventListener('pointerdown', e => {
    arrastando = true; y0 = e.clientY;
    puxador.setPointerCapture(e.pointerId);
  });
  puxador.addEventListener('pointermove', e => {
    if (!arrastando) return;
    const d = Math.max(0, e.clientY - y0);
    folha.style.transform = 'translateY(' + d + 'px)';
  });
  const soltar = e => {
    if (!arrastando) return;
    arrastando = false;
    try { puxador.releasePointerCapture(e.pointerId); } catch (_) {}
    const d = Math.max(0, e.clientY - y0);
    if (d > 90) fecharFolha();
    else folha.style.transform = '';
  };
  puxador.addEventListener('pointerup', soltar);
  puxador.addEventListener('pointercancel', soltar);
})();

/* --- busca --- */
function limparBusca() {
  estado.busca = '';
  $('campo-busca').value = '';
  mostrar($('btn-busca-limpar'), false);
  pintarLista();
}
$('campo-busca').addEventListener('input', e => {
  estado.busca = e.target.value;
  mostrar($('btn-busca-limpar'), !!estado.busca);
  agendarPintura();
});
$('btn-busca-limpar').addEventListener('click', () => { limparBusca(); $('campo-busca').focus(); });

/* --- filtros --- */
for (const c of document.querySelectorAll('.chip[data-filtro]')) {
  c.addEventListener('click', () => {
    estado.filtro = c.dataset.filtro;
    estado.grupoAberto = null;
    for (const o of document.querySelectorAll('.chip[data-filtro]')) {
      o.setAttribute('aria-pressed', String(o === c));
    }
    pintarLista();
    $('lista').scrollTop = 0;
  });
}

/* --- lista --- */
$('lista').addEventListener('click', e => {
  if (e.target.closest('#voltar-grupo')) {
    estado.grupoAberto = null;
    pintarLista();
    return;
  }

  const grupo = e.target.closest('[data-grupo]');
  if (grupo) {
    estado.grupoAberto = {
      tipo: grupo.dataset.grupo,
      chave: grupo.dataset.grupo === 'lista' ? Number(grupo.dataset.chave) : grupo.dataset.chave,
      rotulo: grupo.dataset.rotulo,
    };
    pintarLista();
    $('lista').scrollTop = 0;
    return;
  }

  const mais = e.target.closest('.item-mais');
  if (mais) { e.stopPropagation(); folhaDaFaixa(mais.dataset.uid); return; }

  const b = e.target.closest('.item');
  if (b) {
    const uid = b.dataset.uid;
    definirFila(faixasVisiveis(), uid);
    carregar(uid, true);
    irPara('tocando');
  }
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
$('btn-curtir').addEventListener('click', () => alternarCurtida());
$('btn-velocidade').addEventListener('click', folhaVelocidade);
$('btn-timer').addEventListener('click', folhaTimer);

$('btn-aleatorio').addEventListener('click', e => {
  estado.aleatorio = !estado.aleatorio;
  pref.gravar('aleatorio', estado.aleatorio);
  e.currentTarget.setAttribute('aria-pressed', String(estado.aleatorio));
  refazerAleatorio();
  pintarAgora();
  avisar(estado.aleatorio ? 'Embaralhada' : 'Na ordem');
});

$('btn-repetir').addEventListener('click', () => {
  estado.repetir = estado.repetir === 'tudo' ? 'uma' : estado.repetir === 'uma' ? 'nao' : 'tudo';
  pref.gravar('repetir', estado.repetir);
  pintarRepetir();
  avisar(estado.repetir === 'nao' ? 'Sem repetir'
       : estado.repetir === 'uma' ? 'Repetindo esta faixa'
       : 'Repetindo a fila');
});

/* --- menu da biblioteca --- */
$('btn-embaralhar-tudo').addEventListener('click', () => {
  if (!estado.biblioteca.length) return;
  fecharMenu();
  estado.aleatorio = true;
  pref.gravar('aleatorio', true);
  $('btn-aleatorio').setAttribute('aria-pressed', 'true');
  const todas = faixasVisiveis().length ? faixasVisiveis() : estado.biblioteca;
  const sorteada = todas[Math.floor(Math.random() * todas.length)];
  definirFila(todas, sorteada.uid);
  carregar(sorteada.uid, true);
  irPara('tocando');
});

$('btn-ordenar').addEventListener('click', () => { fecharMenu(); folhaOrdenar(); });
$('btn-ajustes').addEventListener('click', () => { fecharMenu(); folhaAjustes(); });

$('btn-nova-lista').addEventListener('click', () => {
  fecharMenu();
  abrirFolha('nova-lista', 'Criar playlist', corpo => {
    const l = elemento('label', 'campo');
    l.appendChild(elemento('span', 'campo-rotulo', 'Nome'));
    const i = elemento('input', 'campo-entrada');
    i.type = 'text'; i.placeholder = 'Para dirigir, Para dormir…';
    l.appendChild(i);
    corpo.appendChild(l);

    const criar = elemento('button', 'botao-lima', 'Criar');
    criar.type = 'button';
    criar.style.width = '100%';
    criar.addEventListener('click', async () => {
      const nome = i.value.trim();
      if (!nome) { i.focus(); return; }
      const id = await criarLista(nome);
      fecharFolha();
      if (id == null) { avisar('Não deu para criar a playlist.'); return; }
      estado.filtro = 'listas';
      for (const c of document.querySelectorAll('.chip[data-filtro]')) {
        c.setAttribute('aria-pressed', String(c.dataset.filtro === 'listas'));
      }
      pintarLista();
      avisar('“' + nome + '” criada. Ponha músicas pelo menu de cada faixa.');
    });
    corpo.appendChild(criar);
    setTimeout(() => i.focus(), 80);
  });
});

$('btn-limpar').addEventListener('click', () => {
  fecharMenu();
  confirmarFolha('Esvaziar a biblioteca?',
    'Todas as faixas, playlists e curtidas saem da Vitrola. Os arquivos continuam no aparelho.',
    'Esvaziar', async () => {
      pausar();
      for (const f of estado.biblioteca) {
        if (f.url) URL.revokeObjectURL(f.url);
        soltarCapa(f.uid);
      }
      estado.biblioteca = []; estado.porUid.clear();
      estado.fila = []; estado.filaOriginal = []; estado.pos = -1;
      estado.listas = []; estado.corCapa = null; estado.grupoAberto = null;
      som.removeAttribute('src'); som.load();
      await esquecerTudo();
      pref.gravar('sessao', null);
      pintarLista(); pintarAgora(); pintarBotaoTocar(); pintarProgresso();
      contarAoSistema(true);          // sem faixa, isso tira o card da tela de bloqueio
      irPara('biblioteca');
      avisar('Biblioteca esvaziada.');
    });
});

/* Só existe dentro do aplicativo: no navegador não há tela de bloqueio
   própria para diagnosticar, e o item viraria enfeite. */
mostrar($('btn-diagnostico'), !!ponteDoSistema());
$('btn-diagnostico').addEventListener('click', () => {
  fecharMenu();
  const texto = relatorio();
  try { window.alert(texto); } catch (_) { avisar(texto.replace(/\n/g, ' · ')); }
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
  trilho.classList.add('pegando');
  trilho.setPointerCapture(e.pointerId);
  buscarPor(e.clientX);
});
trilho.addEventListener('pointermove', e => { if (estado.arrastando) buscarPor(e.clientX); });
const soltarTrilho = e => {
  estado.arrastando = false;
  trilho.classList.remove('pegando');
  try { trilho.releasePointerCapture(e.pointerId); } catch (_) {}
};
trilho.addEventListener('pointerup', soltarTrilho);
trilho.addEventListener('pointercancel', soltarTrilho);
trilho.addEventListener('keydown', e => {
  if (!isFinite(som.duration)) return;
  const salto = e.shiftKey ? 30 : 5;
  if (e.key === 'ArrowRight') { som.currentTime = Math.min(som.duration, som.currentTime + salto); e.preventDefault(); }
  if (e.key === 'ArrowLeft')  { som.currentTime = Math.max(0, som.currentTime - salto); e.preventDefault(); }
});

/* --- deslizar no disco troca de faixa --- */
(function gestoNoPrato() {
  const prato = $('prato');
  let x0 = 0, y0 = 0, valendo = false;

  prato.addEventListener('pointerdown', e => { valendo = true; x0 = e.clientX; y0 = e.clientY; });
  prato.addEventListener('pointerup', e => {
    if (!valendo) return;
    valendo = false;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
    pular(dx < 0 ? 1 : -1);
  });
  prato.addEventListener('pointercancel', () => { valendo = false; });
})();

/* --- arquivos --- */
for (const b of [$('btn-adicionar'), $('btn-adicionar-vazio')]) {
  if (b) b.addEventListener('click', () => $('arquivos').click());
}
$('arquivos').addEventListener('change', e => {
  acrescentar(e.target.files);
  e.target.value = '';
});

let alvoDaCapa = null;
$('arquivo-capa').addEventListener('change', async e => {
  const arquivo = e.target.files && e.target.files[0];
  e.target.value = '';
  const f = alvoDaCapa ? faixaDe(alvoDaCapa) : null;
  alvoDaCapa = null;
  if (!arquivo || !f) return;

  soltarCapa(f.uid);
  f.capaBlob = arquivo;
  f.capaAviso = undefined;
  persistir(f);
  fecharFolha();
  pintarLista();
  if (faixaAtual() === f) { pintarAgora(); capaParaOSistema(f); anunciarAoSistema(f); }
  avisar('Capa trocada.');
});

let alvoDaLetra = null;
$('arquivo-letra').addEventListener('change', async e => {
  const arquivo = e.target.files && e.target.files[0];
  e.target.value = '';
  const f = alvoDaLetra ? faixaDe(alvoDaLetra) : null;
  alvoDaLetra = null;
  if (!arquivo || !f) return;

  let texto = '';
  try {
    const bytes = new Uint8Array(await arquivo.arrayBuffer());
    texto = decodificar(bytes, 3);       // tenta UTF-8 e cai para os outros
  } catch (_) {}

  const lrc = lerLRC(texto);
  if (lrc) {
    f.letra = lrc;
  } else {
    const linhas = texto.split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean);
    if (!linhas.length) { avisar('O arquivo veio vazio.'); return; }
    f.letra = { tipo: 'corrida', linhas };
  }
  persistir(f);
  fecharFolha();
  letraIndice = -1;
  pintarLetra(true);
  avisar(lrc ? 'Letra sincronizada importada.' : 'Letra importada, sem marcação de tempo.');
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
  if (e.dataTransfer && e.dataTransfer.files.length) acrescentar(e.dataTransfer.files);
});

/* --- teclado --- */
window.addEventListener('keydown', e => {
  const a = e.target;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) {
    if (e.key === 'Escape' && folhaAberta) fecharFolha();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key) {
    case ' ': case 'k': e.preventDefault(); som.paused ? tocar() : pausar(); break;
    case 'ArrowRight': e.preventDefault(); pular(1); break;
    case 'ArrowLeft':  e.preventDefault(); pular(-1); break;
    case 'Escape':
      if (folhaAberta) fecharFolha();
      else if (!$('menu').hidden) fecharMenu();
      else irPara('biblioteca');
      break;
    default: {
      const k = e.key.toLowerCase();
      if (k === 's') $('btn-aleatorio').click();
      else if (k === 'r') $('btn-repetir').click();
      else if (k === 'l') alternarCurtida();
      else if (k === 'q') folhaFila();
      else if (k === '/') { e.preventDefault(); irPara('biblioteca'); $('campo-busca').focus(); }
    }
  }
}, { passive: false });

/* --- eventos do áudio --- */
som.addEventListener('play', () => { acordarAudio(); pintarBotaoTocar(); contarAoSistema(true); });
som.addEventListener('playing', acordarAudio);
som.addEventListener('pause', () => { pintarBotaoTocar(); contarAoSistema(true); guardarSessao(); });
som.addEventListener('seeked', () => contarAoSistema(true));
document.addEventListener('visibilitychange', () => {
  if (!som.paused) acordarAudio();
  if (document.visibilityState === 'hidden') guardarSessao();
});

let ultimoGuardado = 0;
som.addEventListener('timeupdate', () => {
  pintarProgresso(); pintarLetra(false); posicaoNoSistema(); contarAoSistema(false);
  contarEscuta();
  if (estado.timerFim) pintarTimer();
  const agora = Date.now();
  if (agora - ultimoGuardado > 5000) { ultimoGuardado = agora; guardarSessao(); }
});
som.addEventListener('loadedmetadata', () => {
  const f = faixaAtual();
  if (f && !f.dur) { f.dur = som.duration; persistir(f); agendarPintura(); }
  pintarProgresso(); posicaoNoSistema(); contarAoSistema(true);
});
som.addEventListener('ended', () => {
  const f = faixaAtual();
  if (f && !estado.contado) { f.contagem = (f.contagem || 0) + 1; f.ultimaVez = Date.now(); persistir(f); }

  if (estado.timerAoFim) {
    limparTimer();
    pausar(); som.currentTime = 0;
    avisar('Boa noite. A música parou.');
    return;
  }
  if (estado.repetir === 'uma') { som.currentTime = 0; estado.contado = false; tocar(); return; }
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

/* --- o tema do sistema pode mudar com o aparelho ligado --- */
if (window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const ouvir = () => { if (temaEscolhido() === 'sistema') aplicarTema('sistema'); };
  if (mq.addEventListener) mq.addEventListener('change', ouvir);
  else if (mq.addListener) mq.addListener(ouvir);
}

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
  aplicarTema(temaEscolhido());
  if (!pref.ler('girar', true)) document.documentElement.setAttribute('data-girar', 'nao');

  aplicarVolume();
  aplicarVelocidade(pref.ler('velocidade', 1));
  $('rotulo-ordem').textContent = ORDENS[estado.ordenacao] ? ORDENS[estado.ordenacao].rotulo : 'adição';
  $('btn-aleatorio').setAttribute('aria-pressed', String(estado.aleatorio));
  pintarRepetir();

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
