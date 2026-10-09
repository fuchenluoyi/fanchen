/**
 * SSE 编解码：把上游 OpenAI 兼容的 text/event-stream 解析为对象流，
 * 并把我们自己的事件编码成 SSE 写给浏览器（ADR-002）。
 */

/**
 * 编码一条 SSE 事件。
 * @param {Record<string, unknown>} payload
 */
export function sseEncode(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 逐块解析 SSE 文本流。
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<{ data?: string; done?: boolean; malformed?: string }>}
 */
export async function* iterateSse(body) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep;
    // 事件之间以空行分隔，兼容 \n\n 与 \r\n\r\n
    while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + buffer.match(/\r?\n\r?\n/)[0].length);
      const event = parseBlock(block);
      if (event) yield event;
    }
  }
  buffer += decoder.decode();
  const tail = parseBlock(buffer);
  if (tail) yield tail;
}

/**
 * @param {string} block
 * @returns {{ data?: string; done?: boolean; malformed?: string } | null}
 */
function parseBlock(block) {
  const lines = block.split(/\r?\n/);
  /** @type {string[]} */
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join('\n');
  if (data.trim() === '[DONE]') return { done: true };
  return { data };
}

/**
 * 把 SSE 数据块解析为 JSON 对象；失败时返回 malformed 而不是抛错（契约 §5.3）。
 * @param {string} data
 */
export function parseSseData(data) {
  try {
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === 'object') return { value: parsed };
    return { malformed: data };
  } catch {
    return { malformed: data };
  }
}
