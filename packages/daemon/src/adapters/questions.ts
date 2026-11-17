import type { UserQuestion } from './types.js';

/** Codex and zcode expose native question lists, with different option value conventions. */
export function nativeQuestions(questions: any): UserQuestion[] {
  if (!Array.isArray(questions)) return [];
  return questions.filter(q => typeof q?.question === 'string').map((q, i) => ({
    id: String(q.id ?? i), question: q.question, header: q.header,
    options: (Array.isArray(q.options) ? q.options : []).filter((o: any) => typeof o?.label === 'string').map((o: any) => ({ value: String(o.value ?? o.label), label: o.label, description: o.description })),
    multiple: q.multiSelect === true, freeText: true,
  }));
}

/** Keep schema field identities intact. An optional `X_custom` string field the agent pairs with a
 * choice `X` is that choice's own free-text line for an "other" answer or a note, so it is asked on
 * the same card, still answered under its own field id — never as a second card of its own. */
export function formQuestions(schema: any, message: string): UserQuestion[] | null {
  if (schema?.type !== 'object' || !schema.properties) return null;
  const properties = Object.entries(schema.properties) as Array<[string, any]>;
  for (const [, field] of properties) if (field.type !== 'string' && field.type !== 'array' && field.type !== 'boolean') return null;
  const optionsOf = (field: any) => {
    const choices = field.type === 'array' ? field.items : field;
    const enums = choices?.oneOf ?? choices?.anyOf;
    return field.type === 'boolean' ? [{ value: 'true', label: '是' }, { value: 'false', label: '否' }]
      : Array.isArray(enums) ? enums.map((o: any) => ({ value: String(o.const), label: String(o.title ?? o.const), description: o.description }))
      : Array.isArray(choices?.enum) ? choices.enum.map((v: string) => ({ value: String(v), label: String(v) })) : [];
  };
  const required = schema.required ?? [];
  const noteIds = new Set(properties.filter(([id, field]) => id.endsWith('_custom') && field.type === 'string' && !required.includes(id)
    && properties.some(([other, otherField]) => other === id.slice(0, -'_custom'.length) && optionsOf(otherField).length > 0))
    .map(([id]) => id));
  return properties.filter(([id]) => !noteIds.has(id)).map(([id, field]) => {
    const options = optionsOf(field);
    return { id, question: field.description || field.title || message, header: field.title,
      options, multiple: field.type === 'array', freeText: field.type === 'string' && !options.length,
      required: required.includes(id), ...(noteIds.has(`${id}_custom`) ? { note: { id: `${id}_custom` } } : {}) };
  });
}
