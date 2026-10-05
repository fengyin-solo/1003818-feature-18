import type { MaterialLog, MaterialRequisition, MaterialStock } from './material-types'

// 耗材业务种子数据：含一条没有预警数量的历史耗材（MATE-0004），用于验证兼容逻辑。
export const MATERIAL_SEED_STOCKS: MaterialStock[] = [
  {
    id: 1,
    name: '手铲',
    spec: '标准 10cm',
    category: '发掘工具',
    quantity: 25,
    warnQuantity: 8,
    keeper: '李保管',
    status: '充足',
    manualPurchasing: false,
  },
  {
    id: 2,
    name: '考古刷',
    spec: '中号软毛刷',
    category: '清理工具',
    quantity: 6,
    warnQuantity: 10,
    keeper: '李保管',
    status: '偏低',
    manualPurchasing: false,
  },
  {
    id: 3,
    name: '标本袋',
    spec: '12*18cm 自封袋',
    category: '收纳耗材',
    quantity: 2,
    warnQuantity: 50,
    keeper: '王保管',
    status: '需采购',
    manualPurchasing: true,
  },
  {
    id: 4,
    name: '老式绘图铅笔',
    spec: '2B（历史遗留）',
    category: '记录耗材',
    quantity: 40,
    // 历史发掘耗材没有预警数量：保持 null，不参与自动预警。
    warnQuantity: null,
    keeper: '王保管',
    status: '充足',
    manualPurchasing: false,
  },
]

export const MATERIAL_SEED_REQUISITIONS: MaterialRequisition[] = []

export const MATERIAL_SEED_LOGS: MaterialLog[] = []
