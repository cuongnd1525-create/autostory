const test = require('node:test');
const assert = require('node:assert/strict');
const { schemas } = require('../electron/services/autoStorySourceContracts');
const { transport, hookTransport, hookPrompt, validate } = require('../electron/services/autoStorySchemaBoundary');
const Vertex = require('../electron/services/vertexAiService');

function minimal(schema) {
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties).map(([k,v]) => [k,minimal(v)]));
  if (schema.type === 'array') return [];
  if (schema.enum) return schema.enum[0];
  return schema.type === 'number' ? 0 : schema.type === 'boolean' ? false : '';
}
test('all V2 schemas retain their local bounds without expanding provider decoder states', () => {
  const original = JSON.stringify(schemas);
  for (const schema of Object.values(schemas)) {
    const wire = transport(schema);
    assert(!/"(?:maxItems|minItems|additionalProperties)":/.test(JSON.stringify(wire)));
    assert.deepEqual(wire.required, schema.required);
    assert.equal(wire.type, schema.type);
    validate(minimal(schema), schema);
  }
  assert.equal(JSON.stringify(schemas), original);
  assert.deepEqual(transport(schemas.review).properties.verdict.enum, ['PASS','REVISE']);
});
test('local validation rejects oversized responses, wrong types, missing fields and extra fields', () => {
  for (const name of ['discovery','region','blueprints']) {
    const schema = schemas[name];
    const field = Object.keys(schema.properties).find(k => schema.properties[k].type === 'array');
    const value = minimal(schema);
    value[field] = Array.from({length:schema.properties[field].maxItems+1}, () => minimal(schema.properties[field].items));
    assert.throws(() => validate(value,schema), /array size/);
  }
  assert.throws(() => validate({ ...minimal(schemas.audio), accessGranted:'true' }, schemas.audio), /boolean/);
  assert.throws(() => validate({}, schemas.audio), /missing/);
  assert.throws(() => validate({ ...minimal(schemas.audio), invented:true }, schemas.audio), /unexpected/);
  const audio = minimal(schemas.audio);
  audio.audio.audioType = 'invented';
  assert.throws(() => validate(audio,schemas.audio), /enum/);
  audio.audio.audioType = 'uncertain'; audio.audio.confidence = Infinity;
  assert.throws(() => validate(audio,schemas.audio), /finite/);
});
test('hook wire schema keeps root contract while local validation still requires nested fields',()=>{
  const schema=hookTransport(schemas.audition);
  assert.deepEqual(schema.required,['accessGranted','hooks']);
  assert.equal(schema.properties.hooks.items.required,undefined);
  assert.throws(()=>validate({accessGranted:true,hooks:[{}]},schemas.audition),/missing/);
  assert(hookPrompt('Listen',schemas.audition).includes('accessGranted (boolean)'));
});
test('real Vertex request builder simplifies only opted-in V2 schemas', async () => {
  const service = new Vertex({vertexProjectId:'test-project'});
  service.assertBudgetAvailable = async () => {};
  service.getAccessToken = async () => 'test-token';
  service.validateSettings = () => {};
  service.recordUsage = async () => {};
  const previousFetch = global.fetch;
  const requests = [];
  global.fetch = async (_, options) => {
    requests.push(JSON.parse(options.body));
    return { ok:true, json:async () => ({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(minimal(schemas.discovery))}]}}]}) };
  };
  try {
    for (const sourceContract of [false,true]) {
      await service.generateJsonFromFiles({prompt:'Test',responseSchema:schemas.discovery,sourceContract,strictRootJson:true});
    }
    assert.deepEqual(requests[0].generationConfig.responseSchema, schemas.discovery);
    assert.deepEqual(requests[1].generationConfig.responseSchema, transport(schemas.discovery));
    await service.generateJsonFromFiles({prompt:'Listen',responseSchema:schemas.audition,sourceContract:true,hookSchema:true});
    assert.deepEqual(requests[2].generationConfig.responseSchema,hookTransport(schemas.audition));
    assert.equal(requests[2].contents[0].parts[0].text,hookPrompt('Listen',schemas.audition));
  } finally { global.fetch = previousFetch; await service.dispatcher.close(); }
});
