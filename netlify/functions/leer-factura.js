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

═══ PESO/VOLUMEN POR BULTO (importante para Gutiérrez y similares) ═══
Muchos productos llevan el peso O EL VOLUMEN de cada bulto DENTRO del nombre:
- Peso: "HARINA 12.5KG", "MEZCLA 1KG", "PATE 500GR", "CHILI 210GR"
- Volumen: "SIROPE DE ARCE 1L", "VINAGRE SUSHI 20L"
Rellena "peso_bulto" con el valor convertido a la unidad base:
- Si es peso (KG/GR): en KILOS (ej. "12.5KG" -> 12.5 ; "500GR" -> 0.5 ; "210GR" -> 0.21) y pon "unidad": "kg".
- Si es volumen (L/LITRO): en LITROS (ej. "1L" -> 1 ; "20L" -> 20) y pon "unidad": "L".
- Si NO hay peso ni volumen en el nombre, pon "peso_bulto": null.
NO multipliques tú: devuelve cantidad y peso_bulto por separado. El sistema multiplica.

═══ NOMBRE (COPIA EXACTA) ═══
Transcribe la descripción COMPLETA palabra por palabra. NO la acortes, NO quites "cong", "congelada", "entera", "Arotz". NO asumas otro producto. Ej: "FRAMBUESA ENTERA CONG AROTZ" es congelada, NUNCA "frambuesa fresca".

═══ LOTE Y CADUCIDAD ═══
- Segunda línea bajo el nombre: "Lote: XXXX   F.Cad: dd-mm-aaaa" (con o sin puntos). MUCHOS productos NO tienen lote: si no hay, deja "lote":"" y "caducidad":"". No te lo inventes.
- "lote": solo el código tras "Lote:" (letras+números: 044C, AA24102711, BB1CTJ1, B65042815). Completo y exacto.
- "caducidad": fecha tras "F.Cad"/"F.CAD" a YYYY-MM-DD (origen dd-mm-aaaa, ej "24-04-2029" -> "2029-04-24").

Ignora líneas no-producto: "Albarán:... Fecha:...", bases, IVA, cuotas, totales, pago, IBAN.
Coma decimal: "4,50" -> 4.5

Formato:
{
  "proveedor": "de la cabecera",
  "fecha": "YYYY-MM-DD o vacío",
  "productos": [
    {"nombre": "descripción COMPLETA", "cantidad": número, "unidad": "kg/ud/L", "peso_bulto": número_o_null, "lote": "código o vacío", "caducidad": "YYYY-MM-DD o vacío"}
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
