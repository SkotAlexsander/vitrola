/* Uso: node testes/testar.js
   Carrega o app.js de verdade num DOM falso e testa o que e logica pura:
   o leitor de ID3 — incluindo a letra com marcacao de tempo — e a
   formatacao de tempo. Interface, audio e Media Session so olhando. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ARQ = path.join(__dirname, '..', 'app.js');

/* ---------------------------------------------------------- DOM de mentira */
const noop = () => {};
function elFalso(id) {
  return {
    id, textContent: '', innerHTML: '', value: '', hidden: false,
    dataset: {}, style: {}, title: '',
    src: '', alt: '', paused: true, volume: 1, muted: false,
    currentTime: 0, duration: 0, playbackRate: 1, width: 800, height: 600,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, removeEventListener: noop,
    setAttribute: noop, getAttribute: () => null, hasAttribute: () => false,
    removeAttribute: noop, toggleAttribute: noop,
    appendChild: noop, append: noop, prepend: noop, remove: noop,
    contains: () => false, closest: () => null, click: noop,
    setPointerCapture: noop, releasePointerCapture: noop,
    play: () => Promise.resolve(), pause: noop, load: noop,
    getBoundingClientRect: () => ({ width: 400, height: 700, left: 0, top: 0 }),
    getContext: () => ctxFalso(),
  };
}
const PROPS = new Set(['fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin',
  'font', 'textAlign', 'textBaseline', 'globalAlpha', 'globalCompositeOperation',
  'shadowColor', 'shadowBlur', 'filter']);
function ctxFalso() {
  return new Proxy({}, {
    get(a, k) {
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(40 * 40 * 4) });
      if (k === 'createRadialGradient') return () => ({ addColorStop: noop });
      if (PROPS.has(k)) return a[k];
      return noop;
    },
    set(a, k, v) { a[k] = v; return true; },
  });
}

const ctxGlobal = {
  console, Blob, File, TextDecoder, Uint8Array, Uint8ClampedArray, Promise, Math, JSON,
  setTimeout, clearTimeout, requestAnimationFrame: noop,
  Audio: function () { return elFalso('sonda'); },
  Image: function () { return elFalso('img'); },
  URL: { createObjectURL: () => 'blob:falso', revokeObjectURL: noop },
  document: {
    getElementById: elFalso,
    createElement: elFalso,
    createElementNS: elFalso,
    querySelector: elFalso,
    querySelectorAll: () => [],
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
vm.createContext(ctxGlobal);

let src = fs.readFileSync(ARQ, 'utf8');
src += `
;globalThis.__t = { lerEtiquetas, lerID3v2, lerID3v1, sincroSeguro, tempo };`;
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
/** USLT: enc, idioma(3), descricao\0, letra */
function uslt(linhas) {
  return Buffer.concat([Buffer.from([3]), Buffer.from('por', 'latin1'),
                        Buffer.from('\0', 'latin1'), Buffer.from(linhas.join('\n'), 'utf8')]);
}
/** SYLT: enc, idioma(3), formato, tipo, descricao\0, [texto\0 tempo(4)]* */
function sylt(pares) {
  const partes = [Buffer.from([3]), Buffer.from('por', 'latin1'),
                  Buffer.from([2]), Buffer.from([1]), Buffer.from('\0', 'latin1')];
  for (const [ms, txt] of pares) {
    const t = Buffer.alloc(4);
    t.writeUInt32BE(ms, 0);
    partes.push(Buffer.from(txt, 'utf8'), Buffer.from('\0', 'latin1'), t);
  }
  return Buffer.concat(partes);
}
function mp3(nome, quadros, versao) {
  const corpo = Buffer.concat(quadros);
  const todo = Buffer.concat([cabecalho(versao, corpo.length), corpo, Buffer.alloc(2048, 0x55)]);
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

/* ================================================================ os testes */
(async () => {

console.log('\n[1] ID3v2.3 — o formato mais comum');
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
  ok(t.capa && t.capa.type === 'image/png' && t.capa.size === PNG.length,
     `capa extraida, ${t.capa && t.capa.size} bytes`);
}

console.log('\n[2] ID3v2.4 — tamanho sincro-seguro e UTF-8');
{
  const f = mp3('faixa.mp3', [
    quadro('TIT2', texto(3, 'Construção'), 4),
    quadro('TPE1', texto(3, 'Chico Buarque'), 4),
    quadro('TDRC', texto(3, '1971'), 4),
    quadro('APIC', apic(4), 4),
  ], 4);
  const t = await T.lerEtiquetas(f);
  ok(t.titulo === 'Construção', `titulo em UTF-8: "${t.titulo}"`);
  ok(t.ano === '1971', `ano por TDRC: "${t.ano}"`);
  ok(!!t.capa, 'capa lida do quadro APIC');
}

console.log('\n[3] ID3v2.2 — identificadores de 3 letras');
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

console.log('\n[4] a letra');
{
  const f = mp3('faixa.mp3', [
    quadro('TIT2', texto(3, 'Com letra'), 3),
    quadro('SYLT', sylt([[0, 'Primeira linha'], [4200, 'Segunda linha'], [9000, 'Terceira linha']]), 3),
  ], 3);
  const t = await T.lerEtiquetas(f);
  const L = t.letraSinc;
  ok(L && L.tipo === 'sincronizada', 'SYLT reconhecido como letra com marcacao de tempo');
  ok(L && L.linhas.length === 3, `tres linhas lidas (${L && L.linhas.length})`);
  ok(L && L.linhas[1].texto === 'Segunda linha', `texto da 2a linha: "${L && L.linhas[1].texto}"`);
  ok(L && Math.abs(L.linhas[1].t - 4.2) < 0.001, `tempo da 2a linha: ${L && L.linhas[1].t}s (esperado 4.2)`);

  const g = mp3('faixa.mp3', [
    quadro('TIT2', texto(3, 'Sem tempo'), 3),
    quadro('USLT', uslt(['Uma linha', 'Outra linha', '', 'Mais uma']), 3),
  ], 3);
  const u = (await T.lerEtiquetas(g)).letraTexto;
  ok(u && u.tipo === 'corrida', 'USLT reconhecido como letra sem marcacao');
  ok(u && u.linhas.length === 3, `linhas vazias descartadas (${u && u.linhas.length} de 4)`);

  const h = mp3('faixa.mp3', [quadro('TIT2', texto(3, 'Nada'), 3)], 3);
  const n = await T.lerEtiquetas(h);
  ok(!n.letraSinc && !n.letraTexto, 'arquivo sem letra nao inventa letra');
}

console.log('\n[5] quando nao ha ID3v2');
{
  const t = await T.lerEtiquetas(comID3v1('x.mp3', 'Alegria', 'Caetano', 'Transa'));
  ok(t.titulo === 'Alegria', `cai para o ID3v1: "${t.titulo}"`);

  const semNada = new File([Buffer.alloc(3000, 0x55)], 'minha_musica_favorita.mp3', { type: 'audio/mpeg' });
  const t2 = await T.lerEtiquetas(semNada);
  ok(t2.titulo === 'minha musica favorita', `sem etiqueta, usa o nome: "${t2.titulo}"`);
  ok(t2.artista === 'Artista desconhecido', 'e diz que o artista e desconhecido, em portugues');
}

console.log('\n[6] arquivo torto nao pode derrubar o leitor');
{
  const lixo = new File([Buffer.concat([Buffer.from('ID3', 'latin1'),
    Buffer.from([3, 0, 0]), Buffer.from([0x7f, 0x7f, 0x7f, 0x7f]),
    Buffer.alloc(500, 0xff)])], 'torto.mp3', { type: 'audio/mpeg' });
  let quebrou = false, t = null;
  try { t = await T.lerEtiquetas(lixo); } catch (_) { quebrou = true; }
  ok(!quebrou, 'cabecalho mentindo o tamanho nao lanca excecao');
  ok(t && t.titulo === 'torto', `e ainda devolve algo util: "${t && t.titulo}"`);

  let q2 = false;
  try { await T.lerEtiquetas(new File([], 'vazio.mp3', { type: 'audio/mpeg' })); }
  catch (_) { q2 = true; }
  ok(!q2, 'arquivo de zero byte nao lanca excecao');
}

console.log('\n[7] formatacao de tempo');
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
