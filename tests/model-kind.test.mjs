import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// magpie fish.25 起会把插件声明的 kind 接进分类：
//   image → Draws、video → Films、audio → Serves=speech、embedding → Serves=embedding、
//   chat/不给 → 对话。所以 kindOf 的取值必须收敛在这五个里，且不能把
//   「能听音频但输出文本」的对话模型卷进语音分区。

const src = fs.readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')

function pick(name) {
  const i = src.indexOf('function ' + name)
  assert.ok(i > 0, '应找到 ' + name)
  const start = src.lastIndexOf('\n', i)
  let depth = 0
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(start, k + 1) }
  }
  throw new Error('未闭合：' + name)
}

const { kindOf, kindOutput } = new Function(
  pick('kindOf') + '\n' + pick('kindOutput') + '\n; return { kindOf, kindOutput }')()

const KINDS = ['chat', 'image', 'video', 'audio', 'embedding']

test('kind 取值只落在宿主认识的五个类别里', () => {
  const rows = [
    { model_name: 'gpt-6.1-sol', enable_groups: ['[低价] GPT Pro'], supported_endpoint_types: ['openai'] },
    { model_name: 'gemini-3-pro-image', enable_groups: ['[生图] Gemini'], supported_endpoint_types: ['image-generation'] },
    { model_name: 'sd2.5', enable_groups: ['[生图] SD'], supported_endpoint_types: ['image-generation'] },
    { model_name: 'omni-flash', enable_groups: ['[视频] Omni'], supported_endpoint_types: ['openai-video'] },
    { model_name: 'gemini-2.5-flash-preview-tts', enable_groups: ['[低价] 语音合成 TTS'], supported_endpoint_types: ['openai'] },
    { model_name: 'suno_v4', enable_groups: ['[音频] Suno'] },
    { model_name: 'gemini-embedding-2', enable_groups: ['[向量] Gemini'], supported_endpoint_types: ['embedding'] },
    { model_name: 'bge-m3', enable_groups: ['[向量] BGE'], supported_endpoint_types: ['jina-rerank'] },
  ]
  for (const row of rows) {
    const k = kindOf(row)
    assert.ok(KINDS.includes(k), row.model_name + ' 的 kind 非法：' + k)
  }
})

test('端点类型决定分类：图像 / 视频 / 语音 / 向量', () => {
  assert.equal(kindOf({ model_name: 'm', supported_endpoint_types: ['image-generation'] }), 'image')
  assert.equal(kindOf({ model_name: 'm', supported_endpoint_types: ['openai-video'] }), 'video')
  assert.equal(kindOf({ model_name: 'm', supported_endpoint_types: ['audio'] }), 'audio')
  assert.equal(kindOf({ model_name: 'm', supported_endpoint_types: ['tts'] }), 'audio')
  assert.equal(kindOf({ model_name: 'm', supported_endpoint_types: ['embedding'] }), 'embedding')
  assert.equal(kindOf({ model_name: 'm', supported_endpoint_types: ['jina-rerank'] }), 'embedding')
})

test('分组名决定分类：TTS / ASR / Suno / 语音 / 向量', () => {
  assert.equal(kindOf({ model_name: 'm', enable_groups: ['[低价] 语音合成 TTS'] }), 'audio')
  assert.equal(kindOf({ model_name: 'm', enable_groups: ['[音频] ASR 转文字'] }), 'audio')
  assert.equal(kindOf({ model_name: 'm', enable_groups: ['[音频] Suno'] }), 'audio')
  assert.equal(kindOf({ model_name: 'm', enable_groups: ['[向量] 通用'] }), 'embedding')
})

test('能听音频但输出文本的对话模型仍是 chat（不被卷进语音）', () => {
  // 这是 issue 里点名的回归点：以前 audio 正则会匹配模型名，这类模型被误判
  assert.equal(kindOf({
    model_name: 'gpt-4o-audio-preview',
    enable_groups: ['[满血] GPT Pro'],
    supported_endpoint_types: ['openai'],
    input_modalities: ['text', 'audio'],
  }), 'chat')
  assert.equal(kindOf({ model_name: 'qwen-audio-3.0', enable_groups: ['[低价] Qwen'] }), 'chat')
})

test('向量只认完整的 embedding 词，裸 embed 不再误判', () => {
  assert.equal(kindOf({ model_name: 'text-embedding-3-large' }), 'embedding')
  // "embedded" 不是向量模型
  assert.equal(kindOf({ model_name: 'embedded-agent-v2', enable_groups: ['[低价] 通用'] }), 'chat')
  assert.equal(kindOf({ model_name: 'embed-sandbox', enable_groups: ['[低价] 通用'] }), 'chat')
})

test('kind 与 capabilities.output 一致（audio ↔ audio:true、embedding ↔ embedding:true）', () => {
  assert.deepEqual(kindOutput('audio'), { audio: true, text: true })
  assert.deepEqual(kindOutput('embedding'), { embedding: true, text: true })
  assert.deepEqual(kindOutput('image'), { image: true, text: true })
  assert.deepEqual(kindOutput('video'), { video: true, text: true })
  assert.deepEqual(kindOutput('chat'), { text: true })
  // 老宿主兼容：audio / embedding 仍带 text，至少还能当对话模型看到
  assert.equal(kindOutput('audio').text, true)
  assert.equal(kindOutput('embedding').text, true)
})

test('只有非 chat 才写 kind 字段（chat 不该出现在模型条目里）', () => {
  const seg = src.slice(src.indexOf('站点自己的分类'), src.indexOf('站点自己的分类') + 300)
  assert.match(seg, /kind === 'chat' \? \{\} : \{ kind \}/, 'chat 不应写 kind')
})
