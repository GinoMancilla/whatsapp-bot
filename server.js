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
  WAITING_RAZON:    "waiting_razon_social",
  WAITING_PRODUCTO: "waiting_producto",
  CONFIRMING:       "confirming",
  WAITING_CANTIDAD: "waiting_cantidad",
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
        `Para ayudarte con tu cotización necesito algunos datos.\n\n` +
        `📋 ¿Cuál es tu *RUT*?\n_Ejemplo: 12.345.678-9_`
      );
      session.step = STEPS.WAITING_RUT;
      break;

    case STEPS.WAITING_RUT:
      if (!validarRUT(text)) {
        await sendMessage(phone,
          `⚠️ El RUT ingresado no es válido.\nPor favor ingrésalo nuevamente.\n_Ejemplo: 12.345.678-9_`
        );
        break;
      }
      session.data.rut = text.toUpperCase();
      session.data.rutLimpio = text.replace(/[.\-\s]/g, "");
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
      session.step = STEPS.WAITING_PRODUCTO;
      await sendMessage(phone,
        `✅ Empresa registrada.\n\n📦 ¿Qué *producto* necesitas cotizar?\n_Describe el producto o indica el código._`
      );
      break;

    case STEPS.WAITING_PRODUCTO:
      if (text.length < 2) {
        await sendMessage(phone, `⚠️ Por favor describe el producto que necesitas.`);
        break;
      }
      session.data.productoBuscado = text;
      await sendMessage(phone, `🔍 Buscando en nuestro catálogo...`);

      const historial = await buscarProductoEnHistorial(session.data.rutLimpio, text);

      if (historial && historial.length > 0) {
        session.data.productosEncontrados = historial;
        let msg = `📋 Encontré estos productos en tu historial de compras:\n\n`;
        historial.forEach((p, i) => {
          msg += `*${i + 1}.* ${p.DesProd}\n`;
          msg += `   🏷️ Código: ${p.CodProd}\n`;
          msg += `   💰 Precio: $${parseInt(p.precio).toLocaleString("es-CL")}\n`;
          msg += `   📅 Última compra: ${p.fecha}\n\n`;
        });
        msg += `¿Es alguno de estos el producto que buscas? Responde con el *número* o escribe *no* para buscar otro.`;
        await sendMessage(phone, msg);
        session.step = STEPS.CONFIRMING;
      } else {
        await sendMessage(phone,
          `ℹ️ No encontré ese producto en tu historial reciente.\n\n` +
          `Un representante revisará tu solicitud y te contactará a la brevedad.\n\n` +
          `📧 ¿Cuál es tu *correo electrónico* para enviarte la cotización?`
        );
        session.data.productosEncontrados = [];
        session.step = STEPS.WAITING_EMAIL;
      }
      break;

    case STEPS.CONFIRMING:
      const productos = session.data.productosEncontrados;
      const num = parseInt(text);

      if (text.toLowerCase() === "no") {
        await sendMessage(phone,
          `Entendido. Un representante revisará tu solicitud.\n\n` +
          `📧 ¿Cuál es tu *correo electrónico* para enviarte la cotización?`
        );
        session.data.productoSeleccionado = null;
        session.step = STEPS.WAITING_EMAIL;
        break;
      }

      if (isNaN(num) || num < 1 || num > productos.length) {
        await sendMessage(phone,
          `⚠️ Por favor responde con un número entre 1 y ${productos.length}, o escribe *no*.`
        );
        break;
      }

      session.data.productoSeleccionado = productos[num - 1];
      await sendMessage(phone,
        `✅ Perfecto, seleccionaste:\n*${session.data.productoSeleccionado.DesProd}*\n\n` +
        `📦 ¿Qué *cantidad* necesitas?`
      );
      session.step = STEPS.WAITING_CANTIDAD;
      break;

    case STEPS.WAITING_CANTIDAD:
      const cantidad = parseInt(text);
      if (isNaN(cantidad) || cantidad < 1) {
        await sendMessage(phone, `⚠️ Por favor ingresa una cantidad válida.`);
        break;
      }
      session.data.cantidad = cantidad;
      await sendMessage(phone,
        `✅ Cantidad: *${cantidad} unidades*\n\n` +
        `📧 ¿Cuál es tu *correo electrónico* para enviarte la cotización?`
      );
      session.step = STEPS.WAITING_EMAIL;
      break;

    case STEPS.WAITING_EMAIL:
      if (!text.includes("@") || !text.includes(".")) {
        await sendMessage(phone, `⚠️ Por favor ingresa un correo electrónico válido.`);
        break;
      }
      session.data.emailCliente = text.toLowerCase();
      session.step = STEPS.DONE;

      const emailOk = await enviarCotizacion(phone, session.data);

      if (emailOk) {
        await sendMessage(phone,
          `✅ ¡Listo! Tu cotización ha sido enviada a *${session.data.emailCliente}*.\n\n` +
          `Un representante de CINTEC se pondrá en contacto contigo a la brevedad.\n\n` +
          `¡Gracias por preferirnos! 🙏`
        );
      } else {
        await sendMessage(phone,
          `⚠️ Hubo un problema al enviar la cotización. Por favor intenta nuevamente.`
        );
        delete sessions[phone];
      }
      setTimeout(() => delete sessions[phone], 5 * 60 * 1000);
      break;

    case STEPS.DONE:
      await sendMessage(phone,
        `Tu solicitud ya fue procesada. Escribe *hola* para iniciar una nueva cotización.`
      );
      break;
  }
}

// ─── Buscar producto en Google Sheets ────────────────────────────────────────
async function buscarProductoEnHistorial(rutLimpio, productoBuscado) {
  try {
    const resp = await axios.get(process.env.GOOGLE_SHEETS_CSV_URL);
    const rows = parse(resp.data, { columns: true, skip_empty_lines: true });

console.log("Total filas CSV:", rows.length);
    console.log("Primera fila:", JSON.stringify(rows[0]));
    console.log("RUT buscado:", rutLimpio);
const rutSinDV = rutLimpio.slice(0, -1);
const filasConRut = rows.filter(r => 
  (r["CodAuxGSaen"] || "") === rutLimpio || 
  (r["CodAuxGSaen"] || "") === rutSinDV
);
console.log("Filas encontradas para este RUT:", filasConRut.length);
// Debug filtros
filasConRut.forEach((row, i) => {
  const fechaStr = row["Fecha Ult. Vta"] || "";
  const parts = fechaStr.split("/");
  const fecha = parts.length === 3 ? new Date(`${parts[2]}-${parts[1].padStart(2,"0")}-${parts[0].padStart(2,"0")}`) : new Date(fechaStr);
  const precio = parseFloat((row["Ultimo Precio"] || "0").replace(/[$.\s]/g,"").replace(",","."));
  const costoStr = (row["Costo Vta"] || "0").replace(/[$.\s]/g,"").replace(",",".");
  const costo = parseFloat(costoStr) || 0;
  const margen = precio > 0 ? (precio - costo) / precio : 0;
  const desc = (row["DesProd"] || "").toLowerCase();
  console.log(`Fila ${i}: ${desc} | fecha: ${fecha.toLocaleDateString()} | margen: ${(margen*100).toFixed(1)}% | fechaOk: ${fecha >= haceSeismeses} | margenOk: ${margen >= 0.20}`);
});
if (filasConRut.length > 0) console.log("Ejemplo:", JSON.stringify(filasConRut[0]));
    console.log("Columnas disponibles:", Object.keys(rows[0]));
    const haceSeismeses = new Date();
    haceSeismeses.setMonth(haceSeismeses.getMonth() - 6);

    const keywords = productoBuscado.toLowerCase().split(" ").filter(w => w.length > 2);

    const resultados = rows.filter(row => {
      // Filtrar por RUT (sin puntos ni guión)
      const rutRow = (row["CodAuxGSaen"] || "").replace(/[.\-\s]/g, "");
const rutSinDV = rutLimpio.slice(0, -1); // Sin dígito verificador
const rutMatch = rutRow === rutLimpio || rutRow === rutSinDV;

      // Filtrar por fecha últimos 6 meses
      const fechaStr = row["Fecha Ult. Vta"] || row["Fecha"] || "";
      // Parsear fecha en formato DD-MM-YYYY o DD/MM/YYYY
      let fecha;
      if (fechaStr.includes("-") || fechaStr.includes("/")) {
        const sep = fechaStr.includes("-") ? "-" : "/";
        const parts = fechaStr.split(sep);
        if (parts[0].length === 2) {
          // Formato DD-MM-YYYY
          fecha = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
        } else {
          fecha = new Date(fechaStr);
        }
      } else {
        fecha = new Date(fechaStr);
      }
      const fechaOk = fecha >= haceSeismeses;

      // Calcular margen: (PrecioVta - Costo) / PrecioVta
      const precio = parseFloat((row["Ultimo Precio"] || "0").replace(/[$.,]/g, "").replace(",", "."));
      const costo  = parseFloat((row["Costo Vta"] || "0").replace(/[$.,]/g, "").replace(",", "."));
      const margen = precio > 0 ? (precio - costo) / precio : 0;
      const margenOk = margen >= 0.20;

      // Filtrar por producto buscado
      const desc = (row["DesProd"] || "").toLowerCase();
      const cod  = (row["CodProd"] || "").toLowerCase();
      const prodMatch = keywords.some(k => desc.includes(k) || cod.includes(k));

      return rutMatch && fechaOk && margenOk && prodMatch;
    });

    // Eliminar duplicados por CodProd y quedarse con el más reciente
    const unicos = {};
    resultados.forEach(row => {
      const cod = row["CodProd"];
      if (!unicos[cod]) {
        unicos[cod] = {
          CodProd:  row["CodProd"],
          DesProd:  row["DesProd"],
          precio:   row["Ultimo Precio"].replace(/[$\s]/g, ""),
          fecha:    row["Fecha Ult. Vta"] || row["Fecha"],
        };
      }
    });

    return Object.values(unicos).slice(0, 5);
  } catch (err) {
    console.error("Error leyendo Google Sheets:", err.message);
    return null;
  }
}

// ─── Enviar cotización por email ──────────────────────────────────────────────
async function enviarCotizacion(phone, data) {
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const fecha  = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
    const prod   = data.productoSeleccionado;

    const detalleProducto = prod
      ? `
        <table style="width:100%; border-collapse:collapse; margin-top:10px;">
          <tr style="background:#f2f2f2;">
            <td style="padding:8px; font-weight:bold;">Código</td>
            <td style="padding:8px; font-weight:bold;">Descripción</td>
            <td style="padding:8px; font-weight:bold;">Precio Unit.</td>
            <td style="padding:8px; font-weight:bold;">Cantidad</td>
            <td style="padding:8px; font-weight:bold;">Total</td>
          </tr>
          <tr>
            <td style="padding:8px;">${prod.CodProd}</td>
            <td style="padding:8px;">${prod.DesProd}</td>
            <td style="padding:8px;">$${parseInt(prod.precio).toLocaleString("es-CL")}</td>
            <td style="padding:8px;">${data.cantidad}</td>
            <td style="padding:8px;">$${(parseInt(prod.precio) * data.cantidad).toLocaleString("es-CL")}</td>
          </tr>
        </table>`
      : `<p>Producto solicitado: <strong>${data.productoBuscado}</strong><br>
         <em>Un representante revisará disponibilidad y precio.</em></p>`;

    // Email al cliente
    await resend.emails.send({
      from: "CINTEC <onboarding@resend.dev>",
      to: data.emailCliente,
      subject: `Cotización CINTEC - ${data.razonSocial}`,
      html: `
        <div style="font-family:Arial,sans-serif; max-width:600px; margin:auto; padding:24px; border:1px solid #e0e0e0; border-radius:8px;">
          <div style="background:#c0392b; padding:16px; border-radius:8px 8px 0 0; text-align:center;">
            <h2 style="color:white; margin:0;">COTIZACIÓN CINTEC</h2>
          </div>
          <div style="padding:20px;">
            <p>Estimado/a <strong>${data.razonSocial}</strong>,</p>
            <p>A continuación le presentamos nuestra cotización según lo solicitado:</p>
            <p><strong>Fecha:</strong> ${fecha}</p>
            ${detalleProducto}
            <hr style="margin:20px 0;"/>
            <p style="color:#555; font-size:12px;">Esta cotización tiene una vigencia de 30 días. Para confirmar su pedido, responda este correo o contáctenos directamente.</p>
            <p style="color:#555; font-size:12px;">CINTEC - Sociedad Comercial</p>
          </div>
        </div>`
    });

    // Email de notificación interno
    await resend.emails.send({
      from: "Bot CINTEC <onboarding@resend.dev>",
      to: DESTINATION_EMAIL,
      subject: `📦 Nueva cotización enviada - ${data.razonSocial}`,
      html: `
        <div style="font-family:Arial,sans-serif; max-width:600px; margin:auto; padding:24px; border:1px solid #e0e0e0; border-radius:8px;">
          <h2 style="color:#c0392b;">📲 Nueva cotización vía WhatsApp</h2>
          <p><strong>Fecha:</strong> ${fecha}</p>
          <table style="width:100%; border-collapse:collapse;">
            <tr><td style="padding:8px; background:#f9f9f9; font-weight:bold;">📞 WhatsApp</td><td style="padding:8px;">+${phone}</td></tr>
            <tr><td style="padding:8px; font-weight:bold;">🪪 RUT</td><td style="padding:8px;">${data.rut}</td></tr>
            <tr><td style="padding:8px; background:#f9f9f9; font-weight:bold;">🏢 Empresa</td><td style="padding:8px; background:#f9f9f9;">${data.razonSocial}</td></tr>
            <tr><td style="padding:8px; font-weight:bold;">📧 Email cliente</td><td style="padding:8px;">${data.emailCliente}</td></tr>
            <tr><td style="padding:8px; background:#f9f9f9; font-weight:bold;">📦 Producto solicitado</td><td style="padding:8px; background:#f9f9f9;">${data.productoBuscado}</td></tr>
            ${prod ? `<tr><td style="padding:8px; font-weight:bold;">✅ Producto cotizado</td><td style="padding:8px;">${prod.CodProd} - ${prod.DesProd}</td></tr>
            <tr><td style="padding:8px; background:#f9f9f9; font-weight:bold;">💰 Precio</td><td style="padding:8px; background:#f9f9f9;">$${parseInt(prod.precio).toLocaleString("es-CL")}</td></tr>
            <tr><td style="padding:8px; font-weight:bold;">📦 Cantidad</td><td style="padding:8px;">${data.cantidad} unidades</td></tr>
            <tr><td style="padding:8px; background:#f9f9f9; font-weight:bold;">💵 Total</td><td style="padding:8px; background:#f9f9f9;">$${(parseInt(prod.precio) * data.cantidad).toLocaleString("es-CL")}</td></tr>` : ""}
          </table>
          <p style="color:#888; font-size:12px; margin-top:16px;">Cotización enviada al cliente en ${fecha}</p>
        </div>`
    });

    console.log(`📧 Cotización enviada a ${data.emailCliente} para ${data.razonSocial}`);
    return true;
  } catch (err) {
    console.error("Error enviando cotización:", err.message);
    return false;
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
