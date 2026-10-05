import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 领用归还编排里，页面随动作一起带上来的登记项。
export type ActionPayload = {
  经办人?: string
  用途?: string
  入库数量?: number
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string, payload: ActionPayload = {}): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  // 耗材与领用单走专门的领用归还编排，其余模块维持通用流转。
  if (key === 'material') {
    return runMaterialAction(id, action, payload)
  }
  if (key === 'requisition') {
    return runRequisitionAction(id, action, payload)
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  // 探方开始发掘：顺着开工入口自动生成一条耗材领用待办。
  if (key === 'trench' && action === '开始发掘') {
    const code = createRequisitionTodo(updated)
    if (code) {
      return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」，已生成领用待办 ${code}` }
    }
    return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」，没有可用耗材，未生成领用待办` }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// ===== 发掘耗材领用归还编排 =====
// 耗材状态只能沿「充足 → 偏低 → 需采购 → 已停用」顺序流转：
//   - 库存数量变化（领取/退回/入库）触发自动推导，一次走一步或跟随实际水位；
//   - 人工动作只许按顺序走一步：偏低才能发起采购，需采购才能确认入库、标记停用；
//   - 「已停用」是终态，任何推导与动作都不能再改它。
// 冲突规则：人工申购单优先于最低库存（预警数量）推导——申购单未确认入库闭环前，
// 数量推导不覆盖人工登记的「需采购」；入库闭环后按最新库存重新推导。
// 历史发掘耗材没有预警数量：不参与自动推导，人工动作与库存增减照常。

function materialThreshold(row: EntryRow): number | null {
  const raw = row['预警数量']
  if (raw === undefined || raw === null || raw === '') {
    return null
  }
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function materialQuantity(row: EntryRow): number {
  const value = Number(row['当前数量'])
  return Number.isFinite(value) ? value : 0
}

// 按最低库存推导状态；没有预警数量的历史耗材返回 null，表示不推导、保持原状态。
function deriveMaterialStatus(row: EntryRow): string | null {
  const threshold = materialThreshold(row)
  if (threshold === null) {
    return null
  }
  const quantity = materialQuantity(row)
  if (quantity <= 0) {
    return '需采购'
  }
  if (quantity <= threshold) {
    return '偏低'
  }
  return '充足'
}

// 库存数量变化后刷新耗材状态：终态不动，人工申购单未闭环不动，其余跟随推导。
function refreshMaterialStatus(row: EntryRow): EntryRow {
  if (String(row.status) === '已停用') {
    return row
  }
  if (row['申购单号']) {
    return row
  }
  const derived = deriveMaterialStatus(row)
  if (derived === null || derived === row.status) {
    return row
  }
  return { ...row, status: derived, pending: true }
}

function saveMaterialRow(updated: EntryRow): void {
  const rows = listRows('material')
  const index = rows.findIndex((row) => Number(row.id) === Number(updated.id))
  if (index < 0) {
    return
  }
  const next = [...rows]
  next[index] = updated
  saveRows('material', next)
}

function findMaterialByCode(code: string): EntryRow | undefined {
  return listRows('material').find((row) => String(row['耗材编号']) === code)
}

function saveRequisitionRow(updated: EntryRow): void {
  const rows = listRows('requisition')
  const index = rows.findIndex((row) => Number(row.id) === Number(updated.id))
  if (index < 0) {
    return
  }
  const next = [...rows]
  next[index] = updated
  saveRows('requisition', next)
}

// 探方开始发掘 → 自动生成领用待办：取当前第一种未停用的发掘耗材，数量 1。
function createRequisitionTodo(trench: EntryRow): string {
  const material = listRows('material').find((row) => String(row.status) !== '已停用')
  if (!material) {
    return ''
  }
  const rows = listRows('requisition')
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const code = `REQ-${String(nextId).padStart(4, '0')}`
  const trenchCode = String(trench['探方编号'] ?? `探方${trench.id}`)
  const todo: EntryRow = {
    id: nextId,
    status: '待领用',
    pending: true,
    abnormal: false,
    领用编号: code,
    耗材编号: String(material['耗材编号'] ?? ''),
    耗材名称: String(material['耗材名称'] ?? ''),
    关联探方: trenchCode,
    领用数量: 1,
    用途: `${trenchCode} 开工领用`,
    经办人: String(trench['负责人'] ?? ''),
    领用状态: '待领用',
  }
  saveRows('requisition', [...rows, todo])
  return code
}

function runMaterialAction(id: number, action: string, payload: ActionPayload): ActionResult {
  const rows = listRows('material')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的发掘耗材` }
  }
  const row = rows[index]
  const current = String(row.status)
  if (current === '已停用') {
    return { ok: false, message: '发掘耗材已停用，「已停用」是终态，不能再流转' }
  }

  if (action === '发起采购') {
    if (current === '需采购') {
      return { ok: false, message: '人工申购单已登记，等确认入库闭环，不用重复发起' }
    }
    if (current !== '偏低') {
      return { ok: false, message: `当前「${current}」，按顺序要库存回落到「偏低」才能发起采购` }
    }
    const orderNo = `PUR-${String(id).padStart(4, '0')}`
    saveMaterialRow({ ...row, status: '需采购', pending: true, 申购单号: orderNo })
    return { ok: true, message: `已登记人工申购单 ${orderNo}，状态转为「需采购」，入库闭环前以申购单为准` }
  }

  if (action === '确认入库') {
    if (current !== '需采购') {
      return { ok: false, message: `当前「${current}」，按顺序要到「需采购」才能确认入库` }
    }
    const amount = Number(payload.入库数量)
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, message: '确认入库要登记大于 0 的入库数量' }
    }
    const operator = (payload.经办人 ?? '').trim() || String(row['保管人'] ?? '')
    // 先入库，再按领用单先后核销该耗材的待办（库存够才核销），现场领用清单同步增加。
    let quantity = materialQuantity(row) + amount
    let fulfilled = 0
    for (const req of listRows('requisition')) {
      if (String(req.status) !== '待领用' || String(req['耗材编号']) !== String(row['耗材编号'])) {
        continue
      }
      const need = Number(req['领用数量']) || 0
      if (quantity < need) {
        continue
      }
      quantity -= need
      fulfilled += 1
      saveRequisitionRow({ ...req, status: '已领用', pending: true, 经办人: operator, 领用状态: '已领用' })
    }
    const updated: EntryRow = { ...row, 当前数量: quantity }
    delete updated['申购单号']
    // 入库闭环后人工申购单失效，按最新库存重新推导（没有预警数量的历史耗材直接回「充足」）。
    const derived = deriveMaterialStatus(updated) ?? '充足'
    saveMaterialRow({ ...updated, status: derived, pending: true })
    const tail = fulfilled > 0 ? `，核销领用待办 ${fulfilled} 条` : ''
    return { ok: true, message: `已入库 ${amount} 件${tail}，当前库存 ${quantity}，状态「${derived}」` }
  }

  if (action === '标记停用') {
    if (current !== '需采购') {
      return { ok: false, message: `当前「${current}」，按顺序要到「需采购」才能标记停用` }
    }
    saveMaterialRow({ ...row, status: '已停用', pending: false })
    return { ok: true, message: '发掘耗材已标记停用，其领用待办将不能再领取' }
  }

  return { ok: false, message: `发掘耗材没有登记「${action}」这个动作` }
}

function runRequisitionAction(id: number, action: string, payload: ActionPayload): ActionResult {
  const rows = listRows('requisition')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的领用单` }
  }
  const row = rows[index]
  const current = String(row.status)
  // 领取、退回和报废都要记录经办人与用途，缺了就不让流转。
  const operator = (payload.经办人 ?? '').trim()
  const purpose = (payload.用途 ?? '').trim()
  if (!operator) {
    return { ok: false, message: `「${action}」要登记经办人` }
  }
  if (!purpose) {
    return { ok: false, message: `「${action}」要登记用途` }
  }

  if (action === '领取') {
    // 只有「待领用」能领取：同一领用单重复提交到这一步就被拦下，库存只扣减一次。
    if (current !== '待领用') {
      return { ok: false, message: `领用单已是「${current}」，不能重复领取` }
    }
    const material = findMaterialByCode(String(row['耗材编号']))
    if (!material) {
      return { ok: false, message: `没有找到耗材编号 ${row['耗材编号']} 对应的发掘耗材` }
    }
    if (String(material.status) === '已停用') {
      return { ok: false, message: '该发掘耗材已停用，不能领取' }
    }
    const need = Number(row['领用数量']) || 0
    const remain = materialQuantity(material) - need
    if (remain < 0) {
      return { ok: false, message: `库存不足：当前 ${materialQuantity(material)} 件，需要 ${need} 件，可先发起采购` }
    }
    saveMaterialRow(refreshMaterialStatus({ ...material, 当前数量: remain }))
    saveRequisitionRow({ ...row, status: '已领用', pending: true, 经办人: operator, 用途: purpose, 领用状态: '已领用' })
    return { ok: true, message: `已领取 ${need} 件，库存余 ${remain} 件` }
  }

  if (action === '退回') {
    if (current !== '已领用') {
      return { ok: false, message: `领用单已是「${current}」，只有「已领用」能退回` }
    }
    const material = findMaterialByCode(String(row['耗材编号']))
    if (material) {
      const back = materialQuantity(material) + (Number(row['领用数量']) || 0)
      saveMaterialRow(refreshMaterialStatus({ ...material, 当前数量: back }))
    }
    saveRequisitionRow({ ...row, status: '已退回', pending: false, 经办人: operator, 用途: purpose, 领用状态: '已退回' })
    return { ok: true, message: `已退回 ${Number(row['领用数量']) || 0} 件，库存已回补` }
  }

  if (action === '报废') {
    if (current !== '已领用') {
      return { ok: false, message: `领用单已是「${current}」，只有「已领用」能报废` }
    }
    // 报废：数量在领取时已扣减，现场消耗不再回库，这里只登记经办人与用途。
    saveRequisitionRow({ ...row, status: '已报废', pending: false, 经办人: operator, 用途: purpose, 领用状态: '已报废' })
    return { ok: true, message: '已登记报废，库存不回补' }
  }

  return { ok: false, message: `领用单没有登记「${action}」这个动作` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
