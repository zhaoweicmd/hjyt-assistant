import assert from 'node:assert/strict'
import { compileParams, compileOutput, defineRawTool, assertRawSchema } from '../lib/schema.js'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ✓ ' + name) } catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message)) }
}

// —— 输出：TEXT_OUTPUT（作者 DSL）——
t('TEXT_OUTPUT 编译成 raw：required 提升到对象层', () => {
  const raw = compileOutput({ type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } })
  assert.deepEqual(raw, { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] })
})

t('TEXT_OUTPUT 编译产物通过宿主子集校验（0 违规）', () => {
  const raw = compileOutput({ type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } })
  assert.deepEqual(assertRawSchema(raw), [])
})

t('原来那种「作者 DSL 直接当 raw 用」会被离线校验抓出来（对应线上报错）', () => {
  const wrong = { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }
  const errs = assertRawSchema(wrong, 'schema')
  assert.ok(errs.some((x) => x.includes('schema.properties.text.required is not supported on type "string"')), '应报出线上那条错：' + JSON.stringify(errs))
})

t('对象缺 additionalProperties 被拒', () => {
  assert.throws(() => compileOutput({ type: 'object', properties: {} }), /additionalProperties/)
})

// —— 参数：属性级 required + enum + 注解 ——
t('参数：required 提升成数组，注解保留', () => {
  const raw = compileParams({
    plans: { type: 'string', required: true, description: 'plans JSON' },
    mode: { type: 'string', enum: ['idle', 'all'], description: 'idle=停场机' },
  })
  assert.deepEqual(raw, {
    type: 'object',
    properties: {
      plans: { type: 'string', description: 'plans JSON' },
      mode: { type: 'string', description: 'idle=停场机', enum: ['idle', 'all'] },
    },
    required: ['plans'],
  })
})

t('参数为空对象 → {type:object,properties:{}}', () => {
  assert.deepEqual(compileParams({}), { type: 'object', properties: {} })
  assert.deepEqual(compileParams(undefined), { type: 'object', properties: {} })
})

t('参数编译产物通过宿主子集校验', () => {
  const raw = compileParams({
    acId: { type: 'string', required: true, description: '飞机 id' },
    count: { type: 'number', description: '数量' },
    force: { type: 'boolean' },
  })
  assert.deepEqual(assertRawSchema(raw, 'parameters'), [])
})

t('未声明的键被拒（拼错 type/requird 会立刻炸）', () => {
  assert.throws(() => compileParams({ a: { type: 'string', requird: true } }), /不是合法的 schema 键/)
  assert.throws(() => compileParams({ a: { type: 'stroing' } }), /非法类型/)
})

// —— defineRawTool：等价于宿主 defineTool 的产物形状 ——
t('defineRawTool 产出 register 可用的定义', () => {
  const tool = defineRawTool({
    name: 'hjyt_demo',
    description: 'demo',
    parameters: { acId: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: () => [] },
    execute: async (a) => ({ text: 'ok:' + a.acId }),
  })
  assert.equal(tool.name, 'hjyt_demo')
  assert.deepEqual(tool.parameters, { type: 'object', properties: { acId: { type: 'string' } }, required: ['acId'] })
  assert.deepEqual(assertRawSchema(tool.output.schema), [])
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(typeof tool.execute, 'function')
})

t('defineRawTool：args 为 undefined 时兜成 {}', async () => {
  const tool = defineRawTool({
    name: 'x', description: 'x', parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: () => [] },
    execute: async (a) => ({ text: typeof a }),
  })
  assert.deepEqual(await tool.execute(undefined, {}), { text: 'object' })
})

t('缺 output.render 直接报错', () => {
  assert.throws(() => defineRawTool({ name: 'y', parameters: {}, output: {}, execute: async () => ({}) }), /output\.render/)
})

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) process.exit(1)
