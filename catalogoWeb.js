// Catálogo de la tienda web (cintecsa.cl, Jumpseller): nombre, SKU, marca, categoría y
// DESCRIPCIÓN de cada producto, leídos de las fichas públicas (datos schema.org que
// la propia tienda publica). Sirve para que el bot recomiende por necesidad
// ("toallitas húmedas para limpiar el escritorio") y no solo por nombre exacto.
//
// - Se lee del sitemap + cada ficha, con pocas conexiones a la vez (no sobrecargar la tienda).
// - Se guarda en un archivo junto al log de cotizaciones y se refresca cada 24 h.
// - Los PRECIOS nunca salen de aquí: siempre del catálogo oficial (Google Sheets / SQL).
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const SITIO = process.env.TIENDA_URL || "https://www.cintecsa.cl";
const REFRESCO = 24 * 60 * 60 * 1000;
const UA = "CINTEC-Bot/1.0 (asistente de cotizaciones)";

let productos = [];       // [{ sku, nombre, marca, categoria, descripcion, url }]
let actualizado = 0;
let cargando = null;
let archivo = null;

function normalizar(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ").replace(/\s+/g, " ").trim();
}

function skuClave(sku) { return String(sku || "").trim().replace(/^0+/, "").toLowerCase(); }

function limpiarHtml(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").replace(/\s*Ficha t[ée]cnica\s*$/i, "").trim();
}

function extraerFicha(html, url) {
  const bloques = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  let prod = null, categoria = "";
  for (const b of bloques) {
    let j;
    try { j = JSON.parse(b[1]); } catch { continue; }
    for (const n of (Array.isArray(j) ? j : [j])) {
      if (n["@type"] === "Product") prod = n;
      if (n["@type"] === "BreadcrumbList") {
        const nombres = (n.itemListElement || []).map(e => e.item?.name).filter(Boolean);
        categoria = nombres.slice(2, -1).join(" > "); // sin "Inicio", "VER TODOS" ni el producto
      }
    }
  }
  if (!prod?.sku || !prod?.name) return null;
  return {
    sku: String(prod.sku).trim(),
    nombre: String(prod.name).trim(),
    marca: (typeof prod.brand === "object" ? prod.brand?.name : prod.brand) || "",
    categoria,
    descripcion: limpiarHtml(prod.description).slice(0, 600),
    url: prod.url || url,
  };
}

async function leerSitio() {
  const { data: xml } = await axios.get(`${SITIO}/sitemap.xml`, { headers: { "User-Agent": UA }, timeout: 20000 });
  const urls = [...String(xml).matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim())
    .filter(u => u.startsWith(SITIO) && !/\/(ver-todos|contact|nosotros|politica|terminos|blog|customer|cart|search)(\/|$)/.test(u) && u !== SITIO && u !== `${SITIO}/`);
  const encontrados = [];
  let i = 0;
  const trabajador = async () => {
    while (i < urls.length) {
      const url = urls[i++];
      try {
        const { data } = await axios.get(url, { headers: { "User-Agent": UA }, timeout: 20000 });
        const f = extraerFicha(String(data), url);
        if (f) encontrados.push(f);
      } catch { /* una ficha caída no frena el resto */ }
      await new Promise(r => setTimeout(r, 150));
    }
  };
  await Promise.all([trabajador(), trabajador(), trabajador()]);
  return encontrados;
}

async function refrescar() {
  if (cargando) return cargando;
  cargando = (async () => {
    try {
      const nuevos = await leerSitio();
      if (nuevos.length >= 20) { // si la tienda respondió mal, se conserva lo anterior
        productos = nuevos;
        actualizado = Date.now();
        try { fs.writeFileSync(archivo, JSON.stringify({ actualizado, productos })); } catch {}
        console.log(`🛒 Catálogo web: ${productos.length} fichas con descripción leídas de ${SITIO}`);
      } else {
        console.warn(`⚠️ Catálogo web: solo ${nuevos.length} fichas leídas, se mantiene la versión anterior`);
      }
    } catch (err) {
      console.warn("⚠️ Catálogo web: no se pudo leer la tienda:", err.message);
    } finally { cargando = null; }
  })();
  return cargando;
}

function iniciar(dirDatos) {
  archivo = path.join(dirDatos || ".", "catalogo-web.json");
  try {
    const g = JSON.parse(fs.readFileSync(archivo, "utf8"));
    productos = g.productos || []; actualizado = g.actualizado || 0;
    console.log(`🛒 Catálogo web: ${productos.length} fichas desde archivo`);
  } catch {}
  if (Date.now() - actualizado > REFRESCO) refrescar();
  setInterval(() => { if (Date.now() - actualizado > REFRESCO) refrescar(); }, 60 * 60 * 1000);
}

// Raíz simple para comparar singular/plural/diminutivo: "toallitas" ~ "toalla", "humedas" ~ "humeda"
function raiz(w) {
  return w.replace(/(itas|itos|ita|ito)$/, "").replace(/(es|s)$/, "").replace(/[aeo]$/, "");
}
const VACIAS = new Set("para que con sin una uno unos unas los las del de la el en por algo necesito quiero busco tengo como mas muy tipo producto productos cosa limpiar limpieza".split(" "));

// Candidatos por coincidencia de palabras en nombre (pesa más), categoría y descripción
function candidatos(consulta, max = 25) {
  const palabras = normalizar(consulta).split(" ").filter(w => w.length > 2 && !VACIAS.has(w) && !/^\d+$/.test(w));
  if (!palabras.length || !productos.length) return [];
  const raices = palabras.map(raiz).filter(r => r.length >= 3);
  return productos.map(p => {
    const nom = normalizar(p.nombre), cat = normalizar(p.categoria), des = normalizar(p.descripcion);
    let puntos = 0;
    for (const r of raices) {
      if (nom.includes(r)) puntos += 3;
      if (cat.includes(r)) puntos += 2;
      if (des.includes(r)) puntos += 1;
    }
    return { p, puntos };
  }).filter(x => x.puntos > 0).sort((a, b) => b.puntos - a.puntos).slice(0, max).map(x => x.p);
}

// La IA elige, SOLO entre productos reales de la tienda, los que sirven para la necesidad.
// Devuelve fichas (con sku) en orden de relevancia; [] si ninguna sirve.
async function recomendar(anthropicClient, necesidad, maxResultados = 4) {
  const lista = candidatos(necesidad);
  if (!lista.length || !anthropicClient) return lista.slice(0, maxResultados);
  try {
    const r = await anthropicClient.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 60,
      system:
        "Eres el buscador de productos de CINTEC (higiene y limpieza). Recibes la necesidad de un cliente y una lista " +
        "numerada de productos REALES de la tienda con su descripción. Elige solo los que realmente sirven para esa necesidad, " +
        `del más al menos adecuado, máximo ${maxResultados}. Responde SOLO los números separados por coma (ej: 3,1). ` +
        "Si ninguno sirve, responde: ninguno. Nunca agregues texto.",
      messages: [{
        role: "user",
        content: `Necesidad: ${String(necesidad).slice(0, 200)}\n\nProductos:\n` +
          lista.map((p, i) => `${i + 1}. ${p.nombre} [${p.categoria}] — ${p.descripcion.slice(0, 220)}`).join("\n"),
      }],
    });
    const txt = (r.content[0]?.text || "").toLowerCase();
    if (/ninguno/.test(txt)) return [];
    const idx = [...new Set((txt.match(/\d+/g) || []).map(n => parseInt(n, 10) - 1))]
      .filter(n => n >= 0 && n < lista.length);
    return idx.slice(0, maxResultados).map(n => lista[n]);
  } catch (err) {
    console.error("Catálogo web: error recomendando:", err.message);
    return lista.slice(0, maxResultados);
  }
}

// Texto corto con descripciones para dar contexto a la IA de consultas
function contexto(consulta, max = 6) {
  return candidatos(consulta, max).map(p => `${p.nombre}: ${p.descripcion.slice(0, 160)}`).join(" | ");
}

function porSku(sku) { const k = skuClave(sku); return productos.find(p => skuClave(p.sku) === k) || null; }

module.exports = { iniciar, refrescar, recomendar, candidatos, contexto, porSku, skuClave, extraerFicha,
  get total() { return productos.length; } };
