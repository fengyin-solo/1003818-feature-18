/** 发掘耗材领用/归还编排的领域类型。 */

// 库存状态机：只能按顺序前进（充足→偏低→需采购→已停用），确认入库后回到充足。
export const MATERIAL_STATUS_FLOW = ['充足', '偏低', '需采购', '已停用'] as const
export type MaterialStatus = (typeof MATERIAL_STATUS_FLOW)[number]

// 领用单状态：待提交（开工生成的领用待办）→ 已提交（已扣库存，进入现场领用清单）→ 已退回 / 已报废。
export const REQUISITION_STATUS = ['待提交', '已提交', '已退回', '已报废'] as const
export type RequisitionStatus = (typeof REQUISITION_STATUS)[number]

export type MaterialStock = {
  id: number
  name: string
  spec: string
  category: string
  /** 当前库存数量。 */
  quantity: number
  /**
   * 预警数量（最低库存）。
   * 历史耗材可能没有这条数据：为 null 时不参与自动预警，保持兼容。
   */
  warnQuantity: number | null
  keeper: string
  status: MaterialStatus
  /** 是否存在未完成的人工申购单：为 true 时锁定「需采购」，最低库存自动预警不覆盖。 */
  manualPurchasing: boolean
}

export type RequisitionItem = {
  materialId: number
  materialName: string
  quantity: number
}

export type MaterialRequisition = {
  id: number
  code: string
  /** 领用探方；人工申购入库后同步到现场清单的单没有具体探方。 */
  trenchCode: string
  /** 用途：每张领用单都要登记。 */
  purpose: string
  /** 经办人：每张领用单都要登记。 */
  operator: string
  items: RequisitionItem[]
  status: RequisitionStatus
  /** 提交后已实际扣减的明细，key 为耗材编号；同一单重复提交只能扣减一次。 */
  deducted: Record<number, number>
  /** 来源：开工自动生成的领用待办 / 人工申购入库同步 / 现场新建。 */
  source: '开工待办' | '申购同步' | '现场新建'
  createdAt: string
  submittedAt: string | null
}

// 流水动作：领取、退回（含采购入库退回库房）、报废都要记录经办人与用途。
export type MaterialLogKind = '状态流转' | '发起采购' | '确认入库' | '标记停用' | '领用' | '退回' | '报废'

export type MaterialLog = {
  id: number
  time: string
  kind: MaterialLogKind
  materialId: number
  materialName: string
  quantity: number
  /** 关联领用单/探方，可空。 */
  refCode: string
  operator: string
  purpose: string
  fromStatus: string
  toStatus: string
  remark: string
}

export type MaterialOperationResult = {
  ok: boolean
  message: string
  /** 本次动作联动生成的领用单编号，用于在页面上提示。 */
  requisitionCodes?: string[]
}
