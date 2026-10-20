import type { Item, StoredEvent } from './timeline';

export interface VoiceTranscript {
  itemId: string;
  role: 'user' | 'assistant';
  text: string;
  final: boolean;
  at: string;
  afterSeq: number;
  order?: number;
  streaming?: boolean;
}

/** Merge speech only after task layout, so it never changes task/approval state or work folding. */
export function withVoiceItems(items: Item[], events: StoredEvent[], live: readonly VoiceTranscript[]): Item[] {
  const messages = new Map<string, VoiceTranscript>();
  for (const message of live) messages.set(message.itemId, message);
  for (const event of events) if (event.type === 'voice.message') {
    const d = event.data;
    if (typeof d.itemId !== 'string' || (d.role !== 'user' && d.role !== 'assistant') || typeof d.text !== 'string') continue;
    messages.set(d.itemId, { itemId: d.itemId, role: d.role, text: d.text, final: d.final === true,
      at: typeof d.at === 'string' ? d.at : event.ts,
      afterSeq: Number.isSafeInteger(d.afterSeq) ? d.afterSeq : event.seq - 1,
      order: Number.isSafeInteger(d.order) ? d.order : 0, streaming: false });
  }
  if (!messages.size) return items;
  const speech = [...messages.values()].filter(m => m.text).sort((a, b) =>
    a.afterSeq - b.afterSeq || a.at.localeCompare(b.at) || (a.order ?? 0) - (b.order ?? 0));
  const endings = new Map(events.filter(e => e.type === 'turn.done' || e.type === 'turn.error')
    .map(e => [e.turnId, e.seq]));
  const out: Item[] = [];
  let index = 0, position = 0;
  const append = (message: VoiceTranscript) => {
    const key = `voice:${message.itemId}`;
    out.push(message.role === 'user'
      ? { kind: 'user', key, turnId: key, text: message.text, images: [] }
      : { kind: 'assistant', key, turnId: key, text: message.text, done: !message.streaming });
  };
  for (const item of items) {
    const source = /^e(\d+)/.exec(item.key);
    position = Math.max(position, source ? Number(source[1])
      : item.kind === 'actions' || item.kind === 'changes' ? endings.get(item.turnId) ?? position : position);
    while (index < speech.length && speech[index].afterSeq < position) append(speech[index++]);
    out.push(item);
  }
  while (index < speech.length) append(speech[index++]);
  return out;
}
