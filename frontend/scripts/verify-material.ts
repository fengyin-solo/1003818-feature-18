// 耗材编排的端到端规则验证：在 node 里垫片 localStorage，直接跑真实服务代码。
function memStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  }
}
;(globalThis as { window?: unknown }).window = { localStorage: memStorage() }
;(globalThis as { localStorage?: unknown }).localStorage = (
  globalThis as { window: { localStorage: Storage } }
).window.localStorage

import {
  confirmInbound,
  createManualRequisition,
  createStock,
  deactivate,
  listRequisitions,
  listStocks,
  materialStats,
  resetMaterial,
  returnRequisition,
  scrapRequisition,
  startPurchase,
  submitRequisition,
} from '@/api/material-service'
import { createTrenchOpeningTodo } from '@/api/material-service'
import { listEntries, runAction } from '@/api/local-service'

let failures = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`PASS  ${name}`)
  } else {
    failures += 1
    console.error(`FAIL  ${name} ${extra}`)
  }
}

resetMaterial()

// 1. 状态只能顺序流转：充足态不能直接发起采购/停用。
const sufficient = listStocks().find((s) => s.name === '手铲')!
const r1 = startPurchase(sufficient.id, '张三', '采购')
check('充足态不能跨级发起采购', !r1.ok && r1.message.includes('顺序'), r1.message)
const r1b = deactivate(sufficient.id, '张三', '报废')
check('充足态不能跨级停用', !r1b.ok && r1b.message.includes('顺序'), r1b.message)

// 2. 领取/退回/报废/采购/入库/停用都必须有经办人与用途。
const low = listStocks().find((s) => s.name === '考古刷')!
check('发起采购缺经办人被拒', !startPurchase(low.id, '', 'x').ok)
check('发起采购缺用途被拒', !startPurchase(low.id, '张三', '').ok)

// 3. 偏低态发起采购 -> 锁定需采购（以人工申购单为准）。
const purchased = startPurchase(low.id, '李四', '补货申购')
check('偏低发起采购成功', purchased.ok, purchased.message)
const lowAgain = listStocks().find((s) => s.id === low.id)!
check('申购后锁定需采购且标记在途', lowAgain.status === '需采购' && lowAgain.manualPurchasing)

// 4. 历史耗材无预警数量：库存被领低也不自动预警。
const legacy = listStocks().find((s) => s.warnQuantity === null)!
check('历史耗材无预警数量初始充足', legacy.status === '充足')

// 5. 开工自动生成领用待办；同一探方重复开工不重复生成。
const t1 = createTrenchOpeningTodo('TREN-0007', '王五', 'TREN-0007 开工')
check('开工生成领用待办', t1.ok && (t1.requisitionCodes?.length ?? 0) === 1, t1.message)
const t1again = createTrenchOpeningTodo('TREN-0007', '王五', '重复开工')
check('同探方重复开工不重复生成待办', t1again.ok && t1again.requisitionCodes?.[0] === t1.requisitionCodes?.[0])
const todoCode = t1.requisitionCodes![0]
const todo = listRequisitions().find((r) => r.code === todoCode)!
check('待办包含全部未停用耗材', todo.items.length === listStocks().filter((s) => s.status !== '已停用').length)
check('无预警数量耗材默认申领 1 件', todo.items.find((i) => i.materialId === legacy.id)!.quantity === 1)
check('开工待办处于待提交态', todo.status === '待提交')

// 通用 runAction 路径：探方开始发掘同样联动待办（另一探方）。
const before = materialStats().openTodo
const trenchRowId = (() => {
  return Number(listEntries('trench').items.find((r) => String(r.status) === '待发掘')!.id)
})()
const viaGeneric = runAction('trench', trenchRowId, '开始发掘', {
  trenchCode: 'TREN-FROM-GENERIC',
  operator: '赵六',
  purpose: '通用开工入口',
})
check('通用开工入口联动生成待办', viaGeneric.ok && viaGeneric.message.includes('领用待办'), viaGeneric.message)
check('待办计数 +1', materialStats().openTodo === before + 1)

// 6. 同一领用单重复提交只能扣减一次。
const snapshotStock = listStocks().find((s) => s.id === sufficient.id)!.quantity
const submit1 = submitRequisition(todo.id, '王五', '开工领取')
check('待办首次提交成功并扣减', submit1.ok, submit1.message)
const afterFirst = listStocks().find((s) => s.id === sufficient.id)!.quantity
const expectedRemain = Math.max(snapshotStock - todo.items.find((i) => i.materialId === sufficient.id)!.quantity, 0)
check('首次提交按明细扣减', afterFirst === expectedRemain, `${afterFirst} != ${expectedRemain}`)
const submit2 = submitRequisition(todo.id, '王五', '重复提交')
check('重复提交被拒绝', !submit2.ok && submit2.message.includes('重复提交'), submit2.message)
const afterSecond = listStocks().find((s) => s.id === sufficient.id)!.quantity
check('重复提交不再扣减', afterSecond === afterFirst)
check('提交后进入现场领用清单（已提交）', listRequisitions('已提交').some((r) => r.id === todo.id))

// 7. 确认入库：解除锁定、回充足、数量增加，并同步现场领用清单。
const onsiteBefore = listRequisitions('已提交').length
const need = listStocks().find((s) => s.name === '标本袋')! // 种子里申购在途
const inboundQty = 60
const qtyBeforeInbound = listStocks().find((s) => s.id === need.id)!.quantity
const inbound = confirmInbound(need.id, inboundQty, '孙七', '采购到货')
check('确认入库成功', inbound.ok, inbound.message)
const afterInbound = listStocks().find((s) => s.id === need.id)!
check('入库后回充足并解锁', afterInbound.status === '充足' && !afterInbound.manualPurchasing)
check('入库数量累加', afterInbound.quantity === qtyBeforeInbound + inboundQty, `${afterInbound.quantity} != ${qtyBeforeInbound}+${inboundQty}`)
const onsiteAfter = listRequisitions('已提交')
check('入库同步增加现场领用清单', onsiteAfter.length === onsiteBefore + 1)
const synced = onsiteAfter.find((r) => r.source === '申购同步')!
check('同步单含入库耗材且不重复扣库存', synced && (synced.deducted[need.id] ?? -1) === 0)

// 8. 退回：数量还回库房、单据变已退回；报废：不回库存。
const returnQty = todo.deducted[sufficient.id] ?? 0
const stockBeforeReturn = listStocks().find((s) => s.id === sufficient.id)!.quantity
const ret = returnRequisition(todo.id, '王五', '发掘结束退回')
check('退回成功', ret.ok, ret.message)
check('退回后数量回补', listStocks().find((s) => s.id === sufficient.id)!.quantity === stockBeforeReturn + returnQty)
check('退回单状态已退回', listRequisitions().find((r) => r.id === todo.id)!.status === '已退回')
check('退回缺经办人被拒', !returnRequisition(999999, '', 'x').ok)

// 报废路径：新建一单并提交后报废。
const scrapTarget = listStocks().find((s) => s.status === '充足' && s.quantity >= 2)!
const draft = createManualRequisition('TREN-SCRAP', [
  { materialId: scrapTarget.id, materialName: scrapTarget.name, quantity: 2 },
], '钱八', '专项使用')
const draftReq = listRequisitions().find((r) => r.code === draft.requisitionCodes![0])!
submitRequisition(draftReq.id, '钱八', '专项使用')
const stockBeforeScrap = listStocks().find((s) => s.id === scrapTarget.id)!.quantity
const scr = scrapRequisition(draftReq.id, '钱八', '损坏报废')
check('报废成功', scr.ok, scr.message)
check('报废不回补库存', listStocks().find((s) => s.id === scrapTarget.id)!.quantity === stockBeforeScrap)
check('报废单状态已报废', listRequisitions().find((r) => r.id === draftReq.id)!.status === '已报废')

// 9. 登记耗材：可留空预警数量；自动预警只在低于阈值时触发。
const created = createStock({
  name: '新刷子', spec: '小号', category: '清理', quantity: 10, warnQuantity: null,
  keeper: '李保管', operator: '张三', purpose: '新登记',
})
check('无预警数量登记成功且充足', created.ok && listStocks().find((s) => s.name === '新刷子')!.status === '充足')
const created2 = createStock({
  name: '紧张耗材', spec: '', category: '', quantity: 3, warnQuantity: 5,
  keeper: '', operator: '张三', purpose: '新登记',
})
check('低于预警数量自动判为偏低', created2.ok && listStocks().find((s) => s.name === '紧张耗材')!.status === '偏低')
check('登记缺经办人被拒', !createStock({ name: 'x', spec: '', category: '', quantity: 1, warnQuantity: null, keeper: '', operator: '', purpose: '' }).ok)

// 10. 已停用终点校验：偏低->需采购->停用，顺序走完；停用后不能再采购/入库。
const retiring = listStocks().find((s) => s.name === '紧张耗材')!
check('紧张耗材起点为偏低', retiring.status === '偏低')
const buyRetiring = startPurchase(retiring.id, '张三', '停用前申购')
check('偏低发起采购到需采购', buyRetiring.ok)
const deact = deactivate(retiring.id, '张三', '淘汰报废')
check('需采购顺序停用成功', deact.ok, deact.message)
const retired = listStocks().find((s) => s.id === retiring.id)!
check('停用为终点状态', retired.status === '已停用')
check('停用后不能再发起采购', !startPurchase(retiring.id, '张三', 'x').ok)
check('停用后不能再确认入库', !confirmInbound(retiring.id, 5, '张三', 'x').ok)
console.log('\n现场领用清单（已提交）条数：', listRequisitions('已提交').length)
console.log('统计：', JSON.stringify(materialStats()))

if (failures > 0) {
  console.error(`\n${failures} 条检查未通过`)
  process.exit(1)
}
console.log('\n全部规则验证通过')
