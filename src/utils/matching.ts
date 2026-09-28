import type { ArchiveRecord, FieldKey, MatchCandidate } from '../types';

const normalize = (value: string) => value.toLowerCase().replace(/[\s·,，。:：;；()（）\-_/]/g, '');
const chars = (value: string) => {
  const text = normalize(value);
  if (text.length < 2) return [text];
  return Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2));
};
const dice = (left: string, right: string) => {
  const a = chars(left);
  const b = chars(right);
  if (!a.length || !b.length) return 0;
  const remaining = [...b];
  let hits = 0;
  a.forEach((item) => {
    const index = remaining.indexOf(item);
    if (index >= 0) { hits += 1; remaining.splice(index, 1); }
  });
  return (2 * hits) / (a.length + b.length);
};
const jaccard = (left: string[], right: string[]) => {
  const a = new Set(left.map(normalize));
  const b = new Set(right.map(normalize));
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  a.forEach((item) => { if (b.has(item)) intersection += 1; });
  return intersection / (a.size + b.size - intersection);
};
const exactish = (left: string, right: string) => {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) + 0.15;
  return dice(a, b);
};
const displayValue = (record: ArchiveRecord, field: FieldKey) => {
  const value = record[field];
  return Array.isArray(value) ? value.join('、') : String(value);
};

export function scorePair(left: ArchiveRecord, right: ArchiveRecord) {
  const fieldScores: Record<FieldKey, number> = {
    title: exactish(left.title, right.title),
    date: exactish(left.date, right.date),
    people: jaccard(left.people, right.people),
    places: jaccard(left.places, right.places),
    identifier: exactish(left.identifier, right.identifier),
    medium: exactish(left.medium, right.medium),
    extent: exactish(left.extent, right.extent),
    rights: exactish(left.rights, right.rights),
    notes: exactish(left.notes, right.notes)
  };
  const score = fieldScores.title * .3 + fieldScores.date * .2 + fieldScores.people * .2 + fieldScores.places * .14 + fieldScores.identifier * .16;
  const reasons: string[] = [];
  if (fieldScores.identifier > .8) reasons.push('编号高度一致');
  if (fieldScores.title > .58) reasons.push('标题相似');
  if (fieldScores.date > .9) reasons.push('日期一致');
  if (fieldScores.people > .8) reasons.push('人物一致');
  if (fieldScores.places > .6) reasons.push('地点相近');
  if (!reasons.length) reasons.push('组合字段达到匹配阈值');
  return { score: Math.min(1, score), fieldScores, reasons };
}

export function computeMatches(records: ArchiveRecord[]): MatchCandidate[] {
  // 已合并记录已被合并结果取代，不再参与新候选，否则会产生幻影配对
  const active = records.filter((record) => record.status !== 'merged');
  const left = active.filter((record) => record.group === 'A');
  const right = active.filter((record) => record.group === 'B');
  const matches: MatchCandidate[] = [];
  left.forEach((a) => {
    const candidates = right.map((b) => ({ record: b, ...scorePair(a, b) }))
      .filter((item) => item.score >= .38)
      .sort((x, y) => y.score - x.score)
      .slice(0, 4);
    candidates.forEach((candidate) => {
      matches.push({
        id: `match-${a.id}-${candidate.record.id}`,
        leftId: a.id,
        rightId: candidate.record.id,
        score: candidate.score,
        fieldScores: candidate.fieldScores,
        status: 'suggested',
        reasons: candidate.reasons
      });
    });
  });
  return matches.sort((a, b) => b.score - a.score);
}

export interface RematchResult {
  matches: MatchCandidate[];
  /** 新候选里沿用了旧决定（确认/忽略/复核时间）的配对数 */
  retained: number;
  /** 因新记录挤出候选窗口、但已复核过而强制保留的旧配对数 */
  displaced: number;
  /** 全新组合、等待复核的配对数 */
  added: number;
}

/**
 * 导入后重新匹配：配对 id 由两侧记录 id 决定，同一组合的确认、忽略
 * 状态和 reviewedAt 一律沿用；只有新组合以 suggested 进入待复核队列。
 */
export function rematchMatches(records: ArchiveRecord[], previous: MatchCandidate[]): RematchResult {
  const previousById = new Map(previous.map((match) => [match.id, match]));
  const matches: MatchCandidate[] = [];
  let retained = 0;
  let added = 0;
  computeMatches(records).forEach((candidate) => {
    const old = previousById.get(candidate.id);
    if (old) {
      previousById.delete(candidate.id);
      retained += 1;
      // 分数与依据随数据重算，但人工决定和复核时间原样保留
      matches.push({ ...candidate, status: old.status, reviewedAt: old.reviewedAt });
    } else {
      added += 1;
      matches.push(candidate);
    }
  });
  // 旧配对没进新的 top4 候选窗口：只要人工处理过就保留，审计可继续追溯
  const displacedList = [...previousById.values()].filter((match) => match.status !== 'suggested' || Boolean(match.reviewedAt));
  return {
    matches: matches.concat(displacedList).sort((a, b) => b.score - a.score),
    retained,
    displaced: displacedList.length,
    added
  };
}

export function fieldValue(record: ArchiveRecord, field: FieldKey): string {
  return displayValue(record, field);
}
