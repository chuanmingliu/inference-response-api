/** Adapter support is separate from runtime acceptance: none of these pins certifies hardware. */
const modernCapabilities = {
  text: true, streaming: true, function_calling: true, structured_outputs: true,
  json_object: true, developer_role: true, assistant_phase: false,
  parallel_tool_calls: true, reasoning: false,
};
const modelDigest = 'sha256:4c871aaa1be2f0b14156553622c2fed6f62a4a0f1b9df3832cab5fac533cffcc';
const template = { path: 'config/qwen3-responses.jinja', sha256: 'eccd8793472b569dd337f824bc8a4ba13e142b3c86896bb525b2e7a2d474eadc', tokenizer_config_sha256: '253153d0738ceb4c668d2eff957714dd2bea0b56de772a9fdccd96cbf517e6a0', evidence: 'config/qwen3-template-provenance.json' };
const common = {
  api: 'chat_completions', context_length: 32768, default_max_output_tokens: 1024,
  limits: { max_event_bytes: 1024 * 1024, max_output_bytes: 4 * 1024 * 1024, max_stream_bytes: 32 * 1024 * 1024, max_tool_calls: 128 },
  capabilities: modernCapabilities,
  admission: { count_input_tokens: true },
  chat_template_kwargs: { enable_thinking: false },
  chat_template: template,
  acceptance: {
    status: 'unverified', core: 'pending', hardware: 'pending',
    note: 'Adapter fixtures do not certify parser, constrained decoding, model, or accelerator execution. Run the per-runtime acceptance gates.',
  },
};

function runtime(id, engine, device, details) {
  return { ...common, id, engine, device, ...details };
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const RUNTIME_PROFILES = deepFreeze({
  'vllm-metal': runtime('vllm-metal', 'vllm', 'metal', {
    platform: 'darwin-arm64', tokenization: { path: '../tokenize', format: 'vllm' },
    runtime: { vllm: '0.32.0+cpu', plugin: 'vllm-metal==0.32.0', mlx: '0.32.2', python: '3.12' },
    model: { name: 'mlx-community/Qwen3-0.6B-4bit', weights_digest: modelDigest, tokenizer_revision: template.tokenizer_config_sha256, chat_template_revision: template.sha256 },
    configuration: { tool_parser: 'hermes', constrained_decoder: 'xgrammar', required_environment: { VLLM_ENFORCE_STRICT_TOOL_CALLING: '1' }, tool_strict_level: 'auto', required_flags: ['--enable-auto-tool-choice', '--tool-strict-level=auto', '--tool-call-parser=hermes', '--chat-template=config/qwen3-responses.jinja'], exclude_tools_when_tool_choice_none: false },
    evidence: ['docs/native-runtime.json', 'docs/core-vllm-metal.json', 'docs/core-metal-evidence.json', 'docs/responses-implementation-spec.md'],
  }),
  'sglang-metal': runtime('sglang-metal', 'sglang', 'metal', {
    platform: 'darwin-arm64', tokenization: { path: 'tokenize', format: 'sglang' },
    runtime: { sglang: '0.5.22', commit: 'baa9befa381511cd4d56f83980951e5a45fffc6d', mlx: '0.32.2', torch: '2.13.0', python: '3.12' },
    model: { name: 'mlx-community/Qwen3-0.6B-4bit', weights_digest: modelDigest, tokenizer_revision: template.tokenizer_config_sha256, chat_template_revision: template.sha256 },
    configuration: { tool_parser: 'qwen25', constrained_decoder: 'xgrammar', function_constraints: 'service_owned_structural_tag', required_environment: { SGLANG_USE_MLX: '1' }, required_flags: ['--disable-cuda-graph', '--mlx-enable-sampling', '--tool-call-parser=qwen25', '--chat-template=config/qwen3-responses.jinja'] },
    evidence: ['docs/sglang-runtime.json', 'docs/core-sglang-metal.json', 'docs/core-metal-evidence.json', 'docs/responses-implementation-spec.md'],
  }),
  'vllm-cuda': runtime('vllm-cuda', 'vllm', 'cuda', {
    platform: 'linux', tokenization: { path: '../tokenize', format: 'vllm' },
    runtime: { vllm: '0.32.0', distribution: 'vllm==0.32.0', bundle_verification: 'pending' },
    model: { name: 'Qwen/Qwen3-0.6B', weights_revision: 'pending', tokenizer_revision: template.tokenizer_config_sha256, chat_template_revision: template.sha256 },
    configuration: { tool_parser: 'hermes', constrained_decoder: 'xgrammar', required_environment: { VLLM_ENFORCE_STRICT_TOOL_CALLING: '1' }, tool_strict_level: 'auto', required_flags: ['--enable-auto-tool-choice', '--tool-strict-level=auto', '--tool-call-parser=hermes', '--chat-template=config/qwen3-responses.jinja'], exclude_tools_when_tool_choice_none: false },
    evidence: ['docs/responses-implementation-spec.md'],
  }),
  'sglang-cuda': runtime('sglang-cuda', 'sglang', 'cuda', {
    platform: 'linux', tokenization: { path: 'tokenize', format: 'sglang' },
    runtime: { sglang: '0.5.22', commit: 'baa9befa381511cd4d56f83980951e5a45fffc6d', distribution: 'sglang[all]==0.5.22', bundle_verification: 'pending' },
    model: { name: 'Qwen/Qwen3-0.6B', weights_revision: 'pending', tokenizer_revision: template.tokenizer_config_sha256, chat_template_revision: template.sha256 },
    configuration: { tool_parser: 'qwen25', constrained_decoder: 'xgrammar', function_constraints: 'service_owned_structural_tag', required_flags: ['--tool-call-parser=qwen25', '--chat-template=config/qwen3-responses.jinja'] },
    evidence: ['docs/responses-implementation-spec.md'],
  }),
  'dmr-metal': runtime('dmr-metal', 'vllm', 'metal', {
    platform: 'darwin-arm64', distribution: 'docker-model-runner', chat_template: null,
    runtime: { vllm: '0.13.0', plugin: 'vllm-metal==0.1.0' },
    capabilities: { ...modernCapabilities, function_calling: false, structured_outputs: false, json_object: false, developer_role: false, parallel_tool_calls: false },
    admission: { count_input_tokens: false, context_validation: 'engine' },
    acceptance: { status: 'limited', core: 'unsupported', hardware: 'pending', note: 'Legacy text-only compatibility profile; it cannot satisfy the mandatory Core acceptance gate.' },
    evidence: ['compose.yaml'],
  }),
});

export function getRuntimeProfile(name = 'dmr-metal') {
  const profile = RUNTIME_PROFILES[name];
  if (!profile) throw new Error(`Unknown Responses runtime profile: ${name}`);
  return profile;
}
