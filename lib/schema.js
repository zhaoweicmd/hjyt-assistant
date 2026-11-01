/**
 * DSH 工具 schema 编译（作者 DSL → 宿主认的 raw JSON Schema）
 *
 * 背景（2026-10-21 事故，32 个 hjyt_* 工具全部注册失败）：
 *   宿主 `ToolRuntime.register()` 只接受**已编译的 raw JSON Schema** 作为
 *   `output.schema`（`assertSupportedJsonSchema`），而 `parameters` 也必须是
 *   raw JSON Schema（`{type:'object', properties, required?}`）——
 *   这一步原本由宿主的 `defineTool()` 完成。插件早先用
 *   `await import('@deepseek-ai/dsh-tools')` 拿宿主 defineTool，加载不到就静默
 *   退化成恒等函数，于是作者 DSL（属性级 `required: true`）原样进了 register，
 *   被逐条拒成 `schema.properties.text.required is not supported on type "string"`。
 *
 * 现在不依赖宿主模块，本文件按宿主 `dsh-tools` 的 `lib/types/schema.js`
 * 同一套规则自己编译（只覆盖本插件实际用到的子集：标量 / enum / array / object，
 * 属性级 `required: true` 提升为对象级 `required: [...]` 数组）。
 *
 * 规则要点（与宿主一致）：
 *   - 注解键：description / title / default / examples
 *   - 属性级 `required: true`（布尔）→ 对象级 `required: ['a','b']`
 *   - object 必须显式声明布尔 `additionalProperties`
 *   - 编译产物只允许 type / properties / required / additionalProperties / items / enum / const
 */

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']
const SCALARS = ['string', 'number', 'integer', 'boolean', 'null']

function copyAnnotations(src, dst) {
  for (const k of ANNOTATION_KEYS) if (Object.hasOwn(src, k)) dst[k] = src[k]
}

function bad(path, msg) {
  throw new Error('schema ' + path + ' ' + msg)
}

function assertKeys(input, path, allowed) {
  for (const k of Object.keys(input)) {
    if (!allowed.includes(k)) bad(path + '.' + k, '不是合法的 schema 键（允许：' + allowed.join('/') + '）')
  }
}

/** 编译一个作者节点（value-spec）。hasRequired 表示该层允许写属性级 required:true */
function compileNode(input, path, allowRequired) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) bad(path, '必须是对象')
  const allowed = ANNOTATION_KEYS.concat(allowRequired ? ['required'] : [])
  const type = input.type
  if (type === undefined) {
    // 纯注解节点 = 任意 JSON
    assertKeys(input, path, ANNOTATION_KEYS)
    const node = {}
    copyAnnotations(input, node)
    return { node: node, required: input.required === true }
  }
  if (type === 'object') {
    assertKeys(input, path, allowed.concat(['type', 'properties', 'additionalProperties']))
    if (typeof input.additionalProperties !== 'boolean') bad(path + '.additionalProperties', '必须显式写 true/false')
    const node = { type: 'object' }
    copyAnnotations(input, node)
    node.additionalProperties = input.additionalProperties
    const props = input.properties
    if (props !== undefined) {
      if (props === null || typeof props !== 'object' || Array.isArray(props)) bad(path + '.properties', '必须是对象')
      const out = {}
      const req = []
      for (const [k, v] of Object.entries(props)) {
        const r = compileNode(v, path + '.properties.' + k, true)
        out[k] = r.node
        if (r.required) req.push(k)
      }
      node.properties = out
      if (req.length) node.required = req
    }
    return { node: node, required: input.required === true }
  }
  if (type === 'array') {
    assertKeys(input, path, allowed.concat(['type', 'items']))
    const node = { type: 'array' }
    copyAnnotations(input, node)
    if (Object.hasOwn(input, 'items')) node.items = compileNode(input.items, path + '.items', false).node
    return { node: node, required: input.required === true }
  }
  if (SCALARS.includes(type)) {
    assertKeys(input, path, allowed.concat(['type', 'enum', 'const']))
    const node = { type: type }
    copyAnnotations(input, node)
    if (Object.hasOwn(input, 'enum')) {
      if (!Array.isArray(input.enum) || !input.enum.length) bad(path + '.enum', '必须是非空数组')
      node.enum = Array.from(input.enum)
    }
    if (Object.hasOwn(input, 'const')) node.const = input.const
    return { node: node, required: input.required === true }
  }
  if (type === 'oneOf') {
    assertKeys(input, path, allowed.concat(['oneOf']))
    if (!Array.isArray(input.oneOf) || !input.oneOf.length) bad(path + '.oneOf', '必须是非空数组')
    const node = { oneOf: input.oneOf.map((b, i) => compileNode(b, path + '.oneOf[' + i + ']', false).node) }
    copyAnnotations(input, node)
    return { node: node, required: input.required === true }
  }
  return bad(path + '.type', '非法类型 ' + JSON.stringify(type))
}

/**
 * 工具参数：作者写的是「属性名 → 属性 schema」的映射（与宿主 defineTool 一致）
 * @returns {{type:'object', properties:object, required?:string[]}}
 */
export function compileParams(spec) {
  if (spec === undefined || spec === null) return { type: 'object', properties: {} }
  if (typeof spec !== 'object' || Array.isArray(spec)) throw new Error('schema parameters 必须是对象映射')
  const properties = {}
  const required = []
  for (const [k, v] of Object.entries(spec)) {
    const r = compileNode(v, 'parameters.' + k, true)
    properties[k] = r.node
    if (r.required) required.push(k)
  }
  const out = { type: 'object', properties: properties }
  if (required.length) out.required = required
  return out
}

/** 工具输出：作者给的 value-spec（根节点不允许属性级 required） */
export function compileOutput(spec) {
  return compileNode(spec, 'schema', false).node
}

/** 把作者 DSL 的工具定义编译成 register() 直接可用的定义（raw JSON Schema） */
export function defineRawTool(options) {
  const parameters = compileParams(options.parameters)
  const output = options.output || {}
  const render = output.render
  if (typeof render !== 'function') throw new Error('tool "' + options.name + '" 必须带 output.render')
  const tool = {
    name: options.name,
    description: options.description,
    parameters: parameters,
    output: { schema: compileOutput(output.schema), render: render },
    async execute(args, exec) {
      return options.execute(args === undefined || args === null ? {} : args, exec)
    },
  }
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs
  if (options.deferLoading === true) tool.deferLoading = true
  if (typeof options.presentResult === 'function') tool.presentResult = (args, result) => options.presentResult(args, result)
  if (typeof options.presentCall === 'function') tool.presentCall = (args) => options.presentCall(args)
  if (typeof options.finalizeContent === 'function') tool.finalizeContent = (exec, result) => options.finalizeContent(exec, result)
  if (typeof options.projectContent === 'function') tool.projectContent = (exec, result) => options.projectContent(exec, result)
  return tool
}

/**
 * 宿主 raw JSON Schema 子集的「离线校验」，用于单测/自检：
 * 返回违规列表，空数组 = 宿主会接受。
 */
export function assertRawSchema(schema, path) {
  const p = path || 'schema'
  const bads = []
  const walk = (node, at) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      bads.push(at + ' 必须是对象')
      return
    }
    const type = node.type
    const allowedFor = {
      properties: ['object'],
      required: ['object'],
      additionalProperties: ['object'],
      items: ['array'],
      enum: SCALARS,
      const: SCALARS,
    }
    const allowed = ANNOTATION_KEYS.concat(['type', 'oneOf'])
    if (type === 'object') allowed.push('properties', 'required', 'additionalProperties')
    if (type === 'array') allowed.push('items')
    if (SCALARS.includes(type)) allowed.push('enum', 'const')
    for (const k of Object.keys(node)) {
      if (!allowed.includes(k)) bads.push(at + '.' + k + ' is not supported on type "' + String(type) + '"')
      else if (allowedFor[k] && !allowedFor[k].includes(type)) bads.push(at + '.' + k + ' is not supported on type "' + String(type) + '"')
    }
    if (type === 'object') {
      // 宿主校验器只检查「键/类型是否被允许」，并不强制存在 additionalProperties
      // （宿主自家 parameterSchemaSpecToJsonSchema 产出的根对象就没有这个键），
      // 所以这里只在「写了但类型不对」时报错。
      if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') bads.push(at + '.additionalProperties must be a boolean')
      if (node.required !== undefined && (!Array.isArray(node.required) || node.required.some((x) => typeof x !== 'string'))) bads.push(at + '.required must be an array of strings')
      if (node.properties !== undefined) {
        if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) bads.push(at + '.properties must be an object')
        else for (const [k, v] of Object.entries(node.properties)) walk(v, at + '.properties.' + k)
      }
      if (Array.isArray(node.required) && node.properties) {
        for (const k of node.required) if (!Object.hasOwn(node.properties, k)) bads.push(at + '.required names unknown property ' + k)
      }
    }
    if (type === 'array' && node.items !== undefined) walk(node.items, at + '.items')
    if (Array.isArray(node.oneOf)) node.oneOf.forEach((b, i) => walk(b, at + '.oneOf[' + i + ']'))
  }
  walk(schema, p)
  return bads
}
