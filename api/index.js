const express = require('express');
const cors = require('cors');
const { Redis } = require('@upstash/redis');

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PIN = () => process.env.PIN_ADMIN || '1234';

// Claves Redis — misma instancia Upstash que el POS
const K = {
  insumos:      'inv:insumos',
  recetas:      'inv:recetas',
  ordenes:      'inv:ordenes',
  movimientos:  'inv:movimientos',
  cortes:       'inv:cortes',
  config:       'inv:config',
  ts:           'inv:lastUpdate',
  posVentas:    'i:vta',   // llave del POS (solo lectura)
};

// ── Cargar todos los datos de inventario ──
app.get('/api/datos', async (req, res) => {
  try {
    const [insumos, recetas, ordenes, movimientos, cortes, config] = await Promise.all([
      kv.get(K.insumos),
      kv.get(K.recetas),
      kv.get(K.ordenes),
      kv.get(K.movimientos),
      kv.get(K.cortes),
      kv.get(K.config),
    ]);
    res.json({
      insumos:     insumos     || [],
      recetas:     recetas     || [],
      ordenes:     ordenes     || [],
      movimientos: movimientos || [],
      cortes:      cortes      || [],
      config:      config      || { ultimoFolio: 0 },
    });
  } catch (e) {
    console.error('/api/datos', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Guardar todos los datos de inventario ──
app.post('/api/guardar', async (req, res) => {
  try {
    const { insumos, recetas, ordenes, movimientos, cortes, config } = req.body;
    await Promise.all([
      kv.set(K.insumos,      insumos      || []),
      kv.set(K.recetas,      recetas      || []),
      kv.set(K.ordenes,      ordenes      || []),
      kv.set(K.movimientos,  movimientos  || []),
      kv.set(K.cortes,       cortes       || []),
      kv.set(K.config,       config       || { ultimoFolio: 0 }),
      kv.set(K.ts,           Date.now()),
    ]);
    res.json({ ok: true });
  } catch (e) {
    console.error('/api/guardar', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Timestamp para sync ──
app.get('/api/lastUpdate', async (req, res) => {
  try {
    const ts = await kv.get(K.ts);
    res.json({ ts: ts || 0 });
  } catch (e) {
    res.json({ ts: 0 });
  }
});

// ── Stock en tiempo real: stock actual − consumo desde último corte ──
app.get('/api/stock-live', async (req, res) => {
  try {
    const [insumosRaw, recetasRaw, cortesRaw, posVentas, configRaw] = await Promise.all([
      kv.get(K.insumos),
      kv.get(K.recetas),
      kv.get(K.cortes),
      kv.get(K.posVentas),
      kv.get(K.config),
    ]);

    const insumos  = insumosRaw  || [];
    const recetas  = recetasRaw  || [];
    const cortes   = cortesRaw   || [];
    const ventas   = posVentas   || [];
    const config   = configRaw   || {};

    // Solo procesar ventas desde esta fecha en adelante (evita pre-inventario)
    const fechaInicio = config.fechaInicioVentas || '2000-01-01';

    // Fecha del último corte procesado
    const ultimoCorte = cortes.length
      ? cortes.sort((a,b)=>a.fecha.localeCompare(b.fecha)).at(-1).fecha
      : null;

    // Normalizar fecha a YYYY-MM-DD independientemente del formato del POS
    const normalizarFecha = (v) => {
      if(v.fecha) {
        // POS puede guardar como DD/M/YYYY o YYYY-MM-DD
        const f = v.fecha;
        if(f.includes('/')) {
          const [d,m,y] = f.split('/');
          return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        }
        return f.slice(0,10);
      }
      return new Date(v.id).toISOString().slice(0,10);
    };

    // Ventas del POS que NO han sido procesadas en un corte y son >= fechaInicio
    const fechasProcesadas = new Set(cortes.map(c=>c.fecha));
    const ventasPendientes = ventas.filter(v => {
      if(v.excluida) return false;
      const fv = normalizarFecha(v);
      return fv >= fechaInicio && !fechasProcesadas.has(fv);
    });

    // Mapa recetas: platillo → ingredientes
    const recetaMap = {};
    recetas.forEach(r => { recetaMap[r.platillo] = r.ingredientes || []; });

    // Calcular consumo acumulado de ventas pendientes
    const consumo = {}; // { insumoId: cantidad }
    const sinReceta = new Set();
    ventasPendientes.forEach(v => {
      (v.items || []).filter(it => !it.cancelado).forEach(item => {
        const receta = recetaMap[item.n];
        if(!receta || !receta.length) { sinReceta.add(item.n); return; }
        const qty = item.q || 1;
        receta.forEach(ing => {
          consumo[ing.insumoId] = (consumo[ing.insumoId]||0) + ing.cantidad * qty;
        });
      });
    });

    // Calcular stock proyectado por insumo
    const proyectado = {};
    insumos.forEach(ins => {
      proyectado[ins.id] = {
        stockReal:      ins.stock,
        consumoPendiente: consumo[ins.id] || 0,
        stockProyectado:  Math.max(0, ins.stock - (consumo[ins.id]||0)),
      };
    });

    // Agrupar ventas pendientes por fecha (normalizada)
    const fechasPendientes = [...new Set(
      ventasPendientes.map(v => normalizarFecha(v))
    )].sort();

    res.json({
      ventasPendientes:  ventasPendientes.length,
      fechasPendientes,
      ultimoCorte,
      proyectado,
      sinReceta: [...sinReceta],
    });
  } catch(e) {
    console.error('/api/stock-live', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Leer ventas del POS (solo lectura) ──
app.get('/api/ventas-pos', async (req, res) => {
  try {
    const ventas = await kv.get(K.posVentas);
    res.json({ ventas: ventas || [] });
  } catch (e) {
    console.error('/api/ventas-pos', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Corte del día: descontar inventario basado en ventas del POS ──
app.post('/api/corte', async (req, res) => {
  try {
    const { fecha, pin } = req.body;
    if (pin !== PIN()) return res.status(401).json({ error: 'PIN incorrecto' });

    // Traer ventas del POS y datos de inventario en paralelo
    const [posVentas, insumos, recetasRaw, movimientosRaw, cortesRaw, configRaw] = await Promise.all([
      kv.get(K.posVentas),
      kv.get(K.insumos),
      kv.get(K.recetas),
      kv.get(K.movimientos),
      kv.get(K.cortes),
      kv.get(K.config),
    ]);

    const ventas      = posVentas      || [];
    const recetas     = recetasRaw     || [];
    const movimientos = movimientosRaw || [];
    const cortes      = cortesRaw      || [];
    const config      = configRaw      || { ultimoFolio: 0 };

    // Verificar que no se haya procesado ya este día
    if (cortes.some(c => c.fecha === fecha)) {
      return res.status(400).json({ error: `El corte del ${fecha} ya fue procesado.` });
    }

    // Verificar que la fecha no sea anterior al inicio del inventario
    const fechaInicio = config.fechaInicioVentas || '2000-01-01';
    if (fecha < fechaInicio) {
      return res.status(400).json({ error: `No se pueden procesar cortes anteriores al inicio del inventario (${fechaInicio}).` });
    }

    // Filtrar ventas del día solicitado (normalizando formato DD/M/YYYY o YYYY-MM-DD)
    const normFecha = (v) => {
      if(v.fecha) {
        const f = v.fecha;
        if(f.includes('/')) {
          const [d,m,y] = f.split('/');
          return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        }
        return f.slice(0,10);
      }
      return new Date(v.id).toISOString().slice(0,10);
    };
    const ventasHoy = ventas.filter(v => normFecha(v) === fecha && normFecha(v) >= fechaInicio);

    // Mapa de recetas: platillo → ingredientes
    const recetaMap = {};
    recetas.forEach(r => { recetaMap[r.platillo] = r.ingredientes || []; });

    // Calcular descuentos agrupados por insumoId
    const descuentos = {}; // { insumoId: cantidad_total }
    let itemsContados = 0;
    const sinReceta = new Set();

    ventasHoy.forEach(venta => {
      (venta.items || [])
        .filter(it => !it.cancelado)
        .forEach(item => {
          const receta = recetaMap[item.n];
          if (!receta || receta.length === 0) {
            sinReceta.add(item.n);
            return;
          }
          const qty = item.q || 1;
          itemsContados += qty;
          receta.forEach(ing => {
            descuentos[ing.insumoId] = (descuentos[ing.insumoId] || 0) + (ing.cantidad * qty);
          });
        });
    });

    // Aplicar descuentos al stock
    const hora = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    const corteRef = `CORTE-${fecha}`;
    const insumosActualizados = (insumos || []).map(ins => {
      if (!descuentos[ins.id]) return ins;
      const stockAntes = ins.stock;
      const stockDespues = Math.max(0, ins.stock - descuentos[ins.id]);
      movimientos.push({
        id: `${Date.now()}_${ins.id}`,
        fecha,
        hora,
        tipo: 'VENTA',
        insumoId: ins.id,
        nombre: ins.nombre,
        cantidad: -(descuentos[ins.id]),
        unidad: ins.unidad,
        responsable: 'Sistema',
        concepto: `Corte ${fecha} — ${ventasHoy.length} ventas`,
        referencia: corteRef,
        stockAntes,
        stockDespues,
      });
      return { ...ins, stock: stockDespues };
    });

    // Registrar corte
    cortes.push({
      fecha,
      procesadoEn: new Date().toISOString(),
      ventasProcesadas: ventasHoy.length,
      itemsContados,
      insumosAfectados: Object.keys(descuentos).length,
      sinReceta: [...sinReceta],
    });

    await Promise.all([
      kv.set(K.insumos,     insumosActualizados),
      kv.set(K.movimientos, movimientos),
      kv.set(K.cortes,      cortes),
      kv.set(K.ts,          Date.now()),
    ]);

    res.json({
      ok: true,
      ventasProcesadas: ventasHoy.length,
      itemsContados,
      insumosAfectados: Object.keys(descuentos).length,
      sinReceta: [...sinReceta],
    });
  } catch (e) {
    console.error('/api/corte', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Preview de corte (sin ejecutar) ──
app.post('/api/corte-preview', async (req, res) => {
  try {
    const { fecha } = req.body;
    const [posVentas, recetasRaw, cortesRaw, insumos] = await Promise.all([
      kv.get(K.posVentas),
      kv.get(K.recetas),
      kv.get(K.cortes),
      kv.get(K.insumos),
    ]);

    const ventas  = posVentas  || [];
    const recetas = recetasRaw || [];
    const cortes  = cortesRaw  || [];

    const yaProcessado = cortes.some(c => c.fecha === fecha);
    const ventasHoy = ventas.filter(v => {
      const f = v.fecha || '';
      return f === fecha || f.startsWith(fecha);
    });

    const recetaMap = {};
    recetas.forEach(r => { recetaMap[r.platillo] = r.ingredientes || []; });

    const descuentos = {};
    const sinReceta = new Set();
    let itemsContados = 0;

    ventasHoy.forEach(venta => {
      (venta.items || []).filter(it => !it.cancelado).forEach(item => {
        const receta = recetaMap[item.n];
        if (!receta || receta.length === 0) { sinReceta.add(item.n); return; }
        const qty = item.q || 1;
        itemsContados += qty;
        receta.forEach(ing => {
          descuentos[ing.insumoId] = (descuentos[ing.insumoId] || 0) + (ing.cantidad * qty);
        });
      });
    });

    // Enriquecer con nombres
    const insMap = {};
    (insumos || []).forEach(i => { insMap[i.id] = i; });
    const detalles = Object.entries(descuentos).map(([id, cant]) => ({
      insumoId: id,
      nombre: insMap[id]?.nombre || id,
      unidad: insMap[id]?.unidad || '',
      stockActual: insMap[id]?.stock || 0,
      descuento: cant,
      stockResultante: Math.max(0, (insMap[id]?.stock || 0) - cant),
    }));

    res.json({
      fecha,
      yaProcessado,
      ventasHoy: ventasHoy.length,
      itemsContados,
      detalles,
      sinReceta: [...sinReceta],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Importar insumos desde Excel/CSV/JSON ──
app.post('/api/importar', async (req, res) => {
  try {
    const { pin, insumos: nuevos } = req.body;
    if (pin !== PIN()) return res.status(401).json({ error: 'PIN incorrecto' });

    const existentes = await kv.get(K.insumos) || [];
    const map = {};
    existentes.forEach(i => { map[i.id] = i; });

    const hoy = new Date().toISOString().slice(0, 10);
    let creados = 0, actualizados = 0;

    nuevos.forEach((n, idx) => {
      // Buscar por nombre (case-insensitive)
      const match = existentes.find(e => e.nombre.toLowerCase().trim() === n.nombre.toLowerCase().trim());
      if (match) {
        if (n.stock    !== undefined) match.stock    = parseFloat(n.stock)    || 0;
        if (n.stockMin !== undefined) match.stockMin = parseFloat(n.stockMin) || 0;
        if (n.costo    !== undefined) { match.costo  = parseFloat(n.costo)    || 0; match.ultimaRevisionPrecio = hoy; }
        map[match.id] = match;
        actualizados++;
      } else {
        const id = `ins_${Date.now()}_${idx}`;
        map[id] = {
          id,
          nombre: n.nombre.trim(),
          unidad: n.unidad || 'pza',
          stock: parseFloat(n.stock) || 0,
          stockMin: parseFloat(n.stockMin) || 0,
          costo: parseFloat(n.costo) || 0,
          ultimaRevisionPrecio: hoy,
          proveedores: [],
        };
        creados++;
      }
    });

    const merged = Object.values(map);
    await kv.set(K.insumos, merged);
    res.json({ ok: true, creados, actualizados, total: merged.length });
  } catch (e) {
    console.error('/api/importar', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Leer nota de entrega con Claude Vision ──
app.post('/api/leer-nota', async (req, res) => {
  try {
    const { imagen, mediaType } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada en Vercel' });
    if (!imagen)  return res.status(400).json({ error: 'Falta la imagen' });

    // Obtener catálogo de insumos para dar contexto a Claude
    const insumosActuales = await kv.get(K.insumos) || [];
    const catalogo = insumosActuales.map(i => i.nombre).join(', ');

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imagen }
            },
            {
              type: 'text',
              text: `Eres un asistente de inventario para el restaurante INSTINTO. Analiza esta nota de entrega, remisión o CFDI de proveedor.

Nuestro catálogo de insumos es: ${catalogo}

Extrae todos los productos, cantidades y precios. Para cada producto, mapea al insumo más parecido del catálogo si existe.
Si aparece precio unitario o precio total (y puedes deducir el unitario), extráelo. Si no aparece precio, pon null.

IMPORTANTE — unidades y conversión a unidad base:
- Ignora claves SAT (K62, H87, XBX, etc.). Usa solo la unidad comercial/práctica.
- Si ves una columna "Unidad SAT" y otra "Unidad", usa la columna "Unidad".
- CONVIERTE envases a su unidad base cuando la capacidad está explícita en la nota:
  · "1 CUB 4.3 L"  → cantidad: 4.3,  unidad: "litro"   (1 cubeta × 4.3 L)
  · "2 CUB 4.3 L"  → cantidad: 8.6,  unidad: "litro"
  · "1 CAJA 12 PZA"→ cantidad: 12,   unidad: "pza"
  · "3 CAJA 12 PZA"→ cantidad: 36,   unidad: "pza"
  · Si el envase NO trae capacidad (solo dice "CUB" sin número), usa "cubeta" como unidad.
- Otros mapeos directos: KG→kg, G→g, LT/L→litro, ML→ml, PZA→pza, BOLSA→bolsa, ROLLO→rollo.

Responde ÚNICAMENTE con JSON válido, sin texto adicional ni markdown:
{
  "proveedor": "nombre del proveedor si aparece, o null",
  "items": [
    {
      "descripcion": "nombre como aparece en la nota",
      "insumoMapeado": "nombre EXACTO del insumo de nuestro catálogo, o null si no hay match",
      "cantidad": 0,
      "unidad": "cubeta/kg/g/pza/litro/caja/bolsa/rollo/etc",
      "precioUnitario": 0
    }
  ]
}`
            }
          ]
        }]
      })
    });

    const d = await r.json();
    if (!r.ok) return res.status(500).json({ error: d.error?.message || 'Error al llamar Anthropic API' });

    const texto = d.content?.[0]?.text || '';
    const jsonMatch = texto.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'No se pudo extraer datos de la nota. Intenta con una foto más clara.' });

    const resultado = JSON.parse(jsonMatch[0]);
    res.json(resultado);
  } catch (e) {
    console.error('/api/leer-nota', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Leer reporte de ventas en PDF con Claude ──
app.post('/api/leer-ventas-pdf', async (req, res) => {
  try {
    const { pdf } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada en Vercel' });
    if (!pdf)    return res.status(400).json({ error: 'Falta el PDF' });

    const recetasActuales = await kv.get(K.recetas) || [];
    const catalogo = recetasActuales.map(r => r.platillo).join(', ');

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdf }
            },
            {
              type: 'text',
              text: `Eres un asistente de inventario para el restaurante INSTINTO. Analiza este reporte de ventas en PDF.

Nuestro menú es: ${catalogo}

Extrae todos los platillos vendidos y sus cantidades totales. Para cada platillo, mapea al nombre EXACTO del menú si coincide.

Responde ÚNICAMENTE con JSON válido, sin texto adicional ni markdown:
{
  "ventas": [
    {
      "descripcion": "nombre como aparece en el PDF",
      "recetaMapeada": "nombre EXACTO del platillo de nuestro menú, o null si no hay match",
      "cantidad": 0
    }
  ]
}`
            }
          ]
        }]
      })
    });

    const d = await r.json();
    if (!r.ok) return res.status(500).json({ error: d.error?.message || 'Error al llamar Anthropic API' });

    const texto = d.content?.[0]?.text || '';
    const jsonMatch = texto.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'No se pudo extraer datos del PDF. Verifica que sea un reporte de ventas legible.' });

    const resultado = JSON.parse(jsonMatch[0]);
    res.json(resultado);
  } catch (e) {
    console.error('/api/leer-ventas-pdf', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Leer recetario completo desde PDF con Claude ──
app.post('/api/leer-recetario-pdf', async (req, res) => {
  try {
    const { pdf } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada en Vercel' });
    if (!pdf)    return res.status(400).json({ error: 'Falta el PDF' });

    const insumosActuales = await kv.get(K.insumos) || [];
    const catalogo = insumosActuales.map(i => `${i.id}|${i.nombre}|${i.unidad}`).join('\n');

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdf }
            },
            {
              type: 'text',
              text: `Eres un asistente de inventario para el restaurante INSTINTO. Analiza este recetario estandarizado en PDF.

Catálogo de insumos disponibles (formato: id|nombre|unidad):
${catalogo}

Extrae TODOS los platillos del recetario con sus ingredientes y gramajes exactos.
Para cada ingrediente, busca el insumoId correspondiente en el catálogo (coincidencia por nombre, tolerante a mayúsculas/tildes).
Si no hay match razonable, deja insumoId como null y pon el nombre tal como aparece en el PDF.

Responde ÚNICAMENTE con JSON válido, sin texto adicional ni markdown:
{
  "recetas": [
    {
      "platillo": "Nombre del platillo exacto como aparece en el PDF",
      "ingredientes": [
        {
          "nombre": "nombre del ingrediente",
          "insumoId": "ins_XXX o null",
          "cantidad": 0,
          "unidad": "g/ml/pza/etc"
        }
      ]
    }
  ]
}`
            }
          ]
        }]
      })
    });

    const d = await r.json();
    if (!r.ok) return res.status(500).json({ error: d.error?.message || 'Error al llamar Anthropic API' });

    const texto = d.content?.[0]?.text || '';
    const jsonMatch = texto.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'No se pudo extraer el recetario. Verifica que el PDF sea legible.' });

    const resultado = JSON.parse(jsonMatch[0]);
    res.json(resultado);
  } catch (e) {
    console.error('/api/leer-recetario-pdf', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Leer conteo físico de PDF ──
app.post('/api/leer-conteo-fisico-pdf', async (req, res) => {
  try {
    const { pdf } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada en Vercel' });
    if (!pdf)    return res.status(400).json({ error: 'Falta el PDF' });

    const insumosActuales = await kv.get(K.insumos) || [];
    const catalogo = insumosActuales.map(i => `${i.id}|${i.nombre}|${i.unidad}`).join('\n');

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdf }
            },
            {
              type: 'text',
              text: `Eres un asistente de inventario para el restaurante INSTINTO. Analiza este documento de CONTEO FÍSICO de inventario.

Catálogo de insumos disponibles (formato: id|nombre|unidad):
${catalogo}

Extrae TODOS los insumos con sus cantidades exactas del conteo.
Para cada insumo, busca el ID correspondiente en el catálogo (coincidencia por nombre, tolerante a mayúsculas/tildes).
Si no hay match razonable, deja insumoId como null.

Responde ÚNICAMENTE con JSON válido, sin texto adicional ni markdown:
{
  "conteo": [
    {
      "nombre": "nombre del insumo tal como aparece",
      "insumoId": "ins_XXX o null",
      "cantidad": 0,
      "unidad": "g/ml/pza/etc"
    }
  ]
}`
            }
          ]
        }]
      })
    });

    const d = await r.json();
    if (!r.ok) return res.status(500).json({ error: d.error?.message || 'Error al llamar Anthropic API' });

    const texto = d.content?.[0]?.text || '';
    const jsonMatch = texto.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'No se pudo extraer el conteo. Verifica que el PDF sea legible.' });

    const resultado = JSON.parse(jsonMatch[0]);

    // Calcular diferencias contra inventario actual
    const conteoConDiff = resultado.conteo.map(item => {
      const insumo = insumosActuales.find(i => i.id === item.insumoId);
      const stockActual = insumo ? (insumo.stock || 0) : 0;
      const diferencia = item.cantidad - stockActual;

      return {
        ...item,
        stockActual,
        diferencia,
        estado: diferencia === 0 ? 'SIN_CAMBIOS' : (diferencia > 0 ? 'SOBRANTE' : 'FALTANTE')
      };
    });

    res.json({ conteo: conteoConDiff });
  } catch (e) {
    console.error('/api/leer-conteo-fisico-pdf', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Auto-corte: procesa todos los días del POS sin procesar (sin PIN, para sync automático) ──
app.post('/api/auto-corte', async (req, res) => {
  try {
    const [posVentas, insumosRaw, recetasRaw, movimientosRaw, cortesRaw, configRaw] = await Promise.all([
      kv.get(K.posVentas),
      kv.get(K.insumos),
      kv.get(K.recetas),
      kv.get(K.movimientos),
      kv.get(K.cortes),
      kv.get(K.config),
    ]);

    const ventas      = posVentas      || [];
    const recetas     = recetasRaw     || [];
    const movimientos = movimientosRaw || [];
    const cortes      = cortesRaw      || [];
    const config      = configRaw      || {};

    const fechaInicio    = config.fechaInicioVentas || '2000-01-01';
    const fechasProcesadas = new Set(cortes.map(c => c.fecha));

    const normFecha = (v) => {
      if (v.fecha) {
        const f = v.fecha;
        if (f.includes('/')) {
          const [d,m,y] = f.split('/');
          return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        }
        return f.slice(0,10);
      }
      return new Date(v.id).toISOString().slice(0,10);
    };

    // Agrupar ventas pendientes por fecha
    const ventasPorFecha = {};
    ventas.forEach(v => {
      if (v.excluida) return;
      const fv = normFecha(v);
      if (fv < fechaInicio || fechasProcesadas.has(fv)) return;
      if (!ventasPorFecha[fv]) ventasPorFecha[fv] = [];
      ventasPorFecha[fv].push(v);
    });

    const fechasPendientes = Object.keys(ventasPorFecha).sort();
    if (!fechasPendientes.length) return res.json({ ok: true, cortesRealizados: 0, fechas: [] });

    const recetaMap = {};
    recetas.forEach(r => { recetaMap[r.platillo] = r.ingredientes || []; });

    // Mapa mutable de insumos
    const insMap = {};
    (insumosRaw || []).forEach(ins => { insMap[ins.id] = { ...ins }; });

    for (const fecha of fechasPendientes) {
      const ventasHoy   = ventasPorFecha[fecha];
      const descuentos  = {};
      const sinReceta   = new Set();
      let   itemsCount  = 0;

      ventasHoy.forEach(v => {
        (v.items || []).filter(it => !it.cancelado).forEach(item => {
          const receta = recetaMap[item.n];
          if (!receta || !receta.length) { sinReceta.add(item.n); return; }
          const qty = item.q || 1;
          itemsCount += qty;
          receta.forEach(ing => {
            descuentos[ing.insumoId] = (descuentos[ing.insumoId] || 0) + ing.cantidad * qty;
          });
        });
      });

      const hora = new Date().toLocaleTimeString('es-MX', { hour:'2-digit', minute:'2-digit' });
      Object.entries(descuentos).forEach(([insId, cant]) => {
        const ins = insMap[insId];
        if (!ins) return;
        const stockAntes = ins.stock;
        ins.stock = Math.max(0, ins.stock - cant);
        movimientos.push({
          id: `${Date.now()}_${insId}_${fecha}`,
          fecha, hora,
          tipo: 'VENTA',
          insumoId: insId,
          nombre: ins.nombre,
          cantidad: -(cant),
          unidad: ins.unidad,
          responsable: 'Auto-Corte POS',
          concepto: `Auto-corte ${fecha} — ${ventasHoy.length} ventas`,
          referencia: `CORTE-AUTO-${fecha}`,
          stockAntes,
          stockDespues: ins.stock,
        });
      });

      cortes.push({
        fecha,
        procesadoEn: new Date().toISOString(),
        ventasProcesadas: ventasHoy.length,
        itemsContados: itemsCount,
        insumosAfectados: Object.keys(descuentos).length,
        sinReceta: [...sinReceta],
        auto: true,
      });
    }

    await Promise.all([
      kv.set(K.insumos,     Object.values(insMap)),
      kv.set(K.movimientos, movimientos),
      kv.set(K.cortes,      cortes),
      kv.set(K.ts,          Date.now()),
    ]);

    res.json({ ok: true, cortesRealizados: fechasPendientes.length, fechas: fechasPendientes });
  } catch (e) {
    console.error('/api/auto-corte', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Toteat: registro de días con PDF subido ──
const TOTEAT_KEY = 'inv:toteatDias';

app.get('/api/toteat-dias', async (req, res) => {
  try {
    const dias = await kv.get(TOTEAT_KEY) || [];
    res.json({ dias });
  } catch (e) { res.json({ dias: [] }); }
});

app.post('/api/toteat-dias', async (req, res) => {
  try {
    const { fecha } = req.body || {};
    if (!fecha) return res.status(400).json({ error: 'Falta fecha' });
    const dias = await kv.get(TOTEAT_KEY) || [];
    if (!dias.includes(fecha)) {
      dias.push(fecha);
      dias.sort();
      await kv.set(TOTEAT_KEY, dias);
    }
    res.json({ ok: true, dias });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

module.exports = app;
