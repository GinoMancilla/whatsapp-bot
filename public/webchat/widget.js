/*!
 * Chat web CINTEC — burbuja de cotización conectada al mismo motor del bot de WhatsApp.
 * Instalación (tema Jumpseller, antes de </body>):
 *   <script src="https://<servidor-del-bot>/webchat/widget.js" defer></script>
 * Opcionales en el <script>: data-api="https://..." (por defecto, el mismo servidor
 * del que se cargó el script), data-color="#ed0914", data-titulo="CINTEC".
 * Sin dependencias. Todo vive dentro de un Shadow DOM para no chocar con el tema.
 */
(function () {
  "use strict";
  if (window.__cintecChat) return;
  window.__cintecChat = true;

  var script = document.currentScript || (function () {
    var s = document.getElementsByTagName("script");
    return s[s.length - 1];
  })();
  var API = (script.getAttribute("data-api") || new URL(script.src, location.href).origin).replace(/\/+$/, "");
  var COLOR = script.getAttribute("data-color") || "#ed0914";
  var TITULO = script.getAttribute("data-titulo") || "CINTEC";
  var TTL = 30 * 60 * 1000; // igual que la sesión del bot
  var KEY = "cintec-chat-v1";

  // ── Estado persistente por visitante (sobrevive a cambiar de página en la tienda)
  function leer() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || "null");
      if (s && Date.now() - s.ts < TTL) return s;
    } catch (e) {}
    return null;
  }
  function guardar() {
    estado.ts = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify(estado)); } catch (e) {}
  }
  function nuevoId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
  }
  var estado = leer() || { id: nuevoId(), mensajes: [], abierto: false, iniciado: false, ts: Date.now() };

  // ── Producto de la página actual (ficha de Jumpseller): og:type=product
  function productoActual() {
    var tipo = document.querySelector('meta[property="og:type"]');
    if (!tipo || !/product/i.test(tipo.content || "")) return null;
    var t = document.querySelector('meta[property="og:title"]');
    var h1 = document.querySelector("h1");
    var nombre = (t && t.content) || (h1 && h1.textContent) || "";
    nombre = nombre.replace(/\s*[|–-]\s*CINTEC.*$/i, "").trim();
    return nombre ? { nombre: nombre, url: location.href.split("#")[0] } : null;
  }

  // ── Estilos (en el Shadow DOM)
  var css = [
    ":host{all:initial}",
    "*{box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif}",
    "[hidden]{display:none!important}",
    ".fab{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;background:var(--c);color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);display:grid;place-items:center;transition:transform .15s}",
    ".fab:hover{transform:scale(1.06)}",
    ".fab:focus-visible,.btn:focus-visible,.chip:focus-visible,.send:focus-visible,textarea:focus-visible{outline:3px solid #1d6fe0;outline-offset:2px}",
    ".fab svg{width:28px;height:28px}",
    ".badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;border-radius:10px;background:#111;color:#fff;font-size:12px;font-weight:700;display:none;place-items:center;padding:0 5px}",
    ".teaser{position:fixed;right:90px;bottom:30px;z-index:2147483000;background:#fff;color:#1b1f24;border-radius:14px 14px 4px 14px;padding:10px 14px;font-size:14px;line-height:1.35;box-shadow:0 6px 20px rgba(0,0,0,.18);max-width:230px;cursor:pointer}",
    ".teaser b{color:var(--c)}",
    ".panel{position:fixed;right:20px;bottom:92px;z-index:2147483001;width:370px;height:min(600px,calc(100vh - 120px));background:#f4f2f0;border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;transform-origin:bottom right;animation:in .18s ease-out}",
    "@keyframes in{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:none}}",
    "@media (prefers-reduced-motion:reduce){.panel{animation:none}.fab{transition:none}.dot{animation:none!important}}",
    "@media (max-width:480px){.panel{right:0;bottom:0;width:100vw;height:100dvh;border-radius:0}.teaser{display:none}.fab.abierto{display:none}}",
    ".head{background:var(--c);color:#fff;padding:14px 14px 12px 16px;display:flex;align-items:center;gap:10px}",
    ".avatar{width:38px;height:38px;border-radius:50%;background:#fff;color:var(--c);display:grid;place-items:center;font-weight:900;font-size:18px;flex:none}",
    ".who{flex:1;min-width:0}",
    ".who strong{display:block;font-size:15px}",
    ".who span{font-size:12px;opacity:.9}",
    ".who span::before{content:'';display:inline-block;width:7px;height:7px;border-radius:50%;background:#7CFC9A;margin-right:5px;vertical-align:1px}",
    ".btn{background:transparent;border:0;color:#fff;cursor:pointer;padding:6px;border-radius:8px;display:grid;place-items:center}",
    ".btn:hover{background:rgba(255,255,255,.15)}",
    ".btn svg{width:20px;height:20px}",
    ".log{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:8px}",
    ".msg{max-width:84%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;color:#1b1f24}",
    ".bot{align-self:flex-start;background:#fff;border-bottom-left-radius:4px;box-shadow:0 1px 1px rgba(0,0,0,.06)}",
    ".yo{align-self:flex-end;background:var(--c);color:#fff;border-bottom-right-radius:4px}",
    ".msg a{color:inherit;text-decoration:underline}",
    ".file{display:inline-flex;align-items:center;gap:8px;margin-top:2px;padding:8px 12px;border-radius:10px;background:#fff3f3;color:#8a0610!important;text-decoration:none!important;font-weight:600;border:1px solid #f4c7ca}",
    ".typing{align-self:flex-start;background:#fff;border-radius:14px;padding:12px 14px;display:flex;gap:4px}",
    ".dot{width:7px;height:7px;border-radius:50%;background:#9aa0a6;animation:b 1.2s infinite}",
    ".dot:nth-child(2){animation-delay:.15s}.dot:nth-child(3){animation-delay:.3s}",
    "@keyframes b{0%,60%,100%{transform:none;opacity:.5}30%{transform:translateY(-4px);opacity:1}}",
    ".chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 12px 8px}",
    ".chip{border:1.5px solid var(--c);background:#fff;color:var(--c);border-radius:999px;padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer;text-align:left}",
    ".chip:hover{background:var(--c);color:#fff}",
    ".chip.prod{background:var(--c);color:#fff}",
    ".foot{display:flex;gap:8px;padding:10px;background:#fff;border-top:1px solid #e6e2de;align-items:flex-end}",
    "textarea{flex:1;resize:none;border:1px solid #d9d4cf;border-radius:20px;padding:9px 14px;font-size:14px;line-height:1.35;max-height:110px;color:#1b1f24;background:#fff}",
    ".send{width:40px;height:40px;border-radius:50%;border:0;background:var(--c);color:#fff;cursor:pointer;display:grid;place-items:center;flex:none}",
    ".send:disabled{opacity:.45;cursor:default}",
    ".send svg{width:18px;height:18px}",
    ".legal{font-size:11px;color:#6b6560;text-align:center;padding:0 12px 8px;background:#fff}",
    ".legal a{color:inherit}"
  ].join("\n");

  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm3 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var ICON_RESET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 20.5l18-8.5L3 3.5l.01 6.6L15 12 3.01 13.9z"/></svg>';

  // ── Montaje
  var host = document.createElement("div");
  host.id = "cintec-chat";
  var root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    "<style>" + css + "</style>" +
    '<div class="teaser" hidden>👋 ¿Necesitas una <b>cotización</b>? Te la armo en minutos.</div>' +
    '<button class="fab" aria-label="Abrir chat de cotizaciones">' + ICON_CHAT + '<span class="badge"></span></button>' +
    '<section class="panel" role="dialog" aria-label="Chat de cotizaciones ' + esc(TITULO) + '" hidden>' +
      '<header class="head"><div class="avatar">' + esc(TITULO.slice(0, 1)) + '</div>' +
        '<div class="who"><strong>' + esc(TITULO) + '</strong><span>Asistente de cotizaciones</span></div>' +
        '<button class="btn reset" title="Empezar de nuevo" aria-label="Empezar de nuevo">' + ICON_RESET + '</button>' +
        '<button class="btn close" title="Cerrar" aria-label="Cerrar chat">' + ICON_X + '</button></header>' +
      '<div class="log" aria-live="polite"></div>' +
      '<div class="chips"></div>' +
      '<form class="foot"><textarea rows="1" placeholder="Escribe tu mensaje…" aria-label="Mensaje" maxlength="1000"></textarea>' +
        '<button class="send" type="submit" aria-label="Enviar">' + ICON_SEND + '</button></form>' +
      '<div class="legal">Al chatear aceptas la <a href="' + API + '/privacidad" target="_blank" rel="noopener">política de privacidad</a>.</div>' +
    '</section>';
  host.style.setProperty("--c", COLOR);
  root.host.style.setProperty("--c", COLOR);

  var $ = function (s) { return root.querySelector(s); };
  var fab = $(".fab"), panel = $(".panel"), log = $(".log"), chips = $(".chips");
  var form = $(".foot"), input = $("textarea"), send = $(".send"), badge = $(".badge"), teaser = $(".teaser");
  var enviando = false, noLeidos = 0, pollTimer = null;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Formato de WhatsApp → HTML (*negrita*, _cursiva_, ~tachado~, links)
  function formato(t) {
    var h = esc(t);
    h = h.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    h = h.replace(/(^|[\s(>])\*([^*\n]+)\*(?=[\s).,:;!?<]|$)/g, "$1<b>$2</b>");
    h = h.replace(/(^|[\s(>])_([^_\n]+)_(?=[\s).,:;!?<]|$)/g, "$1<i>$2</i>");
    h = h.replace(/(^|[\s(>])~([^~\n]+)~(?=[\s).,:;!?<]|$)/g, "$1<s>$2</s>");
    return h;
  }

  function pintar(m) {
    var el;
    if (m.tipo === "archivo") {
      el = document.createElement("div");
      el.className = "msg bot";
      var a = document.createElement("a");
      a.className = "file";
      a.href = /^https?:/.test(m.url) ? m.url : API + m.url;
      a.target = "_blank"; a.rel = "noopener";
      a.textContent = "📄 Descargar " + (m.nombre || "archivo");
      el.appendChild(a);
    } else {
      el = document.createElement("div");
      el.className = "msg " + (m.de === "yo" ? "yo" : "bot");
      el.innerHTML = formato(m.texto || "");
    }
    log.appendChild(el);
  }

  function bajar() { log.scrollTop = log.scrollHeight; }

  // Opciones numeradas del bot ("*1.* 📦 Cotizar productos") → botones
  function pintarChips() {
    chips.innerHTML = "";
    var ultimo = null;
    for (var i = estado.mensajes.length - 1; i >= 0; i--) {
      if (estado.mensajes[i].de !== "yo" && estado.mensajes[i].tipo !== "archivo") { ultimo = estado.mensajes[i]; break; }
      if (estado.mensajes[i].de === "yo") break;
    }
    var opciones = [];
    if (ultimo) {
      (ultimo.texto || "").split("\n").forEach(function (linea) {
        var m = linea.match(/^\s*\*(\d{1,2})\.\*\s+(.+)$/);
        if (m) opciones.push({ valor: m[1], etiqueta: m[1] + ". " + m[2].replace(/[*_~]/g, "") });
      });
      if (/escribe \*todos\*/i.test(ultimo.texto || "")) opciones.push({ valor: "todos", etiqueta: "Todos" });
      if (!opciones.length && /\*s[ií]\*/i.test(ultimo.texto || "") && /\*no\*/i.test(ultimo.texto || "")) {
        opciones.push({ valor: "sí", etiqueta: "Sí" }, { valor: "no", etiqueta: "No" });
      }
    }
    var prod = productoActual();
    if (prod && !estado.productoOfrecido) {
      opciones.unshift({ valor: "__prod", etiqueta: "📦 Cotizar este producto", prod: true });
    }
    opciones.slice(0, 8).forEach(function (o) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (o.prod ? " prod" : "");
      b.textContent = o.etiqueta;
      b.addEventListener("click", function () {
        if (o.valor === "__prod") {
          estado.productoOfrecido = true;
          enviar("Me gustaría saber más sobre este producto.: " + prod.nombre + " - " + prod.url, "Quiero cotizar: " + prod.nombre);
        } else {
          enviar(o.valor, o.etiqueta);
        }
      });
      chips.appendChild(b);
    });
  }

  function agregar(lista) {
    lista.forEach(function (m) {
      var item = m.tipo === "archivo" ? { de: "bot", tipo: "archivo", nombre: m.nombre, url: m.url } : { de: "bot", texto: m.texto };
      estado.mensajes.push(item);
      pintar(item);
    });
    if (estado.mensajes.length > 120) estado.mensajes = estado.mensajes.slice(-120);
    if (lista.length && panel.hidden) { noLeidos += lista.length; mostrarBadge(); }
    guardar(); pintarChips(); bajar();
  }

  function mostrarBadge() {
    badge.textContent = noLeidos > 9 ? "9+" : String(noLeidos);
    badge.style.display = noLeidos ? "grid" : "none";
  }

  var typingEl = null;
  function escribiendo(on) {
    if (on && !typingEl) {
      typingEl = document.createElement("div");
      typingEl.className = "typing";
      typingEl.setAttribute("aria-label", "El asistente está escribiendo");
      typingEl.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
      log.appendChild(typingEl); bajar();
    } else if (!on && typingEl) { typingEl.remove(); typingEl = null; }
  }

  function enviar(texto, visible) {
    texto = (texto || "").trim();
    if (!texto || enviando) return;
    if (visible !== null) {
      var mio = { de: "yo", texto: visible || texto };
      estado.mensajes.push(mio); pintar(mio);
    }
    estado.iniciado = true;
    guardar(); chips.innerHTML = ""; bajar();
    enviando = true; send.disabled = true; escribiendo(true);
    fetch(API + "/api/web-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: estado.id, text: texto })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || "Error " + r.status);
        return j;
      });
    }).then(function (j) {
      escribiendo(false);
      agregar(j.mensajes || []);
    }).catch(function (e) {
      escribiendo(false);
      agregar([{ texto: "⚠️ " + (e.message && e.message.length < 120 ? e.message : "No pude conectarme. Revisa tu conexión e intenta de nuevo.") }]);
    }).then(function () {
      enviando = false; send.disabled = false;
      if (!panel.hidden) input.focus();
    });
  }

  function poll() {
    if (!estado.iniciado || enviando || document.hidden) return;
    fetch(API + "/api/web-chat/poll?sessionId=" + encodeURIComponent(estado.id))
      .then(function (r) { return r.ok ? r.json() : { mensajes: [] }; })
      .then(function (j) { if (j.mensajes && j.mensajes.length) agregar(j.mensajes); })
      .catch(function () {});
  }

  function abrir() {
    panel.hidden = false; teaser.hidden = true; estado.abierto = true;
    fab.innerHTML = ICON_X; fab.classList.add("abierto"); fab.setAttribute("aria-label", "Cerrar chat");
    noLeidos = 0; guardar(); bajar(); pintarChips();
    if (!estado.iniciado) enviar("hola", null); // saludo real del bot, sin burbuja del usuario
    setTimeout(function () { input.focus(); }, 50);
  }
  function cerrar() {
    panel.hidden = true; estado.abierto = false; guardar();
    fab.innerHTML = ICON_CHAT + '<span class="badge"></span>'; fab.classList.remove("abierto");
    badge = $(".badge"); mostrarBadge();
    fab.setAttribute("aria-label", "Abrir chat de cotizaciones");
    fab.focus();
  }
  function reiniciar() {
    if (enviando) return;
    estado = { id: nuevoId(), mensajes: [], abierto: true, iniciado: false, ts: Date.now() };
    log.innerHTML = ""; chips.innerHTML = ""; guardar();
    enviar("hola", null);
  }

  fab.addEventListener("click", function () { panel.hidden ? abrir() : cerrar(); });
  teaser.addEventListener("click", abrir);
  $(".close").addEventListener("click", cerrar);
  $(".reset").addEventListener("click", reiniciar);
  form.addEventListener("submit", function (e) { e.preventDefault(); var t = input.value; input.value = ""; ajustar(); enviar(t); });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit")); }
  });
  function ajustar() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 110) + "px"; }
  input.addEventListener("input", ajustar);
  root.addEventListener("keydown", function (e) { if (e.key === "Escape" && !panel.hidden) cerrar(); });

  // ── Arranque
  function montar() {
    document.body.appendChild(host);
    estado.mensajes.forEach(pintar);
    if (estado.abierto) abrir();
    else if (!estado.iniciado) setTimeout(function () { if (panel.hidden) teaser.hidden = false; }, 4000);
    pollTimer = setInterval(poll, 5000);
  }
  if (document.body) montar(); else document.addEventListener("DOMContentLoaded", montar);
})();
