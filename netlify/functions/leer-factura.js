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
    ? `\n\nPara AYUDARTE a normalizar, este es el catálogo de Pangea (es solo una referencia; NO fuerces los nombres a esta lista si no coinciden claramente):\n${materias.join(', ')}`
    : '';

  const prompt = `Eres un experto leyendo facturas y albaranes de proveedores de un restaurante en España. Tu trabajo es TRANSCRIBIR con precisión lo que aparece, sin inventar.

Analiza esta factura/albarán y extrae los datos en JSON. Responde SOLO con el JSON, sin explicaciones ni markdown.

REGLAS CRÍTICAS:
- Transcribe el nombre del producto EXACTAMENTE como aparece en la factura. NO inventes ni sustituyas por productos parecidos. Si pone "RELAVIT AUTODISH", escribe "RELAVIT AUTODISH", no "Lavavajillas".
- Lee la columna de CANTIDAD con mucho cuidado: suele ser un número a la izquierda del precio. Cada línea de producto tiene su cantidad. Si dudas entre cantidad y precio, la cantidad suele ser el número más pequeño y redondo.
- Si una línea no tiene cantidad clara, pon null en cantidad, pero NO te la saltes.
- Ignora SOLO las líneas que claramente no son productos: totales, subtotales, IVA, base imponible, portes, descuentos, formas de pago.
- Números con coma decimal española: "2,5" -> 2.5.

Formato exacto:
{
  "proveedor": "nombre del proveedor tal como aparece en la cabecera",
  "fecha": "YYYY-MM-DD o vacío",
  "productos": [
    {"nombre": "texto exacto de la factura", "cantidad": número o null, "unidad": "kg/g/L/ml/ud/cajas/packs", "lote": "si aparece, si no vacío", "caducidad": "YYYY-MM-DD o vacío"}
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
