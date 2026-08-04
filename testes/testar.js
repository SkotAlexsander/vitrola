/* Uso: node testes/testar.js
   Carrega o app.js de verdade num DOM falso e testa o que e logica pura:
   o leitor de ID3 (contra arquivos sinteticos montados byte a byte) e a
   matematica de cor. Interface, audio e Media Session so olhando. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ARQ = path.join(__dirname, '..', 'app.js');

/* ---------------------------------------------------------- DOM de mentira */
const noop = () => {};
function elFalso(id) {
  const el = {
    id, textContent: '', innerHTML: '', value: '85', hidden: false,
    dataset: {}, style: { setProperty: noop, removeProperty: noop },
    src: '', alt: '', paused: true, volume: 1, muted: false,
    currentTime: 0, duration: 0, playbackRate: 1,
    width: 800, height: 100,
    addEventListener: noop, removeEventListener: noop, setAttribute: noop,
    getAttribute: () => null, hasAttribute: () => false, removeAttribute: noop,
    appendChild: noop, append: noop, closest: () => null, click: noop,
    setPointerCapture: noop, releasePointerCapture: noop,
    play: () => Promise.resolve(), pause: noop, load: noop,
    getBoundingClientRect: () => ({ width: 800, height: 100, left: 0, top: 0 }),
    getContext: () => ctxFalso(),
  };
  return el;
}
const PROPS = new Set(['fillStyle','strokeStyle','lineWidth','lineCap','lineJoin','font',
  'textAlign','textBaseline','globalAlpha','globalCompositeOperation','shadowColor',
  'shadowBlur','filter','imageSmoothingEnabled']);
function ctxFalso() {
  const dados = { data: new Uint8ClampedArray(56 * 56 * 4) };
  return new Proxy({}, {
    get(a, k) {
      if (k === 'getImageData') return () => dados;
      if (PROPS.has(k)) return a[k];
      return noop;
    },
    set(a, k, v) { a[k] = v; return true; },
  });
}

const guardado = {};
const ctxGlobal = {
  console, Blob, File, TextDecoder, Uint8Array, Float32Array, Promise, Math, JSON,
  setTimeout, clearTimeout, Audio: function () { return elFalso('sonda'); },
  Image: function () { return elFalso('img'); },
  requestAnimationFrame: noop, cancelAnimationFrame: noop,
  URL: { createObjectURL: () => 'blob:falso', revokeObjectURL: noop },
  localStorage: {
    getItem: k => (k in guardado ? guardado[k] : null),
    setItem: (k, v) => { guardado[k] = String(v); },
  },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  document: {
    getElementById: elFalso,
    createElement: elFalso,
    querySelector: elFalso,
    querySelectorAll: () => [],
    documentElement: elFalso('html'),
    addEventListener: noop,
    title: '',
  },
  window: {
    addEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    devicePixelRatio: 1,
  },
  navigator: {},
};
ctxGlobal.globalThis = ctxGlobal;
ctxGlobal.window.document = ctxGlobal.document;
vm.createContext(ctxGlobal);

let src = fs.readFileSync(ARQ, 'utf8');
src += `
;globalThis.__t = {
  lerEtiquetas, lerID3v2, lerID3v1, sincroSeguro,
  rgbParaHsl, hslParaRgb, luminancia, contraste, hexParaRgb,
  corrigirContraste, ALVO_CONTRASTE, tempo,
};`;
vm.runInContext(src, ctxGlobal, { filename: 'app.js' });
const T = ctxGlobal.__t;

let falhas = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALHA ') + m); if (!c) falhas++; };

/* ------------------------------------------------ montador de MP3 sintetico */
function sincro(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}
function cabecalho(versao, tamanho) {
  const h = Buffer.alloc(10);
  h.write('ID3', 0, 'latin1');
  h[3] = versao;
  sincro(tamanho).copy(h, 6);
  return h;
}
function texto(enc, s) {
  if (enc === 0) return Buffer.concat([Buffer.from([0]), Buffer.from(s, 'latin1')]);
  if (enc === 1) return Buffer.concat([Buffer.from([1]), Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
  if (enc === 3) return Buffer.concat([Buffer.from([3]), Buffer.from(s, 'utf8')]);
  throw new Error('enc');
}
function quadro(id, corpo, versao) {
  if (versao === 2) {
    const h = Buffer.alloc(6);
    h.write(id, 0, 'latin1');
    h[3] = (corpo.length >> 16) & 0xff; h[4] = (corpo.length >> 8) & 0xff; h[5] = corpo.length & 0xff;
    return Buffer.concat([h, corpo]);
  }
  const h = Buffer.alloc(10);
  h.write(id, 0, 'latin1');
  if (versao === 4) sincro(corpo.length).copy(h, 4);
  else h.writeUInt32BE(corpo.length, 4);
  return Buffer.concat([h, corpo]);
}
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
function apic(versao) {
  if (versao === 2) {
    return Buffer.concat([Buffer.from([0]), Buffer.from('PNG', 'latin1'),
                          Buffer.from([3]), Buffer.from('capa\0', 'latin1'), PNG]);
  }
  return Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0', 'latin1'),
                        Buffer.from([3]), Buffer.from('capa\0', 'latin1'), PNG]);
}
function mp3(nome, quadros, versao) {
  const corpo = Buffer.concat(quadros);
  const audioFalso = Buffer.alloc(2048, 0x55);
  const todo = Buffer.concat([cabecalho(versao, corpo.length), corpo, audioFalso]);
  return new File([todo], nome, { type: 'audio/mpeg' });
}
function comID3v1(nome, titulo, artista, album) {
  const t = Buffer.alloc(128);
  t.write('TAG', 0, 'latin1');
  t.write(titulo, 3, 'latin1');
  t.write(artista, 33, 'latin1');
  t.write(album, 63, 'latin1');
  return new File([Buffer.alloc(4096, 0x55), t], nome, { type: 'audio/mpeg' });
}

/* ============================================================= os testes */
(async () => {

console.log('\n[1] ID3v2.3 - o formato mais comum');
{
  const f = mp3('faixa.mp3', [
    quadro('TIT2', texto(1, 'Águas de Março'), 3),
    quadro('TPE1', texto(0, 'Elis Regina'), 3),
    quadro('TALB', texto(1, 'Elis & Tom'), 3),
    quadro('TRCK', texto(0, '3/12'), 3),
    quadro('APIC', apic(3), 3),
  ], 3);
  const t = await T.lerEtiquetas(f);
  ok(t.titulo === 'Águas de Março', `titulo em UTF-16 com acento: "${t.titulo}"`);
  ok(t.artista === 'Elis Regina', `artista em latin1: "${t.artista}"`);
  ok(t.album === 'Elis & Tom', `album: "${t.album}"`);
  ok(t.faixa === '3/12', `numero da faixa: "${t.faixa}"`);
  ok(t.capa && t.capa.type === 'image/png', `capa extraida, tipo ${t.capa && t.capa.type}`);
  ok(t.capa && t.capa.size === PNG.length, `capa com ${t.capa && t.capa.size} bytes (esperado ${PNG.length})`);
}

console.log('\n[2] ID3v2.4 - tamanho de quadro sincro-seguro e UTF-8');
{
  const f = mp3('faixa.mp3', [
    quadro('TIT2', texto(3, 'Construção'), 4),
    quadro('TPE1', texto(3, 'Chico Buarque'), 4),
    quadro('TDRC', texto(3, '1971'), 4),
    quadro('APIC', apic(4), 4),
  ], 4);
  const t = await T.lerEtiquetas(f);
  ok(t.titulo === 'Construção', `titulo em UTF-8: "${t.titulo}"`);
  ok(t.artista === 'Chico Buarque', `artista: "${t.artista}"`);
  ok(t.ano === '1971', `ano por TDRC: "${t.ano}"`);
  ok(!!t.capa, 'capa lida do quadro APIC');
}

console.log('\n[3] ID3v2.2 - identificadores de 3 letras');
{
  const f = mp3('faixa.mp3', [
    quadro('TT2', texto(0, 'Ponta de Lanca'), 2),
    quadro('TP1', texto(0, 'Jorge Ben'), 2),
    quadro('PIC', apic(2), 2),
  ], 2);
  const t = await T.lerEtiquetas(f);
  ok(t.titulo === 'Ponta de Lanca', `titulo: "${t.titulo}"`);
  ok(t.artista === 'Jorge Ben', `artista: "${t.artista}"`);
  ok(t.capa && t.capa.type === 'image/png', 'capa do quadro PIC de 3 letras');
}

console.log('\n[4] quando nao ha ID3v2');
{
  const t = await T.lerEtiquetas(comID3v1('x.mp3', 'Alegria', 'Caetano', 'Transa'));
  ok(t.titulo === 'Alegria', `cai para o ID3v1: "${t.titulo}"`);
  ok(t.artista === 'Caetano', `artista pelo v1: "${t.artista}"`);

  const semNada = new File([Buffer.alloc(3000, 0x55)], 'minha_musica_favorita.mp3', { type: 'audio/mpeg' });
  const t2 = await T.lerEtiquetas(semNada);
  ok(t2.titulo === 'minha musica favorita', `sem etiqueta nenhuma, usa o nome: "${t2.titulo}"`);
  ok(t2.artista === 'Artista desconhecido', 'e diz que o artista e desconhecido');
}

console.log('\n[5] arquivo torto nao pode derrubar o leitor');
{
  const lixo = new File([Buffer.concat([Buffer.from('ID3', 'latin1'),
    Buffer.from([3, 0, 0]), Buffer.from([0x7f, 0x7f, 0x7f, 0x7f]),
    Buffer.alloc(500, 0xff)])], 'torto.mp3', { type: 'audio/mpeg' });
  let quebrou = false, t = null;
  try { t = await T.lerEtiquetas(lixo); } catch (_) { quebrou = true; }
  ok(!quebrou, 'cabecalho mentindo o tamanho nao lanca excecao');
  ok(t && t.titulo === 'torto', `e ainda devolve algo util: "${t && t.titulo}"`);

  const vazio = new File([], 'vazio.mp3', { type: 'audio/mpeg' });
  let q2 = false;
  try { await T.lerEtiquetas(vazio); } catch (_) { q2 = true; }
  ok(!q2, 'arquivo de zero byte nao lanca excecao');
}

console.log('\n[6] ida e volta entre RGB e HSL');
{
  let pior = 0;
  for (let i = 0; i < 4000; i++) {
    const r = (i * 71) % 256, g = (i * 149) % 256, b = (i * 223) % 256;
    const [h, s, l] = T.rgbParaHsl(r, g, b);
    const [r2, g2, b2] = T.hslParaRgb(h, s, l);
    pior = Math.max(pior, Math.abs(r - r2), Math.abs(g - g2), Math.abs(b - b2));
  }
  ok(pior <= 1, `erro maximo de ida e volta: ${pior} (de 255)`);
}

console.log('\n[7] a correcao de contraste realmente alcanca o alvo WCAG');
{
  const fundos = { 'claro #E8E9EC': '#E8E9EC', 'escuro #0E0E10': '#0E0E10' };
  for (const nome in fundos) {
    const fundo = fundos[nome];
    const lumFundo = T.luminancia(T.hexParaRgb(fundo));
    let falhou = 0, pior = 99, quemPior = '';
    for (let h = 0; h < 360; h += 5) {
      for (const s of [0.25, 0.6, 0.95]) {
        for (const l of [0.15, 0.5, 0.85]) {
          const c = T.corrigirContraste({ h, s, l }, fundo, T.ALVO_CONTRASTE);
          const r = T.contraste(T.luminancia(T.hslParaRgb(c.h, c.s, c.l)), lumFundo);
          if (r < T.ALVO_CONTRASTE - 0.01) { falhou++; if (r < pior) { pior = r; quemPior = `h${h} s${s} l${l}`; } }
        }
      }
    }
    const total = 72 * 9;
    ok(falhou === 0, `${nome}: ${total - falhou}/${total} cores passam em ${T.ALVO_CONTRASTE}:1` +
       (falhou ? ` — pior ${pior.toFixed(2)} em ${quemPior}` : ''));
  }
}

console.log('\n[8] a cor extraida nunca fica ilegivel');
{
  // um amarelo vivo, o caso classico que some em fundo claro
  const amarelo = { h: 52, s: 0.95, l: 0.6 };
  const noClaro = T.corrigirContraste(amarelo, '#E8E9EC', 4.5);
  const noEscuro = T.corrigirContraste(amarelo, '#0E0E10', 4.5);
  const cClaro = T.contraste(T.luminancia(T.hslParaRgb(noClaro.h, noClaro.s, noClaro.l)),
                             T.luminancia(T.hexParaRgb('#E8E9EC')));
  const cEscuro = T.contraste(T.luminancia(T.hslParaRgb(noEscuro.h, noEscuro.s, noEscuro.l)),
                              T.luminancia(T.hexParaRgb('#0E0E10')));
  console.log(`        amarelo l=0.60 -> claro l=${noClaro.l.toFixed(2)} (${cClaro.toFixed(1)}:1)` +
              `, escuro l=${noEscuro.l.toFixed(2)} (${cEscuro.toFixed(1)}:1)`);
  ok(cClaro >= 4.5 && cEscuro >= 4.5, 'o amarelo e corrigido nos dois temas');
  ok(noClaro.h === amarelo.h && noEscuro.h === amarelo.h, 'a matiz e preservada — muda so a luminosidade');
}

console.log('\n[9] formatacao de tempo');
{
  ok(T.tempo(0) === '0:00', 'zero');
  ok(T.tempo(65) === '1:05', '65s = 1:05');
  ok(T.tempo(3599) === '59:59', '3599s = 59:59');
  ok(T.tempo(NaN) === '0:00', 'NaN nao vira "NaN:NaN"');
  ok(T.tempo(-5) === '0:00', 'negativo vira zero');
}

console.log('\n' + (falhas === 0 ? 'TUDO PASSOU' : `${falhas} FALHA(S)`));
process.exit(falhas === 0 ? 0 : 1);

})().catch(e => { console.error('EXCECAO:', e); process.exit(1); });
