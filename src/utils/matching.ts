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

/** 返回两个配对共有的记录 id；不相交或同一配对时返回 undefined */
export function sharedRecordId(match: MatchCandidate, other: MatchCandidate): string | undefined {
  if (match.id === other.id) return undefined;
  if (other.leftId === match.leftId || other.leftId === match.rightId) return other.leftId;
  if (other.rightId === match.leftId || other.rightId === match.rightId) return other.rightId;
  return undefined;
}

/**
 * 查找占用目标配对任一条记录的已确认 / 已合并配对。
 * 互斥规则：同一条记录不能同时进入两个已确认结果。
 */
export function findConfirmedBlocker(matches: MatchCandidate[], target: MatchCandidate): MatchCandidate | undefined {
  return matches.find((other) =>
    other.id !== target.id
    && (other.status === 'confirmed' || other.status === 'merged')
    && Boolean(sharedRecordId(target, other))
  );
}

export function computeMatches(records: ArchiveRecord[], previous: MatchCandidate[] = []): MatchCandidate[] {
  // 合并产物不再参与新一轮配对；已删除记录上的历史结论直接丢弃。
  const live = new Map(
    records.filter((record) => record.status !== 'merged').map((record) => [record.id, record])
  );
  const carried = new Map<string, MatchCandidate>();
  previous.forEach((match) => {
    if (match.status === 'suggested') return;
    if (!live.has(match.leftId) || !live.has(match.rightId)) return;
    carried.set(`${match.leftId}|${match.rightId}`, match);
  });

  const left = records.filter((record) => record.group === 'A' && record.status !== 'merged');
  const right = records.filter((record) => record.group === 'B' && record.status !== 'merged');
  const matches: MatchCandidate[] = [];
  const emitted = new Set<string>();

  left.forEach((a) => {
    const candidates = right.map((b) => ({ record: b, ...scorePair(a, b) }))
      .filter((item) => item.score >= .38)
      .sort((x, y) => y.score - x.score)
      .slice(0, 4);
    candidates.forEach((candidate) => {
      const key = `${a.id}|${candidate.record.id}`;
      const prior = carried.get(key);
      emitted.add(key);
      matches.push({
        id: `match-${a.id}-${candidate.record.id}`,
        leftId: a.id,
        rightId: candidate.record.id,
        score: candidate.score,
        fieldScores: candidate.fieldScores,
        // 重新匹配只刷新分数与依据，原确认 / 忽略结论和复核时间原样保留。
        status: prior ? prior.status : 'suggested',
        reasons: candidate.reasons,
        reviewedAt: prior?.reviewedAt
      });
    });
  });

  // 原已复核配对若因分数变化跌出阈值，结论仍然保留，避免导出与审计里凭空消失。
  carried.forEach((prior) => {
    const key = `${prior.leftId}|${prior.rightId}`;
    if (emitted.has(key)) return;
    const a = live.get(prior.leftId);
    const b = live.get(prior.rightId);
    if (!a || !b) return;
    const scored = scorePair(a, b);
    matches.push({
      id: prior.id,
      leftId: prior.leftId,
      rightId: prior.rightId,
      score: scored.score,
      fieldScores: scored.fieldScores,
      status: prior.status,
      reasons: scored.reasons,
      reviewedAt: prior.reviewedAt
    });
  });

  return matches.sort((a, b) => b.score - a.score);
}

export function fieldValue(record: ArchiveRecord, field: FieldKey): string {
  return displayValue(record, field);
}
