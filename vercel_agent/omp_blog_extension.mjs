/** OMP owns the loop; this extension exposes only the existing blog tools. */
export default async function (pi) {
  const base = process.env.OMP_BLOG_BRIDGE;
  const token = process.env.OMP_BLOG_TOKEN;
  if (!base || !token) throw new Error('OMP博客扩展需要本机桥接服务');
  const post = async (path, body, signal) => {
    const response = await fetch(base + path, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body), signal });
    if (!response.ok) throw new Error(`博客桥接HTTP ${response.status}`);
    return response.json();
  };
  const config = await post('/control', {});
  const starts = new Map();
  const forwarded = new Set();
  pi.registerProvider('blog-benchmark', {
    baseUrl: base + '/v1', api: 'openai-completions', apiKey: token,
    models: [{ id: config.model, name: config.model, reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 64000, maxTokens: config.max_output_tokens,
      compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens' } }],
  });
  const z = pi.zod;
  const schema = s => {
    let value;
    if (s.enum) value = z.enum(s.enum);
    else if (s.type === 'object') value = z.object(Object.fromEntries(Object.entries(s.properties ?? {})
      .map(([name, field]) => [name, (s.required ?? []).includes(name) ? schema(field) : schema(field).optional()])));
    else if (s.type === 'integer' || s.type === 'number') {
      value = z.number(); if (s.type === 'integer') value = value.int();
      if (s.minimum !== undefined) value = value.min(s.minimum);
      if (s.maximum !== undefined) value = value.max(s.maximum);
    } else if (s.type === 'boolean') value = z.boolean();
    else {
      value = z.string();
      if (s.minLength !== undefined) value = value.min(s.minLength);
      if (s.maxLength !== undefined) value = value.max(s.maxLength);
    }
    return s.description ? value.describe(s.description) : value;
  };
  for (const tool of config.tools) pi.registerTool({
    name: tool.name, label: tool.name, description: tool.description,
    parameters: schema(tool.parameters), loadMode: 'essential',
    approval: tool.name === 'save_obsidian_blog' ? 'write' : 'read',
    async execute(id, args, signal, _update, ctx) {
      forwarded.add(id);
      const output = await post('/tool', { name: tool.name, arguments: args, tool_call_id: id }, signal);
      if (output.error?.code === 'budget_exceeded') void ctx.abort();
      return { content: [{ type: 'text', text: JSON.stringify(output) }], details: output,
        isError: !!output.error };
    },
  });
  pi.on('session_start', () => pi.setActiveTools(config.tools.map(t => t.name)));
  pi.on('before_agent_start', () => ({ systemPrompt: config.instructions }));
  pi.on('tool_result', (event, ctx) => {
    // Same stopping rule as BlogAgent: verified save completes the business task.
    if (event.toolName === 'save_obsidian_blog' && event.details?.verified === true) void ctx.abort();
  });
  pi.on('tool_execution_start', event => starts.set(event.toolCallId, event));
  pi.on('tool_execution_end', async (event, ctx) => {
    // OMP may reject parameters before execute(); failed attempts still consume budget.
    const start = starts.get(event.toolCallId);
    starts.delete(event.toolCallId);
    if (start && !forwarded.has(event.toolCallId)) {
      const output = await post('/invalid', { name: start.toolName, arguments: start.args, tool_call_id: event.toolCallId });
      if (output.error?.code === 'budget_exceeded') void ctx.abort();
    }
    forwarded.delete(event.toolCallId);
  });
  pi.on('cache_warming_decision', () => ({ action: 'stop' }));
}
