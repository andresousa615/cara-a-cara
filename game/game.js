/* ============================================================
   Cara a Cara — lógica do jogo

   As cartas vêm sempre do manifesto, nunca da pasta de imagens.
   O manifesto só contém pacientes com as quatro cartas completas,
   por isso não há maneira de entrar no tabuleiro uma carta sem par.
   ============================================================ */

const GIVE_UP_AFTER  = 60000;                      // ms até oferecer "Desisto"
const WRONG_DELAY    = 1400;                       // ms com as duas cartas à vista

const DEFAULTS = { cards: 24, difficulty: "dificil", framing: "cara" };

/* Pares por ronda. O tabuleiro tem o dobro das cartas. */
const pairs = () => Math.floor((state.settings.cards || DEFAULTS.cards) / 2);

/*
   Cada ronda diz de onde saem as duas cartas de um paciente.

   No dificil as duas cartas estao em poses diferentes, A e B. No facil usam a
   mesma vista frontal F, e na ronda 1 sao literalmente a mesma imagem.
*/
function roundsFor(dificuldade) {
  const facil = dificuldade === "facil";
  return [
    {
      n: 1,
      task: "Encontra os pares",
      title: "Encontra os pares",
      text: "Cada pessoa aparece duas vezes.",
      faces: facil ? [["original", "F"], ["original", "F"]]
                   : [["original", "A"], ["original", "B"]],
      allowGiveUp: false,
    },
    {
      n: 2,
      task: "As caras foram apagadas",
      title: "As caras foram apagadas",
      text: "Cada pessoa continua a aparecer duas vezes.",
      faces: facil ? [["original", "F"], ["anon", "F"]]
                   : [["original", "A"], ["anon", "B"]],
      allowGiveUp: true,
    },
  ];
}

const el = (id) => document.getElementById(id);

const state = {
  manifest: null,
  used: new Set(),      // pacientes já usados, para as rondas não se repetirem
  roundIndex: 0,
  cards: [],
  first: null,
  lock: false,
  matched: 0,
  moves: 0,
  startedAt: 0,
  ticker: null,
  giveUpTimer: null,
  results: [],
  playerName: "",
  settings: { ...DEFAULTS },
  rounds: [],
  scores: [],
  scoresQuery: "",
  scoresSort: { key: "at", dir: "desc" },
};

/* ---------- utilitários ---------- */

const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const fmtTime = (ms) => {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

const showScreen = (id) => {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("is-active"));
  el(id).classList.add("is-active");
};

/* ---------- disposição do tabuleiro ----------
   De todas as grelhas possíveis para n cartas, usa a que dá a carta maior no
   espaço disponível, e fixa o tamanho do tabuleiro em pixéis. Sem isto a caixa
   não tem largura definida e o grid colapsa. */

function layoutBoard(n) {
  const board = el("board");
  const wrap = board.parentElement;
  const W = wrap?.clientWidth || 0;
  const H = wrap?.clientHeight || 0;

  const gap = W ? parseFloat(getComputedStyle(board).columnGap) || 0 : 0;

  let melhor = null;
  for (let cols = 1; cols <= n; cols++) {
    if (n % cols) continue;
    const rows = n / cols;
    // sem medidas ainda: escolher pela forma do ecrã, o pixel vem no resize
    const lado = W && H
      ? Math.min((W - gap * (cols - 1)) / cols, (H - gap * (rows - 1)) / rows)
      : -Math.abs(Math.log((cols / rows) / (16 / 10)));
    if (!melhor || lado > melhor.lado) melhor = { cols, rows, lado };
  }

  board.style?.setProperty("--cols", melhor.cols);
  board.style?.setProperty("--rows", melhor.rows);

  if (W && H && melhor.lado > 0) {
    const lado = Math.floor(melhor.lado);
    board.style.width  = `${lado * melhor.cols + gap * (melhor.cols - 1)}px`;
    board.style.height = `${lado * melhor.rows + gap * (melhor.rows - 1)}px`;
  }
}

/* ---------- manifesto ---------- */

async function loadManifest() {
  const res = await fetch("/data/manifest.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`manifest.json devolveu ${res.status}`);
  const manifest = await res.json();

  // exames rejeitados na curadoria saem inteiros: original e anonimizado
  let rejeitados = new Set();
  try {
    const r = await fetch("/api/excluded", { cache: "no-store" });
    if (r.ok) rejeitados = new Set((await r.json()).excluded || []);
  } catch { /* sem servidor de curadoria, joga-se com todos */ }
  manifest.patients = manifest.patients.filter((p) => !rejeitados.has(p.id));

  // Segunda barreira: só entram pacientes com as quatro cartas declaradas.
  manifest.patients = manifest.patients.filter((p) =>
    ["cabeca", "cara"].every((enq) =>
      ["A", "B", "F"].every((pose) =>
        p.cards?.[enq]?.original?.[pose] && p.cards?.[enq]?.anon?.[pose]))
  );

  if (manifest.patients.length < pairs() * 2) {
    throw new Error(
      `Só há ${manifest.patients.length} exames disponíveis e este tabuleiro ` +
      `precisa de ${pairs() * 2}. Escolhe um tabuleiro mais pequeno nas Definições ` +
      `ou aceita mais exames na curadoria.`
    );
  }
  return manifest;
}

function failToLoad(err) {
  const stack = document.querySelector("#screen-intro .stack");
  stack.innerHTML = `
    <p class="eyebrow">Não arrancou</p>
    <h1 class="display">Falta o servidor</h1>
    <p class="lede">As imagens não foram encontradas: ${err.message}<br><br>
    Abre um terminal na pasta <b>privacy_game</b> e corre
    <b>./.venv/bin/python serve.py</b></p>`;
}

/* ---------- montagem de uma ronda ---------- */

function choosePatients() {
  const livres = state.manifest.patients.filter((p) => !state.used.has(p.id));
  const pool = livres.length >= pairs() ? livres : state.manifest.patients;
  const escolhidos = shuffle(pool).slice(0, pairs());
  escolhidos.forEach((p) => state.used.add(p.id));
  return escolhidos;
}

function buildCards(round) {
  const cards = [];
  const enq = state.settings.framing;
  for (const patient of choosePatients()) {
    for (const [kind, pose] of round.faces) {
      cards.push({
        pid: patient.id,
        src: `/data/${patient.cards[enq][kind][pose]}`,
      });
    }
  }
  return shuffle(cards);
}

function preload(cards) {
  return Promise.all(cards.map((c) => new Promise((resolve) => {
    const img = new Image();
    img.onload = img.onerror = resolve;
    img.src = c.src;
  })));
}

function renderBoard(cards) {
  const board = el("board");
  board.innerHTML = "";
  layoutBoard(cards.length);
  cards.forEach((card, i) => {
    const btn = document.createElement("button");
    btn.className = "card";
    btn.type = "button";
    btn.dataset.index = String(i);
    btn.setAttribute("aria-label", `Carta ${i + 1}`);
    btn.innerHTML = `
      <span class="card-inner">
        <span class="card-face card-back"></span>
        <span class="card-face card-front">
          <img src="${card.src}" alt="">
        </span>
      </span>`;
    btn.addEventListener("click", () => onFlip(i, btn));
    board.appendChild(btn);
    card.node = btn;
  });
}

/* ---------- cronómetro ---------- */

function startClock() {
  state.startedAt = performance.now();
  state.ticker = setInterval(() => {
    el("hud-time").textContent = fmtTime(performance.now() - state.startedAt);
  }, 250);
}

function stopClock() {
  clearInterval(state.ticker);
  clearTimeout(state.giveUpTimer);
  state.ticker = null;
  return state.startedAt ? performance.now() - state.startedAt : 0;
}

/* ---------- jogo ---------- */

function onFlip(index, node) {
  const card = state.cards[index];
  if (state.lock || node.classList.contains("is-up") ||
      node.classList.contains("is-matched")) return;

  if (!state.ticker) startClock();
  node.classList.add("is-up");

  if (!state.first) {
    state.first = { index, node, card };
    return;
  }

  state.moves += 1;
  el("hud-moves").textContent = state.moves;

  const first = state.first;
  state.first = null;

  if (first.card.pid === card.pid) {
    first.node.classList.add("is-matched");
    node.classList.add("is-matched");
    first.node.disabled = node.disabled = true;
    state.matched += 1;
    el("hud-pairs").textContent = `${state.matched}/${pairs()}`;
    if (state.matched === pairs()) setTimeout(() => finishRound(false), 620);
    return;
  }

  state.lock = true;
  first.node.classList.add("is-wrong");
  node.classList.add("is-wrong");
  setTimeout(() => {
    [first.node, node].forEach((n) => n.classList.remove("is-up", "is-wrong"));
    state.lock = false;
  }, WRONG_DELAY);
}

function startRound() {
  const round = state.rounds[state.roundIndex];

  Object.assign(state, {
    cards: buildCards(round),
    first: null, lock: false, matched: 0, moves: 0, startedAt: 0, ticker: null,
  });

  el("hud-round").textContent = `Ronda ${round.n}`;
  el("hud-task").textContent = round.task;
  el("hud-pairs").textContent = `0/${pairs()}`;
  el("hud-moves").textContent = "0";
  el("hud-time").textContent = "0:00";
  el("btn-give-up").hidden = true;
  el("board-note").classList.remove("is-warn");

  el("board").innerHTML = "";
  showScreen("screen-board");
  el("board-note").textContent = "A preparar as cartas…";

  preload(state.cards).then(() => {
    el("board-note").textContent = "";
    renderBoard(state.cards);
    if (round.allowGiveUp) {
      state.giveUpTimer = setTimeout(() => {
        el("btn-give-up").hidden = false;
        el("board-note").textContent = "Desistir também é um resultado.";
        el("board-note").classList.add("is-warn");
      }, GIVE_UP_AFTER);
    }
  });
}

function finishRound(gaveUp) {
  const ms = stopClock();
  state.results[state.roundIndex] = {
    ms, moves: state.moves, matched: state.matched, gaveUp,
  };

  if (state.roundIndex === 0) {
    el("mid-time").textContent = fmtTime(ms);
    showScreen("screen-mid");
  } else {
    showResults();
  }
}

function showResults() {
  const [r1, r2] = state.results;

  el("score-time-1").textContent = fmtTime(r1.ms);
  el("score-moves-1").textContent = `${r1.moves} tentativas`;
  el("score-time-2").textContent = fmtTime(r2.ms);
  el("score-moves-2").textContent = r2.gaveUp
    ? `desististe com ${r2.matched} de ${pairs()}`
    : `${r2.moves} tentativas`;

  const ratio = r1.ms > 0 ? r2.ms / r1.ms : 0;
  let verdict;
  if (r2.gaveUp) {
    verdict = "A informação de que precisavas já não está nas imagens.";
  } else if (ratio >= 1.6) {
    verdict = `Demoraste ${ratio.toFixed(1)} vezes mais. Eram as mesmas pessoas.`;
  } else {
    verdict = "Conseguiste, mas repara nas tentativas: acertar por sorte não é reconhecer.";
  }
  el("verdict").textContent = verdict;

  showScreen("screen-results");
  saveResult();
}

/* ---------- navegação ---------- */

function showBrief() {
  const round = state.rounds[state.roundIndex];
  el("brief-round").textContent = `Ronda ${round.n}`;
  el("brief-title").textContent = round.title;
  el("brief-text").textContent = round.text;
  showScreen("screen-brief");
}

/* Limpa tudo o que pertence a um jogo. Corre em cada "Começar", venha o
   jogador de onde vier — do ecrã final, do registo de resultados, ou de um
   jogo deixado a meio. Sem isto, quem passasse pelos resultados voltava a
   entrar na ronda 2 com o resultado da ronda 1 do jogo anterior. */
function novoJogo() {
  state.roundIndex = 0;
  state.results = [];
  state.used.clear();
  state.cards = [];
  state.first = null;
  state.lock = false;
  state.dev = false;
  stopClock();
  state.startedAt = 0;
}

function resetGame() {
  novoJogo();
  el("player-name").value = "";
  el("saved-note").textContent = "";
  showScreen("screen-intro");
  el("player-name").focus?.();
}

el("btn-start").addEventListener("click", () => {
  novoJogo();
  state.playerName = (el("player-name").value || "").trim();
  state.rounds = roundsFor(state.settings.difficulty);
  showBrief();
});
el("btn-play").addEventListener("click", startRound);
el("btn-next").addEventListener("click", () => {
  state.roundIndex = 1;
  showBrief();
});
el("btn-again").addEventListener("click", resetGame);
el("btn-give-up").addEventListener("click", () => {
  state.lock = true;
  finishRound(true);
});

window.addEventListener("resize", () => {
  if (state.cards.length) layoutBoard(state.cards.length);
});

/* ============================================================
   Registo de resultados

   Os resultados vivem em scores.json, do lado do servidor, e nao no browser:
   sobrevivem a mudancas de codigo, a limpezas do navegador e a trocas de
   aparelho. Esta parte so fala com a API.
   ============================================================ */

const API = "/api/scores";

const fmtWhen = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const dia = d.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit" });
  const hora = d.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
  return `${dia} ${hora}`;
};

async function api(caminho, opcoes) {
  const res = await fetch(caminho, { cache: "no-store", ...opcoes });
  const corpo = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(corpo.erro || `o servidor respondeu ${res.status}`);
  return corpo;
}

async function saveResult() {
  const [r1, r2] = state.results;
  const nota = el("saved-note");
  if (state.dev) { nota.textContent = "Modo de teste: não gravado."; return; }
  nota.classList.remove("is-error");
  nota.textContent = "A guardar…";
  try {
    const guardado = await api(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: state.playerName,
        pairs: pairs(),
        r1: { ms: Math.round(r1.ms), moves: r1.moves },
        r2: { ms: Math.round(r2.ms), moves: r2.moves,
              gaveUp: r2.gaveUp, matched: r2.matched },
      }),
    });
    nota.textContent = `Guardado como ${guardado.name}.`;
  } catch (err) {
    nota.classList.add("is-error");
    nota.textContent = `Não foi possível guardar: ${err.message}`;
  }
}

function scoreRow(s) {
  const tr = document.createElement("tr");
  tr.dataset.id = s.id;

  const r1 = s.r1 || {};
  const r2 = s.r2 || {};
  const razao = r1.ms > 0 && r2.ms > 0 ? (r2.ms / r1.ms).toFixed(1) : null;
  const razaoMoves = r1.moves > 0 && r2.moves > 0 ? (r2.moves / r1.moves).toFixed(1) : null;

  const movesLabel = (n) => `${n ?? 0} tentativa${n === 1 ? "" : "s"}`;

  const primeira = `${fmtTime(r1.ms || 0)}<span class="cell-sub">${movesLabel(r1.moves)}</span>`;
  const segunda = r2.gaveUp
    ? `<span class="cell-gaveup">desistiu</span><span class="cell-sub">${movesLabel(r2.moves)}</span>`
    : `${fmtTime(r2.ms || 0)}<span class="cell-sub">${movesLabel(r2.moves)}</span>`;
  const terceira = r2.gaveUp
    ? `<span class="cell-gaveup">${r2.matched ?? 0}/${s.pairs || "?"} pares</span>`
    : (razao ? `<span class="cell-ratio">${razao}×</span>` : "—");
  const quarta = razaoMoves ? `<span class="cell-ratio">${razaoMoves}×</span>` : "—";

  tr.innerHTML = `
    <td class="cell-name">${escapeHtml(s.name)}</td>
    <td class="num">${primeira}</td>
    <td class="num">${segunda}</td>
    <td class="num">${terceira}</td>
    <td class="num">${quarta}</td>
    <td class="cell-when">${fmtWhen(s.at)}</td>
    <td class="cell-actions">
      <button class="icon-btn" data-action="edit">Editar</button>
      <button class="icon-btn danger" data-action="delete">Apagar</button>
    </td>`;
  return tr;
}

const escapeHtml = (txt) => String(txt ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

/* Critérios de ordenação do registo. `dirInicial` é o sentido que faz sentido
   à primeira: tempos e tentativas do menor para o maior (o melhor primeiro),
   data e diferença do maior para o menor. Clicar no mesmo critério inverte. */
const SORTS = {
  at:      { label: "Mais recente",  dirInicial: "desc", valor: (s) => String(s.at || "") },
  r1ms:    { label: "Tempo R1",      dirInicial: "asc",  valor: (s) => s.r1?.ms },
  r2ms:    { label: "Tempo R2",      dirInicial: "asc",  valor: (s) => s.r2?.ms },
  r1moves: { label: "Tentativas R1", dirInicial: "asc",  valor: (s) => s.r1?.moves },
  r2moves: { label: "Tentativas R2", dirInicial: "asc",  valor: (s) => s.r2?.moves },
  ratio:   { label: "Diferença de tempo",       dirInicial: "desc",
             valor: (s) => (s.r1?.ms > 0 && s.r2?.ms > 0 ? s.r2.ms / s.r1.ms : undefined) },
  ratioMoves: { label: "Diferença de tentativas", dirInicial: "desc",
             valor: (s) => (s.r1?.moves > 0 && s.r2?.moves > 0 ? s.r2.moves / s.r1.moves : undefined) },
};

const semValor = (v) =>
  v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v));

function renderScores() {
  const body = el("scores-body");
  const vazio = el("scores-empty");
  const tabela = el("scores-table-wrap");

  const procura = state.scoresQuery.trim();
  const q = procura.toLowerCase();
  const lista = state.scores.filter(
    (s) => !q || String(s.name || "").toLowerCase().includes(q));

  const { key, dir } = state.scoresSort;
  const cfg = SORTS[key] || SORTS.at;
  lista.sort((a, b) => {
    const va = cfg.valor(a);
    const vb = cfg.valor(b);
    // quem não tem o valor vai sempre para o fim, em qualquer sentido
    if (semValor(va) && semValor(vb)) return 0;
    if (semValor(va)) return 1;
    if (semValor(vb)) return -1;
    const cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
    return dir === "asc" ? cmp : -cmp;
  });

  body.innerHTML = "";
  lista.forEach((s) => body.appendChild(scoreRow(s)));

  tabela.hidden = lista.length === 0;
  vazio.hidden = lista.length > 0;
  vazio.textContent = state.scores.length === 0
    ? "Ainda não há resultados guardados."
    : `Nenhum resultado com «${procura}».`;

  document.querySelectorAll("#scores-sort .option").forEach((b) => {
    const activo = b.dataset.sort === key;
    b.classList.toggle("is-on", activo);
    const seta = activo ? (dir === "asc" ? " ↑" : " ↓") : "";
    b.querySelector(".option-main").textContent = SORTS[b.dataset.sort].label + seta;
  });
}

async function showScores() {
  showScreen("screen-scores");
  el("scores-body").innerHTML = "";

  try {
    state.scores = await api(API);
  } catch (err) {
    el("scores-empty").hidden = false;
    el("scores-empty").textContent = `Não foi possível ler os resultados: ${err.message}`;
    el("scores-table-wrap").hidden = true;
    return;
  }
  renderScores();
}

/* Editar o nome no proprio sitio: Enter guarda, Escape desiste. */
function startEditing(tr) {
  const cel = tr.querySelector(".cell-name");
  if (cel.querySelector("input")) return;
  const original = cel.textContent;

  const input = document.createElement("input");
  input.className = "name-input";
  input.value = original;
  input.maxLength = 40;
  cel.textContent = "";
  cel.appendChild(input);
  input.focus();
  input.select();

  let terminado = false;
  const fechar = (texto) => { terminado = true; cel.textContent = texto; };

  const guardar = async () => {
    if (terminado) return;
    const novo = input.value.trim();
    if (!novo || novo === original) return fechar(original);
    fechar(novo);
    try {
      await api(`${API}/${tr.dataset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: novo }),
      });
      const alvo = state.scores.find((s) => s.id === tr.dataset.id);
      if (alvo) alvo.name = novo;
    } catch (err) {
      cel.textContent = original;
      alert(`Não foi possível mudar o nome: ${err.message}`);
    }
  };

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); guardar(); }
    if (ev.key === "Escape") fechar(original);
  });
  input.addEventListener("blur", guardar);
}

async function deleteScore(tr) {
  const nome = tr.querySelector(".cell-name").textContent;
  if (!confirm(`Apagar o resultado de ${nome}?`)) return;
  try {
    await api(`${API}/${tr.dataset.id}`, { method: "DELETE" });
    state.scores = state.scores.filter((s) => s.id !== tr.dataset.id);
    renderScores();
  } catch (err) {
    alert(`Não foi possível apagar: ${err.message}`);
  }
}

async function clearAllScores() {
  // Conta sobre a lista inteira, não sobre as linhas visíveis: com um filtro
  // activo, apagar tudo apaga mesmo tudo, e a pergunta tem de o dizer.
  const total = state.scores.length;
  if (!total) return;
  const filtrados = el("scores-body").children.length;
  const aviso = filtrados < total
    ? `Apagar os ${total} resultados, incluindo os ${total - filtrados} que o filtro está a esconder? Isto não se desfaz.`
    : `Apagar os ${total} resultados? Isto não se desfaz.`;
  if (!confirm(aviso)) return;
  try {
    await api(API, { method: "DELETE" });
    state.scores = [];
    renderScores();
  } catch (err) {
    alert(`Não foi possível limpar: ${err.message}`);
  }
}

el("scores-body").addEventListener("click", (ev) => {
  const botao = ev.target.closest?.("[data-action]");
  if (!botao) return;
  const tr = botao.closest("tr");
  if (botao.dataset.action === "edit") startEditing(tr);
  if (botao.dataset.action === "delete") deleteScore(tr);
});

el("scores-search").addEventListener("input", (ev) => {
  state.scoresQuery = ev.target.value;
  renderScores();
});

el("scores-sort").addEventListener("click", (ev) => {
  const b = ev.target.closest?.(".option");
  if (!b) return;
  const key = b.dataset.sort;
  state.scoresSort = state.scoresSort.key === key
    ? { key, dir: state.scoresSort.dir === "asc" ? "desc" : "asc" }
    : { key, dir: SORTS[key].dirInicial };
  renderScores();
});

el("btn-scores").addEventListener("click", showScores);
el("btn-see-scores").addEventListener("click", showScores);
el("btn-scores-back").addEventListener("click", () => showScreen("screen-intro"));
el("btn-clear-all").addEventListener("click", clearAllScores);

/* ============================================================
   Definições

   Ficam em settings.json, do lado do servidor, como os resultados: o PC e o
   tablet jogam com a mesma configuração. Mudar uma opção guarda logo.
   ============================================================ */

const API_SETTINGS = "/api/settings";

/* Nome da grelha para um dado numero de cartas. A orientacao real e escolhida
   em layoutBoard() conforme o ecra; isto e so a etiqueta. */
const GRELHAS = { 12: "3×4", 16: "4×4", 20: "4×5", 24: "4×6", 30: "5×6", 36: "6×6" };

const ENQUADRAMENTOS = {
  cara: {
    nome: "Só a cara",
    sub: "Fecha sobre o rosto. O contorno da cabeça sai do enquadramento.",
  },
  cabeca: {
    nome: "Cabeça inteira",
    sub: "Mostra a cabeça toda, contorno incluído.",
  },
};

const DIFICULDADES = {
  facil: {
    nome: "Fácil",
    sub: "Todos de frente. Na ronda 1 as duas cartas do par são a mesma imagem.",
  },
  dificil: {
    nome: "Difícil",
    sub: "Cada carta do par vista de um ângulo diferente.",
  },
};

function optionButton({ valor, principal, sub, ligado }) {
  const b = document.createElement("button");
  b.className = "option" + (ligado ? " is-on" : "");
  b.type = "button";
  b.dataset.value = String(valor);
  b.setAttribute("role", "radio");
  b.setAttribute("aria-checked", ligado ? "true" : "false");
  b.innerHTML = `<span class="option-main">${principal}</span>` +
                (sub ? `<span class="option-sub">${sub}</span>` : "");
  return b;
}

function renderSettings(opcoesCartas) {
  const cartas = el("opt-cards");
  cartas.innerHTML = "";
  opcoesCartas.forEach((n) => cartas.appendChild(optionButton({
    valor: n,
    principal: GRELHAS[n] || `${n}`,
    sub: `${n / 2} pares`,
    ligado: n === state.settings.cards,
  })));

  const dific = el("opt-difficulty");
  dific.innerHTML = "";
  Object.entries(DIFICULDADES).forEach(([chave, d]) => dific.appendChild(optionButton({
    valor: chave,
    principal: d.nome,
    sub: d.sub,
    ligado: chave === state.settings.difficulty,
  })));

  const enq = el("opt-framing");
  enq.innerHTML = "";
  Object.entries(ENQUADRAMENTOS).forEach(([chave, e]) => enq.appendChild(optionButton({
    valor: chave,
    principal: e.nome,
    sub: e.sub,
    ligado: chave === state.settings.framing,
  })));
}

async function loadSettings() {
  try {
    const cfg = await api(API_SETTINGS);
    if (Object.prototype.hasOwnProperty.call(GRELHAS, cfg.cards)) {
      state.settings.cards = cfg.cards;
    }
    if (DIFICULDADES[cfg.difficulty]) state.settings.difficulty = cfg.difficulty;
    if (ENQUADRAMENTOS[cfg.framing]) state.settings.framing = cfg.framing;
    return cfg.options?.cards || Object.keys(GRELHAS).map(Number);
  } catch {
    // Sem servidor de definicoes o jogo corre na configuracao por omissao.
    return Object.keys(GRELHAS).map(Number);
  }
}

async function saveSettings(mudanca) {
  const nota = el("settings-note");
  nota.classList.remove("is-error");
  nota.textContent = "A guardar…";
  try {
    const cfg = await api(API_SETTINGS, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mudanca),
    });
    state.settings.cards = cfg.cards;
    state.settings.difficulty = cfg.difficulty;
    state.settings.framing = cfg.framing;
    nota.textContent = `${GRELHAS[cfg.cards]}, ${DIFICULDADES[cfg.difficulty].nome.toLowerCase()}, ` +
                       `${ENQUADRAMENTOS[cfg.framing].nome.toLowerCase()}.`;
  } catch (err) {
    nota.classList.add("is-error");
    nota.textContent = `Não foi possível guardar: ${err.message}`;
  }
  renderSettings(state.opcoesCartas);
}

async function showSettings() {
  state.opcoesCartas = await loadSettings();
  renderSettings(state.opcoesCartas);
  el("settings-note").textContent = "";
  showScreen("screen-settings");
}

el("opt-cards").addEventListener("click", (ev) => {
  const b = ev.target.closest?.(".option");
  if (b) saveSettings({ cards: Number(b.dataset.value) });
});

el("opt-difficulty").addEventListener("click", (ev) => {
  const b = ev.target.closest?.(".option");
  if (b) saveSettings({ difficulty: b.dataset.value });
});

el("opt-framing").addEventListener("click", (ev) => {
  const b = ev.target.closest?.(".option");
  if (b) saveSettings({ framing: b.dataset.value });
});

el("btn-settings").addEventListener("click", showSettings);
el("btn-settings-back").addEventListener("click", () => showScreen("screen-intro"));

/* Atalhos de desenvolvimento: abrir a página com #tabuleiro, #fim, #resultados
   ou #definicoes salta directamente para esse ecrã, para se fotografar. */
function devJump() {
  const alvo = (location.hash || "").slice(1);
  if (!alvo) return;
  state.dev = true;
  if (alvo === "tabuleiro") {
    state.playerName = "Teste";
    state.rounds = roundsFor(state.settings.difficulty);
    state.roundIndex = 0;
    startRound();
  } else if (alvo === "fim") {
    state.results = [
      { ms: 41000, moves: 22, matched: pairs(), gaveUp: false },
      { ms: 133000, moves: 58, matched: pairs(), gaveUp: false },
    ];
    state.playerName = "Teste";
    showResults();
  } else if (alvo === "resultados") {
    showScores();
  } else if (alvo === "definicoes") {
    showSettings();
  }
}

loadSettings()
  .then((opcoes) => { state.opcoesCartas = opcoes; return loadManifest(); })
  .then((m) => { state.manifest = m; devJump(); })
  .catch(failToLoad);
