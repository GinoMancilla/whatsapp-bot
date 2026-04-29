require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Resend } = require("resend");
const { parse } = require("csv-parse/sync");

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

const STEPS = {
  START:         "start",
  WAITING_EMAIL: "waiting_email",
  DONE:          "done",
};

// ─── Webhook verificación ─────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
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
    await handleMessage(from, text);
  } catch (err) {
    console.error("Error:", err.message);
  }
});

// ─── Lógica del bot ───────────────────────────────────────────────────────────
async function handleMessage(phone, text) {
  if (!sessions[phone]) {
    sessions[phone] = { step: STEPS.START, data: {} };
  }
  const session = sessions[phone];

  // Reiniciar si escribe "hola" estando en DONE
  if (session.step === STEPS.DONE && /^(hola|nueva|reiniciar|inicio)$/i.test(text)) {
    delete sessions[phone];
    sessions[phone] = { step: STEPS.START, data: {} };
    session.step = STEPS.START;
  }

  switch (session.step) {

    case STEPS.START:
      // Intentar extraer RUT y productos del mensaje libre
      const rutEncontrado = extraerRUT(text);
      const nombreEncontrado = extraerNombre(text);

      if (rutEncontrado) {
        // Mensaje libre con RUT incluido
        session.data.rut = rutEncontrado.formato;
        session.data.rutLimpio = rutEncontrado.limpio;
        session.data.rutSinDV = rutEncontrado.sinDV;
        session.data.nombre = nombreEncontrado || "Cliente";

        await sendMessage(phone, `👋 ¡Hola ${session.data.nombre}! Estoy procesando tu solicitud...`);

        // Extraer productos y cantidades del mensaje
        const productosTexto = extraerProductos(text);

        if (productosTexto.length > 0) {
          await procesarSolicitudCompleta(phone, session, productosTexto);
        } else {
          await sendMessage(phone,
            `✅ RUT registrado: *${session.data.rut}*\n\n` +
            `📦 ¿Qué productos necesitas cotizar?\n` +
            `_Ejemplo: toalla 2 paquetes, lavaloza 5 unidades_`
          );
          session.step = STEPS.WAITING_EMAIL;
        }
      } else {
        // No encontró RUT, pedir datos
        await sendMessage(phone,
          `👋 ¡Hola! Bienvenido/a a *CINTEC*.\n\n` +
          `Puedes escribirme directamente con tu información, por ejemplo:\n\n` +
          `_"Hola, soy Juan, mi RUT es 12.345.678-9 y necesito toalla 2 paquetes y lavaloza 5 unidades"_\n\n` +
          `O si prefieres, dime tu *RUT* para comenzar.`
        );
        session.step = STEPS.WAITING_EMAIL;
      }
      break;

    case STEPS.WAITING_EMAIL:
      // Verificar si es un email
      if (text.includes("@") && text.includes(".")) {
        session.data.emailCliente = text.toLowerCase();
        if (session.data.pendienteEnvio) {
          await enviarCotizacionCompleta(phone, session.data);
          session.step = STEPS.DONE;
        }
        break;
      }

      // Verificar si hay RUT en el mensaje
      const rutMsg = extraerRUT(text);
      if (rutMsg && !session.data.rut) {
        session.data.rut = rutMsg.formato;
        session.data.rutLimpio = rutMsg.limpio;
        session.data.rutSinDV = rutMsg.sinDV;
        const nombre = extraerNombre(text);
        if (nombre) session.data.nombre = nombre;
      }

      // Si tiene RUT, extraer productos
      if (session.data.rut) {
        const productos = extraerProductos(text);
        if (productos.length > 0) {
          await procesarSolicitudCompleta(phone, session, productos);
          break;
        }
      }

      await sendMessage(phone,
        `Por favor escríbeme tu solicitud incluyendo tu RUT y los productos que necesitas.\n\n` +
        `_Ejemplo: "Mi RUT es 12.345.678-9 y necesito toalla 2 paquetes y lavaloza 5 unidades"_`
      );
      break;

    case STEPS.DONE:
      await sendMessage(phone,
        `Tu solicitud ya fue procesada. Escribe *hola* para iniciar una nueva cotización.`
      );
      break;
  }
}

// ─── Procesar solicitud completa ──────────────────────────────────────────────
async function procesarSolicitudCompleta(phone, session, productosTexto) {
  await sendMessage(phone, `🔍 Buscando productos en nuestro catálogo...`);

  // Cargar CSV una vez
  const rows = await cargarCSV();
  if (!rows) {
    await sendMessage(phone, `⚠️ Error al acceder al catálogo. Por favor intenta nuevamente.`);
    return;
  }

  const productosConPrecio = [];
  const productosSinMargen = [];
  const productosNoEncontrados = [];

  for (const item of productosTexto) {
    const resultado = buscarProducto(rows, session.data.rutSinDV, item.nombre);

    if (resultado.encontrado) {
      productosConPrecio.push({
        ...resultado.producto,
        cantidadSolicitada: item.cantidad,
        unidad: item.unidad,
      });
    } else if (resultado.bajoMargen) {
      productosSinMargen.push({
        nombre: item.nombre,
        cantidad: item.cantidad,
        unidad: item.unidad,
        producto: resultado.producto,
      });
    } else {
      productosNoEncontrados.push(item.nombre);
    }
  }

  session.data.productosConPrecio = productosConPrecio;
  session.data.productosSinMargen = productosSinMargen;
  session.data.productosNoEncontrados = productosNoEncontrados;

  // Armar respuesta al cliente
  let respuesta = "";

  if (productosConPrecio.length > 0) {
    respuesta += `✅ *Productos disponibles para cotizar:*\n\n`;
    let total = 0;
    productosConPrecio.forEach((p, i) => {
      const subtotal = p.precio * p.cantidadSolicitada;
      total += subtotal;
      respuesta += `*${i + 1}. ${p.DesProd}*\n`;
      respuesta += `   🏷️ Código: ${p.CodProd}\n`;
      respuesta += `   💰 Precio: $${p.precio.toLocaleString("es-CL")}\n`;
      respuesta += `   📦 Cantidad: ${p.cantidadSolicitada} ${p.unidad}\n`;
      respuesta += `   💵 Subtotal: $${subtotal.toLocaleString("es-CL")}\n\n`;
    });
    respuesta += `*💵 TOTAL: $${total.toLocaleString("es-CL")}*\n\n`;
  }

  if (productosSinMargen.length > 0) {
    respuesta += `⚠️ *Los siguientes productos requieren actualización de precios:*\n`;
    productosSinMargen.forEach(p => {
      respuesta += `• ${p.nombre} (${p.cantidad} ${p.unidad})\n`;
    });
    respuesta += `_Un representante te contactará a la brevedad con los precios actualizados._\n\n`;
  }

  if (productosNoEncontrados.length > 0) {
    respuesta += `ℹ️ *No encontramos historial de:*\n`;
    productosNoEncontrados.forEach(p => {
      respuesta += `• ${p}\n`;
    });
    respuesta += `_Un representante revisará disponibilidad._\n\n`;
  }

  if (productosConPrecio.length > 0) {
    respuesta += `📧 ¿A qué *correo electrónico* te enviamos la cotización?`;
    session.data.pendienteEnvio = true;
    session.step = STEPS.WAITING_EMAIL;
  } else {
    respuesta += `📧 Un representante se pondrá en contacto contigo a la brevedad.`;
    session.step = STEPS.DONE;
    // Notificar internamente
    await notificarInterno(phone, session.data);
  }

  await sendMessage(phone, respuesta);

  // Notificar productos sin margen al correo interno
  if (productosSinMargen.length > 0) {
    await notificarBajoMargen(phone, session.data, productosSinMargen);
  }
}

// ─── Buscar producto en CSV ───────────────────────────────────────────────────
function buscarProducto(rows, rutSinDV, nombreBuscado) {
  const haceSeismeses = new Date();
  haceSeismeses.setMonth(haceSeismeses.getMonth() - 6);

  const keywords = nombreBuscado.toLowerCase().split(" ").filter(w => w.length > 2);

  // Filtrar por RUT
  const filasCliente = rows.filter(row => {
    const rutRow = (row["CodAuxGSaen"] || "").replace(/[.\-\s]/g, "");
    return rutRow === rutSinDV;
  });

  // Filtrar por producto
  const filasProducto = filasCliente.filter(row => {
    const desc = (row["DesProd"] || "").toLowerCase();
    const cod  = (row["CodProd"] || "").toLowerCase();
    return keywords.some(k => desc.includes(k) || cod.includes(k));
  });

  if (filasProducto.length === 0) return { encontrado: false, bajoMargen: false };

  // Filtrar por fecha y margen
  const filasValidas = filasProducto.filter(row => {
    const fechaStr = row["Fecha Ult. Vta"] || "";
    const parts = fechaStr.split("/");
    const fecha = parts.length === 3
      ? new Date(`${parts[2]}-${parts[1].padStart(2,"0")}-${parts[0].padStart(2,"0")}`)
      : new Date(fechaStr);

    const precio = parseFloat((row["Ultimo Precio"] || "0").replace(/[$.\s]/g,"").replace(",","."));
    const costo  = parseFloat((row["Costo Vta"] || "0").replace(/[$.\s]/g,"").replace(",",".")) || 0;
    const margen = precio > 0 ? (precio - costo) / precio : 0;

    return fecha >= haceSeismeses && margen >= 0.20;
  });

  if (filasValidas.length > 0) {
    const row = filasValidas[0];
    const precio = parseFloat((row["Ultimo Precio"] || "0").replace(/[$.\s]/g,"").replace(",","."));
    return {
      encontrado: true,
      bajoMargen: false,
      producto: {
        CodProd: row["CodProd"],
        DesProd: row["DesProd"],
        precio,
        fecha: row["Fecha Ult. Vta"],
      }
    };
  }

  // Existe el producto pero tiene bajo margen o fecha vencida
  const row = filasProducto[0];
  const precio = parseFloat((row["Ultimo Precio"] || "0").replace(/[$.\s]/g,"").replace(",","."));
  const costo  = parseFloat((row["Costo Vta"] || "0").replace(/[$.\s]/g,"").replace(",",".")) || 0;
  const margen = precio > 0 ? (precio - costo) / precio : 0;
  const esBajoMargen = margen < 0.20;

  return {
    encontrado: false,
    bajoMargen: esBajoMargen,
    producto: {
      CodProd: row["CodProd"],
      DesProd: row["DesProd"],
      precio,
      margen: (margen * 100).toFixed(1),
    }
  };
}

// ─── Cargar CSV desde Google Sheets ──────────────────────────────────────────
async function cargarCSV() {
  try {
    const resp = await axios.get(GOOGLE_SHEETS_CSV_URL);
    return parse(resp.data, { columns: true, skip_empty_lines: true });
  } catch (err) {
    console.error("Error cargando CSV:", err.message);
    return null;
  }
}

// ─── Extraer RUT del texto ────────────────────────────────────────────────────
function extraerRUT(texto) {
  const match = texto.match(/\b(\d{7,8}[-.]?\d)\b/);
  if (!match) return null;
  const raw = match[1].replace(/[.\-\s]/g, "");
  if (!validarRUT(match[1])) return null;
  return {
    formato: match[1].toUpperCase(),
    limpio:  raw,
    sinDV:   raw.slice(0, -1),
  };
}

// ─── Extraer nombre del texto ─────────────────────────────────────────────────
function extraerNombre(texto) {
  const match = texto.match(/(?:soy|me llamo|mi nombre es)\s+([A-Za-záéíóúÁÉÍÓÚñÑ]+(?:\s+[A-Za-záéíóúÁÉÍÓÚñÑ]+)?)/i);
  return match ? match[1] : null;
}

// ─── Extraer productos y cantidades del texto ─────────────────────────────────
function extraerProductos(texto) {
  const productos = [];
  // Patrones: "toalla 2 paquetes", "lavaloza 10 unidades", "papel 3"
  const patron = /([a-záéíóúñA-ZÁÉÍÓÚÑ\s]+?)\s+(\d+)\s*(paquetes?|unidades?|cajas?|litros?|kilos?|kg|lt|un|paq|cja|bolsas?|rollos?|pares?)?(?=[,y]|$)/gi;
  let match;
  while ((match = patron.exec(texto)) !== null) {
    const nombre = match[1].trim().toLowerCase();
    const cantidad = parseInt(match[2]);
    const unidad = match[3] || "unidades";
    // Filtrar palabras irrelevantes
    if (nombre.length > 2 && !["hola", "soy", "necesito", "quiero", "nombre", "rut", "mi", "es"].includes(nombre)) {
      productos.push({ nombre, cantidad, unidad });
    }
  }
  return productos;
}

// ─── Enviar cotización completa ───────────────────────────────────────────────
async function enviarCotizacionCompleta(phone, data) {
  try {
    const resend = new Resend(RESEND_API_KEY);
    const fecha  = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
    const productos = data.productosConPrecio;

    let filasProductos = "";
    let total = 0;
    productos.forEach(p => {
      const subtotal = p.precio * p.cantidadSolicitada;
      total += subtotal;
      filasProductos += `
        <tr>
          <td style="padding:8px; border-bottom:1px solid #eee;">${p.CodProd}</td>
          <td style="padding:8px; border-bottom:1px solid #eee;">${p.DesProd}</td>
          <td style="padding:8px; border-bottom:1px solid #eee; text-align:right;">$${p.precio.toLocaleString("es-CL")}</td>
          <td style="padding:8px; border-bottom:1px solid #eee; text-align:center;">${p.cantidadSolicitada} ${p.unidad}</td>
          <td style="padding:8px; border-bottom:1px solid #eee; text-align:right;">$${subtotal.toLocaleString("es-CL")}</td>
        </tr>`;
    });

    const htmlCliente = `
      <div style="font-family:Arial,sans-serif; max-width:650px; margin:auto; padding:24px; border:1px solid #e0e0e0; border-radius:8px;">
        <div style="background:#c0392b; padding:16px; border-radius:8px 8px 0 0; text-align:center;">
          <h2 style="color:white; margin:0;">COTIZACIÓN CINTEC</h2>
        </div>
        <div style="padding:20px;">
          <p>Estimado/a <strong>${data.nombre || data.rut}</strong>,</p>
          <p>A continuación le presentamos nuestra cotización:</p>
          <p><strong>Fecha:</strong> ${fecha} &nbsp;&nbsp; <strong>RUT:</strong> ${data.rut}</p>
          <table style="width:100%; border-collapse:collapse; margin-top:10px;">
            <tr style="background:#c0392b; color:white;">
              <th style="padding:8px;">Código</th>
              <th style="padding:8px;">Descripción</th>
              <th style="padding:8px; text-align:right;">Precio Unit.</th>
              <th style="padding:8px; text-align:center;">Cantidad</th>
              <th style="padding:8px; text-align:right;">Subtotal</th>
            </tr>
            ${filasProductos}
            <tr style="background:#f9f9f9; font-weight:bold;">
              <td colspan="4" style="padding:8px; text-align:right;">TOTAL:</td>
              <td style="padding:8px; text-align:right;">$${total.toLocaleString("es-CL")}</td>
            </tr>
          </table>
          <hr style="margin:20px 0;"/>
          <p style="color:#555; font-size:12px;">Esta cotización tiene una vigencia de 30 días.</p>
          <p style="color:#555; font-size:12px;">CINTEC - Sociedad Comercial</p>
        </div>
      </div>`;

    // Email al cliente
    await resend.emails.send({
      from: "CINTEC <onboarding@resend.dev>",
      to: data.emailCliente,
      subject: `Cotización CINTEC - ${fecha}`,
      html: htmlCliente,
    });

    // Email interno
    await resend.emails.send({
      from: "Bot CINTEC <onboarding@resend.dev>",
      to: DESTINATION_EMAIL,
      subject: `📦 Cotización enviada - ${data.nombre || data.rut}`,
      html: `
        <div style="font-family:Arial,sans-serif; max-width:600px; margin:auto; padding:24px; border:1px solid #e0e0e0; border-radius:8px;">
          <h2 style="color:#c0392b;">📲 Cotización enviada vía WhatsApp</h2>
          <p><strong>Fecha:</strong> ${fecha}</p>
          <p><strong>RUT:</strong> ${data.rut}</p>
          <p><strong>Cliente:</strong> ${data.nombre || "-"}</p>
          <p><strong>Email cliente:</strong> ${data.emailCliente}</p>
          <p><strong>WhatsApp:</strong> +${phone}</p>
          ${htmlCliente}
        </div>`
    });

    console.log(`📧 Cotización enviada a ${data.emailCliente}`);

    await sendMessage(phone,
      `✅ ¡Listo! Tu cotización fue enviada a *${data.emailCliente}*.\n\n` +
      `¡Gracias por preferirnos! Si necesitas algo más escribe *hola*. 🙏`
    );
    return true;
  } catch (err) {
    console.error("Error enviando cotización:", err.message);
    return false;
  }
}

// ─── Notificar bajo margen al correo interno ──────────────────────────────────
async function notificarBajoMargen(phone, data, productosSinMargen) {
  try {
    const resend = new Resend(RESEND_API_KEY);
    const fecha  = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });

    let filas = "";
    productosSinMargen.forEach(p => {
      filas += `
        <tr>
          <td style="padding:8px; border-bottom:1px solid #eee;">${p.producto?.CodProd || "-"}</td>
          <td style="padding:8px; border-bottom:1px solid #eee;">${p.producto?.DesProd || p.nombre}</td>
          <td style="padding:8px; border-bottom:1px solid #eee; text-align:center;">${p.cantidad} ${p.unidad}</td>
          <td style="padding:8px; border-bottom:1px solid #eee; text-align:right; color:#e74c3c;">${p.producto?.margen || "-"}%</td>
        </tr>`;
    });

    await resend.emails.send({
      from: "Bot CINTEC <onboarding@resend.dev>",
      to: DESTINATION_EMAIL,
      subject: `⚠️ Productos con bajo margen - ${data.nombre || data.rut}`,
      html: `
        <div style="font-family:Arial,sans-serif; max-width:600px; margin:auto; padding:24px; border:1px solid #e74c3c; border-radius:8px;">
          <h2 style="color:#e74c3c;">⚠️ Productos no cotizados por bajo margen</h2>
          <p><strong>Fecha:</strong> ${fecha}</p>
          <p><strong>Cliente:</strong> ${data.nombre || "-"} | RUT: ${data.rut}</p>
          <p><strong>WhatsApp:</strong> +${phone}</p>
          <p>Los siguientes productos fueron solicitados pero <strong>no se cotizaron</strong> porque el margen es inferior al 20%. Requieren revisión del área de análisis:</p>
          <table style="width:100%; border-collapse:collapse; margin-top:10px;">
            <tr style="background:#e74c3c; color:white;">
              <th style="padding:8px;">Código</th>
              <th style="padding:8px;">Producto</th>
              <th style="padding:8px;">Cantidad</th>
              <th style="padding:8px;">Margen actual</th>
            </tr>
            ${filas}
          </table>
          <p style="margin-top:16px; color:#555;">Por favor contactar al cliente para informar actualización de precios.</p>
        </div>`
    });

    console.log(`⚠️ Notificación bajo margen enviada para ${data.rut}`);
  } catch (err) {
    console.error("Error notificando bajo margen:", err.message);
  }
}

// ─── Notificar interno sin cotización ────────────────────────────────────────
async function notificarInterno(phone, data) {
  try {
    const resend = new Resend(RESEND_API_KEY);
    const fecha  = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
    await resend.emails.send({
      from: "Bot CINTEC <onboarding@resend.dev>",
      to: DESTINATION_EMAIL,
      subject: `📋 Solicitud sin cotización - ${data.nombre || data.rut}`,
      html: `
        <div style="font-family:Arial,sans-serif; max-width:600px; margin:auto; padding:24px;">
          <h2>📋 Solicitud recibida sin productos para cotizar</h2>
          <p><strong>Fecha:</strong> ${fecha}</p>
          <p><strong>Cliente:</strong> ${data.nombre || "-"} | RUT: ${data.rut}</p>
          <p><strong>WhatsApp:</strong> +${phone}</p>
          <p>El cliente fue informado que un representante lo contactará.</p>
        </div>`
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
  const exp = 11 - (sum % 11);
  const dvExp = exp === 11 ? "0" : exp === 10 ? "K" : String(exp);
  return dv === dvExp;
}

// ─── Inicio del servidor ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📌 Webhook URL: http://TU-DOMINIO/webhook`);
});
