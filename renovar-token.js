require("dotenv").config();
const axios = require("axios");
const { Resend } = require("resend");

async function renovarToken() {
  try {
    console.log("🔄 Iniciando renovación del token...");

    const resp = await axios.get("https://graph.facebook.com/oauth/access_token", {
      params: {
        grant_type: "fb_exchange_token",
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        fb_exchange_token: process.env.WHATSAPP_TOKEN,
      }
    });

    const nuevoToken = resp.data.access_token;

    // Actualizar en Railway
    await axios.post(
      "https://backboard.railway.app/graphql/v2",
      {
        query: `mutation {
          variableUpsert(input: {
            serviceId: "${process.env.RAILWAY_SERVICE_ID}"
            environmentId: "${process.env.RAILWAY_ENVIRONMENT_ID}"
            name: "WHATSAPP_TOKEN"
            value: "${nuevoToken}"
          })
        }`
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.RAILWAY_API_TOKEN}`,
          "Content-Type": "application/json",
        }
      }
    );

    // Notificar por correo
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: "Bot CINTEC <onboarding@resend.dev>",
      to: process.env.DESTINATION_EMAIL,
      subject: "✅ Token WhatsApp renovado automáticamente",
      html: `
        <div style="font-family:Arial,sans-serif; padding:24px; border:1px solid #27AE60; border-radius:8px;">
          <h2 style="color:#27AE60;">✅ Token renovado exitosamente</h2>
          <p>Fecha: <strong>${new Date().toLocaleString("es-CL", {timeZone:"America/Santiago"})}</strong></p>
          <p>Próxima renovación en <strong>50 días</strong>.</p>
        </div>`
    });

    console.log("✅ Token renovado y correo enviado.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
    
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: "Bot CINTEC <onboarding@resend.dev>",
      to: process.env.DESTINATION_EMAIL,
      subject: "❌ Error al renovar token WhatsApp",
      html: `<p>Error: ${err.message}</p><p>Por favor renueva el token manualmente.</p>`
    });
    process.exit(1);
  }
}

renovarToken();