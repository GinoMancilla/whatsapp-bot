import PptxGenJS from "pptxgenjs";

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in

// ─── PALETA ─────────────────────────────────────────────────────────────────
const RED    = "ED0914";
const RED_DK = "8B0008";
const WHITE  = "FFFFFF";
const GRAY8  = "1E293B";
const GRAY6  = "475569";
const GRAY4  = "94A3B8";
const GRAY1  = "F8FAFC";
const GREEN  = "15803D";
const GBG    = "F0FDF4";
const GBDR   = "86EFAC";
const BLUE   = "1D4ED8";
const GRAY7  = "374151";

// ─── LOGO URL ────────────────────────────────────────────────────────────────
const LOGO = "https://assets.jumpseller.com/store/cintecsa/themes/954643/settings/e6f636bc6ca9fb2e0341/logo%20cintec%20color_.png?1771944795";

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function tag(slide, txt, y) {
  slide.addText(txt, {
    x: 0.7, y, w: 11.93, h: 0.22,
    fontSize: 8, bold: true, color: RED, charSpacing: 3,
    fontFace: "Calibri",
  });
}

function h2(slide, txt, y) {
  slide.addText(txt, {
    x: 0.7, y, w: 11.93, h: 0.55,
    fontSize: 26, bold: true, color: GRAY8, fontFace: "Calibri",
  });
}

function body(slide, txt, y, opts = {}) {
  slide.addText(txt, {
    x: 0.7, y, w: 11.93, h: 0.32,
    fontSize: 12, color: GRAY6, fontFace: "Calibri",
    ...opts,
  });
}

function pageNum(slide, n, total) {
  slide.addText(`${n} / ${total}`, {
    x: 12, y: 7.1, w: 1, h: 0.3,
    fontSize: 9, color: GRAY4, align: "right", fontFace: "Calibri",
  });
}

function card(slide, x, y, w, h, opts = {}) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x, y, w, h,
    fill: { color: opts.fill || WHITE },
    line: { color: opts.border || "E2E8F0", width: 1.2 },
    rectRadius: 0.12,
  });
}

function redBar(slide) {
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 13.33, h: 0.06,
    fill: { color: RED }, line: { color: RED },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 1 — PORTADA
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  s.background = { color: "1A0002" };

  // Gradiente simulado con rectángulos superpuestos
  s.addShape(pptx.ShapeType.rect, { x:0, y:0, w:13.33, h:7.5, fill:{ color:"3D0007" }, line:{color:"3D0007"} });
  s.addShape(pptx.ShapeType.rect, { x:6, y:0, w:7.33, h:7.5, fill:{ color:"ED0914", transparency:60 }, line:{color:"ED0914",transparency:60} });
  s.addShape(pptx.ShapeType.ellipse, { x:8, y:-1.5, w:6, h:6, fill:{ color:"ED0914", transparency:75 }, line:{color:"ED0914",transparency:75} });

  // Logo
  try {
    s.addImage({ path: LOGO, x: 0.7, y: 0.55, w: 2.2, h: 0.55 });
  } catch {
    s.addText("CINTEC", { x:0.7, y:0.5, w:3, h:0.5, fontSize:22, bold:true, color:WHITE, fontFace:"Calibri" });
  }

  s.addText("PROPUESTA COMERCIAL CONFIDENCIAL", {
    x:0.7, y:1.4, w:8, h:0.28,
    fontSize:8, bold:true, color:"94A3B8", charSpacing:3, fontFace:"Calibri",
  });

  s.addText("Bot de Cotizaciones\nAutomáticas vía WhatsApp", {
    x:0.7, y:1.9, w:9, h:1.8,
    fontSize:40, bold:true, color:WHITE, lineSpacingMultiple:1.1, fontFace:"Calibri",
  });

  s.addText("Sistema inteligente que recibe solicitudes de clientes, consulta el catálogo\nde productos y envía cotizaciones por email — disponible 24/7, sin intervención humana.", {
    x:0.7, y:3.85, w:8.5, h:0.9,
    fontSize:12, color:"A5B4FC", lineSpacingMultiple:1.5, fontFace:"Calibri",
  });

  const chips = ["⚡ Operativo hoy", "🤖 Claude AI integrado", "📊 Reportes en tiempo real", "🔒 Seguridad enterprise"];
  chips.forEach((chip, i) => {
    const cx = 0.7 + i * 3.1;
    s.addShape(pptx.ShapeType.roundRect, { x:cx, y:4.95, w:2.8, h:0.36, fill:{color:"FFFFFF",transparency:88}, line:{color:"FFFFFF",transparency:70}, rectRadius:0.06 });
    s.addText(chip, { x:cx, y:4.95, w:2.8, h:0.36, fontSize:10, color:"E2E8F0", align:"center", fontFace:"Calibri" });
  });

  s.addText("Junio 2026 · Propuesta de Automatización Comercial", {
    x:9.5, y:7.1, w:3.6, h:0.28, fontSize:9, color:"64748B", align:"right", fontFace:"Calibri",
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 2 — ¿QUÉ ES UN BOT?
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  s.background = { color: WHITE };
  redBar(s);

  tag(s, "¿QUÉ ES?", 0.28);
  h2(s, "Como contratar un vendedor que nunca duerme", 0.55);
  body(s, "Un bot es un sistema automatizado que conversa con tus clientes como lo haría un vendedor — pero disponible 24/7, sin descanso y sin errores.", 1.15, { h:0.42 });

  const cards3 = [
    { title:"🤖  El Bot", fill:"FFF0F0", border:"FCA5A5",
      desc:"Recibe el mensaje, pide el RUT, valida la empresa, busca los productos y envía la cotización automáticamente." },
    { title:"📋  El Catálogo", fill:"EFF6FF", border:"93C5FD",
      desc:"Consulta Google Sheets en tiempo real. Si cambias un precio, el bot lo refleja inmediatamente en la siguiente cotización." },
    { title:"📧  El Email", fill:"F0FDF4", border:"86EFAC",
      desc:"Genera y envía la cotización formal al correo del cliente en segundos, con todos los detalles y totales." },
  ];
  cards3.forEach((c, i) => {
    const cx = 0.7 + i * 4.0;
    card(s, cx, 1.75, 3.7, 2.1, { fill: c.fill, border: c.border });
    s.addText(c.title, { x:cx+0.18, y:1.92, w:3.34, h:0.36, fontSize:14, bold:true, color:GRAY8, fontFace:"Calibri" });
    s.addText(c.desc, { x:cx+0.18, y:2.38, w:3.34, h:1.2, fontSize:10.5, color:GRAY6, lineSpacingMultiple:1.4, fontFace:"Calibri" });
  });

  // VS box
  card(s, 0.7, 4.05, 11.93, 1.5, { fill: GRAY1, border:"E2E8F0" });
  s.addText("SIN EL BOT", { x:1.2, y:4.18, w:4, h:0.26, fontSize:9, bold:true, color:GRAY4, charSpacing:2, fontFace:"Calibri" });
  s.addText("👤 Vendedor disponible solo en horario de oficina\n⏳ Respuesta: horas o al día siguiente\n❌ Errores manuales posibles", {
    x:1.2, y:4.48, w:4.5, h:0.9, fontSize:11, color:GRAY6, lineSpacingMultiple:1.5, fontFace:"Calibri",
  });
  s.addText("VS", { x:5.9, y:4.5, w:1.4, h:0.7, fontSize:28, bold:true, color:RED, align:"center", valign:"middle", fontFace:"Calibri" });
  s.addText("CON EL BOT", { x:7.4, y:4.18, w:4, h:0.26, fontSize:9, bold:true, color:RED, charSpacing:2, fontFace:"Calibri" });
  s.addText("🤖 Bot disponible 24/7 todos los días\n⚡ Respuesta: menos de 30 segundos\n✅ Precios exactos desde el catálogo", {
    x:7.4, y:4.48, w:4.5, h:0.9, fontSize:11, color:GRAY6, lineSpacingMultiple:1.5, fontFace:"Calibri",
  });

  pageNum(s, 2, 10);
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 3 — FLUJO PASO A PASO
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  s.background = { color: GRAY1 };
  redBar(s);

  tag(s, "CÓMO FUNCIONA", 0.28);
  h2(s, "El flujo completo paso a paso", 0.55);
  body(s, "Desde que el cliente escribe hasta que recibe el email, todo ocurre en menos de un minuto.", 1.15);

  const steps = [
    { icon:"📱", title:"Cliente escribe", desc:"Abre WhatsApp y envía mensaje al número de CINTEC", color:"DCF CE7", bg:"F0FDF4", bdr:"86EFAC" },
    { icon:"🤖", title:"Bot saluda", desc:"Pide RUT y razón social para identificar al cliente", color:"DBEAFE", bg:"EFF6FF", bdr:"93C5FD" },
    { icon:"📦", title:"Recibe productos", desc:"El cliente escribe qué productos y cantidades necesita", color:"FEF9C3", bg:"FEFCE8", bdr:"FDE68A" },
    { icon:"🔍", title:"Busca en catálogo", desc:"Consulta Google Sheets y calcula precios en tiempo real", color:"F3E8FF", bg:"FAF5FF", bdr:"D8B4FE" },
    { icon:"✅", title:"Envía por WhatsApp", desc:"Muestra resumen con precios y totales al cliente", color:"DCFCE7", bg:"F0FDF4", bdr:"86EFAC" },
    { icon:"📧", title:"Email automático", desc:"Envía cotización formal al correo del cliente en segundos", color:"FEE2E2", bg:"FFF0F0", bdr:"FCA5A5" },
  ];

  steps.forEach((step, i) => {
    const cx = 0.5 + i * 2.06;
    card(s, cx, 1.65, 1.88, 2.4, { fill: step.bg, border: step.bdr });
    s.addText(step.icon, { x:cx, y:1.75, w:1.88, h:0.55, fontSize:28, align:"center", fontFace:"Segoe UI Emoji" });
    s.addText(step.title, { x:cx+0.1, y:2.38, w:1.68, h:0.38, fontSize:10, bold:true, color:GRAY8, align:"center", fontFace:"Calibri" });
    s.addText(step.desc, { x:cx+0.08, y:2.8, w:1.72, h:0.9, fontSize:9, color:GRAY6, align:"center", lineSpacingMultiple:1.35, fontFace:"Calibri" });
    if (i < steps.length - 1) {
      s.addText("→", { x:cx+1.82, y:2.15, w:0.3, h:0.38, fontSize:16, bold:true, color:GRAY4, align:"center", fontFace:"Calibri" });
    }
  });

  // Timeline
  card(s, 0.7, 4.25, 11.93, 1.05, { fill: WHITE });
  s.addText("⚡  TIEMPO TOTAL DEL PROCESO", { x:0.9, y:4.35, w:5, h:0.26, fontSize:9, bold:true, color:RED, charSpacing:2, fontFace:"Calibri" });
  const times = [["0 seg","Cliente escribe"],["< 2 seg","Bot responde"],["~5 seg","Catálogo consultado"],["~20 seg","Cotización lista"],["< 60 seg","Email enviado"]];
  times.forEach(([t, l], i) => {
    const tx = 1.0 + i * 2.3;
    s.addText(t, { x:tx, y:4.7, w:2, h:0.3, fontSize:13, bold:true, color:RED, fontFace:"Calibri" });
    s.addText(l, { x:tx, y:5.0, w:2, h:0.25, fontSize:9.5, color:GRAY6, fontFace:"Calibri" });
  });

  pageNum(s, 3, 10);
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 4 — DEMO (estático en PPTX)
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  s.background = { color: GRAY1 };
  redBar(s);

  tag(s, "DEMO EN VIVO", 0.28);
  h2(s, "Conversación real en WhatsApp", 0.55);

  // Phone mockup izquierda
  s.addShape(pptx.ShapeType.roundRect, { x:0.7, y:1.2, w:4.2, h:5.9, fill:{color:"111B21"}, line:{color:"111B21"}, rectRadius:0.18 });
  s.addShape(pptx.ShapeType.rect, { x:0.7, y:1.2, w:4.2, h:0.55, fill:{color:"1F2C34"}, line:{color:"1F2C34"} });
  s.addShape(pptx.ShapeType.ellipse, { x:0.78, y:1.26, w:0.38, h:0.38, fill:{color:RED}, line:{color:RED} });
  s.addText("CI", { x:0.78, y:1.26, w:0.38, h:0.38, fontSize:8, bold:true, color:WHITE, align:"center", valign:"middle", fontFace:"Calibri" });
  s.addText("CINTEC Ventas  🟢 en línea", { x:1.22, y:1.3, w:3, h:0.35, fontSize:9, color:WHITE, fontFace:"Calibri" });

  const msgs = [
    { side:"bot", txt:"👋 ¡Hola! Bienvenido/a a CINTEC.\nPara cotizarte necesito tu RUT." },
    { side:"user", txt:"12.345.678-9" },
    { side:"bot", txt:"✅ RUT validado. ¿Cuál es tu Razón Social?" },
    { side:"user", txt:"Distribuidora El Sur Ltda." },
    { side:"bot", txt:"✅ Registrado. ¿Qué productos necesitas cotizar?" },
    { side:"user", txt:"lavaloza 10 un, detergente 5 kg" },
    { side:"bot", txt:"🔍 Buscando en catálogo...\n\n✅ Lavaloza Liq. 5L × 10 — $48.500\n✅ Detergente Ind. 5kg × 5 — $61.500\n💵 TOTAL: $110.000" },
    { side:"bot", txt:"📧 ¿A qué correo enviamos la cotización?" },
    { side:"user", txt:"compras@empresa.cl" },
    { side:"bot", txt:"🎉 ¡Listo! Cotización enviada.\n¡Gracias por preferirnos! 🙏" },
  ];

  let yy = 1.85;
  msgs.forEach(m => {
    const isBot = m.side === "bot";
    const lines = m.txt.split("\n").length;
    const bh = Math.max(0.28, lines * 0.2 + 0.1);
    const bw = 2.8;
    const bx = isBot ? 0.85 : 0.7 + 4.2 - bw - 0.15;
    s.addShape(pptx.ShapeType.roundRect, {
      x:bx, y:yy, w:bw, h:bh,
      fill:{ color: isBot ? "1F2C34" : "005C4B" },
      line:{ color: isBot ? "1F2C34" : "005C4B" },
      rectRadius:0.06,
    });
    s.addText(m.txt, { x:bx+0.08, y:yy+0.04, w:bw-0.16, h:bh-0.08, fontSize:7.5, color:"E9EDEF", lineSpacingMultiple:1.3, fontFace:"Calibri" });
    yy += bh + 0.08;
    if (yy > 6.7) return;
  });

  // Descripción derecha
  const descSteps = [
    ["① RUT + Razón Social", "El bot identifica al cliente y valida su RUT con el módulo 11 oficial."],
    ["② Lista de productos", "El cliente escribe en lenguaje natural. El bot entiende cantidades y formatos."],
    ["③ Búsqueda en catálogo", "Consulta Google Sheets en tiempo real y calcula precios exactos con subtotales."],
    ["④ Confirmación y email", "Pide el correo del cliente y envía la cotización formal automáticamente."],
  ];
  let dy = 1.2;
  descSteps.forEach(([title, desc]) => {
    card(s, 5.2, dy, 7.9, 1.1, { fill: WHITE });
    s.addText(title, { x:5.4, y:dy+0.12, w:7.5, h:0.32, fontSize:12, bold:true, color:GRAY8, fontFace:"Calibri" });
    s.addText(desc,  { x:5.4, y:dy+0.48, w:7.5, h:0.52, fontSize:10.5, color:GRAY6, lineSpacingMultiple:1.35, fontFace:"Calibri" });
    dy += 1.25;
  });

  pageNum(s, 4, 10);
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 5 — CÓMO LLEGA EL EMAIL
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  s.background = { color: WHITE };
  redBar(s);

  tag(s, "EL CORREO AL CLIENTE", 0.28);
  h2(s, "¿Cómo llega la cotización al email?", 0.55);
  body(s, "El bot usa Resend, un servicio profesional de envío, que garantiza la entrega en segundos.", 1.1);

  const nodes = [
    { icon:"📱", label:"WhatsApp", sub:"Cliente confirma email", bg:"DCF CE7" },
    { icon:"🤖", label:"Bot CINTEC", sub:"Genera cotización", bg:"FEE2E2" },
    { icon:"📋", label:"Google Sheets", sub:"Precios actualizados", bg:"DBEAFE" },
    { icon:"📄", label:"Cotización", sub:"Generada en el bot", bg:"F3E8FF" },
    { icon:"📧", label:"Resend", sub:"Envío profesional", bg:"FEF9C3" },
    { icon:"📥", label:"Email cliente", sub:"Llega en segundos", bg:"DCFCE7" },
  ];

  nodes.forEach((n, i) => {
    const nx = 0.5 + i * 2.06;
    s.addShape(pptx.ShapeType.roundRect, { x:nx+0.15, y:1.7, w:1.6, h:1.6, fill:{color:n.bg.replace(" ","")}, line:{color:"E2E8F0"}, rectRadius:0.12 });
    s.addText(n.icon, { x:nx+0.15, y:1.78, w:1.6, h:0.55, fontSize:26, align:"center", fontFace:"Segoe UI Emoji" });
    s.addText(n.label, { x:nx, y:2.4, w:1.9, h:0.28, fontSize:10, bold:true, color:GRAY8, align:"center", fontFace:"Calibri" });
    s.addText(n.sub,   { x:nx, y:2.72, w:1.9, h:0.42, fontSize:8.5, color:GRAY6, align:"center", lineSpacingMultiple:1.3, fontFace:"Calibri" });
    if (i < nodes.length - 1) {
      s.addText("→", { x:nx+1.72, y:2.2, w:0.38, h:0.38, fontSize:18, bold:true, color:RED, align:"center", fontFace:"Calibri" });
    }
  });

  // Email mockup
  card(s, 1.5, 3.45, 10.33, 3.6, { fill: WHITE, border: "E2E8F0" });
  s.addShape(pptx.ShapeType.rect, { x:1.5, y:3.45, w:10.33, h:0.42, fill:{color:GRAY1}, line:{color:"E2E8F0"} });
  s.addText("De: cotizaciones@cintec.cl   |   Para: compras@empresa.cl   |   Asunto: Cotización N°2847 — Distribuidora El Sur", {
    x:1.68, y:3.5, w:9.9, h:0.3, fontSize:9, color:GRAY6, fontFace:"Calibri",
  });
  s.addText("📦  Cotización de Productos CINTEC", { x:1.7, y:4.05, w:9.5, h:0.38, fontSize:16, bold:true, color:GRAY8, fontFace:"Calibri" });
  const rows = [
    ["Lavaloza Líquido 5L × 10 un","$48.500"],
    ["Detergente Industrial 5kg × 5 un","$61.500"],
    ["Subtotal","$110.000"],
    ["IVA (19%)","$20.900"],
  ];
  rows.forEach(([label, val], i) => {
    const ry = 4.55 + i * 0.35;
    s.addText(label, { x:1.7, y:ry, w:8, h:0.3, fontSize:11, color:GRAY6, fontFace:"Calibri" });
    s.addText(val, { x:9.5, y:ry, w:2, h:0.3, fontSize:11, bold:true, color:GRAY8, align:"right", fontFace:"Calibri" });
  });
  s.addShape(pptx.ShapeType.roundRect, { x:1.7, y:6.0, w:9.8, h:0.42, fill:{color:RED}, line:{color:RED}, rectRadius:0.06 });
  s.addText("TOTAL", { x:1.9, y:6.04, w:7, h:0.34, fontSize:13, bold:true, color:WHITE, fontFace:"Calibri" });
  s.addText("$130.900", { x:9.5, y:6.04, w:2, h:0.34, fontSize:13, bold:true, color:WHITE, align:"right", fontFace:"Calibri" });

  pageNum(s, 5, 10);
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 6 — BENEFICIOS
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  s.background = { color: GRAY1 };
  redBar(s);

  tag(s, "BENEFICIOS", 0.28);
  h2(s, "¿Por qué automatizar las cotizaciones?", 0.55);

  const benes = [
    { icon:"⏰", num:"24/7",    title:"Disponible siempre",      desc:"Fines de semana, festivos y madrugadas. Respuesta inmediata en cualquier horario." },
    { icon:"⚡", num:"< 30s",   title:"Respuesta inmediata",     desc:"Desde que el cliente escribe hasta que recibe la cotización pasan menos de un minuto." },
    { icon:"🎯", num:"100%",    title:"Precios exactos",         desc:"Consulta el catálogo oficial en cada cotización. Cero errores ni precios desactualizados." },
    { icon:"📊", num:"KPI",     title:"Datos en tiempo real",    desc:"Panel con productos más cotizados, clientes activos y montos generados por canal." },
    { icon:"👔", num:"+Ventas", title:"Vendedores enfocados",    desc:"Liberados de rutinas, el equipo dedica su energía a negociaciones de alto valor." },
    { icon:"📈", num:"ROI",     title:"Se paga solo",            desc:"A 8 UF/mes, la inversión se recupera en ~5 meses solo por ahorro operacional." },
  ];

  benes.forEach((b, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const cx = 0.7 + col * 4.0, cy = 1.4 + row * 2.55;
    card(s, cx, cy, 3.7, 2.3, { fill: WHITE });
    s.addText(b.icon, { x:cx+0.2, y:cy+0.18, w:0.55, h:0.55, fontSize:24, fontFace:"Segoe UI Emoji" });
    s.addText(b.num, { x:cx+0.85, y:cy+0.15, w:2.6, h:0.5, fontSize:28, bold:true, color:RED, fontFace:"Calibri" });
    s.addText(b.title, { x:cx+0.2, y:cy+0.72, w:3.2, h:0.32, fontSize:12, bold:true, color:GRAY8, fontFace:"Calibri" });
    s.addText(b.desc,  { x:cx+0.2, y:cy+1.08, w:3.2, h:1.0, fontSize:10, color:GRAY6, lineSpacingMultiple:1.35, fontFace:"Calibri" });
  });

  pageNum(s, 6, 10);
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 7 — ¿PARA QUÉ EMPRESAS?
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  s.background = { color: WHITE };
  redBar(s);

  tag(s, "¿PARA QUIÉN?", 0.28);
  h2(s, "Funciona en cualquier empresa con catálogo", 0.55);
  body(s, "Cualquier empresa que venda productos con precios definidos puede implementar este bot en menos de una semana.", 1.1);

  const inds = [
    { icon:"🧴", name:"Higiene y Limpieza",       ex:"Como CINTEC — distribuidoras de productos industriales que atienden empresas por volumen.", fill:"FFF0F0", bdr:"FCA5A5" },
    { icon:"🔧", name:"Ferretería y Construcción", ex:"Cotización de materiales, herramientas y repuestos con precios de lista actualizados.",      fill:"EFF6FF", bdr:"93C5FD" },
    { icon:"🥗", name:"Alimentos y Bebidas",       ex:"Distribuidoras con clientes regulares: restaurantes, supermercados, hoteles.",                fill:"F0FDF4", bdr:"86EFAC" },
    { icon:"💊", name:"Farmacéutica y Lab.",        ex:"Insumos médicos, reactivos y equipos con validación de cliente por RUT.",                    fill:"FEF9C3", bdr:"FDE68A" },
    { icon:"⚙️", name:"Equipos Industriales",      ex:"Maquinaria y repuestos con flujos especializados (como las hidrolavadoras en CINTEC).",       fill:"FAF5FF", bdr:"D8B4FE" },
    { icon:"👕", name:"Textil y Uniformes",         ex:"Vestuario corporativo con tallas, colores y cantidades mínimas por pedido.",                 fill:"FFF7ED", bdr:"FDBA74" },
  ];

  inds.forEach((ind, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const cx = 0.7 + col * 4.0, cy = 1.7 + row * 2.4;
    card(s, cx, cy, 3.7, 2.15, { fill: ind.fill, border: ind.bdr });
    s.addText(ind.icon, { x:cx+0.18, y:cy+0.2, w:0.55, h:0.55, fontSize:26, fontFace:"Segoe UI Emoji" });
    s.addText(ind.name, { x:cx+0.18, y:cy+0.66, w:3.2, h:0.35, fontSize:12, bold:true, color:GRAY8, fontFace:"Calibri" });
    s.addText(ind.ex,   { x:cx+0.18, y:cy+1.05, w:3.2, h:0.88, fontSize:10, color:GRAY6, lineSpacingMultiple:1.35, fontFace:"Calibri" });
  });

  pageNum(s, 7, 10);
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 8 — SEGURIDAD
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  s.background = { color: GRAY1 };
  redBar(s);

  tag(s, "SEGURIDAD", 0.28);
  h2(s, "Tus datos están protegidos", 0.55);
  body(s, "Explicado sin tecnicismos: estas son las 5 capas de protección del sistema.", 1.1);

  const secs = [
    { icon:"🔏", tech:"Firma HMAC-SHA256",    simple:"Solo Meta puede hablar con el bot",     desc:'Cada mensaje llega con un "sello secreto". Si el mensaje no tiene ese sello exacto, el bot lo rechaza automáticamente.', analogy:"Como un sobre con lacre sellado — si alguien lo abrió antes de llegar, se nota y se rechaza.", fill:"DCFCE7" },
    { icon:"🚧", tech:"Rate Limiting",         simple:"Nadie puede saturar el sistema",        desc:"Si alguien envía cientos de mensajes para colapsar el bot, el sistema lo detecta y lo bloquea automáticamente.", analogy:"Como un portero de discoteca — si alguien intenta entrar muchas veces seguidas, lo detiene.", fill:"DBEAFE" },
    { icon:"🔐", tech:"Variables de Entorno",  simple:"Las contraseñas nunca están en el código", desc:"Todas las claves de acceso están guardadas en un sistema separado, no escritas en el programa.", analogy:"Como guardar las llaves en una caja fuerte, no debajo de la alfombra.", fill:"FEF9C3" },
    { icon:"🛡️", tech:"Protección XSS + CSP", simple:"Ningún mensaje puede dañar el sistema", desc:"El bot filtra todo lo que recibe. Si alguien envía código malicioso disfrazado de texto, el sistema lo neutraliza.", analogy:"Como el escáner del aeropuerto — revisa cada equipaje antes de dejarlo pasar.", fill:"F3E8FF" },
  ];

  secs.forEach((sec, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const cx = 0.7 + col * 6.2, cy = 1.55 + row * 2.5;
    card(s, cx, cy, 5.9, 2.25, { fill: WHITE });
    s.addShape(pptx.ShapeType.roundRect, { x:cx+0.18, y:cy+0.18, w:0.6, h:0.6, fill:{color:sec.fill.replace(" ","")}, line:{color:"E2E8F0"}, rectRadius:0.08 });
    s.addText(sec.icon, { x:cx+0.18, y:cy+0.18, w:0.6, h:0.6, fontSize:18, align:"center", valign:"middle", fontFace:"Segoe UI Emoji" });
    s.addText(sec.tech, { x:cx+0.9, y:cy+0.18, w:4.8, h:0.22, fontSize:8, bold:true, color:RED, charSpacing:1.5, fontFace:"Calibri" });
    s.addText(sec.simple, { x:cx+0.9, y:cy+0.44, w:4.8, h:0.32, fontSize:12, bold:true, color:GRAY8, fontFace:"Calibri" });
    s.addText(sec.desc, { x:cx+0.18, y:cy+0.85, w:5.5, h:0.55, fontSize:10, color:GRAY6, lineSpacingMultiple:1.3, fontFace:"Calibri" });
    s.addShape(pptx.ShapeType.roundRect, { x:cx+0.18, y:cy+1.45, w:5.5, h:0.62, fill:{color:GRAY1}, line:{color:"E2E8F0"}, rectRadius:0.06 });
    s.addText("💡  " + sec.analogy, { x:cx+0.28, y:cy+1.5, w:5.3, h:0.52, fontSize:9.5, color:GRAY6, lineSpacingMultiple:1.3, italic:true, fontFace:"Calibri" });
  });

  // Token permanente banner
  s.addShape(pptx.ShapeType.roundRect, { x:0.7, y:6.55, w:11.93, h:0.65, fill:{color:RED}, line:{color:RED_DK}, rectRadius:0.08 });
  s.addText("🔒  Token permanente de Meta: La conexión con WhatsApp Business nunca caduca. No hay riesgo de que el bot se desconecte solo.", {
    x:0.9, y:6.6, w:11.5, h:0.55, fontSize:11, bold:true, color:WHITE, fontFace:"Calibri",
  });

  pageNum(s, 8, 10);
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 9 — COSTOS (solo plan estándar)
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  s.background = { color: WHITE };
  redBar(s);

  tag(s, "INVERSIÓN", 0.28);
  h2(s, "Plan Estándar — Propuesta de servicio", 0.55);
  body(s, "Precios en UF = protección contra la inflación. El costo real en pesos no varía con el tiempo.", 1.1);

  // Card central plan estándar
  card(s, 1.8, 1.55, 9.73, 5.1, { fill: GBG, border: GBDR });

  // Badge
  s.addShape(pptx.ShapeType.roundRect, { x:2.2, y:1.75, w:1.5, h:0.3, fill:{color:"DCFCE7"}, line:{color:GBDR}, rectRadius:0.06 });
  s.addText("PLAN ESTÁNDAR", { x:2.2, y:1.75, w:1.5, h:0.3, fontSize:8, bold:true, color:GREEN, align:"center", charSpacing:1.5, fontFace:"Calibri" });

  s.addText("Servicio Mensual", { x:2.2, y:2.14, w:9, h:0.45, fontSize:22, bold:true, color:GRAY8, fontFace:"Calibri" });

  // Precios en dos columnas
  s.addText("Implementación (pago único)", { x:2.2, y:2.72, w:4, h:0.26, fontSize:9, bold:true, color:GRAY4, charSpacing:1, fontFace:"Calibri" });
  s.addText("25 UF + IVA", { x:2.2, y:3.02, w:3.5, h:0.45, fontSize:22, bold:true, color:GRAY8, fontFace:"Calibri" });
  s.addText("≈ $970.000 al valor de hoy", { x:2.2, y:3.5, w:3.5, h:0.26, fontSize:10, color:GREEN, fontFace:"Calibri" });

  s.addText("+", { x:5.6, y:2.95, w:0.7, h:0.5, fontSize:28, bold:true, color:GRAY4, align:"center", fontFace:"Calibri" });

  s.addText("Mantención mensual", { x:6.35, y:2.72, w:4.5, h:0.26, fontSize:9, bold:true, color:GRAY4, charSpacing:1, fontFace:"Calibri" });
  s.addText("8 UF / mes + IVA", { x:6.35, y:3.02, w:4.5, h:0.45, fontSize:22, bold:true, color:GREEN, fontFace:"Calibri" });
  s.addText("≈ $310.400/mes · sin contrato mínimo", { x:6.35, y:3.5, w:4.5, h:0.26, fontSize:10, color:GREEN, fontFace:"Calibri" });

  // Línea divisoria
  s.addShape(pptx.ShapeType.line, { x:2.2, y:3.88, w:9, h:0, line:{color:"E2E8F0", width:1} });

  // Lista incluye
  s.addText("INCLUYE CADA MES", { x:2.2, y:4.0, w:5, h:0.24, fontSize:8, bold:true, color:GRAY4, charSpacing:2, fontFace:"Calibri" });
  const includes = [
    "Servidor Railway activo 24/7",
    "WhatsApp Business API (Meta)",
    "Claude AI · consultas libres",
    "Resend · emails transaccionales",
    "Soporte técnico y correcciones",
    "Actualizaciones de seguridad",
    "Panel de reportes siempre activo",
    "Monitoreo y alertas de caídas",
  ];
  includes.forEach((inc, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const ix = 2.2 + col * 4.7, iy = 4.3 + row * 0.37;
    s.addText("✓  " + inc, { x:ix, y:iy, w:4.3, h:0.32, fontSize:11, color:GRAY6, fontFace:"Calibri" });
  });

  body(s, "1 UF ≈ $38.800 CLP (jun 2026)  ·  El bot cuesta menos que el sueldo de medio día de un vendedor y trabaja 720 horas al mes", 6.78, { fontSize:10, color:GRAY4, italic:true, h:0.26 });

  pageNum(s, 9, 10);
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 10 — CTA
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  s.background = { color: "1A0002" };
  s.addShape(pptx.ShapeType.rect, { x:0, y:0, w:13.33, h:7.5, fill:{color:"3D0007"}, line:{color:"3D0007"} });
  s.addShape(pptx.ShapeType.rect, { x:5, y:0, w:8.33, h:7.5, fill:{color:"ED0914",transparency:70}, line:{color:"ED0914",transparency:70} });
  s.addShape(pptx.ShapeType.ellipse, { x:7, y:-1, w:7, h:7, fill:{color:"ED0914",transparency:80}, line:{color:"ED0914",transparency:80} });

  try {
    s.addImage({ path: LOGO, x:0.7, y:0.5, w:2.2, h:0.55 });
  } catch {
    s.addText("CINTEC", { x:0.7, y:0.5, w:3, h:0.5, fontSize:22, bold:true, color:WHITE, fontFace:"Calibri" });
  }

  s.addText("SIGUIENTE PASO", { x:0.7, y:1.3, w:8, h:0.28, fontSize:9, bold:true, color:"94A3B8", charSpacing:3, fontFace:"Calibri" });
  s.addText("¿Lo activamos\nesta semana?", { x:0.7, y:1.7, w:9, h:1.5, fontSize:42, bold:true, color:WHITE, lineSpacingMultiple:1.1, fontFace:"Calibri" });
  s.addText("El bot ya está funcionando. Solo necesita conectarse al número real de CINTEC.", {
    x:0.7, y:3.35, w:8, h:0.45, fontSize:13, color:"A5B4FC", fontFace:"Calibri",
  });

  const ctaSteps = [["01","Aprobar propuesta\ny emitir OC"],["02","Vincular número\noficial de CINTEC"],["03","Ajustar catálogo\ny flujos finales"],["04","Bot en producción\nen < 48 horas"]];
  ctaSteps.forEach(([n, l], i) => {
    const cx = 0.7 + i * 3.05;
    s.addShape(pptx.ShapeType.roundRect, { x:cx, y:3.95, w:2.8, h:1.4, fill:{color:"FFFFFF",transparency:88}, line:{color:"FFFFFF",transparency:70}, rectRadius:0.1 });
    s.addText(n, { x:cx, y:4.1, w:2.8, h:0.52, fontSize:28, bold:true, color:WHITE, align:"center", fontFace:"Calibri" });
    s.addText(l, { x:cx+0.1, y:4.65, w:2.6, h:0.62, fontSize:10, color:"94A3B8", align:"center", lineSpacingMultiple:1.3, fontFace:"Calibri" });
  });

  // Contact box
  card(s, 2.4, 5.55, 8.53, 1.65, { fill: WHITE, border:"E2E8F0" });
  s.addText("¿Listo para empezar?", { x:2.6, y:5.68, w:8, h:0.38, fontSize:16, bold:true, color:GRAY8, fontFace:"Calibri" });
  s.addText("📧  mancillagino@gmail.com", { x:2.6, y:6.12, w:7, h:0.32, fontSize:12, color:GRAY7, fontFace:"Calibri" });
  s.addText("💬  Respuesta en menos de 24 horas hábiles  ·  🚀  Operativo en menos de una semana", {
    x:2.6, y:6.48, w:8, h:0.28, fontSize:10.5, color:GRAY6, fontFace:"Calibri",
  });
}

// ─── GUARDAR ─────────────────────────────────────────────────────────────────
await pptx.writeFile({ fileName: "Bot-WhatsApp-CINTEC.pptx" });
console.log("✅ Bot-WhatsApp-CINTEC.pptx generado correctamente");
