# 📲 Bot WhatsApp → Email · Guía de Instalación

## ¿Qué hace este bot?

Cuando un cliente te escribe por WhatsApp, el bot:
1. Le pide el **RUT** (con validación chilena)
2. Le pide la **Razón Social**
3. Le pide los **productos** que necesita
4. Envía un **correo a mancillagino@gmail.com** con toda la info
5. Confirma al cliente que su solicitud fue recibida

---

## Requisitos previos

- Node.js 18+
- Una cuenta en [Meta for Developers](https://developers.facebook.com)
- Un número de **WhatsApp Business** (puede ser de prueba gratuito)
- Una cuenta Gmail con **Contraseña de Aplicación** habilitada

---

## Paso 1 — Configurar Meta WhatsApp Cloud API

1. Ve a [developers.facebook.com](https://developers.facebook.com) → Crear App → Empresa
2. Agrega el producto **WhatsApp**
3. En **WhatsApp → API Setup** anota:
   - `Phone Number ID`
   - Genera un **Token de Acceso Permanente** (System User)
4. Guarda esos valores en el `.env`

---

## Paso 2 — Configurar Gmail

1. Ve a [myaccount.google.com](https://myaccount.google.com) → Seguridad
2. Activa la **Verificación en 2 pasos**
3. Ve a **Contraseñas de aplicaciones**
4. Crea una contraseña para "Correo / Otro dispositivo"
5. Copia esa contraseña de 16 caracteres al `.env` como `GMAIL_APP_PASSWORD`

---

## Paso 3 — Instalar y ejecutar

```bash
git clone <tu-repo>
cd whatsapp-bot
cp .env.example .env
# Edita .env con tus credenciales

npm install
npm start
```

---

## Paso 4 — Exponer el servidor a internet

Meta necesita una URL pública para enviar los mensajes. Opciones:

### Opción A — ngrok (pruebas locales, gratis)
```bash
npm install -g ngrok
ngrok http 3000
# Copia la URL https://xxxx.ngrok.io
```

### Opción B — Railway / Render (producción, gratuito)
- [railway.app](https://railway.app) → Deploy from GitHub → Listo
- [render.com](https://render.com) → New Web Service → Listo

---

## Paso 5 — Registrar el Webhook en Meta

1. Ve a tu App de Meta → WhatsApp → Configuration
2. En **Webhook**:
   - URL: `https://TU-DOMINIO/webhook`
   - Verify Token: el mismo que pusiste en `VERIFY_TOKEN` del `.env`
3. Suscríbete al evento: `messages`

---

## Estructura del proyecto

```
whatsapp-bot/
├── server.js        ← Servidor principal del bot
├── .env.example     ← Plantilla de variables de entorno
├── .env             ← Tus credenciales (NO subir a git)
├── package.json
└── README.md
```

---

## Email que recibirás

```
Asunto: 📦 Nueva solicitud de cliente - EMPRESA SPA

📲 Nueva Solicitud vía WhatsApp
Recibida el 23/04/2026 14:35:00

📞 Teléfono WhatsApp   | +56912345678
🪪 RUT                 | 12.345.678-9
🏢 Razón Social        | EMPRESA SPA
📦 Productos           | Tornillos M8, Tuercas M8, Pernos 10mm
```

---

## Soporte

Si tienes problemas con la configuración, los logs del servidor te mostrarán qué está fallando.
Ejecuta `npm run dev` para ver logs en tiempo real con nodemon.
