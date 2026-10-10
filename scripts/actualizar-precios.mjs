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
    const vi = l.indexOf("variants:[");
    if (id && vi >= 0) {   // variantes (otros colores) que tienen su propio link
      let k = 0;
      for (const m of l.slice(vi).matchAll(/\{n:"([^"]+)",img:IMG\.\w+(?:,url:"([^"]+)")?/g)) {
        if (m[2]) out.push({ id: `${id}-v${k}`, url: m[2], titulo: `${titulo.replace(/\\"/g, '"')} (${m[1]})` });
        k++;
      }
    }
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
      const can = (t.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) || t.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i) || [])[1];
      if (can) { const ids = extraerIds(can); if (ids.item || ids.producto) return { url: can, ...ids }; }
      const suelto = t.match(/\b(MLA)-?(\d{9,10})\b/);
      if (suelto) return { url: actual, item: "MLA" + suelto[2], producto: null };
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

async function precioPorWeb(id) {
  const num = String(id).replace(/\D/g, "");
  const r = await fetch(`https://articulo.mercadolibre.com.ar/MLA-${num}`, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", "accept-language": "es-AR,es;q=0.9", accept: "text/html" } });
  if (!r.ok) throw new Error("la página de la publicación respondió " + r.status);
  const t = await r.text();
  let price = 0, nombre = (t.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || [])[1] || "";
  for (const b of t.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(b[1]); const lista = Array.isArray(j) ? j : [j];
      for (const o of lista) { const of = Array.isArray(o.offers) ? o.offers[0] : o.offers; if (of && +(of.price || of.lowPrice) > 0) { price = +(of.price || of.lowPrice); nombre = nombre || o.name || ""; break; } }
    } catch {}
    if (price) break;
  }
  if (!price) { const m = t.match(/<meta[^>]+itemprop=["']price["'][^>]+content=["']([\d.]+)["']/i); if (m) price = +m[1]; }
  if (!(price > 0)) throw new Error("no encontré el precio en la página de la publicación");
  const o = t.match(/"original_price"\s*:\s*(\d+(?:\.\d+)?)/);
  return { price, old: o && +o[1] > price ? +o[1] : 0, nombre, via: "página de la publicación" };
}

async function precioDeItem(id, tk) {
  try { return await precioDeItemApi(id, tk); }
  catch (e) {
    try { return await precioPorWeb(id); }
    catch (e2) { throw new Error(e.message.slice(0, 100) + " | web: " + e2.message); }
  }
}

async function precioDeItemApi(id, tk) {
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

const PARADA = new Set("para con los las del una uno que por sin hasta mas como pero este esta sus muy entre".split(" "));
const palabras = t => new Set(String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !PARADA.has(w)));
const coinciden = (a, b) => { const A = palabras(a), B = palabras(b); let n = 0; for (const w of A) if (B.has(w)) n++; return n; };

async function precioDeProducto(pid, tk) {
  const pr = await api(`/products/${pid}`, tk), w = pr.buy_box_winner || {}, nombre = pr.name || "";
  if (w.item_id) { const r = await precioDeItem(w.item_id, tk); return { ...r, nombre, via: "ganadora" }; }
  if (+w.price > 0) return { price: +w.price, old: +w.original_price > +w.price ? +w.original_price : 0, nombre, via: "ganadora" };
  const intentos = []; let muestra = "";
  try {   // publicaciones del producto de catálogo
    const li = await api(`/products/${pid}/items`, tk);
    const arr = Array.isArray(li) ? li : (li.results || li.items || []);
    muestra = arr[0] ? JSON.stringify(arr[0]).slice(0, 260) : "";
    intentos.push("lista:" + arr.length);
    const nuevos = arr.filter(x => +x.price > 0 && (!x.condition || x.condition === "new"));
    if (nuevos.length) {
      const m = nuevos.reduce((a, b) => (+b.price < +a.price ? b : a));
      return { price: +m.price, old: +m.original_price > +m.price ? +m.original_price : 0, nombre, via: "lista de publicaciones (la más barata)", desde: true };
    }
    let mejor = null, primerError = "";
    for (const x of arr.slice(0, 5)) {
      const id = x.item_id || x.id; if (!id) continue;
      try { const r = await precioDeItem(id, tk); if (!mejor || r.price < mejor.price) mejor = r; } catch (e) { primerError = primerError || e.message.slice(0, 110); }
    }
    if (mejor) return { ...mejor, nombre, via: "publicaciones del producto" };
    if (primerError) intentos.push("publicación: " + primerError);
  } catch (e) { intentos.push("lista: " + e.message.slice(0, 110)); }
  try {   // búsqueda pública por producto
    const se = await api(`/sites/MLA/search?product_id=${pid}&sort=price_asc&limit=5`, tk);
    const rs = se.results || [];
    if (rs.length && +rs[0].price > 0) return { price: +rs[0].price, old: +rs[0].original_price > +rs[0].price ? +rs[0].original_price : 0, nombre, via: "búsqueda" };
    intentos.push("búsqueda:" + rs.length);
  } catch (e) { intentos.push("búsqueda: " + (e.message.match(/respondió (\d+)/) || [, "error"])[1]); }
  const err = new Error("sin precio disponible (" + intentos.join("; ") + ")");
  err.diag = { producto: pid, nombre_en_ML: nombre, claves_de_producto: Object.keys(pr).slice(0, 12).join(","), ejemplo_de_publicacion: muestra };
  throw err;
}

async function main() {
  if (!ID || !SECRET) { console.error("Faltan ML_CLIENT_ID y ML_CLIENT_SECRET (se cargan en Settings > Secrets and variables > Actions)."); process.exit(1); }
  const productos = leerProductos();
  console.log(`Productos con link de afiliado: ${productos.length}`);
  const tk = await token();
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { items: {} };
  const items = { ...(prev.items || {}) };
  const ahora = new Date().toISOString();
  let ok = 0, diags = 0; const fallos = [], filas = [];
  for (const p of productos) {
    items[p.id] = items[p.id] || { titulo: p.titulo, price: 0, old: 0 };
    items[p.id].titulo = p.titulo;
    let finalUrl = p.url;
    try {
      const r = await resolver(p.url);
      finalUrl = r.url || p.url;
      if (r.error) throw new Error(r.error);
      const res = r.item ? await precioDeItem(r.item, tk) : await precioDeProducto(r.producto, tk);
      if (res.nombre && coinciden(p.titulo, res.nombre) < 1) throw new Error(`parece otro producto: en Mercado Libre se llama "${res.nombre.slice(0, 70)}"`);
      items[p.id].price = res.price; items[p.id].old = res.old; items[p.id].updated = ahora;
      if (res.desde) items[p.id].desde = true; else delete items[p.id].desde;
      filas.push(`| ${p.id} | ${p.titulo.slice(0, 55)} | ${(res.nombre || "").slice(0, 60)} | ${res.nombre ? coinciden(p.titulo, res.nombre) : "-"} | ${res.price} | ${res.old || ""} | ${res.desde ? "desde" : "exacto"} |`);
      if (res.nombre) items[p.id].ml = res.nombre.slice(0, 90);
      ok++;
      console.log(`OK   #${p.id} ${p.titulo.slice(0, 40)} -> $${res.price}${res.old ? " (antes $" + res.old + ")" : ""}${res.nombre ? " | ML: " + res.nombre.slice(0, 50) : ""}${res.via ? " | vía " + res.via : ""}`);
    } catch (e) {
      fallos.push(p);
      filas.push(`| ${p.id} | ${p.titulo.slice(0, 55)} | SIN PRECIO: ${e.message.slice(0, 90).replace(/\|/g, "/")} | | | | |`);
      console.log(`FALLÓ #${p.id} ${p.titulo.slice(0, 40)} | ${e.message} | ${p.url}`);
      if (diags < 4) { diags++; console.log(`   DIAGNÓSTICO #${p.id}: link final = ${finalUrl}` + (e.diag ? " | respuesta de /products = " + JSON.stringify(e.diag) : "")); }
    }
    await sleep(350);
  }
  console.log(`\nResumen: ${ok} con precio, ${fallos.length} sin poder actualizar (se conserva el precio anterior).`);
  if (!ok) { console.error("No se pudo actualizar ningún producto: no toco precios.json."); process.exit(1); }
  const ordenado = Object.fromEntries(Object.entries(items).sort((a, b) => parseInt(a[0]) - parseInt(b[0]) || a[0].localeCompare(b[0])));
  if (!DRY) {
    fs.writeFileSync(OUT, JSON.stringify({ updated: ahora, items: ordenado }, null, 1) + "\n");
    fs.writeFileSync(process.env.REVISION_FILE || "revision-precios.md", "# Revisión de precios\n\n| id | nuestro producto | nombre en Mercado Libre | coincidencias | precio | antes | tipo |\n|---|---|---|---|---|---|---|\n" + filas.join("\n") + "\n");
  }
  else console.log("(modo --dry: no se guardó nada)");
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
