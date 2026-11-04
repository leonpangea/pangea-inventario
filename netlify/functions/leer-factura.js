// Lee la foto de una factura o albarán con Claude y devuelve las líneas ya
// convertidas a la UNIDAD DE COMPRA de cada materia prima del catálogo,
// para que el descuento de inventario sea exacto.
//
// La IA solo COPIA lo que está impreso (bultos, letra, kilos, lote, precio,
// importe). El cálculo y la comprobación los hace este servidor, que es
// determinista: la cantidad buena es la que cumple  cantidad x precio = importe.
//
// La clave API vive aquí en el servidor (variable de entorno), nunca en la app.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://euksmojqeiijfhbbavnn.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_fQJxpQCYdImxP9bsriBdSg_Px0JYdVe';
const MODELO = process.env.MODELO_IA || 'claude-sonnet-4-5-20250929';

// Lo que trae una caja. Ve añadiendo aquí lo que confirmes con el proveedor y
// esas líneas dejarán de pedir que escribas la cantidad a mano.
const _UD_POR_CAJA = {  // para materias que se controlan en "ud"
  'aguacate': 13,       // caja de "12/14 Pzas", 13 de media (Fran, 20/09/2026)
  // 'rúcula': 8,
};
const _KG_POR_CAJA = {  // para materias que se controlan en "kg" o "l"
  'arándano fresco': 1, // siempre en barqueta de 1 kg, nunca a granel (Fran, 20/09/2026)
  'levadura seca': 10,  // caja Angel = 20 paquetes de 500 gr (Fran, 20/09/2026)
};

// Productos de factura cuyo nombre no se parece al del catálogo. Se comprueban
// contra la descripción leída; el primero que case, gana.
const ALIAS = [
  [/c[ou]bert\w*.*70\s*[\/\-]\s*[35]0/i,      'chocolate negro 70%'],
  [/c[ou]bert\w*.*(edelweiss|blanc)/i,        'chocolate blanco'],
  [/c[ou]bert\w*.*(leche|823)/i,              'chocolate con leche'],
  [/nata\s+italiana/i,                       'nata'],
  [/levadura.*cinta\s*roja/i,                'levadura fresca'],
  [/levadura.*(en\s*polvo|angel)/i,          'levadura seca'],      // panificables
  [/impulsor|polvo\s*de\s*hornear|royal/i,   'polvo de hornear'],   // bizcochos
  [/mantequilla.*(debic|placa|laminar)/i,    'mantequilla de laminar 84%'],
  [/mantequilla.*(villepre|pascual|bloque)/i,'mantequilla'],
  [/harina.*(gran\s*)?fuerza/i,              'harina de fuerza'],
  [/harina.*(banda\s*blanca|floja)/i,        'harina floja'],
  [/harina.*nova/i,                          'harina nova'],
  [/harina.*(sfoglia|hojaldre)/i,            'harina sfoglia'],
  [/az[uú]car.*(glass|nevada)/i,             'azúcar glass'],
  [/az[uú]car.*moreno/i,                     'azúcar moreno'],
  [/az[uú]car/i,                             'azúcar'],
  [/(sabormas|oliva|aceite).*(vir\w*\.?\s*extra|\bv\.?\s?e\.?\b|\bavoe\b)/i, 'aceite de oliva virgen extra'],
  [/(sabormas|aceite).*oliva/i,              'aceite de oliva'],
  [/aceite.*(girasol|sunflower)/i,           'aceite de girasol'],
];

// Membretes que no coinciden con el nombre con el que Fran tiene dado de alta
// al proveedor. Se aplica al nombre que devuelve la IA, sea cual sea.
const PROV_ALIAS = [
  [/cervecera\s*leonesa|cerlesa/i,           'CERLESA'],
  [/frutas\s*el\s*bierzo|el\s*bierzo/i,      'FRUTAS EL BIERZO'],
  [/exclusivas\s*andr/i,                     'EXCLUSIVAS ANDRES'],
  [/javier\s*guti[eé]rrez/i,                 'COMERCIAL JAVIER GUTIERREZ'],
  [/queslac|entrequesos/i,                   'ENTREQUESOS'],
  [/euroques/i,                              'EUROQUES'],
  [/hu?evos?\s*camperos|del\s*p[aá]ramo/i,   'Huevos Camperos del Páramo'],
  [/c[aá]rnicas?\s*su[aá]rez|carnes\s*su[aá]rez/i, 'CARNICAS SUAREZ'],
  [/productos\s*seco/i,                      'PRODUCTOS SECO'],
  [/nistaldis/i,                             'NISTALDIS'],
  [/pharmadus/i,                             'PHARMADUS'],
  [/supercash/i,                             'SUPERCASH'],
  [/top\s*cash/i,                            'TOP CASH'],
  [/mercadona/i,                             'MERCADONA'],
  [/epicure/i,                               'EPICURE 56'],
  [/comercial\s*luna/i,                      'Comercial Luna'],
  [/entrepe[nñ]as/i,                         'Entrepeñas'],
  [/pistacyl/i,                              'Pistacyl'],
];

function normProveedor(p) {
  const s = String(p || '').trim();
  if (!s) return s;
  for (const [re, nombre] of PROV_ALIAS) if (re.test(s)) return nombre;
  // quita la forma societaria, que suele estorbar al emparejar
  return s.replace(/[,.]?\s*\b(s\.?\s?l\.?\s?u?\.?|s\.?\s?a\.?|s\.?\s?c\.?\s?l\.?|c\.?\s?b\.?)\b\s*$/i, '').trim();
}

// ---------------------------------------------------------------- utilidades
const norm = s => String(s == null ? '' : s)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).trim().replace(/\s|€/g, '');
  if (/,\d{1,4}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');   // 1.250,5
  else s = s.replace(/,/g, '');                                          // 1,250.5
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

// las tablas se escriben con tildes pero se consultan normalizadas
const _norml = t => { const o = {}; for (const k in t) o[norm(k)] = t[k]; return o; };
const UD_POR_CAJA = _norml(_UD_POR_CAJA);
const KG_POR_CAJA = _norml(_KG_POR_CAJA);

const esPeso = u => /^(kg|kgs|kilo|kilos|k)$/.test(u);
const esVol  = u => /^(l|lt|lts|litro|litros|ml|cl)$/.test(u);
const esUd   = u => /^(ud|uds|u|unid|unidad|unidades|pieza|piezas|pza|pzas|bdja|bandeja|bandejas|barqueta|barquetas|manojo|manojos|bote|botes|bolsa|bolsas|tarrina|tarrinas|docena|docenas|caja|cajas)$/.test(u);
const esCaja = u => /^(caja|cajas|cj|c|bulto|bultos|palet|palot|saco|sacos|malla|mallas)$/.test(u);

function limpiarLote(v) {
  if (!v) return '';
  let s = String(v).trim();
  s = s.replace(/^\s*n[º°o]?\.?\s*lote\.?\s*:?\s*/i, '');
  s = s.replace(/^\s*lote\.?\s*:?\s*/i, '');
  s = s.replace(/\s*f\.?\s*cad\.?.*$/i, '');
  s = s.replace(/\s*caducidad\s*:?.*$/i, '');
  s = s.replace(/^[:\-\s]+|[:\s]+$/g, '').trim();
  return s;
}

// Mismo criterio que la app: idéntico, plural/singular, o el catálogo contiene
// TODO lo leído. Por debajo de eso respetamos el nombre de la factura.
function emparejar(nombre, cat) {
  const n = norm(nombre);
  if (!n) return '';
  let best = '', bs = 0;
  for (const m of cat) {
    const mn = norm(m.nombre);
    let s = 0;
    if (mn === n) s = 100;
    else if (mn === n + 's' || n === mn + 's') s = 95;
    else if (mn.includes(n) && n.length >= 5) s = 70;
    if (s > bs) { bs = s; best = m.nombre; }
  }
  return bs >= 70 ? best : '';
}

// ------------------------------------------------- catálogo (nombre + unidad)
async function cargarCatalogo(materiasDelCliente) {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/inv_materias?select=nombre,unidad&order=nombre`,
      { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } }
    );
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d) && d.length)
        return d.map(m => ({ nombre: m.nombre, unidad: (m.unidad || 'kg').toLowerCase() }));
    }
  } catch (e) { /* seguimos con lo que mandó el cliente */ }
  return (materiasDelCliente || []).map(m =>
    typeof m === 'string' ? { nombre: m, unidad: '' }
                          : { nombre: m.nombre, unidad: (m.unidad || '').toLowerCase() });
}

// ------------------------------------------------------ el cálculo de verdad
function resolver(l, cat, porNombre, proveedor) {
  const desc = String(l.descripcion || l.nombre || '').trim();
  const propuesta = l.catalogo && porNombre[norm(l.catalogo)] ? porNombre[norm(l.catalogo)].nombre : '';
  let porAlias = '';
  for (const [re, destino] of ALIAS) {
    if (re.test(desc) && porNombre[norm(destino)]) { porAlias = porNombre[norm(destino)].nombre; break; }
  }
  const nombre = propuesta || porAlias || emparejar(desc, cat) || desc;
  const m = porNombre[norm(nombre)] || null;
  const destino = m ? m.unidad : '';           // kg | l | ud   ('' = materia nueva)

  const letra   = String(l.bultos_letra || '').trim().toUpperCase().slice(0, 1);
  const bultos  = num(l.bultos);
  const neto    = num(l.kg_neto);
  const bruto   = num(l.kg_bruto);
  const cc      = num(l.cantidad_col);
  const uc      = norm(l.unidad_col);
  const precio  = num(l.precio);
  const importe = num(l.importe);
  const envase  = num(l.peso_envase_kg);       // kg o l que trae cada envase
  const udsEnv  = num(l.uds_por_envase);       // piezas sueltas que trae cada envase

  // 1. La cantidad facturada de verdad: la que cumple cantidad x precio = importe,
  //    descontando el % de descuento de la línea si lo hay.
  const dto = Math.min(Math.max(num(l.dto) || 0, 0), 99);
  const precioNeto = precio != null ? precio * (1 - dto / 100) : null;
  const qFac = (precioNeto && precioNeto > 0 && importe != null) ? importe / precioNeto : null;
  const casa = v => v != null && qFac != null && Math.abs(v - qFac) <= Math.max(0.02, Math.abs(qFac) * 0.012);

  // 2. ¿En qué unidad está esa cantidad? Manda la letra del bulto.
  let udFac = (letra === 'U' || letra === 'M' || letra === 'B') ? 'ud'
            : (letra === 'C' || letra === 'K' || letra === 'S' || letra === 'P') ? 'kg'
            : esUd(uc) ? 'ud' : esVol(uc) ? 'l' : esPeso(uc) ? 'kg' : '';
  // El Bierzo: a veces las columnas de kilos repiten el nº de bultos; entonces
  // no son kilos, y el precio es por bulto (por unidad si la letra es U/M,
  // por caja si es C).
  const espejo = neto != null && bultos != null && Math.abs(neto - bultos) < 1e-6
                 && (bruto == null || Math.abs(bruto - bultos) < 1e-6);
  const kilosSonEspejo = espejo && udFac === 'ud';
  const cajasEspejo    = espejo && udFac === 'kg' && (letra === 'C' || letra === 'S' || letra === 'P');

  // 3. La cantidad facturada, eligiendo la columna que cuadra con el importe.
  let q = null;
  if (udFac === 'ud') {
    q = casa(bultos) ? bultos : casa(cc) ? cc : (bultos != null ? bultos : cc);
  } else {
    q = casa(neto) ? neto : casa(cc) ? cc : casa(bruto) ? bruto
      : (neto != null ? neto : cc != null ? cc : (letra === 'K' ? bultos : null));
  }
  if (q == null && qFac != null) q = qFac;
  if (!udFac && q != null) udFac = destino || 'kg';

  // Si lo leído no cuadra con importe ÷ precio, manda la aritmética: es más
  // fiable que el OCR de una cifra. Solo si sale un número limpio (así un
  // descuento no leído no nos cuela una cantidad rara).
  let qCorregida = null;
  const limpio = v => v != null && Math.abs(v - Math.round(v * 1000) / 1000) < 1e-9;
  if (q != null && qFac != null && qFac > 0 && !casa(q) && limpio(qFac)) {
    qCorregida = q; q = qFac;
  }

  // 4. Pasarla a la unidad en la que está dada de alta la materia.
  let ud = destino || (udFac === 'ud' ? 'ud' : udFac || 'kg');
  let cant = null, aviso = '';
  const redondea = v => v == null ? null : Math.round(v * 1000) / 1000;

  // Exclusivas Andrés factura a granel salvo que la descripción diga el formato
  const dicFormato = /\d\s*(kg|kgs|gr|grs|g|l|lt|ml|cl|cc)\b|\bx\s*\d/i.test(desc);
  const esEnvase = /^\s*(caja|cajas|bote|bte|pq|paq|saco|sacos|bolsa|bolsas|lata|latas|tarrina|spray|bidon|garrafa)\b/i.test(desc);
  const aGranel = /exclusivas\s*andr/i.test(String(proveedor || '')) && !dicFormato && !envase && !esEnvase;

  // ¿la línea viene en cajas? (la letra del bulto o la columna de unidad)
  const lineaEnCajas = letra === 'C' || letra === 'S' || letra === 'P' || esCaja(uc);
  let cajas = bultos != null ? bultos : (cc != null ? cc : null);
  let cajasCorregidas = null;
  // En las líneas facturadas POR CAJA el importe manda sobre la lectura de la
  // columna: importe ÷ precio es el nº de cajas, y es aritmética, no OCR.
  function afinarCajas() {
    if (qFac != null && qFac > 0 && (cajas == null || !casa(cajas))) {
      cajasCorregidas = cajas; cajas = qFac;
    }
    return cajas;
  }

  if (ud === 'kg' || ud === 'l') {
    const kpc = KG_POR_CAJA[norm(nombre)];
    // el peso real del albarán manda; la tabla solo entra cuando no hay peso
    // fiable (la columna de kilos repite los bultos, o no viene)
    if (lineaEnCajas && (cajasEspejo || neto == null) && kpc && afinarCajas() != null) {
      cant = cajas * kpc;
      aviso = `${redondea(cajas)} caja(s) × ${kpc} ${ud} = ${redondea(cant)} ${ud}.`
            + (cajasCorregidas != null ? ` (En el albarán leí ${cajasCorregidas} bultos, pero por el importe salen ${cajas}: compruébalo.)` : ' (Comprueba las cajas.)');
    }
    else if (cajasEspejo) {
      // la columna de kilos repite el nº de cajas: no son kilos, el precio es por caja
      aviso = `Vienen ${q} caja(s) de "${nombre}" y el albarán no dice los ${ud}: escríbelos. (La columna de kilos repite el nº de cajas, no son kilos.)`;
    }
    // si el albarán trae un peso de verdad, ése manda sobre cualquier cuenta
    else if (neto != null && !espejo) cant = neto;
    else if (udFac === 'kg' || udFac === 'l') cant = q;            // kg ≈ l (densidad 1)
    else if (udFac === 'ud' && envase && q != null) {
      cant = q * envase;
      aviso = `${q} envase(s) × ${envase} ${ud} = ${redondea(cant)} ${ud}.`;
    } else if (udFac === 'ud' && aGranel && q != null) {
      // Exclusivas Andrés: si la descripción no dice ningún formato, la línea
      // va a granel y la cantidad ya está en la unidad de la materia.
      cant = q;
      aviso = `La descripción no dice el formato, así que lo tomo como ${redondea(q)} ${ud} a granel. Compruébalo.`;
    } else if (udFac === 'ud') {
      aviso = `La factura da ${q != null ? q + ' ' : ''}${letra === 'C' || esCaja(uc) ? 'caja(s)' : 'unidad(es)'} y "${nombre}" se controla en ${ud}: escribe los ${ud} que han entrado.`;
      if (kilosSonEspejo) aviso += ' (Ojo: la columna de kilos repite el nº de unidades, no son kilos.)';
    } else if (neto != null && !kilosSonEspejo) cant = neto;
    else aviso = `No se ve el peso de "${nombre}": escribe los ${ud}.`;
  } else if (ud === 'ud') {
    const upc = UD_POR_CAJA[norm(nombre)];
    // si la línea viene en cajas, la cantidad son cajas: los kilos del albarán
    // no sirven para nada aquí
    if (lineaEnCajas) {
      if (upc && afinarCajas() != null) {
        cant = cajas * upc;
        aviso = `${redondea(cajas)} caja(s) × ${upc} ud = ${redondea(cant)} ud.`
              + (cajasCorregidas != null ? ` (En el albarán leí ${cajasCorregidas} bultos, pero por el importe salen ${cajas}: compruébalo.)` : ' (Comprueba las cajas.)');
      } else if (udsEnv && udsEnv > 0 && afinarCajas() != null) {
        cant = cajas * udsEnv;
        if (udsEnv > 1) aviso = `${redondea(cajas)} caja(s) × ${udsEnv} ud = ${redondea(cant)} ud.`;
        if (cajasCorregidas != null) {
          aviso += ` (En el albarán leí ${cajasCorregidas} bultos, pero por el importe salen ${redondea(cajas)}: compruébalo.)`;
        }
      } else if (cajas != null) {
        aviso = `Vienen ${redondea(cajas)} caja(s) y "${nombre}" se controla en unidades: escribe cuántas unidades han entrado.`;
      } else aviso = `No se ve cuántas cajas de "${nombre}" han entrado.`;
    } else if (udFac === 'ud') {
      if (/docena/.test(uc) || /docena/i.test(desc)) {
        cant = q * 12; aviso = `${q} docena(s) × 12 = ${redondea(cant)} ud.`;
      } else if (udsEnv && udsEnv > 1) {
        cant = q * udsEnv;
        aviso = `${q} envase(s) × ${udsEnv} ud = ${redondea(cant)} ud.`;
      } else cant = q;
    } else if (envase && q != null) {
      cant = q / envase;
      aviso = `${q} ${udFac} ÷ ${envase} por envase = ${redondea(cant)} ud (revísalo).`;
    } else {
      aviso = `La factura va en ${udFac || 'peso'} y "${nombre}" se controla en unidades: escribe las unidades.`;
    }
  }

  const lote = limpiarLote(l.lote);
  if (!lote) aviso = (aviso ? aviso + ' ' : '') + 'Sin lote: cópialo del albarán.';

  // avisos de control sobre la cantidad
  if (qCorregida != null)
    aviso = (aviso ? aviso + ' ' : '')
          + `En el albarán leí ${redondea(qCorregida)} pero por el importe (${importe} ÷ ${redondea(precioNeto)}) salen ${redondea(qFac)}: he cogido ${redondea(qFac)}, compruébalo.`;
  else if (cajasCorregidas == null && cant != null && cant === q && qFac != null && !casa(q))
    aviso = (aviso ? aviso + ' ' : '') + `Comprobación: el importe sale de ${redondea(qFac)} × ${redondea(precioNeto)} €. Revisa la cantidad.`;

  return {
    nombre,
    cantidad: redondea(cant),
    unidad: ud,
    lote,
    caducidad: l.caducidad || '',
    aviso,
    // lo que venía impreso, para contrastar. Si la columna de kilos solo repite
    // el nº de bultos no la enseñamos: no son kilos y confunde.
    leido: (() => {
      const udTxt = udFac === 'kg' ? 'kilos' : udFac === 'l' ? 'litros'
                  : udFac === 'ud' ? 'unidades' : (l.unidad_col || '');
      const hayBultos = !!letra && bultos != null;          // la letra solo la trae El Bierzo
      const igual = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;
      // enseñamos la cantidad que se ha usado de verdad, en su unidad
      const pesoManda = !espejo && neto != null && igual(cant, neto);
      const base = pesoManda ? { v: neto, u: ud === 'l' ? 'litros' : 'kilos' } : { v: q, u: udTxt };
      const repetido = hayBultos && igual(base.v, bultos);   // no repetir el mismo número dos veces
      return {
        descripcion: desc,
        bultos: hayBultos ? bultos : null,
        letra,
        kg_bruto: null,
        kg_neto: (!espejo && neto != null && !igual(neto, base.v)) ? neto : null,
        cantidad_col: (repetido || base.v == null) ? null : redondea(base.v),
        unidad_col: (repetido || base.v == null) ? '' : base.u,
        precio, importe, albaran: l.albaran || ''
      };
    })()
  };
}

// ------------------------------------------------------------------ el prompt
function construirPrompt(cat) {
  const catalogoTxt = cat.length
    ? `\n\nCATÁLOGO DE PANGEA (si la descripción de la factura es este producto, pon su nombre EXACTO en "catalogo"; si no lo tienes claro, deja ""):\n${cat.map(m => m.nombre).join(', ')}`
    : '';

  return `Eres un lector de facturas y albaranes de proveedores de hostelería en España.
Analiza la imagen y devuelve SOLO JSON, sin explicaciones ni markdown.

Tu trabajo es COPIAR lo que está impreso, columna por columna. NO conviertas, NO calcules, NO deduzcas. El cálculo lo hace el programa después, y comprueba que cantidad × precio = importe, así que esos tres datos tienen que ser fieles.

Formato exacto:
{
  "proveedor": "nombre del proveedor",
  "documento": "nº de factura, o \\"\\"",
  "fecha": "YYYY-MM-DD o \\"\\"",
  "lineas": [
    {
      "albaran": "nº del albarán bajo el que va la línea, o \\"\\"",
      "descripcion": "el texto del producto tal cual",
      "bultos": número o null,
      "bultos_letra": "la letra pegada al número de bultos, en mayúscula, o \\"\\"",
      "kg_bruto": número o null,
      "kg_neto": número o null,
      "cantidad_col": número o null,
      "unidad_col": "kg/ud/caja/l/docenas/... o \\"\\"",
      "peso_envase_kg": número o null,
      "uds_por_envase": número o null,
      "lote": "el nº de lote, o \\"\\"",
      "caducidad": "YYYY-MM-DD o \\"\\"",
      "precio": número o null,
      "dto": número o null,
      "importe": número o null,
      "catalogo": "nombre exacto del catálogo, o \\"\\""
    }
  ]
}

REGLAS GENERALES
1. EL LOTE ES LO MÁS IMPORTANTE. Puede estar en su propia columna, pegado al código del producto, en el renglón de debajo ("Lote: 2026/33226 Caducidad: 05/08/27") o entre paréntesis. Cópialo entero con letras, números, guiones y barras. Solo "" si de verdad no aparece.
2. Una línea partida en dos renglones (descripción arriba, lote o caducidad debajo) es UNA sola línea.
3. Las facturas mensuales agrupan las líneas por albarán ("Albarán: 22.493 : 02/07/2026", "ALBARAN 12873", "Del Albaran nº:26002807"). Esa cabecera NO es un producto: su número va en "albaran" de las líneas que cuelgan de ella.
4. Números con punto decimal: "2,5" -> 2.5. Si el original usa el punto para los miles ("1.250"), devuelve 1250.
5. No confundas la columna de IVA (%I, %IVA: 4, 10, 21) con una cantidad.
5b. "dto" es el % de descuento de la línea (columnas "Dto.", "% dto.", "Dto"), solo el número: 25 para un 25%. Si no hay, null. Importa, porque compruebo que cantidad × precio ya descontado da el importe.
5c. "precio" e "importe" son los dos números que más me sirven para comprobar la cantidad: cópialos con todos sus decimales, tal cual (26.5781, no 26.58).
6. "peso_envase_kg" es lo que trae UNA de las unidades que estás copiando en "cantidad_col", en kg o litros, CONTANDO TODO LO QUE VA DENTRO. Si no se puede saber por la descripción, null.
   · Cuando la cantidad son cajas o lotes completos, multiplica formato × piezas: "SABORMAS VIR EXTRA 5L Caja de 3" -> 15; "DISAL FINA T-1 1KG-12" -> 12; "SABORMA VIR EXT 1L-15" -> 15; "CABREIROA GAS VR 24b 33cl" -> 7.92; "GAR VINAGRE 5 L.-3" -> 15.
   · Cuando la cantidad ya son las piezas sueltas (hay una columna "Uds." aparte de "Cajas"), pon solo lo que pesa UNA pieza: "MONTEREY JACK 50%LONCHAS 1KGx6" con Uds. 6 -> 1; "NATA 1LX12" con Uds. 12 -> 1.
   · Formatos simples: "HARINA ALMENDRA 1KG" -> 1; "PLATANO DESHIDRATADO 800GR" -> 0.8; "PATE TARTUFO NERO 500GR" -> 0.5.
6b. "uds_por_envase" es CUÁNTAS PIEZAS SUELTAS trae UNA de las unidades que estás copiando en "cantidad_col". Es el hermano de "peso_envase_kg": uno cuenta el peso, el otro las piezas.
   · "SABORMAS VIR EXTRA 5L Caja de 3" -> 3 (tres garrafas); "DISAL FINA T-1 1KG-12" -> 12; "CABREIROA GAS VR 24b 33cl" -> 24; "NATA 1LX12" facturada por cajas -> 12.
   · Si la cantidad ya son piezas sueltas (hay columna "Uds." aparte de "Cajas", o la unidad es "ud"), pon 1.
   · Si la descripción NO dice cuántas piezas trae el bulto, pon 1 cuando sea claramente un envase suelto ("YAROS PLUS FREGASUELOS BIOALCOHOL MANZANA 5L" -> 1, una garrafa) y null cuando de verdad no se pueda saber.
7. Si un dato no aparece: null en los números, "" en los textos. No lo inventes.
8. Ignora lo que no sea producto: totales, base imponible, IVA, recargo, portes, envases y retornos de cajas vacías, descuentos de pie, servicios, tasas de Punto Verde / S.I.G., y los avisos en texto libre que el proveedor imprime entre las líneas ("CERRADO POR LAS TARDES", "GRACIAS POR SU CONFIANZA", horarios, etc.). Si una de esas frases aparece pegada a un producto, déjala fuera de la descripción.

LA COLUMNA "BULTOS" Y SU LETRA
Muchos albaranes de fruta y verdura ponen, pegada al número de bultos, una letra que dice de qué es el bulto:
  C = caja    U = unidad (pieza, manojo, barqueta, bandeja)    K = kilo
  B = bandeja    S = saco    M = malla/manojo    P = palet
Pon el número en "bultos" y la letra sola en "bultos_letra". "3 C" -> 3 y "C". "8,00 U" -> 8 y "U". Si no lleva letra, "".
NUNCA supongas que la línea va en kilos porque haya una columna de kilos.

9. Si hay DOS columnas de precio (una con IVA y otra sin IVA), "precio" es la que multiplicada por la cantidad da el importe: la de SIN IVA. Nunca la de "PREC+IVA" ni la de "P.V.P. con IVA".
10. El PROVEEDOR es la razón social impresa en la cabecera, copiada tal cual. No lo deduzcas del parecido con la lista de abajo: "COMERCIAL JAVIER GUTIERREZ S.L." y "COMERCIAL LUNA" son dos empresas distintas, igual que "ENTREQUESOS" y "EUROQUES". Si la cabecera dice una, no pongas la otra.
11. Un documento puede ser FACTURA o ALBARÁN; se leen igual. En un albarán, su propio número va en "documento" y también en "albaran".

CÓMO ES CADA PROVEEDOR
· FRUTAS EL BIERZO — COD. | LOTE | Descripción | %I | BULTOS | KG. BRUTO | KG. NETO | Precio | Importe.
  El LOTE es el número de 9 cifras que va ENTRE el código y la descripción: no es parte del código, cópialo en "lote".
  BULTOS es la columna que va JUSTO ANTES de KG. BRUTO, y es la única que lleva letra pegada. Copia ese número en "bultos" y su letra en "bultos_letra". No metas ahí los kilos ni el %I.
  El importe siempre es KG. NETO × Precio. En las líneas con letra U o M la columna de kilos repite el número de unidades (8,00 U -> 8,00 kg): cópiala igual, el programa ya lo sabe.
  Antes de dar por buena una línea comprueba que bultos, kilos, precio e importe son los cuatro números que ves, en ese orden, y que el importe cuadra.
· EXCLUSIVAS ANDRÉS — Cód. | Descripción | Cantidad | Precio | % IVA | % dto. | Importe, agrupado por "Albarán: 26- 4711 - Fecha: 04-08-2026".
  DEBAJO de cada producto va su renglón "Lote: 39E0907601    Fecha de caducidad: 31-12-2030": de ahí salen "lote" y "caducidad".
  LA UNIDAD LA DICE EL PRINCIPIO DE LA DESCRIPCIÓN, y manda sobre todo lo demás:
    · "KG", "KGS", "KGS.", "KGRS", "KGRS." (o lo que la foto haya deformado, tipo "YGRS.") -> unidad_col "kg" y peso_envase_kg null. La cantidad YA son kilos, aunque después ponga el formato: "KGS. AZUCAR Saco 25 KG" con cantidad 50 son 50 kg (dos sacos), NO 50 sacos.
    · "LT", "LTS", "L" -> unidad_col "l". "LT NATA ITALIANA 38%" con cantidad 12 son 12 litros.
    · "CAJA", "CAJAS" -> unidad_col "caja"; "BOTE", "BTE", "PQ" -> unidad_col "ud". En los dos casos, peso_envase_kg con el tamaño si la descripción lo dice ("CAJA LEVADURA CINTA ROJA 10 KG" -> 10); si no lo dice, null.
    · Si no empieza por ninguna de esas abreviaturas: unidad_col "ud", y peso_envase_kg solo si la descripción trae el tamaño ("GOMA XANTANA 700 GRS" -> 0.7).
  Si la descripción NO lleva ningún tamaño de envase y el producto es a granel (harina, azúcar, cobertura, chocolate, cacao, mantequilla), son kilos.
· COMERCIAL JAVIER GUTIÉRREZ — Ref. | Descripción | Cajas | Cantidad | Precio | Dto. | Importe, en facturas y en albaranes, con el renglón "Lote: 005959   F.Cad: 23-07-2027" DEBAJO de cada producto.
  AQUÍ EL SEPARADOR DECIMAL ES EL PUNTO: "9.63" son 9,63 y "1.00" es 1. El importe es Cantidad × Precio.
  "Cajas" -> bultos, y bultos_letra SIEMPRE "" (esa columna es informativa, no dice la unidad). "Cantidad" -> cantidad_col.
  La unidad y el envase los dice el FINAL de la descripción:
    · termina en "KG" suelto ("MANGO DADOS CONG AROTZ KG") -> unidad_col "kg", peso_envase_kg null: la cantidad ya son kilos.
    · lleva el tamaño del bulto ("HARINA NOVA 12,5KG" -> 12.5; "HARINA MASA HOJALDRE 12.5KG SFOGLIA" -> 12.5; "YOGUR GRIEGO METEORA C/5KG" -> 5; "PATE TARTUFO NERO 500GR" -> 0.5; "CHILE CHIPOTLE ADOBO L/2,8KG" -> 2.8) -> unidad_col "ud" y peso_envase_kg con ese tamaño: la cantidad son envases.
· ENTREQUESOS / EUROQUES / QUESLAC — Código | Concepto | Lote | Caducidad | Cajas | Uds. | Kilos | Precio | Dto | Importe.
  "Cajas" -> bultos con bultos_letra "" (informativo). "Uds." -> cantidad_col con unidad_col "ud". "Kilos" -> kg_neto. El importe es Kilos × Precio.
  ALBARÁN DE EUROQUES (cabecera "DESCRIPCIÓN ARTICULO | CAJAS | UNI/PIEZ | KILOS | PRECIO | IMPORTE"): cada producto ocupa DOS renglones.
    Arriba la descripción ("QUESO MASCARPONE 2KG ALBE X3UD", "MAYONESA SARNAGO 3,6L X 4UD"); a la izquierda, un renglón más abajo, el código (55069).
    Abajo "IVA 4   F.CAD.:27-12-26   LOTE:10672": "lote" es lo que va tras "LOTE:" (10672) y "caducidad" la fecha tras "F.CAD." con año de 2 cifras (27-12-26 -> 2026-12-27). El número tras "IVA" es el % de IVA, NUNCA cantidad ni lote.
    A la derecha, en el renglón de la descripción, van los números: el PRIMERO (4.00) son las unidades/piezas -> cantidad_col con unidad_col "ud"; el SEGUNDO (8.000) son los kilos -> kg_neto; luego PRECIO e IMPORTE.
    Aquí el importe es UNIDADES × PRECIO (4 × 13,900 = 55,60), no kilos × precio. "X3UD"/"X 4UD" al final del nombre es lo que trae la caja, no la cantidad recibida.
    El tamaño del envase va en la descripción ("2KG" -> peso_envase_kg 2; "3,6L" -> 3.6; "1KG" -> 1).
· ENTREPEÑAS — Código | Descripción | Lote | Unid. | Peso | Precio | U/K | %Dto. | Importe.
  "Peso" -> kg_neto. "Unid." -> bultos. La columna U/K (una K o una U) -> bultos_letra. "Unid." puede ser 0 y no pasa nada.
· PRODUCTOS SECO — Código | Descripción | Emb | Cantidad | Precio | Dto | IVA | Importe, y DEBAJO "Lote: 2026/33226 Caducidad: 05/08/27". La cantidad ("4 Ud") va en cantidad_col + unidad_col. El tamaño del envase está en la descripción ("1KG", "5KG", "800GR").
· SUÁREZ (carnes) — Código | Concepto | Kilos | Precio | %Dto | Importe, agrupado por "Albarán Nº". Kilos -> kg_neto. No trae lote.
· HUEVOS CAMPEROS DEL PÁRAMO — Descripción | Cantidad | Precio | Dcto | Importe | IVA, agrupado por "ALBARAN 12873". "DOCENAS L GRANEL 60,0" son 60 DOCENAS: cantidad_col 60 y unidad_col "docenas". No trae lote.
· EPICURE (café) — CÓDIGO | DESCRIPCIÓN | CANT. | PRECIO | TOTAL, agrupado por nº de albarán y fecha. La cantidad son unidades (cápsulas, sobres). No trae lote.
· PHARMADUS (tés) — el producto va en un renglón y DEBAJO "P-GR-26-086 | 16/06/2026 | Fin de 2028 | 1 Unidad(es)". Ese primer código de la línea de abajo es el LOTE, y "1 Unidad(es)" la cantidad.
· MERCADONA — Descripción | Unid. | P.Unitario | B.Imp. | IVA | Cuota IVA | Importe. "precio" es P.Unitario y "importe" es B.Imp. (el Importe del final lleva IVA). Fuera PARKING y BOLSA PLASTICO. No trae lote.
· TOP CASH — ART | CANT | DESCRIPCIÓN | %IVA | Precio | Precio con IVA | Importe. OJO: la CANTIDAD va ANTES de la descripción, y hay dos precios: coge el primero (sin IVA), que es el que da el importe.
· SUPERCASH — IVA | PREC+IVA | DESCRIPCION DEL ARTICULO | CANTID. | T | CONTE | UNIDADES | PRECIO | IMPORTE. La cantidad buena es UNIDADES y el precio bueno es PRECIO (el que está pegado a IMPORTE), nunca PREC+IVA.
· NISTALDIS (bebidas) — CÓDIGO EAN | ART. | DESCRIPCIÓN | CANTIDAD | PRECIO | BASE | DTO. | IMPORTE, agrupado por "Alb. Nº E1785913395272 de 05-08-2026". Los renglones "Dto.(%)", "Dto.Euros/Caja" y "NETO" que van debajo de un producto NO son productos.
· CERLESA / CERVECERA LEONESA (bebidas y limpieza) — Código | Descripción | Cantidad | P.V.P. | DTO. | IMPORTE | T.IVA | T.ART. El proveedor es "CERLESA" aunque el membrete diga "CERVECERA LEONESA SL".
  NO son productos y hay que saltárselos por completo: los avisos en texto libre del proveedor ("CERRADO POR LAS TARDES" y parecidos), el renglón "REF.ALBARAN: 4.682.049" (ese número va en "albaran" de las líneas que vienen debajo) y todo lo del Punto Verde ("Desglose tasa S.I.G(Seguimiento Integral de Gestion - Punto Verde)", "SIG TOTAL S.I.G."). Tampoco los pegues dentro de la descripción del producto de al lado.
  La columna Cantidad son CAJAS o lotes completos, y la descripción dice el formato: "5L Caja de 3" son 15 litros por caja, "1KG-12" son 12 kg, "1L-15" son 15 litros.
· VINOR (vinos) — REFERENCIA | DESCRIPCION | CAJAS | UNIDADES | PRECIO | DTO. | IMPORTE. La cantidad buena es UNIDADES (botellas); CAJAS -> bultos con letra "C".
· MÁS QUE BIO / PISTACYL — Descripción | Unidades | Precio | Importe. El tamaño del envase está en la descripción ("ARROZ ROJO 500G", "BOLSA PISTACHO (2,5 KG)").
· CHOCOLATE PUCHERO — PRODUCTO | VARIATION | PRECIO | CANTIDAD | % IVA | TOTAL. OJO: aquí el PRECIO va ANTES que la CANTIDAD.
· COMERCIAL LUNA (limpieza) — Referencia | Artículo | Cantidad | Precio | Dto | Importe | %IVA, agrupado por "Albarán ... Fecha ...".
Si el proveedor no es ninguno de estos, aplica las reglas generales.${catalogoTxt}`;
}

// ------------------------------------------------------------------- handler
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Falta configurar ANTHROPIC_API_KEY en Netlify' }) };

  let imagen, media_type, materias;
  try {
    const body = JSON.parse(event.body);
    imagen = body.imagen;
    media_type = body.media_type || 'image/jpeg';
    materias = body.materias || [];
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Datos inválidos' }) };
  }
  if (!imagen) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta la imagen' }) };

  const cat = await cargarCatalogo(materias);
  const porNombre = {};
  cat.forEach(m => { porNombre[norm(m.nombre)] = m; });

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 8000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type, data: imagen } },
            { type: 'text', text: construirPrompt(cat) }
          ]
        }]
      })
    });

    const data = await resp.json();
    if (data.error) return { statusCode: 500, headers, body: JSON.stringify({ error: data.error.message || 'Error de la IA' }) };

    let texto = (data.content || []).map(b => b.text || '').join('').trim();
    texto = texto.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(texto); }
    catch (e) {
      const a = texto.indexOf('{'), b = texto.lastIndexOf('}');
      try { parsed = JSON.parse(texto.slice(a, b + 1)); }
      catch (e2) { return { statusCode: 200, headers, body: JSON.stringify({ error: 'La IA no devolvió un formato válido', crudo: texto.slice(0, 1500) }) }; }
    }

    const brutas = Array.isArray(parsed.lineas) ? parsed.lineas
                 : Array.isArray(parsed.productos) ? parsed.productos : [];
    const prov = normProveedor(parsed.proveedor || '');
    const productos = brutas.map(l => resolver(l, cat, porNombre, prov));

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        proveedor: prov,
        documento: parsed.documento || '',
        fecha: parsed.fecha || '',
        productos,
        resumen: {
          lineas: productos.length,
          sin_lote: productos.filter(p => !p.lote).length,
          sin_cantidad: productos.filter(p => p.cantidad == null).length
        }
      })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Error al contactar con la IA: ' + e.message }) };
  }
};
