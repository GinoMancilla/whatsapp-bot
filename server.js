require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Resend } = require("resend");
const { parse } = require("csv-parse/sync");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1); // confiar en Railway reverse proxy para req.ip correcto

// Capturar body raw para verificación de firma Meta (debe ir antes de express.json)
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

const {
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID,
  VERIFY_TOKEN,
  DESTINATION_EMAIL,
  RESEND_API_KEY,
  GOOGLE_SHEETS_CSV_URL,
} = process.env;

const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET || "";
if (!WHATSAPP_APP_SECRET) console.warn("⚠️  WHATSAPP_APP_SECRET no configurado — verificación de firma Meta desactivada. Configúralo en Railway.");

// Números de prueba (pueden usar comandos /reset /status sin afectar clientes reales)
const TEST_PHONES = new Set(
  (process.env.TEST_PHONES || "").split(",").map(n => n.trim()).filter(Boolean)
);
if (TEST_PHONES.size > 0) console.log(`🧪 Números de prueba registrados: ${[...TEST_PHONES].join(", ")}`);

// Tokens separados por propósito — fallback a VERIFY_TOKEN si no están configurados
const REPORT_TOKEN     = process.env.REPORT_TOKEN     || VERIFY_TOKEN;
const SPECIALIST_TOKEN = process.env.SPECIALIST_TOKEN || VERIFY_TOKEN;
if (!process.env.REPORT_TOKEN)     console.warn("⚠️  REPORT_TOKEN no configurado, usando VERIFY_TOKEN como fallback. Configura REPORT_TOKEN en Railway.");
if (!process.env.SPECIALIST_TOKEN) console.warn("⚠️  SPECIALIST_TOKEN no configurado, usando VERIFY_TOKEN como fallback. Configura SPECIALIST_TOKEN en Railway.");

// ─── Verificación de firma Meta (X-Hub-Signature-256) ─────────────────────────
function verificarFirmaMeta(req) {
  if (!WHATSAPP_APP_SECRET) return true; // si no está configurado, se omite (warn en startup)
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", WHATSAPP_APP_SECRET)
    .update(req.rawBody)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

const sessions = {};
const hidroPendientes  = new Map(); // phone → respuesta del especialista (fallback si sesión expiró)
const hidroSolicitudes = new Map(); // phone → { sentAt, data, reminderCount } — para recordatorios

// Correo de contacto para derechos de datos personales (Ley 21.719)
const DATOS_CONTACTO = process.env.DATOS_CONTACTO || "caja@cintecsa.cl";

// ─── Datos bancarios CINTEC (formas de pago) ─────────────────────────────────
const DATOS_BANCARIOS_WSP =
  `🏦 *Datos para transferencia:*\n\n` +
  `*Sociedad Comercial Cintec Limitada*\n` +
  `RUT: 77.338.250-6\n\n` +
  `🔹 Banco Santander\nCta. Corriente N° 36989-6\n\n` +
  `🔹 Banco BCI\nCta. Corriente N° 60310332\n\n` +
  `📧 Email: caja@cintecsa.cl`;

const DATOS_BANCARIOS_HTML = `
  <div style="background:#f8f8f8; border:1px solid #e0e0e0; border-radius:8px; padding:16px; margin-top:16px;">
    <h3 style="color:#c0392b; margin:0 0 10px;">💳 Datos bancarios para transferencia</h3>
    <p style="margin:4px 0;"><strong>Sociedad Comercial Cintec Limitada</strong> — RUT 77.338.250-6</p>
    <p style="margin:4px 0;">Banco Santander — Cta. Corriente N° 36989-6</p>
    <p style="margin:4px 0;">Banco BCI — Cta. Corriente N° 60310332</p>
    <p style="margin:4px 0;">Enviar comprobante a <a href="mailto:caja@cintecsa.cl">caja@cintecsa.cl</a> o por WhatsApp</p>
  </div>`;

// ─── Instancias globales (evitar recrear en cada llamada) ─────────────────────
const resendClient = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
const anthropicClient = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// ─── Registro persistente de cotizaciones y contactos ────────────────────────
const LOG_FILE = process.env.LOG_PATH || "./cotizaciones.json";
let cotizacionesLog = [];

try {
  if (fs.existsSync(LOG_FILE)) {
    const contenido = fs.readFileSync(LOG_FILE, "utf8").trim();
    if (contenido) cotizacionesLog = JSON.parse(contenido);
    console.log(`📊 Log cargado: ${cotizacionesLog.length} registros`);
  }
} catch (err) {
  console.warn("No se pudo cargar el log de cotizaciones:", err.message);
}

function guardarLog() {
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(cotizacionesLog, null, 2)); }
  catch (err) { console.error("Error guardando log:", err.message); }
}

// ─── Retención de auditoría: conservar el registro por 6 meses ────────────────
const RETENCION_MS = 183 * 24 * 60 * 60 * 1000; // ~6 meses
function purgarLogAntiguo() {
  const limite = Date.now() - RETENCION_MS;
  const antes = cotizacionesLog.length;
  cotizacionesLog = cotizacionesLog.filter(e => {
    const t = new Date(e.timestamp).getTime();
    return isNaN(t) || t >= limite; // conserva si la fecha es válida y está dentro de la ventana
  });
  if (cotizacionesLog.length !== antes) {
    console.log(`🗑️  Purga de auditoría: ${antes - cotizacionesLog.length} registros con más de 6 meses eliminados`);
    guardarLog();
  }
}
setInterval(purgarLogAntiguo, 24 * 60 * 60 * 1000); // revisa a diario
purgarLogAntiguo(); // al iniciar

// ─── Registro de conversaciones (auditoría interna) ───────────────────────────
// Guarda cada consulta libre del cliente y la respuesta del asistente inteligente.
function registrarConsulta(phone, pregunta, respuesta) {
  if (TEST_PHONES.has(phone)) return; // los números de prueba no generan datos
  cotizacionesLog.push({
    id:        `CONS-${Date.now()}`,
    tipo:      "consulta",
    timestamp: new Date().toISOString(),
    phone,
    pregunta:  (pregunta  || "").slice(0, 500),
    respuesta: (respuesta || "").slice(0, 1000),
  });
  guardarLog();
}

// ─── Seguimiento post-cotización ──────────────────────────────────────────────
// phone → { cotId, sentAt } — clientes con seguimiento enviado esperando respuesta
const seguimientosPendientes = new Map();
// Reconstruir marcadores tras un reinicio del servidor
for (const c of cotizacionesLog) {
  if (c.tipo === "cotizacion" && c.seguimientoEnviado && !c.respuestaSeguimiento && c.seguimientoEnviadoAt &&
      Date.now() - new Date(c.seguimientoEnviadoAt).getTime() < 7 * 24 * 60 * 60 * 1000) {
    seguimientosPendientes.set(c.phone, { cotId: c.id, sentAt: new Date(c.seguimientoEnviadoAt).getTime() });
  }
}

function registrarCotizacion(phone, data) {
  if (TEST_PHONES.has(phone)) return;
  cotizacionesLog.push({
    id:            `COT-${Date.now()}`,
    tipo:          "cotizacion",
    timestamp:     new Date().toISOString(),
    phone,
    rut:           data.rut || "",
    razonSocial:   data.razonSocial || "",
    esClienteNuevo: !!data.esClienteNuevo,
    emailCliente:  data.emailCliente || "",
    direccionEntrega: data.direccionEntrega || "",
    requiereFlete:    !!data.requiereFlete,
    productos:     (data.productosConfirmados || []).map(item => ({
      codigo:      item.seleccionado?.CodProd || "",
      descripcion: item.seleccionado?.DesProd || "",
      precio:      item.seleccionado?.precio  || 0,
      cantidad:    item.cantidad || 1,
      unidad:      item.unidad   || "unidades",
      subtotal:    (item.seleccionado?.precio || 0) * (item.cantidad || 1),
    })),
    total: (data.productosConfirmados || []).reduce(
      (sum, item) => sum + (item.seleccionado?.precio || 0) * (item.cantidad || 1), 0
    ),
  });
  guardarLog();
}

function registrarContacto(phone, nombre, motivo) {
  if (TEST_PHONES.has(phone)) return;
  cotizacionesLog.push({
    id:        `CTT-${Date.now()}`,
    tipo:      "contacto",
    timestamp: new Date().toISOString(),
    phone,
    nombre:    nombre || "",
    motivo:    motivo || "",
  });
  guardarLog();
}

function registrarConversacionProblematica(phone, session, tipo, extra = {}) {
  if (TEST_PHONES.has(phone)) return;
  cotizacionesLog.push({
    id:               `PROB-${Date.now()}`,
    tipo,
    timestamp:        new Date().toISOString(),
    phone,
    step:             session.step,
    cliente:          session.data.razonSocial || "",
    rut:              session.data.rut || "",
    mensajesRecientes: [...(session.data.mensajesRecientes || [])],
    ...extra,
  });
  guardarLog();
}

function registrarComprobante(phone, info) {
  if (TEST_PHONES.has(phone)) return;
  cotizacionesLog.push({
    id:          `PAGO-${Date.now()}`,
    tipo:        "comprobante",
    timestamp:   new Date().toISOString(),
    phone,
    razonSocial: info.razonSocial || "",
    rut:         info.rut || "",
    archivo:     info.filename || "",
    mimeType:    info.mimeType || "",
    cotizacionId: info.cotizacionId || "",
    totalCotizacion: info.totalCotizacion || 0,
  });
  guardarLog();
}

// ─── Cache del catálogo CSV (TTL: 10 minutos) ─────────────────────────────────
let csvCache = { rows: null, ts: 0 };
const CSV_CACHE_TTL = 10 * 60 * 1000;

// ─── Deduplicación de mensajes (Meta puede enviar el mismo webhook 2 veces) ───
const processedMsgIds = new Set();
setInterval(() => processedMsgIds.clear(), 5 * 60 * 1000);

// Dedup secundario: mismo texto del mismo teléfono dentro de 5 segundos
const recentUserMsgs = new Map(); // `${phone}:${text}` → timestamp
setInterval(() => {
  const cutoff = Date.now() - 10_000;
  for (const [k, ts] of recentUserMsgs) if (ts < cutoff) recentUserMsgs.delete(k);
}, 10_000);

// ─── Limpieza de sesiones abandonadas (TTL: 30 minutos sin actividad) ─────────
const SESSION_TTL = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const phone of Object.keys(sessions)) {
    if (now - (sessions[phone].lastActivity || 0) > SESSION_TTL) {
      delete sessions[phone];
    }
  }
}, 5 * 60 * 1000);

// ─── Recordatorios automáticos de solicitudes hidro sin respuesta ─────────────
const HIDRO_REMIND_AFTER  = 2 * 60 * 60 * 1000; // reenviar al técnico tras 2h
const HIDRO_NOTIFY_CLIENT = 4 * 60 * 60 * 1000; // avisar al cliente tras 4h

setInterval(async () => {
  const now = Date.now();
  for (const [phone, entry] of hidroSolicitudes) {
    const elapsed = now - entry.sentAt;
    try {
      if (entry.reminderCount === 0 && elapsed >= HIDRO_REMIND_AFTER) {
        await reenviarRecordatorioHidro(phone, entry.data);
        entry.reminderCount = 1;
        console.log(`🔔 Recordatorio técnico hidro enviado para ${phone}`);
      } else if (entry.reminderCount === 1 && elapsed >= HIDRO_NOTIFY_CLIENT) {
        const s = sessions[phone];
        if (s?.step === STEPS.HIDRO_ESPERANDO) {
          await sendMessage(phone,
            `⏳ Seguimos trabajando en tu cotización de hidrolavadora. Un especialista te responderá a la brevedad.\n` +
            `Si tienes alguna consulta urgente, escribe *ejecutivo* y te atendemos directamente.`
          );
        }
        entry.reminderCount = 2;
      }
    } catch (err) {
      console.error(`Error en recordatorio hidro ${phone}:`, err.message);
    }
  }
}, 30 * 60 * 1000);

// ─── Seguimiento post-cotización: preguntar si revisó la cotización ──────────
// A los 3 días, usando la plantilla aprobada por Meta "seguimiento_cotizacion"
// (fuera de la ventana de 24h solo se permiten plantillas pre-aprobadas).
// Se envía UNA sola vez — si el cliente no responde, no se insiste.
const SEGUIMIENTO_TRAS     = 3 * 24 * 60 * 60 * 1000;
const SEGUIMIENTO_MAX      = 7 * 24 * 60 * 60 * 1000; // no seguir cotizaciones más antiguas
const SEGUIMIENTO_TEMPLATE = "seguimiento_cotizacion";

async function procesarSeguimientos() {
  const now = Date.now();
  let cambios = false;
  for (const c of cotizacionesLog) {
    if (c.tipo !== "cotizacion" || c.seguimientoEnviado) continue;
    const edad = now - new Date(c.timestamp).getTime();
    if (edad < SEGUIMIENTO_TRAS || edad > SEGUIMIENTO_MAX) continue;

    // Si ya envió comprobante de pago después de la cotización, no hay nada que seguir
    const pago = cotizacionesLog.some(e => e.tipo === "comprobante" && e.phone === c.phone &&
      new Date(e.timestamp) > new Date(c.timestamp));
    if (pago) {
      c.seguimientoEnviado   = true;
      c.respuestaSeguimiento = "pago_recibido";
      cambios = true;
      continue;
    }

    // Fuera de la ventana de 24h de WhatsApp → solo se puede enviar plantilla aprobada
    const ok = await sendTemplate(c.phone, SEGUIMIENTO_TEMPLATE, [c.razonSocial || "Estimado cliente"]);
    if (ok) {
      c.seguimientoEnviado   = true;
      c.seguimientoEnviadoAt = new Date().toISOString();
      c.respuestaSeguimiento = "";
      cambios = true;
      seguimientosPendientes.set(c.phone, { cotId: c.id, sentAt: now });
      console.log(`📤 Seguimiento (plantilla) enviado a +${c.phone} (${c.id})`);
    } else {
      // Plantilla aún no aprobada o error de envío → se reintenta en la próxima pasada
      console.warn(`Seguimiento no enviado a +${c.phone}, se reintentará en 1h`);
    }
  }
  if (cambios) guardarLog();
}
setInterval(procesarSeguimientos, 60 * 60 * 1000);      // cada hora
setTimeout(procesarSeguimientos, 5 * 60 * 1000);        // primera pasada tras el arranque

// ─── Rate limiter WhatsApp: ventana deslizante por usuario (máx 12 msg/min) ──
// Cada usuario tiene su propia ventana de 60s que arranca con su primer mensaje.
// Evita el exploit de ventana fija global (burst justo antes del reset).
const rateLimiter = new Map(); // phone → { count, windowStart }

// ─── Rate limiter HTTP: ventana deslizante por IP (para /reporte y /especialista) ─
const httpRateLimiter = new Map(); // ip → { count, windowStart }
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of httpRateLimiter) {
    if (now - entry.windowStart >= 60_000) httpRateLimiter.delete(ip);
  }
}, 60_000);

function checkHttpRateLimit(ip, max = 30) {
  const now   = Date.now();
  const entry = httpRateLimiter.get(ip);
  if (!entry || now - entry.windowStart >= 60_000) {
    httpRateLimiter.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}

setInterval(() => {
  const now = Date.now();
  for (const [phone, entry] of rateLimiter) {
    if (now - entry.windowStart >= 60_000) rateLimiter.delete(phone);
  }
}, 60_000);

function checkRateLimit(phone) {
  const now   = Date.now();
  const entry = rateLimiter.get(phone);

  if (!entry || now - entry.windowStart >= 60_000) {
    rateLimiter.set(phone, { count: 1, windowStart: now });
    return true;
  }

  entry.count += 1;
  return entry.count <= 12;
}

// ─── Anti-frustración: handoff automático tras 2 errores consecutivos ─────────
async function registrarError(phone, session) {
  if (TEST_PHONES.has(phone)) return;
  session.data.erroresConsecutivos = (session.data.erroresConsecutivos || 0) + 1;
  if (session.data.erroresConsecutivos >= 2) {
    session.data.erroresConsecutivos = 0;
    registrarConversacionProblematica(phone, session, "loop");
    await notificarHandoff(phone, session.data);
    await sendMessage(phone,
      `💁 Veo que estás teniendo dificultades. Ya notifiqué a un *ejecutivo de ventas* que te contactará pronto.\n\n` +
      `Puedes seguir cotizando o escribir *stop* para cerrar.`
    );
  }
}

function resetearErrores(session) {
  session.data.erroresConsecutivos = 0;
}

const STEPS = {
  START:              "start",
  MENU_INICIO:        "menu_inicio",
  CONTACTO_NOMBRE:    "contacto_nombre",
  CONTACTO_MOTIVO:    "contacto_motivo",
  WAITING_RUT:        "waiting_rut",
  WAITING_RAZON:      "waiting_razon",
  WAITING_PRODUTOS:   "waiting_productos",
  CONFIRMANDO:        "confirmando",
  WAITING_FORMATO:    "waiting_formato",
  ELIGIENDO_OPCION:   "eligiendo_opcion",
  WAITING_CANTIDAD:   "waiting_cantidad",
  WAITING_MAS:        "waiting_mas",
  WAITING_ENTREGA:    "waiting_entrega",
  WAITING_EMAIL:      "waiting_email",
  HIDRO_CANTIDAD:     "hidro_cantidad",
  HIDRO_DISTINTAS:    "hidro_distintas",
  HIDRO_SPECS:        "hidro_specs",
  HIDRO_ESPERANDO:    "hidro_esperando",
  HIDRO_EMAIL:        "hidro_email",
  DONE:               "done",
};

// ─── Normalizar texto ─────────────────────────────────────────────────────────
function normalizar(str) {
  return (str || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

// ─── Cobertura de entregas directas ──────────────────────────────────────────
// Regiones: Los Lagos, Los Ríos, Biobío + comunas puntuales (Punta Arenas, Natales, Temuco)
const COMUNAS_COBERTURA = [
  // Región de Los Lagos
  "puerto montt", "puerto varas", "llanquihue", "frutillar", "fresia", "los muermos",
  "maullin", "calbuco", "cochamo", "osorno", "san pablo", "puyehue", "rio negro",
  "purranque", "puerto octay", "san juan de la costa", "castro", "ancud", "quellon",
  "chonchi", "dalcahue", "curaco de velez", "puqueldon", "queilen", "quemchi",
  "quinchao", "chaiten", "futaleufu", "hualaihue", "palena", "los lagos",
  // Región de Los Ríos
  "valdivia", "corral", "lanco", "mafil", "mariquina", "san jose de la mariquina",
  "paillaco", "panguipulli", "la union", "futrono", "lago ranco", "rio bueno", "los rios",
  // Región del Biobío
  "concepcion", "coronel", "chiguayante", "florida", "hualqui", "lota", "penco",
  "san pedro de la paz", "santa juana", "talcahuano", "tome", "hualpen", "lebu",
  "arauco", "canete", "contulmo", "curanilahue", "los alamos", "tirua", "los angeles",
  "antuco", "cabrero", "laja", "mulchen", "nacimiento", "negrete", "quilaco",
  "quilleco", "san rosendo", "santa barbara", "tucapel", "yumbel", "alto biobio", "biobio",
  // Comunas puntuales
  "punta arenas", "puerto natales", "natales", "temuco",
];
// Localidades conocidas FUERA de cobertura (para detectar y avisar flete)
const LOCALIDADES_FUERA = [
  "la florida", "santiago", "providencia", "las condes", "nunoa", "maipu", "puente alto",
  "san bernardo", "quilicura", "estacion central", "recoleta", "independencia", "vitacura",
  "lo barnechea", "penalolen", "macul", "la reina", "huechuraba", "renca", "cerrillos",
  "pudahuel", "colina", "lampa", "melipilla", "talagante", "buin", "paine",
  "vina del mar", "valparaiso", "quilpue", "villa alemana", "concon", "quillota", "san antonio",
  "antofagasta", "calama", "mejillones", "tocopilla", "iquique", "alto hospicio", "pozo almonte",
  "arica", "la serena", "coquimbo", "ovalle", "illapel", "vallenar", "copiapo", "caldera",
  "rancagua", "machali", "rengo", "san fernando", "santa cruz", "talca", "curico", "linares",
  "cauquenes", "constitucion", "chillan", "san carlos", "bulnes", "quirihue",
  "coyhaique", "puerto aysen", "chile chico", "cochrane",
  "villarrica", "pucon", "angol", "victoria", "lautaro", "nueva imperial", "padre las casas",
  "porvenir", "puerto williams",
];

function clasificarZonaEntrega(direccion) {
  const d = normalizar(direccion);
  const contiene = lista => lista.some(c => new RegExp(`\\b${c}\\b`).test(d));
  if (contiene(LOCALIDADES_FUERA)) return "fuera";
  if (contiene(COMUNAS_COBERTURA)) return "cobertura";
  return "desconocida";
}

// Reduce plural español a raíz: "guantes"→"guante", "bidones"→"bidon"
function stemES(word) {
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s"))  return word.slice(0, -1);
  return word;
}

// ─── Detección de consultas y respuesta conversacional (Claude) ──────────────
function esUnaConsulta(text) {
  if (text.includes("?")) return true;
  return /^(cuantas?|cuantos?|como|que|donde|cual|tienen|hay|venden|viene|incluyen?|trae[n]?|mandan|traen|cuesta[n]?|precio|disponible|se vende|entregan|despachan|incluye)/i
    .test(normalizar(text));
}

// Detecta un mensaje que claramente NO es el dato pedido, sino una pregunta o
// pedido fuera de tema (para reencauzar con amabilidad en pasos de captura de datos).
// Se usa solo donde el dato esperado tiene forma distintiva (RUT = dígitos, correo = @).
function pareceFueraDeTema(text) {
  const t = normalizar(text);
  const palabras = t.split(/\s+/).filter(Boolean);
  const digitos  = (t.match(/\d/g) || []).length;
  return t.includes("?") || (palabras.length >= 3 && digitos < 4);
}

// Busca en el catálogo productos relacionados con la pregunta (solo nombres, sin precios)
// para que Claude responda con productos reales de CINTEC en vez de inventar.
async function buscarContextoCatalogo(session, pregunta) {
  try {
    const rows = session.data.rows || await cargarCSV();
    if (!rows) return "";
    const keywords = normalizar(pregunta).split(" ")
      .filter(w => w.length > 3 && !STOP_WORDS_ENVASE.has(w) && !/^\d+$/.test(w));
    if (keywords.length === 0) return "";
    const vistos = new Set();
    const nombres = [];
    for (const kw of keywords) {
      for (const p of buscarEnCatalogo(rows, [kw])) {
        if (!vistos.has(p.CodProd)) { vistos.add(p.CodProd); nombres.push(p.DesProd); }
        if (nombres.length >= 12) break;
      }
      if (nombres.length >= 12) break;
    }
    return nombres.length ? nombres.join(" | ") : "";
  } catch { return ""; }
}

async function responderConsulta(phone, session, pregunta) {
  if (!anthropicClient) return false;
  try {
    const client = anthropicClient;

    // Contexto resumido de la sesión actual
    const confirmados = (session.data.productosConfirmados || [])
      .map(p => p.seleccionado?.DesProd).filter(Boolean).join(", ");
    const buscando = session.data.itemActual?.nombre || "";
    const contextLine = [
      confirmados && `Productos ya cotizados: ${confirmados}`,
      buscando    && `Producto en búsqueda actual: ${buscando}`,
    ].filter(Boolean).join(". ");

    // Productos reales del catálogo relacionados con la pregunta (nombres, sin precios)
    const catalogo = await buscarContextoCatalogo(session, pregunta);

    // Memoria: últimos mensajes del cliente para dar continuidad a preguntas de seguimiento
    const historial = (session.data.mensajesRecientes || [])
      .slice(-6, -1) // excluye el mensaje actual (ya viene como `pregunta`)
      .map(m => ({ role: "user", content: m.text }));

    const response = await client.messages.create({
      model: "claude-opus-4-8", // conversación real con el cliente — máxima calidad de comprensión
      max_tokens: 250,
      system:
        `Eres el asistente de ventas de CINTEC, empresa chilena de productos de limpieza, higiene y desinfección industrial. ` +
        `Responde SOLO preguntas relacionadas con productos de limpieza, cotizaciones o servicios de CINTEC. ` +
        `Responde en español, de forma breve (máx 2-3 oraciones). ` +
        `Si no tienes la información exacta, di "un ejecutivo puede ayudarte con eso". ` +
        `NUNCA inventes precios, disponibilidad, ni datos de productos. Los precios SOLO se entregan en la cotización final por correo — si preguntan un precio, di que lo verán en la cotización. ` +
        `Si te preguntan algo fuera del ámbito comercial de CINTEC (política, religión, contenido adulto, temas personales), responde solo: "Estoy aquí para ayudarte con cotizaciones de CINTEC." ` +
        (catalogo ? `Productos reales de nuestro catálogo relacionados con la consulta (menciona solo estos, sin precios): ${catalogo}. ` : `No hay productos en catálogo que coincidan con la consulta; si preguntan por disponibilidad de un producto puntual, deriva a un ejecutivo. `) +
        (contextLine ? `Contexto de la cotización en curso: ${contextLine}.` : ""),
      messages: [...historial, { role: "user", content: pregunta }],
    });

    const reply = response.content[0]?.text || "";
    registrarConsulta(phone, pregunta, reply); // auditoría: pregunta del cliente + respuesta de la IA
    if (/ejecutivo puede ayudarte|estoy aquí para ayudarte con cotizaciones/i.test(reply)) {
      registrarConversacionProblematica(phone, session, "sin_respuesta", { pregunta, respuestaClaude: reply });
    }
    await sendMessage(phone, `${reply}\n\n_Continuemos con tu cotización..._`);
    return true;
  } catch (err) {
    console.error("Error Claude:", err.message);
    return false;
  }
}

// Palabras de envase/cantidad/intención que no deben usarse como keyword de producto
const STOP_WORDS_ENVASE = new Set([
  "bidon", "bidones", "bolsa", "bolsas", "saco", "sacos",
  "caja", "cajas", "frasco", "frascos", "tarro", "tarros",
  "balde", "baldes", "tambor", "tambores", "galon", "galones",
  "envase", "envases", "botella", "botellas", "de", "del",
  "un", "una", "uno", "unos", "unas", "talla",
  "unidad", "unidades",
  // Palabras de intención (por si no se stripearon en el parser)
  "necesito", "quiero", "quisiera", "dame", "busco", "requiero", "preciso",
]);

// Convierte "talla m/l/s/xl" → notación catálogo "t/m"/"t/l"/etc.
function normalizarTalla(nombre) {
  const m = normalizar(nombre).match(/\btalla\s+(xs|xch|xxl|xxg|xl|xg|ch|chico|mediano?|med|grande?|s|m|l|g)\b/);
  if (!m) return null;
  const map = {
    xs:'t/xs', xch:'t/xs',
    s:'t/s', ch:'t/s', chico:'t/s',
    m:'t/m', mediano:'t/m', med:'t/m',
    l:'t/l', g:'t/l', grande:'t/l',
    xl:'t/xl', xg:'t/xl',
    xxl:'t/xxl', xxg:'t/xxl',
  };
  return map[m[1]] || null;
}

// ─── Abreviar proveedor ───────────────────────────────────────────────────────
function abreviarProveedor(proveedor) {
  if (!proveedor) return "-";
  const p = proveedor.trim();
  // Tomar primera palabra significativa
  const palabras = p.split(/\s+/);
  const stopWords = ["de", "del", "la", "el", "los", "las", "y", "e", "s.a", "spa", "ltda", "chile", "industrial", "comercial", "y", "limitada"];
  const significativas = palabras.filter(w => !stopWords.includes(w.toLowerCase().replace(/[.,]/g, "")));
  return significativas.slice(0, 2).join(" ") || palabras[0];
}

// ─── Webhook verificación ─────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// ─── Recepción de mensajes ────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  if (!verificarFirmaMeta(req)) {
    console.warn("⚠️  Webhook rechazado: firma Meta inválida desde", req.ip);
    return res.sendStatus(403);
  }
  res.sendStatus(200);
  try {
    const msg  = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;
    // Ignorar mensajes duplicados que Meta reenvía (mismo msg.id)
    if (processedMsgIds.has(msg.id)) return;
    processedMsgIds.add(msg.id);
    const from = msg.from;
    // Comprobantes de pago: el cliente envía una imagen o documento (PDF)
    if (msg.type === "image" || msg.type === "document") {
      if (!checkRateLimit(from)) return;
      await manejarComprobante(from, msg);
      return;
    }
    const text = msg.text?.body?.trim();
    if (!text) return;
    // Dedup secundario: mismo texto del mismo teléfono en <5 s (Meta puede enviar distinto msg.id)
    const dedupKey = `${from}:${text}`;
    const lastTs   = recentUserMsgs.get(dedupKey);
    if (lastTs && Date.now() - lastTs < 5_000) return;
    recentUserMsgs.set(dedupKey, Date.now());
    if (!checkRateLimit(from)) {
      console.warn(`Rate limit alcanzado: ${from}`);
      return;
    }
    await handleMessage(from, text);
  } catch (err) {
    console.error("Error:", err.message);
  }
});

// ─── Lógica del bot ───────────────────────────────────────────────────────────
async function handleMessage(phone, text) {
  if (!sessions[phone]) sessions[phone] = { step: STEPS.START, data: {} };
  const session = sessions[phone];
  session.lastActivity = Date.now();

  if (!session.data.mensajesRecientes) session.data.mensajesRecientes = [];
  session.data.mensajesRecientes.push({ ts: new Date().toISOString(), text });
  if (session.data.mensajesRecientes.length > 5) session.data.mensajesRecientes.shift();

  // ── Comandos exclusivos para números de prueba ────────────────────────────
  if (TEST_PHONES.has(phone)) {
    if (text === "/reset") {
      delete sessions[phone];
      await sendMessage(phone, `🧪 _[TEST]_ Sesión reiniciada. El bot responderá como si fuera un cliente nuevo.`);
      return;
    }
    if (text === "/status") {
      const s = sessions[phone];
      const step = s?.step ?? "sin sesión";
      const data = s ? JSON.stringify({ rut: s.data.rut, razon: s.data.razonSocial, step }, null, 2) : "{}";
      await sendMessage(phone, `🧪 _[TEST]_ Estado actual:\n\`\`\`\n${data}\n\`\`\``);
      return;
    }
    if (text === "/help") {
      await sendMessage(phone,
        `🧪 *Comandos de prueba disponibles:*\n` +
        `• */reset* — Reinicia tu sesión (cliente nuevo)\n` +
        `• */status* — Muestra el estado actual de tu sesión\n` +
        `• */help* — Muestra este menú\n\n` +
        `_Los demás mensajes funcionan igual que para un cliente real._`
      );
      return;
    }
  }

  // ── Comando STOP: cerrar conversación (cumplimiento Meta) ──────────────────
  if (/^(stop|detener|cancelar|salir|para|basta)$/i.test(normalizar(text))) {
    delete sessions[phone];
    await sendMessage(phone,
      `✅ Tu conversación fue cerrada. Escribe *hola* cuando necesites cotizar nuevamente.\n\n` +
      `_Si necesitas ayuda, un ejecutivo de ventas puede atenderte directamente._`
    );
    return;
  }

  // ── Comando DATOS: derechos de datos personales (Ley 21.719) ───────────────
  if (/^(datos|mis datos|privacidad|proteccion de datos|eliminar mis? datos|borrar mis? datos)$/i.test(normalizar(text))) {
    await sendMessage(phone,
      `🔒 *Tus datos personales en CINTEC*\n\n` +
      `Para cotizarte guardamos solo lo necesario: *RUT, nombre, contacto y dirección de entrega*, con el fin de procesar tu cotización y despacho. ` +
      `No los usamos para publicidad ni los compartimos con terceros ajenos al servicio.\n\n` +
      `Tienes derecho a *acceder, corregir o eliminar* tu información. Para ejercerlo, escríbenos a *${DATOS_CONTACTO}* indicando tu RUT y qué necesitas.\n\n` +
      `_Escribe *hola* para volver al menú._`
    );
    return;
  }

  // ── Respuesta a seguimiento post-cotización ────────────────────────────────
  let seg = seguimientosPendientes.get(phone);
  if (seg && Date.now() - seg.sentAt > 7 * 24 * 60 * 60 * 1000) {
    seguimientosPendientes.delete(phone); // marcador vencido → conversación normal
    seg = null;
  }
  if (seg && (session.step === STEPS.START || session.step === STEPS.DONE)) {
    seguimientosPendientes.delete(phone);
    const cot = cotizacionesLog.find(e => e.id === seg.cotId);
    const tSeg = normalizar(text);
    const quiereCotizar = /^hola\.?$/.test(tSeg) || /cotizar|nueva cotizacion|otra cotizacion/.test(tSeg);
    const sinInteres = /^no\.?$/.test(tSeg) ||
      /no gracias|no me interesa|no por ahora|ya compr|no quiero|no lo necesito|descartar|mas adelante|quizas despues/.test(tSeg);

    if (quiereCotizar) {
      // Quiere cotizar de nuevo: marcar interés y dejar que siga el flujo normal
      if (cot) { cot.respuestaSeguimiento = "interesado"; guardarLog(); }
    } else if (sinInteres) {
      if (cot) { cot.respuestaSeguimiento = "sin_interes"; guardarLog(); }
      await sendMessage(phone,
        `Gracias por avisarnos. 🙏 Si más adelante necesitas cotizar, escribe *hola* y te atendemos al instante.`
      );
      session.step = STEPS.DONE;
      return;
    } else {
      // Respondió con interés o una consulta → derivar al ejecutivo con contexto
      if (cot) { cot.respuestaSeguimiento = "interesado"; guardarLog(); }
      await notificarSeguimientoInteresado(phone, cot, text);
      await sendMessage(phone,
        `✅ ¡Excelente! Un *ejecutivo de CINTEC* te contactará a la brevedad para ayudarte con tu pedido.\n\n` +
        `_Si necesitas cotizar algo más, escribe *hola*._`
      );
      session.step = STEPS.DONE;
      return;
    }
  }

  // ── Solicitud de ejecutivo humano (desde cualquier punto del flujo) ─────────
  // No interceptar si ya está en el flujo de contacto para evitar loops
  const enFlujoContacto = [STEPS.CONTACTO_NOMBRE, STEPS.CONTACTO_MOTIVO].includes(session.step);
  if (!enFlujoContacto && /hablar con|quiero un ejecutivo|necesito un asesor|agente humano|persona real|vendedor|asesor|contactar(me)?|comunicarme/i.test(normalizar(text))) {
    if (session.data.razonSocial) {
      // Ya tenemos su nombre (estaba en medio de una cotización): notificar de inmediato
      await notificarContactoEjecutivo(phone, session.data.razonSocial, "Solicitó ejecutivo durante cotización");
      registrarContacto(phone, session.data.razonSocial, "Solicitó ejecutivo durante cotización");
      await sendMessage(phone,
        `👤 Entendido, *${session.data.razonSocial}*. Un *ejecutivo de ventas* de CINTEC ` +
        `se pondrá en contacto contigo a la brevedad.\n\n` +
        `_Escribe *hola* si necesitas algo más._`
      );
    } else {
      // Sin nombre aún: pedir nombre antes de notificar
      session.step = STEPS.CONTACTO_NOMBRE;
      await sendMessage(phone,
        `👤 Con gusto te conectamos con un *ejecutivo de CINTEC*.\n\n` +
        `¿Cuál es tu *nombre* para informarle?`
      );
      return;
    }
    session.step = STEPS.DONE;
    setTimeout(() => delete sessions[phone], 5 * 60 * 1000);
    return;
  }

  if (session.step === STEPS.DONE && /^(hola|nueva|reiniciar|inicio)$/i.test(text)) {
    delete sessions[phone];
    sessions[phone] = { step: STEPS.START, data: {} };
    session.step = STEPS.START;
  }

  // Interceptar consultas/preguntas libres durante el flujo de cotización
  const stepsConversacionales = new Set([
    STEPS.WAITING_PRODUTOS, STEPS.CONFIRMANDO, STEPS.WAITING_FORMATO,
    STEPS.ELIGIENDO_OPCION, STEPS.WAITING_MAS, STEPS.WAITING_CANTIDAD,
  ]);
  if (stepsConversacionales.has(session.step) && esUnaConsulta(text)) {
    const atendido = await responderConsulta(phone, session, text);
    if (atendido) return;
  }

  switch (session.step) {

    case STEPS.START:
      await sendMessage(phone,
        `👋 ¡Hola! Bienvenido/a a *CINTEC*.\n\n` +
        `🔒 _Para cotizarte guardamos tu RUT, nombre, contacto y dirección con el único fin de procesar tu cotización y despacho. Escribe *datos* cuando quieras acceder, corregir o eliminar tu información._\n\n` +
        `¿En qué te podemos ayudar hoy?\n\n` +
        `*1.* 📦 Cotizar productos\n` +
        `*2.* 👤 Contactar con un ejecutivo`
      );
      session.step = STEPS.MENU_INICIO;
      break;

    case STEPS.MENU_INICIO:
      await manejarMenuInicio(phone, session, text);
      break;

    case STEPS.CONTACTO_NOMBRE:
      await manejarContactoNombre(phone, session, text);
      break;

    case STEPS.CONTACTO_MOTIVO:
      await manejarContactoMotivo(phone, session, text);
      break;

    case STEPS.WAITING_RUT: {
      const tNormRut = normalizar(text);
      // Detectar negativa a entregar el RUT
      const rechazaRut = /^no\.?$/.test(tNormRut) ||
        /no quiero|no lo tengo|no tengo rut|no me lo se|no lo se|prefiero no|para que|por que lo (piden|necesitan)|sin rut|no dar|no entregar|no compartir|es (necesario|obligatorio)/.test(tNormRut);
      const aceptaSinRut = session.data.ofrecioSinRut &&
        /^(si|s|ok|dale|bueno|ya|continuar|continuemos|sigamos|sin rut)\.?$/.test(tNormRut);

      if (aceptaSinRut || (rechazaRut && session.data.ofrecioSinRut)) {
        // Cliente insiste o acepta → continuar sin RUT como cliente nuevo (precio lista)
        session.data.rut       = "";
        session.data.rutLimpio = "";
        session.data.rutSinDV  = null; // null no matchea historial → precio lista
        session.data.sinRut    = true;
        session.step = STEPS.WAITING_RAZON;
        await sendMessage(phone,
          `👍 Sin problema, te cotizaré con *precio lista*.\n\n` +
          `¿Cuál es tu *nombre o razón social*?`
        );
        break;
      }
      if (rechazaRut) {
        session.data.ofrecioSinRut = true;
        await sendMessage(phone,
          `El RUT solo lo uso para buscar tus *precios preferenciales* si ya eres cliente de CINTEC. 😊\n\n` +
          `Si prefieres no entregarlo, puedo cotizarte con *precio lista*.\n\n` +
          `Responde *sí* para continuar sin RUT, o ingresa tu *RUT* para buscar tus precios.`
        );
        break;
      }
      // Si el texto tiene menos de 6 dígitos no puede ser un RUT — el cliente escribió otra cosa
      const digitosEnTexto = (text.match(/\d/g) || []).length;
      if (digitosEnTexto < 6) {
        const reencauce = pareceFueraDeTema(text)
          ? `😊 Estoy aquí solo para ayudarte con *cotizaciones de CINTEC*.\n\n`
          : "";
        await sendMessage(phone,
          reencauce +
          `Para comenzar necesito tu RUT. 😊\n\n` +
          `Si tienes *RUT de empresa*, ingrésalo.\n` +
          `De lo contrario, ingresa tu *RUT personal*.\n\n` +
          `_Ej empresa: 76.123.456-7_\n` +
          `_Ej personal: 12.345.678-9_` +
          (session.data.ofrecioSinRut ? `\n\n_O responde *sí* para cotizar sin RUT con precio lista._` : "")
        );
        break;
      }
      const rutLimpio = normalizarRUT(text);
      if (!validarRUT(text)) {
        await sendMessage(phone,
          `⚠️ RUT inválido. Ingrésalo nuevamente.\n` +
          `_Ej empresa: 76.123.456-7 · Ej personal: 12.345.678-9_`
        );
        break;
      }
      // En Chile, RUTs de empresa son >= 50.000.000 (comienzan con 5, 6, 7, 8 o 9)
      const soloDigitos = rutLimpio.slice(0, -1);
      const esEmpresa   = parseInt(soloDigitos, 10) >= 50000000;
      session.data.rut              = rutLimpio; // siempre guardado sin puntos
      session.data.rutLimpio        = rutLimpio;
      session.data.rutSinDV         = soloDigitos;
      session.data.esperandoRutPersonal = !esEmpresa;
      session.step = STEPS.WAITING_RAZON;
      await sendMessage(phone, `✅ RUT registrado.\n\n¿Cuál es tu *nombre o razón social*?`);
      break;
    }

    case STEPS.WAITING_RAZON: {
      if (/^(no tengo|no|sin empresa|sin nombre|nada)$/i.test(normalizar(text))) {
        await sendMessage(phone, `⚠️ Necesito tu nombre o razón social para la cotización.\n¿Cuál es tu *nombre o razón social*?`);
        break;
      }
      if (text.length < 3) {
        await sendMessage(phone, `⚠️ Ingresa tu nombre o razón social.`);
        break;
      }
      session.data.razonSocial = text;
      session.step = STEPS.WAITING_PRODUTOS;
      await sendMessage(phone,
        `✅ Registrado.\n\n` +
        `📦 ¿Qué productos necesitas cotizar?\n\n` +
        `_Indica productos con cantidades:_\n` +
        `_"lavaloza 10 unidades, toalla 2 paquetes"_`
      );
      break;
    }

    case STEPS.WAITING_PRODUTOS:
      if (text.length < 3) { await sendMessage(phone, `⚠️ Describe los productos que necesitas.`); break; }
      session.data.textoProductos = text;
      await sendMessage(phone, `🔍 Buscando en nuestro catálogo...`);
      await procesarProductos(phone, session);
      break;

    case STEPS.CONFIRMANDO:
      await manejarConfirmacion(phone, session, text);
      break;

    case STEPS.WAITING_FORMATO:
      await manejarFormato(phone, session, text);
      break;

    case STEPS.ELIGIENDO_OPCION:
      await manejarEleccionOpcion(phone, session, text);
      break;

    case STEPS.WAITING_CANTIDAD:
      await manejarCantidad(phone, session, text);
      break;

    case STEPS.WAITING_MAS:
      await manejarMasProductos(phone, session, text);
      break;

    case STEPS.WAITING_ENTREGA:
      if (text.length < 5) {
        await sendMessage(phone, `⚠️ Ingresa una dirección de entrega válida (calle, comuna y ciudad).`);
        break;
      }
      session.data.direccionEntrega = text;
      session.data.requiereFlete = clasificarZonaEntrega(text) === "fuera";
      session.step = STEPS.WAITING_EMAIL;
      if (session.data.requiereFlete) {
        await sendMessage(phone,
          `ℹ️ En esa comuna *no realizamos entregas directas*.\n\n` +
          `Tu pedido se despacha por *flete externo* y su valor se cotiza por separado — ` +
          `un ejecutivo te confirmará el costo del envío. 🚚\n\n` +
          `📧 ¿A qué *correo electrónico* enviamos la cotización?`
        );
      } else {
        await sendMessage(phone, `📧 ¿A qué *correo electrónico* enviamos la cotización?`);
      }
      break;

    case STEPS.WAITING_EMAIL:
      if (!text.includes("@") || !text.includes(".")) {
        const reencauceMail = pareceFueraDeTema(text)
          ? `😊 Estoy aquí solo para ayudarte con tu cotización de CINTEC.\n\n`
          : "";
        await sendMessage(phone, reencauceMail + `📧 Ingresa un *correo electrónico válido* para enviarte la cotización.`);
        break;
      }
      session.data.emailCliente = text.toLowerCase();
      await enviarCotizacionCompleta(phone, session.data);
      session.step = STEPS.DONE;
      setTimeout(() => delete sessions[phone], 5 * 60 * 1000);
      break;

    case STEPS.HIDRO_CANTIDAD:
      await manejarHidroCantidad(phone, session, text);
      break;

    case STEPS.HIDRO_DISTINTAS:
      await manejarHidroDistintas(phone, session, text);
      break;

    case STEPS.HIDRO_SPECS:
      await manejarHidroSpecs(phone, session, text);
      break;

    case STEPS.HIDRO_ESPERANDO:
      await sendMessage(phone, `⏳ Tu cotización está siendo preparada por un especialista. Te avisaremos cuando esté lista.`);
      break;

    case STEPS.HIDRO_EMAIL:
      await manejarHidroEmail(phone, session, text);
      break;

    case STEPS.DONE:
      await sendMessage(phone,
        `✅ Tu solicitud fue procesada.\n\nEscribe *hola* cuando necesites cotizar o contactar a un ejecutivo.`
      );
      break;
  }
}

// ─── Menú inicial ────────────────────────────────────────────────────────────
async function manejarMenuInicio(phone, session, text) {
  const t = normalizar(text);

  // Detección de intención de contacto (sin cotización)
  const esContacto = /^2$/.test(t) ||
    /hablar con|contactar|comunicarme|necesito hablar|quiero hablar|hablar con alguien|ejecutivo|asesor|vendedor|persona real|agente|llamarme|me llamen|me pueden llamar|consulta|duda|problema|reclamo|queja|factura|boleta|pedido|horario|direccion|sucursal|informacion/
    .test(t);

  // Detección de intención de cotización directa
  const esCotizacion = /^1$/.test(t) ||
    /cotizar|cotizacion|precio|productos?|necesito|quiero|busco|comprar|pedir|cuanto|cuanto sale|lavaloza|toalla|guante|desinfect|limpiez|higiene|quimico/
    .test(t);

  if (esContacto) {
    session.step = STEPS.CONTACTO_NOMBRE;
    await sendMessage(phone,
      `👤 Con gusto te conectamos con un *ejecutivo de CINTEC*.\n\n` +
      `¿Cuál es tu *nombre* para informarle?`
    );
    return;
  }

  if (esCotizacion) {
    session.step = STEPS.WAITING_RUT;
    await sendMessage(phone,
      `📦 ¡Perfecto! Para cotizarte necesito algunos datos.\n\n` +
      `Si tienes *RUT de empresa*, ingrésalo.\n` +
      `De lo contrario, ingresa tu *RUT personal*.\n\n` +
      `_Ej empresa: 76.123.456-7_\n` +
      `_Ej personal: 12.345.678-9_`
    );
    return;
  }

  // Las regex no reconocieron el mensaje → clasificar intención con Claude
  const intencion = await clasificarIntencion(text);
  if (intencion === "cotizar") {
    session.step = STEPS.WAITING_RUT;
    await sendMessage(phone,
      `📦 ¡Perfecto! Para cotizarte necesito algunos datos.\n\n` +
      `Si tienes *RUT de empresa*, ingrésalo.\n` +
      `De lo contrario, ingresa tu *RUT personal*.\n\n` +
      `_Ej empresa: 76.123.456-7_\n` +
      `_Ej personal: 12.345.678-9_`
    );
    return;
  }
  if (intencion === "contacto") {
    session.step = STEPS.CONTACTO_NOMBRE;
    await sendMessage(phone,
      `👤 Con gusto te conectamos con un *ejecutivo de CINTEC*.\n\n` +
      `¿Cuál es tu *nombre* para informarle?`
    );
    return;
  }

  // Intención no clara → repetir menú
  await sendMessage(phone,
    `No entendí tu selección. Por favor elige una opción:\n\n` +
    `*1.* 📦 Cotizar productos\n` +
    `*2.* 👤 Contactar con un ejecutivo`
  );
}

// Clasifica un mensaje ambiguo del menú inicial en: cotizar | contacto | ninguno.
// Usa Claude solo cuando las regex no dieron match, para no perder al cliente.
async function clasificarIntencion(text) {
  if (!anthropicClient) return "ninguno";
  try {
    const response = await anthropicClient.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      system:
        `Clasifica el mensaje de un cliente de CINTEC (productos de limpieza industrial) que está en el menú inicial. ` +
        `Responde UNA sola palabra:\n` +
        `"cotizar" si quiere comprar, cotizar o pregunta por productos (ej: "necesito algo pa limpiar la bodega", "venden cloro?").\n` +
        `"contacto" si quiere hablar con una persona, tiene un reclamo, consulta de factura/pedido/horario, o soporte.\n` +
        `"ninguno" si es un saludo vacío, spam o algo incomprensible.\n` +
        `Solo responde: cotizar, contacto o ninguno.`,
      messages: [{ role: "user", content: text.slice(0, 300) }],
    });
    const out = normalizar(response.content[0]?.text || "");
    if (out.includes("cotizar")) return "cotizar";
    if (out.includes("contacto")) return "contacto";
    return "ninguno";
  } catch (err) {
    console.error("Error clasificando intención:", err.message);
    return "ninguno";
  }
}

// ─── Flujo de contacto con ejecutivo ─────────────────────────────────────────
async function manejarContactoNombre(phone, session, text) {
  if (text.length < 2) {
    await sendMessage(phone, `⚠️ Ingresa tu nombre para continuar.`);
    return;
  }
  session.data.nombreContacto = text;
  session.step = STEPS.CONTACTO_MOTIVO;
  await sendMessage(phone,
    `¡Hola, *${text}*! 👋\n\n` +
    `¿En qué podemos ayudarte? Cuéntanos brevemente el motivo de tu consulta.`
  );
}

async function manejarContactoMotivo(phone, session, text) {
  const nombre = session.data.nombreContacto || "Cliente";
  session.data.motivoContacto = text;

  await notificarContactoEjecutivo(phone, nombre, text);
  registrarContacto(phone, nombre, text);

  await sendMessage(phone,
    `✅ ¡Listo, *${nombre}*! Tu solicitud fue enviada a nuestro equipo.\n\n` +
    `Un *ejecutivo de CINTEC* se pondrá en contacto contigo a la brevedad por este mismo número.\n\n` +
    `_Si necesitas cotizar productos mientras tanto, escribe *hola* para volver al menú._`
  );
  session.step = STEPS.DONE;
  setTimeout(() => delete sessions[phone], 5 * 60 * 1000);
}

async function notificarContactoEjecutivo(phone, nombre, motivo) {
  if (!resendClient) return;
  try {
    const fecha = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
    await resendClient.emails.send({
      from:    "Bot CINTEC <onboarding@resend.dev>",
      to:      DESTINATION_EMAIL,
      subject: `📞 Cliente solicita contacto — ${nombre}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;border:2px solid #3498db;border-radius:8px;">
          <h2 style="color:#3498db;">📞 Solicitud de contacto con ejecutivo</h2>
          <p><strong>Fecha:</strong> ${fecha}</p>
          <p><strong>Nombre:</strong> ${escapeHtml(nombre)}</p>
          <p><strong>WhatsApp:</strong> <a href="https://wa.me/${escapeHtml(phone)}">+${escapeHtml(phone)}</a></p>
          <p><strong>Motivo:</strong></p>
          <blockquote style="background:#f5f5f5;padding:12px;border-left:4px solid #3498db;border-radius:4px;">
            ${escapeHtml(motivo)}
          </blockquote>
          <p style="margin-top:16px;">⚡ Acción requerida: contactar al cliente a la brevedad.</p>
        </div>`,
    });
  } catch (err) {
    console.error("Error notificando contacto:", err.message);
  }
}

// ─── Procesar productos ───────────────────────────────────────────────────────
async function procesarProductos(phone, session) {
  // Inicializar acumuladores antes de cualquier operación
  if (!session.data.productosConfirmados)   session.data.productosConfirmados   = [];
  if (!session.data.productosBajoMargen)    session.data.productosBajoMargen    = [];
  if (!session.data.productosNoEncontrados) session.data.productosNoEncontrados = [];

  const items = parsearProductos(session.data.textoProductos);
  session.data.itemsPendientes = items;

  // Si el primer producto es hidrolavadora, no necesita catálogo → ir directo
  const primerItem = items[0];
  if (primerItem && esHidrolavadora(primerItem.nombre)) {
    session.data.itemActual = primerItem;
    await iniciarFlujoHidro(phone, session);
    return;
  }

  const rows = await cargarCSV();
  if (!rows) { await sendMessage(phone, `⚠️ Error al acceder al catálogo. Intenta nuevamente en unos segundos.`); return; }

  // Detectar si cliente tiene historial
  const filasCliente = rows.filter(row =>
    (row["CodAuxGSaen"] || "").replace(/[.\-\s]/g, "") === session.data.rutSinDV
  );
  session.data.esClienteNuevo = filasCliente.length === 0;
  if (session.data.esClienteNuevo) console.log(`Cliente nuevo: ${session.data.rutSinDV}`);

  session.data.rows = rows;

  await procesarSiguienteProducto(phone, session);
}

// ─── Procesar siguiente producto de la lista ──────────────────────────────────
async function procesarSiguienteProducto(phone, session) {
  if (session.data.itemsPendientes.length === 0) {
    await mostrarResumenFinal(phone, session);
    return;
  }

  const item = session.data.itemsPendientes[0];
  session.data.itemActual = item;

  if (esHidrolavadora(item.nombre)) {
    await iniciarFlujoHidro(phone, session);
  } else if (session.data.esClienteNuevo) {
    await buscarParaClienteNuevo(phone, session, item);
  } else {
    await buscarParaClienteExistente(phone, session, item);
  }
}

// ─── Buscar para cliente existente ───────────────────────────────────────────
async function buscarParaClienteExistente(phone, session, item) {
  const resultado = buscarProductoHistorial(session.data.rows, session.data.rutSinDV, item.nombre);

  if (resultado.principal) {
    session.data.resultadoActual    = resultado;
    session.data.modoAlternativas   = false;
    const p = resultado.principal;
    let msg = `📦 Encontré este producto en tu historial:\n\n`;
    msg += `*${p.DesProd}*\n`;
    msg += `🏷️ Código: ${p.CodProd}\n`;
    msg += `📅 Última compra: ${p.fecha}\n\n`;
    msg += `¿Es este el producto correcto? Responde *sí* o *no*.`;
    session.step = STEPS.CONFIRMANDO;
    await sendMessage(phone, msg);
  } else if (resultado.bajoMargen) {
    // Precio desactualizado en historial → avisar al equipo y buscar en catálogo
    notificarBajoMargen(phone, session.data, [{ ...item, producto: resultado.bajoMargenProducto }]);
    await buscarParaClienteNuevo(phone, session, item);
  } else {
    // No encontrado en historial → buscar en catálogo general
    await buscarParaClienteNuevo(phone, session, item);
  }
}

// ─── Buscar para cliente nuevo (catálogo completo, Precio Lista) ──────────────
async function buscarParaClienteNuevo(phone, session, item) {
  const allKeywords = normalizar(item.nombre).split(" ")
    .filter(w => w.length > 2 && !STOP_WORDS_ENVASE.has(w) && !/^\d+$/.test(w));

  if (allKeywords.length === 0) {
    session.data.productosNoEncontrados.push(item.nombre);
    await sendMessage(phone, `ℹ️ No encontré _"${item.nombre}"_ en nuestro catálogo.\nUn representante revisará disponibilidad.`);
    session.data.itemsPendientes.shift();
    await procesarSiguienteProducto(phone, session);
    return;
  }

  // Fase 1: buscar por primera palabra (anchor principal)
  const fase1 = buscarEnCatalogo(session.data.rows, [allKeywords[0]]);

  // Fase 2: filtrar resultados por palabras secundarias (con fallback a fase 1)
  let encontrados = fase1;
  if (allKeywords.length > 1 && fase1.length > 0) {
    const secundarias = allKeywords.slice(1);
    const fase2 = fase1.filter(p => {
      const desc = normalizar(p.DesProd).replace(/-/g, "");
      return secundarias.some(k => {
        const kn = k.replace(/-/g, "");
        return desc.includes(kn) || desc.includes(stemES(kn));
      });
    });
    if (fase2.length > 0) encontrados = fase2;
  }

  // Filtrar por talla si fue especificada
  const talla = normalizarTalla(item.nombre);
  if (talla) {
    const conTalla = encontrados.filter(p => normalizar(p.DesProd).includes(talla));
    if (conTalla.length > 0) encontrados = conTalla;
  }

  if (encontrados.length === 0) {
    // Búsqueda ampliada: cada keyword por separado para mostrar opciones cercanas
    const vistoCod = new Set();
    const ampliados = [];
    for (const kw of allKeywords) {
      for (const p of buscarEnCatalogo(session.data.rows, [kw])) {
        if (!vistoCod.has(p.CodProd)) { vistoCod.add(p.CodProd); ampliados.push(p); }
      }
      if (ampliados.length >= 6) break;
    }

    if (ampliados.length > 0) {
      await sendMessage(phone,
        `ℹ️ No encontré _"${item.nombre}"_ exactamente en nuestro catálogo.\n` +
        `Estas son las opciones más cercanas que tenemos:`
      );
      await mostrarOpcionesProducto(phone, session, ampliados, item);
      return;
    }

    // Sin resultados ni parciales → derivar a representante
    session.data.productosNoEncontrados.push(item.nombre);
    await sendMessage(phone,
      `ℹ️ No encontré _"${item.nombre}"_ en nuestro catálogo.\n` +
      `Un representante revisará disponibilidad.`
    );
    session.data.itemsPendientes.shift();
    await procesarSiguienteProducto(phone, session);
    return;
  }

  // Si el cliente especificó formato inline ("x 5lt", "formato 5 lt"), filtrar directo
  let resultado = encontrados;
  let formatoNoEncontrado = false;
  if (item.formatoEspecificado) {
    const fmt = normalizarFormatoStr(item.formatoEspecificado);
    const filtradosFmt = encontrados.filter(p => normalizar(p.DesProd).includes(fmt));
    if (filtradosFmt.length > 0) {
      resultado = filtradosFmt;
    } else {
      formatoNoEncontrado = true; // el formato pedido no existe, mostramos lo disponible
    }
  }

  // Extraer formatos únicos (litros, kg, ml, mt, etc.)
  const formatos = extraerFormatos(resultado);

  if (formatos.length > 1 && !item.formatoEspecificado) {
    session.data.opcionesEncontradas = resultado;
    session.data.formatosDisponibles  = formatos;
    session.step = STEPS.WAITING_FORMATO;

    let msg = `📦 Encontré varias presentaciones de _"${item.nombre}"_.\n\n`;
    msg += `¿Qué formato necesitas?\n\n`;
    formatos.forEach((f, i) => { msg += `*${i + 1}.* ${f}\n`; });
    msg += `\nResponde con el *número* del formato que necesitas.`;
    await sendMessage(phone, msg);
  } else if (formatoNoEncontrado && formatos.length > 1) {
    // Formato pedido no existe → avisar y mostrar los disponibles
    session.data.opcionesEncontradas = resultado;
    session.data.formatosDisponibles  = formatos;
    session.step = STEPS.WAITING_FORMATO;

    let msg = `ℹ️ No tenemos _"${item.nombre}"_ en formato *${item.formatoEspecificado}*.\n\n`;
    msg += `Los formatos disponibles son:\n\n`;
    formatos.forEach((f, i) => { msg += `*${i + 1}.* ${f}\n`; });
    msg += `\nResponde con el *número* del que necesitas.`;
    await sendMessage(phone, msg);
  } else {
    await mostrarOpcionesProducto(phone, session, resultado, item);
  }
}

// ─── Manejar selección de formato ────────────────────────────────────────────
async function manejarFormato(phone, session, text) {
  const formatos = session.data.formatosDisponibles;
  const soloNumero = /^\s*\d+\s*$/.test(text);
  const num = parseInt(text);
  let formatoElegido = null;

  if (soloNumero && num >= 1 && num <= formatos.length) {
    formatoElegido = formatos[num - 1];
  } else {
    // Buscar coincidencia por texto (ej. "20 kg", "20kg", "5 lt")
    const textNorm = normalizar(text);
    formatoElegido = formatos.find(f => normalizar(f).includes(textNorm) || textNorm.includes(normalizar(f)));
  }

  if (!formatoElegido) {
    const lista = formatos.map((f, i) => `*${i + 1}.* ${f}`).join("\n");
    await sendMessage(phone, `⚠️ No reconocí ese formato. Elige con un número o escribe el formato exacto:\n\n${lista}`);
    await registrarError(phone, session);
    return;
  }
  const opciones = session.data.opcionesEncontradas.filter(p => {
    const desc = normalizar(p.DesProd);
    return desc.includes(normalizar(formatoElegido));
  });

  resetearErrores(session);
  await mostrarOpcionesProducto(phone, session, opciones.length > 0 ? opciones : session.data.opcionesEncontradas, session.data.itemActual);
}

// ─── Mostrar opciones de producto ─────────────────────────────────────────────
async function mostrarOpcionesProducto(phone, session, opciones, item) {
  // Deduplicar por CodProd y tomar máx 4
  const unicosPorCod = {};
  opciones.forEach(p => { if (!unicosPorCod[p.CodProd]) unicosPorCod[p.CodProd] = p; });
  const lista = Object.values(unicosPorCod).slice(0, 4);

  session.data.opcionesActuales = lista;
  session.step = STEPS.ELIGIENDO_OPCION;

  let msg = `📋 *Opciones disponibles para "${item.nombre}":*\n\n`;
  lista.forEach((p, i) => {
    const prov = abreviarProveedor(p.Proveedor);
    msg += `*${i + 1}.* ${p.DesProd}\n`;
    msg += `   🏭 ${prov}\n\n`;
  });

  if (lista.length > 1) {
    msg += `Responde con el *número* de tu elección o escribe *todos* para cotizarlos todos.`;
  } else {
    msg += `Responde *sí* para confirmar o *no* para cancelar.`;
  }

  await sendMessage(phone, msg);
}

// ─── Manejar elección de opción ───────────────────────────────────────────────
async function manejarEleccionOpcion(phone, session, text) {
  const lista = session.data.opcionesActuales;
  const item  = session.data.itemActual;
  const textNorm = normalizar(text);
  const cantidadAntes = session.data.productosConfirmados.length;

  if (textNorm === "todos" || textNorm === "todas") {
    // Agregar todos
    lista.forEach(p => {
      const precio = parsearPrecio(p["Precio Lista"]);
      session.data.productosConfirmados.push({
        seleccionado: { CodProd: p.CodProd, DesProd: p.DesProd, precio, fecha: "-", Proveedor: p.Proveedor },
        cantidad: item.cantidad,
        unidad:   item.unidad,
        confirmado: true,
        esClienteNuevo: true,
      });
    });
    await sendMessage(phone, `✅ Se cotizarán *${lista.length} opciones*.`);
  } else {
    const num = parseInt(text);
    if (lista.length === 1 && /^(si|sí|s|yes|ok)$/i.test(textNorm)) {
      const p = lista[0];
      const precio = parsearPrecio(p["Precio Lista"]);
      session.data.productosConfirmados.push({
        seleccionado: { CodProd: p.CodProd, DesProd: p.DesProd, precio, fecha: "-", Proveedor: p.Proveedor },
        cantidad: item.cantidad,
        unidad:   item.unidad,
        confirmado: true,
        esClienteNuevo: true,
      });
      await sendMessage(phone, `✅ Producto confirmado.`);
    } else if (!isNaN(num) && num >= 1 && num <= lista.length) {
      const p = lista[num - 1];
      const precio = parsearPrecio(p["Precio Lista"]);
      session.data.productosConfirmados.push({
        seleccionado: { CodProd: p.CodProd, DesProd: p.DesProd, precio, fecha: "-", Proveedor: p.Proveedor },
        cantidad: item.cantidad,
        unidad:   item.unidad,
        confirmado: true,
        esClienteNuevo: true,
      });
      await sendMessage(phone, `✅ Seleccionado: *${p.DesProd}*`);
    } else if (/^(no|n|cancelar)$/i.test(textNorm)) {
      session.data.productosNoEncontrados.push(item.nombre);
      await sendMessage(phone, `Entendido, omitiremos ese producto.`);
    } else {
      // El cliente escribió algo libre (ej: "busco el x-75", "quiero el verde")
      // Intentar interpretarlo como una nueva búsqueda para este mismo slot de producto
      const consultaLimpia = text.trim()
        .replace(/^(busco\s+(el\s+|la\s+|los\s+|las\s+)?|quiero\s+(el\s+|la\s+|los\s+|las\s+)?|necesito\s+(el\s+|la\s+|los\s+|las\s+)?|dame\s+(el\s+|la\s+)?)/i, "")
        .trim();
      const palabrasUtiles = normalizar(consultaLimpia).split(" ")
        .filter(w => w.length > 2 && !/^\d+$/.test(w) && !STOP_WORDS_ENVASE.has(w));

      if (palabrasUtiles.length > 0 && session.data.rows) {
        const nuevoItem = {
          nombre: consultaLimpia,
          cantidad: item.cantidad,
          unidad: item.unidad,
          cantidadEspecificada: item.cantidadEspecificada,
        };
        session.data.itemActual = nuevoItem;
        session.data.itemsPendientes[0] = nuevoItem;
        await sendMessage(phone, `🔍 Buscando _"${consultaLimpia}"_ en el catálogo...`);
        await buscarParaClienteNuevo(phone, session, nuevoItem);
        return;
      }

      await sendMessage(phone, `⚠️ Responde con un número, *todos* o *no*.`);
      await registrarError(phone, session);
      return;
    }
  }

  session.data.itemsPendientes.shift();

  // Si el cliente no especificó cantidad y sí confirmó productos, pedirla ahora
  const productosAgregados = session.data.productosConfirmados.length - cantidadAntes;
  if (!item.cantidadEspecificada && productosAgregados > 0) {
    session.step = STEPS.WAITING_CANTIDAD;
    session.data.cantidadPendienteCount = productosAgregados;
    if (productosAgregados > 1) {
      await sendMessage(phone, `📦 ¿Cuántas unidades necesitas de cada presentación?`);
    } else {
      const prod = session.data.productosConfirmados[session.data.productosConfirmados.length - 1];
      const desc = prod?.seleccionado?.DesProd || "este producto";
      await sendMessage(phone, `📦 ¿Cuántas unidades necesitas?\n_${desc}_`);
    }
    return;
  }

  resetearErrores(session);
  await continuarTrasEleccion(phone, session);
}

async function continuarTrasEleccion(phone, session) {
  if (session.data.itemsPendientes.length === 0) {
    session.step = STEPS.WAITING_MAS;
    await sendMessage(phone, `¿Necesitas cotizar algo más? Responde *sí* para agregar productos o *no* para continuar.`);
  } else {
    await procesarSiguienteProducto(phone, session);
  }
}

// ─── Manejar cantidad cuando no fue especificada ──────────────────────────────
async function manejarCantidad(phone, session, text) {
  const match = text.match(/\d+/);
  const num = match ? parseInt(match[0]) : NaN;
  if (isNaN(num) || num < 1) {
    await sendMessage(phone, `⚠️ Ingresa una cantidad válida (número mayor a 0).`);
    await registrarError(phone, session);
    return;
  }

  const count = session.data.cantidadPendienteCount || 1;
  const confirmados = session.data.productosConfirmados;
  for (let i = confirmados.length - count; i < confirmados.length; i++) {
    confirmados[i].cantidad = num;
  }

  await sendMessage(phone, `✅ Cantidad registrada: *${num} unidades*.`);
  await continuarTrasEleccion(phone, session);
}

// ─── Manejar "¿necesitas algo más?" ──────────────────────────────────────────
async function manejarMasProductos(phone, session, text) {
  const textNorm = normalizar(text);
  if (/^(no|n|nop|listo|eso es todo|eso|fin)$/i.test(textNorm)) {
    await mostrarResumenFinal(phone, session);
  } else if (/^(si|sí|s|yes|ok|claro|bueno)$/i.test(textNorm)) {
    session.step = STEPS.WAITING_PRODUTOS;
    await sendMessage(phone,
      `📦 ¿Qué más necesitas?\n_Indica producto y cantidad:_\n_"papel higienico 3 paquetes"_`
    );
  } else {
    // El cliente escribió directamente un producto en vez de sí/no
    session.data.textoProductos = text;
    session.data.itemsPendientes = parsearProductos(text);
    await sendMessage(phone, `🔍 Buscando en nuestro catálogo...`);
    await procesarSiguienteProducto(phone, session);
  }
}

// ─── Manejar confirmación (cliente existente) ─────────────────────────────────
async function manejarConfirmacion(phone, session, text) {
  const textNorm = normalizar(text);
  const item     = session.data.itemActual;
  const resultado = session.data.resultadoActual;

  if (session.data.modoAlternativas) {
    const num = parseInt(text);
    const opciones = [resultado.principal, ...resultado.alternativas];
    if (isNaN(num) || num < 1 || num > opciones.length) {
      await sendMessage(phone, `⚠️ Responde con un número entre 1 y ${opciones.length}.`);
      await registrarError(phone, session);
      return;
    }
    const elegido = opciones[num - 1];
    session.data.productosConfirmados.push({
      seleccionado: elegido,
      cantidad:     item.cantidad,
      unidad:       item.unidad,
      confirmado:   true,
    });
    session.data.modoAlternativas = false;
    await sendMessage(phone, `✅ Seleccionado: *${elegido.DesProd}*`);
    session.data.itemsPendientes.shift();
    await siguientePasoTrasConfirmacion(phone, session);
    return;
  }

  if (/^(si|sí|s|yes|ok|bueno|correcto|afirmativo|dale)$/i.test(textNorm)) {
    session.data.productosConfirmados.push({
      seleccionado: resultado.principal,
      cantidad:     item.cantidad,
      unidad:       item.unidad,
      confirmado:   true,
    });
    await sendMessage(phone, `✅ Producto confirmado.`);
    session.data.itemsPendientes.shift();
    await siguientePasoTrasConfirmacion(phone, session);
    return;
  }

  if (/^(no|n|nop|incorrecto|otro)$/i.test(textNorm)) {
    if (resultado.alternativas.length === 0) {
      await sendMessage(phone,
        `ℹ️ No hay más opciones en tu historial para _"${item.nombre}"_.\n` +
        `Buscaré en catálogo general...`
      );
      await buscarParaClienteNuevo(phone, session, item);
      return;
    }
    const opciones = [resultado.principal, ...resultado.alternativas];
    let msg = `📋 *Alternativas para "${item.nombre}":*\n\n`;
    opciones.forEach((p, i) => {
      msg += `*${i + 1}.* ${p.DesProd}\n`;
      msg += `   📅 Última compra: ${p.fecha}\n\n`;
    });
    msg += `Responde con el *número* de tu elección.`;
    session.data.modoAlternativas = true;
    await sendMessage(phone, msg);
    return;
  }

  await sendMessage(phone, `⚠️ No entendí. Por favor responde *sí* o *no*.`);
  await registrarError(phone, session);
}

// ─── Siguiente paso tras confirmación ────────────────────────────────────────
async function siguientePasoTrasConfirmacion(phone, session) {
  const item = session.data.itemActual;
  if (!item.cantidadEspecificada) {
    session.step = STEPS.WAITING_CANTIDAD;
    session.data.cantidadPendienteCount = 1;
    await sendMessage(phone, `📦 ¿Cuántas unidades necesitas de este producto?`);
    return;
  }
  if (session.data.itemsPendientes.length === 0) {
    session.step = STEPS.WAITING_MAS;
    await sendMessage(phone, `¿Necesitas cotizar algo más? Responde *sí* o *no*.`);
  } else {
    await procesarSiguienteProducto(phone, session);
  }
}

// ─── Mostrar resumen final ────────────────────────────────────────────────────
async function mostrarResumenFinal(phone, session) {
  const confirmados   = session.data.productosConfirmados;
  const bajoMargen    = session.data.productosBajoMargen || [];
  const noEncontrados = session.data.productosNoEncontrados || [];

  if (confirmados.length === 0) {
    await sendMessage(phone,
      `ℹ️ No hay productos para cotizar.\nUn representante te contactará a la brevedad.`
    );
    session.step = STEPS.DONE;
    await notificarInterno(phone, session.data);
    return;
  }

  let msg = `📋 *Resumen de tu solicitud:*\n\n`;
  confirmados.forEach((item, i) => {
    const p = item.seleccionado;
    msg += `*${i + 1}. ${p.DesProd}*\n`;
    msg += `   🏷️ Código: ${p.CodProd}\n`;
    msg += `   📦 Cantidad: ${item.cantidad} ${item.unidad}\n\n`;
  });

  const condicionPago = session.data.esClienteNuevo ? "Contado" : "30 días";
  msg += `📧 Los *precios y el total* van incluidos en la cotización que enviaremos a tu correo.\n\n`;
  msg += `🕒 *Vigencia de precios:* 72 horas\n`;
  msg += `🚚 *Despacho:* Puerto Montt\n`;
  msg += `💳 *Condición de pago:* ${condicionPago}\n\n`;

  if (bajoMargen.length > 0) {
    msg += `⚠️ Estos productos requieren actualización de precios:\n`;
    bajoMargen.forEach(p => { msg += `• ${p.nombre}\n`; });
    msg += `_Un representante te contactará._\n\n`;
  }
  if (noEncontrados.length > 0) {
    msg += `ℹ️ No encontrado en catálogo: ${noEncontrados.join(", ")}\nUn representante revisará disponibilidad.\n\n`;
  }

  msg += `📦 ¿Cuál es la *dirección de entrega*? (calle, comuna y ciudad)`;
  session.step = STEPS.WAITING_ENTREGA;
  await sendMessage(phone, msg);
}

// ─── Buscar en historial cliente existente ────────────────────────────────────
function buscarProductoHistorial(rows, rutSinDV, nombreBuscado) {
  const haceSeismeses = new Date();
  haceSeismeses.setMonth(haceSeismeses.getMonth() - 6);
  const allKeywords = normalizar(nombreBuscado).split(" ").filter(w => w.length > 2 && !/^\d+$/.test(w));

  if (allKeywords.length === 0) return { principal: null, alternativas: [], bajoMargen: false };

  const filasCliente = rows.filter(row =>
    (row["CodAuxGSaen"] || "").replace(/[.\-\s]/g, "") === rutSinDV
  );

  // Fase 1: filtrar por primera palabra
  const fase1 = filasCliente.filter(row => {
    const desc = normalizar(row["DesProd"] || "");
    const cod  = (row["CodProd"] || "").toLowerCase();
    const k = allKeywords[0], stem = stemES(k);
    return desc.includes(k) || desc.includes(stem) || cod.includes(k) || cod.includes(stem);
  });

  // Fase 2: refinar por palabras secundarias (con fallback a fase 1)
  let filasProducto = fase1;
  if (allKeywords.length > 1 && fase1.length > 0) {
    const secundarias = allKeywords.slice(1);
    const fase2 = fase1.filter(row => {
      const desc = normalizar(row["DesProd"] || "");
      return secundarias.some(k => desc.includes(k) || desc.includes(stemES(k)));
    });
    if (fase2.length > 0) filasProducto = fase2;
  }

  if (filasProducto.length === 0) return { principal: null, alternativas: [], bajoMargen: false };

  const validos = [];
  const bajoMargenFilas = [];

  filasProducto.forEach(row => {
    const fechaStr = row["Fecha Ult. Vta"] || "";
    const parts    = fechaStr.split("/");
    const fecha    = parts.length === 3
      ? new Date(`${parts[2]}-${parts[1].padStart(2,"0")}-${parts[0].padStart(2,"0")}`)
      : new Date(fechaStr);
    const precio = parsearPrecio(row["Ultimo Precio"]);
    const costo  = parsearPrecio(row["Costo Vta"]);
    const margen = precio > 0 ? (precio - costo) / precio : 0;
    const prodObj = { CodProd: row["CodProd"], DesProd: row["DesProd"], precio, fecha: fechaStr, margen: (margen*100).toFixed(1) };
    if (fecha >= haceSeismeses && margen >= 0.20) validos.push(prodObj);
    else if (margen < 0.20) bajoMargenFilas.push(prodObj);
  });

  if (validos.length === 0 && bajoMargenFilas.length > 0) {
    return { principal: null, alternativas: [], bajoMargen: true, bajoMargenProducto: bajoMargenFilas[0] };
  }
  if (validos.length === 0) return { principal: null, alternativas: [], bajoMargen: false };

  const unicosPorCod = {};
  validos.forEach(p => { if (!unicosPorCod[p.CodProd]) unicosPorCod[p.CodProd] = p; });
  const unicosArr = Object.values(unicosPorCod);
  return { principal: unicosArr[0], alternativas: unicosArr.slice(1, 3), bajoMargen: false };
}

// ─── Helper: parsear precio desde string CSV ──────────────────────────────────
function parsearPrecio(str) {
  return parseFloat((str || "0").replace(/[$.\s]/g, "").replace(",", ".")) || 0;
}

// ─── Buscar en catálogo completo ──────────────────────────────────────────────
function buscarEnCatalogo(rows, keywords) {
  const unicosPorCod = {};
  rows.forEach(row => {
    if (!unicosPorCod[row["CodProd"]]) unicosPorCod[row["CodProd"]] = row;
  });
  const catalogo = Object.values(unicosPorCod);

  return catalogo.filter(row => {
    // Quitar guiones para que "x80" encuentre "X-80", "x-80" encuentre "x80", etc.
    const desc  = normalizar(row["DesProd"] || "").replace(/-/g, "");
    const cod   = (row["CodProd"] || "").toLowerCase().replace(/-/g, "");
    const precio = parsearPrecio(row["Precio Lista"]);
    if (precio <= 0) return false;
    return keywords.some(k => {
      const kn   = k.replace(/-/g, "");
      const stem = stemES(kn);
      return desc.includes(kn) || desc.includes(stem) || cod.includes(kn) || cod.includes(stem);
    });
  });
}

// ─── Extraer formatos del texto ───────────────────────────────────────────────
function extraerFormatos(productos) {
  const formatoRegex = /(\d+(?:[.,]\d+)?\s*(?:lt|litros?|kg|kilos?|gr|gramos?|ml|cc|mt|metros?|un|unidades?|l\b))/gi;
  const medidas   = new Set(); // lt, kg, mt, ml, etc. — van primero
  const conteos   = new Set(); // un, unidades — van después
  const esMedida  = /^[\d.,]+\s*(lt|litros?|kg|kilos?|gr|gramos?|ml|cc|mt|metros?)/i;

  productos.forEach(p => {
    const matches = (p.DesProd || "").match(formatoRegex);
    if (matches) matches.forEach(m => {
      const normalizado = normalizarFormatoStr(m.trim());
      if (esMedida.test(normalizado)) medidas.add(normalizado);
      else conteos.add(normalizado);
    });
  });

  // Medidas reales primero, luego conteos, máx 6
  return [...medidas, ...conteos].slice(0, 6);
}

// Normaliza un string de formato: "5lt"→"5 lt", "10kg"→"10 kg"
function normalizarFormatoStr(fmt) {
  return (fmt || "").toLowerCase().trim()
    .replace(/(\d)\s*(lt|litros?|kg|kilos?|gr|gramos?|ml|cc|mt|metros?|un\b)/gi, '$1 $2').trim();
}

// ─── Parsear texto de productos ───────────────────────────────────────────────
function parsearProductos(texto) {
  const items  = [];
  const partes = texto.split(/,|\sy\s/i);

  partes.forEach(parte => {
    parte = parte.trim();
    if (parte.length < 2) return;

    // Limpiar palabras de intención: "necesito lavaloza" → "lavaloza"
    parte = parte.replace(/^(necesito|quiero|quisiera|dame|me das?|busco|requiero|requerimos?|necesitamos?|queremos?|me puedes? (dar|cotizar)|cotizame|preciso|precisamos?)\s+/i, '').trim();

    // Limpiar prefijos de cantidad+envase: "una caja de X" → "X", "un bidón de X" → "X"
    parte = parte.replace(/^(un[ao]?s?|dos|tres|cuatro|cinco)\s+(caja|bidon|bidones|bolsa|saco|frasco|tarro|balde|tambor|galon|envase|botella|paquete|sobre)s?\s+(de\s+)?/i, '').trim();

    // Extraer formato inline "x 5lt", "formato 5 lt", "x 10kg", etc.
    let formatoEspecificado = null;
    const fmtMatch = parte.match(/\s+(?:x|formato)\s+(\d+(?:[.,]\d+)?\s*(?:lt|litros?|kg|kilos?|gr|gramos?|ml|cc|mt|metros?|l\b))\b/i);
    if (fmtMatch) {
      formatoEspecificado = normalizarFormatoStr(fmtMatch[1]);
      parte = parte.replace(fmtMatch[0], '').trim();
    }

    const UNIDADES_MEDIDA = /^(lt|litros?|kg|kilos?|gr|gramos?|ml|cc|mt|metros?)$/i;
    const UNIDADES = `paquetes?|unidades?|cajas?|litros?|kilos?|kg|lt|un|paq|bolsas?|rollos?|bidones?|tambores?|baldes?|galones?|frascos?|tarros?|sachet|sobres?|mt|metros?`;
    const matchFinal  = parte.match(new RegExp(`^(.+?)\\s+(\\d+)\\s*(${UNIDADES})?$`, 'i'));
    const matchInicio = parte.match(new RegExp(`^(\\d+)\\s*(${UNIDADES})?\\s+(.+)$`, 'i'));
    if (matchFinal) {
      const nombre = normalizar(matchFinal[1]);
      const num  = parseInt(matchFinal[2]);
      const unid = matchFinal[3] || "";
      if (nombre.length > 2) {
        if (unid && UNIDADES_MEDIDA.test(unid) && !formatoEspecificado) {
          // "toalla 350 mt" → el "350 mt" es especificación de formato, no cantidad
          items.push({ nombre, cantidad: 1, unidad: "unidades", cantidadEspecificada: false,
            formatoEspecificado: normalizarFormatoStr(`${num} ${unid}`) });
        } else {
          items.push({ nombre, cantidad: num, unidad: unid || "unidades", cantidadEspecificada: true, formatoEspecificado });
        }
      }
    } else if (matchInicio) {
      const nombre = normalizar(matchInicio[3]);
      const num  = parseInt(matchInicio[1]);
      const unid = matchInicio[2] || "";
      if (nombre.length > 2) {
        if (unid && UNIDADES_MEDIDA.test(unid) && !formatoEspecificado) {
          items.push({ nombre, cantidad: 1, unidad: "unidades", cantidadEspecificada: false,
            formatoEspecificado: normalizarFormatoStr(`${num} ${unid}`) });
        } else {
          items.push({ nombre, cantidad: num, unidad: unid || "unidades", cantidadEspecificada: true, formatoEspecificado });
        }
      }
    } else {
      const nombre = normalizar(parte);
      if (nombre.length > 2) items.push({ nombre, cantidad: 1, unidad: "unidades", cantidadEspecificada: false, formatoEspecificado });
    }
  });

  const unicos = [];
  const nombres = new Set();
  items.forEach(item => { if (!nombres.has(item.nombre)) { nombres.add(item.nombre); unicos.push(item); } });
  return unicos;
}

// ─── Cargar CSV (cacheado 10 min, timeout 8s, fallback a cache vencido) ───────
async function cargarCSV() {
  const now = Date.now();
  if (csvCache.rows && (now - csvCache.ts) < CSV_CACHE_TTL) {
    return csvCache.rows;
  }
  try {
    const resp = await axios.get(GOOGLE_SHEETS_CSV_URL, { timeout: 8000 });
    const rows = parse(resp.data, { columns: true, skip_empty_lines: true });
    csvCache = { rows, ts: now };
    return rows;
  } catch (err) {
    console.error("Error cargando CSV:", err.message);
    if (csvCache.rows) {
      console.warn("Usando cache CSV vencido como fallback");
      return csvCache.rows;
    }
    return null;
  }
}

// ─── Enviar cotización ────────────────────────────────────────────────────────
async function enviarCotizacionCompleta(phone, data) {
  try {
    const resend      = resendClient;
    const fecha       = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
    const confirmados = data.productosConfirmados;

    let filas = "";
    let total = 0;
    confirmados.forEach(item => {
      const p        = item.seleccionado;
      const subtotal = p.precio * item.cantidad;
      total += subtotal;
      filas += `<tr>
        <td style="padding:8px; border-bottom:1px solid #eee;">${escapeHtml(p.CodProd)}</td>
        <td style="padding:8px; border-bottom:1px solid #eee;">${escapeHtml(p.DesProd)}</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:right;">$${p.precio.toLocaleString("es-CL")}</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:center;">${item.cantidad} ${escapeHtml(item.unidad)}</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:right;">$${subtotal.toLocaleString("es-CL")}</td>
      </tr>`;
    });

    const htmlCotizacion = `
      <div style="font-family:Arial,sans-serif; max-width:650px; margin:auto; padding:24px; border:1px solid #e0e0e0; border-radius:8px;">
        <div style="background:#c0392b; padding:16px; border-radius:8px 8px 0 0; text-align:center;">
          <h2 style="color:white; margin:0;">COTIZACIÓN CINTEC</h2>
        </div>
        <div style="padding:20px;">
          <p>Estimado/a <strong>${escapeHtml(data.razonSocial)}</strong>,</p>
          <p><strong>Fecha:</strong> ${fecha} &nbsp; <strong>RUT:</strong> ${data.rut ? escapeHtml(data.rut) : "Por confirmar"}</p>
          ${data.esClienteNuevo ? '<p><em>Precios según lista vigente.</em></p>' : ''}
          <table style="width:100%; border-collapse:collapse; margin-top:10px;">
            <tr style="background:#c0392b; color:white;">
              <th style="padding:8px;">Código</th><th style="padding:8px;">Descripción</th>
              <th style="padding:8px; text-align:right;">Precio Unit.</th>
              <th style="padding:8px;">Cantidad</th><th style="padding:8px; text-align:right;">Subtotal</th>
            </tr>
            ${filas}
            <tr style="background:#f9f9f9; font-weight:bold;">
              <td colspan="4" style="padding:8px; text-align:right;">TOTAL:</td>
              <td style="padding:8px; text-align:right;">$${total.toLocaleString("es-CL")}</td>
            </tr>
          </table>
          <hr style="margin:20px 0;"/>
          <table style="width:100%; font-size:13px; color:#444;">
            <tr>
              <td>🕒 <strong>Vigencia de precios:</strong> 72 horas</td>
              <td>🚚 <strong>Despacho:</strong> Puerto Montt</td>
              <td>💳 <strong>Condición de pago:</strong> ${data.esClienteNuevo ? "Contado" : "30 días"}</td>
            </tr>
          </table>
          ${data.direccionEntrega ? `<p style="font-size:13px; color:#444; margin-top:10px;">📦 <strong>Lugar de entrega:</strong> ${escapeHtml(data.direccionEntrega)}${data.requiereFlete ? ` <em style="color:#e74c3c;">(fuera de zona de entrega directa — flete por cotizar)</em>` : ""}</p>` : ""}
          ${DATOS_BANCARIOS_HTML}
        </div>
      </div>`;

    await resend.emails.send({
      from: "CINTEC <onboarding@resend.dev>",
      to: data.emailCliente,
      subject: `Cotización CINTEC - ${fecha}`,
      html: htmlCotizacion,
    });

    await resend.emails.send({
      from: "Bot CINTEC <onboarding@resend.dev>",
      to: DESTINATION_EMAIL,
      subject: `📦 Cotización enviada - ${data.razonSocial}${data.sinRut ? " (SIN RUT)" : data.esClienteNuevo ? " (CLIENTE NUEVO)" : ""}`,
      html: `<h2 style="color:#c0392b;">📲 Cotización enviada vía WhatsApp</h2>
        <p><strong>Cliente:</strong> ${escapeHtml(data.razonSocial)} | RUT: ${data.rut ? escapeHtml(data.rut) : `<span style="color:#e74c3c;font-weight:bold">⚠️ SIN RUT — solicitar al facturar</span>`}</p>
        <p><strong>Email:</strong> ${escapeHtml(data.emailCliente)} | WhatsApp: +${escapeHtml(phone)}</p>
        <p><strong>Tipo:</strong> ${data.esClienteNuevo ? "🆕 Cliente nuevo (Precio Lista)" : "✅ Cliente existente"}</p>
        ${data.requiereFlete ? `<p style="color:#e74c3c;font-weight:bold;">🚚 REQUIERE FLETE — entrega fuera de zona directa (${escapeHtml(data.direccionEntrega || "")}). Cotizar valor del envío.</p>` : ""}
        ${htmlCotizacion}`,
    });

    registrarCotizacion(phone, data);
    await sendMessage(phone,
      `✅ ¡Listo! Tu cotización fue enviada a *${data.emailCliente}*.\n\n` +
      `¡Gracias por preferirnos! Escribe *hola* si necesitas algo más. 🙏`
    );
    await sendMessage(phone,
      `💳 *Formas de pago:*\n\n` +
      `1️⃣ Transferencia bancaria\n` +
      `2️⃣ Pago contra factura (clientes con crédito aprobado)\n\n` +
      DATOS_BANCARIOS_WSP + `\n\n` +
      `Cuando realices el pago, *envía el comprobante por este mismo chat* 📎 y nuestro equipo lo validará.`
    );
    console.log(`📧 Cotización enviada a ${data.emailCliente}`);
  } catch (err) {
    console.error("Error enviando cotización:", err.message);
    await sendMessage(phone, `⚠️ Error al enviar cotización. Por favor intenta nuevamente.`);
  }
}

// ─── Comprobante de pago (imagen/documento por WhatsApp) ─────────────────────
async function manejarComprobante(phone, msg) {
  try {
    const media   = msg.type === "image" ? msg.image : msg.document;
    const mediaId = media?.id;
    if (!mediaId) return;
    const mimeType = media.mime_type || "application/octet-stream";
    const ext      = mimeType.includes("pdf") ? "pdf" : (mimeType.split("/")[1] || "jpg");
    const filename = media.filename || `comprobante-${Date.now()}.${ext}`;

    // 1. Meta entrega una URL temporal del archivo a partir del media ID
    const meta = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    // 2. Descargar el binario (la URL requiere el mismo token)
    const file = await axios.get(meta.data.url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      responseType: "arraybuffer",
      maxContentLength: 15 * 1024 * 1024,
    });

    // Contexto del cliente: sesión activa o su última cotización registrada
    const session   = sessions[phone];
    const ultimaCot = [...cotizacionesLog].reverse().find(e => e.tipo === "cotizacion" && e.phone === phone);
    const razonSocial = session?.data?.razonSocial || ultimaCot?.razonSocial || "";
    const rut         = session?.data?.rut         || ultimaCot?.rut         || "";

    // 3. Reenviar a caja/ejecutivo con el archivo adjunto
    if (resendClient) {
      const fecha = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
      await resendClient.emails.send({
        from:    "Bot CINTEC <onboarding@resend.dev>",
        to:      DESTINATION_EMAIL,
        subject: `💰 Comprobante de pago recibido — ${razonSocial || "+" + phone}`,
        html: `<h2 style="color:#c0392b;">💰 Comprobante de pago recibido vía WhatsApp</h2>
          <p><strong>Fecha:</strong> ${fecha}</p>
          <p><strong>Cliente:</strong> ${escapeHtml(razonSocial || "–")} | RUT: ${escapeHtml(rut || "–")}</p>
          <p><strong>WhatsApp:</strong> <a href="https://wa.me/${escapeHtml(phone)}">+${escapeHtml(phone)}</a></p>
          ${ultimaCot ? `<p><strong>Última cotización:</strong> ${escapeHtml(ultimaCot.id)} por $${(ultimaCot.total || 0).toLocaleString("es-CL")} (${new Date(ultimaCot.timestamp).toLocaleString("es-CL", { timeZone: "America/Santiago" })})</p>` : `<p><em>Sin cotización previa registrada para este número.</em></p>`}
          <p>El comprobante viene adjunto. Validar el pago y confirmar al cliente.</p>`,
        attachments: [{ filename, content: Buffer.from(file.data).toString("base64") }],
      });
    }

    // El cliente pagó → cancelar seguimiento pendiente de esa cotización
    seguimientosPendientes.delete(phone);
    if (ultimaCot && ultimaCot.seguimientoEnviado && !ultimaCot.respuestaSeguimiento) {
      ultimaCot.respuestaSeguimiento = "pago_recibido";
      guardarLog();
    }

    registrarComprobante(phone, {
      razonSocial, rut, filename, mimeType,
      cotizacionId:    ultimaCot?.id    || "",
      totalCotizacion: ultimaCot?.total || 0,
    });
    await sendMessage(phone,
      `✅ *Recibimos tu comprobante de pago.*\n\n` +
      `Nuestro equipo validará la transferencia y te confirmaremos a la brevedad por este medio. 🙏`
    );
    console.log(`💰 Comprobante recibido de +${phone} (${filename})`);
  } catch (err) {
    console.error("Error procesando comprobante:", err.response?.data || err.message);
    await sendMessage(phone,
      `⚠️ No pudimos procesar el archivo. Intenta enviarlo nuevamente ` +
      `o mándalo por correo a *caja@cintecsa.cl*.`
    );
  }
}

// ─── Notificar respuesta a seguimiento ────────────────────────────────────────
async function notificarSeguimientoInteresado(phone, cot, mensaje) {
  if (!resendClient) return;
  try {
    const fecha = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
    await resendClient.emails.send({
      from:    "Bot CINTEC <onboarding@resend.dev>",
      to:      DESTINATION_EMAIL,
      subject: `🔥 Cliente respondió al seguimiento — ${cot?.razonSocial || "+" + phone}`,
      html: `<h2 style="color:#c0392b;">🔥 Respuesta al seguimiento de cotización</h2>
        <p><strong>Fecha:</strong> ${fecha}</p>
        <p><strong>Cliente:</strong> ${escapeHtml(cot?.razonSocial || "–")} | RUT: ${escapeHtml(cot?.rut || "–")}</p>
        <p><strong>WhatsApp:</strong> <a href="https://wa.me/${escapeHtml(phone)}">+${escapeHtml(phone)}</a></p>
        ${cot ? `<p><strong>Cotización:</strong> ${escapeHtml(cot.id)} por $${(cot.total || 0).toLocaleString("es-CL")} (${new Date(cot.timestamp).toLocaleString("es-CL", { timeZone: "America/Santiago" })})</p>` : ""}
        <p><strong>Mensaje del cliente:</strong></p>
        <div style="background:#f5f5f5;padding:12px 16px;border-radius:8px;">${escapeHtml(mensaje)}</div>
        <p>Cliente con interés activo — contactar para cerrar la venta. 🎯</p>`,
    });
  } catch (err) {
    console.error("Error notificando seguimiento:", err.message);
  }
}

// ─── Notificar handoff a ejecutivo ───────────────────────────────────────────
async function notificarHandoff(phone, data) {
  if (!resendClient) return;
  try {
    const resend = resendClient;
    const fecha  = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
    await resend.emails.send({
      from:    "Bot CINTEC <onboarding@resend.dev>",
      to:      DESTINATION_EMAIL,
      subject: `👤 Cliente solicita ejecutivo — ${data?.razonSocial || phone}`,
      html: `<h2>👤 Cliente solicita atención humana</h2>
        <p><strong>Fecha:</strong> ${fecha}</p>
        <p><strong>Cliente:</strong> ${escapeHtml(data?.razonSocial || "–")} | RUT: ${escapeHtml(data?.rut || "–")}</p>
        <p><strong>WhatsApp:</strong> <a href="https://wa.me/${escapeHtml(phone)}">+${escapeHtml(phone)}</a></p>
        <p>El cliente solicitó hablar con un ejecutivo durante el flujo de cotización.</p>`,
    });
  } catch (err) {
    console.error("Error notificando handoff:", err.message);
  }
}

// ─── Notificar bajo margen ────────────────────────────────────────────────────
async function notificarBajoMargen(phone, data, productosBajoMargen) {
  if (!resendClient) return;
  try {
    const resend = resendClient;
    const fecha  = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
    let filas = "";
    productosBajoMargen.forEach(p => {
      filas += `<tr>
        <td style="padding:8px;">${escapeHtml(p.producto?.CodProd || "-")}</td>
        <td style="padding:8px;">${escapeHtml(p.producto?.DesProd || p.nombre)}</td>
        <td style="padding:8px;">${escapeHtml(String(p.cantidad))} ${escapeHtml(p.unidad)}</td>
        <td style="padding:8px; color:#e74c3c;">${escapeHtml(String(p.producto?.margen || "-"))}%</td>
      </tr>`;
    });
    await resend.emails.send({
      from: "Bot CINTEC <onboarding@resend.dev>",
      to: DESTINATION_EMAIL,
      subject: `⚠️ Productos bajo margen - ${data.razonSocial}`,
      html: `<div style="font-family:Arial,sans-serif; max-width:600px; margin:auto; padding:24px; border:2px solid #e74c3c; border-radius:8px;">
        <h2 style="color:#e74c3c;">⚠️ Productos no cotizados por bajo margen</h2>
        <p><strong>Cliente:</strong> ${escapeHtml(data.razonSocial)} | RUT: ${escapeHtml(data.rut)} | WhatsApp: +${escapeHtml(phone)}</p>
        <p><strong>Fecha:</strong> ${fecha}</p>
        <table style="width:100%; border-collapse:collapse;">
          <tr style="background:#e74c3c; color:white;">
            <th style="padding:8px;">Código</th><th style="padding:8px;">Producto</th>
            <th style="padding:8px;">Cantidad</th><th style="padding:8px;">Margen</th>
          </tr>${filas}
        </table>
        <p style="margin-top:16px;">⚡ Acción requerida: revisar precios y contactar al cliente.</p>
      </div>`,
    });
  } catch (err) {
    console.error("Error notificando bajo margen:", err.message);
  }
}

// ─── Flujo Hidrolavadora ──────────────────────────────────────────────────────
const HIDRO_KEYWORDS = /hidro\s?lavadora|hidrolavadora|pressure\s?washer|lavadora\s?a\s?presion/i;

function esHidrolavadora(nombre) {
  return HIDRO_KEYWORDS.test(nombre);
}

const HIDRO_PREGUNTAS = [
  { key: "agua",      msg: "💧 ¿La hidrolavadora usará *agua fría* o *agua caliente*?",
    valida: t => /fri|calient|ambas|las dos/.test(normalizar(t)),
    error:  "Responde *agua fría* o *agua caliente*." },
  { key: "corriente", msg: "⚡ ¿Qué tipo de corriente eléctrica requiere?\n*1.* Monofásica (220V)\n*2.* Trifásica (380V)",
    valida: t => /^[12]$/.test(t.trim()) || /mono|trif|220|380|no se|no lo se/.test(normalizar(t)),
    error:  "Responde *1* (Monofásica 220V) o *2* (Trifásica 380V)." },
  { key: "bares",     msg: "🔧 ¿Qué presión necesita?\n_Indica en bares, ej: 100, 150, 200_",
    valida: t => /\d/.test(t) || /no se|no lo se|cualquier/.test(normalizar(t)),
    error:  "Indica la presión en *bares* con un número, ej: *150*. Si no la conoces, escribe *no sé*." },
  { key: "caudal",    msg: "🌊 ¿Qué caudal necesita?\n_Indica en litros/minuto, ej: 10, 15, 20_",
    valida: t => /\d/.test(t) || /no se|no lo se|cualquier/.test(normalizar(t)),
    error:  "Indica el caudal en *litros/minuto* con un número, ej: *15*. Si no lo conoces, escribe *no sé*." },
  { key: "modelo",    msg: "📋 ¿Tiene algún modelo de referencia?\n_Escribe marca y modelo, o *no* si no tiene_" },
  { key: "horas",     msg: "⏱️ ¿Cuántas horas al día operará la hidrolavadora?",
    valida: t => /\d/.test(t) || /media|una|dos|tres|cuatro|cinco|seis|ocho|todo el dia|jornada/.test(normalizar(t)),
    error:  "Indica cuántas *horas al día* operará, ej: *4*." },
  { key: "uso",       msg: "🏭 ¿Para qué uso la destinará?\n_Ej: lavado de vehículos, maquinaria industrial, pisos_" },
];

async function iniciarFlujoHidro(phone, session) {
  // Sacar TODOS los ítems de hidrolavadora de la cola: se cotizan aparte con especialista
  const hidroItems = session.data.itemsPendientes.filter(i => esHidrolavadora(i.nombre));
  session.data.itemsPendientes = session.data.itemsPendientes.filter(i => !esHidrolavadora(i.nombre));

  session.data.hidrosList   = [];
  session.data.hidrosActual = 1;
  session.data.hidroSpecs   = {};
  session.data.hidroPaso    = 0;

  // Si el cliente ya indicó cantidad (ej: "2 hidrolavadoras"), no volver a preguntar
  const todasEspecificadas = hidroItems.length > 0 && hidroItems.every(i => i.cantidadEspecificada);
  const declaradas = hidroItems.reduce((s, i) => s + (i.cantidad || 1), 0);

  if (todasEspecificadas) {
    await definirCantidadHidros(phone, session, declaradas);
  } else {
    session.step = STEPS.HIDRO_CANTIDAD;
    await sendMessage(phone,
      `🔩 ¡Perfecto! Las *hidrolavadoras* las cotiza directamente un especialista.\n\n` +
      `¿*Cuántas unidades* necesitas cotizar?`
    );
  }
}

async function definirCantidadHidros(phone, session, cantidad) {
  session.data.hidrosTotal = cantidad;
  if (cantidad === 1) {
    session.data.hidrosMismasSpecs = true;
    session.step = STEPS.HIDRO_SPECS;
    await sendMessage(phone,
      `🔩 Para cotizar tu *hidrolavadora* correctamente, necesito algunas especificaciones técnicas.\n\n` +
      HIDRO_PREGUNTAS[0].msg
    );
  } else {
    session.step = STEPS.HIDRO_DISTINTAS;
    await sendMessage(phone,
      `Las *${cantidad} hidrolavadoras* que necesitas, ¿tienen las *mismas características* o son *distintas*?\n\n` +
      `*1.* Todas iguales\n*2.* Distintas características`
    );
  }
}

const HIDRO_PALABRAS_NUM = { una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };

async function manejarHidroCantidad(phone, session, text) {
  const t = normalizar(text);
  let cantidad = null;
  const numMatch = t.match(/\d+/);
  if (numMatch) {
    cantidad = parseInt(numMatch[0]);
  } else {
    for (const [palabra, valor] of Object.entries(HIDRO_PALABRAS_NUM)) {
      if (new RegExp(`\\b${palabra}\\b`).test(t)) { cantidad = valor; break; }
    }
  }
  if (!cantidad || cantidad < 1 || cantidad > 50) {
    await sendMessage(phone, `⚠️ Indícame la cantidad con un número, ej: *1*, *2*, *3*.\n\n¿Cuántas hidrolavadoras necesitas cotizar?`);
    return;
  }
  await definirCantidadHidros(phone, session, cantidad);
}

async function manejarHidroDistintas(phone, session, text) {
  const t = normalizar(text);
  const iguales   = /^1\.?$/.test(t.trim()) || /igual|misma|identic/.test(t);
  const distintas = /^2\.?$/.test(t.trim()) || /distint|diferent|varia/.test(t);
  if (iguales === distintas) {
    await sendMessage(phone, `⚠️ Responde *1* si todas son iguales o *2* si tienen distintas características.`);
    return;
  }
  session.data.hidrosMismasSpecs = iguales;
  session.step = STEPS.HIDRO_SPECS;
  const intro = iguales
    ? `👍 Perfecto, te preguntaré las especificaciones *una sola vez* y aplicarán para las ${session.data.hidrosTotal} unidades.\n\n`
    : `👍 Entendido, te preguntaré las especificaciones de *cada una*. Empecemos con la *hidrolavadora 1:*\n\n`;
  await sendMessage(phone, intro + HIDRO_PREGUNTAS[0].msg);
}

async function manejarHidroSpecs(phone, session, text) {
  const paso = session.data.hidroPaso;
  const pregunta = HIDRO_PREGUNTAS[paso];

  // Detectar respuestas fuera de contexto (ej: "son 2" cuando se pregunta por el agua)
  if (pregunta.valida && !pregunta.valida(text)) {
    await sendMessage(phone,
      `🤔 Creo que eso no responde mi pregunta. ${pregunta.error}\n\n` + pregunta.msg
    );
    return;
  }

  // Guardar respuesta actual
  if (pregunta.key === "corriente") {
    session.data.hidroSpecs[pregunta.key] = /^[12]$/.test(text.trim())
      ? (text.trim() === "1" ? "Monofásica (220V)" : "Trifásica (380V)")
      : text;
  } else {
    session.data.hidroSpecs[pregunta.key] = text;
  }

  const siguientePaso = paso + 1;
  if (siguientePaso < HIDRO_PREGUNTAS.length) {
    session.data.hidroPaso = siguientePaso;
    await sendMessage(phone, HIDRO_PREGUNTAS[siguientePaso].msg);
    return;
  }

  // Terminó una ronda de especificaciones
  if (session.data.hidrosMismasSpecs) {
    // Una sola ronda aplica a todas las unidades
    session.data.hidrosList.push({
      nombre:   "Hidrolavadora",
      cantidad: session.data.hidrosTotal,
      specs: { ...session.data.hidroSpecs },
    });
    await finalizarFlujoHidro(phone, session);
  } else {
    // Ronda por unidad
    session.data.hidrosList.push({
      nombre:   `Hidrolavadora ${session.data.hidrosActual}`,
      cantidad: 1,
      specs: { ...session.data.hidroSpecs },
    });
    if (session.data.hidrosActual < session.data.hidrosTotal) {
      session.data.hidrosActual++;
      session.data.hidroSpecs = {};
      session.data.hidroPaso  = 0;
      await sendMessage(phone,
        `✅ Hidrolavadora *${session.data.hidrosActual - 1}/${session.data.hidrosTotal}* registrada.\n\n` +
        `Ahora las especificaciones de la *hidrolavadora ${session.data.hidrosActual}:*\n\n` +
        HIDRO_PREGUNTAS[0].msg
      );
    } else {
      await finalizarFlujoHidro(phone, session);
    }
  }
}

async function finalizarFlujoHidro(phone, session) {
  // Todas las hidros procesadas → UN solo email al técnico con todo
  session.step = STEPS.HIDRO_ESPERANDO;
  await enviarSolicitudHidroEmail(phone, session.data);
  hidroSolicitudes.set(phone, { sentAt: Date.now(), data: { ...session.data }, reminderCount: 0 });
  const n = session.data.hidrosTotal || 1;
  await sendMessage(phone,
    `✅ ¡Listo! Registramos las especificaciones ${n > 1 ? `de tus *${n} hidrolavadoras*` : "de tu *hidrolavadora*"}.\n\n` +
    `Tu solicitud fue derivada a un *especialista* que buscará las mejores opciones.\n\n` +
    `Te notificaremos por este medio cuando tengamos la cotización. ⏳`
  );
  if (session.data.itemsPendientes.length > 0) {
    await procesarSiguienteProducto(phone, session);
  }
}

async function manejarHidroEmail(phone, session, text) {
  if (!text.includes("@") || !text.includes(".")) {
    await sendMessage(phone, `⚠️ Ingresa un correo electrónico válido.`);
    return;
  }
  const emailCliente = text.toLowerCase();
  const respuesta    = session.data.hidroRespuesta || "";
  const resend       = resendClient;
  try {
    await resend.emails.send({
      from: "Bot CINTEC <onboarding@resend.dev>",
      to:   emailCliente,
      subject: "Cotización Hidrolavadora - CINTEC",
      html: `<h2>Cotización Hidrolavadora</h2>
        <p>Estimado/a <strong>${escapeHtml(session.data.razonSocial)}</strong>,</p>
        <p>A continuación le presentamos la cotización preparada por nuestro especialista:</p>
        <div style="background:#f5f5f5;padding:16px;border-radius:8px;white-space:pre-wrap;">${escapeHtml(respuesta).replace(/\n/g,"<br>")}</div>
        <p>Cualquier consulta, puede responder este correo o contactarnos por WhatsApp.</p>
        <p><em>Equipo CINTEC</em></p>`,
    });
    await sendMessage(phone, `✅ La cotización fue enviada a *${emailCliente}*.\n\n¡Gracias por preferirnos! Escribe *hola* si necesitas algo más.`);
  } catch (err) {
    await sendMessage(phone, `⚠️ No pude enviar el correo. Intenta nuevamente.`);
    console.error("Error enviando cotización hidro:", err.message);
    return;
  }
  session.step = STEPS.DONE;
  setTimeout(() => delete sessions[phone], 5 * 60 * 1000);
}

function buildHidroEmailHtml(phone, data, esRecordatorio = false) {
  const fecha    = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
  const hidros   = data.hidrosList?.length ? data.hidrosList
                   : [{ nombre: "Hidrolavadora", cantidad: 1, specs: data.hidroSpecs || {} }];
  const baseUrl  = process.env.BASE_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "https://whatsapp-bot-production-8bc1.up.railway.app");
  const hidrosB64 = Buffer.from(JSON.stringify(hidros)).toString("base64url");
  const formUrl  = `${baseUrl}/especialista/form?phone=${phone}&nombre=${encodeURIComponent(data.razonSocial)}&token=${SPECIALIST_TOKEN}&hidros=${hidrosB64}`;

  const labelSpecs = { agua:"Tipo de agua", corriente:"Corriente eléctrica", bares:"Presión (bares)",
    caudal:"Caudal (L/min)", modelo:"Modelo referencia", horas:"Horas de uso/día", uso:"Uso destinado" };

  const tablas = hidros.map((h, i) => {
    const filas = HIDRO_PREGUNTAS.map(p =>
      `<tr><td style="padding:6px 12px;font-weight:bold;color:#555;width:40%">${escapeHtml(labelSpecs[p.key] || p.key)}</td>
       <td style="padding:6px 12px">${escapeHtml(h.specs[p.key] || "–")}</td></tr>`
    ).join("");
    return `
      <h3 style="margin:18px 0 6px;color:#333">
        ${hidros.length > 1 ? `🔩 Hidrolavadora ${i + 1}/${hidros.length}: ${escapeHtml(h.nombre)}` : "🔩 Especificaciones técnicas"}
        ${h.cantidad > 1 ? `<span style="font-size:13px;color:#888"> · Cantidad: ${h.cantidad}</span>` : ""}
      </h3>
      <table border="1" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px">
        <tr style="background:#f5f5f5"><th style="padding:6px 12px;text-align:left">Especificación</th><th style="padding:6px 12px;text-align:left">Respuesta del cliente</th></tr>
        ${filas}
      </table>`;
  }).join(`<hr style="margin:20px 0;border:none;border-top:1px solid #eee">`);

  const alertaRecordatorio = esRecordatorio
    ? `<div style="background:#FEF2F2;border-left:4px solid #ED0914;padding:12px 16px;margin-bottom:16px;border-radius:4px">
         <strong style="color:#ED0914">⏰ Recordatorio:</strong> Esta solicitud lleva más de 2 horas sin respuesta.
       </div>` : "";

  const totalUnidades = hidros.reduce((s, h) => s + (h.cantidad || 1), 0);
  return {
    subject: `${esRecordatorio ? "⏰ RECORDATORIO: " : ""}🔩 Solicitud Hidrolavadora${totalUnidades > 1 ? ` (${totalUnidades} equipos)` : ""} — ${data.razonSocial}`,
    html: `
      ${alertaRecordatorio}
      <h2>🔩 ${esRecordatorio ? "Recordatorio: " : ""}Solicitud de hidrolavadora${totalUnidades > 1 ? `s (${totalUnidades} equipos)` : ""}</h2>
      <p><strong>Fecha:</strong> ${fecha}</p>
      <p><strong>Cliente:</strong> ${escapeHtml(data.razonSocial)} | RUT: ${escapeHtml(data.rut || "–")} | WhatsApp: +${escapeHtml(phone)}</p>
      ${tablas}
      <br>
      <p>
        <a href="${formUrl}" style="background:#ed0914;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block">
          📩 Responder cotización al cliente
        </a>
      </p>
      <p style="color:#888;font-size:12px">O copia este enlace: ${formUrl}</p>`,
  };
}

async function enviarSolicitudHidroEmail(phone, data) {
  if (!resendClient) return;
  try {
    const { subject, html } = buildHidroEmailHtml(phone, data, false);
    await resendClient.emails.send({ from: "Bot CINTEC <onboarding@resend.dev>", to: DESTINATION_EMAIL, subject, html });
  } catch (err) { console.error("Error enviando solicitud hidro:", err.message); }
}

async function reenviarRecordatorioHidro(phone, data) {
  if (!resendClient) return;
  try {
    const { subject, html } = buildHidroEmailHtml(phone, data, true);
    await resendClient.emails.send({ from: "Bot CINTEC <onboarding@resend.dev>", to: DESTINATION_EMAIL, subject, html });
  } catch (err) { console.error("Error enviando recordatorio hidro:", err.message); }
}

// ─── Notificar interno ────────────────────────────────────────────────────────
async function notificarInterno(phone, data) {
  if (!resendClient) return;
  try {
    const resend = resendClient;
    const fecha  = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
    await resend.emails.send({
      from: "Bot CINTEC <onboarding@resend.dev>",
      to: DESTINATION_EMAIL,
      subject: `📋 Solicitud sin cotización - ${data.razonSocial}`,
      html: `<h2>📋 Solicitud sin productos para cotizar</h2>
        <p><strong>Fecha:</strong> ${fecha}</p>
        <p><strong>Cliente:</strong> ${escapeHtml(data.razonSocial)} | RUT: ${escapeHtml(data.rut)} | WhatsApp: +${escapeHtml(phone)}</p>
        <p>Productos solicitados: ${escapeHtml(data.textoProductos)}</p>`,
    });
  } catch (err) {
    console.error("Error notificando interno:", err.message);
  }
}

// ─── Enviar mensaje WhatsApp ──────────────────────────────────────────────────
async function sendMessage(to, body) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Error enviando mensaje:", err.response?.data || err.message);
  }
}

// Plantillas pre-aprobadas por Meta — únicas permitidas fuera de la ventana de 24h
async function sendTemplate(to, templateName, bodyParams = []) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: "es" },
          components: bodyParams.length ? [{
            type: "body",
            parameters: bodyParams.map(t => ({ type: "text", text: String(t) })),
          }] : [],
        },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    return true;
  } catch (err) {
    console.error("Error enviando plantilla:", err.response?.data || err.message);
    return false;
  }
}

// ─── Validación RUT chileno ───────────────────────────────────────────────────
// Normaliza RUT a solo dígitos + DV, aceptando con/sin puntos, con/sin guion
function normalizarRUT(rut) {
  return rut.trim().replace(/\./g, "").replace(/[\s-]/g, "").toUpperCase();
}

function validarRUT(rut) {
  const cleaned = normalizarRUT(rut);
  if (!/^\d{7,8}[0-9K]$/.test(cleaned)) return false;
  const body = cleaned.slice(0, -1);
  const dv   = cleaned.slice(-1);
  let sum = 0, mul = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += parseInt(body[i]) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const exp   = 11 - (sum % 11);
  const dvExp = exp === 11 ? "0" : exp === 10 ? "K" : String(exp);
  return dv === dvExp;
}

// ─── Especialista: formulario y recepción de cotización hidrolavadora ─────────
function escapeHtml(str) {
  return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

app.get("/especialista/form", (req, res) => {
  if (!checkHttpRateLimit(req.ip, 10)) return res.status(429).send("Demasiadas solicitudes. Intenta en un minuto.");
  const { phone, nombre, token, hidros: hidrosB64, specs: specsB64 } = req.query;
  if (!phone || !token || token !== SPECIALIST_TOKEN) return res.status(401).send("No autorizado.");

  let hidros = [];
  try {
    if (hidrosB64) hidros = JSON.parse(Buffer.from(hidrosB64, "base64url").toString());
    else if (specsB64) hidros = [{ nombre: "Hidrolavadora", cantidad: 1, specs: JSON.parse(Buffer.from(specsB64, "base64url").toString()) }];
  } catch {}

  const labelSpecs = {
    agua:"Tipo de agua", corriente:"Corriente eléctrica", bares:"Presión requerida",
    caudal:"Caudal requerido", modelo:"Modelo de referencia", horas:"Horas de uso/día", uso:"Uso destinado"
  };

  const tablasSpecs = hidros.map((h, i) => {
    const filas = Object.entries(labelSpecs)
      .filter(([k]) => h.specs?.[k])
      .map(([k, label]) => `<tr><td class="sl">${escapeHtml(label)}</td><td>${escapeHtml(h.specs[k])}</td></tr>`)
      .join("");
    return `<div class="sec">
      <div class="sec-title">${hidros.length > 1 ? `Hidrolavadora ${i + 1}/${hidros.length} — ${escapeHtml(h.nombre)}${h.cantidad > 1 ? ` (×${h.cantidad})` : ""}` : "Especificaciones solicitadas"}</div>
      <table class="specs">${filas || "<tr><td colspan='2' style='color:#aaa'>Sin especificaciones</td></tr>"}</table>
    </div>`;
  }).join("");

  res.setHeader("Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'"
  );
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cotización Hidrolavadora — CINTEC</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,sans-serif;background:#f4f4f4;padding:16px}
    .card{background:#fff;max-width:600px;margin:0 auto;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)}
    .hdr{background:#ed0914;color:#fff;padding:16px 20px}
    .hdr h2{font-size:17px}
    .hdr p{font-size:12px;opacity:.85;margin-top:3px}
    .body{padding:18px 20px}
    .sec{margin-bottom:18px}
    .sec-title{font-size:10px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-bottom:8px;border-bottom:1px solid #eee;padding-bottom:4px}
    .info-box{background:#fafafa;border:1px solid #e8e8e8;border-radius:6px;padding:10px 14px;font-size:14px;line-height:1.8}
    table.specs{width:100%;border-collapse:collapse;font-size:13px}
    table.specs td{padding:5px 8px;border-bottom:1px solid #f0f0f0}
    table.specs td.sl{font-weight:bold;color:#555;width:42%}
    .field{margin-bottom:12px}
    label{display:block;font-size:13px;font-weight:bold;color:#333;margin-bottom:4px}
    label .hint{font-weight:normal;color:#aaa;font-size:11px}
    input[type=text],textarea{width:100%;padding:8px 11px;font-size:14px;border:1px solid #ccc;border-radius:6px;font-family:Arial,sans-serif}
    input[type=text]:focus,textarea:focus{border-color:#ed0914;outline:none}
    textarea{height:72px;resize:vertical}
    .row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .btn{width:100%;background:#ed0914;color:#fff;border:none;padding:13px;font-size:15px;font-weight:bold;border-radius:6px;cursor:pointer;margin-top:4px}
    .btn:hover{background:#c00}
  </style>
</head>
<body>
<div class="card">
  <div class="hdr">
    <h2>🔩 Cotización Hidrolavadora</h2>
    <p>Completa los campos y envía la cotización al cliente</p>
  </div>
  <div class="body">

    <div class="sec">
      <div class="sec-title">Datos del cliente</div>
      <div class="info-box">
        <strong>Cliente:</strong> ${escapeHtml(nombre)}<br>
        <strong>WhatsApp:</strong> +${escapeHtml(phone)}
      </div>
    </div>

    ${tablasSpecs}

    <form method="POST" action="/especialista/cotizacion">
      <input type="hidden" name="phone" value="${escapeHtml(phone)}">
      <input type="hidden" name="token" value="${escapeHtml(token)}">

      <div class="sec">
        <div class="sec-title">Equipo recomendado</div>

        <div class="field">
          <label>Modelo recomendado <span class="hint">marca y modelo exacto</span></label>
          <input type="text" name="modelo" placeholder="Ej: Karcher HD 7/18-4 Classic" required>
        </div>

        <div class="row2">
          <div class="field">
            <label>Precio neto <span class="hint">sin IVA</span></label>
            <input type="text" name="precio_neto" placeholder="Ej: $850.000" required>
          </div>
          <div class="field">
            <label>Precio c/IVA <span class="hint">opcional</span></label>
            <input type="text" name="precio_iva" placeholder="Ej: $1.011.500">
          </div>
        </div>

        <div class="field">
          <label>Características técnicas <span class="hint">presión, caudal, potencia, voltaje, peso</span></label>
          <input type="text" name="caracteristicas" placeholder="Ej: 180 bar, 18 lt/min, Motor 3HP monofásico 220V">
        </div>

        <div class="row2">
          <div class="field">
            <label>Plazo de entrega</label>
            <input type="text" name="plazo" placeholder="Ej: 5-7 días hábiles" required>
          </div>
          <div class="field">
            <label>Garantía</label>
            <input type="text" name="garantia" placeholder="Ej: 12 meses" required>
          </div>
        </div>

        <div class="field">
          <label>Condiciones de pago</label>
          <input type="text" name="condiciones" placeholder="Ej: Transferencia bancaria, 50% anticipo" required>
        </div>

        <div class="field">
          <label>Observaciones <span class="hint">accesorios incluidos, stock, notas</span></label>
          <textarea name="observaciones" placeholder="Ej: Incluye manguera 10 mt, lanza y pistola. Stock disponible."></textarea>
        </div>
      </div>

      <button class="btn" type="submit">📩 Enviar cotización al cliente</button>
    </form>
  </div>
</div>
</body>
</html>`);
});

app.post("/especialista/cotizacion", express.urlencoded({ extended: true }), async (req, res) => {
  if (!checkHttpRateLimit(req.ip, 10)) return res.status(429).send("Demasiadas solicitudes. Intenta en un minuto.");
  const { phone, token, modelo, precio_neto, precio_iva, caracteristicas, plazo, garantia, condiciones, observaciones } = req.body;
  if (!phone || !modelo || !precio_neto) return res.status(400).send("Faltan campos obligatorios.");
  if (token !== SPECIALIST_TOKEN) return res.status(401).send("Token inválido.");

  // Componer mensaje estructurado para el cliente
  const partes = [
    `🔩 *Modelo:* ${modelo}`,
    `💰 *Precio neto:* ${precio_neto}${precio_iva ? `  |  *c/IVA:* ${precio_iva}` : ""}`,
    caracteristicas && `⚙️ *Características:* ${caracteristicas}`,
    `📦 *Plazo de entrega:* ${plazo}`,
    `🛡️ *Garantía:* ${garantia}`,
    `💳 *Condiciones:* ${condiciones}`,
    observaciones && `📝 *Observaciones:* ${observaciones}`,
  ].filter(Boolean).join("\n");
  const respuesta = partes;

  // El técnico respondió — cancelar recordatorios pendientes
  hidroSolicitudes.delete(phone);

  const session = sessions[phone];
  if (session) {
    session.data.hidroRespuesta = respuesta;
    session.step = STEPS.HIDRO_EMAIL;
    await sendMessage(phone,
      `✅ ¡Tenemos la cotización de tu hidrolavadora!\n\n` +
      `¿A qué *correo electrónico* te enviamos el detalle?`
    );
  } else {
    // Sesión expiró — guardar en mapa y reiniciar sesión mínima
    hidroPendientes.set(phone, respuesta);
    sessions[phone] = { step: STEPS.HIDRO_EMAIL, data: { hidroRespuesta: respuesta, razonSocial: "Cliente" } };
    await sendMessage(phone,
      `✅ ¡Tenemos la cotización de tu hidrolavadora!\n\n` +
      `¿A qué *correo electrónico* te enviamos el detalle?`
    );
  }

  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>OK</title></head>
<body style="font-family:Arial;max-width:500px;margin:60px auto;text-align:center">
  <h2 style="color:#27ae60">✅ Cotización enviada al cliente</h2>
  <p>El cliente recibirá el mensaje por WhatsApp y podrá indicar su correo.</p>
</body></html>`);
});

// ─── Sesiones del panel de control ───────────────────────────────────────────
const panelSessions = new Map();
const PANEL_TTL = 8 * 60 * 60 * 1000;

function getPanelSession(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)panel_sid=([^;]+)/);
  if (!m) return null;
  const exp = panelSessions.get(m[1]);
  if (!exp || Date.now() > exp) { panelSessions.delete(m[1]); return null; }
  return m[1];
}
function createPanelSession(res) {
  const sid = crypto.randomBytes(32).toString("hex");
  panelSessions.set(sid, Date.now() + PANEL_TTL);
  res.setHeader("Set-Cookie", `panel_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${PANEL_TTL / 1000}`);
}
function clearPanelSession(req, res) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)panel_sid=([^;]+)/);
  if (m) panelSessions.delete(m[1]);
  res.setHeader("Set-Cookie", "panel_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
}

// ─── Panel de control KPI ─────────────────────────────────────────────────────
function buildKPIPage(nonce, showLogout = false) {
  const cotizaciones  = cotizacionesLog.filter(e => e.tipo === "cotizacion");
  const contactos     = cotizacionesLog.filter(e => e.tipo === "contacto");
  const problematicas = cotizacionesLog.filter(e => e.tipo === "loop" || e.tipo === "sin_respuesta");
  const comprobantes  = cotizacionesLog.filter(e => e.tipo === "comprobante");
  const consultas     = cotizacionesLog.filter(e => e.tipo === "consulta");
  const hidroPendientesList = [...hidroSolicitudes.entries()]
    .map(([phone, entry]) => ({
      phone,
      sentAt:        entry.sentAt,
      data:          entry.data,
      reminderCount: entry.reminderCount,
      elapsed:       Date.now() - entry.sentAt,
    }))
    .sort((a, b) => b.elapsed - a.elapsed);

  // ── KPIs principales ────────────────────────────────────────────────────────
  const nuevos      = cotizaciones.filter(c => c.esClienteNuevo).length;
  const existentes  = cotizaciones.filter(c => !c.esClienteNuevo).length;
  const totalMonto  = cotizaciones.reduce((s, c) => s + (c.total || 0), 0);
  const ticketProm  = cotizaciones.length ? Math.round(totalMonto / cotizaciones.length) : 0;
  const clientesUnicos = new Set(cotizaciones.map(c => c.rut).filter(Boolean)).size;

  // Últimos 7 días
  const hace7  = Date.now() - 7  * 86400000;
  const hace30 = Date.now() - 30 * 86400000;
  const cot7d  = cotizaciones.filter(c => new Date(c.timestamp).getTime() > hace7).length;
  const monto7d = cotizaciones.filter(c => new Date(c.timestamp).getTime() > hace7)
                              .reduce((s, c) => s + (c.total || 0), 0);

  // ── Cotizaciones por día (30 días) ──────────────────────────────────────────
  const porDia = {};
  cotizaciones.filter(c => new Date(c.timestamp).getTime() > hace30).forEach(c => {
    const dia = c.timestamp.slice(0, 10);
    porDia[dia] = (porDia[dia] || 0) + 1;
  });
  const diasOrdenados = Object.keys(porDia).sort();

  // ── Por hora del día ────────────────────────────────────────────────────────
  const porHora = Array(24).fill(0);
  cotizaciones.forEach(c => {
    const h = new Date(c.timestamp).getHours();
    porHora[h]++;
  });

  // ── Productos: veces, unidades y monto ──────────────────────────────────────
  const prodMap = {};
  cotizaciones.forEach(c => {
    (c.productos || []).forEach(p => {
      const k = p.codigo || p.descripcion;
      if (!prodMap[k]) prodMap[k] = { descripcion: p.descripcion || k, veces: 0, unidades: 0, monto: 0 };
      prodMap[k].veces++;
      prodMap[k].unidades += (p.cantidad || 1);
      prodMap[k].monto    += (p.subtotal || 0);
    });
  });
  const topProdVeces = Object.values(prodMap).sort((a, b) => b.veces  - a.veces ).slice(0, 8);
  const topProdMonto = Object.values(prodMap).sort((a, b) => b.monto  - a.monto ).slice(0, 8);

  // ── Top clientes por monto ──────────────────────────────────────────────────
  const clienteMap = {};
  cotizaciones.forEach(c => {
    const k = c.rut || c.phone;
    if (!clienteMap[k]) clienteMap[k] = { nombre: c.razonSocial || c.rut || c.phone, monto: 0, veces: 0 };
    clienteMap[k].monto += (c.total || 0);
    clienteMap[k].veces++;
  });
  const topClientes = Object.values(clienteMap).sort((a, b) => b.monto - a.monto).slice(0, 10);

  const j = v => JSON.stringify(v);

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Panel CINTEC · Bot WhatsApp</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;background:#F1F5F9;color:#1E293B;min-height:100vh}

/* ── Header ── */
.hdr{background:linear-gradient(135deg,#8B0008 0%,#ED0914 60%,#FF4444 100%);color:#fff;padding:20px 32px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 2px 12px rgba(0,0,0,.25)}
.hdr-left{display:flex;align-items:center;gap:14px}
.hdr-logo{font-size:28px;font-weight:900;letter-spacing:-1px;color:#fff}
.hdr-logo span{opacity:.6;font-weight:300}
.hdr-title{font-size:15px;font-weight:600;opacity:.9}
.hdr-sub{font-size:11px;opacity:.65;margin-top:2px}
.hdr-right{text-align:right;font-size:11px;opacity:.7;line-height:1.6}
.badge-live{display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,.2);border-radius:20px;padding:3px 10px;font-size:11px;font-weight:600}
.dot-live{width:7px;height:7px;background:#4ADE80;border-radius:50%;animation:pulse 1.8s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

/* ── Layout ── */
.wrap{padding:24px 32px;max-width:1400px;margin:0 auto}
.row{display:grid;gap:18px;margin-bottom:18px}
.row-6{grid-template-columns:repeat(6,1fr)}
.row-2{grid-template-columns:1fr 1fr}
.row-3{grid-template-columns:2fr 1fr 1fr}
.row-1{grid-template-columns:1fr}
@media(max-width:1100px){.row-6{grid-template-columns:repeat(3,1fr)}.row-2,.row-3{grid-template-columns:1fr}}

/* ── KPI Card ── */
.kpi{background:#fff;border-radius:14px;padding:18px 20px;box-shadow:0 1px 6px rgba(0,0,0,.07);border-top:3px solid transparent;transition:transform .15s}
.kpi:hover{transform:translateY(-2px)}
.kpi.red{border-color:#ED0914}
.kpi.green{border-color:#22C55E}
.kpi.blue{border-color:#3B82F6}
.kpi.purple{border-color:#A855F7}
.kpi.orange{border-color:#F97316}
.kpi.teal{border-color:#14B8A6}
.kpi-icon{font-size:22px;margin-bottom:6px}
.kpi-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#94A3B8}
.kpi-value{font-size:26px;font-weight:800;color:#1E293B;margin:4px 0 2px;line-height:1}
.kpi-sub{font-size:11px;color:#94A3B8}
.kpi-sub b{color:#22C55E}

/* ── Panel ── */
.panel{background:#fff;border-radius:14px;padding:20px 22px;box-shadow:0 1px 6px rgba(0,0,0,.07)}
.panel-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #F1F5F9}
.panel-title{font-size:13px;font-weight:700;color:#374151;display:flex;align-items:center;gap:7px}
.panel-pill{font-size:10px;background:#FEF2F2;color:#ED0914;border-radius:20px;padding:2px 9px;font-weight:700}
.chart-wrap{position:relative;height:200px}
.chart-wrap-sm{position:relative;height:170px}

/* ── Tabla ── */
table{width:100%;border-collapse:collapse;font-size:12.5px}
thead th{background:#F8FAFC;padding:8px 12px;text-align:left;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#94A3B8;border-bottom:1px solid #E2E8F0}
tbody td{padding:9px 12px;border-bottom:1px solid #F1F5F9;color:#374151}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:#FAFAFA}
.tag{display:inline-block;border-radius:20px;padding:2px 8px;font-size:10px;font-weight:700}
.tag-new{background:#DCFCE7;color:#15803D}
.tag-rec{background:#DBEAFE;color:#1D4ED8}
.tag-loop{background:#FEF9C3;color:#92400E}
.tag-sin{background:#FEE2E2;color:#991B1B}
.rank{width:22px;height:22px;border-radius:50%;background:#F1F5F9;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#64748B}
.rank.top{background:#FEF2F2;color:#ED0914}

/* ── Vacío ── */
.empty{text-align:center;padding:32px;color:#CBD5E1;font-size:13px}

/* ── Footer ── */
.footer{text-align:center;padding:24px;font-size:11px;color:#CBD5E1}
</style>
<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
</head>
<body>

<div class="hdr">
  <div class="hdr-left">
    <img src="https://assets.jumpseller.com/store/cintecsa/themes/954643/settings/e6f636bc6ca9fb2e0341/logo%20cintec%20color_.png?1771944795"
         style="height:36px;filter:brightness(0) invert(1)" alt="CINTEC" onerror="this.style.display='none'">
    <div>
      <div class="hdr-title">Panel de Control · Bot WhatsApp</div>
      <div class="hdr-sub">Automatización de cotizaciones CINTEC</div>
    </div>
  </div>
  <div style="display:flex;align-items:center;gap:16px">
    <span class="badge-live"><span class="dot-live"></span>En vivo</span>
    <div class="hdr-right">
      Actualizado<br>${new Date().toLocaleString("es-CL",{timeZone:"America/Santiago"})}<br>
      <a href="" style="color:rgba(255,255,255,.7);font-size:10px;text-decoration:none">↻ Actualizar</a>
    </div>
    ${showLogout ? `<a href="/panel/logout" style="color:rgba(255,255,255,.85);font-size:11px;text-decoration:none;background:rgba(0,0,0,.25);border-radius:20px;padding:6px 16px;font-weight:600;white-space:nowrap">⎋ Cerrar sesión</a>` : ""}
  </div>
</div>

<div class="wrap">

  <!-- ── Fila 1: KPIs ── -->
  <div class="row row-6">
    <div class="kpi red">
      <div class="kpi-icon">📋</div>
      <div class="kpi-label">Total cotizaciones</div>
      <div class="kpi-value">${cotizaciones.length}</div>
      <div class="kpi-sub"><b>${cot7d}</b> últimos 7 días</div>
    </div>
    <div class="kpi green">
      <div class="kpi-icon">💵</div>
      <div class="kpi-label">Monto total cotizado</div>
      <div class="kpi-value" style="font-size:18px">$${totalMonto.toLocaleString("es-CL")}</div>
      <div class="kpi-sub"><b>$${monto7d.toLocaleString("es-CL")}</b> últ. 7 días</div>
    </div>
    <div class="kpi blue">
      <div class="kpi-icon">🎯</div>
      <div class="kpi-label">Ticket promedio</div>
      <div class="kpi-value" style="font-size:20px">$${ticketProm.toLocaleString("es-CL")}</div>
      <div class="kpi-sub">por cotización</div>
    </div>
    <div class="kpi teal">
      <div class="kpi-icon">👥</div>
      <div class="kpi-label">Clientes únicos</div>
      <div class="kpi-value">${clientesUnicos}</div>
      <div class="kpi-sub">${nuevos} nuevos · ${existentes} recurrentes</div>
    </div>
    <div class="kpi purple">
      <div class="kpi-icon">📞</div>
      <div class="kpi-label">Solicitudes ejecutivo</div>
      <div class="kpi-value">${contactos.length}</div>
      <div class="kpi-sub">derivadas a ventas</div>
    </div>
    <div class="kpi orange">
      <div class="kpi-icon">⚠️</div>
      <div class="kpi-label">Conv. problemáticas</div>
      <div class="kpi-value">${problematicas.length}</div>
      <div class="kpi-sub">loops + sin respuesta</div>
    </div>
  </div>

  <!-- ── Fila 2: Gráfico diario + Dona ── -->
  <div class="row row-2">
    <div class="panel">
      <div class="panel-hdr">
        <div class="panel-title">📈 Cotizaciones por día <span class="panel-pill">30 días</span></div>
      </div>
      <div class="chart-wrap">
        <canvas id="chartDia"></canvas>
      </div>
    </div>
    <div class="panel">
      <div class="panel-hdr">
        <div class="panel-title">🥧 Nuevos vs Recurrentes</div>
      </div>
      <div class="chart-wrap">
        <canvas id="chartDona"></canvas>
      </div>
    </div>
  </div>

  <!-- ── Fila 3: Por hora + Top productos por monto ── -->
  <div class="row row-2">
    <div class="panel">
      <div class="panel-hdr">
        <div class="panel-title">🕐 Actividad por hora del día</div>
      </div>
      <div class="chart-wrap">
        <canvas id="chartHora"></canvas>
      </div>
    </div>
    <div class="panel">
      <div class="panel-hdr">
        <div class="panel-title">💰 Top productos por monto cotizado</div>
      </div>
      <div class="chart-wrap">
        <canvas id="chartMonto"></canvas>
      </div>
    </div>
  </div>

  <!-- ── Fila 4: Top clientes + Top productos por frecuencia ── -->
  <div class="row row-2">
    <div class="panel">
      <div class="panel-hdr">
        <div class="panel-title">🏆 Top clientes por monto</div>
      </div>
      ${topClientes.length === 0 ? `<div class="empty">Sin datos aún</div>` : `
      <table>
        <thead><tr><th>#</th><th>Cliente</th><th style="text-align:right">Monto total</th><th style="text-align:center">Cotizaciones</th></tr></thead>
        <tbody>
        ${topClientes.map((c, i) => `
          <tr>
            <td><span class="rank${i < 3 ? " top" : ""}">${i + 1}</span></td>
            <td style="font-weight:600">${escapeHtml(c.nombre)}</td>
            <td style="text-align:right;font-weight:700;color:#ED0914">$${c.monto.toLocaleString("es-CL")}</td>
            <td style="text-align:center;color:#94A3B8">${c.veces}</td>
          </tr>`).join("")}
        </tbody>
      </table>`}
    </div>
    <div class="panel">
      <div class="panel-hdr">
        <div class="panel-title">📦 Top productos por frecuencia</div>
      </div>
      ${topProdVeces.length === 0 ? `<div class="empty">Sin datos aún</div>` : `
      <table>
        <thead><tr><th>#</th><th>Producto</th><th style="text-align:center">Veces</th><th style="text-align:center">Unidades</th></tr></thead>
        <tbody>
        ${topProdVeces.map((p, i) => `
          <tr>
            <td><span class="rank${i < 3 ? " top" : ""}">${i + 1}</span></td>
            <td>${escapeHtml(p.descripcion)}</td>
            <td style="text-align:center;font-weight:700">${p.veces}</td>
            <td style="text-align:center;color:#94A3B8">${p.unidades}</td>
          </tr>`).join("")}
        </tbody>
      </table>`}
    </div>
  </div>

  <!-- ── Fila 5: Últimas cotizaciones ── -->
  <div class="row row-1">
    <div class="panel">
      <div class="panel-hdr">
        <div class="panel-title">📋 Últimas cotizaciones <span class="panel-pill">20 más recientes</span></div>
      </div>
      ${cotizaciones.length === 0 ? `<div class="empty">Sin cotizaciones registradas aún</div>` : `
      <table>
        <thead><tr><th>Fecha</th><th>Cliente</th><th>RUT</th><th>Tipo</th><th style="text-align:right">Total</th><th>Email</th><th>Seguimiento</th></tr></thead>
        <tbody>
        ${[...cotizaciones].reverse().slice(0, 20).map(c => `
          <tr>
            <td style="color:#94A3B8;white-space:nowrap">${new Date(c.timestamp).toLocaleString("es-CL",{timeZone:"America/Santiago",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}</td>
            <td style="font-weight:600">${escapeHtml(c.razonSocial || "–")}</td>
            <td style="color:#94A3B8">${c.rut ? escapeHtml(c.rut) : `<span class="tag tag-loop">SIN RUT</span>`}</td>
            <td><span class="tag ${c.esClienteNuevo ? "tag-new" : "tag-rec"}">${c.esClienteNuevo ? "Nuevo" : "Recurrente"}</span></td>
            <td style="text-align:right;font-weight:700;color:#ED0914">$${(c.total || 0).toLocaleString("es-CL")}</td>
            <td style="color:#94A3B8">${escapeHtml(c.emailCliente || "–")}</td>
            <td>${
              c.respuestaSeguimiento === "interesado"     ? `<span class="tag tag-new">🔥 Interesado</span>` :
              c.respuestaSeguimiento === "sin_interes"    ? `<span class="tag tag-sin">❄️ Sin interés</span>` :
              c.respuestaSeguimiento === "pago_recibido"  ? `<span class="tag tag-rec">💰 Pagó</span>` :
              c.seguimientoEnviado                        ? `<span class="tag tag-loop">📤 Enviado</span>` : "–"
            }</td>
          </tr>`).join("")}
        </tbody>
      </table>`}
    </div>
  </div>

  ${hidroPendientesList.length === 0 ? "" : `
  <!-- ── Hidros pendientes ── -->
  <div class="row row-1">
    <div class="panel" style="grid-column:1/-1">
      <div class="panel-hdr">
        <div class="panel-title">🔩 Hidrolavadoras pendientes de cotización <span style="background:#F59E0B;color:#000;padding:2px 10px;border-radius:12px;font-size:12px;margin-left:8px;font-weight:700">${hidroPendientesList.length}</span></div>
      </div>
      <table>
        <thead><tr><th>Espera</th><th>Cliente</th><th>WhatsApp</th><th>Unidades</th><th>Recordatorios</th></tr></thead>
        <tbody>
        ${hidroPendientesList.map(h => {
          const hh = Math.floor(h.elapsed / 3600000);
          const mm = Math.floor((h.elapsed % 3600000) / 60000);
          const tiempoStr = hh > 0 ? hh + "h " + mm + "m" : mm + "m";
          const color = h.elapsed > 4 * 3600000 ? "#ED0914" : h.elapsed > 2 * 3600000 ? "#F59E0B" : "#94A3B8";
          const n = (h.data.hidrosList || []).reduce((s, x) => s + (x.cantidad || 1), 0) || 1;
          return `<tr>
            <td style="color:${color};white-space:nowrap;font-weight:700">${tiempoStr}</td>
            <td style="font-weight:600">${escapeHtml(h.data.nombre || "–")}</td>
            <td style="color:#94A3B8">+${escapeHtml(h.phone)}</td>
            <td>${n} hidrolavadora${n > 1 ? "s" : ""}</td>
            <td><span class="tag ${h.reminderCount > 0 ? "tag-loop" : "tag-sin"}">${h.reminderCount > 0 ? h.reminderCount + " enviado" + (h.reminderCount > 1 ? "s" : "") : "Pendiente"}</span></td>
          </tr>`;
        }).join("")}
        </tbody>
      </table>
    </div>
  </div>`}

  <!-- ── Comprobantes de pago ── -->
  <div class="row row-1">
    <div class="panel" style="grid-column:1/-1">
      <div class="panel-hdr">
        <div class="panel-title">💰 Comprobantes de pago recibidos${comprobantes.length > 0 ? ` <span style="background:#22C55E;color:#000;padding:2px 10px;border-radius:12px;font-size:12px;margin-left:8px;font-weight:700">${comprobantes.length}</span>` : ""}</div>
      </div>
      ${comprobantes.length === 0 ? `<div class="empty">Sin comprobantes recibidos</div>` : `
      <table>
        <thead><tr><th>Fecha</th><th>Cliente</th><th>RUT</th><th>WhatsApp</th><th>Archivo</th><th>Cotización asociada</th></tr></thead>
        <tbody>
        ${[...comprobantes].reverse().slice(0, 15).map(c => `
          <tr>
            <td style="color:#94A3B8;white-space:nowrap">${new Date(c.timestamp).toLocaleString("es-CL",{timeZone:"America/Santiago",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}</td>
            <td style="font-weight:600">${escapeHtml(c.razonSocial || "–")}</td>
            <td style="color:#94A3B8">${escapeHtml(c.rut || "–")}</td>
            <td style="color:#94A3B8">+${escapeHtml(c.phone)}</td>
            <td style="font-size:11px">${escapeHtml(c.archivo || "–")}</td>
            <td>${c.cotizacionId ? `${escapeHtml(c.cotizacionId)} · $${(c.totalCotizacion || 0).toLocaleString("es-CL")}` : "–"}</td>
          </tr>`).join("")}
        </tbody>
      </table>`}
    </div>
  </div>

  <!-- ── Registro de conversaciones (auditoría) ── -->
  <div class="row row-1">
    <div class="panel" style="grid-column:1/-1">
      <div class="panel-hdr">
        <div class="panel-title">📝 Registro de conversaciones${consultas.length > 0 ? ` <span style="background:#3B82F6;color:#fff;padding:2px 10px;border-radius:12px;font-size:12px;margin-left:8px;font-weight:700">${consultas.length}</span>` : ""}</div>
        <a href="/panel/export" style="font-size:12px;color:#3B82F6;text-decoration:none;font-weight:600;border:1px solid #3B82F6;padding:5px 12px;border-radius:7px">⬇ Exportar CSV</a>
      </div>
      ${consultas.length === 0 ? `<div class="empty">Sin consultas registradas aún</div>` : `
      <table>
        <thead><tr><th>Fecha</th><th>WhatsApp</th><th>Consulta del cliente</th><th>Respuesta del bot</th></tr></thead>
        <tbody>
        ${[...consultas].reverse().slice(0, 25).map(c => `
          <tr>
            <td style="color:#94A3B8;white-space:nowrap">${new Date(c.timestamp).toLocaleString("es-CL",{timeZone:"America/Santiago",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}</td>
            <td style="color:#94A3B8">+${escapeHtml(c.phone)}</td>
            <td style="max-width:240px">${escapeHtml(c.pregunta || "–")}</td>
            <td style="max-width:340px;color:#94A3B8;font-size:13px">${escapeHtml(c.respuesta || "–")}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      <div style="margin-top:10px;font-size:11px;color:#64748B">Se conservan por 6 meses. Mostrando las 25 más recientes de ${consultas.length}. Exporta para el registro completo.</div>`}
    </div>
  </div>

  <!-- ── Fila 6: Contactos + Problemáticas ── -->
  <div class="row row-2">
    <div class="panel">
      <div class="panel-hdr">
        <div class="panel-title">📞 Solicitudes a ejecutivo</div>
      </div>
      ${contactos.length === 0 ? `<div class="empty">Sin solicitudes registradas</div>` : `
      <table>
        <thead><tr><th>Fecha</th><th>Nombre</th><th>WhatsApp</th><th>Motivo</th></tr></thead>
        <tbody>
        ${[...contactos].reverse().slice(0, 15).map(c => `
          <tr>
            <td style="color:#94A3B8;white-space:nowrap">${new Date(c.timestamp).toLocaleString("es-CL",{timeZone:"America/Santiago",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}</td>
            <td style="font-weight:600">${escapeHtml(c.nombre || "–")}</td>
            <td style="color:#94A3B8">+${escapeHtml(c.phone)}</td>
            <td>${escapeHtml(c.motivo || "–")}</td>
          </tr>`).join("")}
        </tbody>
      </table>`}
    </div>
    <div class="panel">
      <div class="panel-hdr">
        <div class="panel-title">⚠️ Conversaciones problemáticas</div>
      </div>
      ${problematicas.length === 0 ? `<div class="empty">Sin conversaciones problemáticas</div>` : `
      <table>
        <thead><tr><th>Fecha</th><th>Tipo</th><th>Cliente</th><th>Últimos mensajes</th></tr></thead>
        <tbody>
        ${[...problematicas].reverse().slice(0, 15).map(p => `
          <tr>
            <td style="color:#94A3B8;white-space:nowrap">${new Date(p.timestamp).toLocaleString("es-CL",{timeZone:"America/Santiago",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}</td>
            <td><span class="tag ${p.tipo === "loop" ? "tag-loop" : "tag-sin"}">${p.tipo === "loop" ? "Loop" : "Sin resp."}</span></td>
            <td style="font-weight:600">${escapeHtml(p.cliente || "–")}</td>
            <td style="color:#94A3B8;font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${(p.mensajesRecientes || []).map(m => escapeHtml(m.text)).join(" → ")}</td>
          </tr>`).join("")}
        </tbody>
      </table>`}
    </div>
  </div>

</div>
<div class="footer">CINTEC · Bot WhatsApp · Panel interno · ${new Date().getFullYear()}</div>

<script nonce="${nonce}">
const RED = '#ED0914', RED2 = 'rgba(237,9,20,.15)';
const BLUE = '#3B82F6', GREEN = '#22C55E', PURPLE = '#A855F7';
const GRAY = '#94A3B8';
const defaults = { plugins:{ legend:{ display:false } }, animation:{ duration:600 } };

// Gráfico por día
new Chart(document.getElementById('chartDia'), {
  type:'bar',
  data:{
    labels:${j(diasOrdenados.map(d => d.slice(5)))},
    datasets:[{ label:'Cotizaciones', data:${j(diasOrdenados.map(d => porDia[d]))},
      backgroundColor:RED2, borderColor:RED, borderWidth:2, borderRadius:5 }]
  },
  options:{ ...defaults, scales:{ y:{ beginAtZero:true, ticks:{ stepSize:1 }, grid:{ color:'#F1F5F9' } }, x:{ grid:{ display:false }, ticks:{ font:{ size:10 } } } } }
});

// Dona nuevos vs recurrentes
new Chart(document.getElementById('chartDona'), {
  type:'doughnut',
  data:{
    labels:['Nuevos','Recurrentes'],
    datasets:[{ data:[${nuevos},${existentes}],
      backgroundColor:[GREEN,'#DBEAFE'], borderColor:['#fff','#fff'], borderWidth:3,
      hoverOffset:6 }]
  },
  options:{ ...defaults, cutout:'68%', plugins:{ legend:{ display:true, position:'bottom', labels:{ font:{ size:11 }, padding:14 } } } }
});

// Gráfico por hora
new Chart(document.getElementById('chartHora'), {
  type:'bar',
  data:{
    labels:${j(Array.from({length:24}, (_,i) => i+'h'))},
    datasets:[{ data:${j(porHora)},
      backgroundColor:porHora.map(v => v === Math.max(...${j(porHora)}) ? RED : 'rgba(237,9,20,.25)'),
      borderRadius:4 }]
  },
  options:{ ...defaults, scales:{ y:{ beginAtZero:true, ticks:{ stepSize:1 }, grid:{ color:'#F1F5F9' } }, x:{ grid:{ display:false }, ticks:{ font:{ size:9 } } } } }
});

// Top productos por monto (horizontal)
new Chart(document.getElementById('chartMonto'), {
  type:'bar',
  data:{
    labels:${j(topProdMonto.map(p => p.descripcion.slice(0,28)))},
    datasets:[{ data:${j(topProdMonto.map(p => p.monto))},
      backgroundColor:'rgba(59,130,246,.2)', borderColor:BLUE, borderWidth:2, borderRadius:4 }]
  },
  options:{ ...defaults, indexAxis:'y', scales:{ x:{ beginAtZero:true, grid:{ color:'#F1F5F9' }, ticks:{ callback:v=>'$'+v.toLocaleString('es-CL') } }, y:{ grid:{ display:false }, ticks:{ font:{ size:10 } } } } }
});
</script>
</body>
</html>`;
}

// ─── /reporte — acceso por token (URL anterior sigue funcionando) ─────────────
// /reporte quedó retirado por seguridad: el acceso con token en la URL fue
// reemplazado por login con usuario y contraseña. Redirige al panel seguro.
app.get("/reporte", (req, res) => res.redirect(302, "/panel"));

// ─── /panel — acceso con login ────────────────────────────────────────────────
app.get("/panel/login", (req, res) => {
  if (getPanelSession(req)) return res.redirect("/panel");
  const error = req.query.error === "1";
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CINTEC · Acceso Panel</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;
     background:linear-gradient(135deg,#8B0008 0%,#ED0914 60%,#FF4444 100%);
     font-family:'Segoe UI',Arial,sans-serif}
.card{background:#fff;border-radius:18px;padding:40px 44px;width:100%;max-width:380px;
      box-shadow:0 20px 60px rgba(0,0,0,.3)}
.logo{text-align:center;margin-bottom:26px}
.logo img{height:38px}
h1{font-size:18px;font-weight:700;color:#1E293B;text-align:center;margin-bottom:5px}
.sub{font-size:12px;color:#94A3B8;text-align:center;margin-bottom:26px}
label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;
      color:#64748B;display:block;margin-bottom:5px}
input{width:100%;border:1.5px solid #E2E8F0;border-radius:9px;padding:11px 14px;
      font-size:14px;color:#1E293B;outline:none;margin-bottom:16px;transition:border .2s;background:#fff}
input:focus{border-color:#ED0914;box-shadow:0 0 0 3px rgba(237,9,20,.08)}
button{width:100%;background:#ED0914;color:#fff;border:none;border-radius:9px;
       padding:13px;font-size:14px;font-weight:700;cursor:pointer;transition:background .2s;margin-top:4px}
button:hover{background:#C0071B}
.err{background:#FEF2F2;border:1px solid #FCA5A5;color:#991B1B;border-radius:8px;
     padding:10px 14px;font-size:12px;margin-bottom:18px;text-align:center}
.foot{text-align:center;font-size:10px;color:#CBD5E1;margin-top:22px}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <img src="https://assets.jumpseller.com/store/cintecsa/themes/954643/settings/e6f636bc6ca9fb2e0341/logo%20cintec%20color_.png?1771944795"
         alt="CINTEC" onerror="this.style.display='none'">
  </div>
  <h1>Panel de Control</h1>
  <p class="sub">Bot WhatsApp · Estadísticas internas</p>
  ${error ? '<div class="err">⚠️ Usuario o contraseña incorrectos</div>' : ""}
  <form method="POST" action="/panel/login">
    <label for="u">Usuario</label>
    <input type="text" id="u" name="user" placeholder="Tu usuario" autocomplete="username" required>
    <label for="p">Contraseña</label>
    <input type="password" id="p" name="pass" placeholder="Tu contraseña" autocomplete="current-password" required>
    <button type="submit">Ingresar →</button>
  </form>
  <div class="foot">CINTEC · Acceso restringido al equipo interno</div>
</div>
</body>
</html>`);
});

app.post("/panel/login", express.urlencoded({ extended: false }), (req, res) => {
  const PANEL_USER = process.env.PANEL_USER || "cintec";
  const PANEL_PASS = process.env.PANEL_PASS || "";
  if (!PANEL_PASS) return res.status(500).send("PANEL_PASS no está configurado en Railway.");
  if (req.body.user === PANEL_USER && req.body.pass === PANEL_PASS) {
    createPanelSession(res);
    return res.redirect("/panel");
  }
  res.redirect("/panel/login?error=1");
});

app.get("/panel", (req, res) => {
  if (!checkHttpRateLimit(req.ip, 30)) return res.status(429).send("Demasiadas solicitudes. Intenta en un minuto.");
  if (!getPanelSession(req)) return res.redirect("/panel/login");
  const nonce = crypto.randomBytes(16).toString("base64");
  res.setHeader("Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src data: https:; connect-src 'none'`
  );
  res.send(buildKPIPage(nonce, true));
});

app.get("/panel/logout", (req, res) => {
  clearPanelSession(req, res);
  res.redirect("/panel/login");
});

// Exportar el registro de conversaciones a CSV (auditoría interna) — requiere login
app.get("/panel/export", (req, res) => {
  if (!checkHttpRateLimit(req.ip, 30)) return res.status(429).send("Demasiadas solicitudes. Intenta en un minuto.");
  if (!getPanelSession(req)) return res.redirect("/panel/login");

  const consultas = cotizacionesLog.filter(e => e.tipo === "consulta");
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`; // escape CSV
  const filas = consultas.map(c => [
    new Date(c.timestamp).toLocaleString("es-CL", { timeZone: "America/Santiago" }),
    "+" + (c.phone || ""),
    c.pregunta  || "",
    c.respuesta || "",
  ].map(esc).join(","));
  const csv = "﻿" + ["Fecha,WhatsApp,Consulta del cliente,Respuesta del bot", ...filas].join("\r\n");

  const fecha = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="registro-conversaciones-${fecha}.csv"`);
  res.send(csv);
});

// ─── Inicio del servidor ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📌 Webhook URL: http://TU-DOMINIO/webhook`);
  // Pre-calentar caché del catálogo para que el primer cliente no espere
  try {
    const rows = await cargarCSV();
    console.log(`📦 Catálogo pre-cargado: ${rows?.length ?? 0} filas`);
  } catch (e) {
    console.warn("⚠️  No se pudo pre-cargar el catálogo:", e.message);
  }
});
