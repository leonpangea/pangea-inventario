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
    ? `\n\nHay un catálogo de Pangea que puedes ver SOLO para corregir faltas de ortografía si el nombre ya coincide. PROHIBIDO cambiar un producto por otro del catálogo aunque se parezca. Si la factura dice "Frambuesa entera cong", la respuesta es "Frambuesa entera cong", JAMÁS "Frambuesa fresca". Catálogo:\n${materias.join(', ')}`
    : '';

  const prompt = `Eres un experto leyendo albaranes y facturas de proveedores de un restaurante en España. Tu única tarea es TRANSCRIBIR exactamente lo que aparece. NO inventes, NO acortes, NO sustituyas.

Devuelve SOLO un JSON, sin explicaciones ni markdown.

═══ CANTIDAD ═══
Las facturas tienen varias columnas de números, típicamente: "CAJAS"/"BULTOS", "CANTIDAD", "PRECIO", "DTO", "IMPORTE", y a veces "KG NETO".
Para el campo "cantidad":
1. Si existe "KG NETO", usa KG NETO (unidad "kg").
2. Si NO hay KG NETO, usa la columna "CANTIDAD" (nunca CAJAS/BULTOS si hay CANTIDAD).
3. Solo si no hay CANTIDAD, usa CAJAS/BULTOS.
NUNCA uses PRECIO, DTO ni IMPORTE.

═══ PESO POR BULTO (importante para Gutiérrez y similares) ═══
Muchos productos llevan el peso de cada bulto DENTRO del nombre, ej: "HARINA MASA HOJALDRE 12.5KG SFOGLIA", "MEZCLA FRUTOS ROJOS 1KG", "PATE TARTUFO 500GR".
- Si detectas un peso en el nombre, ponlo en el campo "peso_bulto" en KILOS (ej. "12.5KG" -> 12.5 ; "1KG" -> 1 ; "500GR" -> 0.5 ; "90GR" -> 0.09).
- Si NO hay peso en el nombre, pon "peso_bulto": null.
NO multipliques tú: solo devuelve la cantidad y el peso_bulto por separado. El sistema hará la multiplicación.

═══ NOMBRE (COPIA EXACTA) ═══
Transcribe la descripción COMPLETA palabra por palabra. NO la acortes, NO quites "cong", "congelada", "entera", "Arotz". NO asumas otro producto. Ej: "FRAMBUESA ENTERA CONG AROTZ" es congelada, NUNCA "frambuesa fresca".

═══ LOTE Y CADUCIDAD ═══
- Segunda línea bajo el nombre: "Lote: XXXX   F.Cad: dd-mm-aaaa" (con o sin puntos).
- "lote": solo el código tras "Lote:" (letras+números: 044C, AA24102711, BB1CTJ1). Completo y exacto.
- "caducidad": fecha tras "F.Cad"/"F.CAD" a YYYY-MM-DD (origen dd-mm-aaaa, ej "24-04-2029" -> "2029-04-24").

Ignora líneas no-producto: "Albarán:... Fecha:...", bases, IVA, cuotas, totales, pago, IBAN.
Coma decimal: "4,50" -> 4.5

Formato:
{
  "proveedor": "de la cabecera",
  "fecha": "YYYY-MM-DD o vacío",
  "productos": [
    {"nombre": "descripción COMPLETA", "cantidad": número, "unidad": "kg/ud/L", "peso_bulto": número_en_kg_o_null, "lote": "código", "caducidad": "YYYY-MM-DD o vacío"}
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
