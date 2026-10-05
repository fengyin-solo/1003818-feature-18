import { listRows, storageKey } from './local-store'
import {
  MATERIAL_SEED_LOGS,
  MATERIAL_SEED_REQUISITIONS,
  MATERIAL_SEED_STOCKS,
} from './material-seed'
import type {
  MaterialLog,
  MaterialRequisition,
  MaterialStatus,
  MaterialStock,
} from './material-types'
import type { EntryRow } from './types'

// 耗材业务独立持久化：与通用清单表分开存放，避免被通用动作覆盖。
const STOCK_KEY = `${storageKey()}:material-stocks`
const REQUISITION_KEY = `${storageKey()}:material-requisitions`
const LOG_KEY = `${storageKey()}:material-logs`
const SEQ_KEY = `${storageKey()}:material-seq`
const MIGRATE_KEY = `${storageKey()}:material-migrated`

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(fallback)
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return clone(fallback)
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return clone(fallback)
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

// 从旧的通用 material 清单表迁移历史耗材；没有预警数量时保留 null。
function migrateLegacyStocks(): MaterialStock[] {
  const legacy = listRows('material')
  return legacy.map((row: EntryRow, index: number) => {
    const status = String(row.status) as MaterialStatus
    return {
      id: Number(row.id) || index + 1,
      name: String(row['耗材名称'] ?? `耗材${row.id}`),
      spec: String(row['规格型号'] ?? ''),
      category: String(row['用途分类'] ?? ''),
      quantity: toNumber(row['当前数量']) ?? 0,
      warnQuantity: toNumber(row['预警数量']),
      keeper: String(row['保管人'] ?? ''),
      status: ['充足', '偏低', '需采购', '已停用'].includes(status) ? status : '充足',
      manualPurchasing: status === '需采购',
    }
  })
}

export type MaterialDb = {
  stocks: MaterialStock[]
  requisitions: MaterialRequisition[]
  logs: MaterialLog[]
  /** 领用单/流水的自增序号，分开计数避免互相影响。 */
  requisitionSeq: number
  logSeq: number
}

let cache: MaterialDb | null = null

export function materialDb(): MaterialDb {
  if (cache) {
    return cache
  }
  // 只在首次访问时迁移一次通用表里的历史耗材，之后以耗材专用存储为准。
  const migrated =
    typeof window !== 'undefined' &&
    window.localStorage &&
    window.localStorage.getItem(MIGRATE_KEY) === '1'
  let stocks = readJson<MaterialStock[]>(STOCK_KEY, MATERIAL_SEED_STOCKS)
  if (!migrated) {
    const legacy = migrateLegacyStocks()
    if (legacy.length > 0) {
      stocks = legacy
    }
    writeJson(MIGRATE_KEY, '1')
  }
  cache = {
    stocks,
    requisitions: readJson<MaterialRequisition[]>(REQUISITION_KEY, MATERIAL_SEED_REQUISITIONS),
    logs: readJson<MaterialLog[]>(LOG_KEY, MATERIAL_SEED_LOGS),
    requisitionSeq: readJson<number>(SEQ_KEY + ':requisition', 0),
    logSeq: readJson<number>(SEQ_KEY + ':log', 0),
  }
  persistStocks()
  return cache
}

export function persistStocks(): void {
  const db = materialDb()
  writeJson(STOCK_KEY, db.stocks)
  writeJson(REQUISITION_KEY, db.requisitions)
  writeJson(LOG_KEY, db.logs)
  writeJson(SEQ_KEY + ':requisition', db.requisitionSeq)
  writeJson(SEQ_KEY + ':log', db.logSeq)
}

export function resetMaterialDb(): MaterialDb {
  cache = {
    stocks: clone(MATERIAL_SEED_STOCKS),
    requisitions: clone(MATERIAL_SEED_REQUISITIONS),
    logs: clone(MATERIAL_SEED_LOGS),
    requisitionSeq: 0,
    logSeq: 0,
  }
  persistStocks()
  return cache
}

export function nextRequisitionId(): number {
  const db = materialDb()
  db.requisitionSeq += 1
  return db.requisitionSeq
}

export function nextLogId(): number {
  const db = materialDb()
  db.logSeq += 1
  return db.logSeq
}
