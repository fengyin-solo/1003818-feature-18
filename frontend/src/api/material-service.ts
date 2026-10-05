import {
  materialDb,
  nextLogId,
  nextRequisitionId,
  persistStocks,
  resetMaterialDb,
} from '@/data/material-store'
import {
  MATERIAL_STATUS_FLOW,
  type MaterialLog,
  type MaterialLogKind,
  type MaterialOperationResult,
  type MaterialRequisition,
  type MaterialStatus,
  type MaterialStock,
} from '@/data/material-types'

// 现场默认领用基数：有预警数量时按最低库存备一套，没有预警数量的历史耗材按 1 件登记。
const FALLBACK_KIT_QUANTITY = 1

function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`
}

function requireAttribution(operator: string, purpose: string): string | null {
  if (!operator.trim()) {
    return '请填写经办人'
  }
  if (!purpose.trim()) {
    return '请填写用途'
  }
  return null
}

// 按当前数量与最低库存（预警数量）推导状态。
// 规则：已停用不参与；人工申购单锁定「需采购」，最低库存不再覆盖；没有预警数量的历史耗材不自动预警。
export function deriveStatus(stock: MaterialStock): MaterialStatus {
  if (stock.status === '已停用') {
    return '已停用'
  }
  if (stock.manualPurchasing) {
    return '需采购'
  }
  if (stock.warnQuantity === null) {
    return stock.status === '需采购' ? '充足' : stock.status
  }
  if (stock.quantity <= 0) {
    return '需采购'
  }
  if (stock.quantity <= stock.warnQuantity) {
    return '偏低'
  }
  return '充足'
}

function addLog(input: {
  kind: MaterialLogKind
  stock: MaterialStock
  quantity: number
  refCode: string
  operator: string
  purpose: string
  fromStatus: string
  toStatus: string
  remark?: string
}): void {
  const db = materialDb()
  db.logs.unshift({
    id: nextLogId(),
    time: now(),
    kind: input.kind,
    materialId: input.stock.id,
    materialName: input.stock.name,
    quantity: input.quantity,
    refCode: input.refCode,
    operator: input.operator.trim(),
    purpose: input.purpose.trim(),
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    remark: input.remark ?? '',
  })
}

function refreshStockStatus(stock: MaterialStock, remark: string): void {
  const next = deriveStatus(stock)
  if (next !== stock.status) {
    const from = stock.status
    stock.status = next
    addLog({
      kind: '状态流转',
      stock,
      quantity: 0,
      refCode: '',
      operator: '系统',
      purpose: '按最低库存自动预警',
      fromStatus: from,
      toStatus: next,
      remark,
    })
  }
}

export function listStocks(filters: Record<string, string> = {}): MaterialStock[] {
  const pairs = Object.entries(filters).filter(([, v]) => v.trim() !== '')
  return materialDb().stocks.filter((stock) =>
    pairs.every(([field, value]) => String(stockField(stock, field)).includes(value.trim())),
  )
}

function stockField(stock: MaterialStock, field: string): string | number {
  const map: Record<string, string | number | null> = {
    耗材名称: stock.name,
    规格型号: stock.spec,
    用途分类: stock.category,
    保管人: stock.keeper,
    耗材状态: stock.status,
  }
  return map[field] ?? ''
}

function findStock(id: number): MaterialStock | null {
  return materialDb().stocks.find((item) => item.id === id) ?? null
}

// 状态只能按 充足→偏低→需采购→已停用 顺序前进，不能回退、不能跨级。
function assertForward(from: MaterialStatus, to: MaterialStatus, action: string): string | null {
  const i = MATERIAL_STATUS_FLOW.indexOf(from)
  const j = MATERIAL_STATUS_FLOW.indexOf(to)
  if (j <= i) {
    return `耗材已是「${from}」，${action}不能回退状态`
  }
  if (j !== i + 1) {
    return `耗材状态只能按顺序流转，不能从「${from}」直接跳到「${to}」`
  }
  return null
}

// 发起采购（人工申购单）：只允许在「偏低」时发起；一旦发起即锁定「需采购」，以人工申购单为准。
export function startPurchase(
  id: number,
  operator: string,
  purpose: string,
): MaterialOperationResult {
  const attribution = requireAttribution(operator, purpose)
  if (attribution) {
    return { ok: false, message: attribution }
  }
  const stock = findStock(id)
  if (!stock) {
    return { ok: false, message: `没有找到编号为 ${id} 的耗材` }
  }
  if (stock.status === '已停用') {
    return { ok: false, message: '耗材已停用，不能再发起采购' }
  }
  if (stock.manualPurchasing || stock.status === '需采购') {
    return { ok: false, message: '该耗材已有人工申购单，无需重复发起' }
  }
  const forwardError = assertForward(stock.status, '需采购', '发起采购')
  if (forwardError) {
    return { ok: false, message: forwardError }
  }
  const from = stock.status
  stock.manualPurchasing = true
  stock.status = '需采购'
  addLog({
    kind: '发起采购',
    stock,
    quantity: 0,
    refCode: '',
    operator,
    purpose,
    fromStatus: from,
    toStatus: '需采购',
    remark: '人工申购单优先于最低库存预警',
  })
  persistStocks()
  return { ok: true, message: `已为「${stock.name}」发起人工申购单，状态锁定为需采购` }
}

// 确认入库：采购到货后增加库存、解除申购锁定、回到充足；并把该耗材同步加入现场领用清单。
export function confirmInbound(
  id: number,
  quantity: number,
  operator: string,
  purpose: string,
): MaterialOperationResult {
  const attribution = requireAttribution(operator, purpose)
  if (attribution) {
    return { ok: false, message: attribution }
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, message: '入库数量必须大于 0' }
  }
  const stock = findStock(id)
  if (!stock) {
    return { ok: false, message: `没有找到编号为 ${id} 的耗材` }
  }
  if (!stock.manualPurchasing && stock.status !== '需采购') {
    return { ok: false, message: '只有需采购（申购中）的耗材才能确认入库' }
  }
  const from = stock.status
  stock.quantity += Math.floor(quantity)
  stock.manualPurchasing = false
  stock.status = '充足'
  const db = materialDb()
  // 另一个业务面：申购入库后同步在现场领用清单里增加一条（已提交态，不再扣库存）。
  const code = `LYD-${String(nextRequisitionId()).padStart(4, '0')}`
  db.requisitions.unshift({
    id: db.requisitionSeq,
    code,
    trenchCode: '现场库房',
    purpose: purpose.trim(),
    operator: operator.trim(),
    items: [{ materialId: stock.id, materialName: stock.name, quantity: Math.floor(quantity) }],
    status: '已提交',
    deducted: { [stock.id]: 0 },
    source: '申购同步',
    createdAt: now(),
    submittedAt: now(),
  })
  addLog({
    kind: '确认入库',
    stock,
    quantity: Math.floor(quantity),
    refCode: code,
    operator,
    purpose,
    fromStatus: from,
    toStatus: '充足',
    remark: '入库后同步加入现场领用清单',
  })
  persistStocks()
  return {
    ok: true,
    message: `「${stock.name}」入库 ${Math.floor(quantity)} 件，已同步到现场领用清单（${code}）`,
    requisitionCodes: [code],
  }
}

// 标记停用：顺序状态机的终点，只能从「需采购」停用。
export function deactivate(
  id: number,
  operator: string,
  purpose: string,
): MaterialOperationResult {
  const attribution = requireAttribution(operator, purpose)
  if (attribution) {
    return { ok: false, message: attribution }
  }
  const stock = findStock(id)
  if (!stock) {
    return { ok: false, message: `没有找到编号为 ${id} 的耗材` }
  }
  if (stock.status === '已停用') {
    return { ok: false, message: '耗材已经停用' }
  }
  const forwardError = assertForward(stock.status, '已停用', '标记停用')
  if (forwardError) {
    return { ok: false, message: forwardError }
  }
  const from = stock.status
  stock.manualPurchasing = false
  stock.status = '已停用'
  addLog({
    kind: '标记停用',
    stock,
    quantity: 0,
    refCode: '',
    operator,
    purpose,
    fromStatus: from,
    toStatus: '已停用',
  })
  persistStocks()
  return { ok: true, message: `「${stock.name}」已停用` }
}

// 探方开始发掘：自动生成一张领用待办（待提交单）。同一探方已有待办时不重复生成。
export function createTrenchOpeningTodo(
  trenchCode: string,
  operator: string,
  purpose: string,
): MaterialOperationResult {
  const db = materialDb()
  const existing = db.requisitions.find(
    (item) => item.trenchCode === trenchCode && item.status === '待提交',
  )
  if (existing) {
    return {
      ok: true,
      message: `探方 ${trenchCode} 已有领用待办 ${existing.code}，不重复生成`,
      requisitionCodes: [existing.code],
    }
  }
  const items = db.stocks
    .filter((stock) => stock.status !== '已停用')
    .map((stock) => ({
      materialId: stock.id,
      materialName: stock.name,
      quantity: stock.warnQuantity ?? FALLBACK_KIT_QUANTITY,
    }))
  if (items.length === 0) {
    return { ok: false, message: '暂无可领用的在库耗材，未生成领用待办' }
  }
  const id = nextRequisitionId()
  const code = `LYD-${String(id).padStart(4, '0')}`
  db.requisitions.unshift({
    id,
    code,
    trenchCode,
    purpose: purpose.trim() || `探方${trenchCode}开工领用`,
    operator: operator.trim() || '值班管理员',
    items,
    status: '待提交',
    deducted: {},
    source: '开工待办',
    createdAt: now(),
    submittedAt: null,
  })
  persistStocks()
  return {
    ok: true,
    message: `探方 ${trenchCode} 已开工，自动生成领用待办 ${code}（${items.length} 项）`,
    requisitionCodes: [code],
  }
}

export function listRequisitions(status?: string): MaterialRequisition[] {
  const all = materialDb().requisitions
  return status ? all.filter((item) => item.status === status) : all
}

function findRequisition(id: number): MaterialRequisition | null {
  return materialDb().requisitions.find((item) => item.id === id) ?? null
}

// 提交领用单：进入现场领用清单并扣减库存。非待提交态一律拒绝——同一单重复提交只扣一次。
export function submitRequisition(
  id: number,
  operator: string,
  purpose: string,
): MaterialOperationResult {
  const attribution = requireAttribution(operator, purpose)
  if (attribution) {
    return { ok: false, message: attribution }
  }
  const requisition = findRequisition(id)
  if (!requisition) {
    return { ok: false, message: '没有找到这张领用单' }
  }
  if (requisition.status !== '待提交') {
    return {
      ok: false,
      message: `领用单 ${requisition.code} 已是「${requisition.status}」，重复提交不会再次扣减库存`,
    }
  }
  requisition.operator = operator.trim()
  requisition.purpose = purpose.trim()

  let shortfall = 0
  for (const item of requisition.items) {
    const stock = findStock(item.materialId)
    if (!stock || stock.status === '已停用') {
      shortfall += item.quantity
      requisition.deducted[item.materialId] = 0
      continue
    }
    const given = Math.min(item.quantity, stock.quantity)
    const from = stock.status
    stock.quantity -= given
    requisition.deducted[item.materialId] = given
    if (given > 0) {
      addLog({
        kind: '领用',
        stock,
        quantity: given,
        refCode: requisition.code,
        operator,
        purpose,
        fromStatus: from,
        toStatus: from,
        remark: given < item.quantity ? `申请 ${item.quantity}，库存不足实发 ${given}` : '',
      })
    }
    shortfall += Math.max(item.quantity - given, 0)
    refreshStockStatus(stock, '领用扣减后按最低库存重算')
  }
  requisition.status = '已提交'
  requisition.submittedAt = now()
  persistStocks()
  const message =
    shortfall > 0
      ? `领用单 ${requisition.code} 已提交并扣减库存，另有 ${shortfall} 件库存不足未发放`
      : `领用单 ${requisition.code} 已提交，库存扣减完成并进入现场领用清单`
  return { ok: true, message, requisitionCodes: [requisition.code] }
}

// 退回：把已领数量全部还回库房。
export function returnRequisition(
  id: number,
  operator: string,
  purpose: string,
): MaterialOperationResult {
  const attribution = requireAttribution(operator, purpose)
  if (attribution) {
    return { ok: false, message: attribution }
  }
  const requisition = findRequisition(id)
  if (!requisition) {
    return { ok: false, message: '没有找到这张领用单' }
  }
  if (requisition.status !== '已提交') {
    return { ok: false, message: `只有已提交的领用单才能退回，当前为「${requisition.status}」` }
  }
  for (const item of requisition.items) {
    const given = requisition.deducted[item.materialId] ?? 0
    if (given <= 0) {
      continue
    }
    const stock = findStock(item.materialId)
    if (!stock) {
      continue
    }
    const from = stock.status
    stock.quantity += given
    requisition.deducted[item.materialId] = 0
    addLog({
      kind: '退回',
      stock,
      quantity: given,
      refCode: requisition.code,
      operator,
      purpose,
      fromStatus: from,
      toStatus: from,
    })
    if (stock.status !== '已停用' && !stock.manualPurchasing) {
      refreshStockStatus(stock, '退回入库后按最低库存重算')
    }
  }
  requisition.status = '已退回'
  persistStocks()
  return { ok: true, message: `领用单 ${requisition.code} 已全部退回库房` }
}

// 报废：已领数量做销账处理，不回库存。
export function scrapRequisition(
  id: number,
  operator: string,
  purpose: string,
): MaterialOperationResult {
  const attribution = requireAttribution(operator, purpose)
  if (attribution) {
    return { ok: false, message: attribution }
  }
  const requisition = findRequisition(id)
  if (!requisition) {
    return { ok: false, message: '没有找到这张领用单' }
  }
  if (requisition.status !== '已提交') {
    return { ok: false, message: `只有已提交的领用单才能报废，当前为「${requisition.status}」` }
  }
  for (const item of requisition.items) {
    const given = requisition.deducted[item.materialId] ?? 0
    const stock = findStock(item.materialId)
    if (given <= 0 || !stock) {
      continue
    }
    addLog({
      kind: '报废',
      stock,
      quantity: given,
      refCode: requisition.code,
      operator,
      purpose,
      fromStatus: stock.status,
      toStatus: stock.status,
    })
    requisition.deducted[item.materialId] = 0
  }
  requisition.status = '已报废'
  persistStocks()
  return { ok: true, message: `领用单 ${requisition.code} 已报废销账` }
}

export function listLogs(): MaterialLog[] {
  return materialDb().logs
}

export function materialStats(): {
  kindCount: number
  needPurchase: number
  lowCount: number
  openTodo: number
  onSiteCount: number
} {
  const db = materialDb()
  return {
    kindCount: db.stocks.length,
    needPurchase: db.stocks.filter((s) => s.status === '需采购').length,
    lowCount: db.stocks.filter((s) => s.status === '偏低').length,
    openTodo: db.requisitions.filter((r) => r.status === '待提交').length,
    onSiteCount: db.requisitions.filter((r) => r.status === '已提交').length,
  }
}

// 现场新建领用单：落成一张待提交单，由页面紧接着走统一的提交动作（与开工待办共用幂等校验）。
export function createManualRequisition(
  trenchCode: string,
  items: { materialId: number; materialName: string; quantity: number }[],
  operator: string,
  purpose: string,
): MaterialOperationResult {
  const attribution = requireAttribution(operator, purpose)
  if (attribution) {
    return { ok: false, message: attribution }
  }
  if (!trenchCode.trim()) {
    return { ok: false, message: '请填写领用探方' }
  }
  const valid = items
    .filter((item) => item.quantity > 0)
    .map((item) => ({ ...item, quantity: Math.floor(item.quantity) }))
  if (valid.length === 0) {
    return { ok: false, message: '请至少勾选一种耗材并填写数量' }
  }
  const db = materialDb()
  const id = nextRequisitionId()
  const code = `LYD-${String(id).padStart(4, '0')}`
  db.requisitions.unshift({
    id,
    code,
    trenchCode: trenchCode.trim(),
    purpose: purpose.trim(),
    operator: operator.trim(),
    items: valid,
    status: '待提交',
    deducted: {},
    source: '现场新建',
    createdAt: now(),
    submittedAt: null,
  })
  persistStocks()
  return { ok: true, message: code, requisitionCodes: [code] }
}

export function resetMaterial(): void {
  resetMaterialDb()
}

export type StockDraft = {
  name: string
  spec: string
  category: string
  quantity: number
  // 预警数量可留空：历史/不设最低库存的耗材传 null，不参与自动预警。
  warnQuantity: number | null
  keeper: string
  operator: string
  purpose: string
}

// 登记发掘耗材：数量与最低库存冲突时不在此处发生，状态由数量推导。
export function createStock(draft: StockDraft): MaterialOperationResult {
  const attribution = requireAttribution(draft.operator, draft.purpose)
  if (attribution) {
    return { ok: false, message: attribution }
  }
  if (!draft.name.trim()) {
    return { ok: false, message: '请填写耗材名称' }
  }
  if (!Number.isFinite(draft.quantity) || draft.quantity < 0) {
    return { ok: false, message: '当前数量必须是不小于 0 的数字' }
  }
  if (
    draft.warnQuantity !== null &&
    (!Number.isFinite(draft.warnQuantity) || draft.warnQuantity < 0)
  ) {
    return { ok: false, message: '预警数量必须是不小于 0 的数字，或留空' }
  }
  const db = materialDb()
  const id = db.stocks.reduce((max, item) => Math.max(max, item.id), 0) + 1
  const stock: MaterialStock = {
    id,
    name: draft.name.trim(),
    spec: draft.spec.trim(),
    category: draft.category.trim(),
    quantity: Math.floor(draft.quantity),
    warnQuantity: draft.warnQuantity === null ? null : Math.floor(draft.warnQuantity),
    keeper: draft.keeper.trim(),
    status: '充足',
    manualPurchasing: false,
  }
  stock.status = deriveStatus(stock)
  db.stocks.push(stock)
  addLog({
    kind: '状态流转',
    stock,
    quantity: stock.quantity,
    refCode: '',
    operator: draft.operator,
    purpose: draft.purpose,
    fromStatus: '—',
    toStatus: stock.status,
    remark: '登记发掘耗材',
  })
  persistStocks()
  return { ok: true, message: `已登记耗材「${stock.name}」，当前状态「${stock.status}」` }
}
