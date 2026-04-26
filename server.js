require("dotenv").config();
const express = require("express");
const axios = require("axios");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json());

// ─── Configuración ───────────────────────────────────────────────────────────
const {
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID,
  VERIFY_TOKEN,
  GMAIL_USER,
  GMAIL_APP_PASSWORD,
  DESTINATION_EMAIL,
} = process.env;

// ─── Estado de conversaciones en memoria ─────────────────────────────────────
// Para producción usa Redis o una base de datos
const sessions = {};

// ─── Pasos de la conversación ─────────────────────────────────────────────────
const STEPS = {
  START:          "start",
  WAITING_RUT:    "waiting_rut",
  WAITING_RAZON:  "waiting_razon_social",
  WAITING_PROD:   "waiting_productos",
  DONE:           "done",
};

// ─── Verificación del webhook (Meta requiere esto) ────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado correctamente");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── Recepción de mensajes ────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Responde rápido a Meta

  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;

    if (!value?.messages) return;

    const msg     = value.messages[0];
    const from    = msg.from;           // Número del cliente
    const text    = msg.text?.body?.trim();

    if (!text) return;

    await handleMessage(from, text);
  } catch (err) {
    console.error("Error procesando mensaje:", err.message);
  }
});

// ─── Lógica del bot ───────────────────────────────────────────────────────────
async function handleMessage(phone, text) {
  // Inicializa sesión si no existe
  if (!sessions[phone]) {
    sessions[phone] = { step: STEPS.START, data: {} };
  }

  const session = sessions[phone];

  switch (session.step) {

    case STEPS.START:
      await sendMessage(phone,
        `👋 ¡Hola! Bienvenido/a.\n\n` +
        `Soy el asistente virtual. Para procesar tu solicitud necesito algunos datos.\n\n` +
        `📋 *¿Cuál es tu RUT?*\n_Ejemplo: 12.345.678-9_`
      );
      session.step = STEPS.WAITING_RUT;
      break;

    case STEPS.WAITING_RUT:
      if (!validarRUT(text)) {
        await sendMessage(phone,
          `⚠️ El RUT ingresado no parece válido.\n` +
          `Por favor ingrésalo nuevamente.\n_Ejemplo: 12.345.678-9_`
        );
        break;
      }
      session.data.rut = text.toUpperCase();
      await sendMessage(phone,
        `✅ RUT registrado: *${session.data.rut}*\n\n` +
        `🏢 ¿Cuál es la *Razón Social* de tu empresa?`
      );
      session.step = STEPS.WAITING_RAZON;
      break;

    case STEPS.WAITING_RAZON:
      if (text.length < 3) {
        await sendMessage(phone, `⚠️ Por favor ingresa la razón social completa.`);
        break;
      }
      session.data.razonSocial = text;
      await sendMessage(phone,
        `✅ Razón Social: *${session.data.razonSocial}*\n\n` +
        `📦 ¿Qué *productos* necesitas?\n` +
        `_Puedes listar varios separados por coma._`
      );
      session.step = STEPS.WAITING_PROD;
      break;

    case STEPS.WAITING_PROD:
      if (text.length < 3) {
        await sendMessage(phone, `⚠️ Por favor describe los productos que necesitas.`);
        break;
      }
      session.data.productos = text;
      session.step = STEPS.DONE;

      // Enviar email y confirmar al cliente
      const emailOk = await enviarEmail(phone, session.data);

      if (emailOk) {
        await sendMessage(phone,
          `✅ ¡Muchas gracias! Hemos recibido tu solicitud con éxito.\n\n` +
          `📋 *Resumen:*\n` +
          `• RUT: ${session.data.rut}\n` +
          `• Empresa: ${session.data.razonSocial}\n` +
          `• Productos: ${session.data.productos}\n\n` +
          `📩 Un representante se pondrá en contacto contigo a la brevedad.`
        );
      } else {
        await sendMessage(phone,
          `⚠️ Hubo un problema al enviar tu solicitud. Por favor intenta nuevamente.`
        );
        delete sessions[phone]; // Resetea para que pueda reintentar
      }

      // Limpia sesión completada después de 5 min
      setTimeout(() => delete sessions[phone], 5 * 60 * 1000);
      break;

    case STEPS.DONE:
      await sendMessage(phone,
        `Tu solicitud ya fue enviada. ¿Deseas iniciar una nueva?\n` +
        `Escribe *hola* o *nueva solicitud* para comenzar.`
      );
      // Permite reiniciar
      if (/^(hola|nueva solicitud|reiniciar|inicio)$/i.test(text)) {
        delete sessions[phone];
        await handleMessage(phone, text);
      }
      break;
  }
}

// ─── Enviar mensaje por WhatsApp Cloud API ─────────────────────────────────
async function sendMessage(to, body) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("Error enviando mensaje WhatsApp:", err.response?.data || err.message);
  }
}

// ─── Enviar email con Nodemailer ──────────────────────────────────────────────
async function enviarEmail(phone, data) {
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASSWORD, // Contraseña de aplicación de Google
      },
    });

    const fecha = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });

    await transporter.sendMail({
      from: `"Bot WhatsApp" <${GMAIL_USER}>`,
      to: DESTINATION_EMAIL,
      subject: `📦 Nueva solicitud de cliente - ${data.razonSocial}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #25D366;">📲 Nueva Solicitud vía WhatsApp</h2>
          <p style="color: #555;">Recibida el <strong>${fecha}</strong></p>
          <hr/>
          <table style="width:100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 10px; background:#f9f9f9; font-weight:bold; width:40%;">📞 Teléfono WhatsApp</td>
              <td style="padding: 10px;">+${phone}</td>
            </tr>
            <tr>
              <td style="padding: 10px; font-weight:bold;">🪪 RUT</td>
              <td style="padding: 10px;">${data.rut}</td>
            </tr>
            <tr>
              <td style="padding: 10px; background:#f9f9f9; font-weight:bold;">🏢 Razón Social</td>
              <td style="padding: 10px; background:#f9f9f9;">${data.razonSocial}</td>
            </tr>
            <tr>
              <td style="padding: 10px; font-weight:bold;">📦 Productos Solicitados</td>
              <td style="padding: 10px;">${data.productos}</td>
            </tr>
          </table>
          <hr/>
          <p style="color:#888; font-size:12px;">Este correo fue generado automáticamente por el bot de WhatsApp.</p>
        </div>
      `,
    });

    console.log(`📧 Email enviado correctamente para ${data.razonSocial}`);
    return true;
  } catch (err) {
    console.error("Error enviando email:", err.message);
    return false;
  }
}

// ─── Validación básica de RUT chileno ─────────────────────────────────────────
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

  const expected = 11 - (sum % 11);
  const dvExpected =
    expected === 11 ? "0" :
    expected === 10 ? "K" :
    String(expected);

  return dv === dvExpected;
}

// ─── Inicio del servidor ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📌 Webhook URL: http://TU-DOMINIO/webhook`);
});
