import {
  $, component$, useComputed$, useSignal, useStore, useVisibleTask$
} from '@builder.io/qwik';
import { Checkbox, Modal, Tabs } from '@qwik-ui/headless';
import type { ArchiveRecord, ArchiveState, FieldKey, MatchCandidate, RecordGroup } from './types';
import { fieldValue, rematchMatches } from './utils/matching';
import { seedState } from './data/seed';

const STORAGE_KEY = 'sologsb-1020-archive-state-v1';
const fieldLabels: Array<[FieldKey, string]> = [
  ['title', '标题'], ['date', '日期'], ['people', '人物'], ['places', '地点'], ['identifier', '编号'],
  ['medium', '载体'], ['extent', '数量'], ['rights', '权利'], ['notes', '备注']
];

const parseDate = (value: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
  if (/^\d{4}$/.test(value)) return `${value}年`;
  return value || '未知';
};

const recordById = (state: ArchiveState, id: string) => state.records.find((record) => record.id === id);
const matchLabel = (state: ArchiveState, match: MatchCandidate) => {
  const left = recordById(state, match.leftId);
  const right = recordById(state, match.rightId);
  return `${left?.title ?? '未知记录'} ↔ ${right?.title ?? '未知记录'}`;
};

// 已确认或已合并的配对占用其两侧记录，互斥锁不允许同一记录再进另一套结果
const lockedStatus = (status: MatchCandidate['status']) => status === 'confirmed' || status === 'merged';
const sharesRecord = (a: MatchCandidate, b: MatchCandidate) =>
  a.id !== b.id && (a.leftId === b.leftId || a.leftId === b.rightId || a.rightId === b.leftId || a.rightId === b.rightId);
const lockedMatches = (state: ArchiveState) => state.matches.filter((match) => lockedStatus(match.status));
const blockersOf = (state: ArchiveState, target: MatchCandidate) =>
  lockedMatches(state).filter((lock) => sharesRecord(lock, target));
const sharedRecordId = (a: MatchCandidate, b: MatchCandidate) =>
  [a.leftId, a.rightId].find((id) => id === b.leftId || id === b.rightId)!;
const statusText = (status: MatchCandidate['status']) =>
  status === 'suggested' ? '待复核' : status === 'confirmed' ? '已确认' : status === 'rejected' ? '已忽略' : '已合并';

const conflictNotice = (state: ArchiveState, target: MatchCandidate, blockers: MatchCandidate[]) => {
  const blocker = blockers[0];
  const shared = recordById(state, sharedRecordId(target, blocker));
  return `与${statusText(blocker.status)}配对「${matchLabel(state, blocker)}」冲突：共同记录「${shared?.title ?? sharedRecordId(target, blocker)}」已归入该结果，需先忽略原配对`;
};

export default component$(() => {
  const state = useStore<ArchiveState>(seedState());
  const history = useSignal<string[]>([]);
  const future = useSignal<string[]>([]);
  const query = useSignal('');
  const groupFilter = useSignal<'all' | RecordGroup>('all');
  const statusFilter = useSignal<'all' | 'suggested' | 'confirmed' | 'rejected'>('all');
  const visibleCount = useSignal(80);
  const selectedMatchIds = useSignal<string[]>([]);
  const importOpen = useSignal(false);
  const mergeOpen = useSignal(false);
  const importGroup = useSignal<RecordGroup>('A');
  const importRaw = useSignal('');
  const importText = useSignal('');
  const toast = useSignal('');
  const panelTab = useSignal(0);

  const snapshot = () => JSON.stringify({
    revision: state.revision,
    records: state.records,
    matches: state.matches,
    merges: state.merges,
    audit: state.audit
  });

  const capture = () => {
    history.value = [...history.value.slice(-49), snapshot()];
    future.value = [];
  };

  const restore = (raw: string) => {
    const next = JSON.parse(raw) as Partial<ArchiveState>;
    state.revision = next.revision ?? state.revision;
    state.records = next.records ?? state.records;
    state.matches = next.matches ?? state.matches;
    state.merges = next.merges ?? state.merges;
    state.audit = next.audit ?? state.audit;
  };

  const notify = (message: string) => {
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 2800);
  };

  const commit = (action: string, detail: string, recordIds: string[] = []) => {
    state.revision += 1;
    state.audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), action, detail, recordIds });
    state.audit = state.audit.slice(0, 300);
  };

  const undo = $(() => {
    const raw = history.value.at(-1);
    if (!raw) return;
    future.value = [...future.value, snapshot()];
    history.value = history.value.slice(0, -1);
    restore(raw);
  });

  const redo = $(() => {
    const raw = future.value.at(-1);
    if (!raw) return;
    history.value = [...history.value, snapshot()];
    future.value = future.value.slice(0, -1);
    restore(raw);
  });

  const filteredRecords = useComputed$(() => {
    const term = query.value.trim().toLowerCase();
    return state.records
      .filter((record) => groupFilter.value === 'all' || record.group === groupFilter.value)
      .filter((record) => !term || [record.title, record.date, record.identifier, ...record.people, ...record.places].join(' ').toLowerCase().includes(term))
      .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title, 'zh-CN'))
      .slice(0, visibleCount.value);
  });

  const filteredMatches = useComputed$(() => state.matches
    .filter((match) => statusFilter.value === 'all' || match.status === statusFilter.value)
    .sort((a, b) => b.score - a.score));

  // 冲突图：已锁定配对 -> 与它共用记录的待复核配对；待复核配对 -> 拦截它的锁定配对
  const conflictGraph = useComputed$(() => {
    const locking = new Map<string, MatchCandidate[]>();
    const blockedBy = new Map<string, MatchCandidate[]>();
    const locked = state.matches.filter((match) => lockedStatus(match.status));
    const suggested = state.matches.filter((match) => match.status === 'suggested');
    suggested.forEach((candidate) => {
      const blockers = locked.filter((lock) => sharesRecord(lock, candidate));
      if (blockers.length) {
        blockedBy.set(candidate.id, blockers);
        blockers.forEach((lock) => {
          locking.set(lock.id, [...(locking.get(lock.id) ?? []), candidate]);
        });
      }
    });
    return { locking, blockedBy };
  });

  // 被互斥拦住的待复核配对总数，随确认/忽略实时增减
  const blockedCount = useComputed$(() => conflictGraph.value.blockedBy.size);

  // 队列排序：每条锁定配对后面紧跟与它冲突的待复核配对，共同记录与分数连着显示
  const orderedMatches = useComputed$(() => {
    const list = filteredMatches.value;
    const attached = new Set<string>();
    const ordered: MatchCandidate[] = [];
    list.forEach((match) => {
      if (lockedStatus(match.status)) {
        ordered.push(match);
        conflictGraph.value.locking.get(match.id)?.forEach((peer) => {
          if (!attached.has(peer.id) && list.includes(peer)) {
            ordered.push(peer);
            attached.add(peer.id);
          }
        });
      }
    });
    list.forEach((match) => { if (!attached.has(match.id) && !lockedStatus(match.status)) ordered.push(match); });
    return ordered;
  });

  const visibleMatches = useComputed$(() => orderedMatches.value.slice(0, 120));
  const activeMatch = useComputed$(() => state.matches.find((match) => match.id === state.activeMatchId) ?? filteredMatches.value[0]);
  const activeBlockers = useComputed$(() => (activeMatch.value && activeMatch.value.status === 'suggested'
    ? conflictGraph.value.blockedBy.get(activeMatch.value.id) ?? []
    : []));
  const conflictCount = useComputed$(() => state.matches.filter((match) => match.status === 'suggested' && match.score < .68).length);

  // 配对不再占用记录时，若该记录没有其它已确认/已合并配对，则退回未核对
  const syncRecordStatus = (match: MatchCandidate) => {
    [match.leftId, match.rightId].forEach((recordId) => {
      const stillLocked = state.matches.some((item) =>
        item.id !== match.id && lockedStatus(item.status) && (item.leftId === recordId || item.rightId === recordId));
      if (!stillLocked) {
        const record = recordById(state, recordId);
        if (record && record.status !== 'merged') record.status = 'unreviewed';
      }
    });
  };

  const updateMatch = $((id: string, status: MatchCandidate['status']) => {
    const match = state.matches.find((item) => item.id === id);
    if (!match) return;
    // 互斥：待复核配对与已确认/已合并结果共用记录时必须先处理冲突
    if (status === 'confirmed' && match.status === 'suggested') {
      const blockers = blockersOf(state, match);
      if (blockers.length) {
        state.activeMatchId = match.id;
        statusFilter.value = 'all';
        notify(conflictNotice(state, match, blockers));
        return;
      }
    }
    capture();
    match.status = status;
    match.reviewedAt = new Date().toISOString();
    if (status === 'confirmed') {
      [match.leftId, match.rightId].forEach((recordId) => {
        const record = recordById(state, recordId);
        if (record && record.status !== 'merged') record.status = 'confirmed';
      });
    } else if (status === 'rejected') {
      syncRecordStatus(match);
    }
    commit(status === 'confirmed' ? '确认匹配' : '忽略可疑匹配', matchLabel(state, match), [match.leftId, match.rightId]);
    notify(status === 'confirmed' ? '已确认此项匹配' : '已忽略此项匹配');
  });

  const bulkMatch = $((status: MatchCandidate['status']) => {
    const ids = selectedMatchIds.value;
    if (!ids.length) return;
    // 确认操作逐条做互斥检查：包括同批内先确认的配对，后面共用记录的也要拦下
    const blocked: Array<{ match: MatchCandidate; blockers: MatchCandidate[] }> = [];
    const newlyLockedIds = new Set<string>();
    const dynamicLocks = (match: MatchCandidate) => state.matches
      .filter((item) => item.id !== match.id && (lockedStatus(item.status) || newlyLockedIds.has(item.id)))
      .filter((lock) => sharesRecord(lock, match));
    if (status === 'confirmed') {
      ids.forEach((id) => {
        const match = state.matches.find((item) => item.id === id && item.status === 'suggested');
        if (!match) return;
        const blockers = dynamicLocks(match);
        if (blockers.length) blocked.push({ match, blockers });
        else newlyLockedIds.add(match.id);
      });
    }
    const allowed = ids.filter((id) => !blocked.some((item) => item.match.id === id));
    if (!allowed.length) {
      const first = blocked[0];
      notify(conflictNotice(state, first.match, first.blockers));
      return;
    }
    capture();
    const reviewedAt = new Date().toISOString();
    const recordIds: string[] = [];
    allowed.forEach((id) => {
      const match = state.matches.find((item) => item.id === id);
      if (!match) return;
      match.status = status;
      match.reviewedAt = reviewedAt;
      recordIds.push(match.leftId, match.rightId);
      if (status === 'confirmed') {
        [match.leftId, match.rightId].forEach((recordId) => {
          const record = recordById(state, recordId);
          if (record && record.status !== 'merged') record.status = 'confirmed';
        });
      } else {
        syncRecordStatus(match);
      }
    });
    commit('批量复核', `${allowed.length} 条匹配被标记为${status === 'confirmed' ? '确认' : '忽略'}${blocked.length ? `，${blocked.length} 条因互斥冲突被拦下` : ''}`, [...new Set(recordIds)]);
    selectedMatchIds.value = [];
    notify(blocked.length
      ? `已处理 ${allowed.length} 条，${blocked.length} 条与已确认配对冲突被拦下`
      : `已批量处理 ${allowed.length} 条匹配`);
  });

  const openMerge = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    if (match.status === 'suggested') {
      const blockers = blockersOf(state, match);
      if (blockers.length) {
        notify(conflictNotice(state, match, blockers));
        return;
      }
    }
    state.activeMatchId = match.id;
    fieldLabels.forEach(([field]) => {
      const left = recordById(state, match.leftId);
      const right = recordById(state, match.rightId);
      if (left && right && fieldValue(left, field) === fieldValue(right, field)) choices[field] = 'A';
      else choices[field] = 'A';
    });
    mergeOpen.value = true;
  });

  const choices = useStore<Record<FieldKey, RecordGroup | 'combine'>>({
    title: 'A', date: 'A', people: 'A', places: 'A', identifier: 'A', medium: 'A', extent: 'A', rights: 'A', notes: 'A'
  });

  const mergeCurrent = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    const left = recordById(state, match.leftId);
    const right = recordById(state, match.rightId);
    if (!left || !right) return;
    capture();
    const values: Partial<Record<FieldKey, string>> = {};
    fieldLabels.forEach(([field]) => {
      const source = choices[field];
      const pick = source === 'combine' ? `${fieldValue(left, field)}；${fieldValue(right, field)}` : fieldValue(source === 'A' ? left : right, field);
      values[field] = pick;
    });
    const merged: ArchiveRecord = {
      ...left,
      ...values,
      people: values.people?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.people,
      places: values.places?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.places,
      status: 'merged',
      updatedAt: new Date().toISOString()
    };
    state.records = [...state.records.filter((record) => record.id !== left.id && record.id !== right.id), merged];
    const reviewedAt = new Date().toISOString();
    state.matches.forEach((item) => {
      if (item.id === match.id) {
        item.status = 'merged';
        item.reviewedAt = reviewedAt;
      } else if (sharesRecord(item, match) && item.status === 'suggested') {
        // 记录已被合并取代，共用记录的待复核配对自动关闭，已确认/已忽略的人工决定保留
        item.status = 'rejected';
        item.reviewedAt = reviewedAt;
      }
    });
    state.merges.unshift({
      id: crypto.randomUUID(),
      matchId: match.id,
      leftId: left.id,
      rightId: right.id,
      chosen: { ...choices },
      values,
      mergedAt: new Date().toISOString()
    });
    commit('合并两条记录', `保留 ${Object.values(choices).filter((choice) => choice === 'A').length} 个 A 来源字段、${Object.values(choices).filter((choice) => choice === 'B').length} 个 B 来源字段`, [left.id, right.id, merged.id]);
    mergeOpen.value = false;
    notify('记录已合并，来源与字段选择已写入审计记录');
  });

  const parseImport = $(() => {
    const raw = importRaw.value.trim();
    if (!raw) return;
    let rows: Array<Partial<ArchiveRecord>> = [];
    try {
      if (raw.startsWith('[')) rows = JSON.parse(raw) as Array<Partial<ArchiveRecord>>;
      else {
        const lines = raw.split(/\r?\n/).filter(Boolean);
        rows = lines.map((line, index) => {
          const cells = line.split(/\t|\|/).map((cell) => cell.trim());
          return {
            title: cells[0] || `未命名记录 ${index + 1}`,
            date: cells[1] || '',
            people: (cells[2] || '').split(/[，,、]/).filter(Boolean),
            places: (cells[3] || '').split(/[，,、]/).filter(Boolean),
            identifier: cells[4] || '',
            medium: cells[5] || '',
            extent: cells[6] || '',
            rights: cells[7] || '',
            notes: cells[8] || ''
          };
        });
      }
    } catch {
      notify('导入内容格式不正确，请使用 JSON 数组或制表符分隔文本');
      return;
    }
    if (!rows.length) return;
    capture();
    rows.forEach((row) => {
      const record: ArchiveRecord = {
        id: crypto.randomUUID(),
        group: importGroup.value,
        title: row.title || '未命名记录',
        date: row.date || '',
        people: Array.isArray(row.people) ? row.people : String(row.people || '').split(/[，,、]/).filter(Boolean),
        places: Array.isArray(row.places) ? row.places : String(row.places || '').split(/[，,、]/).filter(Boolean),
        identifier: row.identifier || '',
        medium: row.medium || '',
        extent: row.extent || '',
        rights: row.rights || '',
        notes: row.notes || '',
        updatedAt: new Date().toISOString(),
        status: 'unreviewed'
      };
      state.records.push(record);
    });
    // 重新匹配保留原确认、忽略与复核时间，仅新组合进入待复核
    const result = rematchMatches(state.records, state.matches);
    state.matches = result.matches;
    commit(
      '导入档案记录',
      `从 ${importGroup.value} 组导入 ${rows.length} 条记录并重新匹配：${result.added} 条新组合待复核，保留 ${result.retained} 条原确认/忽略决定${result.displaced ? `，${result.displaced} 条已复核配对移出候选窗口仍保留` : ''}`,
      []
    );
    importRaw.value = '';
    importText.value = '';
    importOpen.value = false;
    notify(`已导入 ${rows.length} 条记录：${result.added} 条新配对待复核，原有决定与复核时间已保留`);
  });

  const importFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    importRaw.value = await file.text();
    importText.value = file.name;
  });

  const exportAudit = $(() => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records: state.records, matches: state.matches, merges: state.merges, audit: state.audit }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `档案元数据核对结果-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

  const moveReview = $((delta: number) => {
    const list = orderedMatches.value;
    const index = list.findIndex((match) => match.id === activeMatch.value?.id);
    const current = index < 0 ? 0 : index;
    const next = list[Math.max(0, Math.min(list.length - 1, current + delta))];
    if (next) {
      state.activeMatchId = next.id;
      document.querySelector(`[data-match-id="${next.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  useVisibleTask$(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<ArchiveState>;
        restore(JSON.stringify(saved));
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
    state.hydrated = true;
  });

  useVisibleTask$(({ track }) => {
    const payload = track(() => JSON.stringify({ revision: state.revision, records: state.records, matches: state.matches, merges: state.merges, audit: state.audit }));
    if (state.hydrated) localStorage.setItem(STORAGE_KEY, payload);
  });

  useVisibleTask$(({ cleanup }) => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') { event.preventDefault(); importOpen.value = true; return; }
      if (editing) return;
      const key = event.key.toLowerCase();
      if (key === 'j') { event.preventDefault(); moveReview(1); }
      if (key === 'k') { event.preventDefault(); moveReview(-1); }
      if (event.key === 'Enter' && activeMatch.value) { event.preventDefault(); openMerge(); }
      if (key === 'c' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'confirmed'); }
      if (key === 'r' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'rejected'); }
      if (key === '?' || (event.shiftKey && event.key === '/')) { event.preventDefault(); panelTab.value = 2; }
    };
    window.addEventListener('keydown', handler);
    cleanup(() => window.removeEventListener('keydown', handler));
  });

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-seal">档</div>
          <div><h1>档案元数据核对台</h1><p>ARCHIVE RECONCILIATION DESK</p></div>
        </div>
        <div class="top-stat"><span class="online-dot" />{state.hydrated ? `离线保存 · r${state.revision}` : '正在恢复本地工作区'}</div>
        <div class="top-actions">
          <button class="icon-button" disabled={!history.value.length} onClick$={undo}>撤销</button>
          <button class="icon-button" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="button ghost" onClick$={() => importOpen.value = true}>导入两组记录</button>
          <button class="button light" onClick$={exportAudit}>导出核对包</button>
        </div>
      </header>

      <div class="overview">
        <div><span class="eyebrow">RECONCILIATION PROJECT</span><h2>口述史与手稿元数据比对</h2><p>逐条确认可疑匹配，保留每个字段的来源选择，并留下可追溯的处理记录。</p></div>
        <div class="metrics">
          <div><strong>{state.records.filter((record) => record.group === 'A').length}</strong><span>A 组记录</span></div>
          <div><strong>{state.records.filter((record) => record.group === 'B').length}</strong><span>B 组记录</span></div>
          <div><strong>{state.matches.filter((match) => match.status === 'suggested').length}</strong><span>待复核匹配</span></div>
          <div class="danger" title="与已确认或已合并结果共用记录、确认被拦的待复核配对数"><strong>{blockedCount.value}</strong><span>互斥拦截</span></div>
          <div class="danger"><strong>{conflictCount.value}</strong><span>低分可疑项</span></div>
        </div>
      </div>

      <main class="desk-grid">
        <section class="panel match-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">01 / MATCH QUEUE</span><h3>匹配核对队列</h3></div>
            <span class="shortcut-hint">J / K 移动 · Enter 合并</span>
          </div>
          <div class="toolbar-row">
            <select class="input" value={statusFilter.value} onChange$={(event) => { statusFilter.value = (event.target as HTMLSelectElement).value as typeof statusFilter.value; }}>
              <option value="all">全部匹配</option><option value="suggested">待复核</option><option value="confirmed">已确认</option><option value="rejected">已忽略</option>
            </select>
            <button class="button small" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('confirmed')}>批量确认</button>
            <button class="button small ghost" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('rejected')}>批量忽略</button>
          </div>
          <div class="match-list">
            {visibleMatches.value.map((match) => {
              const left = recordById(state, match.leftId);
              const right = recordById(state, match.rightId);
              const isActive = () => state.activeMatchId === match.id;
              const blockers = conflictGraph.value.blockedBy.get(match.id) ?? [];
              const lockingPeers = conflictGraph.value.locking.get(match.id) ?? [];
              const isBlocked = blockers.length > 0;
              const isLocking = lockingPeers.length > 0;
              return (
                <article
                  data-match-id={match.id}
                  class={`match-card ${isActive() ? 'active' : ''} ${isBlocked ? 'blocked' : ''} ${isLocking ? 'locking' : ''}`}
                  onClick$={() => { state.activeMatchId = match.id; }}
                  tabIndex={0}
                >
                  <div class="match-topline">
                    <Checkbox.Root
                      class="qwik-check"
                      aria-label={`选择匹配 ${match.id}`}
                      initialValue={selectedMatchIds.value.includes(match.id)}
                      onClick$={(event: Event) => {
                        event.stopPropagation();
                        selectedMatchIds.value = selectedMatchIds.value.includes(match.id)
                          ? selectedMatchIds.value.filter((id) => id !== match.id)
                          : [...selectedMatchIds.value, match.id];
                      }}
                    ><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Root>
                    <span class={`score ${match.score < .68 ? 'low' : ''}`}>{Math.round(match.score * 100)}%</span>
                    <span class={`status ${match.status}`}>{statusText(match.status)}</span>
                    {isBlocked && <span class="mutex-badge">互斥拦截</span>}
                    {isLocking && <span class="mutex-badge locking">占用 {lockingPeers.length} 条</span>}
                    <span class="record-id">{left?.identifier}</span>
                  </div>
                  <div class="pair-preview">
                    <div><small>A · {left?.group}</small><strong>{left?.title ?? '记录已合并'}</strong><span>{parseDate(left?.date ?? '')} · {left?.people.join('、')}</span></div>
                    <i>↔</i>
                    <div><small>B · {right?.group}</small><strong>{right?.title ?? '记录已合并'}</strong><span>{parseDate(right?.date ?? '')} · {right?.people.join('、')}</span></div>
                  </div>
                  <div class="reason-line">{match.reasons.join(' · ')}</div>
                  {isBlocked && <div class="conflict-strip">
                    <div class="conflict-head">⛔ 与 {blockers.length} 条已锁定结果共用记录，确认被拦：先忽略原配对才能继续</div>
                    {blockers.map((blocker) => {
                      const sharedId = sharedRecordId(match, blocker);
                      const shared = recordById(state, sharedId);
                      return (
                        <div class="conflict-row" key={blocker.id} onClick$={(event: Event) => { event.stopPropagation(); state.activeMatchId = blocker.id; }}>
                          <span class="conflict-link">查看冲突方</span>
                          <strong>{matchLabel(state, blocker)}</strong>
                          <em class={`status ${blocker.status}`}>{statusText(blocker.status)} {Math.round(blocker.score * 100)}%</em>
                          <span class="conflict-shared">共同记录：{shared?.title ?? sharedId} · 本条 {Math.round(match.score * 100)}%</span>
                          <button class="button small danger" onClick$={(event: Event) => { event.stopPropagation(); updateMatch(blocker.id, 'rejected'); }}>忽略原配对</button>
                        </div>
                      );
                    })}
                  </div>}
                  {isLocking && <div class="conflict-strip locking-strip">
                    <div class="conflict-head">🔒 已锁定 {lockingPeers.length} 条共用记录的待复核配对：</div>
                    {lockingPeers.map((peer) => {
                      const sharedId = sharedRecordId(match, peer);
                      const shared = recordById(state, sharedId);
                      return (
                        <div class="conflict-row" key={peer.id} onClick$={(event: Event) => { event.stopPropagation(); state.activeMatchId = peer.id; }}>
                          <span class="conflict-link">查看被拦配对</span>
                          <strong>{matchLabel(state, peer)}</strong>
                          <em class={`score ${peer.score < .68 ? 'low' : ''}`}>{Math.round(peer.score * 100)}%</em>
                          <span class="conflict-shared">共同记录：{shared?.title ?? sharedId} · 本条 {Math.round(match.score * 100)}%</span>
                        </div>
                      );
                    })}
                  </div>}
                </article>
              );
            })}
            {!visibleMatches.value.length && <div class="empty-state">没有符合当前筛选条件的匹配。</div>}
          </div>
        </section>

        <section class="panel records-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">02 / RECORD INDEX</span><h3>档案记录索引</h3></div>
            <span class="shortcut-hint">分页渲染 · 当前 {filteredRecords.value.length} 条</span>
          </div>
          <div class="toolbar-row">
            <input class="input search" placeholder="搜索标题、日期、人物、地点或编号" value={query.value} onInput$={(event) => { query.value = (event.target as HTMLInputElement).value; visibleCount.value = 80; }} />
            <select class="input compact" value={groupFilter.value} onChange$={(event) => { groupFilter.value = (event.target as HTMLSelectElement).value as typeof groupFilter.value; visibleCount.value = 80; }}>
              <option value="all">A + B</option><option value="A">A 组</option><option value="B">B 组</option>
            </select>
          </div>
          <div class="record-table">
            <div class="table-head"><span>来源</span><span>标题</span><span>日期 / 人物 / 地点</span><span>编号</span><span>状态</span></div>
            {filteredRecords.value.map((record) => (
              <div class="table-row" key={record.id}>
                <span class={`group-badge ${record.group.toLowerCase()}`}>{record.group}</span>
                <strong>{record.title}</strong>
                <span>{parseDate(record.date)}<small>{record.people.join('、')} · {record.places.join('、')}</small></span>
                <code>{record.identifier}</code>
                <span class={`record-status ${record.status}`}>{record.status === 'unreviewed' ? '未核对' : record.status === 'confirmed' ? '已确认' : record.status === 'rejected' ? '已忽略' : '已合并'}</span>
              </div>
            ))}
          </div>
          {filteredRecords.value.length >= visibleCount.value && <button class="load-more" onClick$={() => visibleCount.value += 80}>加载下 80 条记录</button>}
        </section>

        <section class="panel review-panel">
          <Tabs.Root bind:selectedIndex={panelTab} class="review-tabs">
            <Tabs.List class="tab-list"><Tabs.Tab>复核详情</Tabs.Tab><Tabs.Tab>合并追溯</Tabs.Tab><Tabs.Tab>键盘帮助</Tabs.Tab></Tabs.List>
            <Tabs.Panel class="tab-panel">
              {activeMatch.value && (() => {
                const left = recordById(state, activeMatch.value!.leftId);
                const right = recordById(state, activeMatch.value!.rightId);
                if (!left || !right) return <div class="empty-state">该配对的原始记录已在合并中归档，字段来源请查看下方「合并追溯」。</div>;
                const blockers = activeBlockers.value;
                return <>
                  <div class="active-score"><span>{Math.round(activeMatch.value!.score * 100)}</span><div><strong>综合匹配分</strong><small>{activeMatch.value!.reasons.join(' · ')}</small></div></div>
                  {blockers.length > 0 && <div class="mutex-banner">
                    <strong>⛔ 互斥冲突：确认被拦住</strong>
                    {blockers.map((blocker) => {
                      const sharedId = sharedRecordId(activeMatch.value!, blocker);
                      const shared = recordById(state, sharedId);
                      return (
                        <div class="mutex-line" key={blocker.id}>
                          <p>共同记录「{shared?.title ?? sharedId}」已归入{statusText(blocker.status)}配对「{matchLabel(state, blocker)}」（{Math.round(blocker.score * 100)}%），本项 {Math.round(activeMatch.value!.score * 100)}%。忽略原配对后才能确认本项。</p>
                          <div class="mutex-actions">
                            <button class="button small ghost" onClick$={() => { state.activeMatchId = blocker.id; }}>查看冲突方</button>
                            <button class="button small danger" onClick$={() => updateMatch(blocker.id, 'rejected')}>忽略原配对</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>}
                  <div class="field-compare compact"><div class="field-label">字段</div><div>A 来源</div><div>B 来源</div>
                    {fieldLabels.map(([field, label]) => <><div class="field-label">{label}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(left, field) || '—'}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(right, field) || '—'}</div></>)}
                  </div>
                  <div class="action-stack">
                    <button class="button primary wide" disabled={blockers.length > 0} onClick$={openMerge} title={blockers.length > 0 ? '存在互斥冲突，先忽略原配对' : ''}>逐字段合并</button>
                    <div class="split-actions">
                      <button class="button confirm" disabled={blockers.length > 0} onClick$={() => updateMatch(activeMatch.value!.id, 'confirmed')}>{blockers.length > 0 ? '确认被互斥拦住' : '确认匹配'}</button>
                      <button class="button ghost" onClick$={() => updateMatch(activeMatch.value!.id, 'rejected')}>忽略</button>
                    </div>
                    {activeMatch.value!.reviewedAt && <div class="reviewed-at">上次复核：{new Date(activeMatch.value!.reviewedAt).toLocaleString('zh-CN')}</div>}
                  </div>
                </>;
              })()}
              {!activeMatch.value && <div class="empty-state">从左侧选择一条匹配查看字段来源。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel">
              {state.merges.length ? state.merges.map((merge) => {
                const left = recordById(state, merge.leftId);
                const right = recordById(state, merge.rightId);
                return <details class="merge-log" key={merge.id}><summary>{left?.title ?? merge.leftId} ↔ {right?.title ?? merge.rightId}</summary><p>{new Date(merge.mergedAt).toLocaleString('zh-CN')}</p><ul>{Object.entries(merge.chosen).map(([field, choice]) => <li key={field}><strong>{fieldLabels.find(([key]) => key === field)?.[1]}</strong><span>保留 {choice === 'A' ? 'A 来源' : choice === 'B' ? 'B 来源' : '双来源拼接'}：{merge.values[field as FieldKey]}</span></li>)}</ul></details>;
              }) : <div class="empty-state">还没有合并记录。完成一次字段合并后，来源选择会出现在这里。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel shortcut-panel">
              <div><kbd>J / K</kbd><span>下一条 / 上一条可疑匹配</span></div><div><kbd>Enter</kbd><span>打开逐字段合并窗口</span></div><div><kbd>C / R</kbd><span>确认 / 忽略当前匹配</span></div><div><kbd>Ctrl + Z / Y</kbd><span>撤销 / 重做</span></div><div><kbd>Ctrl + I</kbd><span>打开导入窗口</span></div><div><kbd>Ctrl/⌘ + Enter</kbd><span>在导入框中提交记录</span></div>
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </main>

      <section class="bottom-grid">
        <article class="panel audit-panel">
          <div class="panel-heading"><div><span class="eyebrow">03 / TRACE</span><h3>最新处理记录</h3></div><span>{state.audit.length} 条</span></div>
          <div class="audit-list">
            {state.audit.slice(0, 8).map((entry) => <div class="audit-entry" key={entry.id}><time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><div><strong>{entry.action}</strong><p>{entry.detail}</p></div><span>{entry.recordIds.length ? `${entry.recordIds.length} 条记录` : '系统'}</span></div>)}
          </div>
        </article>
        <article class="panel explanation-panel">
          <div class="panel-heading"><div><span class="eyebrow">METHOD</span><h3>匹配与保护规则</h3></div></div>
          <p>标题、日期、人物、地点和编号按权重综合评分。低于 68% 的候选会以红色标记，但系统不会替研究者自动决定。</p>
          <div class="rule-row"><span>1</span><p>配对互斥：记录进入已确认/已合并结果后，再确认共用它的配对会被拦住，需先忽略原配对；冲突双方在队列中相邻显示共同记录与分数。</p></div>
          <div class="rule-row"><span>2</span><p>每个字段保留 A / B 来源，可在合并窗口中单独选择或拼接。</p></div>
          <div class="rule-row"><span>3</span><p>导入后重新匹配保留原确认、忽略与复核时间，仅新组合进入待复核；撤销重做、离线保存与导出同步。</p></div>
          <div class="rule-row"><span>4</span><p>原始记录、合并结果和忽略动作都进入本地审计轨迹，记录列表分批窗口渲染。</p></div>
        </article>
      </section>

      {toast.value && <div class="toast">{toast.value}</div>}

      <Modal.Root bind:show={importOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">IMPORT</span><Modal.Title>导入一组档案记录</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">支持 JSON 数组或制表符 / 竖线分隔文本。字段顺序：标题、日期、人物、地点、编号、载体、数量、权利、备注。</Modal.Description>
          <div class="import-controls">
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'A'} onChange$={() => importGroup.value = 'A'} /><span><strong>A 组</strong><small>口述史 / 主要记录</small></span></label>
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'B'} onChange$={() => importGroup.value = 'B'} /><span><strong>B 组</strong><small>手稿 / 待合并记录</small></span></label>
            <label class="file-button">选择文件<input type="file" accept=".json,.txt,.csv,.tsv" onChange$={(event, element) => importFile(event, element)} /></label>
          </div>
          <textarea class="modal-textarea" value={importRaw.value} onInput$={(event) => importRaw.value = (event.target as HTMLTextAreaElement).value} placeholder="李秀珍口述史访谈 | 2019-04-12 | 李秀珍、周明远 | 临河县 | OH-LXZ-2019-01 | 数字录音 | 02:14:38 | 研究者授权 | ..." />
          {importText.value && <div class="file-name">已读取：{importText.value}</div>}
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" disabled={!importRaw.value.trim()} onClick$={parseImport}>导入并重新匹配</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={mergeOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel merge-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">FIELD MERGE</span><Modal.Title>逐字段选择保留来源</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          {activeMatch.value && (() => {
            const left = recordById(state, activeMatch.value!.leftId)!;
            const right = recordById(state, activeMatch.value!.rightId)!;
            return <>
              <Modal.Description class="modal-description">每个字段都显示两条记录的原始来源。选择后，生成一条新合并记录，原记录编号与选择依据仍保留在审计轨迹中。</Modal.Description>
              <div class="field-picker-head"><span>字段</span><span>A 组来源</span><span>B 组来源</span></div>
              <div class="field-picker">
                {fieldLabels.map(([field, label]) => {
                  const leftValue = fieldValue(left, field) || '—';
                  const rightValue = fieldValue(right, field) || '—';
                  const same = leftValue === rightValue;
                  return <div class={`field-picker-row ${same ? 'same' : 'conflict'}`} key={field}><div class="picker-label"><strong>{label}</strong>{same ? <small>一致</small> : <small>冲突</small>}</div><label class={`source-option ${choices[field] === 'A' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'A'} onChange$={() => choices[field] = 'A'} /><span><b>A</b>{leftValue}</span></label><label class={`source-option ${choices[field] === 'B' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'B'} onChange$={() => choices[field] = 'B'} /><span><b>B</b>{rightValue}</span></label><button class={`combine-button ${choices[field] === 'combine' ? 'selected' : ''}`} onClick$={() => choices[field] = 'combine'} title="拼接两侧内容">拼接</button></div>;
                })}
              </div>
              <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" onClick$={mergeCurrent}>生成合并记录</button></Modal.Footer>
            </>;
          })()}
        </Modal.Panel>
      </Modal.Root>
    </div>
  );
});
