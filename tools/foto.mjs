// Screenshot of any game screen with an emulated viewport.
//   node tools/foto.mjs "http://127.0.0.1:8000/#tabuleiro" 390 844 out.png
// Shortcuts #tabuleiro, #fim, #resultados and #definicoes open that screen in
// test mode (nothing is saved).
import { writeFileSync } from "node:fs";
import { openBrowser } from "./browser.mjs";

const [, , url, w = "1440", h = "900", dst = "screenshot.png"] = process.argv;
if (!url) { console.error("usage: node tools/foto.mjs URL [width] [height] [out.png]"); process.exit(1); }

const b = await openBrowser({ width: +w, height: +h });
try {
  await b.goto(url);
  writeFileSync(dst, await b.screenshot());
  console.log(dst);
} finally {
  await b.close();
}
