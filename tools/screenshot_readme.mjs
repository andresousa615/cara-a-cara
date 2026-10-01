// Builds docs/ronda2.png, the README picture of round 2.
//
// The README must never show a real original face. This script plays the real
// game in a headless browser, turns a few cards face up, and pixelates every
// original card INSIDE the page before the screenshot is taken, so the
// original pixels never reach the file. Anonymised cards stay visible: they
// are the same images published in assets/anon/.
//
// Needs the game running with a built data/ folder:
//   python3 serve.py &
//   node tools/screenshot_readme.mjs [http://127.0.0.1:8000] [docs/ronda2.png]
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openBrowser } from "./browser.mjs";

const base = process.argv[2] || "http://127.0.0.1:8000";
const dst = process.argv[3] || "docs/ronda2.png";
const BLOCKS = 6;   // an original card is reduced to 6×6 blocks

const b = await openBrowser({ width: 1100, height: 720 });
try {
  await b.goto(base + "/", 2500);

  // round 2, 6 pairs, easy difficulty, whole-head framing; test mode saves nothing
  await b.eval(`(async () => {
    for (let i = 0; i < 50 && !state.manifest; i++) await new Promise(r => setTimeout(r, 100));
    if (!state.manifest) throw new Error("manifest not loaded — is data/ built?");
    state.dev = true;
    state.settings = { cards: 12, difficulty: "facil", framing: "cabeca" };
    state.rounds = roundsFor("facil");
    state.roundIndex = 1;
    startRound();
    for (let i = 0; i < 100 && !document.querySelector("#board .card"); i++)
      await new Promise(r => setTimeout(r, 100));
    return true;
  })()`);
  await b.sleep(800);

  const resumo = await b.eval(`(async () => {
    const isOrig = (c) => c.src.includes("_original_");
    const cards = state.cards;
    // one matched pair, plus one more original and one more anonymised card
    const orig = cards.find(isOrig);
    const par = cards.find(c => c.pid === orig.pid && c !== orig);
    const outroO = cards.find(c => isOrig(c) && c.pid !== orig.pid);
    const outroA = cards.find(c => !isOrig(c) && c.pid !== orig.pid && c.pid !== outroO.pid);
    orig.node.classList.add("is-matched"); par.node.classList.add("is-matched");
    outroO.node.classList.add("is-up"); outroA.node.classList.add("is-up");

    // pixelate every original card in the DOM, face up or not
    const pixelate = (img) => new Promise((resolve) => {
      const go = () => {
        const small = document.createElement("canvas");
        small.width = small.height = ${BLOCKS};
        small.getContext("2d").drawImage(img, 0, 0, ${BLOCKS}, ${BLOCKS});
        const big = document.createElement("canvas");
        big.width = big.height = 400;
        const g = big.getContext("2d");
        g.imageSmoothingEnabled = false;
        g.drawImage(small, 0, 0, 400, 400);
        img.onload = () => resolve(true);
        img.src = big.toDataURL("image/png");
      };
      img.complete && img.naturalWidth ? go() : (img.onload = go);
    });
    const origImgs = [...document.querySelectorAll("#board .card img")]
      .filter(img => img.src.includes("_original_"));
    await Promise.all(origImgs.map(pixelate));

    const leftovers = [...document.querySelectorAll("#board img")]
      .filter(img => img.src.includes("_original_")).length;
    return { pixelated: origImgs.length, leftovers };
  })()`);

  if (resumo.leftovers !== 0) throw new Error("an original card was not pixelated; refusing to save");
  await b.sleep(700);   // let the flip animation finish

  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, await b.screenshot());
  console.log(`${dst}  (${resumo.pixelated} original cards pixelated)`);
} finally {
  await b.close();
}
