// Función segura: recibe la foto de la factura, se la pasa a Claude,
// devuelve proveedor + productos + cantidades + lotes.
// La clave API vive aquí en el servidor (variable de entorno), nunca en la app.

exports.handler = async (event) => {
  // CORS para que la app pueda llamarla
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
    ? `\n\nCatálogo de materias primas de Pangea (usa EXACTAMENTE estos nombres cuando coincidan, si no, deja el nombre tal cual aparece en la factura):\n${materias.join(', ')}`
    : '';

  const prompt = `Eres un asistente que lee facturas y albaranes de un restaurante en España.
Analiza esta factura/albarán y extrae los datos en JSON. Responde SOLO con el JSON, sin explicaciones ni markdown.

Formato exacto:
{
  "proveedor": "nombre del proveedor",
  "fecha": "YYYY-MM-DD o vacío si no se ve",
  "productos": [
    {"nombre": "...", "cantidad": número, "unidad": "kg/g/L/ml/ud/cajas", "lote": "nº de lote si aparece, si no vacío", "caducidad": "YYYY-MM-DD o vacío"}
  ]
}

Reglas:
- Cantidad siempre como número (usa punto decimal). Si pone "2,5" devuelve 2.5.
- Si no ves lote o caducidad, deja "".
- Ignora líneas que no sean productos (totales, IVA, portes, descuentos).
- Si un producto no tiene unidad clara, pon "ud".${catalogoTxt}`;

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
