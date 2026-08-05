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

  const catalogoTxt = materias.length
    ? `\n\nCatálogo de Pangea SOLO como referencia ortográfica. NO cambies un producto por otro del catálogo: si la factura dice "Arándano granel", la respuesta es "Arándano granel", nunca "Arándanos congelados". Lista:\n${materias.join(', ')}`
    : '';

  const prompt = `Eres un experto leyendo albaranes y facturas de proveedores de un restaurante en España. TRANSCRIBE lo que ves. NO inventes ni sustituyas productos.

Devuelve SOLO un JSON, sin explicaciones ni markdown.

CÓMO ELEGIR LA CANTIDAD (muy importante):
Estas facturas suelen tener VARIAS columnas de números: "%", "CAJAS", "BULTOS", "CANTIDAD", "KG BRUTO", "KG NETO", "PRECIO", "DTO", "IMPORTE". Toma la cantidad REAL de mercancía así:
1. Si hay columna "KG NETO" (o "NETO"), usa ESE valor y unidad "kg".
2. Si no hay KG NETO pero hay una columna "CANTIDAD", usa esa cantidad (NO la columna CAJAS ni BULTOS).
3. Si el producto solo tiene "CAJAS"/"BULTOS"/"UDS", usa ese y unidad "ud".
NUNCA uses las columnas de PRECIO, DTO ni IMPORTE como cantidad.

NOMBRES:
- Copia la descripción/concepto tal cual (ej. "FRESA ENTERA CONG AROTZ KG", "PATE TARTUFO NERO 500GR"). NO cambies el producto por otro parecido.

LOTE Y CADUCIDAD (importante):
- Muchos productos tienen una SEGUNDA LÍNEA justo debajo del nombre con el lote y la caducidad. Puede aparecer como "LOTE:XXXX   F.CAD.:dd-mm-aaaa" o "Lote: XXXX   F.Cad: dd-mm-aaaa" (con o sin puntos, mayúsculas o minúsculas).
- En "lote" pon SOLO el código que va tras "LOTE:"/"Lote:" (ej. de "Lote: A54102412" pon "A54102412"; de "LOTE:6070" pon "6070"). Sin la palabra LOTE ni dos puntos.
- El lote puede tener letras y números mezclados (ej. "BB1CTJ1", "044C", "AA24102711", "024B08275E5"). Cópialo completo y exacto, sin cortar letras del principio ni del final.
- En "caducidad" pon la fecha que sigue a "F.CAD."/"F.Cad" convertida a YYYY-MM-DD (ej. "24-04-2029" -> "2029-04-24").

Ignora líneas que no son productos: bases, IVA, cuotas, totales, formas de pago, IBAN, líneas de "Albarán: ... Fecha: ...".
Coma decimal española: "4,50" -> 4.5

Formato:
{
  "proveedor": "de la cabecera",
  "fecha": "YYYY-MM-DD o vacío",
  "productos": [
    {"nombre": "descripción exacta", "cantidad": número o null, "unidad": "kg/ud/L/cajas", "lote": "solo el código del lote", "caducidad": "YYYY-MM-DD o vacío"}
  ]
}${catalogoTxt}`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type, data: imagen } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    const data = await resp.json();
    if (data.error) return { statusCode: 500, headers, body: JSON.stringify({ error: data.error.message || 'Error de la IA' }) };

    let texto = (data.content || []).map(b => b.text || '').join('').trim();
    texto = texto.replace(/^```json\s*/i, '').replace(/```$/,'').trim();
    let parsed;
    try { parsed = JSON.parse(texto); }
    catch (e) { return { statusCode: 200, headers, body: JSON.stringify({ error: 'La IA no devolvió un formato válido', crudo: texto }) }; }

    return { statusCode: 200, headers, body: JSON.stringify(parsed) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Error al contactar con la IA: ' + e.message }) };
  }
};
