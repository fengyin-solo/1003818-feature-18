<template>
  <section class="page" data-module="requisition">
    <header class="page-head">
      <div>
        <h2>现场领用清单</h2>
        <p class="page-desc">维护领用单，围绕领用编号、耗材编号、关联探方、领用数量做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出现场领用清单</button>
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
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="openOp(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!availableActions(row).length">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无现场领用数据，探方开始发掘后会自动生成领用待办</td>
        </tr>
      </tbody>
    </table>

    <form v-if="op" class="op-bar" @submit.prevent="confirmOp">
      <span>{{ op.action }}：{{ op.row['领用编号'] }}</span>
      <label class="filter-item">
        <span>经办人</span>
        <input v-model="op.经办人" />
      </label>
      <label class="filter-item">
        <span>用途</span>
        <input v-model="op.用途" />
      </label>
      <button class="btn primary" type="submit">确认{{ op.action }}</button>
      <button class="btn ghost" type="button" @click="op = null">取消</button>
    </form>

    <footer class="page-foot">
      <span>共 {{ total }} 条现场领用记录</span>
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

const meta = moduleMeta('requisition')
const columns = ["领用编号", "耗材编号", "耗材名称", "关联探方", "领用数量", "用途", "经办人", "领用状态"]
const statuses = ["待领用", "已领用", "已退回", "已报废"]
const stats = [{"label": "领用单总数", "value": 0}, {"label": "待领用数", "value": 0}, {"label": "现场在用量", "value": 0}]

const store = useSessionStore()
const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const op = ref<{ action: string; row: EntryRow; 经办人: string; 用途: string } | null>(null)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function availableActions(row: EntryRow): string[] {
  if (String(row.status) === '待领用') {
    return ['领取']
  }
  if (String(row.status) === '已领用') {
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

function openOp(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  op.value = {
    action,
    row,
    经办人: store.operator,
    用途: String(row['用途'] ?? ''),
  }
}

function confirmOp() {
  if (!op.value) {
    return
  }
  errorMessage.value = ''
  noticeMessage.value = ''
  const { action, row, 经办人, 用途 } = op.value
  const result = applyAction(meta.key, Number(row.id), action, { 经办人, 用途 })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  op.value = null
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '现场领用列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
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
