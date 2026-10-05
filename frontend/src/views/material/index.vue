<template>
  <section class="page" data-module="material">
    <header class="page-head">
      <div>
        <h2>耗材管理管理</h2>
        <p class="page-desc">维护发掘耗材，围绕耗材编号、耗材名称、规格型号、用途分类做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记发掘耗材</button>
        <button class="btn" type="button" @click="exportRows">导出耗材管理清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无耗材管理数据，可先登记发掘耗材</td>
        </tr>
      </tbody>
    </table>

    <form v-if="stockIn" class="op-bar" @submit.prevent="confirmStockIn">
      <span>确认入库：{{ stockIn.row['耗材编号'] }}</span>
      <label class="filter-item">
        <span>入库数量</span>
        <input v-model.number="stockIn.入库数量" type="number" min="1" />
      </label>
      <label class="filter-item">
        <span>经办人</span>
        <input v-model="stockIn.经办人" />
      </label>
      <button class="btn primary" type="submit">确认入库</button>
      <button class="btn ghost" type="button" @click="stockIn = null">取消</button>
    </form>

    <section class="requisition-panel">
      <header class="panel-head">
        <h3>领用归还编排</h3>
        <span class="panel-desc">探方开工自动生成领用待办；领取、退回和报废都要登记经办人与用途，同一领用单只扣减一次库存。</span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in reqColumns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="req in requisitions" :key="String(req.id)">
            <td v-for="column in reqColumns" :key="column">{{ req[column] ?? '—' }}</td>
            <td>{{ req.status }}</td>
            <td class="row-actions">
              <button
                v-for="action in reqActions(req)"
                :key="action"
                class="link"
                type="button"
                @click="openReqOp(action, req)"
              >
                {{ action }}
              </button>
              <span v-if="!reqActions(req).length">—</span>
            </td>
          </tr>
          <tr v-if="!requisitions.length">
            <td :colspan="reqColumns.length + 2" class="empty-state">暂无领用单，探方开始发掘后会自动生成领用待办</td>
          </tr>
        </tbody>
      </table>

      <form v-if="reqOp" class="op-bar" @submit.prevent="confirmReqOp">
        <span>{{ reqOp.action }}：{{ reqOp.row['领用编号'] }}</span>
        <label class="filter-item">
          <span>经办人</span>
          <input v-model="reqOp.经办人" />
        </label>
        <label class="filter-item">
          <span>用途</span>
          <input v-model="reqOp.用途" />
        </label>
        <button class="btn primary" type="submit">确认{{ reqOp.action }}</button>
        <button class="btn ghost" type="button" @click="reqOp = null">取消</button>
      </form>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条耗材管理记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('material')
const columns = ["耗材编号", "耗材名称", "规格型号", "用途分类", "当前数量", "预警数量", "保管人", "耗材状态"]
const actions = ["发起采购", "确认入库", "标记停用"]
const statuses = ["充足", "偏低", "需采购", "已停用"]
const stats = [{"label": "耗材种类", "value": 0}, {"label": "需采购种类", "value": 0}, {"label": "偏低种类", "value": 0}]
const reqColumns = ["领用编号", "耗材编号", "耗材名称", "关联探方", "领用数量", "用途", "经办人", "领用状态"]

const store = useSessionStore()
const rows = ref<EntryRow[]>([])
const requisitions = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const stockIn = ref<{ row: EntryRow; 入库数量: number; 经办人: string } | null>(null)
const reqOp = ref<{ action: string; row: EntryRow; 经办人: string; 用途: string } | null>(null)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function reqActions(req: EntryRow): string[] {
  if (String(req.status) === '待领用') {
    return ['领取']
  }
  if (String(req.status) === '已领用') {
    return ['退回', '报废']
  }
  return []
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '发掘耗材登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  if (action === '确认入库') {
    stockIn.value = { row, 入库数量: 1, 经办人: store.operator }
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function confirmStockIn() {
  if (!stockIn.value) {
    return
  }
  errorMessage.value = ''
  noticeMessage.value = ''
  const { row, 入库数量, 经办人 } = stockIn.value
  const result = applyAction(meta.key, Number(row.id), '确认入库', { 入库数量, 经办人 })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  stockIn.value = null
  reload()
}

function openReqOp(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  reqOp.value = {
    action,
    row,
    经办人: store.operator,
    用途: String(row['用途'] ?? ''),
  }
}

function confirmReqOp() {
  if (!reqOp.value) {
    return
  }
  errorMessage.value = ''
  noticeMessage.value = ''
  const { action, row, 经办人, 用途 } = reqOp.value
  const result = applyAction('requisition', Number(row.id), action, { 经办人, 用途 })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reqOp.value = null
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    requisitions.value = listEntries('requisition').items
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '耗材管理列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.requisition-panel {
  margin-top: 16px;
}
.panel-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 8px 0;
}
.panel-head h3 {
  margin: 0;
  font-size: 15px;
}
.panel-desc {
  color: var(--muted);
  font-size: 12px;
}
.op-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
  margin: 10px 0;
  padding: 10px 12px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.notice-text {
  color: #067647;
}
</style>
