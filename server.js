require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Resend } = require("resend");
const { parse } = require("csv-parse/sync");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

const {
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID,
  VERIFY_TOKEN,
  DESTINATION_EMAIL,
  RESEND_API_KEY,
  GOOGLE_SHEETS_CSV_URL,
} = process.env;

const sessions = {};
const hidroPendientes = new Map(); // phone → respuesta del especialista (fallback si sesión expiró)

// ─── Rate limiter (máx 12 mensajes/minuto por usuario) ────────────────────────
const rateLimiter = new Map();
setInterval(() => rateLimiter.clear(), 60 * 1000);

function checkRateLimit(phone) {
  const count = (rateLimiter.get(phone) || 0) + 1;
  rateLimiter.set(phone, count);
  return count <= 12;
}

// ─── Anti-frustración: handoff automático tras 2 errores consecutivos ─────────
async function registrarError(phone, session) {
  session.data.erroresConsecutivos = (session.data.erroresConsecutivos || 0) + 1;
  if (session.data.erroresConsecutivos >= 2) {
    session.data.erroresConsecutivos = 0;
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
  WAITING_RUT:        "waiting_rut",
  WAITING_RAZON:      "waiting_razon",
  WAITING_PRODUTOS:   "waiting_productos",
  CONFIRMANDO:        "confirmando",
  WAITING_FORMATO:    "waiting_formato",
  ELIGIENDO_OPCION:   "eligiendo_opcion",
  WAITING_CANTIDAD:   "waiting_cantidad",
  WAITING_MAS:        "waiting_mas",
  WAITING_EMAIL:      "waiting_email",
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

async function responderConsulta(phone, session, pregunta) {
  if (!process.env.ANTHROPIC_API_KEY) return false;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Contexto resumido de la sesión actual
    const confirmados = (session.data.productosConfirmados || [])
      .map(p => p.seleccionado?.DesProd).filter(Boolean).join(", ");
    const buscando = session.data.itemActual?.nombre || "";
    const contextLine = [
      confirmados && `Productos ya cotizados: ${confirmados}`,
      buscando    && `Producto en búsqueda actual: ${buscando}`,
    ].filter(Boolean).join(". ");

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 250,
      system:
        `Eres el asistente de ventas de CINTEC, empresa chilena de productos de limpieza, higiene y desinfección industrial. ` +
        `Responde SOLO preguntas relacionadas con productos de limpieza, cotizaciones o servicios de CINTEC. ` +
        `Responde en español, de forma breve (máx 2-3 oraciones). ` +
        `Si no tienes la información exacta, di "un ejecutivo puede ayudarte con eso". ` +
        `NUNCA inventes precios, disponibilidad, ni datos de productos. ` +
        `Si te preguntan algo fuera del ámbito comercial de CINTEC (política, religión, contenido adulto, temas personales), responde solo: "Estoy aquí para ayudarte con cotizaciones de CINTEC." ` +
        (contextLine ? `Contexto de la cotización en curso: ${contextLine}.` : ""),
      messages: [{ role: "user", content: pregunta }],
    });

    const reply = response.content[0]?.text || "";
    await sendMessage(phone, `${reply}\n\n_Continuemos con tu cotización..._`);
    return true;
  } catch (err) {
    console.error("Error Claude:", err.message);
    return false;
  }
}

// Palabras de envase/cantidad que no deben usarse como keyword de producto
const STOP_WORDS_ENVASE = new Set([
  "bidon", "bidones", "bolsa", "bolsas", "saco", "sacos",
  "caja", "cajas", "frasco", "frascos", "tarro", "tarros",
  "balde", "baldes", "tambor", "tambores", "galon", "galones",
  "envase", "envases", "botella", "botellas", "de", "del",
  "un", "una", "uno", "unos", "unas", "talla",
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
  res.sendStatus(200);
  try {
    const msg  = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;
    const from = msg.from;
    const text = msg.text?.body?.trim();
    if (!text) return;
    if (!checkRateLimit(from)) {
      console.warn(`Rate limit alcanzado: ${from}`);
      return; // ignorar silenciosamente, no enviar mensaje
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

  // ── Comando STOP: cerrar conversación (cumplimiento Meta) ──────────────────
  if (/^(stop|detener|cancelar|salir|para|basta)$/i.test(normalizar(text))) {
    delete sessions[phone];
    await sendMessage(phone,
      `✅ Tu conversación fue cerrada. Escribe *hola* cuando necesites cotizar nuevamente.\n\n` +
      `_Si necesitas ayuda, un ejecutivo de ventas puede atenderte directamente._`
    );
    return;
  }

  // ── Handoff a ejecutivo humano ─────────────────────────────────────────────
  if (/hablar con|quiero un ejecutivo|necesito un asesor|agente humano|persona real|vendedor|asesor/i.test(normalizar(text))) {
    await notificarHandoff(phone, session.data);
    await sendMessage(phone,
      `👤 Entendido. Un *ejecutivo de ventas* de CINTEC se pondrá en contacto contigo a la brevedad.\n\n` +
      `Puedes continuar cotizando mientras tanto, o esperar a ser atendido.`
    );
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
        `Para cotizarte necesito algunos datos.\n\n` +
        `Si tienes *RUT de empresa*, ingrésalo.\n` +
        `De lo contrario, ingresa tu *RUT personal*.\n\n` +
        `_Ej empresa: 76.123.456-7_\n` +
        `_Ej personal: 12.345.678-9_`
      );
      session.step = STEPS.WAITING_RUT;
      break;

    case STEPS.WAITING_RUT: {
      const rutLimpio = text.replace(/[.\-\s]/g, "").toUpperCase();
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
      session.data.rut              = text.toUpperCase();
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

    case STEPS.WAITING_EMAIL:
      if (!text.includes("@") || !text.includes(".")) {
        await sendMessage(phone, `⚠️ Ingresa un correo electrónico válido.`);
        break;
      }
      session.data.emailCliente = text.toLowerCase();
      await enviarCotizacionCompleta(phone, session.data);
      session.step = STEPS.DONE;
      setTimeout(() => delete sessions[phone], 5 * 60 * 1000);
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
      await sendMessage(phone, `Tu solicitud fue procesada. Escribe *hola* para una nueva cotización.`);
      break;
  }
}

// ─── Procesar productos ───────────────────────────────────────────────────────
async function procesarProductos(phone, session) {
  const rows = await cargarCSV();
  if (!rows) { await sendMessage(phone, `⚠️ Error al acceder al catálogo.`); return; }

  // Detectar si cliente tiene historial
  const filasCliente = rows.filter(row =>
    (row["CodAuxGSaen"] || "").replace(/[.\-\s]/g, "") === session.data.rutSinDV
  );
  session.data.esClienteNuevo = filasCliente.length === 0;

  if (session.data.esClienteNuevo) {
    console.log(`Cliente nuevo: ${session.data.rutSinDV}`);
  }

  session.data.rows            = rows;
  session.data.itemsPendientes = parsearProductos(session.data.textoProductos);
  // No resetear: el cliente puede agregar productos en múltiples rondas
  if (!session.data.productosConfirmados)   session.data.productosConfirmados   = [];
  if (!session.data.productosBajoMargen)    session.data.productosBajoMargen    = [];
  if (!session.data.productosNoEncontrados) session.data.productosNoEncontrados = [];

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
    msg += `💰 Precio: $${p.precio.toLocaleString("es-CL")}\n`;
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
      const desc = normalizar(p.DesProd);
      return secundarias.some(k => desc.includes(k) || desc.includes(stemES(k)));
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
    const precio = parseFloat((p["Precio Lista"] || "0").replace(/[$.\s]/g,"").replace(",","."));
    msg += `*${i + 1}.* ${p.DesProd}\n`;
    msg += `   💰 $${precio.toLocaleString("es-CL")} | 🏭 ${prov}\n\n`;
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
      const precio = parseFloat((p["Precio Lista"] || "0").replace(/[$.\s]/g,"").replace(",","."));
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
      const precio = parseFloat((p["Precio Lista"] || "0").replace(/[$.\s]/g,"").replace(",","."));
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
      const precio = parseFloat((p["Precio Lista"] || "0").replace(/[$.\s]/g,"").replace(",","."));
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
    await sendMessage(phone, `✅ Seleccionado: *${elegido.DesProd}*\n💰 $${elegido.precio.toLocaleString("es-CL")}`);
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
      msg += `   💰 $${p.precio.toLocaleString("es-CL")} | 📅 ${p.fecha}\n\n`;
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

  let msg = `📋 *Resumen de tu cotización:*\n\n`;
  let total = 0;
  confirmados.forEach((item, i) => {
    const p        = item.seleccionado;
    const subtotal = p.precio * item.cantidad;
    total += subtotal;
    msg += `*${i + 1}. ${p.DesProd}*\n`;
    msg += `   🏷️ Código: ${p.CodProd}\n`;
    msg += `   💰 Precio: $${p.precio.toLocaleString("es-CL")}\n`;
    msg += `   📦 Cantidad: ${item.cantidad} ${item.unidad}\n`;
    msg += `   💵 Subtotal: $${subtotal.toLocaleString("es-CL")}\n\n`;
  });
  msg += `*💵 TOTAL: $${total.toLocaleString("es-CL")}*\n\n`;

  if (bajoMargen.length > 0) {
    msg += `⚠️ Estos productos requieren actualización de precios:\n`;
    bajoMargen.forEach(p => { msg += `• ${p.nombre}\n`; });
    msg += `_Un representante te contactará._\n\n`;
  }
  if (noEncontrados.length > 0) {
    msg += `ℹ️ Sin disponibilidad de: ${noEncontrados.join(", ")}\n\n`;
  }

  msg += `📧 ¿A qué *correo electrónico* enviamos la cotización?`;
  session.step = STEPS.WAITING_EMAIL;
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
    const precio = parseFloat((row["Ultimo Precio"] || "0").replace(/[$.\s]/g,"").replace(",","."));
    const costo  = parseFloat((row["Costo Vta"] || "0").replace(/[$.\s]/g,"").replace(",",".")) || 0;
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

// ─── Buscar en catálogo completo ──────────────────────────────────────────────
function buscarEnCatalogo(rows, keywords) {
  // Deduplicar por CodProd tomando solo una fila por producto
  const unicosPorCod = {};
  rows.forEach(row => {
    if (!unicosPorCod[row["CodProd"]]) unicosPorCod[row["CodProd"]] = row;
  });
  const catalogo = Object.values(unicosPorCod);

  return catalogo.filter(row => {
    const desc = normalizar(row["DesProd"] || "");
    const cod  = (row["CodProd"] || "").toLowerCase();
    const precio = parseFloat((row["Precio Lista"] || "0").replace(/[$.\s]/g,"").replace(",","."));
    if (precio <= 0) return false;
    const match = keywords.some(k => {
      const stem = stemES(k);
      return desc.includes(k) || desc.includes(stem) || cod.includes(k) || cod.includes(stem);
    });
    if (match) console.log(`Encontrado: ${row["DesProd"]} | PrecioLista: ${row["Precio Lista"]}`);
    return match;
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

// ─── Cargar CSV ───────────────────────────────────────────────────────────────
async function cargarCSV() {
  try {
    const resp = await axios.get(GOOGLE_SHEETS_CSV_URL);
    return parse(resp.data, { columns: true, skip_empty_lines: true });
  } catch (err) {
    console.error("Error cargando CSV:", err.message);
    return null;
  }
}

// ─── Enviar cotización ────────────────────────────────────────────────────────
async function enviarCotizacionCompleta(phone, data) {
  try {
    const resend      = new Resend(RESEND_API_KEY);
    const fecha       = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
    const confirmados = data.productosConfirmados;

    let filas = "";
    let total = 0;
    confirmados.forEach(item => {
      const p        = item.seleccionado;
      const subtotal = p.precio * item.cantidad;
      total += subtotal;
      filas += `<tr>
        <td style="padding:8px; border-bottom:1px solid #eee;">${p.CodProd}</td>
        <td style="padding:8px; border-bottom:1px solid #eee;">${p.DesProd}</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:right;">$${p.precio.toLocaleString("es-CL")}</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:center;">${item.cantidad} ${item.unidad}</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:right;">$${subtotal.toLocaleString("es-CL")}</td>
      </tr>`;
    });

    const htmlCotizacion = `
      <div style="font-family:Arial,sans-serif; max-width:650px; margin:auto; padding:24px; border:1px solid #e0e0e0; border-radius:8px;">
        <div style="background:#c0392b; padding:16px; border-radius:8px 8px 0 0; text-align:center;">
          <h2 style="color:white; margin:0;">COTIZACIÓN CINTEC</h2>
        </div>
        <div style="padding:20px;">
          <p>Estimado/a <strong>${data.razonSocial}</strong>,</p>
          <p><strong>Fecha:</strong> ${fecha} &nbsp; <strong>RUT:</strong> ${data.rut}</p>
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
          <p style="color:#555; font-size:12px;">Vigencia: 30 días. CINTEC - Sociedad Comercial</p>
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
      subject: `📦 Cotización enviada - ${data.razonSocial}${data.esClienteNuevo ? " (CLIENTE NUEVO)" : ""}`,
      html: `<h2 style="color:#c0392b;">📲 Cotización enviada vía WhatsApp</h2>
        <p><strong>Cliente:</strong> ${data.razonSocial} | RUT: ${data.rut}</p>
        <p><strong>Email:</strong> ${data.emailCliente} | WhatsApp: +${phone}</p>
        <p><strong>Tipo:</strong> ${data.esClienteNuevo ? "🆕 Cliente nuevo (Precio Lista)" : "✅ Cliente existente"}</p>
        ${htmlCotizacion}`,
    });

    await sendMessage(phone,
      `✅ ¡Listo! Tu cotización fue enviada a *${data.emailCliente}*.\n\n` +
      `¡Gracias por preferirnos! Escribe *hola* si necesitas algo más. 🙏`
    );
    console.log(`📧 Cotización enviada a ${data.emailCliente}`);
  } catch (err) {
    console.error("Error enviando cotización:", err.message);
    await sendMessage(phone, `⚠️ Error al enviar cotización. Por favor intenta nuevamente.`);
  }
}

// ─── Notificar handoff a ejecutivo ───────────────────────────────────────────
async function notificarHandoff(phone, data) {
  if (!RESEND_API_KEY) return;
  try {
    const resend = new Resend(RESEND_API_KEY);
    const fecha  = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
    await resend.emails.send({
      from:    "Bot CINTEC <onboarding@resend.dev>",
      to:      DESTINATION_EMAIL,
      subject: `👤 Cliente solicita ejecutivo — ${data?.razonSocial || phone}`,
      html: `<h2>👤 Cliente solicita atención humana</h2>
        <p><strong>Fecha:</strong> ${fecha}</p>
        <p><strong>Cliente:</strong> ${data?.razonSocial || "–"} | RUT: ${data?.rut || "–"}</p>
        <p><strong>WhatsApp:</strong> <a href="https://wa.me/${phone}">+${phone}</a></p>
        <p>El cliente solicitó hablar con un ejecutivo durante el flujo de cotización.</p>`,
    });
  } catch (err) {
    console.error("Error notificando handoff:", err.message);
  }
}

// ─── Notificar bajo margen ────────────────────────────────────────────────────
async function notificarBajoMargen(phone, data, productosBajoMargen) {
  try {
    const resend = new Resend(RESEND_API_KEY);
    const fecha  = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
    let filas = "";
    productosBajoMargen.forEach(p => {
      filas += `<tr>
        <td style="padding:8px;">${p.producto?.CodProd || "-"}</td>
        <td style="padding:8px;">${p.producto?.DesProd || p.nombre}</td>
        <td style="padding:8px;">${p.cantidad} ${p.unidad}</td>
        <td style="padding:8px; color:#e74c3c;">${p.producto?.margen || "-"}%</td>
      </tr>`;
    });
    await resend.emails.send({
      from: "Bot CINTEC <onboarding@resend.dev>",
      to: DESTINATION_EMAIL,
      subject: `⚠️ Productos bajo margen - ${data.razonSocial}`,
      html: `<div style="font-family:Arial,sans-serif; max-width:600px; margin:auto; padding:24px; border:2px solid #e74c3c; border-radius:8px;">
        <h2 style="color:#e74c3c;">⚠️ Productos no cotizados por bajo margen</h2>
        <p><strong>Cliente:</strong> ${data.razonSocial} | RUT: ${data.rut} | WhatsApp: +${phone}</p>
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
  { key: "agua",      msg: "💧 ¿La hidrolavadora usará *agua fría* o *agua caliente*?" },
  { key: "corriente", msg: "⚡ ¿Qué tipo de corriente eléctrica requiere?\n*1.* Monofásica (220V)\n*2.* Trifásica (380V)" },
  { key: "bares",     msg: "🔧 ¿Qué presión necesita?\n_Indica en bares, ej: 100, 150, 200_" },
  { key: "caudal",    msg: "🌊 ¿Qué caudal necesita?\n_Indica en litros/minuto, ej: 10, 15, 20_" },
  { key: "modelo",    msg: "📋 ¿Tiene algún modelo de referencia?\n_Escribe marca y modelo, o *no* si no tiene_" },
  { key: "horas",     msg: "⏱️ ¿Cuántas horas al día operará la hidrolavadora?" },
  { key: "uso",       msg: "🏭 ¿Para qué uso la destinará?\n_Ej: lavado de vehículos, maquinaria industrial, pisos_" },
];

async function iniciarFlujoHidro(phone, session) {
  session.data.hidroSpecs   = {};
  session.data.hidroPaso    = 0;
  session.step = STEPS.HIDRO_SPECS;
  await sendMessage(phone,
    `🔩 Para cotizar una *hidrolavadora* correctamente, necesito algunas especificaciones técnicas.\n\n` +
    HIDRO_PREGUNTAS[0].msg
  );
}

async function manejarHidroSpecs(phone, session, text) {
  const paso = session.data.hidroPaso;
  const { key } = HIDRO_PREGUNTAS[paso];

  // Guardar respuesta actual
  if (key === "corriente") {
    session.data.hidroSpecs[key] = /^[12]$/.test(text.trim())
      ? (text.trim() === "1" ? "Monofásica (220V)" : "Trifásica (380V)")
      : text;
  } else {
    session.data.hidroSpecs[key] = text;
  }

  const siguientePaso = paso + 1;
  if (siguientePaso < HIDRO_PREGUNTAS.length) {
    session.data.hidroPaso = siguientePaso;
    await sendMessage(phone, HIDRO_PREGUNTAS[siguientePaso].msg);
  } else {
    // Todas las specs recolectadas
    session.data.itemsPendientes.shift();
    session.step = STEPS.HIDRO_ESPERANDO;
    await enviarSolicitudHidroEmail(phone, session.data);
    await sendMessage(phone,
      `✅ ¡Listo! Hemos registrado todas las especificaciones.\n\n` +
      `Tu solicitud fue derivada a un *especialista* que buscará la mejor opción en calidad y precio.\n\n` +
      `Te notificaremos por este medio cuando tengamos la cotización. ⏳`
    );
    // Continuar con otros productos pendientes si los hay
    if (session.data.itemsPendientes.length > 0) {
      await procesarSiguienteProducto(phone, session);
    }
  }
}

async function manejarHidroEmail(phone, session, text) {
  if (!text.includes("@") || !text.includes(".")) {
    await sendMessage(phone, `⚠️ Ingresa un correo electrónico válido.`);
    return;
  }
  const emailCliente = text.toLowerCase();
  const respuesta    = session.data.hidroRespuesta || "";
  const resend       = new Resend(RESEND_API_KEY);
  try {
    await resend.emails.send({
      from: "Bot CINTEC <onboarding@resend.dev>",
      to:   emailCliente,
      subject: "Cotización Hidrolavadora - CINTEC",
      html: `<h2>Cotización Hidrolavadora</h2>
        <p>Estimado/a <strong>${session.data.razonSocial}</strong>,</p>
        <p>A continuación le presentamos la cotización preparada por nuestro especialista:</p>
        <div style="background:#f5f5f5;padding:16px;border-radius:8px;white-space:pre-wrap;">${respuesta.replace(/\n/g,"<br>")}</div>
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

async function enviarSolicitudHidroEmail(phone, data) {
  try {
    const resend  = new Resend(RESEND_API_KEY);
    const fecha   = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
    const specs   = data.hidroSpecs || {};
    const baseUrl = process.env.BASE_URL ||
      (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "https://whatsapp-bot-production.up.railway.app");
    const formUrl = `${baseUrl}/especialista/form?phone=${phone}&nombre=${encodeURIComponent(data.razonSocial)}&token=${VERIFY_TOKEN}`;

    const filas = HIDRO_PREGUNTAS.map(p =>
      `<tr><td style="padding:6px 12px;font-weight:bold">${p.key}</td><td style="padding:6px 12px">${specs[p.key] || "-"}</td></tr>`
    ).join("");

    await resend.emails.send({
      from:    "Bot CINTEC <onboarding@resend.dev>",
      to:      DESTINATION_EMAIL,
      subject: `🔩 Solicitud Hidrolavadora — ${data.razonSocial}`,
      html: `
        <h2>🔩 Nueva solicitud de hidrolavadora</h2>
        <p><strong>Fecha:</strong> ${fecha}</p>
        <p><strong>Cliente:</strong> ${data.razonSocial} | RUT: ${data.rut} | WhatsApp: +${phone}</p>
        <h3>Especificaciones técnicas</h3>
        <table border="1" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
          <tr><th style="padding:6px 12px">Especificación</th><th style="padding:6px 12px">Respuesta</th></tr>
          ${filas}
        </table>
        <br>
        <p>
          <a href="${formUrl}" style="background:#ed0914;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold">
            📩 Responder cotización al cliente
          </a>
        </p>
        <p style="color:#888;font-size:12px">O copia este enlace: ${formUrl}</p>`,
    });
  } catch (err) {
    console.error("Error enviando solicitud hidro:", err.message);
  }
}

// ─── Notificar interno ────────────────────────────────────────────────────────
async function notificarInterno(phone, data) {
  try {
    const resend = new Resend(RESEND_API_KEY);
    const fecha  = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
    await resend.emails.send({
      from: "Bot CINTEC <onboarding@resend.dev>",
      to: DESTINATION_EMAIL,
      subject: `📋 Solicitud sin cotización - ${data.razonSocial}`,
      html: `<h2>📋 Solicitud sin productos para cotizar</h2>
        <p><strong>Fecha:</strong> ${fecha}</p>
        <p><strong>Cliente:</strong> ${data.razonSocial} | RUT: ${data.rut} | WhatsApp: +${phone}</p>
        <p>Productos solicitados: ${data.textoProductos}</p>`,
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

// ─── Validación RUT chileno ───────────────────────────────────────────────────
function validarRUT(rut) {
  const cleaned = rut.replace(/[.\-\s]/g, "");
  if (!/^\d{7,8}[0-9Kk]$/.test(cleaned)) return false;
  const body = cleaned.slice(0, -1);
  const dv   = cleaned.slice(-1).toUpperCase();
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
app.get("/especialista/form", (req, res) => {
  const { phone, nombre, token } = req.query;
  if (!phone || !token) return res.status(400).send("Parámetros inválidos.");
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cotización Hidrolavadora — CINTEC</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; }
    h2   { color: #ed0914; }
    textarea { width: 100%; height: 200px; padding: 10px; font-size: 15px; border: 1px solid #ccc; border-radius: 6px; }
    button { background: #ed0914; color: #fff; border: none; padding: 12px 28px; font-size: 16px; border-radius: 6px; cursor: pointer; margin-top: 12px; }
    button:hover { background: #c00; }
    .info { background: #f5f5f5; padding: 12px; border-radius: 6px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <h2>🔩 Responder cotización hidrolavadora</h2>
  <div class="info">
    <strong>Cliente:</strong> ${nombre || "–"}<br>
    <strong>WhatsApp:</strong> +${phone}
  </div>
  <p>Escribe la cotización del equipo recomendado (modelo, precio, características, condiciones):</p>
  <form method="POST" action="/especialista/cotizacion">
    <input type="hidden" name="phone" value="${phone}">
    <input type="hidden" name="token" value="${token}">
    <textarea name="respuesta" placeholder="Ej: Recomendamos KARCHER HD 7/18-4 Classic — Monofásica, 180 bar, 18 lt/min...&#10;Precio neto: $850.000&#10;Condiciones: ..." required></textarea>
    <br>
    <button type="submit">📩 Enviar cotización al cliente</button>
  </form>
</body>
</html>`);
});

app.post("/especialista/cotizacion", express.urlencoded({ extended: true }), async (req, res) => {
  const { phone, token, respuesta } = req.body;
  if (!phone || !respuesta) return res.status(400).send("Faltan campos.");
  if (token !== VERIFY_TOKEN) return res.status(401).send("Token inválido.");

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

// ─── Inicio del servidor ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📌 Webhook URL: http://TU-DOMINIO/webhook`);
});
