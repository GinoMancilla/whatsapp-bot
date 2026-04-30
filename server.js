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
  START:            "start",
  WAITING_RUT:      "waiting_rut",
  WAITING_RAZON:    "waiting_razon",
  WAITING_PRODUTOS: "waiting_productos",
  WAITING_EMAIL:    "waiting_email",
  DONE:             "done",
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
      await sendMessage(phone,
        `👋 ¡Hola! Bienvenido/a a *CINTEC*.\n\n` +
        `Para cotizarte necesito algunos datos.\n\n` +
        `📋 ¿Cuál es tu *RUT*?\n_Ejemplo: 12.345.678-9_`
      );
      session.step = STEPS.WAITING_RUT;
      break;

    case STEPS.WAITING_RUT:
      const rutLimpio = text.replace(/[.\-\s]/g, "").toUpperCase();
      if (!validarRUT(text)) {
        await sendMessage(phone,
          `⚠️ El RUT ingresado no es válido.\nPor favor ingrésalo nuevamente.\n_Ejemplo: 12.345.678-9_`
        );
        break;
      }
      session.data.rut = text.toUpperCase();
      session.data.rutLimpio = rutLimpio;
      session.data.rutSinDV  = rutLimpio.slice(0, -1);
      session.step = STEPS.WAITING_RAZON;
      await sendMessage(phone,
        `✅ RUT registrado.\n\n🏢 ¿Cuál es la *Razón Social* de tu empresa?`
      );
      break;

    case STEPS.WAITING_RAZON:
      if (text.length < 3) {
        await sendMessage(phone, `⚠️ Por favor ingresa la razón social completa.`);
        break;
      }
      session.data.razonSocial = text;
      session.step = STEPS.WAITING_PRODUTOS;
      await sendMessage(phone,
        `✅ Empresa registrada.\n\n` +
        `📦 ¿Qué productos necesitas cotizar?\n\n` +
        `_Puedes indicar varios productos con sus cantidades, por ejemplo:_\n` +
        `_"lavaloza 10 unidades, toalla 2 paquetes, papel higiénico 3 paquetes"_`
      );
      break;

    case STEPS.WAITING_PRODUTOS:
      if (text.length < 3) {
        await sendMessage(phone, `⚠️ Por favor describe los productos que necesitas.`);
        break;
      }
      session.data.textoProductos = text;
      await sendMessage(phone, `🔍 Buscando productos en nuestro catálogo...`);
      await procesarProductos(phone, session);
      break;

    case STEPS.WAITING_EMAIL:
      if (!text.includes("@") || !text.includes(".")) {
        await sendMessage(phone, `⚠️ Por favor ingresa un correo electrónico válido.`);
        break;
      }
      session.data.emailCliente = text.toLowerCase();
      await enviarCotizacionCompleta(phone, session.data);
      session.step = STEPS.DONE;
      setTimeout(() => delete sessions[phone], 5 * 60 * 1000);
      break;

    case STEPS.DONE:
      await sendMessage(phone,
        `Tu solicitud ya fue procesada. Escribe *hola* para iniciar una nueva cotización.`
      );
      break;
  }
}

// ─── Procesar productos ───────────────────────────────────────────────────────
async function procesarProductos(phone, session) {
  const rows = await cargarCSV();
  if (!rows) {
    await sendMessage(phone, `⚠️ Error al acceder al catálogo. Por favor intenta nuevamente.`);
    return;
  }

  // Parsear productos del texto
  const itemsTexto = parsearProductos(session.data.textoProductos);
  console.log("Productos parseados:", JSON.stringify(itemsTexto));

  const productosConPrecio  = [];
  const productosBajoMargen = [];
  const productosNoEncontrados = [];

  for (const item of itemsTexto) {
    const resultado = buscarProducto(rows, session.data.rutSinDV, item.nombre);
    if (resultado.encontrado) {
      productosConPrecio.push({
        ...resultado.producto,
        cantidad: item.cantidad,
        unidad: item.unidad,
      });
    } else if (resultado.bajoMargen) {
      productosBajoMargen.push({ ...item, producto: resultado.producto });
    } else {
      productosNoEncontrados.push(item.nombre);
    }
  }

  session.data.productosConPrecio  = productosConPrecio;
  session.data.productosBajoMargen = productosBajoMargen;
  session.data.productosNoEncontrados = productosNoEncontrados;

  // Armar respuesta al cliente
  let respuesta = "";

  if (productosConPrecio.length > 0) {
    respuesta += `✅ *Productos disponibles:*\n\n`;
    let total = 0;
    productosConPrecio.forEach((p, i) => {
      const subtotal = p.precio * p.cantidad;
      total += subtotal;
      respuesta += `*${i + 1}. ${p.DesProd}*\n`;
      respuesta += `   🏷️ Código: ${p.CodProd}\n`;
      respuesta += `   💰 Precio: $${p.precio.toLocaleString("es-CL")}\n`;
      respuesta += `   📦 Cantidad: ${p.cantidad} ${p.unidad}\n`;
      respuesta += `   💵 Subtotal: $${subtotal.toLocaleString("es-CL")}\n\n`;
    });
    respuesta += `*💵 TOTAL: $${total.toLocaleString("es-CL")}*\n\n`;
  }

  if (productosBajoMargen.length > 0) {
    respuesta += `⚠️ *Los siguientes productos requieren actualización de precios:*\n`;
    productosBajoMargen.forEach(p => {
      respuesta += `• ${p.nombre} (${p.cantidad} ${p.unidad})\n`;
    });
    respuesta += `_Un representante te contactará a la brevedad con los precios actualizados._\n\n`;
    await notificarBajoMargen(phone, session.data, productosBajoMargen);
  }

  if (productosNoEncontrados.length > 0) {
    respuesta += `ℹ️ *No encontramos historial de:*\n`;
    productosNoEncontrados.forEach(p => { respuesta += `• ${p}\n`; });
    respuesta += `_Un representante revisará disponibilidad._\n\n`;
  }

  if (productosConPrecio.length > 0) {
    respuesta += `📧 ¿A qué *correo electrónico* te enviamos la cotización?`;
    session.step = STEPS.WAITING_EMAIL;
  } else {
    respuesta += `Un representante se pondrá en contacto contigo a la brevedad.`;
    session.step = STEPS.DONE;
    await notificarInterno(phone, session.data);
    setTimeout(() => delete sessions[phone], 5 * 60 * 1000);
  }

  await sendMessage(phone, respuesta);
}

// ─── Parsear texto de productos ───────────────────────────────────────────────
function parsearProductos(texto) {
  const items = [];
  // Dividir por comas o "y"
  const partes = texto.split(/,|\sy\s/i);

  partes.forEach(parte => {
    parte = parte.trim();
    // Buscar número al inicio o al final
    const matchInicio = parte.match(/^(\d+)\s+(.+?)(?:\s+(paquetes?|unidades?|cajas?|litros?|kilos?|kg|lt|un|paq|bolsas?|rollos?))?$/i);
    const matchFinal  = parte.match(/^(.+?)\s+(\d+)\s*(paquetes?|unidades?|cajas?|litros?|kilos?|kg|lt|un|paq|bolsas?|rollos?)?$/i);

    if (matchInicio) {
      items.push({
        cantidad: parseInt(matchInicio[1]),
        nombre:   matchInicio[2].trim().toLowerCase(),
        unidad:   matchInicio[3] || "unidades",
      });
    } else if (matchFinal) {
      items.push({
        nombre:   matchFinal[1].trim().toLowerCase(),
        cantidad: parseInt(matchFinal[2]),
        unidad:   matchFinal[3] || "unidades",
      });
    } else if (parte.length > 2) {
      items.push({ nombre: parte.toLowerCase(), cantidad: 1, unidad: "unidades" });
    }
  });

  return items;
}

// ─── Buscar producto en CSV ───────────────────────────────────────────────────
function buscarProducto(rows, rutSinDV, nombreBuscado) {
  const haceSeismeses = new Date();
  haceSeismeses.setMonth(haceSeismeses.getMonth() - 6);

  const keywords = nombreBuscado.toLowerCase().split(" ").filter(w => w.length > 2);

  const filasCliente = rows.filter(row =>
    (row["CodAuxGSaen"] || "").replace(/[.\-\s]/g, "") === rutSinDV
  );

  const filasProducto = filasCliente.filter(row => {
    const desc = (row["DesProd"] || "").toLowerCase();
    const cod  = (row["CodProd"] || "").toLowerCase();
    return keywords.some(k => desc.includes(k) || cod.includes(k));
  });

  if (filasProducto.length === 0) return { encontrado: false, bajoMargen: false };

  const filasValidas = filasProducto.filter(row => {
    const fechaStr = row["Fecha Ult. Vta"] || "";
    const parts    = fechaStr.split("/");
    const fecha    = parts.length === 3
      ? new Date(`${parts[2]}-${parts[1].padStart(2,"0")}-${parts[0].padStart(2,"0")}`)
      : new Date(fechaStr);

    const precio = parseFloat((row["Ultimo Precio"] || "0").replace(/[$.\s]/g,"").replace(",","."));
    const costo  = parseFloat((row["Costo Vta"] || "0").replace(/[$.\s]/g,"").replace(",",".")) || 0;
    const margen = precio > 0 ? (precio - costo) / precio : 0;

    return fecha >= haceSeismeses && margen >= 0.20;
  });

  if (filasValidas.length > 0) {
    const row    = filasValidas[0];
    const precio = parseFloat((row["Ultimo Precio"] || "0").replace(/[$.\s]/g,"").replace(",","."));
    return {
      encontrado: true,
      bajoMargen: false,
      producto: { CodProd: row["CodProd"], DesProd: row["DesProd"], precio, fecha: row["Fecha Ult. Vta"] }
    };
  }

  const row    = filasProducto[0];
  const precio = parseFloat((row["Ultimo Precio"] || "0").replace(/[$.\s]/g,"").replace(",","."));
  const costo  = parseFloat((row["Costo Vta"] || "0").replace(/[$.\s]/g,"").replace(",",".")) || 0;
  const margen = precio > 0 ? (precio - costo) / precio : 0;

  return {
    encontrado: false,
    bajoMargen: margen < 0.20,
    producto: { CodProd: row["CodProd"], DesProd: row["DesProd"], precio, margen: (margen*100).toFixed(1) }
  };
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
    const resend = new Resend(RESEND_API_KEY);
    const fecha  = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
    const productos = data.productosConPrecio;

    let filas = "";
    let total = 0;
    productos.forEach(p => {
      const subtotal = p.precio * p.cantidad;
      total += subtotal;
      filas += `
        <tr>
          <td style="padding:8px; border-bottom:1px solid #eee;">${p.CodProd}</td>
          <td style="padding:8px; border-bottom:1px solid #eee;">${p.DesProd}</td>
          <td style="padding:8px; border-bottom:1px solid #eee; text-align:right;">$${p.precio.toLocaleString("es-CL")}</td>
          <td style="padding:8px; border-bottom:1px solid #eee; text-align:center;">${p.cantidad} ${p.unidad}</td>
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
          <table style="width:100%; border-collapse:collapse; margin-top:10px;">
            <tr style="background:#c0392b; color:white;">
              <th style="padding:8px;">Código</th>
              <th style="padding:8px;">Descripción</th>
              <th style="padding:8px; text-align:right;">Precio Unit.</th>
              <th style="padding:8px;">Cantidad</th>
              <th style="padding:8px; text-align:right;">Subtotal</th>
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
      subject: `📦 Cotización enviada - ${data.razonSocial}`,
      html: `
        <h2 style="color:#c0392b;">📲 Cotización enviada vía WhatsApp</h2>
        <p><strong>Cliente:</strong> ${data.razonSocial} | RUT: ${data.rut}</p>
        <p><strong>Email:</strong> ${data.emailCliente} | WhatsApp: +${phone}</p>
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
      html: `
        <div style="font-family:Arial,sans-serif; max-width:600px; margin:auto; padding:24px; border:2px solid #e74c3c; border-radius:8px;">
          <h2 style="color:#e74c3c;">⚠️ Productos no cotizados por bajo margen</h2>
          <p><strong>Cliente:</strong> ${data.razonSocial} | RUT: ${data.rut} | WhatsApp: +${phone}</p>
          <p><strong>Fecha:</strong> ${fecha}</p>
          <table style="width:100%; border-collapse:collapse;">
            <tr style="background:#e74c3c; color:white;">
              <th style="padding:8px;">Código</th>
              <th style="padding:8px;">Producto</th>
              <th style="padding:8px;">Cantidad</th>
              <th style="padding:8px;">Margen actual</th>
            </tr>
            ${filas}
          </table>
          <p style="margin-top:16px;">⚡ Acción requerida: revisar precios y contactar al cliente.</p>
        </div>`,
    });
    console.log(`⚠️ Notificación bajo margen enviada`);
  } catch (err) {
    console.error("Error notificando bajo margen:", err.message);
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
      html: `
        <h2>📋 Solicitud sin productos para cotizar</h2>
        <p><strong>Fecha:</strong> ${fecha}</p>
        <p><strong>Cliente:</strong> ${data.razonSocial} | RUT: ${data.rut} | WhatsApp: +${phone}</p>
        <p>Productos solicitados: ${data.textoProductos}</p>
        <p>El cliente fue informado que un representante lo contactará.</p>`,
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
