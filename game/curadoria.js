/* Curadoria: um exame de cada vez. ← rejeita, → aceita.
   Cada decisão fica gravada no servidor no momento do clique, e ao voltar
   à página retoma-se no primeiro exame ainda sem decisão. */

const el = (id) => document.getElementById(id);

const AMOSTRAS = [
  ["cabeca", "original", "F", "original"],
  ["cabeca", "anon",     "F", "anonimizado"],
  ["cara",   "original", "A", "cara"],
  ["cara",   "anon",     "B", "cara anonimizada"],
];

const state = { exams: [], fila: [], i: 0, historico: [] };

async function api(caminho, opcoes) {
  const res = await fetch(caminho, { cache: "no-store", ...opcoes });
  const corpo = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(corpo.erro || `o servidor respondeu ${res.status}`);
  return corpo;
}

function preload(ex) {
  if (!ex) return;
  AMOSTRAS.forEach(([enq, kind, pose]) => {
    const rel = ex.cards?.[enq]?.[kind]?.[pose];
    if (rel) { const im = new Image(); im.src = `/data/${rel}`; }
  });
}

function show() {
  const total = state.fila.length;
  const rejeitados = state.exams.filter((e) => e.decision === "reject").length;
  const aceites = state.exams.filter((e) => e.decision === "keep").length;

  if (state.i >= total) {
    el("exam").hidden = true;
    document.querySelector(".cur-buttons").hidden = true;
    el("done").hidden = false;
    el("progress").textContent = `${total} de ${total}`;
    el("done-text").textContent = `${aceites} aceites, ${rejeitados} rejeitados. ` +
      `Os rejeitados não entram no jogo.`;
    return;
  }

  el("exam").hidden = false;
  document.querySelector(".cur-buttons").hidden = false;
  el("done").hidden = true;

  const ex = state.fila[state.i];
  el("progress").textContent = `${state.i + 1} de ${total} · ${rejeitados} rejeitados no total`;
  el("exam-id").textContent = ex.id;
  const atual = el("exam-current");
  atual.textContent = ex.decision === "keep" ? "actualmente: aceite"
                    : ex.decision === "reject" ? "actualmente: rejeitado" : "";
  atual.classList.toggle("is-reject", ex.decision === "reject");
  el("imgs").innerHTML = AMOSTRAS.map(([enq, kind, pose, rotulo]) => {
    const rel = ex.cards?.[enq]?.[kind]?.[pose];
    return `<figure><img src="/data/${rel}" alt=""><figcaption>${rotulo}</figcaption></figure>`;
  }).join("");
  el("btn-undo").disabled = state.historico.length === 0;

  preload(state.fila[state.i + 1]);
}

async function decide(decisao) {
  if (state.i >= state.fila.length) return;
  const ex = state.fila[state.i];
  try {
    await api(`/api/decisions/${encodeURIComponent(ex.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: decisao }),
    });
  } catch (err) {
    alert(`Não foi possível guardar: ${err.message}`);
    return;
  }
  ex.decision = decisao;
  state.historico.push(state.i);
  state.i += 1;
  show();
}

function undo() {
  if (!state.historico.length) return;
  state.i = state.historico.pop();
  show();
}

async function load() {
  try {
    const dados = await api("/api/curation");
    state.exams = dados.exams;
  } catch (err) {
    el("imgs").innerHTML = `<p class="saved-note is-error">Não foi possível ler os exames: ${err.message}</p>`;
    return;
  }
  // percorre todos; começa no primeiro sem decisão, ou no resumo se não houver
  state.fila = state.exams;
  const primeiro = state.exams.findIndex((e) => !e.decision);
  state.i = primeiro === -1 ? state.exams.length : primeiro;
  show();
}

el("btn-reject").addEventListener("click", () => decide("reject"));
el("btn-keep").addEventListener("click", () => decide("keep"));
el("btn-undo").addEventListener("click", undo);
el("btn-restart").addEventListener("click", () => {
  state.fila = state.exams; state.i = 0; state.historico = []; show();
});
el("btn-review-kept").addEventListener("click", () => {
  state.fila = state.exams.filter((e) => e.decision === "keep");
  state.i = 0; state.historico = []; show();
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "ArrowLeft")  { ev.preventDefault(); decide("reject"); }
  if (ev.key === "ArrowRight") { ev.preventDefault(); decide("keep"); }
  if (ev.key === "Backspace")  { ev.preventDefault(); undo(); }
});

load();
