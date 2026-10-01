# -*- coding: utf-8 -*-
"""
Servidor local do jogo Cara a Cara.

Serve a pasta game/ na raiz, a pasta data/ em /data/, e uma pequena API para
o registo de resultados, as definicoes e a curadoria. So usa a biblioteca
padrao do Python.

    python3 serve.py            # so nesta maquina
    python3 serve.py --lan      # tambem para tablets na mesma rede

Por omissao escuta apenas em 127.0.0.1. As cartas originais sao caras de
pessoas reais (IXI): abrir isto a rede e uma decisao a tomar de proposito, com
a flag --lan, e so numa rede de confianca.

Resultados, definicoes e curadoria ficam em state/ (ou em CARA_STATE_DIR).
Nao estao dentro de data/, que e regenerada pelo setup, nem dependem do
browser.
"""

import argparse
import json
import os
import pathlib
import socket
import threading
import uuid
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE      = os.path.dirname(os.path.abspath(__file__))
GAME_DIR  = os.path.join(BASE, "game")
DATA_DIR  = os.path.join(BASE, "data")

# Os ficheiros de estado ficam em state/, salvo se CARA_STATE_DIR disser outra
# coisa. No Docker aponta para um volume.
STATE_DIR = os.environ.get("CARA_STATE_DIR") or os.path.join(BASE, "state")
SCORES    = os.path.join(STATE_DIR, "scores.json")
SETTINGS  = os.path.join(STATE_DIR, "settings.json")
DECISIONS = os.path.join(STATE_DIR, "decisions.json")
IN_DOCKER = os.environ.get("CARA_DOCKER") == "1"

_lock = threading.Lock()

# Numero de cartas por ronda que a aba de configuracoes oferece. Tem de ser par,
# senao nao se formam pares, e o dobro tem de caber nos pacientes disponiveis.
CARTAS_VALIDAS = (12, 16, 20, 24, 30, 36)
DIFICULDADES   = ("facil", "dificil")
ENQUADRAMENTOS = ("cabeca", "cara")
POR_OMISSAO    = {"cards": 24, "difficulty": "dificil", "framing": "cara"}


# ---------- persistencia dos resultados ----------

def load_scores():
    if not os.path.isfile(SCORES):
        return []
    try:
        with open(SCORES, encoding="utf-8") as fh:
            dados = json.load(fh)
        return dados if isinstance(dados, list) else []
    except (json.JSONDecodeError, OSError):
        # Um ficheiro ilegivel nao pode apagar o historico sem deixar rasto.
        estragado = SCORES + ".corrompido"
        try:
            os.replace(SCORES, estragado)
            print("scores.json ilegivel; guardado em {}".format(estragado))
        except OSError:
            pass
        return []


def save_scores(scores):
    """Escrita atomica: grava ao lado e so depois substitui."""
    tmp = SCORES + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(scores, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, SCORES)


def novo_resultado(payload):
    return {
        "id": uuid.uuid4().hex[:12],
        "name": (payload.get("name") or "Anónimo").strip()[:40] or "Anónimo",
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pairs": int(payload.get("pairs") or 0),
        "r1": payload.get("r1") or {},
        "r2": payload.get("r2") or {},
    }


def load_settings():
    """Le as configuracoes, corrigindo qualquer valor que nao sirva."""
    cfg = dict(POR_OMISSAO)
    try:
        with open(SETTINGS, encoding="utf-8") as fh:
            guardado = json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return cfg
    if isinstance(guardado, dict):
        if guardado.get("cards") in CARTAS_VALIDAS:
            cfg["cards"] = guardado["cards"]
        if guardado.get("difficulty") in DIFICULDADES:
            cfg["difficulty"] = guardado["difficulty"]
        if guardado.get("framing") in ENQUADRAMENTOS:
            cfg["framing"] = guardado["framing"]
    return cfg


def load_decisions():
    """{id do exame: "keep" | "reject"}, decidido na curadoria."""
    dados = load_json(DECISIONS, {})
    return {k: v for k, v in dados.items() if v in ("keep", "reject")} \
        if isinstance(dados, dict) else {}


def save_decisions(dec):
    tmp = DECISIONS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(dec, fh, indent=1, sort_keys=True)
    os.replace(tmp, DECISIONS)


def rejected_ids():
    return sorted(k for k, v in load_decisions().items() if v == "reject")


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def save_settings(cfg):
    tmp = SETTINGS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, SETTINGS)


class Handler(SimpleHTTPRequestHandler):
    """Ficheiros do jogo, cartas em /data/ e a API em /api/scores."""

    # ---------- ficheiros ----------

    def translate_path(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/data/"):
            rel, root = clean[len("/data/"):], DATA_DIR
        else:
            rel, root = clean.lstrip("/") or "index.html", GAME_DIR
        full = os.path.normpath(os.path.join(root, *rel.split("/")))
        if not full.startswith(root):
            return root
        return full

    def end_headers(self):
        # O codigo do jogo muda com frequencia e nunca deve ficar em cache; as
        # cartas em /data/ sao grandes e imutaveis entre renderizacoes, e essas
        # o browser pode guardar.
        limpo = self.path.split("?", 1)[0]
        if not limpo.startswith("/data/cards/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "404" in (fmt % args):
            super().log_message(fmt, *args)

    # ---------- utilitarios da API ----------

    def _json(self, obj, status=200):
        corpo = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def _body(self):
        tamanho = int(self.headers.get("Content-Length") or 0)
        if not tamanho:
            return {}
        try:
            return json.loads(self.rfile.read(tamanho).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def _score_id(self):
        """Devolve o id em /api/scores/<id>, ou None se o caminho for a coleccao."""
        resto = self.path[len("/api/scores"):].split("?", 1)[0].strip("/")
        return resto or None

    # ---------- verbos ----------

    def _serve_index(self, ficheiro="index.html"):
        """Entrega uma pagina com ?v=<mtime> no CSS e no JS. Cada alteracao a
        esses ficheiros muda o URL, e o browser nunca reutiliza a copia antiga."""
        html = pathlib.Path(GAME_DIR, ficheiro).read_text(encoding="utf-8")
        for nome in ("style.css", "game.js", "curadoria.js"):
            try:
                v = int(os.path.getmtime(os.path.join(GAME_DIR, nome)))
            except OSError:
                v = 0
            html = html.replace('"{}"'.format(nome), '"{}?v={}"'.format(nome, v))
        corpo = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def do_GET(self):
        caminho = self.path.split("?", 1)[0].rstrip("/")
        if caminho in ("", "/index.html"):
            return self._serve_index()
        if caminho == "/curadoria.html":
            return self._serve_index("curadoria.html")
        if caminho == "/api/scores":
            with _lock:
                return self._json(load_scores())
        if caminho == "/api/excluded":
            with _lock:
                return self._json({"excluded": rejected_ids()})
        if caminho == "/api/curation":
            manifest = load_json(os.path.join(DATA_DIR, "manifest.json"), {"patients": []})
            noise = load_json(os.path.join(DATA_DIR, "noise.json"), {})
            with _lock:
                dec = load_decisions()
            exames = [{
                "id": p["id"],
                "cards": p["cards"],
                "noise": noise.get(p["id"]),
                "decision": dec.get(p["id"]),
            } for p in manifest.get("patients", [])]
            return self._json({"exams": exames})
        if caminho == "/api/settings":
            with _lock:
                cfg = load_settings()
            cfg["options"] = {"cards": list(CARTAS_VALIDAS),
                              "difficulties": list(DIFICULDADES),
                              "framings": list(ENQUADRAMENTOS)}
            return self._json(cfg)
        return super().do_GET()

    def do_PUT(self):
        caminho = self.path.split("?", 1)[0].rstrip("/")
        if caminho.startswith("/api/decisions/"):
            exam_id = caminho[len("/api/decisions/"):]
            decisao = self._body().get("decision")
            if not exam_id or decisao not in ("keep", "reject", None):
                return self._json({"erro": "decisão inválida"}, 400)
            with _lock:
                dec = load_decisions()
                if decisao is None:
                    dec.pop(exam_id, None)
                else:
                    dec[exam_id] = decisao
                save_decisions(dec)
            return self._json({"id": exam_id, "decision": decisao})
        if caminho != "/api/settings":
            return self._json({"erro": "caminho desconhecido"}, 404)
        pedido = self._body()
        cartas = pedido.get("cards")
        dific  = pedido.get("difficulty")
        enq    = pedido.get("framing")
        if cartas is not None and cartas not in CARTAS_VALIDAS:
            return self._json({"erro": "número de cartas inválido"}, 400)
        if dific is not None and dific not in DIFICULDADES:
            return self._json({"erro": "dificuldade inválida"}, 400)
        if enq is not None and enq not in ENQUADRAMENTOS:
            return self._json({"erro": "enquadramento inválido"}, 400)
        with _lock:
            cfg = load_settings()
            if cartas is not None:
                cfg["cards"] = cartas
            if dific is not None:
                cfg["difficulty"] = dific
            if enq is not None:
                cfg["framing"] = enq
            save_settings(cfg)
        return self._json(cfg)

    def do_POST(self):
        if self.path.rstrip("/") != "/api/scores":
            return self._json({"erro": "caminho desconhecido"}, 404)
        registo = novo_resultado(self._body())
        with _lock:
            scores = load_scores()
            scores.append(registo)
            save_scores(scores)
        return self._json(registo, 201)

    def do_PATCH(self):
        if not self.path.startswith("/api/scores"):
            return self._json({"erro": "caminho desconhecido"}, 404)
        alvo = self._score_id()
        if not alvo:
            return self._json({"erro": "falta o id"}, 400)
        novo_nome = (self._body().get("name") or "").strip()[:40]
        if not novo_nome:
            return self._json({"erro": "o nome não pode ficar vazio"}, 400)
        with _lock:
            scores = load_scores()
            for s in scores:
                if s["id"] == alvo:
                    s["name"] = novo_nome
                    save_scores(scores)
                    return self._json(s)
        return self._json({"erro": "resultado não encontrado"}, 404)

    def do_DELETE(self):
        if not self.path.startswith("/api/scores"):
            return self._json({"erro": "caminho desconhecido"}, 404)
        alvo = self._score_id()
        with _lock:
            scores = load_scores()
            if alvo is None:                       # apagar tudo
                save_scores([])
                return self._json({"apagados": len(scores)})
            restantes = [s for s in scores if s["id"] != alvo]
            if len(restantes) == len(scores):
                return self._json({"erro": "resultado não encontrado"}, 404)
            save_scores(restantes)
        return self._json({"apagados": 1})


def lan_ip():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return None
    finally:
        sock.close()


def main():
    ap = argparse.ArgumentParser(description="Servidor local do jogo.")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--lan", action="store_true",
                    help="aceitar ligacoes de outros aparelhos na mesma rede")
    args = ap.parse_args()

    if not os.path.isfile(os.path.join(DATA_DIR, "manifest.json")):
        print("Sem manifesto em data/. Corre primeiro:  ./setup.sh")
        return 1

    os.makedirs(STATE_DIR, exist_ok=True)
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    httpd = ThreadingHTTPServer((host, args.port), partial(Handler, directory=GAME_DIR))

    print("Cara a Cara")
    if IN_DOCKER:
        # dentro do contentor o IP nao e o do computador; quem manda e o -p
        print("  a correr dentro do Docker; o endereco e o do computador")
        print("  anfitriao, na porta que foi mapeada com -p")
    else:
        print("  http://127.0.0.1:{}".format(args.port))
        if args.lan:
            ip = lan_ip()
            if ip:
                print("  http://{}:{}   (tablets na mesma rede)".format(ip, args.port))
            print("  aberto a rede local: as cartas sao caras de doentes reais")
    cfg = load_settings()
    print("  estado em {} ({} resultados guardados)".format(STATE_DIR, len(load_scores())))
    print("  configuracao: {} cartas, {}, enquadramento {}".format(
        cfg["cards"], cfg["difficulty"], cfg["framing"]))
    print("  exames rejeitados na curadoria: {}".format(len(rejected_ids())))
    if IN_DOCKER:
        print("  curadoria em /curadoria.html no mesmo endereco")
    else:
        print("  curadoria em http://127.0.0.1:{}/curadoria.html".format(args.port))
    print("Ctrl+C para parar.")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nParado.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
