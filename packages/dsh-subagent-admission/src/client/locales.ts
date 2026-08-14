/** Bilingual copy for the native read-only Admission Control view. */

/** Locale namespace owned by this plugin. */
export const NS = 'admissionControl'

/** Complete key domain shared by both shipped dictionaries. */
export type AdmissionControlKey =
  | 'view.label'
  | 'view.title'
  | 'snapshot.loading'
  | 'snapshot.epoch'
  | 'snapshot.revision'
  | 'snapshot.updated'
  | 'snapshot.enforced'
  | 'value.yes'
  | 'value.no'
  | 'value.none'
  | 'status.title'
  | 'status.reason'
  | 'status.strict.label'
  | 'status.strict.aria'
  | 'status.strict.summary'
  | 'status.audit.label'
  | 'status.audit.aria'
  | 'status.audit.summary'
  | 'status.unavailable.label'
  | 'status.unavailable.aria'
  | 'status.unavailable.summary'
  | 'status.draining.label'
  | 'status.draining.aria'
  | 'status.draining.summary'
  | 'quota.title'
  | 'quota.globalActive'
  | 'quota.rootActive'
  | 'quota.rootAdmittedTotal'
  | 'quota.parentChildren'
  | 'leases.title'
  | 'leases.aria'
  | 'leases.empty'
  | 'leases.pendingChild'
  | 'leases.child'
  | 'leases.parent'
  | 'leases.root'
  | 'leases.operation'
  | 'leases.mode'
  | 'leases.admittedAt'
  | 'leases.phase'
  | 'history.title'
  | 'history.aria'
  | 'history.empty'
  | 'history.droppedSuffix'
  | 'history.time'
  | 'history.event'
  | 'history.operation'
  | 'history.parent'
  | 'history.code'
  | 'operation.new-one-shot'
  | 'operation.new-continuable'
  | 'operation.cold-resume'
  | 'phase.active'
  | 'phase.draining'
  | 'event.accepted'
  | 'event.denied'
  | 'event.released'
  | 'event.failed-start'
  | 'event.protocol'
  | 'event.bootstrap'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Native read-only admission status, capacity, leases, and event history. */
    admissionControl: AdmissionControlKey
  }
}

/** English dictionary. */
export const en: Record<AdmissionControlKey, string> = {
  'view.label': 'Admission Control',
  'view.title': 'Admission Control',
  'snapshot.loading': 'Loading admission snapshot…',
  'snapshot.epoch': 'Epoch',
  'snapshot.revision': 'Revision',
  'snapshot.updated': 'Updated',
  'snapshot.enforced': 'Enforced',
  'value.yes': 'Yes',
  'value.no': 'No',
  'value.none': '—',
  'status.title': 'Policy status',
  'status.reason': 'Reason',
  'status.strict.label': 'Strict',
  'status.strict.aria': 'Strict status',
  'status.strict.summary': 'Protocol-backed admission is enforced.',
  'status.audit.label': 'Audit',
  'status.audit.aria': 'Audit status',
  'status.audit.summary': 'Observation only; limits are not enforced.',
  'status.unavailable.label': 'Unavailable',
  'status.unavailable.aria': 'Unavailable status',
  'status.unavailable.summary': 'Admission protocol is unavailable.',
  'status.draining.label': 'Draining',
  'status.draining.aria': 'Draining status',
  'status.draining.summary': 'New admission is closed while existing permits drain.',
  'quota.title': 'Capacity',
  'quota.globalActive': 'Global active',
  'quota.rootActive': 'Root active',
  'quota.rootAdmittedTotal': 'Root admitted total',
  'quota.parentChildren': 'Parent children',
  'leases.title': 'Active leases',
  'leases.aria': 'Active leases',
  'leases.empty': 'No active leases.',
  'leases.pendingChild': 'Pending child publication',
  'leases.child': 'Child',
  'leases.parent': 'Parent',
  'leases.root': 'Root',
  'leases.operation': 'Operation',
  'leases.mode': 'Mode',
  'leases.admittedAt': 'Admitted',
  'leases.phase': 'Phase',
  'history.title': 'Admission history',
  'history.aria': 'Admission history',
  'history.empty': 'No admission events recorded.',
  'history.droppedSuffix': 'older events were dropped from this bounded snapshot.',
  'history.time': 'Time',
  'history.event': 'Event',
  'history.operation': 'Operation',
  'history.parent': 'Parent',
  'history.code': 'Code',
  'operation.new-one-shot': 'New one-shot',
  'operation.new-continuable': 'New continuable',
  'operation.cold-resume': 'Cold resume',
  'phase.active': 'Active',
  'phase.draining': 'Draining',
  'event.accepted': 'Accepted',
  'event.denied': 'Denied',
  'event.released': 'Released',
  'event.failed-start': 'Failed start',
  'event.protocol': 'Protocol',
  'event.bootstrap': 'Bootstrap',
}

/** Simplified Chinese dictionary. */
export const zh: Record<AdmissionControlKey, string> = {
  'view.label': '准入控制',
  'view.title': '准入控制',
  'snapshot.loading': '正在加载准入快照…',
  'snapshot.epoch': '时代',
  'snapshot.revision': '修订',
  'snapshot.updated': '更新时间',
  'snapshot.enforced': '已强制执行',
  'value.yes': '是',
  'value.no': '否',
  'value.none': '—',
  'status.title': '策略状态',
  'status.reason': '原因',
  'status.strict.label': '严格',
  'status.strict.aria': '严格模式状态',
  'status.strict.summary': '准入协议正在强制执行限额。',
  'status.audit.label': '审计',
  'status.audit.aria': '审计模式状态',
  'status.audit.summary': '仅观察；限额不会强制执行。',
  'status.unavailable.label': '不可用',
  'status.unavailable.aria': '准入协议不可用状态',
  'status.unavailable.summary': '准入协议当前不可用。',
  'status.draining.label': '排空中',
  'status.draining.aria': '排空模式状态',
  'status.draining.summary': '新准入已关闭，现有许可正在排空。',
  'quota.title': '容量',
  'quota.globalActive': '全局活跃',
  'quota.rootActive': '根任务活跃',
  'quota.rootAdmittedTotal': '根任务累计准入',
  'quota.parentChildren': '父任务子任务',
  'leases.title': '活跃许可',
  'leases.aria': '活跃许可',
  'leases.empty': '当前没有活跃许可。',
  'leases.pendingChild': '等待发布子会话标识',
  'leases.child': '子会话',
  'leases.parent': '父会话',
  'leases.root': '根会话',
  'leases.operation': '操作',
  'leases.mode': '模式',
  'leases.admittedAt': '准入时间',
  'leases.phase': '阶段',
  'history.title': '准入历史',
  'history.aria': '准入历史',
  'history.empty': '尚未记录准入事件。',
  'history.droppedSuffix': '条较早事件已从有界快照中丢弃。',
  'history.time': '时间',
  'history.event': '事件',
  'history.operation': '操作',
  'history.parent': '父会话',
  'history.code': '代码',
  'operation.new-one-shot': '新建一次性子任务',
  'operation.new-continuable': '新建可继续子任务',
  'operation.cold-resume': '冷恢复',
  'phase.active': '活跃',
  'phase.draining': '排空中',
  'event.accepted': '已接受',
  'event.denied': '已拒绝',
  'event.released': '已释放',
  'event.failed-start': '启动失败',
  'event.protocol': '协议',
  'event.bootstrap': '启动',
}
