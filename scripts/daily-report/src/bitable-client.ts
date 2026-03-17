/**
 * Bitable Client — reads pending todo items from Feishu Bitable.
 * Standalone: no framework imports.
 */
import type * as lark from '@larksuiteoapi/node-sdk';
import type { BitableFieldSchema } from './config-reader.js';

export interface BitableTodoItem {
  recordId: string;
  name: string;
  status: string;
  priority: string;
  dueDate?: string;
}

export async function fetchBitableSchema(
  client: lark.Client,
  appToken: string,
  tableId: string,
): Promise<BitableFieldSchema | null> {
  try {
    const res = await client.bitable.v1.appTableField.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100 },
    });
    const items = res?.data?.items;
    if (!items || items.length === 0) return null;

    const rawFields = items.map(f => ({
      field_name: f.field_name,
      type: f.type,
      field_id: (f as any).field_id || '',
    }));

    const taskNameField = findField(items, ['任务', '事项', '名称', '标题', 'name', 'title', 'task'], [1]);
    const statusField = findField(items, ['状态', 'status', 'state'], [3, 4]);
    const priorityField = findField(items, ['优先级', '优先', 'priority', 'level'], [3, 4]);
    const dueDateField = findField(items, ['截止', '日期', 'due', 'deadline', 'date'], [5]);

    if (!taskNameField || !statusField || !priorityField) {
      console.warn('[bitable] Could not identify required fields:', rawFields.map(f => f.field_name));
      return null;
    }

    console.log(`[bitable] Schema: task=${taskNameField}, status=${statusField}, priority=${priorityField}`);
    return { taskNameField, statusField, priorityField, dueDateField: dueDateField || undefined, rawFields };
  } catch (err) {
    console.error('[bitable] fetchSchema failed:', err);
    return null;
  }
}

function findField(
  fields: Array<{ field_name: string; type: number }>,
  keywords: string[],
  types?: number[],
): string | null {
  for (const field of fields) {
    if (types && !types.includes(field.type)) continue;
    if (keywords.some(kw => field.field_name.toLowerCase().includes(kw.toLowerCase()))) return field.field_name;
  }
  if (types) {
    for (const field of fields) {
      if (keywords.some(kw => field.field_name.toLowerCase().includes(kw.toLowerCase()))) return field.field_name;
    }
  }
  return null;
}

export async function fetchPendingTodos(
  client: lark.Client,
  appToken: string,
  tableId: string,
  schema: BitableFieldSchema,
): Promise<BitableTodoItem[]> {
  try {
    const res = await client.bitable.v1.appTableRecord.search({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100 },
      data: {
        field_names: [
          schema.taskNameField, schema.statusField, schema.priorityField,
          ...(schema.dueDateField ? [schema.dueDateField] : []),
        ],
        filter: {
          conjunction: 'and',
          conditions: [
            { field_name: schema.statusField, operator: 'isNot', value: ['已完成'] },
            { field_name: schema.statusField, operator: 'isNot', value: ['已放弃'] },
          ],
        },
        sort: [{ field_name: schema.priorityField, desc: false }],
      },
    });
    const items = res?.data?.items;
    if (!items || items.length === 0) return [];
    return items.map(item => ({
      recordId: item.record_id || '',
      name: extractText(item.fields[schema.taskNameField]),
      status: extractText(item.fields[schema.statusField]),
      priority: extractText(item.fields[schema.priorityField]),
      dueDate: schema.dueDateField ? extractDate(item.fields[schema.dueDateField]) : undefined,
    }));
  } catch (err) {
    console.error('[bitable] fetchPendingTodos failed:', err);
    return [];
  }
}

function extractText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(v => (typeof v === 'string' ? v : v?.text ?? String(v))).join('');
  if (typeof value === 'object' && 'text' in (value as any)) return String((value as any).text || '');
  return String(value);
}

function extractDate(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number') {
    const d = new Date(value);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  if (typeof value === 'string') return value;
  return undefined;
}
