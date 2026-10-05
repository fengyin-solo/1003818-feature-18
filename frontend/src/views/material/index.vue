<template>
  <section class="page" data-module="material">
    <header class="page-head">
      <div>
        <h2>耗材管理</h2>
        <p class="page-desc">
          发掘耗材领用归还编排：库存按「充足→偏低→需采购→已停用」顺序流转；领取、退回、报废均记录经办人与用途。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记发掘耗材</button>
        <button class="btn" type="button" @click="resetAll">重置示例数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab"
        :class="{ active: activeTab === tab.key }"
        type="button"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
        <em v-if="tab.badge > 0" class="tab-badge">{{ tab.badge }}</em>
      </button>
    </div>

    <!-- 库存面 -->
    <div v-show="activeTab === 'stock'">
      <p class="status-legend">
        <span v-for="item in statusSummary" :key="item.status" class="legend-item">
          {{ item.status }}：{{ item.count }}
        </span>
      </p>
      <form class="filter-bar" @submit.prevent="reload">
        <label class="filter-item">
          <span>耗材名称</span>
          <input v-model="filters.name" placeholder="按耗材名称检索" />
        </label>
        <label class="filter-item">
          <span>用途分类</span>
          <input v-model="filters.category" placeholder="按用途分类检索" />
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      </form>

      <table class="data-table">
        <thead>
          <tr>
            <th>耗材编号</th>
            <th>耗材名称</th>
            <th>规格型号</th>
            <th>用途分类</th>
            <th>当前数量</th>
            <th>预警数量(最低库存)</th>
            <th>保管人</th>
            <th>当前状态</th>
            <th>申购单</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="stock in stocks" :key="stock.id">
            <td>MATE-{{ String(stock.id).padStart(4, '0') }}</td>
            <td>{{ stock.name }}</td>
            <td>{{ stock.spec || '—' }}</td>
            <td>{{ stock.category || '—' }}</td>
            <td>{{ stock.quantity }}</td>
            <td>
              {{ stock.warnQuantity === null ? '未设置（兼容历史耗材，不预警）' : stock.warnQuantity }}
            </td>
            <td>{{ stock.keeper || '—' }}</td>
            <td>
              <span class="status-tag" :data-status="stock.status">{{ stock.status }}</span>
            </td>
            <td>{{ stock.manualPurchasing ? '人工申购在途' : '—' }}</td>
            <td class="row-actions">
              <button
                v-if="stock.status === '偏低'"
                class="link"
                type="button"
                @click="openAttribution('purchase', stock)"
              >
                发起采购
              </button>
              <button
                v-if="stock.status === '需采购'"
                class="link"
                type="button"
                @click="openInbound(stock)"
              >
                确认入库
              </button>
              <button
                v-if="stock.status === '需采购'"
                class="link danger"
                type="button"
                @click="openAttribution('deactivate', stock)"
              >
                标记停用
              </button>
              <span v-if="!hasStockAction(stock)" class="muted-text">顺序流转中</span>
            </td>
          </tr>
          <tr v-if="!stocks.length">
            <td colspan="10" class="empty-state">暂无耗材，可先登记发掘耗材</td>
          </tr>
        </tbody>
      </table>
      <p class="page-tip">
        状态只能按 充足→偏低→需采购→已停用 顺序前进；人工申购单发起后锁定「需采购」，以申购单为准，最低库存自动预警不再覆盖；确认入库后回到「充足」并同步现场领用清单。
      </p>
    </div>

    <!-- 领用待办面 -->
    <div v-show="activeTab === 'todo'">
      <table class="data-table">
        <thead>
          <tr>
            <th>领用单号</th>
            <th>来源</th>
            <th>领用探方</th>
            <th>领用明细</th>
            <th>经办人</th>
            <th>用途</th>
            <th>生成时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="req in todoList" :key="req.id">
            <td>{{ req.code }}</td>
            <td>{{ req.source }}</td>
            <td>{{ req.trenchCode }}</td>
            <td>
              <span v-for="item in req.items" :key="item.materialId" class="chip">
                {{ item.materialName }} ×{{ item.quantity }}
              </span>
            </td>
            <td>{{ req.operator }}</td>
            <td>{{ req.purpose }}</td>
            <td>{{ req.createdAt }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="openSubmit(req)">确认领用</button>
            </td>
          </tr>
          <tr v-if="!todoList.length">
            <td colspan="8" class="empty-state">
              暂无领用待办，探方开始发掘时会自动生成；也可在现场领用清单新建
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 现场领用清单面 -->
    <div v-show="activeTab === 'onsite'">
      <div class="page-actions" style="margin: 8px 0">
        <button class="btn primary" type="button" @click="openManualRequisition">现场新建领用单</button>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>领用单号</th>
            <th>来源</th>
            <th>领用探方</th>
            <th>领用明细（实发）</th>
            <th>经办人</th>
            <th>用途</th>
            <th>状态</th>
            <th>提交时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="req in onsiteList" :key="req.id">
            <td>{{ req.code }}</td>
            <td>{{ req.source }}</td>
            <td>{{ req.trenchCode }}</td>
            <td>
              <span v-for="item in req.items" :key="item.materialId" class="chip">
                {{ item.materialName }}
                ×{{ req.deducted[item.materialId] ?? 0
                }}<em v-if="(req.deducted[item.materialId] ?? 0) < item.quantity" class="shortfall">
                  /申{{ item.quantity }}</em
                >
              </span>
            </td>
            <td>{{ req.operator }}</td>
            <td>{{ req.purpose }}</td>
            <td><span class="status-tag" :data-status="req.status">{{ req.status }}</span></td>
            <td>{{ req.submittedAt ?? '—' }}</td>
            <td class="row-actions">
              <template v-if="req.status === '已提交'">
                <button class="link" type="button" @click="openAttributionReq('return', req)">
                  退回
                </button>
                <button class="link danger" type="button" @click="openAttributionReq('scrap', req)">
                  报废
                </button>
              </template>
              <span v-else class="muted-text">已完结</span>
            </td>
          </tr>
          <tr v-if="!onsiteList.length">
            <td colspan="9" class="empty-state">
              现场领用清单为空，待办确认领用或申购确认入库后会同步到这里
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 流水面 -->
    <div v-show="activeTab === 'logs'">
      <table class="data-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>动作</th>
            <th>耗材</th>
            <th>数量</th>
            <th>关联单据</th>
            <th>经办人</th>
            <th>用途</th>
            <th>状态变化</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="log in logs" :key="log.id">
            <td>{{ log.time }}</td>
            <td>{{ log.kind }}</td>
            <td>{{ log.materialName }}</td>
            <td>{{ log.quantity || '—' }}</td>
            <td>{{ log.refCode || '—' }}</td>
            <td>{{ log.operator }}</td>
            <td>{{ log.purpose }}</td>
            <td>{{ log.fromStatus }} → {{ log.toStatus }}</td>
            <td>{{ log.remark || '—' }}</td>
          </tr>
          <tr v-if="!logs.length">
            <td colspan="9" class="empty-state">暂无流水记录</td>
          </tr>
        </tbody>
      </table>
    </div>

    <footer class="page-foot">
      <span>共 {{ stocks.length }} 种耗材 · {{ requisitions.length }} 张领用单</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
    </footer>

    <!-- 统一动作弹窗 -->
    <div v-if="dialog.open" class="modal-mask" @click.self="closeDialog">
      <div class="modal">
        <h3 class="modal-title">{{ dialog.title }}</h3>
        <p v-if="dialog.subtitle" class="modal-subtitle">{{ dialog.subtitle }}</p>

        <template v-if="dialog.kind === 'create'">
          <label class="form-item"><span>耗材名称 *</span><input v-model="dialog.form.name" /></label>
          <label class="form-item"><span>规格型号</span><input v-model="dialog.form.spec" /></label>
          <label class="form-item"
            ><span>用途分类</span><input v-model="dialog.form.category"
          /></label>
          <label class="form-item"
            ><span>当前数量 *</span><input v-model.number="dialog.form.quantity" type="number" min="0"
          /></label>
          <label class="form-item">
            <span>预警数量（最低库存，可留空）</span>
            <input
              v-model="warnInput"
              type="number"
              min="0"
              placeholder="历史耗材留空则不自动预警"
            />
          </label>
          <label class="form-item"><span>保管人</span><input v-model="dialog.form.keeper" /></label>
        </template>

        <label v-if="dialog.kind === 'inbound'" class="form-item">
          <span>入库数量 *</span>
          <input v-model.number="dialog.form.quantity" type="number" min="1" />
        </label>

        <template v-if="dialog.kind === 'manual'">
          <label class="form-item"><span>领用探方</span><input v-model="dialog.form.trenchCode" placeholder="如 TREN-0007" /></label>
          <p class="modal-subtitle">勾选要领用的耗材并填写数量：</p>
          <div v-for="item in dialog.form.items" :key="item.materialId" class="manual-item">
            <label>
              <input v-model="item.checked" type="checkbox" />
              {{ item.materialName }}（库存 {{ item.stock }}）
            </label>
            <input v-model.number="item.quantity" type="number" min="1" />
          </div>
        </template>

        <label class="form-item"><span>经办人 *</span><input v-model="dialog.form.operator" /></label>
        <label class="form-item">
          <span>用途 *</span>
          <textarea v-model="dialog.form.purpose" rows="2" placeholder="说明本次操作的用途"></textarea>
        </label>

        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" @click="confirmDialog">确认</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  confirmInbound,
  createManualRequisition,
  createStock,
  deactivate,
  listLogs,
  listRequisitions,
  listStocks,
  materialStats,
  resetMaterial,
  returnRequisition,
  scrapRequisition,
  startPurchase,
  submitRequisition,
} from '@/api/material-service'
import type {
  MaterialLog,
  MaterialOperationResult,
  MaterialRequisition,
  MaterialStock,
} from '@/data/material-types'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()

const stocks = ref<MaterialStock[]>([])
const requisitions = ref<MaterialRequisition[]>([])
const logs = ref<MaterialLog[]>([])
const errorMessage = ref('')
const noticeMessage = ref('')

const activeTab = ref<'stock' | 'todo' | 'onsite' | 'logs'>('stock')
const filters = ref<{ name: string; category: string }>({ name: '', category: '' })

const statuses = ['充足', '偏低', '需采购', '已停用']
const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: stocks.value.filter((stock) => stock.status === status).length,
  })),
)

const todoList = computed(() => requisitions.value.filter((item) => item.status === '待提交'))
const onsiteList = computed(() => requisitions.value.filter((item) => item.status !== '待提交'))

const stats = computed(() => {
  const s = materialStats()
  return [
    { label: '耗材种类', value: s.kindCount },
    { label: '需采购种类', value: s.needPurchase },
    { label: '偏低种类', value: s.lowCount },
    { label: '领用待办', value: s.openTodo },
    { label: '现场领用清单', value: s.onSiteCount },
  ]
})

const tabs = computed(() => [
  { key: 'stock' as const, label: '耗材库存', badge: 0 },
  { key: 'todo' as const, label: '领用待办', badge: todoList.value.length },
  { key: 'onsite' as const, label: '现场领用清单', badge: onsiteList.value.filter((r) => r.status === '已提交').length },
  { key: 'logs' as const, label: '操作流水', badge: 0 },
])

type DialogKind = 'create' | 'purchase' | 'inbound' | 'deactivate' | 'submit' | 'return' | 'scrap' | 'manual'

type ManualItemDraft = {
  materialId: number
  materialName: string
  stock: number
  checked: boolean
  quantity: number
}

type DialogState = {
  open: boolean
  kind: DialogKind
  title: string
  subtitle: string
  targetStock: MaterialStock | null
  targetReq: MaterialRequisition | null
  form: {
    name: string
    spec: string
    category: string
    quantity: number | null
    keeper: string
    operator: string
    purpose: string
    trenchCode: string
    items: ManualItemDraft[]
  }
}

function emptyDialog(): DialogState {
  return {
    open: false,
    kind: 'create',
    title: '',
    subtitle: '',
    targetStock: null,
    targetReq: null,
    form: {
      name: '',
      spec: '',
      category: '',
      quantity: null,
      keeper: '',
      operator: session.operator,
      purpose: '',
      trenchCode: '',
      items: [],
    },
  }
}

const dialog = ref<DialogState>(emptyDialog())
// 预警数量单独用字符串接住，留空 = null（历史耗材兼容）。
const warnInput = ref<string>('')

function show(kind: DialogKind, title: string, subtitle = ''): void {
  dialog.value = emptyDialog()
  dialog.value.open = true
  dialog.value.kind = kind
  dialog.value.title = title
  dialog.value.subtitle = subtitle
  warnInput.value = ''
}

function closeDialog(): void {
  dialog.value = emptyDialog()
}

function openCreate(): void {
  show('create', '登记发掘耗材')
}

function openAttribution(kind: 'purchase' | 'deactivate', stock: MaterialStock): void {
  show(
    kind,
    kind === 'purchase' ? '发起人工申购单' : '标记停用（报废在库）',
    `耗材：${stock.name}（当前 ${stock.status}，库存 ${stock.quantity}）`,
  )
  dialog.value.targetStock = stock
}

function openInbound(stock: MaterialStock): void {
  show('inbound', '确认入库', `耗材：${stock.name}，入库后回到充足并同步现场领用清单`)
  dialog.value.targetStock = stock
  dialog.value.form.quantity = stock.warnQuantity ?? 1
}

function openSubmit(req: MaterialRequisition): void {
  show('submit', `确认领用 ${req.code}`, '提交后进入现场领用清单并扣减库存，重复提交只扣一次')
  dialog.value.targetReq = req
  dialog.value.form.operator = req.operator
  dialog.value.form.purpose = req.purpose
}

function openAttributionReq(kind: 'return' | 'scrap', req: MaterialRequisition): void {
  show(
    kind,
    kind === 'return' ? `退回领用单 ${req.code}` : `报废领用单 ${req.code}`,
    kind === 'return' ? '已领数量全部还回库房' : '已领数量销账，不回库存',
  )
  dialog.value.targetReq = req
}

function openManualRequisition(): void {
  show('manual', '现场新建领用单', '直接登记一张已提交的现场领用单并扣减库存')
  dialog.value.form.items = stocks.value
    .filter((stock) => stock.status !== '已停用')
    .map((stock) => ({
      materialId: stock.id,
      materialName: stock.name,
      stock: stock.quantity,
      checked: false,
      quantity: 1,
    }))
}

function hasStockAction(stock: MaterialStock): boolean {
  return stock.status === '偏低' || stock.status === '需采购'
}

function handle(result: MaterialOperationResult): void {
  reload()
  if (result.ok) {
    errorMessage.value = ''
    noticeMessage.value = result.message
    closeDialog()
  } else {
    errorMessage.value = result.message
  }
}

function confirmDialog(): void {
  const { kind, form, targetStock, targetReq } = dialog.value
  const operator = form.operator.trim()
  const purpose = form.purpose.trim()

  if (kind === 'create') {
    const warn = warnInput.value.trim() === '' ? null : Number(warnInput.value)
    handle(
      createStock({
        name: form.name,
        spec: form.spec,
        category: form.category,
        quantity: Number(form.quantity),
        warnQuantity: warn,
        keeper: form.keeper,
        operator,
        purpose,
      }),
    )
    return
  }

  if (!targetStock && !targetReq) {
    return
  }

  if (kind === 'purchase' && targetStock) {
    handle(startPurchase(targetStock.id, operator, purpose))
  } else if (kind === 'inbound' && targetStock) {
    handle(confirmInbound(targetStock.id, Number(form.quantity), operator, purpose))
  } else if (kind === 'deactivate' && targetStock) {
    handle(deactivate(targetStock.id, operator, purpose))
  } else if (kind === 'submit' && targetReq) {
    handle(submitRequisition(targetReq.id, operator, purpose))
  } else if (kind === 'return' && targetReq) {
    handle(returnRequisition(targetReq.id, operator, purpose))
  } else if (kind === 'scrap' && targetReq) {
    handle(scrapRequisition(targetReq.id, operator, purpose))
  } else if (kind === 'manual') {
    const picked = form.items.filter((item) => item.checked && item.quantity > 0)
    if (picked.length === 0) {
      errorMessage.value = '请至少勾选一种耗材并填写数量'
      return
    }
    if (!form.trenchCode.trim()) {
      errorMessage.value = '请填写领用探方'
      return
    }
    // 现场新建走「待提交→确认领用」同一条提交链路，保证扣减幂等规则一致。
    const result = createManualRequisition(
      form.trenchCode.trim(),
      picked.map((item) => ({ materialId: item.materialId, materialName: item.materialName, quantity: item.quantity })),
      operator,
      purpose,
    )
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    reload()
    const draft = requisitions.value.find(
      (item) => item.code === result.requisitionCodes?.[0] && item.status === '待提交',
    )
    if (draft) {
      const submitted = submitRequisition(draft.id, operator, purpose)
      handle(submitted)
      activeTab.value = 'onsite'
    }
  }
}

function resetFilters(): void {
  filters.value = { name: '', category: '' }
  reload()
}

function resetAll(): void {
  resetMaterial()
  activeTab.value = 'stock'
  noticeMessage.value = '耗材数据已重置为示例数据'
  errorMessage.value = ''
  reload()
}

function reload(): void {
  stocks.value = listStocks({ 耗材名称: filters.value.name, 用途分类: filters.value.category })
  requisitions.value = listRequisitions()
  logs.value = listLogs()
}

onMounted(reload)
</script>
