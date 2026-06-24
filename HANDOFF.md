# HANDOFF — INSTINTO Inventario
**Última actualización:** 23 junio 2026 (tarde)
**Rama:** `main` · Deploy automático en Vercel al hacer push
**Commit activo:** `59825a9`

---

## ESTADO GENERAL

Sistema de inventario **recién activado**. Hoy se reconectó la Redis correcta, se corrigieron bugs de modelo Claude, se agregó el banner de "sin receta" y se generó el formato de conteo físico. El sistema está en producción y conectado al mismo Redis que el POS.

**URL activa:** https://instinto-inventario.vercel.app
**Proyecto Vercel:** `instinto-inventario`
**Repo local:** `/Users/cha/Desktop/instinto-inventario/`

---

## LO QUE SE HIZO HOY ✅ (23 junio 2026)

### Fix #1 — Redis reconectada (causa raíz del sistema inactivo)
- El proyecto apuntaba a una Redis vacía (Added Mar 30 — nunca funcionó)
- Actualizados `KV_REST_API_URL` y `KV_REST_API_TOKEN` en Vercel → misma instancia que el POS
- Redis: `cool-toad-149285.upstash.io` (Instinto-POS en Upstash)
- Redeploy aplicado → sistema conectado al mismo POS

### Fix #2 — Model ID incorrecto (4 endpoints Claude)
- `claude-opus-4-6` no existe como modelo válido → rompía: leer fotos de notas, PDFs de ventas, recetario y conteo físico
- Corregido a `claude-haiku-4-5-20251001` (más barato, suficiente para extracción estructurada)
- **Regla establecida:** usar siempre el modelo más barato; sugerir uno mayor solo si la tarea lo justifica

### Fix #3 — Auto-corte ahora reporta platillos sin receta
- El endpoint `/api/auto-corte` acumulaba `sinReceta` internamente pero no lo devolvía al frontend
- Agregado `globalSinReceta` que se incluye en la respuesta JSON
- Nuevo banner amarillo en el frontend: cuando hay platillos del POS sin receta mapeada, aparece un aviso con los nombres exactos + instrucción de ir al Recetario

### Entregable — Formato de conteo físico
- Creado `public/conteo-fisico.html`: formato imprimible organizado por categorías (carnes, pan, quesos, verduras, salsas, papas, condimentos, empaque, bebidas)
- URL: https://instinto-inventario.vercel.app/conteo-fisico.html
- Listo para imprimir y usar hoy con gerentes

---

## ESTADO ACTUAL DEL SISTEMA

| Componente | Estado |
|-----------|--------|
| Redis (conexión al POS) | ✅ Activa — `cool-toad-149285.upstash.io` |
| Auto-corte al cargar página | ✅ Funciona — procesa ventas históricas del POS |
| Banner "sin receta" | ✅ Activo — alerta cuando platillo no tiene receta mapeada |
| Leer fotos de notas (Claude Vision) | ✅ Corregido — usa haiku |
| Leer PDFs de ventas | ✅ Corregido — usa haiku |
| Insumos cargados | ⚠️ CERO — hay que hacer conteo físico y cargar |
| Recetas mapeadas | ⚠️ CERO — hay que agregar recetario |
| Conteo físico inicial | ⏳ PENDIENTE — formato listo, conteo por hacer |

---

## PENDIENTE — PRÓXIMA SESIÓN 🔜

### Prioridad 1: Cargar insumos desde conteo físico
1. Gerentes llenan `conteo-fisico.html` hoy
2. Entrar al inventario → tab **Config** → **Importar insumos** → subir el conteo
   - O usar el botón **Conteo Físico** en la pantalla principal para cargar stock inicial
3. Verificar que los nombres de insumos coincidan con los ingredientes del recetario

### Prioridad 2: Cargar recetario
- Ir a tab **Recetario** → agregar cada platillo del POS con sus ingredientes y gramajes
- Los platillos que aparezcan en el banner amarillo = los que más urgen
- El nombre del platillo en el recetario debe coincidir **exactamente** con el nombre en el POS (case-sensitive)

### Prioridad 3: Verificar auto-corte con datos reales
- Una vez cargados insumos y recetas, recargar el inventario
- El auto-corte procesará todas las ventas históricas del POS
- Revisar si el stock resultante tiene sentido (puede ser negativo al inicio — es normal, son ventas históricas)
- Hacer un conteo físico real y usar "Conteo Físico" para ajustar al stock actual

### Prioridad 4: Reportes semanales (siguiente etapa de desarrollo)
Reportes que se van a construir:
- Varianza semanal (teórico vs real)
- Food cost % por categoría
- Compras semana vs semana anterior
- Punto de reorden automático (ya existe en tab Stock)
- ABC de insumos (mensual)

---

## ARQUITECTURA DE DATOS

```
Redis (cool-toad-149285.upstash.io — misma que POS):
  i:vta              → ventas del POS (solo lectura desde inventario)
  inv:insumos        → catálogo de ingredientes + stock actual
  inv:recetas        → recetas: platillo → lista de ingredientes con gramajes
  inv:movimientos    → historial de movimientos (ventas, merma, compras, ajustes)
  inv:cortes         → registro de cortes diarios procesados
  inv:config         → configuración (fechaInicioVentas, etc.)
  inv:lastUpdate     → timestamp para sync entre tabs
  inv:ordenes        → órdenes de compra a proveedores
  inv:toteatDias     → días con PDF de Toteat ya subido
```

---

## VARIABLES DE ENTORNO (proyecto instinto-inventario)

| Variable | Estado | Notas |
|----------|--------|-------|
| `KV_REST_API_URL` | ✅ Actualizada hoy | `https://cool-toad-149285.upstash.io` |
| `KV_REST_API_TOKEN` | ✅ Actualizada hoy | Token completo (read-write), Sensitive |
| `ANTHROPIC_API_KEY` | ✅ Existía desde antes | Para Vision y PDF reading |
| `PIN_ADMIN` | ⚠️ No configurada | Usa default `1234` — pendiente cambiar |

---

## PINS DEL SISTEMA

| PIN | Valor | Para qué |
|-----|-------|----------|
| Admin (`PIN_ADMIN`) | `1234` (default) | Acciones con PIN: corte manual, importar, etc. |

---

## PARA ARRANCAR LA PRÓXIMA SESIÓN

Di: **"continuemos con el inventario"** → cargo este handoff automáticamente.

Comandos rápidos:
- `"carga el conteo físico"` → guía para importar insumos al sistema
- `"configura el recetario"` → proceso para mapear platillos del POS a ingredientes
- `"construye el reporte semanal"` → arranca el desarrollo de los reportes de KPIs
