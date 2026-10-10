// Robot de precios de Nexo Market.
// Lee los links de afiliado que están en index.html, busca el precio actual (y el descuento) de cada
// publicación en la API oficial de Mercado Libre y escribe todo en precios.json.
// Uso:  node scripts/actualizar-precios.mjs          (actualiza precios.json)
//       node scripts/actualizar-precios.mjs --dry    (solo muestra lo que encontró, sin guardar)
import fs from "node:fs";

const ID = process.env.ML_CLIENT_ID, SECRET = process.env.ML_CLIENT_SECRET;
const HTML = process.env.HTML_FILE || "index.html", OUT = process.env.PRECIOS_FILE || "precios.json";
const DRY = process.argv.includes("--dry");
const UA = "Mozilla/5.0 (compatible; NexoMarketPrecios/1.0)";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function leerProductos() {
  const html = fs.readFileSync(HTML, "utf8");
  const i = html.indexOf("const PRODUCTS=[");
  if (i < 0) throw new Error("No encontré la lista de productos en " + HTML);
  const bloque = html.slice(i, html.indexOf("\n];", i));
  const out = [];
  for (const l of bloque.split("\n")) {
    if (!l.startsWith("{id:")) continue;
    const id = (l.match(/^\{id:(\d+),/) || [])[1];
    const url = (l.match(/,url:"([^"]+)"/) || [])[1];
    const titulo = (l.match(/title:"((?:[^"\\]|\\.)*)"/) || [])[1] || "";
    if (id && url) out.push({ id, url, titulo: titulo.replace(/\\"/g, '"') });
  }
  return out;
}

function extraerIds(u) {
  let d = u; try { d = decodeURIComponent(u); } catch {}
  const m = d.match(/(?:item_id[:=]|wid=)(MLA)-?(\d{6,})/i) || d.match(/\/(MLA)-?(\d{8,})-/i) || d.match(/(?:articulo|produto)\.mercadolibre\.com\.ar\/(MLA)-?(\d{6,})/i);
  const p = d.match(/\/p\/(MLA\d+)/i);
  return { item: m ? "MLA" + m[2] : null, producto: p ? p[1].toUpperCase() : null };
}

async function resolver(url) {
  let actual = url;
  for (let n = 0; n < 8; n++) {
    let r;
    try { r = await fetch(actual, { redirect: "manual", headers: { "user-agent": UA, "accept-language": "es-AR,es;q=0.9" } }); }
    catch (e) { return { url: actual, error: "no pude abrir el link: " + e.message }; }
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) {
      actual = new URL(loc, actual).toString();
      const ids = extraerIds(actual);
      if (ids.item || ids.producto) return { url: actual, ...ids };
      continue;
    }
    // Sin más redirecciones: último intento, buscar el ID dentro de la página
    if (r.ok) {
      const t = await r.text();
      const it = t.match(/"item_id"\s*:\s*"(MLA\d+)"/) || t.match(/item_id[:=](MLA\d+)/);
      const pr = t.match(/\/p\/(MLA\d+)/);
      if (it || pr) return { url: actual, item: it ? it[1] : null, producto: pr ? pr[1] : null };
    }
    return { url: actual, error: "el link terminó en una página sin ID de publicación (estado " + r.status + ")" };
  }
  return { url: actual, error: "demasiadas redirecciones" };
}

async function token() {
  const r = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: ID, client_secret: SECRET })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("No pude obtener el token de Mercado Libre: " + JSON.stringify(j));
  return j.access_token;
}

async function api(path, tk) {
  const r = await fetch("https://api.mercadolibre.com" + path, { headers: { authorization: "Bearer " + tk, accept: "application/json" } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} respondió ${r.status}: ${t.slice(0, 120)}`);
  return JSON.parse(t);
}

async function precioDeItem(id, tk) {
  let price = 0, old = 0;
  try {
    const s = await api(`/items/${id}/sale_price?context=channel_marketplace`, tk);
    if (s && +s.amount > 0) { price = +s.amount; if (+s.regular_amount > price) old = +s.regular_amount; }
  } catch {}
  if (!price) {
    const it = await api(`/items/${id}`, tk);
    if (it.status && it.status !== "active") throw new Error("la publicación no está activa (" + it.status + ")");
    price = +it.price; if (+it.original_price > price) old = +it.original_price;
  }
  if (!(price > 0)) throw new Error("no encontré un precio válido");
  return { price, old };
}

async function precioDeProducto(pid, tk) {
  const pr = await api(`/products/${pid}`, tk), w = pr.buy_box_winner || {};
  if (w.item_id) return precioDeItem(w.item_id, tk);
  if (+w.price > 0) return { price: +w.price, old: +w.original_price > +w.price ? +w.original_price : 0 };
  throw new Error("el producto no tiene una publicación ganadora");
}

async function main() {
  if (!ID || !SECRET) { console.error("Faltan ML_CLIENT_ID y ML_CLIENT_SECRET (se cargan en Settings > Secrets and variables > Actions)."); process.exit(1); }
  const productos = leerProductos();
  console.log(`Productos con link de afiliado: ${productos.length}`);
  const tk = await token();
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { items: {} };
  const items = { ...(prev.items || {}) };
  const ahora = new Date().toISOString();
  let ok = 0; const fallos = [];
  for (const p of productos) {
    items[p.id] = items[p.id] || { titulo: p.titulo, price: 0, old: 0 };
    items[p.id].titulo = p.titulo;
    try {
      const r = await resolver(p.url);
      if (r.error) throw new Error(r.error);
      const res = r.item ? await precioDeItem(r.item, tk) : await precioDeProducto(r.producto, tk);
      items[p.id].price = res.price; items[p.id].old = res.old; items[p.id].updated = ahora;
      ok++;
      console.log(`OK   #${p.id} ${p.titulo.slice(0, 40)} -> $${res.price}${res.old ? " (antes $" + res.old + ")" : ""}`);
    } catch (e) {
      fallos.push(p);
      console.log(`FALLÓ #${p.id} ${p.titulo.slice(0, 40)} | ${e.message} | ${p.url}`);
    }
    await sleep(350);
  }
  console.log(`\nResumen: ${ok} con precio, ${fallos.length} sin poder actualizar (se conserva el precio anterior).`);
  if (!ok) { console.error("No se pudo actualizar ningún producto: no toco precios.json."); process.exit(1); }
  const ordenado = Object.fromEntries(Object.entries(items).sort((a, b) => a[0] - b[0]));
  if (!DRY) fs.writeFileSync(OUT, JSON.stringify({ updated: ahora, items: ordenado }, null, 1) + "\n");
  else console.log("(modo --dry: no se guardó nada)");
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
